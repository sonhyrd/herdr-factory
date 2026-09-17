// Health checks, shared by the `doctor` CLI command (prints ✓/✗) and the TUI Doctor tab (renders
// ✓/✗). Each check returns a structured result so both consumers render it however they like — the
// check logic lives in exactly one place. Grouped by ownership: what herdr-factory provisions &
// maintains itself vs the external tools + auth the user supplies. Repo-specific checks are a
// separate group behind `--repo`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidencePublisher, credsRefreshHint } from "./clients/evidence.ts";
import { run } from "./clients/exec.ts";
import { assertMainCheckout, globalDbPath, isManagedNode } from "./config.ts";
import { descriptorFor } from "./sources/registry.ts";
import { buildDeps } from "./build-deps.ts";
import { availableMemoryMb, loadMachineConfig, machineConfigPath } from "./machine.ts";
import type { Deps } from "./core/deps.ts";
import { pingHealth, readServerInfo } from "./server/client.ts";
import * as service from "./watchers/service.ts";
import { readUpdateStatus, updateChannel } from "./watchers/update-status.ts";

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

/** A compact "3m ago" / "2h ago" / "5d ago" for an epoch-ms timestamp (relative to now). */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
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

/** Machine-wide checks, grouped by ownership. No repo needed.
 *  `deep` = also interact with external services (gh auth, herdr daemon); the default is local-only
 *  and side-effect-free (tool presence, no network calls). */
export async function baseGroups(deep = false): Promise<DoctorGroup[]> {
  const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
  const info = readServerInfo();
  const running = info ? await pingHealth(info.port).catch(() => false) : false;

  const managed = await Promise.all([
    attempt("node runtime >= 26", async () => {
      if (Number(process.versions.node.split(".")[0]) < 26) throw new Error(`v${process.versions.node} is too old`);
      return `v${process.versions.node}, ${isManagedNode(process.execPath) ? "vendored" : "ambient"}`;
    }),
    updateCheck(),
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
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : `none — per-repo caps only (${machineConfigPath()} absent or empty)`;
    }),
    attempt("database", async () => {
      const p = globalDbPath();
      if (!existsSync(p)) throw new Error("not initialized yet (created on the first `serve`)");
      return p;
    }),
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
    // publisher's deepProbe. Uploads land under herdr-factory/<github_username>/<key_prefix>/… .
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
  const folder = ["herdr-factory", ev.githubUsername ?? "<gh-login>", ev.keyPrefix].filter(Boolean).join("/");
  switch (ev.publisher) {
    case "s3":
      return `configured: s3 → s3://${ev.bucket}/${folder}/ (${ev.region})`;
    case "local":
      return `configured: local → served at ${ev.publicBaseUrl ?? "http://127.0.0.1:<port>"}/evidence/${folder}/`;
    case "command":
      return `configured: command → \`${ev.command.join(" ")}\` (uploads + prints URLs)`;
  }
}
