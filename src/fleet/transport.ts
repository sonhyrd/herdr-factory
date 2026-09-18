// How a machine's factory API is reached. This is the seam the rest of the fleet is written against:
// everything above it speaks HTTP to a base URL and does not know whether the bytes crossed a socket
// or an SSH forward.
//
//   * LOCAL  — server.json, exactly as the TUI has always read it (`http://127.0.0.1:<port>`).
//   * REMOTE — an SSH local forward (`ssh -N -L <free port>:127.0.0.1:8765 <target>`), so the remote
//     server keeps binding 127.0.0.1 only. OpenSSH's ControlMaster is reused, so a second machine's
//     forward (and a later fleet read) rides one authenticated connection rather than re-handshaking.
//
// Both answer `null` rather than throwing when the machine can't be reached: an unreachable machine
// is DATA in a fleet read (`unverifiable`), not an error that fails the whole view.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { serverInfoPath, stateRoot } from "../config-paths.ts";
import type { Machine } from "./machines.ts";

/** Port a remote factory server binds. `serve`'s default and not per-machine configurable — the
 *  fleet deliberately adds no config, and a host that moved its port off the default can be reached
 *  by pointing the endpoint override below at it. */
export const REMOTE_API_PORT = 8765;

export interface MachineTransport {
  /** Base URL for this machine's factory API, or null when it cannot be reached. */
  endpoint(machine: Machine): Promise<string | null>;
  /** Tear down anything held open (SSH forwards). Safe to call twice. */
  close(): void;
  /** Why this machine's endpoint could not be resolved last time we tried — ssh's own first line of
   *  stderr, when there was one. A far better `unverifiable` reason than "could not reach its API",
   *  which is true of an auth failure, an unknown host and a refused forward alike. */
  failureDetail?(machine: Machine): string | null;
}

/** Read the local server's advertised port. Same contract as `tui/api.ts`: an absent or malformed
 *  server.json, or an advertised pid that is gone, all mean "no server here". */
function localEndpoint(): string | null {
  try {
    const o = JSON.parse(readFileSync(serverInfoPath(), "utf8")) as { pid?: number; port?: number };
    if (typeof o.pid !== "number" || typeof o.port !== "number") return null;
    process.kill(o.pid, 0);
    return `http://127.0.0.1:${o.port}`;
  } catch {
    return null;
  }
}

/**
 * Explicit endpoints, by machine name, from a JSON file (`{"<machine>": "http://127.0.0.1:1234"}`).
 *
 * This is the transport's test seam — it is what lets the e2e suite point a "remote" machine at a
 * second `serve` in the same world instead of standing up real SSH — and it doubles as the escape
 * hatch for a host whose server is not on the default port. Not repo config: an override read from
 * the environment, so it can never make a fleet read depend on a config key.
 */
function endpointOverrides(): Record<string, string> {
  const path = process.env.HERDR_FACTORY_FLEET_ENDPOINTS?.trim();
  if (!path || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [name, url] of Object.entries(raw)) if (typeof url === "string" && url.trim()) out[name] = url.trim().replace(/\/+$/, "");
    return out;
  } catch {
    return {};
  }
}

/** An unused loopback port, from the kernel. Racy in principle (the port is free when we ask and
 *  claimed by `ssh` a moment later); `-o ExitOnForwardFailure=yes` turns a lost race into a forward
 *  that fails fast and a machine reported `unverifiable`, rather than a silent half-open tunnel. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not get a free local port"))));
    });
  });
}

async function answersHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

interface Forward {
  proc: ChildProcess;
  baseUrl: string;
  target: string;
  localPort: number;
  /** The client we spawned exited 0 and left a ControlPersist master holding the forward, so this
   *  forward outlives `proc` and is torn down through the control socket instead of a signal. */
  backgrounded: boolean;
}

/** macOS's `sun_path` is 104 bytes — the smallest limit of the platforms we run on, so it is the one
 *  every ControlPath has to fit. Linux's is 108. */
export const SUN_PATH_MAX = 104;
/** ssh does not bind `<ControlPath>` directly: while the master comes up it listens on
 *  `<ControlPath>.<random>` (~17 chars) and renames it, so the socket it actually binds is longer
 *  than the path we hand it. Budget for that suffix rather than discovering it as `unix_listener:
 *  path … too long for Unix domain socket` and an ssh that exits 255 before the forward is up. */
const CONTROL_PATH_HEADROOM = 20;
/** `%C` expands to a 40-char hex hash of (local host, remote host, port, user). */
const CONTROL_HASH_LEN = 40;

/** Does `<dir>/%C` — expanded, plus ssh's own suffix — still fit in a Unix socket path? */
export function controlPathFits(dir: string): boolean {
  return Buffer.byteLength(join(dir, "x".repeat(CONTROL_HASH_LEN))) <= SUN_PATH_MAX - CONTROL_PATH_HEADROOM;
}

/** The short per-user fallback: `/tmp` rather than `$TMPDIR`, because macOS's `$TMPDIR` is itself a
 *  ~50-byte per-user path under `/var/folders` and would defeat the point. Per-uid and 0700 so one
 *  user cannot pre-create or read another's control sockets on a shared host. */
function shortControlDir(): string {
  return `/tmp/hf-${process.getuid?.() ?? 0}`;
}

/**
 * Where this transport's ControlMaster sockets go — or `null` for "do not multiplex".
 *
 * The preferred directory (under the state root) is used when it fits; a state root deep enough to
 * overflow `sun_path` falls back to the short per-user directory, and if even that does not fit
 * (an absurd uid, or no `/tmp`) the forward runs unmultiplexed. Losing connection reuse costs a
 * handshake; a ControlPath that overflows costs the whole fleet read.
 */
export function resolveControlDir(preferred: string): string | null {
  if (controlPathFits(preferred)) return preferred;
  const short = shortControlDir();
  return controlPathFits(short) ? short : null;
}

/**
 * The forward's argv. `controlDir` of `null` means no multiplexing at all — the fallback for a
 * machine whose ControlPath cannot be made to fit.
 *
 * `ControlPersist` is kept deliberately, rather than dropped to keep the client in the foreground:
 * the connection it leaves behind is what makes a second machine's forward and the NEXT
 * `herdr-factory fleet` cheap, and on a box that asks for a passphrase or an MFA touch it is the
 * difference between one prompt and one per call. The price is that when ssh has to fork a NEW
 * master, the client we spawned exits 0 the moment the forward is up — so "exited" is not "failed"
 * here, and `open()` reads the forward's own `/health` instead of the client's exit (see below).
 */
export function sshForwardArgs(opts: { target: string; localPort: number; connectTimeoutMs: number; controlDir: string | null }): string[] {
  return [
    "-N",
    "-o",
    "BatchMode=yes", // never prompt: a fleet read is not interactive, and a prompt would hang it
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ConnectTimeout=${Math.ceil(opts.connectTimeoutMs / 1000)}`,
    ...(opts.controlDir === null
      ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
      : ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(opts.controlDir, "%C")}`, "-o", "ControlPersist=120"]),
    "-L",
    `${opts.localPort}:127.0.0.1:${REMOTE_API_PORT}`,
    opts.target,
  ];
}

/** ssh's diagnosis, trimmed to the one line worth putting in a table cell. */
function firstLine(stderr: string): string {
  return (
    stderr
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

export interface SshTransportOpts {
  /** How long a forward has to come up and answer /health. */
  connectTimeoutMs?: number;
  /** Preferred home for the ControlMaster sockets. Defaults under the factory state root, and is
   *  only used when the resulting ControlPath fits `sun_path` (see `resolveControlDir`). */
  controlDir?: string;
}

/**
 * The production transport: server.json for the local machine, an SSH local forward per remote one.
 *
 * Forwards are cached for the life of the process and torn down by `close()`. A `herdr-factory fleet`
 * invocation is short-lived, so in practice each remote machine costs one `ssh -N` for the duration
 * of the command — and with ControlPersist the NEXT invocation reuses the multiplexed connection
 * instead of paying the handshake again.
 *
 * Which means a forward can outlive the `ssh` we spawned: when ssh has to start a master, the client
 * exits 0 as soon as the tunnel is up and the backgrounded master holds it. So a forward is judged
 * by whether it answers `/health`, and released either with a signal (foreground client) or with
 * `ssh -O cancel` (backgrounded master) — see `open()` and `tearDown()`.
 */
export class SshForwardTransport implements MachineTransport {
  private readonly forwards = new Map<string, Forward>();
  private readonly failures = new Map<string, string>();
  private readonly connectTimeoutMs: number;
  private readonly controlDir: string | null;
  private closed = false;

  constructor(opts: SshTransportOpts = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.controlDir = resolveControlDir(opts.controlDir ?? join(stateRoot(), "fleet-ssh"));
  }

  async endpoint(machine: Machine): Promise<string | null> {
    const override = endpointOverrides()[machine.name];
    if (override) return (await answersHealth(override, this.connectTimeoutMs)) ? override : null;
    if (machine.local) {
      const local = localEndpoint();
      return local && (await answersHealth(local, 2500)) ? local : null;
    }
    if (!machine.sshTarget) return null;

    const held = this.forwards.get(machine.name);
    // A backgrounded forward is held by the ControlPersist master, not by the client that set it up:
    // its `exitCode` is 0 and says nothing about whether the tunnel is still there.
    if (held) return held.backgrounded || held.proc.exitCode === null ? held.baseUrl : (this.forwards.delete(machine.name), null);
    return this.open(machine.name, machine.sshTarget);
  }

  /**
   * Bring one forward up.
   *
   * `replaceStaleMaster` is the one retry this transport allows itself: a ControlMaster that
   * outlived the remote server's restart still answers `-O check` with `Master running`, and ssh
   * will happily multiplex a new forward onto that dead connection — which then never answers
   * `/health`. `-O check` alone cannot tell a healthy master from a stale one (it only pings the
   * local socket), so staleness is diagnosed the only way it can be: a master that is running AND a
   * forward through it that did not come up. Then `-O exit` drops it and the retry forks a fresh
   * one. Once, never in a loop — a second failure is the remote's, not the master's.
   */
  private async open(name: string, target: string, replaceStaleMaster = true): Promise<string | null> {
    if (this.closed) return null;
    this.failures.delete(name);
    const port = await freePort().catch(() => 0);
    if (!port) return this.failed(name, "could not get a free local port for the forward");
    if (this.controlDir !== null) mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    const args = sshForwardArgs({ target, localPort: port, connectTimeoutMs: this.connectTimeoutMs, controlDir: this.controlDir });
    // stderr is kept (stdin/stdout are not): when ssh exits before the forward is up, its first line
    // is the only thing that says WHY, and it is what the machine's `unverifiable` row reports.
    const proc = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.unref();
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    proc.stderr?.on("error", () => undefined);
    proc.on("error", (e) => (stderr ||= e.message)); // no ssh on PATH: the health poll below decides
    const drained = { done: false };
    proc.once("close", () => (drained.done = true));
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + this.connectTimeoutMs;
    let backgrounded = false;
    // How many times `/health` was actually asked. Without it a fast failure is indistinguishable
    // from a slow one in the row it produces — "could not reach its API" reads the same whether the
    // forward was polled thirty times or ssh died before the first attempt.
    let probes = 0;
    while (Date.now() < deadline) {
      const code = proc.exitCode;
      // ssh gave up (auth, unknown host, refused forward, a ControlPath that does not fit).
      if (code !== null && code !== 0) {
        // The last of its stderr can still be in flight when `exitCode` lands; `close` is the point
        // at which all of it has arrived, and its first line is the whole diagnosis.
        for (let i = 0; i < 20 && !drained.done; i++) await new Promise((r) => setTimeout(r, 10));
        const line = firstLine(stderr);
        return this.giveUp(name, target, replaceStaleMaster, line ? `${line} (ssh exited ${code}, ${probes} /health ${probes === 1 ? "attempt" : "attempts"})` : `ssh exited ${code} after ${probes} /health ${probes === 1 ? "attempt" : "attempts"}`);
      }
      // Exit 0 is the ControlPersist handshake, not a failure: ssh forked a master into the
      // background and the foreground client returned. The forward is up for as long as that master
      // lives, so only `/health` on the forwarded port — never the client's exit — decides.
      if (code === 0) backgrounded = true;
      probes++;
      if (await answersHealth(baseUrl, 1000)) {
        this.forwards.set(name, { proc, baseUrl, target, localPort: port, backgrounded });
        return baseUrl;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.tearDown({ proc, baseUrl, target, localPort: port, backgrounded });
    const why = backgrounded
      ? `ssh backgrounded its forward but it did not answer /health in ${probes} attempts over ${this.connectTimeoutMs}ms`
      : `the SSH forward did not answer /health in ${probes} attempts over ${this.connectTimeoutMs}ms`;
    const line = firstLine(stderr);
    return this.giveUp(name, target, replaceStaleMaster, line ? `${line} (${why})` : why);
  }

  /** Is there a ControlMaster for `target` right now? `-O check` exits 0 and prints `Master running`
   *  when the local control socket answers — which is all it proves, hence the caller's second
   *  condition (a forward through it that failed). */
  private masterRunning(target: string): boolean {
    if (this.controlDir === null) return false;
    const r = spawnSync("ssh", ["-O", "check", "-o", `ControlPath=${join(this.controlDir, "%C")}`, target], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  }

  /**
   * A forward failed. If a ControlMaster is holding the connection it was multiplexed onto, that
   * master is the suspect — it can outlive the remote server (or the network path) it was opened
   * over, and every forward through it fails while `ssh -O check` still says `Master running`. Drop
   * it once and try again on a fresh connection; report the original reason if that fails too.
   */
  private async giveUp(name: string, target: string, replaceStaleMaster: boolean, detail: string): Promise<string | null> {
    if (!replaceStaleMaster || this.closed || !this.masterRunning(target)) return this.failed(name, detail);
    spawnSync("ssh", ["-O", "exit", "-o", `ControlPath=${join(this.controlDir!, "%C")}`, target], { stdio: "ignore", timeout: 5000 });
    const retried = await this.open(name, target, false);
    if (retried) return retried;
    return this.failed(name, `${this.failures.get(name) ?? detail} (after replacing a stale ControlMaster; first attempt: ${detail})`);
  }

  /**
   * Release one forward.
   *
   * A client still in the foreground dies on a signal. A backgrounded one is already gone and the
   * forward belongs to the ControlPersist master, so it takes a control command over the same
   * ControlPath — otherwise the tunnel and its local port outlive the command that opened them.
   * `-O cancel` (the forward) rather than `-O exit` (the whole master): the master is exactly the
   * connection reuse ControlPersist is there for, and the next fleet read should still find it.
   */
  private tearDown({ proc, target, backgrounded, localPort }: Forward): void {
    if (!backgrounded) {
      proc.kill("SIGTERM");
      return;
    }
    if (this.controlDir === null) return; // unmultiplexed: nothing was left behind to stop
    const args = ["-O", "cancel", "-o", `ControlPath=${join(this.controlDir, "%C")}`, "-L", `${localPort}:127.0.0.1:${REMOTE_API_PORT}`, target];
    spawnSync("ssh", args, { stdio: "ignore", timeout: 5000 });
  }

  /** Remember why this machine has no endpoint, and answer the transport's "unreachable" = null. */
  private failed(name: string, detail: string): null {
    this.failures.set(name, detail);
    return null;
  }

  failureDetail(machine: Machine): string | null {
    return this.failures.get(machine.name) ?? null;
  }

  close(): void {
    this.closed = true;
    for (const forward of this.forwards.values()) this.tearDown(forward);
    this.forwards.clear();
  }
}
