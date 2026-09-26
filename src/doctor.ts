// Health checks, shared by the `doctor` CLI command (prints ✓/✗) and the TUI Doctor tab (renders
// ✓/✗). Each check returns a structured result so both consumers render it however they like — the
// check logic lives in exactly one place. Grouped by ownership: what herdr-factory provisions &
// maintains itself vs the external tools + auth the user supplies. Repo-specific checks are a
// separate group behind `--repo`.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidencePublisher, credsRefreshHint } from "./clients/evidence.ts";
import { run } from "./clients/exec.ts";
import { assertMainCheckout, configLoadError, globalDbPath, isManagedNode, loadConfig, type BeltConfig, type Config, type StepConfig } from "./config.ts";
import { descriptorFor } from "./sources/registry.ts";
import { orphanWorktreeListeners, worktreesRoot } from "./core/dev-server.ts";
import { openDb } from "./db/index.ts";
import { Store } from "./db/store.ts";
import { systemClock } from "./types.ts";
import { buildDeps } from "./build-deps.ts";
import { availableMemoryMb, loadMachineConfig, machineConfigPath } from "./machine.ts";
import type { Deps } from "./core/deps.ts";
import { pingHealth, readServerInfo } from "./server/client.ts";
import { HERDR_AGENT_KINDS } from "./types.ts";
import * as service from "./watchers/service.ts";
import { ago, readUpdateStatus, updateChannel, updateStalled } from "./watchers/update-status.ts";
import { CHECKOUT_GIT_TIMEOUT_MS, readCheckoutSync, type CheckoutSync } from "./watchers/checkouts.ts";
import { configDir } from "./config-paths.ts";

/** One check's outcome. `detail` is extra context: a version/path/endpoint on success, or the
 *  failure reason on ✗. `warn` marks an amber (not-a-failure) state — a healthy check that still
 *  wants attention, e.g. an auto-update that was skipped/failed or left the box behind its channel
 *  target. A warn is `ok: true` (it never fails `doctor`'s exit code) but paints amber. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  warn?: boolean;
  detail?: string;
}
export interface DoctorGroup {
  title: string;
  checks: DoctorCheck[];
}

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Run one check: the fn returns a success `detail` string (or void) or throws — a thrown Error's
 *  message becomes the ✗ detail. Never rejects. */
async function attempt(name: string, fn: () => Promise<string | void>): Promise<DoctorCheck> {
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail || undefined };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error && e.message ? e.message : undefined };
  }
}


/** The auto-update check — channel-aware, and the surface for a skipped/failed/behind update. It
 *  reads the updater's recorded status file (written every supervisor tick) so a dirty-checkout skip
 *  or a failed reset shows up here (amber) instead of only in the supervisor log. The channel is
 *  read from that status file when present (what the SERVICE actually ran — the env var is captured
 *  at install time and may not be exported in this shell), falling back to the ambient env. On a box
 *  that has never updated (no status file) it validates the `main` upstream exists, as before. */
export async function updateCheck(): Promise<DoctorCheck> {
  const name = "auto-update";
  const status = readUpdateStatus();
  const channel = status?.channel ?? updateChannel();
  const target = status?.targetRef ?? (channel === "stable" ? "latest release tag" : "upstream");

  if (status) {
    const when = ago(status.at);
    if (status.outcome === "failed") return { name, ok: true, warn: true, detail: `${channel}: last update FAILED — ${status.reason ?? "unknown"} (${when})` };
    if (status.dirtySkip) return { name, ok: true, warn: true, detail: `${channel}: reset to ${target} skipped — checkout has uncommitted changes (${when})` };
    if (status.behind) return { name, ok: true, warn: true, detail: `${channel}: behind ${target}${status.reason ? ` — ${status.reason}` : ""} (${when})` };
    // Nothing has run the updater for many ticks: no scheduler (a HERDR_SKIP_SERVICE host with no
    // ensure-up loop), or one stuck on a hung tick. The recorded "up to date" is stale news.
    if (updateStalled(status)) return { name, ok: true, warn: true, detail: `auto-update stalled — last check ${when} (nothing is running \`ensure-up\` every 60s)` };
    if (status.warning) return { name, ok: true, warn: true, detail: `${channel}: updated but ${status.warning} (${when})` };
    const state = status.outcome === "updated" ? `updated (${status.reason ?? "reset"})` : `up to date on ${target}`;
    return { name, ok: true, detail: `${channel}: ${state} (${when})` };
  }

  // No attempt recorded yet (fresh box, or auto-update disabled). Fall back to the historical check:
  // confirm the branch has an upstream to update from (main); stable resolves its target from tags.
  if (channel === "stable") return { name, ok: true, detail: "stable: follows the latest release tag (no update attempt recorded yet)" };
  try {
    const upstream = (await run("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd: PKG_ROOT })).stdout.trim();
    return { name, ok: true, detail: `main: upstream ${upstream}` };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error && e.message ? e.message : undefined };
  }
}

/** Each configured repo's MAIN checkout (`repo.path`) vs its base branch — the result of the
 *  fast-forward `ensure-up` attempts every 10 minutes (issue #71). Amber when a checkout couldn't
 *  be advanced (on another branch, dirty, diverged) or the fetch failed, since that checkout is
 *  quietly going stale for whoever opens it. Never a ✗ — a human working in there is normal. */
export function checkoutSyncCheck(state: Record<string, CheckoutSync> = readCheckoutSync(), now = Date.now()): DoctorCheck {
  const name = "main checkouts up to date";
  const entries = Object.values(state);
  if (entries.length === 0) return { name, ok: true, detail: "no sync recorded yet (ensure-up records one per repo every 10min)" };
  const line = (c: CheckoutSync) => `${c.repo}: ${c.outcome === "up_to_date" ? "up to date" : (c.reason ?? c.outcome)} (${ago(c.at, now)})`;
  const stale = entries.filter((c) => c.outcome === "skipped" || c.outcome === "failed");
  const detail = entries.map(line).join(" · ");
  return stale.length > 0 ? { name, ok: true, warn: true, detail } : { name, ok: true, detail };
}

/** The live config dir (`~/.config/herdr-factory`) vs its `origin/main` (issue #115). Rollout there
 *  is manual — nothing syncs it (see watchers/checkouts.ts) — so it silently fell behind merged
 *  fixes on every host. Amber when HEAD is behind `origin/main` or a tracked file has local edits.
 *  Never a ✗, and never touches the checkout: `fetch` (only under --deep — the shallow doctor makes
 *  no network calls, so it compares against the last-fetched ref) moves remote-tracking refs only. */
export async function liveConfigCheck(dir = configDir(), fetch = false): Promise<DoctorCheck> {
  const name = "live config up to date";
  if (!existsSync(join(dir, ".git"))) return { name, ok: true, detail: `${dir} is not a git checkout — nothing to compare` };
  // Lazy: updater.ts's Effect stack stays out of doctor's import graph (see CHECKOUT_GIT_TIMEOUT_MS).
  const { execBounded } = await import("./watchers/updater.ts");
  const git = (...args: string[]) => execBounded("git", args, dir, CHECKOUT_GIT_TIMEOUT_MS);
  try {
    if (fetch) await git("fetch", "origin", "--quiet");
    const warns: string[] = [];
    const behind = Number(await git("rev-list", "--count", "HEAD..origin/main"));
    if (behind > 0) {
      const first = (await git("log", "--reverse", "--format=%s", "HEAD..origin/main")).split("\n")[0];
      warns.push(`live config ${behind} commit(s) behind origin/main (${first})${fetch ? "" : " as of the last fetch"}`);
    }
    const dirty = (await git("diff", "--name-only", "HEAD")).split("\n").filter(Boolean); // staged + unstaged, tracked only
    if (dirty.length > 0) warns.push(`uncommitted changes to ${dirty.join(", ")}`);
    if (warns.length > 0) return { name, ok: true, warn: true, detail: `${warns.join(" · ")} — roll out by hand in ${dir}` };
    return { name, ok: true, detail: `at origin/main${fetch ? "" : " as of the last fetch (--deep fetches)"}` };
  } catch (e) {
    return { name, ok: true, warn: true, detail: `could not check — ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Dev servers that outlived their run (or its park): a LISTENing process whose cwd is inside
 *  herdr's worktrees dir with no live, unparked run owning that worktree. They keep a port (so the next run's server silently
 *  moves up its range and an evidence pass can film a stale server) and their whole RSS — capacity
 *  the scheduler believes it has and does not. Amber, never a ✗, and REPORT ONLY: doctor never
 *  kills; the engine's `stopDevServer` does, only its own run's port, at every step change (advance,
 *  bounce, rework), every park (attention, waiting_for_human) and teardown. Deep-only (it runs an
 *  lsof per listener). */
export async function orphanListenerCheck(): Promise<DoctorCheck> {
  const name = "orphaned dev servers";
  try {
    const dbPath = globalDbPath();
    // No DB ⇒ no run has ever existed on this box, so every listener under the worktrees dir would
    // read as an orphan. Say nothing rather than cry wolf.
    if (!existsSync(dbPath)) return { name, ok: true, detail: "no database yet — nothing has run here" };
    const db = openDb(dbPath);
    let live: string[];
    try {
      live = new Store(db, systemClock).workingWorktreePaths();
    } finally {
      db.close();
    }
    const orphans = await orphanWorktreeListeners(live);
    if (orphans.length === 0) return { name, ok: true, detail: `none — every listener under ${worktreesRoot()} belongs to a working run` };
    const detail = orphans.map((o) => `${o.command} pid ${o.pid} on :${o.port}${o.rssKb != null ? ` (${Math.round(o.rssKb / 1024)} MB)` : ""} in ${o.cwd}`).join(" · ");
    return { name, ok: true, warn: true, detail: `${orphans.length} listener(s) outlived their run or its park — ${detail}. Kill them by hand (doctor never kills)` };
  } catch (e) {
    return { name, ok: true, warn: true, detail: `could not check — ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Is a tool on PATH? Presence only — doesn't invoke it (so no network/side effects). Resolves
 *  against `env` (the server's PATH) when given, so the answer doesn't depend on how THIS process
 *  was launched — a GUI-opened TUI has a leaner PATH than a terminal, but both should report the
 *  environment where the factory actually runs its tools. */
async function onPath(tool: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await run("sh", ["-c", `command -v ${JSON.stringify(tool)} >/dev/null 2>&1`], { env });
}

/** The minimum herdr the factory works against, read from the plugin manifest so the CLI floor and
 *  the floor herdr itself enforces when loading our plugin can never drift. */
export function minHerdrVersion(): string {
  const manifest = readFileSync(join(PKG_ROOT, "herdr-plugin.toml"), "utf8");
  return /^\s*min_herdr_version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? "0.0.0";
}

/** Compare dotted numeric versions: <0 / 0 / >0. Non-numeric suffixes (a `-beta` tail) are ignored —
 *  a pre-release of the floor counts as the floor, which is the friendlier read for a doctor check. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [xs, ys] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const d = (xs[i] ?? 0) - (ys[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** herdr's own version floor check. `herdr --version` prints `herdr <semver>`; below the floor the
 *  factory's CLI calls fail in ways that are hard to read from the run's own symptoms (0.7.5 changed
 *  `agent start` to adopt an existing pane and replaced the top-level `wait`), so it is worth one
 *  cheap, local subprocess to say so plainly. */
async function herdrVersionCheck(herdrBin: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await run(herdrBin, ["--version"], { env, allowFail: true });
  const version = /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`)?.[1];
  if (!version) throw new Error("not on PATH (or `herdr --version` gave no version)");
  const floor = minHerdrVersion();
  if (compareVersions(version, floor) < 0) throw new Error(`v${version} is too old — the factory needs >= ${floor} (run \`herdr update\`)`);
  return `v${version}`;
}

// --- the agent tooling a run actually shells out to -----------------------------------------
// `claude` is not the only harness a belt runs: every pane launches whatever the config's `agent:`
// block names, and the prompts delegate the real work to agent SKILLS. None of that used to be
// checked, and none of it fails loudly — a missing skill just makes the agent improvise, and a
// `--model` id cursor-agent doesn't recognise makes it print its model list and exit, leaving a
// pane that LOOKS ready while the whole run burns quietly. So these checks are CONFIG-driven: a
// host whose belts never touch Cursor reports "not configured" rather than ✗ (issue #49).

/** Where each agent engine reads its skills from, relative to $HOME — first root is the engine's
 *  own. Cursor also reads Claude's and the shared `~/.agents` root (issue #104), so a skill linked
 *  only there still counts. */
const SKILL_ROOTS: Record<string, string[]> = {
  cursor: [".cursor/skills", ".claude/skills", ".agents/skills"],
  claude: [".claude/skills"],
};

/** The herdr agent KIND a harness block runs as: its explicit `kind`, else the command when the
 *  command itself names a kind (`claude`), else Cursor's CLI under its own binary name. undefined
 *  for a wrapper script with no `kind:` — we can't tell what it launches, so we don't guess. */
function engineKind(a: { command?: string; kind?: string } | undefined): string | undefined {
  if (!a) return undefined;
  if (a.kind) return a.kind;
  const base = a.command?.split("/").pop() ?? "";
  if (base === "cursor-agent") return "cursor";
  return HERDR_AGENT_KINDS.includes(base) ? base : undefined;
}

/** Every `--model <id>` / `--model=<id>` in an argv. */
function modelIds(args: readonly string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === "--model" && args[i + 1]) out.push(args[i + 1]!);
    else if (a.startsWith("--model=")) out.push(a.slice("--model=".length));
  });
  return out;
}

// Skill names are read from the prompts rather than hardcoded, so the check follows the prompts as
// they change. Two deliberately TIGHT patterns, so prose can never invent a name: a path rooted at a
// skills DIRECTORY (`~/.claude/skills/to-spec/SKILL.md`) and a bolded name directly before the word
// "skill" (`Use the **pr-review** skill`). Anything vaguer is left alone — a ✗ for a skill nobody
// asked for is worse than no check, and the loose form catches prose like "release skills/commands
// under `.claude/`".
const SKILL_PATTERNS = [/\.(?:claude|cursor)\/skills\/([a-z0-9][a-z0-9._-]*)/g, /\*\*([a-z0-9][a-z0-9._-]*)\*\*\s+skill\b/g];

/** The skill names a prompt body references. */
export function skillNamesIn(body: string): string[] {
  const out = new Set<string>();
  for (const re of SKILL_PATTERNS) for (const m of body.matchAll(re)) out.add(m[1]!);
  return [...out];
}

/** The prompt bodies a step carries at LOAD time: its engine base, plus a `config`-sourced user
 *  prompt file. A `repo`-sourced prompt lives in a run's worktree and isn't readable from here. */
function stepPrompts(config: Config, step: StepConfig): string[] {
  const bodies = [step.enginePrompt];
  if (step.promptFile && step.promptFileSource === "config") {
    const abs = isAbsolute(step.promptFile) ? step.promptFile : join(config.paths.repoDir, step.promptFile);
    if (existsSync(abs)) bodies.push(readFileSync(abs, "utf8"));
  }
  return bodies.filter((b): b is string => !!b);
}

/** Which engine runs a step: the layout pane it targets (that pane's agent is what actually starts),
 *  falling back to the harness a SPAWNED pane would launch (step over belt over repo). */
function stepEngine(config: Config, belt: BeltConfig, step: StepConfig): string | undefined {
  const layout = config.layouts.find((l) => l.id === belt.defaultLayout);
  const pane = step.tab && step.pane ? layout?.tabs.find((t) => t.title === step.tab)?.panes.find((p) => p.title === step.pane) : undefined;
  if (pane?.agent) return pane.agent.kind;
  return engineKind(step.agent ?? config.agent);
}

/** What a repo's config asks of the agent tooling on this host: which engines it starts, the Cursor
 *  model ids it names, and the skills its prompts delegate to (per engine, since each engine reads
 *  its skills from its own root). */
export interface AgentTooling {
  engines: Set<string>;
  cursorModels: Set<string>;
  /** engine kind → the skill names that engine's prompts reference. */
  skills: Map<string, Set<string>>;
}

export function agentTooling(config: Config): AgentTooling {
  const engines = new Set<string>();
  const cursorModels = new Set<string>();
  const skills = new Map<string, Set<string>>();
  const addModels = (engine: string | undefined, args: readonly string[]) => {
    if (engine) engines.add(engine);
    // Only Cursor's ids are checkable against `cursor-agent models` — `--model opus` on a claude
    // pane is Claude Code's namespace, not Cursor's.
    if (engine === "cursor") for (const m of modelIds(args)) cursorModels.add(m);
  };
  // Layout panes start their own agents (the common case: every step targets a pane).
  for (const l of config.layouts) for (const t of l.tabs) for (const p of t.panes) if (p.agent) addModels(p.agent.kind, p.agent.args);
  // …and a step with no pane spawns one from the resolved harness.
  addModels(engineKind(config.agent), config.agent.flags);
  for (const belt of config.belts) {
    for (const step of belt.steps) {
      if (step.agent) addModels(engineKind(step.agent), step.agent.flags);
      const engine = stepEngine(config, belt, step);
      if (!engine) continue;
      for (const body of stepPrompts(config, step)) {
        for (const name of skillNamesIn(body)) {
          let set = skills.get(engine);
          if (!set) skills.set(engine, (set = new Set()));
          set.add(name);
        }
      }
    }
  }
  return { engines, cursorModels, skills };
}

/** `cursor-agent models` prints `<id> - <label>` per line. One invocation per doctor run, memoized
 *  so several repos share it. */
let cursorModelsCache: Promise<Set<string>> | undefined;
function listCursorModels(env?: NodeJS.ProcessEnv): Promise<Set<string>> {
  cursorModelsCache ??= (async () => {
    // allowFail + our own message: the raw `exec failed: cursor-agent models (code 1): …` this used
    // to surface is not a fix hint, and the issue asks every row to carry one.
    const r = await run("cursor-agent", ["models"], { env, timeoutMs: 30_000, allowFail: true });
    if (r.code !== 0) {
      const said = firstLine(`${r.stdout}\n${r.stderr}`);
      throw new Error(`\`cursor-agent models\` failed (exit ${r.code})${said ? ` — ${said}` : ""} — sign in with \`cursor-agent login\` if it wants authentication`);
    }
    return new Set([...r.stdout.matchAll(/^(\S+) - /gm)].map((m) => m[1]!));
  })();
  return cursorModelsCache;
}
/** Test seam / fresh-run reset: the next `listCursorModels` invokes the CLI again. */
export function resetCursorModelsCache(): void {
  cursorModelsCache = undefined;
}

/** Presence as a BOOLEAN, for a check that must branch on it rather than fail on it — `run()` turns
 *  a spawn ENOENT into an ordinary non-zero result under `allowFail`, so a check that goes straight
 *  to invoking a tool cannot tell "missing" from "broken" and would misdiagnose it. */
async function isOnPath(tool: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  return onPath(tool, env).then(
    () => true,
    () => false,
  );
}

/** The same remediation the group's other absent-tool rows give: install it, then re-run `install`
 *  so the SERVICE's frozen PATH picks it up (these checks resolve against that PATH, not a shell's). */
function missingToolHint(what: string): string {
  return `not on PATH — install ${what}, then re-run \`herdr-factory install\` so the service PATH picks it up`;
}

/** The first non-empty line a CLI printed, for quoting its own words back in a ✗. */
function firstLine(out: string): string {
  return out.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** The "you provide" checks that only a loaded config can gate: cursor-agent (+ its login and the
 *  model ids in play), the skills the prompts name, and `ocr`. Each is a ✗ with a one-line fix hint,
 *  never a throw; each reports "not configured" when this config doesn't ask for it. */
export async function agentToolingChecks(tooling: AgentTooling, deep: boolean, env?: NodeJS.ProcessEnv): Promise<DoctorCheck[]> {
  // Pushed as PROMISES and awaited together: `cursor-agent status` and `cursor-agent models` each
  // cost ~2s, and running them back to back is what would push `--deep` past "a couple of seconds".
  const checks: (DoctorCheck | Promise<DoctorCheck>)[] = [];
  const usesCursor = tooling.engines.has("cursor");
  // Presence, resolved ONCE and shared by the rows that invoke cursor-agent. Deep must establish it
  // before interpreting anything the CLI "said": under `allowFail` a spawn ENOENT arrives as an
  // ordinary non-zero result, so without this a MISSING binary reads as a signed-out one — and the
  // operator is told to run `cursor-agent login`, which itself fails with command-not-found.
  const cursorOnPath = usesCursor && deep ? isOnPath("cursor-agent", env) : undefined;

  // 1. cursor-agent. Its login opens a browser and blocks, so it can never be fixed unattended —
  //    naming it here, early, is the whole point.
  if (!usesCursor) {
    checks.push({ name: "cursor-agent", ok: true, detail: "not configured — no belt runs a Cursor agent" });
  } else if (!deep) {
    checks.push(attempt("cursor-agent", () => onPath("cursor-agent", env)));
  } else {
    checks.push(
      attempt("cursor-agent (signed in)", async () => {
        if (!(await cursorOnPath)) throw new Error(missingToolHint("Cursor's CLI (`cursor-agent`)"));
        const r = await run("cursor-agent", ["status"], { env, allowFail: true, timeoutMs: 30_000 });
        const said = firstLine(`${r.stdout}\n${r.stderr}`);
        const who = /logged in as (\S+)/i.exec(`${r.stdout} ${r.stderr}`)?.[1];
        // Quote the CLI's own first line whichever way it exited — a non-zero exit (a broken
        // install answering `error: unknown command status`) is exactly when it is worth showing.
        if (!who) throw new Error(`not signed in — run \`cursor-agent login\` on this host (it opens a browser)${said ? ` [cursor-agent said: ${said}]` : ""}`);
        return who;
      }),
    );
  }

  // 2. Every configured Cursor `--model` id still exists. Deep only: one CLI invocation.
  const models = [...tooling.cursorModels].sort();
  if (models.length === 0) {
    checks.push({ name: "cursor models", ok: true, detail: "none configured" });
  } else if (!deep) {
    checks.push({ name: "cursor models", ok: true, detail: `${models.length} configured (${models.join(", ")}) — --deep to verify` });
  } else {
    checks.push(
      attempt("cursor models", async () => {
        // One root cause, one ✗: when the binary is absent the row above already says so and how to
        // fix it, so this defers rather than repeating it as a second failure.
        if (cursorOnPath && !(await cursorOnPath)) return "not checked — cursor-agent is not on PATH (see the row above)";
        const known = await listCursorModels(env);
        const gone = models.filter((m) => !known.has(m));
        if (gone.length > 0) throw new Error(`${gone.join(", ")} not in \`cursor-agent models\` — fix the \`--model\` id in this repo's config (a rejected id makes cursor-agent print its model list and exit)`);
        return models.join(", ");
      }),
    );
  }

  // 3. The skills the prompts name exist under the engine that runs them. Deep only, so plain
  //    `doctor` stays PATH-only.
  const named = [...tooling.skills].flatMap(([engine, names]) => [...names].map((name) => ({ engine, name })));
  if (named.length === 0) {
    checks.push({ name: "agent skills", ok: true, detail: "none named by the prompts" });
  } else if (!deep) {
    checks.push({ name: "agent skills", ok: true, detail: `${named.length} named by the prompts — --deep to verify` });
  } else {
    checks.push(
      attempt("agent skills", async () => {
        const missing = named.filter(({ engine, name }) => {
          const roots = SKILL_ROOTS[engine] ?? [];
          return roots.length > 0 && !roots.some((root) => existsSync(join(homedir(), root, name, "SKILL.md")));
        });
        if (missing.length > 0) {
          const where = ({ engine, name }: { engine: string; name: string }) => {
            const [own, ...also] = SKILL_ROOTS[engine]!;
            return `${name} missing at ~/${own}/${name}/SKILL.md` + (also.length ? ` (nor under ${also.map((r) => `~/${r}`).join(", ")})` : "");
          };
          throw new Error(missing.map(where).join("; ") + " — install (or re-link) the skill on this host");
        }
        return `${named.length} present (${named.map((s) => s.name).sort().join(", ")})`;
      }),
    );
  }

  // 4. `ocr` — pr-review's third review track shells out to it, and nothing in the install puts it
  //    there. Only checked when a prompt actually names pr-review.
  const needsOcr = [...tooling.skills.values()].some((names) => names.has("pr-review"));
  checks.push(
    needsOcr
      ? // `ocr` gets a hint of its own rather than the shared `command -v` failure the other
        //  you-provide tools show: it is the one tool here that NOTHING installs, so "where does it
        //  come from" is the actual question a ✗ has to answer.
        attempt("ocr", async () => {
          if (!(await isOnPath("ocr", env))) throw new Error(`${missingToolHint("`ocr`")} (pr-review's third review track shells out to it; nothing in \`install.sh\` provides it)`);
        })
      : { name: "ocr", ok: true, detail: "not configured — no prompt names the pr-review skill" },
  );

  return await Promise.all(checks);
}

/** Machine-wide checks, grouped by ownership. No repo needed.
 *  `deep` = also interact with external services (gh auth, herdr daemon); the default is local-only
 *  and side-effect-free (tool presence, no network calls).
 *  `repo` is optional and only widens the "you provide" group: the agent tooling a run shells out to
 *  (cursor-agent, its model ids, the skills the prompts name, ocr) is only checkable — and only
 *  gateable, so a Cursor-less host isn't failed — against a loaded config. */
export async function baseGroups(deep = false, repo?: string): Promise<DoctorGroup[]> {
  const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
  const info = readServerInfo();
  const running = info ? await pingHealth(info.port).catch(() => false) : false;

  const managed = await Promise.all([
    attempt("node runtime >= 26", async () => {
      if (Number(process.versions.node.split(".")[0]) < 26) throw new Error(`v${process.versions.node} is too old`);
      return `v${process.versions.node}, ${isManagedNode(process.execPath) ? "vendored" : "ambient"}`;
    }),
    updateCheck(),
    Promise.resolve(checkoutSyncCheck()),
    liveConfigCheck(configDir(), deep),
    attempt("supervisor service", async () => {
      if (!(await service.isLoaded())) throw new Error("not loaded — run `herdr-factory install`");
    }),
    attempt("server", async () => {
      if (!running) throw new Error(info ? "registered but not responding" : "not running (run `herdr-factory start`)");
      return `running on :${info!.port} (v${info!.version})`;
    }),
    attempt("machine limits (machine.yml)", async () => {
      const m = loadMachineConfig(); // throws the readable validation error ⇒ ✗
      const parts = [
        m.maxActiveWorkspaces !== undefined && `cap ${m.maxActiveWorkspaces} working across all repos`,
        m.minFreeMemoryMb !== undefined && `claims pause below ${m.minFreeMemoryMb} MB available (now ${availableMemoryMb()} MB)`,
        m.notifyNeedsYou && "notifies when a fleet item newly needs you",
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : `none — per-repo caps only (${machineConfigPath()} absent or empty)`;
    }),
    attempt("database", async () => {
      const p = globalDbPath();
      if (!existsSync(p)) throw new Error("not initialized yet (created on the first `serve`)");
      return p;
    }),
    ...(deep ? [orphanListenerCheck()] : []),
  ]);

  // These tools are resolved against the SERVICE's PATH, not this process's. The checks run
  // in-process (CLI command or TUI tab), but the tools are found/invoked by the resident `serve`,
  // which runs with the PATH baked into the launchd plist / systemd unit at install. A terminal has
  // that rich PATH; a GUI-launched TUI inherits the bare `/usr/bin:/bin:…` and would otherwise
  // report herdr/gh/claude as "missing" while `serve` finds them fine (git survives only via its
  // /usr/bin fallback). Falling back to process.env when the service isn't installed keeps the old
  // behavior (and the "supervisor service" check above already flags a missing service).
  // Default: presence on PATH (local, no network). Deep: actually interact (gh auth verifies the
  // GitHub token; herdr `workspace list` verifies the daemon responds).
  const toolPath = service.servicePath();
  const toolEnv = toolPath ? { ...process.env, PATH: toolPath } : undefined;
  const provided = await Promise.all([
    attempt("git", () => onPath("git", toolEnv)),
    deep
      ? attempt("herdr (daemon responds)", async () => {
          const version = await herdrVersionCheck(herdrBin, toolEnv);
          // `status server` reports the running daemon's protocol + whether this CLI can speak it —
          // a mismatch means an updated binary with a stale server still running (`herdr update`
          // without a restart), which presents as arbitrary socket failures.
          const r = await run(herdrBin, ["status", "server"], { env: toolEnv, allowFail: true });
          const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(r.stdout)?.[1]?.trim();
          if (field("compatible") === "no") throw new Error(`${version} CLI cannot speak the running server's protocol ${field("protocol") ?? "?"} — restart herdr`);
          await run(herdrBin, ["workspace", "list"], { env: toolEnv });
          return `${version}, protocol ${field("protocol") ?? "?"}`;
        })
      : attempt("herdr", () => herdrVersionCheck(herdrBin, toolEnv)),
    deep
      ? attempt("gh (authenticated)", async () => void (await run("gh", ["auth", "status"], { env: toolEnv })))
      : attempt("gh", () => onPath("gh", toolEnv)),
    attempt("claude", () => onPath("claude", toolEnv)),
  ]);

  // A config that won't load is already the repo group's ✗ (`config loads + sources buildable`);
  // here it just means we can't say what tooling this host needs, so we say nothing.
  if (repo) {
    let config: Config | undefined;
    try {
      config = loadConfig(repo).config;
    } catch {
      config = undefined;
    }
    if (config) provided.push(...(await agentToolingChecks(agentTooling(config), deep, toolEnv)));
  }

  return [
    { title: "managed by herdr-factory", checks: managed },
    { title: "you provide (install + auth)", checks: provided },
  ];
}

/** Repo-specific checks: config validity, the repo checkout, origin, work sources, and evidence.
 *  A config-load failure is a ✗ (not a throw), so the caller can still show the base groups.
 *  `deep` = also interact with services (work-source health endpoints, an evidence-bucket write
 *  probe); the default only inspects local config. */
export async function repoGroup(repo: string, deep = false): Promise<DoctorGroup> {
  const checks: DoctorCheck[] = [];
  let deps: Deps | undefined;
  checks.push(
    // Naming matters: buildDeps also CONSTRUCTS each source client, and a descriptor's create()
    // may throw on an unbuildable source (e.g. github_issues with no resolvable repo) even when
    // the YAML itself is schema-valid — the label must not send the operator to the config file.
    await attempt("config loads + sources buildable", async () => {
      // Read with THIS code, like the server's claim gate: a file it can't load stops claims there.
      const invalid = configLoadError(repo);
      if (invalid) throw new Error(`config invalid: ${invalid} — the server claims nothing for this repo until it loads`);
      deps = await buildDeps(repo);
    }),
  );
  if (deps) {
    const d = deps;
    checks.push(await attempt("repo.path is a main git checkout", async () => assertMainCheckout(d.config.repo.path)));
    checks.push(
      await attempt("git origin resolved", async () => {
        if (!d.ghRepo) throw new Error("no origin — set repo.github or add a git remote");
        return d.ghRepo;
      }),
    );
    for (const src of d.sources) {
      // The pickup labels of every belt feeding this source (deduped) — a label-driven source
      // health-checks each one is usable; a label-less source ignores them.
      const pickupLabels = [...new Set(d.belts.filter((b) => b.source === src.name).map((b) => b.label).filter((l): l is string => !!l))];
      // Default: it's configured (local). Deep: hit the backend's health endpoint (network).
      if (deep) {
        checks.push(await attempt(`source ${src.name} (${src.type})`, async () => void (await src.client.health(pickupLabels))));
      } else {
        checks.push({ name: `source ${src.name} (${src.type})`, ok: true, detail: "configured (--deep to health-check)" });
      }
      // Auth readiness — the source's own cheap, no-network view (INV-12). Covers what the secrets
      // manifest can't (github's `gh auth token` fallback), and reads back the actionable hint. A
      // present-but-rejected credential still shows ✓ here; deep's health() is what exercises it.
      checks.push(
        await attempt(`auth ${src.name} (${src.type})`, async () => {
          const st = await src.client.authStatus();
          if (st.state === "unauthenticated") throw new Error(st.detail ?? "not authenticated");
          return st.state === "not_applicable" ? "no auth required" : "credentials present";
        }),
      );
      // Required secrets present is a cheap local check (driven by the type's descriptor
      // manifest) — keep in both modes; deep's health() proves they actually work.
      const required = descriptorFor(src.type).secrets.filter((s) => s.required);
      if (required.length > 0) {
        checks.push(
          await attempt(`${src.type} secrets for ${src.name}`, async () => {
            const missing = required.filter((s) => !d.env[s.envKey]);
            if (missing.length > 0) {
              throw new Error(missing.map((s) => `${s.envKey} missing in the repo env file — ${s.hint}`).join("; "));
            }
          }),
        );
      }
    }
    const ev = d.config.evidence;
    // Default: report it's configured (local, no network). Deep: a per-publisher active round-trip
    // (S3 PutObject write-probe · local static-serve round-trip · command dry-run) — see each
    // publisher's deepProbe. Uploads land under <key_root>/<github_username>/<key_prefix>/… .
    if (!ev) {
      checks.push({ name: "evidence", ok: true, detail: "not configured (optional)" });
    } else if (deep) {
      const publisher = createEvidencePublisher(ev, { currentLogin: () => d.github.currentLogin() });
      checks.push(await attempt(`evidence publisher (${ev.publisher})`, () => publisher.deepProbe()));
    } else {
      checks.push({ name: "evidence", ok: true, detail: `${describeEvidence(ev)} — --deep to probe` });
    }
    // Evidence-upload outbox health (local, no network): pending uploads still retrying. An auth-class
    // stuck upload almost always means the AWS SSO session expired — the actionable fix (S3 only).
    if (ev) {
      const pending = d.store
        .listIntents(repo, { kind: "evidence_publish", status: "pending" })
        .map((i) => ({ errorKind: i.errorClass as string | null, lastError: i.lastError }));
      const profile = ev.publisher === "s3" ? ev.profile : undefined;
      if (pending.length === 0) {
        checks.push({ name: "evidence uploads", ok: true, detail: "none pending" });
      } else if (pending.some((u) => u.errorKind === "auth")) {
        checks.push({ name: "evidence uploads", ok: false, detail: `${pending.length} stuck on AWS creds — ${credsRefreshHint(profile)}` });
      } else {
        checks.push({ name: "evidence uploads", ok: true, detail: `${pending.length} pending — retrying (last: ${pending[pending.length - 1]!.lastError ?? "not yet attempted"})` });
      }
    }
  }
  return { title: `repo ${repo}`, checks };
}

/** Shallow (no-network) one-line summary of where evidence publishes, per publisher. Shows the
 *  gh-login placeholder rather than resolving it (that would be a network call). */
function describeEvidence(ev: NonNullable<Deps["config"]["evidence"]>): string {
  const folder = [ev.keyRoot, ev.githubUsername ?? "<gh-login>", ev.keyPrefix].filter(Boolean).join("/");
  switch (ev.publisher) {
    case "s3":
      return `configured: s3 → s3://${ev.bucket}/${folder}/ (${ev.region})`;
    case "local":
      return `configured: local → served at ${ev.publicBaseUrl ?? "http://127.0.0.1:<port>"}/evidence/${folder}/`;
    case "command":
      return `configured: command → \`${ev.command.join(" ")}\` (uploads + prints URLs)`;
  }
}
