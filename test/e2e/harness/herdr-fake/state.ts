// Scenario-facing control + query surface for the FAKE herdr lane (./herdr is the shim; ./README.md
// documents the argv surface, the injection knobs and the blind spots).
//
// Every PUBLIC METHOD here matches `HerdrServer` in ../herdr.ts — same names, same signatures, same
// return shapes (the shared `Agent`/`Pane`/`Tab`/`Workspace`/`HerdrCall` types are imported from
// there, not re-declared, so the two lanes cannot drift). A scenario must not care which lane it is
// on: `w.herdr.agents()` reads the same either way.
//
// The difference is what the extra members buy: this lane can be told to FAIL. `unreachable`,
// `hideAgent()`, `killAgent()`, `failSubcommand()`, `stallPrompt()` and `latency()` drive engine paths
// a real herdr cannot be asked for — HerdrUnreachableError must DEFER rather than park a healthy run,
// a respawn needs TWO confirmed absences ≥45s apart, a dropped prompt must not start a budget clock.
//
// Every knob is written to an injection FILE the shim re-reads on every invocation, so it takes effect
// on the very next engine call — the resident `serve` was started with a fixed environment and would
// never see an env change (which is also why the env forms are only useful as static scenario setup).
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flagValueFrom, paneReportsFrom } from "../herdr.ts";
import type { Agent, HerdrCall, Pane, Tab, Workspace } from "../herdr.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The shim a world puts on `HERDR_BIN_PATH`. */
export const FAKE_HERDR_SHIM = join(HERE, "herdr");

/** One pane in the shim's state file. Read-only from a scenario's point of view — mutate through the
 *  CLI (which is what the engine does) rather than by editing this. */
export interface FakePane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label: string | null;
  cwd: string;
  env: Record<string, string>;
  focused: boolean;
  /** Synthetic shell pid: `pane process-info` reports it as the pane's idle foreground. */
  shell_pid: number;
  seq: number;
  /** The launched agent process (`agent start`, or a `pane run` herdr would auto-detect). */
  agent: { name: string; kind: string; pid: number; session_id: string; started_at: number } | null;
  /** A plain command running in the pane (`pane run` of a layout `setup`), which is not an agent. */
  command: { pid: number; command: string } | null;
  metadata: { seq?: number; source?: string | null; display_agent?: string; title?: string | null; tokens?: Record<string, string> };
}

export interface FakeTab {
  tab_id: string;
  workspace_id: string;
  label: string | null;
  seq: number;
}

export interface FakeWorkspace {
  workspace_id: string;
  label: string | null;
  active_tab_id: string | null;
  worktree?: { checkout_path: string; repo_root: string; repo_name: string; is_linked_worktree: boolean; branch: string };
}

/** A saved SSH machine profile, exactly as `herdr machine list --json` answers one. */
export interface FakeMachineProfile {
  label: string;
  target: string;
  session?: string | null;
  enabled?: boolean;
}

export interface FakeHerdrState {
  seq: number;
  workspaces: Record<string, FakeWorkspace>;
  tabs: Record<string, FakeTab>;
  panes: Record<string, FakePane>;
  plugins: string[];
  machines: FakeMachineProfile[];
}

/** The injection file's schema. Any key present here WINS over its env fallback for that key. */
export interface FakeHerdrInjection {
  /** Subcommands (`"agent list"`, `"worktree create"`, …) or `"*"` that exit non-zero. */
  fail?: string[];
  /** Pane ids (or `"*"`) omitted from `agent list` / reported `gone` while their process lives. */
  hiddenPanes?: string[];
  /** Pane ids (or `"*"`) whose `agent prompt` is refused as `agent_prompt_stalled`, undelivered. */
  promptStall?: string[];
  /** Milliseconds of latency added before answering. */
  sleepMs?: number;
  /** Subcommands the latency applies to (empty = all). */
  sleep?: string[];
}

function blankState(): FakeHerdrState {
  return { seq: 0, workspaces: {}, tabs: {}, panes: {}, plugins: [], machines: [] };
}

export class FakeHerdr {
  private readonly bin: string;
  private readonly env: Record<string, string>;
  private readonly logPath: string;
  private readonly callLog: string;
  readonly statePath: string;
  readonly injectPath: string;

  constructor(opts: { bin: string; env: Record<string, string>; logPath: string; callLog: string }) {
    this.bin = opts.bin;
    this.env = opts.env;
    this.logPath = opts.logPath;
    this.callLog = opts.callLog;
    // Resolved EXACTLY as the shim resolves them (both default off HOME, the world root), so the
    // control surface and the shim can never end up looking at different files.
    const home = opts.env.HOME ?? "/tmp";
    this.statePath = opts.env.HF_HERDR_STATE ?? join(home, "herdr-fake-state.json");
    this.injectPath = opts.env.HF_HERDR_INJECT ?? join(home, "herdr-fake-inject.json");
  }

  /** Copy the shim into a world's `bin/` as `herdr` (what `HERDR_BIN_PATH` points at) and return it. */
  static install(binDir: string): string {
    mkdirSync(binDir, { recursive: true });
    const dest = join(binDir, "herdr");
    copyFileSync(FAKE_HERDR_SHIM, dest);
    chmodSync(dest, 0o755);
    return dest;
  }

  // ── the HerdrServer surface ───────────────────────────────────────────────────────────────────

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

  /** No server to boot: this only prepares the state the shim reads. Directories first (the engine's
   *  very first call may be a `worktree create`), then a clean state + no injection, so a re-used
   *  world root can never leak the previous scenario's panes or knobs. */
  async start(): Promise<void> {
    for (const dir of [dirname(this.statePath), dirname(this.callLog), this.runtimeDir(), this.worktreeRoot()]) {
      mkdirSync(dir, { recursive: true });
    }
    this.writeState(blankState());
    this.resetInjection();
    // world.collect() copies `herdr-server.log` into the artifacts; leave a note rather than a
    // confusing absence.
    mkdirSync(dirname(this.logPath), { recursive: true });
    writeFileSync(this.logPath, "(fake herdr lane: no server — every `herdr` call is served in-process by harness/herdr-fake/herdr)\n");
  }

  /** Reap every process this lane launched. Load-bearing: the agents are DETACHED (that is how they
   *  survive the shim invocation that started them), so nothing else will collect them, and a leaked
   *  agent keeps writing into a world root the runner is about to delete. */
  async stop(): Promise<void> {
    for (const pid of this.agentPids()) this.kill(pid);
    this.resetInjection();
  }

  /** Nothing to link — there is no herdr host here to fire `worktree.created`, so no layout is ever
   *  built. Answers true (the shim answers success) so `World.start()`'s link step passes; a fake-lane
   *  scenario must not declare `layouts`. */
  linkPlugin(repoRoot: string): boolean {
    return this.cli(["plugin", "link", repoRoot]).code === 0;
  }

  pluginLog(): string {
    return "(fake herdr lane: no plugin host — `worktree.created` never fires and no layout is built)";
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

  /** The pane tree as `<tab label>/<pane label>` strings — what a layout assertion compares against.
   *  On this lane there are no layouts, so it only ever shows the worktree's root tab plus the tabs
   *  the engine created for dedicated panes. */
  paneLabels(workspaceId: string): string[] {
    const tabs = new Map(this.tabs(workspaceId).map((t) => [t.tab_id, t.label ?? "?"]));
    return this.panes(workspaceId)
      .map((p) => `${tabs.get(p.tab_id) ?? "?"}/${p.label ?? "?"}`)
      .sort();
  }

  /** A pane's recent output. There is no terminal here, so this is the agent process's captured
   *  stdout+stderr rather than a rendered screen — which is what a post-mortem actually wants. */
  readPane(paneId: string, lines = 20): string {
    const r = this.cli(["pane", "read", paneId, "--source", "recent", "--lines", String(lines), "--format", "text"]);
    return r.code === 0 ? r.stdout : `(pane read failed: ${r.stderr.trim() || r.stdout.trim()})`;
  }

  processInfo(paneId: string): string {
    const r = this.cli(["pane", "process-info", "--pane", paneId]);
    return r.code === 0 ? r.stdout.trim() : `(process-info failed: ${r.stderr.trim()})`;
  }

  /** Every pane's output + process in a workspace — the post-mortem. */
  /** Every pane of every workspace — the shape `World.stop()` dumps into the artifacts. */
  allScreens(lines = 200): string {
    const ws = this.workspaces();
    if (ws.length === 0) return "(no workspaces)";
    return ws.map((w) => `═══ workspace ${w.workspace_id} (${w.label ?? "?"}) ═══\n${this.screens(w.workspace_id, lines)}`).join("\n\n");
  }

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

  /** Create a worktree by hand — the "someone made a worktree outside the factory" path. Runs a real
   *  `git worktree add`, so the checkout exists and `git rev-parse HEAD` works inside it. */
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

  /** Every herdr invocation the FACTORY made, from the shim's own JSONL log (`{ts, argv}` — the same
   *  shape the real lane's wrapper writes, so call-budget assertions are lane-independent). */
  calls(): HerdrCall[] {
    if (!existsSync(this.callLog)) return [];
    return readFileSync(this.callLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as HerdrCall;
        } catch {
          return { ts: 0, argv: [l] };
        }
      });
  }

  /** Desktop notifications the engine fired — only observable through the argv log. */
  notifications(): { title: string; body: string }[] {
    return this.calls()
      .filter((c) => c.argv[0] === "notification" && c.argv[1] === "show")
      .map((c) => ({ title: c.argv[2] ?? "", body: flagValueFrom(c.argv, "--body") }));
  }

  /** Operator-facing reports the engine submitted INTO a run's pane (reportToPane → `agent prompt`)
   *  — where a park's explanation goes for a mechanical failure, and for any park on a file-channel
   *  source. Mirrors the real lane's accessor so a scenario reads the same in both. */
  paneReports(): { paneId: string; text: string }[] {
    return paneReportsFrom(this.calls());
  }

  /** Display metadata the engine published on panes (the ⚠ ATTENTION title, hf_* tokens). */
  paneMetadata(): { paneId: string; argv: string[] }[] {
    return this.calls()
      .filter((c) => c.argv[0] === "pane" && c.argv[1] === "report-metadata")
      .map((c) => ({ paneId: c.argv[2] ?? "", argv: c.argv }));
  }

  // ── failure injection (what this lane exists for) ─────────────────────────────────────────────

  /** Make `agent list` fail outright — the client then throws `HerdrUnreachableError`, which every
   *  liveness caller must DEFER on rather than treat as "the pane died". */
  get unreachable(): boolean {
    return (this.injection().fail ?? []).includes("agent list");
  }
  set unreachable(on: boolean) {
    this.failSubcommand("agent list", on);
  }

  /** Fail (exit 1) every call classified as `subcommand` — the first two argv tokens, e.g.
   *  `"agent list"`, `"agent start"`, `"worktree create"`, `"pane report-metadata"`; `"*"` = all. */
  failSubcommand(subcommand: string, on = true): void {
    this.patchInjection((i) => {
      const set = new Set(i.fail ?? []);
      if (on) set.add(subcommand);
      else set.delete(subcommand);
      i.fail = [...set];
    });
  }

  /** Report a pane ABSENT (omitted from `agent list`, `agent_status: "gone"` in `pane list`) while its
   *  process keeps running — the dead-pane/respawn path. The engine needs two confirmed absences
   *  ≥45s apart before it respawns, so a scenario holds this across that window. The hidden agent's
   *  NAME is freed too, so the respawn's `agent start` isn't refused for a name collision. */
  hideAgent(paneId: string): void {
    this.patchInjection((i) => {
      const set = new Set(i.hiddenPanes ?? []);
      set.add(paneId);
      i.hiddenPanes = [...set];
    });
  }

  showAgent(paneId: string): void {
    this.patchInjection((i) => {
      i.hiddenPanes = (i.hiddenPanes ?? []).filter((p) => p !== paneId);
    });
  }

  /** Actually kill a pane's agent process, so the pane is GENUINELY gone (no injection involved) —
   *  the difference from `hideAgent` is that nothing is lying: `agent list` stops listing it because
   *  the process is dead. Returns false when there was nothing alive to kill. */
  killAgent(paneId: string): boolean {
    const pane = this.state().panes[paneId];
    const pid = pane?.agent?.pid ?? pane?.command?.pid;
    if (!pid) return false;
    return this.kill(pid);
  }

  /** Refuse the next `agent prompt` to this pane as `agent_prompt_stalled` WITHOUT delivering the
   *  text — herdr's "the submission was dropped" answer. `"*"` covers every pane. */
  stallPrompt(paneId: string, on = true): void {
    this.patchInjection((i) => {
      const set = new Set(i.promptStall ?? []);
      if (on) set.add(paneId);
      else set.delete(paneId);
      i.promptStall = [...set];
    });
  }

  /** Add `ms` of latency before answering, optionally scoped to some subcommands (default: all).
   *  `latency(0)` clears it. Used to prove a slow herdr is killed at the engine's exec timeout
   *  instead of wedging the tick. */
  latency(ms: number, subcommands: string[] = []): void {
    this.patchInjection((i) => {
      i.sleepMs = ms;
      i.sleep = subcommands;
    });
  }

  /** Seed the saved SSH machines `herdr machine list --json` answers — which is where the factory's
   *  FLEET comes from. Fake-lane only: a real herdr's machine list is the operator's, and a scenario
   *  may not add to it. Call after `start()`, which blanks the state. */
  setMachines(machines: FakeMachineProfile[]): void {
    const s = this.state();
    s.machines = machines;
    this.writeState(s);
  }

  resetInjection(): void {
    this.writeInjection({});
  }

  injection(): FakeHerdrInjection {
    try {
      return JSON.parse(readFileSync(this.injectPath, "utf8")) as FakeHerdrInjection;
    } catch {
      return {};
    }
  }

  // ── raw state (diagnostics + the pid bookkeeping stop() needs) ────────────────────────────────

  state(): FakeHerdrState {
    try {
      return { ...blankState(), ...(JSON.parse(readFileSync(this.statePath, "utf8")) as FakeHerdrState) };
    } catch {
      return blankState();
    }
  }

  /** Every process this lane launched (agents and plain pane commands), living or not. */
  agentPids(): number[] {
    const out: number[] = [];
    for (const pane of Object.values(this.state().panes)) {
      if (pane.agent?.pid) out.push(pane.agent.pid);
      if (pane.command?.pid) out.push(pane.command.pid);
    }
    return out;
  }

  /** The pid of a pane's agent, or null — how a scenario asserts a process really outlived (or didn't
   *  outlive) a park, a respawn, or a teardown. */
  agentPid(paneId: string): number | null {
    return this.state().panes[paneId]?.agent?.pid ?? null;
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private runtimeDir(): string {
    return this.env.HF_HERDR_RUNTIME ?? join(this.env.HOME ?? "/tmp", ".herdr-fake");
  }

  private worktreeRoot(): string {
    return this.env.HF_HERDR_WORKTREES ?? join(this.env.HOME ?? "/tmp", "worktrees");
  }

  /** SIGTERM then SIGKILL the process GROUP (the launcher is detached, so the agent and anything it
   *  spawned share a group of their own). */
  private kill(pid: number): boolean {
    let killed = false;
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, sig);
          killed = true;
          break;
        } catch {
          /* already gone / not ours */
        }
      }
    }
    return killed;
  }

  /** Atomic (temp file + rename), so a concurrent shim invocation never reads a half-written file.
   *  Also clears the shim's mkdir lock: a shim killed mid-mutation (an exec timeout) would otherwise
   *  leave a directory every later call has to wait out. */
  private writeState(s: FakeHerdrState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.statePath);
    rmSync(`${this.statePath}.lock`, { recursive: true, force: true });
  }

  private writeInjection(i: FakeHerdrInjection): void {
    mkdirSync(dirname(this.injectPath), { recursive: true });
    const tmp = `${this.injectPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(i, null, 2));
    renameSync(tmp, this.injectPath);
  }

  private patchInjection(fn: (i: FakeHerdrInjection) => void): void {
    const i = this.injection();
    fn(i);
    this.writeInjection(i);
  }
}
