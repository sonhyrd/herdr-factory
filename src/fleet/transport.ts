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
import { spawn, type ChildProcess } from "node:child_process";
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
}

export interface SshTransportOpts {
  /** How long a forward has to come up and answer /health. */
  connectTimeoutMs?: number;
  /** Where ControlMaster sockets live. Defaults under the factory state root. */
  controlDir?: string;
}

/**
 * The production transport: server.json for the local machine, an SSH local forward per remote one.
 *
 * Forwards are cached for the life of the process and torn down by `close()`. A `herdr-factory fleet`
 * invocation is short-lived, so in practice each remote machine costs one `ssh -N` for the duration
 * of the command — and with ControlPersist the NEXT invocation reuses the multiplexed connection
 * instead of paying the handshake again.
 */
export class SshForwardTransport implements MachineTransport {
  private readonly forwards = new Map<string, Forward>();
  private readonly connectTimeoutMs: number;
  private readonly controlDir: string;
  private closed = false;

  constructor(opts: SshTransportOpts = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.controlDir = opts.controlDir ?? join(stateRoot(), "fleet-ssh");
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
    if (held) return held.proc.exitCode === null ? held.baseUrl : (this.forwards.delete(machine.name), null);
    return this.open(machine.name, machine.sshTarget);
  }

  private async open(name: string, target: string): Promise<string | null> {
    if (this.closed) return null;
    const port = await freePort().catch(() => 0);
    if (!port) return null;
    mkdirSync(this.controlDir, { recursive: true });
    const args = [
      "-N",
      "-o",
      "BatchMode=yes", // never prompt: a fleet read is not interactive, and a prompt would hang it
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      `ConnectTimeout=${Math.ceil(this.connectTimeoutMs / 1000)}`,
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${join(this.controlDir, "%C")}`,
      "-o",
      "ControlPersist=120",
      "-L",
      `${port}:127.0.0.1:${REMOTE_API_PORT}`,
      target,
    ];
    const proc = spawn("ssh", args, { stdio: "ignore" });
    proc.unref();
    proc.on("error", () => undefined); // no ssh on PATH: the health poll below decides
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + this.connectTimeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return null; // ssh gave up (auth, unknown host, forward refused)
      if (await answersHealth(baseUrl, 1000)) {
        this.forwards.set(name, { proc, baseUrl });
        return baseUrl;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    proc.kill("SIGTERM");
    return null;
  }

  close(): void {
    this.closed = true;
    for (const { proc } of this.forwards.values()) proc.kill("SIGTERM");
    this.forwards.clear();
  }
}
