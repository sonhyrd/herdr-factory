// The hf-port handshake: how a run's own dev server is found, and reaped at every step change,
// park and teardown.
//
// A dev server started inside a layout pane is REPARENTED when the workspace closes, so it
// outlives its worktree, keeps its port and keeps its RSS forever — capacity the scheduler
// believes it has and does not. Teardown used to remove the workspace, the checkout, the git
// registration and the branch, and never touch processes.
//
// The handshake is one line on each side. The target repo's setup/dev command writes the port it
// picked to `<absolute git dir>/hf-port` (the git dir is per-worktree, is not the checkout the
// agent edits, and survives until the `rmrf`); teardown reads it BEFORE the checkout is destroyed
// and kills whatever still listens on it once the workspace is closed.
//
// Two rules this file exists to keep:
//   - Kill the LISTENER's process group, not a parent pid. pnpm is the parent and the dev server
//     is its child — that split is exactly why orphans survived — and the group kill reaps the
//     esbuild/cli helpers too.
//   - NEVER a pattern kill. No `pkill -f`, no `killall`: a host running three or four runs would
//     lose its siblings' servers. Only the pid(s) holding this run's own port.
//   - Never trust the port alone. A port is not proof of ownership — concurrent runs have shared
//     one, and a teardown killed a sibling's server. A listener is signalled only when its cwd is
//     inside this run's worktree; any other (or unreadable) cwd is left running and logged.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { run } from "../clients/exec.ts";

/** Written into the worktree's git dir by the target repo's setup/dev command (one `echo`). */
export const PORT_FILE = "hf-port";

/** Grace between the group SIGTERM and the SIGKILL sweep. Nuxt/Vite flush and exit well inside it. */
const GRACE_MS = 3000;

/** herdr's worktrees root — every factory checkout lives under it, which is what makes a listener
 *  with a cwd inside it attributable to a run. */
export function worktreesRoot(): string {
  return join(homedir(), ".herdr", "worktrees");
}

/** The worktree's own git dir (`git rev-parse --absolute-git-dir`) without shelling out to git: a
 *  linked worktree's `.git` is a FILE containing `gitdir: <path>`, a main checkout's is a dir.
 *  null when the worktree is gone or `.git` is unreadable. */
export function gitDir(worktreePath: string): string | null {
  const dot = join(worktreePath, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
    return /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** The dev-server port this run reserved, per the hf-port handshake. null when the file is absent,
 *  unreadable, or doesn't hold a plausible port — teardown carries on either way. */
export function readRunPort(worktreePath: string): number | null {
  const dir = gitDir(worktreePath);
  if (!dir) return null;
  try {
    const port = Number.parseInt(readFileSync(join(dir, PORT_FILE), "utf8").trim(), 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** `lsof`, with its "nothing matched" exit 1 read as empty output — but a MISSING (or refused, or
 *  hung) lsof rethrown. Blanket `allowFail` would turn a host without lsof into a confident
 *  "nothing is listening": teardown would log that it reaped a live server, and doctor would report
 *  no orphans. Both callers would rather say they could not look. */
async function lsof(args: string[], timeoutMs: number): Promise<string> {
  try {
    return (await run("lsof", args, { timeoutMs })).stdout;
  } catch (e) {
    if (e instanceof Error && /\(code 1\)/.test(e.message)) return ""; // lsof: no match
    throw e; // not installed / not permitted / timed out
  }
}

const listenerArgs = (port: number): string[] => ["-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"];

/** pids LISTENing on a TCP port (`lsof -nP -ti tcp:<port> -sTCP:LISTEN`). */
export async function listenerPids(port: number): Promise<number[]> {
  const out = await lsof(listenerArgs(port), 10_000);
  return out
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 1);
}

/** A process's group id, or null if it is already gone. */
async function pgidOf(pid: number): Promise<number | null> {
  const r = await run("ps", ["-o", "pgid=", "-p", String(pid)], { allowFail: true, timeoutMs: 5000 });
  const pgid = Number.parseInt(r.stdout.trim(), 10);
  return Number.isInteger(pgid) && pgid > 1 ? pgid : null;
}

/** Signal the listener's process GROUP (so pnpm's children — the actual server, its esbuild
 *  helpers — go with it), falling back to the bare pid when the group can't be read or is OUR
 *  own (never signal the factory's own group). Best-effort: a process that died between the
 *  lsof and the kill is the normal case. */
async function signalListener(pid: number, ownPgid: number | null, sig: "SIGTERM" | "SIGKILL"): Promise<void> {
  const pgid = await pgidOf(pid);
  const target = pgid != null && pgid !== ownPgid ? -pgid : pid;
  try {
    process.kill(target, sig);
  } catch {
    /* already gone / not ours to signal */
  }
}

/** A process's resident set size in KiB (`ps -o rss=`), or null if it is already gone. */
async function rssKbOf(pid: number): Promise<number | null> {
  const r = await run("ps", ["-o", "rss=", "-p", String(pid)], { allowFail: true, timeoutMs: 5000 });
  const kb = Number.parseInt(r.stdout.trim(), 10);
  return Number.isInteger(kb) ? kb : null;
}

/** `realpath`, tolerating a path that no longer exists (teardown reaps AFTER the worktree is
 *  removed): the deepest existing ancestor is resolved and the rest re-appended. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realPath(parent), basename(p));
  }
}

const inside = (cwd: string, dir: string): boolean => cwd === dir || cwd.startsWith(`${dir}/`);

export interface KilledListener {
  pid: number;
  /** RSS read just before the SIGTERM — the memory the kill gave back. */
  rssKb: number | null;
  cwd: string;
}

export interface ReapResult {
  /** Listeners inside the run's worktree, signalled. */
  killed: KilledListener[];
  /** Listeners on the port whose cwd is elsewhere (null = unreadable) — left running. */
  skipped: { pid: number; cwd: string | null }[];
  /** The lsof command that found the listeners — evidence for a "nothing was listening". */
  lsof: string;
}

/** The process-touching half of the reap, injectable so tests never signal a real process. */
export interface ReapIO {
  listenerPids: (port: number) => Promise<number[]>;
  cwdOf: (pid: number) => Promise<string | null>;
  rssKbOf: (pid: number) => Promise<number | null>;
  signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const realIO: ReapIO = {
  listenerPids,
  cwdOf,
  rssKbOf,
  signal: async (pid, sig) => signalListener(pid, await pgidOf(process.pid), sig),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Kill the listeners on `port` whose cwd is inside `worktreePath` (realpath prefix match): group
 *  SIGTERM → grace → SIGKILL on whichever of them still listen. A listener with any other cwd, or
 *  one that can't be read, is never signalled — it comes back in `skipped`. */
export async function killPortListeners(port: number, worktreePath: string, io: ReapIO = realIO): Promise<ReapResult> {
  const wt = realPath(worktreePath);
  const result: ReapResult = { killed: [], skipped: [], lsof: `lsof ${listenerArgs(port).join(" ")}` };
  const cwdIfOwned = async (pid: number): Promise<{ cwd: string | null; ours: boolean }> => {
    const cwd = await io.cwdOf(pid).catch(() => null);
    return { cwd, ours: cwd != null && inside(realPath(cwd), wt) };
  };
  for (const pid of await io.listenerPids(port)) {
    const { cwd, ours } = await cwdIfOwned(pid);
    if (ours) result.killed.push({ pid, rssKb: await io.rssKbOf(pid), cwd: cwd! });
    else result.skipped.push({ pid, cwd });
  }
  if (result.killed.length === 0) return result;
  for (const k of result.killed) await io.signal(k.pid, "SIGTERM");
  await io.sleep(GRACE_MS);
  for (const pid of await io.listenerPids(port)) if ((await cwdIfOwned(pid)).ours) await io.signal(pid, "SIGKILL");
  return result;
}

export interface OrphanListener {
  pid: number;
  port: number;
  command: string;
  cwd: string;
  rssKb: number | null;
}

/** Every LISTENing process on the host, as {pid, command, port}. The columnar output is parsed:
 *  COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME, with NAME (`*:4100`) second-to-last and
 *  `(LISTEN)` last. `+c 0` keeps the full command name — lsof truncates it to 9 chars by default,
 *  which turns the one field an operator identifies the process by into `MainThrea`. */
async function listeningProcesses(): Promise<{ pid: number; command: string; port: number }[]> {
  const stdout = await lsof(["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN"], 15_000);
  const out: { pid: number; command: string; port: number }[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;
    const pid = Number.parseInt(f[1]!, 10);
    const port = Number.parseInt(f.at(-2)!.split(":").at(-1)!, 10);
    if (Number.isInteger(pid) && Number.isInteger(port)) out.push({ pid, command: f[0]!, port });
  }
  return out;
}

/** A process's cwd, via lsof's field output (`-Fn` ⇒ an `n<path>` line). Works on macOS + Linux.
 *  Linux suffixes a removed dir with ` (deleted)` — a torn-down worktree's server — stripped. */
async function cwdOf(pid: number): Promise<string | null> {
  const out = await lsof(["-a", "-d", "cwd", "-Fn", "-p", String(pid)], 10_000);
  return /^n(.+)$/m.exec(out)?.[1]?.trim().replace(/ \(deleted\)$/, "") ?? null;
}

/** Listeners running inside a factory worktree that no WORKING run owns — dev servers that outlived
 *  their run or its park (a parked run's worktree is not in `liveWorktrees`). REPORT ONLY: nothing
 *  here signals anything. The engine's `stopDevServer` kills only its own run's port, at every step
 *  change (advance, bounce, rework), every park (attention, waiting_for_human) and teardown. */
export async function orphanWorktreeListeners(liveWorktrees: string[]): Promise<OrphanListener[]> {
  const root = worktreesRoot();
  const orphans: OrphanListener[] = [];
  const seen = new Set<number>();
  for (const p of await listeningProcesses()) {
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    const cwd = await cwdOf(p.pid);
    if (!cwd || !cwd.startsWith(`${root}/`)) continue;
    if (liveWorktrees.some((wt) => cwd === wt || cwd.startsWith(`${wt}/`))) continue;
    orphans.push({ ...p, cwd, rssKb: await rssKbOf(p.pid) });
  }
  return orphans;
}
