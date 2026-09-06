// The REAL herdr lane: a headless `herdr server` per world. Verified in a Linux container — it needs
// no TTY, no config.toml and no desktop; it spawns real PTY panes, builds real git worktrees, and
// adopts the harness's scripted agent through `agent start --kind claude`.
//
// Two constraints are load-bearing:
//   * the herdr config dir must sit at a SHORT path — the unix socket lives inside it and a long one
//     overflows sun_path, killing the server at boot (hence /h/<id>, not a deep temp path);
//   * panes inherit the SERVER's environment, so the server is started with the whole world env
//     (world bin first on PATH, HERDR_FACTORY_* , HF_AGENT_*) — that is what lets a step agent's
//     `herdr-factory step-done` reach this world's config and state rather than the real install.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HerdrCall {
  ts: number;
  argv: string[];
}

/** The frame `core/pane-display.ts` wraps every operator report in before submitting it to a pane.
 *  Kept in lock-step with reportToPane — it is how a report is told apart from a step's prompt. */
export const PANE_REPORT_FRAME = "[herdr-factory report";

/** Operator reports pulled out of a recorded argv log — shared by both lanes so they can't drift.
 *
 *  The wrapper logs `printf '%s\n' "$@" | jq -R .`, which is LINE-based, so a multi-line argument
 *  arrives as several array entries: a park report's `resume <KEY>` tail lands in argv[4]/argv[5],
 *  not argv[3]. Rejoin them (stopping at the first flag, since `agent prompt --wait …` puts real
 *  flags after the text) or every assertion on anything below a report's first line silently fails. */
/** The value of a `--flag <value>` argument, rejoined across the lines the wrapper split it into
 *  (see {@link paneReportsFrom}) — a multi-line notification body would otherwise read as its first
 *  line only. Empty string when the flag is absent. */
export function flagValueFrom(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  if (i < 0) return "";
  const lines: string[] = [];
  for (const part of argv.slice(i + 1)) {
    if (part.startsWith("--")) break;
    lines.push(part);
  }
  return lines.join("\n");
}

export function paneReportsFrom(calls: HerdrCall[]): { paneId: string; text: string }[] {
  const out: { paneId: string; text: string }[] = [];
  for (const c of calls) {
    if (c.argv[0] !== "agent" || c.argv[1] !== "prompt") continue;
    const lines: string[] = [];
    for (const part of c.argv.slice(3)) {
      if (part.startsWith("--")) break;
      lines.push(part);
    }
    const text = lines.join("\n");
    if (text.includes(PANE_REPORT_FRAME)) out.push({ paneId: c.argv[2] ?? "", text });
  }
  return out;
}

export interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label?: string | null;
  agent_status?: string;
  focused?: boolean;
  cwd?: string;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  label?: string | null;
  pane_count?: number;
}

export interface Agent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string;
  agent_status: string;
  name?: string;
  cwd?: string;
}

export interface Workspace {
  workspace_id: string;
  label?: string | null;
  worktree?: { checkout_path?: string; repo_root?: string; is_linked_worktree?: boolean };
}

export class HerdrServer {
  private readonly bin: string;
  private readonly env: Record<string, string>;
  private readonly logPath: string;
  private readonly callLog: string;
  private readonly downFlag: string | null;
  private proc: ChildProcess | null = null;

  constructor(opts: { bin: string; env: Record<string, string>; logPath: string; callLog: string; downFlag?: string }) {
    this.bin = opts.bin;
    this.env = opts.env;
    this.logPath = opts.logPath;
    this.callLog = opts.callLog;
    this.downFlag = opts.downFlag ?? null;
  }

  /** Make herdr unreachable **to the factory**, on cue.
   *
   *  The engine's notion of "unreachable" is precisely `herdr agent list` failing (`HerdrClient.agents`
   *  wraps any non-zero/unparseable result in `HerdrUnreachableError`), so the injection point is the
   *  world's `herdr` wrapper: while the flag file exists it refuses every call the way a herdr with no
   *  server does. The real server keeps running — killing it would also destroy the panes, which is a
   *  DIFFERENT failure (confirmed-gone) and would make a defer-vs-park assertion meaningless.
   *
   *  The harness's own queries bypass the wrapper (this class runs the binary directly), so the world
   *  stays fully observable throughout the outage. */
  set unreachable(down: boolean) {
    if (!this.downFlag) throw new Error("HerdrServer: no downFlag configured — cannot inject an outage");
    if (down) writeFileSync(this.downFlag, "");
    else rmSync(this.downFlag, { force: true });
  }

  get unreachable(): boolean {
    return this.downFlag != null && existsSync(this.downFlag);
  }

  /** Run a herdr CLI command with the world env. `allowFail` mirrors the engine's own posture. */
  cli(args: string[], opts: { timeoutMs?: number } = {}): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(this.bin, args, { env: this.env, encoding: "utf8", timeout: opts.timeoutMs ?? 60_000 });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  json<T>(args: string[]): T | null {
    const r = this.cli(args);
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    mkdirSync(join(this.env.XDG_CONFIG_HOME ?? this.env.HOME ?? "/tmp", "herdr"), { recursive: true });
    const out = createWriteStream(this.logPath, { flags: "a" });
    this.proc = spawn(this.bin, ["server"], { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.proc.stdout?.pipe(out);
    this.proc.stderr?.pipe(out);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      // Short per-probe timeout: a not-yet-listening socket must cost ~ms, not the 60s default, or
      // the readiness deadline is never even evaluated.
      const probe = this.cli(["workspace", "list"], { timeoutMs: 4000 });
      if (probe.code === 0 && probe.stdout.includes('"result"')) return;
      if (this.proc.exitCode !== null) {
        throw new Error(
          `herdr server exited (${this.proc.exitCode}) during startup:\n${tail(this.logPath, 30)}\nlast probe: ${probe.stderr || probe.stdout}`,
        );
      }
      await delay(200);
    }
    throw new Error(
      `herdr server did not become ready in 30s (bin=${this.bin}):\n${tail(this.logPath, 30)}\n` +
        `last probe: ${JSON.stringify(this.cli(["workspace", "list"], { timeoutMs: 4000 }))}`,
    );
  }

  /** Register the factory as a herdr plugin so `worktree.created` builds a belt's layout. Best-effort
   *  before the server is up (it may need the socket), retried after. */
  linkPlugin(repoRoot: string): boolean {
    const r = this.cli(["plugin", "link", repoRoot]);
    return r.code === 0;
  }

  pluginLog(): string {
    const r = this.cli(["plugin", "log", "list", "--plugin", "herdr-factory"]);
    return r.code === 0 ? r.stdout : `(plugin log unavailable: ${r.stderr.trim()})`;
  }

  workspaces(): Workspace[] {
    return this.json<{ result?: { workspaces?: Workspace[] } }>(["workspace", "list"])?.result?.workspaces ?? [];
  }

  /** The workspace whose worktree checkout path ends with `suffix` (a branch slug). */
  workspaceFor(suffix: string): Workspace | undefined {
    return this.workspaces().find((w) => (w.worktree?.checkout_path ?? "").endsWith(suffix));
  }

  tabs(workspaceId: string): Tab[] {
    return this.json<{ result?: { tabs?: Tab[] } }>(["tab", "list", "--workspace", workspaceId])?.result?.tabs ?? [];
  }

  panes(workspaceId: string): Pane[] {
    return this.json<{ result?: { panes?: Pane[] } }>(["pane", "list", "--workspace", workspaceId])?.result?.panes ?? [];
  }

  agents(): Agent[] {
    return this.json<{ result?: { agents?: Agent[] } }>(["agent", "list"])?.result?.agents ?? [];
  }

  /** The pane tree as `<tab label>/<pane label>` strings — what a layout assertion compares against. */
  paneLabels(workspaceId: string): string[] {
    const tabs = new Map(this.tabs(workspaceId).map((t) => [t.tab_id, t.label ?? "?"]));
    return this.panes(workspaceId)
      .map((p) => `${tabs.get(p.tab_id) ?? "?"}/${p.label ?? "?"}`)
      .sort();
  }

  /** A pane's recent terminal output. `pane read` works whether or not the pane hosts an agent,
   *  which is what makes it the tool for "why did this layout pane never come up?". */
  readPane(paneId: string, lines = 20): string {
    const r = this.cli(["pane", "read", paneId, "--source", "recent", "--lines", String(lines), "--format", "text"]);
    return r.code === 0 ? r.stdout : `(pane read failed: ${r.stderr.trim() || r.stdout.trim()})`;
  }

  /** What herdr sees running in a pane — `agent start` refuses a pane whose shell isn't idle, so this
   *  is the first question to ask when an agent never comes up. */
  processInfo(paneId: string): string {
    const r = this.cli(["pane", "process-info", "--pane", paneId]);
    return r.code === 0 ? r.stdout.trim() : `(process-info failed: ${r.stderr.trim()})`;
  }

  /** Every pane's screen + process in a workspace — the layout post-mortem. */
  screens(workspaceId: string, lines = 20): string {
    const tabs = new Map(this.tabs(workspaceId).map((t) => [t.tab_id, t.label ?? "?"]));
    return this.panes(workspaceId)
      .map(
        (p) =>
          `··· ${tabs.get(p.tab_id) ?? "?"}/${p.label ?? "?"} (${p.pane_id}, agent_status=${p.agent_status ?? "-"}) ···\n` +
          `${this.processInfo(p.pane_id)}\n${this.readPane(p.pane_id, lines)}`,
      )
      .join("\n");
  }

  /** Every pane of every workspace — the whole terminal state of the world in one string. */
  allScreens(lines = 200): string {
    const ws = this.workspaces();
    if (ws.length === 0) return "(no workspaces)";
    return ws.map((w) => `═══ workspace ${w.workspace_id} (${w.label ?? "?"}) ═══\n${this.screens(w.workspace_id, lines)}`).join("\n\n");
  }

  /** Create a worktree by hand — the "someone made a worktree outside the factory" layout path. */
  worktreeCreate(repoCwd: string, branch: string, baseRef = "origin/main"): { workspaceId: string; path: string } | null {
    const j = this.json<{ result?: { workspace?: { workspace_id?: string; worktree?: { checkout_path?: string } } } }>([
      "worktree",
      "create",
      "--cwd",
      repoCwd,
      "--branch",
      branch,
      "--base",
      baseRef,
      "--no-focus",
      "--json",
    ]);
    const ws = j?.result?.workspace;
    return ws?.workspace_id ? { workspaceId: ws.workspace_id, path: ws.worktree?.checkout_path ?? "" } : null;
  }

  /** Every herdr invocation the FACTORY made, from the world's `herdr` wrapper. */
  calls(): HerdrCall[] {
    if (!existsSync(this.callLog)) return [];
    const lines = readFileSync(this.callLog, "utf8").split("\n").filter(Boolean);
    const out: HerdrCall[] = [];
    for (const [i, l] of lines.entries()) {
      try {
        out.push(JSON.parse(l) as HerdrCall);
      } catch {
        // A live process may be mid-append, so the LAST line is allowed to be torn. Anything else is
        // a broken wrapper, and must not be swallowed: silently degrading here once turned every
        // notification assertion into a no-op (`date +%s%3N` is GNU-only, so on macOS every line was
        // unparseable and `notifications()` always answered "none fired").
        if (i === lines.length - 1) continue;
        throw new Error(`herdr call log has an unparseable line (${this.callLog}:${i + 1}): ${l}`);
      }
    }
    return out;
  }

  /** Desktop notifications the engine fired — only observable through the wrapper. */
  notifications(): { title: string; body: string }[] {
    return this.calls()
      .filter((c) => c.argv[0] === "notification" && c.argv[1] === "show")
      .map((c) => ({ title: c.argv[2] ?? "", body: flagValueFrom(c.argv, "--body") }));
  }

  /** Operator-facing reports the engine submitted INTO a run's pane (`core/pane-display.ts`
   *  reportToPane → `herdr agent prompt <pane> <text>`). This is where a park's explanation goes for
   *  a mechanical failure (a budget, a stall, a suspended job) and for any park on a source whose
   *  reply channel is a FILE (`local_markdown`) — a note in a hidden folder is where nobody looks.
   *  Only a comments source (jira/github_issues/sentry) gets a note on the item instead
   *  (`World.waitForNote`). Matched on the frame reportToPane wraps every report in. */
  paneReports(): { paneId: string; text: string }[] {
    return paneReportsFrom(this.calls());
  }

  /** Display metadata the engine published on panes (the ⚠ ATTENTION title, hf_* tokens). */
  paneMetadata(): { paneId: string; argv: string[] }[] {
    return this.calls()
      .filter((c) => c.argv[0] === "pane" && c.argv[1] === "report-metadata")
      .map((c) => ({ paneId: c.argv[2] ?? "", argv: c.argv }));
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.cli(["server", "stop"], { timeoutMs: 15_000 });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && this.proc.exitCode === null) await delay(150);
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    this.proc = null;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function tail(file: string, lines: number): string {
  if (!existsSync(file)) return `(no ${file})`;
  const all = readFileSync(file, "utf8").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}
