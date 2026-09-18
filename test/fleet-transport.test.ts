// The SSH forward itself: the ControlPath it hands ssh, and what it reports when ssh gives up.
//
// Both are load-bearing on macOS, where `sun_path` is 104 bytes: a ControlPath under a deep state
// root overflows it, ssh exits 255 before the forward is up, and every remote machine reads
// `unverifiable` while `ssh -L …` by hand works fine. The diagnosis is only in ssh's stderr, so the
// transport keeps it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlPathFits, resolveControlDir, SshForwardTransport, sshForwardArgs, SUN_PATH_MAX } from "../src/fleet/transport.ts";
import type { Machine } from "../src/fleet/machines.ts";

const remote: Machine = { name: "build-box", sshTarget: "ops@build-box", session: null, local: false };

/** The ControlPath ssh is given, with `%C` expanded and the suffix it appends while binding the
 *  master socket — i.e. the path the kernel actually sees. */
function boundSocketPath(args: string[]): string {
  const opt = args.find((a) => a.startsWith("ControlPath="))!;
  return `${opt.slice("ControlPath=".length).replace("%C", "c".repeat(40))}.KdT9pQwZr1sVb2Hx`;
}

describe("fleet ssh forward — ControlPath", () => {
  it("keeps the configured control dir when its ControlPath fits", () => {
    const dir = "/var/hf/fleet-ssh";
    expect(resolveControlDir(dir)).toBe(dir);
  });

  it("falls back to a short per-user dir when the control dir would overflow sun_path", () => {
    // The default — `~/.local/state/herdr-factory/fleet-ssh` — is already one of these on any real
    // home directory: 51 bytes of dir, 40 of `%C`, 17 more that ssh appends. That was the bug.
    const deep = "/Users/someone/.local/state/herdr-factory/fleet-ssh";
    expect(controlPathFits(deep)).toBe(false);

    const resolved = resolveControlDir(deep);
    expect(resolved).toMatch(/^\/tmp\/hf-\d+$/);
    expect(controlPathFits(resolved!)).toBe(true);

    const args = sshForwardArgs({ target: "ops@build-box", localPort: 45231, connectTimeoutMs: 10_000, controlDir: resolved });
    expect(args).toContain(`ControlPath=${join(resolved!, "%C")}`);
    expect(args).toContain("ControlMaster=auto");
    expect(Buffer.byteLength(boundSocketPath(args))).toBeLessThanOrEqual(SUN_PATH_MAX);
    // …and the forward is still the forward: free local port to the remote server's loopback port.
    expect(args.slice(-3)).toEqual(["-L", "45231:127.0.0.1:8765", "ops@build-box"]);
  });

  it("runs the forward unmultiplexed when no ControlPath can be made to fit", () => {
    const args = sshForwardArgs({ target: "ops@build-box", localPort: 45231, connectTimeoutMs: 10_000, controlDir: null });
    expect(args).toContain("ControlMaster=no");
    expect(args).toContain("ControlPath=none");
    expect(args.some((a) => a.includes("%C"))).toBe(false);
    expect(args.slice(-3)).toEqual(["-L", "45231:127.0.0.1:8765", "ops@build-box"]);
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("BatchMode=yes");
  });
});

// ── what an ssh that gives up reports ──────────────────────────────────────────────────────────
//
// Driven through a FAKE `ssh` on PATH, so this exercises the real spawn, the real stderr plumbing
// and the real early-exit path rather than a stub of them.

describe("fleet ssh forward — why it failed", () => {
  let dir: string;
  let path: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-ssh-"));
    path = process.env.PATH;
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeSsh(script: string): void {
    const bin = join(dir, "ssh");
    writeFileSync(bin, `#!/bin/bash\n${script}\n`);
    chmodSync(bin, 0o755);
  }

  it("surfaces ssh's own stderr instead of a generic unreachable", async () => {
    fakeSsh(`echo 'unix_listener: path "/Users/ops/.local/state/herdr-factory/fleet-ssh/abc.rand" too long for Unix domain socket' >&2\nexit 255`);
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });

    expect(await transport.endpoint(remote)).toBeNull();
    expect(transport.failureDetail(remote)).toContain("too long for Unix domain socket");
    transport.close();
  });

  it("reports ssh's exit code when it dies saying nothing", async () => {
    fakeSsh("exit 255");
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });

    expect(await transport.endpoint(remote)).toBeNull();
    expect(transport.failureDetail(remote)).toContain("ssh exited 255");
    transport.close();
  });

  it("knows nothing to report about a machine it was never asked to reach", () => {
    const transport = new SshForwardTransport({ controlDir: join(dir, "control") });
    expect(transport.failureDetail(remote)).toBeNull();
  });
});
