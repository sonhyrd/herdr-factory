// The hf-port handshake: how a run's own dev server is found, and reaped at teardown.
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
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** pids LISTENing on a TCP port (`lsof -nP -ti tcp:<port> -sTCP:LISTEN`). */
export async function listenerPids(port: number): Promise<number[]> {
  const out = await lsof(["-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], 10_000);
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

/** Kill whatever listens on `port`: group SIGTERM → grace → SIGKILL on whatever still listens.
 *  Returns the pids that were holding the port (empty ⇒ nothing was listening). */
export async function killPortListeners(port: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<number[]> {
  const pids = await listenerPids(port);
  if (pids.length === 0) return [];
  const ownPgid = await pgidOf(process.pid);
  for (const pid of pids) await signalListener(pid, ownPgid, "SIGTERM");
  await sleep(GRACE_MS);
  for (const pid of await listenerPids(port)) await signalListener(pid, ownPgid, "SIGKILL");
  return pids;
}

export interface OrphanListener {
  pid: number;
  port: number;
  command: string;
  cwd: string;
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

/** A process's cwd, via lsof's field output (`-Fn` ⇒ an `n<path>` line). Works on macOS + Linux. */
async function cwdOf(pid: number): Promise<string | null> {
  const out = await lsof(["-a", "-d", "cwd", "-Fn", "-p", String(pid)], 10_000);
  return /^n(.+)$/m.exec(out)?.[1]?.trim() ?? null;
}

/** Listeners running inside a factory worktree that NO live run owns any more — dev servers that
 *  outlived their teardown. REPORT ONLY: nothing here signals anything (teardown is the only
 *  thing that kills, and only its own run's port). */
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
    orphans.push({ ...p, cwd });
  }
  return orphans;
}
