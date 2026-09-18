// Layout matching, planning, and application.
//
// Absorbed from herdr-plugin-workspace-manager, and re-converged with it on herdr 0.7.5's native
// APIs (the plugin's v0.6.0 rebuild): the topology is declarative, agents are herdr's to start, and
// nothing is typed into a shell that might not be listening — with one deliberate exception, the
// setup command of a pane that also hosts an agent, which is run in the pane only once its shell is
// idle (see `paneScript`/`runSetupInPane`: herdr will not adopt an agent into a pane whose process is
// a script).
//
//   • resolveBeltLayout — pick the layout for a worktree from its belt (branch globs → default).
//   • pruneLayoutToBelt — drop the tabs of a shared layout no step on THIS belt uses (layout-match).
//   • tabTree           — turn one configured tab into herdr's declarative pane tree: splits with
//                         their ratios, labels, cwd, env, and each pane's command as ARGV.
//   • splitRatio        — the size → ratio conversion, given the region being split.
//   • applyLayout       — one `layout.apply` per tab, then setup, then the agents.
//
// What each piece replaced, and why:
//   – One request per tab instead of a `pane split` + `pane rename` + `pane run` round-trip per pane.
//     A cell `size` resolves against the tab area queried ONCE rather than re-measuring after every
//     split, and no symbolic handle map is needed: herdr echoes the tree back with the ids filled in.
//   – Pane commands are the pane's PROCESS, not keystrokes typed into its shell: they can't race a
//     shell that isn't ready and don't appear in scrollback. They still run inside the user's
//     interactive LOGIN shell, because that is what they used to get — dropping it would silently
//     break any command whose toolchain comes from a shell rc hook (mise, asdf, nvm). The one typed
//     command (an agent pane's setup) goes through that same login shell as a child, so the identical
//     `setup.command` behaves identically wherever it runs.
//   – Setup reports through a status FILE it writes itself, instead of printing a sentinel that
//     `pane wait-output` scraped back — a marker could scroll out of the matched rows, wrap, or be
//     matched from the shell's own echo before the command had run.
//   – An agent is started by herdr (`agent start --kind --pane`), which returns only once it has
//     detected the agent and marked it ready for input.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LayoutAgent, LayoutConfig, LayoutPane, LayoutSize, LayoutTab } from "../config.ts";
import { stateRoot } from "../config-paths.ts";
import type { LayoutNode, PaneBox } from "../types.ts";
import type { Deps } from "./deps.ts";
import { telemetrySpan } from "../telemetry/index.ts";

// Pure worktree→layout matching lives in the leaf ./layout-match.ts (so the lean event-hook entry
// can import it without this module's runner/telemetry graph). Re-exported here for existing callers.
export { globMatch, resolveBeltLayout, resolveHookLayout, pruneLayoutToBelt, beltTargetedTabs } from "./layout-match.ts";

// ── Shell wrapping ────────────────────────────────────────────────────────────────────────────────

/** Quote a script for embedding as one single-quoted shell word. */
const singleQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** `$SHELL`, falling back to /bin/sh — expanded by the outer `sh`, not by us. */
const USER_SHELL = '"${SHELL:-/bin/sh}"';

/** Wrap a script as argv for herdr to launch as the pane's process. The user's own LOGIN+interactive
 *  shell, not a bare `sh`: the old implementation typed commands into the pane's interactive shell,
 *  so `.zshrc`/`.bash_profile` setup (mise/asdf shims, nvm, PATH edits) was already applied. */
export const shellArgv = (script: string): string[] => ["sh", "-c", `exec ${USER_SHELL} -lic ${singleQuote(script)}`];

/** Hand the pane back to an interactive shell once its command finishes, so a pane whose command
 *  exits behaves like one you ran the command in yourself — and so `agent start`, which requires a
 *  pane sitting at its shell prompt, has one to attach to. Interactive but NOT login: the wrapper
 *  above already ran the login files and this shell inherits their exported environment; re-running
 *  them would fire login-only side effects (another ssh-agent, another MOTD) a second time. */
export const HAND_BACK = `exec ${USER_SHELL} -i`;

/** Record the setup command's exit status where the runner can read it. `$?` is captured immediately
 *  after the command, before anything else can overwrite it. */
const recordStatus = (statusPath: string): string => `printf '%s' "$?" > ${singleQuote(statusPath)}`;

/** The setup command as a line to RUN IN a setup pane that hosts an agent (see `paneScript`), rather
 *  than baking it into the pane's own process.
 *
 *  It goes through the same login+interactive shell a pane-PROCESS command gets (`shellArgv`) so the
 *  identical `setup.command` behaves identically either way — a toolchain that comes from a shell rc
 *  hook (mise, asdf, nvm, `brew shellenv` in `.zprofile`) must not depend on whether the pane happens
 *  to host an agent. But as a CHILD, never `exec`: the pane's own shell has to survive, because that
 *  is exactly what `agent start` attaches to. */
export const setupScript = (setup: { command: string; statusPath: string }): string =>
  `${USER_SHELL} -lic ${singleQuote(`${setup.command}; ${recordStatus(setup.statusPath)}`)}`;

/** The script a pane runs, or undefined for a plain shell pane.
 *
 *  An AGENT pane is deliberately left script-free even when it is the layout's setup pane. Baking the
 *  setup in makes the pane's process a wrapper script ending in `exec $SHELL -i`, and herdr will NOT
 *  adopt an agent into that re-exec'd shell: `agent start` accepts the pane, launches nothing, and
 *  times out after 60s, so every step targeting the pane burns its layout wait and the run parks
 *  `layout_wait_timeout`. (Found end-to-end — `test/e2e/scenarios/layout-setup-on-agent-pane.e2e.ts`;
 *  `pane process-info` shows the pane's process replaced by a non-login `/bin/bash -i` where a
 *  working agent pane shows herdr's own shell.) The runner instead runs `setupScript` IN the pane
 *  with `pane run` once it exists, which is what a human would do and leaves herdr's shell intact. */
export function paneScript(pane: LayoutPane, setup?: { command: string; statusPath: string }): string | undefined {
  const parts: string[] = [];
  if (setup && !pane.agent) {
    parts.push(setup.command, recordStatus(setup.statusPath));
  }
  if (pane.command) parts.push(pane.command);
  if (parts.length === 0) return undefined;
  // A plain pane and a `persist` command pane must end at a prompt. (An agent pane can't reach here:
  // config forbids `agent` + `command`, and its setup is run in the pane rather than baked in, so it
  // has no script at all.)
  if (!pane.command || pane.persist) parts.push(HAND_BACK);
  return parts.join("; ");
}

// ── Planning: a configured tab → herdr's declarative pane tree ────────────────────────────────────

/** Clamp a split ratio into herdr's usable open interval (0, 1). A fixed cell size that meets or
 *  exceeds the available space would otherwise produce a degenerate 0-width pane. */
export function clampRatio(r: number): number | undefined {
  if (!Number.isFinite(r)) return undefined;
  return Math.min(0.99, Math.max(0.01, r));
}

/** The ratio for one split: the fraction the FIRST (existing) side keeps, herdr's convention.
 *
 *  A pane's `size` sizes the NEW (second) side, so it inverts: percent p → first keeps 1 - p/100;
 *  cells w → first keeps 1 - w/extent, where `extent` is the region being split along the split axis.
 *  Legacy `ratio` (already the first side's share) passes through. Returns undefined when nothing
 *  sizes the split, or when a cell size can't be converted (unknown extent) — an even split then. */
export function splitRatio(pane: LayoutPane, extent: number | undefined): number | undefined {
  if (pane.ratio != null) return pane.ratio;
  const size: LayoutSize | undefined = pane.size;
  if (!size) return undefined;
  if ("percent" in size) return clampRatio(1 - size.percent / 100);
  if (extent == null || !Number.isFinite(extent) || extent <= 0) return undefined;
  return clampRatio(1 - size.cells / extent);
}

/** herdr's own even split. `layout.apply` requires an explicit ratio on every split node, so there is
 *  no "let herdr decide" to defer to. */
export const EVEN_RATIO = 0.5;

/** What's left of a region for everything after a split that gave `ratio` to the first side. */
const remaining = (box: PaneBox, direction: "right" | "down", ratio: number): PaneBox =>
  direction === "right" ? { ...box, cols: box.cols * (1 - ratio) } : { ...box, rows: box.rows * (1 - ratio) };

/**
 * Build one tab's herdr pane tree. The config's pane list is linear — pane 0 is the tab's root pane
 * and each later pane splits off the one before it — which maps onto a right-nested tree:
 *
 *   panes [a, b(right), c(down)]  ->  split(right, a, split(down, b, c))
 *
 * so every `size` keeps meaning "this share of the pane I split from", not "of the whole tab".
 * `box` is the tab's cell area; it is tracked down the tree so a fixed `cells` size resolves against
 * the region actually being split. Omit it and percentages still work exactly (they're relative)
 * while cell sizes fall back to an even split.
 */
export function tabTree(tab: LayoutTab, opts: { cwd?: string; box?: PaneBox; setup?: { command: string; statusPath: string } } = {}): LayoutNode {
  const leaf = (pane: LayoutPane): LayoutNode => {
    const script = paneScript(pane, pane.setup ? opts.setup : undefined);
    return {
      type: "pane",
      ...(pane.title ? { label: pane.title } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(script ? { command: shellArgv(script) } : {}),
      ...(Object.keys(pane.env).length > 0 ? { env: pane.env } : {}),
    };
  };

  const build = (index: number, box: PaneBox | undefined): LayoutNode => {
    const pane = tab.panes[index]!;
    const next = tab.panes[index + 1];
    if (!next) return leaf(pane);
    const direction = next.split ?? "right";
    const extent = box ? (direction === "right" ? box.cols : box.rows) : undefined;
    const ratio = splitRatio(next, extent) ?? EVEN_RATIO;
    return {
      type: "split",
      direction,
      ratio,
      first: leaf(pane),
      second: build(index + 1, box ? remaining(box, direction, ratio) : undefined),
    };
  };
  return build(0, opts.box);
}

// ── The setup status file ─────────────────────────────────────────────────────────────────────────

const setupDir = (): string => join(stateRoot(), "layout-hook", "setup");

/** Where one build's setup command should record its exit status. Unique per build, so two worktrees
 *  created at once can't read each other's. */
export function setupStatusPath(token: string): string {
  const dir = setupDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, `${token}.status`);
}

/** Drop status files left behind by builds that died before reading theirs (called from the one-shot
 *  `[[startup]]` hook). Returns the count reaped. */
export function reapSetupStatusFiles(maxAgeMs = 24 * 60 * 60 * 1000): number {
  let reaped = 0;
  const dir = setupDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // nothing has ever run setup
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p, { force: true });
        reaped += 1;
      }
    } catch {
      /* raced with another reader — leave it */
    }
  }
  return reaped;
}

// ── Application: build the tabs, then setup, then the agents ──────────────────────────────────────

/** The worktree we build a layout INTO: its existing root tab (whose panes `layout.apply` replaces —
 *  absent, every tab is APPENDED and nothing already there is touched) and the checkout path every
 *  pane should open in. `rootPaneId` is used to measure the tab area. */
export interface LayoutTarget {
  workspaceId: string;
  rootTabId?: string;
  rootPaneId?: string;
  cwd?: string;
  /** Extra env for every pane on top of the layout's own (e.g. the run's work key). */
  env?: Record<string, string>;
}

/** Cap on a blocking setup command — a hung setup must not wedge the build forever. A timeout is
 *  REPORTED, not fatal: the layout is already built, and a slow setup shouldn't invalidate it. */
const SETUP_TIMEOUT_MS = 600_000;
const SETUP_POLL_MS = 200;
/** How long to wait for a pane to be back at its shell prompt before starting an agent in it. */
const SHELL_READY_TIMEOUT_MS = 15_000;
const SHELL_READY_POLL_MS = 100;
/** herdr's own default wait for a spawned agent to reach interactive readiness (`agent_timeout_ms`
 *  overrides it per pane). */
const AGENT_READY_TIMEOUT_MS = 60_000;
/** The metadata token a build reports setup progress on, so a long or failed setup is visible in the
 *  UI rather than only in the log. */
const SETUP_TOKEN = "hf_setup";

/** Build `layout` into the target worktree via herdr. Emits a `layout.apply` span. Throws if the
 *  TOPOLOGY can't be built — the caller (the layout hook) records that and releases its claim so the
 *  build is retried. A failed setup or agent does NOT throw: the layout is already there, and tearing
 *  it down over one pane would lose the rest. */
export async function applyLayout(deps: Deps, target: LayoutTarget, layout: LayoutConfig): Promise<void> {
  return telemetrySpan(
    "layout.apply",
    { repo: deps.config.repoName, "herdr.workspace_id": target.workspaceId, "layout.id": layout.id },
    () => applyLayoutImpl(deps, target, layout),
  );
}

/** One built pane: the configured pane and the real herdr pane id it became. */
interface BuiltPane {
  pane: LayoutPane;
  paneId: string;
}

async function applyLayoutImpl(deps: Deps, target: LayoutTarget, layout: LayoutConfig): Promise<void> {
  // Measure the tab ONCE, before anything is split: `pane layout` reports the whole tab's cell area,
  // which is what every `cells` size resolves against as tabTree walks down.
  const box = target.rootPaneId ? ((await deps.herdr.tabArea(target.rootPaneId)) ?? undefined) : undefined;
  const setup = layout.setup ? { command: layout.setup.command, statusPath: setupStatusPath(deps.uid()) } : undefined;

  const built: BuiltPane[] = [];
  let setupPaneId: string | undefined;
  let setupSettled = setup == null;
  // An agent setup pane carries no spawn script (see paneScript), so its setup has to be RUN in it.
  // `setupRun` resolves to whether the command was actually issued; everything that depends on the
  // setup awaits it first (`setupIssued`).
  let setupNeedsRun = false;
  let setupRun: Promise<boolean> | null = null;

  for (const [index, tab] of layout.tabs.entries()) {
    // Extra env (the run's work key) rides on every pane, under the layout's own.
    const panes = target.env
      ? tab.panes.map((p) => ({ ...p, env: { ...target.env, ...p.env } }))
      : tab.panes;
    const tree = tabTree({ ...tab, panes }, { cwd: target.cwd, box, setup });
    // Tab 0 REBUILDS the worktree's existing tab (herdr builds the replacement first, then closes the
    // old one, so the workspace is never briefly tabless); later tabs are created by the same call.
    // With no root tab, tab 0 is created too — a new tab set beside whatever is already there.
    // `tab_id` and `workspace_id` are mutually exclusive; `tab_label` applies either way.
    const applied = await deps.herdr.layoutApply({
      ...(index === 0 && target.rootTabId ? { tabId: target.rootTabId } : { workspaceId: target.workspaceId }),
      tabLabel: tab.title,
      root: tree,
    });
    if (applied.paneIds.length !== tab.panes.length) {
      throw new Error(`layout "${layout.id}": herdr built ${applied.paneIds.length} panes for tab ${index}, expected ${tab.panes.length}`);
    }
    tab.panes.forEach((pane, j) => {
      const paneId = applied.paneIds[j]!;
      built.push({ pane, paneId });
      if (pane.setup && setup) {
        setupPaneId = paneId;
        setupNeedsRun = pane.agent != null;
      }
    });
    deps.log("info", `layout "${layout.id}": applied tab ${index} → ${applied.tabId} (${tab.panes.length} pane(s))`);

    // An agent setup pane's command isn't part of its process — issue it the moment the pane exists.
    // Deliberately NOT awaited here: `runSetupInPane` first waits for that pane's shell (up to
    // SHELL_READY_TIMEOUT_MS), and a NON-blocking setup must not delay the remaining tabs, which it
    // never did when the command was the pane's own process.
    if (setup && setupPaneId && setupNeedsRun && !setupRun) {
      setupRun = runSetupInPane(deps, layout, setup, setupPaneId);
    }

    // A blocking setup must finish before any later tab is spawned.
    if (setup && layout.setup?.blocking && !setupSettled && setupPaneId) {
      if (await setupIssued(setupRun)) await awaitSetup(deps, layout, setup.statusPath, setupPaneId);
      setupSettled = true;
    }
  }

  const agentNames: string[] = []; // herdr requires uniqueness among live agents — see deriveAgentName
  for (const { pane, paneId } of built) {
    if (!pane.agent) continue;
    // An agent is started INTO the pane's shell, so setup running in that same pane must be finished
    // first even when it isn't marked blocking.
    if (setup && !setupSettled && setupPaneId === paneId) {
      deps.log("info", `layout "${layout.id}": waiting for setup before starting the agent in its pane`);
      if (await setupIssued(setupRun)) await awaitSetup(deps, layout, setup.statusPath, paneId);
      setupSettled = true;
    }
    await startAgent(deps, layout, pane.agent, paneId, target.workspaceId, agentNames);
  }

  if (setup && !setupSettled) deps.log("info", `layout "${layout.id}": setup is running in ${setupPaneId ?? "its pane"} (not blocking)`);
}

/** Run the layout's setup command IN an agent pane, rather than as the pane's own process. Keeping
 *  herdr's shell — instead of a wrapper that ends in `exec $SHELL -i` — is what leaves the pane
 *  adoptable by `agent start` (see paneScript). Answers whether the command was actually issued.
 *
 *  A pane that never reaches a prompt is NOT tried anyway: the keystrokes would be dropped, the status
 *  file would never appear, and the caller would then sit out the full SETUP_TIMEOUT_MS (10 min) —
 *  inside the worktree.created hook — for a setup that never ran. Report it like any other setup
 *  failure and let the build continue; the layout still stands and the agent still starts. */
async function runSetupInPane(deps: Deps, layout: LayoutConfig, setup: { command: string; statusPath: string }, paneId: string): Promise<boolean> {
  if (!(await awaitShellPrompt(deps, paneId))) {
    const detail = `setup pane ${paneId} never reached a shell prompt (${SHELL_READY_TIMEOUT_MS}ms) — setup was not run`;
    await deps.herdr.reportPaneDisplay(paneId, { tokens: { [SETUP_TOKEN]: "not-run" } }).catch(() => {});
    deps.log("warn", `layout "${layout.id}": ${detail}`);
    await deps.herdr.notify("herdr-factory: layout setup failed", `${detail} (layout "${layout.id}")`).catch(() => {});
    return false;
  }
  deps.log("info", `layout "${layout.id}": running setup in ${paneId}`);
  await deps.herdr.paneRun(paneId, setupScript(setup));
  return true;
}

/** Was the pane-run setup issued? `null` means there was nothing to issue (the setup rides on a pane's
 *  own process), which counts as issued. Never rejects — a thrown pane-run is "not issued". */
function setupIssued(run: Promise<boolean> | null): Promise<boolean> {
  return run === null ? Promise.resolve(true) : run.catch(() => false);
}

/** Start (and optionally prompt) one pane's agent. Never throws: a failed agent doesn't invalidate
 *  the layout that is already built, so it warns, notifies, and lets the rest of the build stand. */
async function startAgent(deps: Deps, layout: LayoutConfig, agent: LayoutAgent, paneId: string, workspaceId: string, taken: string[]): Promise<void> {
  // `agent start` refuses a pane that isn't at an available shell prompt, and a freshly created pane
  // isn't there yet: the shell is still sourcing rc files (mise/asdf activation, prompt setup), and a
  // setup pane has to finish its command and exec back to a prompt first. Poll for that state rather
  // than sleeping a fixed guess.
  if (!(await awaitShellPrompt(deps, paneId))) {
    deps.log("warn", `layout "${layout.id}": ${paneId} is not back at a shell prompt after ${SHELL_READY_TIMEOUT_MS}ms; starting ${agent.kind} anyway`);
  }
  const name = agent.name ?? deriveAgentName(agent.kind, workspaceId, taken);
  taken.push(name);
  const ok = await deps.herdr.agentAdopt(paneId, {
    name,
    kind: agent.kind,
    args: agent.args,
    timeoutMs: agent.startTimeoutMs ?? AGENT_READY_TIMEOUT_MS,
  });
  if (!ok) {
    deps.log("warn", `layout "${layout.id}": could not start ${agent.kind} in ${paneId}`);
    await deps.herdr.notify("herdr-factory: agent did not start", `${agent.kind} in ${paneId} (layout "${layout.id}")`).catch(() => {});
    return;
  }
  deps.log("info", `layout "${layout.id}": started ${agent.kind} as "${name}" in ${paneId}`);

  if (agent.prompt) {
    // Waiting is opt-in: a prompt timeout means "block until the agent settles or this elapses".
    // Without one the prompt is submitted and the build moves on, leaving the agent working.
    const sent = await deps.herdr.agentOpenPrompt(paneId, agent.prompt, { settleTimeoutMs: agent.promptTimeoutMs });
    deps.log(sent ? "info" : "warn", `layout "${layout.id}": opening prompt for "${name}" ${sent ? "submitted" : "was not accepted"}`);
  }
}

/** A herdr-legal agent name (`[a-z][a-z0-9_-]{0,31}`) for a pane whose config didn't pick one.
 *
 *  Derived from the kind + workspace so two worktrees running the same agent don't collide — herdr
 *  requires the name to be unique among LIVE agents. `taken` disambiguates WITHIN one build, which a
 *  layout hits as soon as it has two panes of the same kind (a `work` and a `pr` claude pane in one
 *  tab): without it the second `agent start` would be refused outright. */
export function deriveAgentName(kind: string, workspaceId: string, taken: readonly string[] = []): string {
  const clean = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  const base = `${clean(kind) || "agent"}-${clean(workspaceId)}`.slice(0, 32).replace(/-+$/, "");
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Poll `pane process-info` until the pane's shell owns the foreground alone — the state
 *  `herdr agent start` requires of a pane before it will start an agent in it. Shared with the
 *  dedicated-pane spawn path (core/step.ts), which creates a pane the same way and hits the same race:
 *  a brand-new pane's shell is still sourcing rc files (mise/asdf activation, prompt setup) for a
 *  moment. Returns false on timeout — callers warn and try anyway, since herdr's own error is clearer
 *  than refusing to start. */
export async function awaitShellPrompt(deps: Deps, paneId: string): Promise<boolean> {
  const deadline = deps.now() * 1000 + SHELL_READY_TIMEOUT_MS;
  // Two consecutive idle samples: a shell sourcing rc files drops in and out of having a child, so a
  // single sample can catch the gap between two of them and call the pane ready a moment early.
  let consecutive = 0;
  for (;;) {
    if (await deps.herdr.paneAtShellPrompt(paneId)) {
      if (++consecutive >= 2) return true;
    } else {
      consecutive = 0;
    }
    if (Date.now() >= deadline) return false;
    await deps.sleep(SHELL_READY_POLL_MS);
  }
}

/** Block on the setup command, reporting progress and outcome on the pane itself. */
async function awaitSetup(deps: Deps, layout: LayoutConfig, statusPath: string, paneId: string): Promise<void> {
  // TTL slightly beyond the wait, so a crashed build can't leave a pane labelled "running" forever.
  await deps.herdr.reportPaneDisplay(paneId, { tokens: { [SETUP_TOKEN]: "running" }, ttlMs: SETUP_TIMEOUT_MS + 30_000 }).catch(() => {});
  deps.log("info", `layout "${layout.id}": waiting for setup in ${paneId}`);

  const outcome = await waitForSetup(deps, statusPath);
  const token = (value: string | null) => deps.herdr.reportPaneDisplay(paneId, { tokens: { [SETUP_TOKEN]: value } }).catch(() => {});
  if (outcome.kind === "exited" && outcome.code === 0) {
    await token(null);
    deps.log("info", `layout "${layout.id}": setup finished in ${paneId}`);
    return;
  }
  const detail =
    outcome.kind === "timeout"
      ? `setup did not finish within ${SETUP_TIMEOUT_MS}ms in ${paneId}`
      : `setup exited ${outcome.code} in ${paneId}`;
  await token(outcome.kind === "timeout" ? "timed-out" : `failed-${outcome.code}`);
  deps.log("warn", `layout "${layout.id}": ${detail}`);
  await deps.herdr.notify("herdr-factory: layout setup failed", `${detail} (layout "${layout.id}")`).catch(() => {});
}

type SetupOutcome = { kind: "exited"; code: number } | { kind: "timeout" };

/** Setup's exit status, once its pane has written it. Polls for the status file the setup script
 *  writes: unlike matching a sentinel in terminal output, this can't be missed because the marker
 *  scrolled away, wrapped, or was echoed back by the shell before the command actually ran. */
async function waitForSetup(deps: Deps, statusPath: string): Promise<SetupOutcome> {
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  for (;;) {
    const code = readSetupStatus(statusPath);
    if (code != null) return { kind: "exited", code };
    if (Date.now() >= deadline) return { kind: "timeout" };
    await deps.sleep(SETUP_POLL_MS);
  }
}

/** The recorded exit code, or null while the file is absent/empty (i.e. "not yet"). Consumes the file
 *  once read, so a later build can't see a stale status. */
function readSetupStatus(statusPath: string): number | null {
  let text: string;
  try {
    if (!existsSync(statusPath)) return null;
    text = readFileSync(statusPath, "utf8").trim();
  } catch {
    return null;
  }
  if (!text) return null; // written by one printf, but an empty read just means "not yet"
  rmSync(statusPath, { force: true });
  const code = Number.parseInt(text, 10);
  return Number.isFinite(code) ? code : 0; // unreadable status ⇒ treat as finished
}
