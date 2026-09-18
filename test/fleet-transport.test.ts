// The SSH forward itself: the ControlPath it hands ssh, and what it reports when ssh gives up.
//
// Both are load-bearing on macOS, where `sun_path` is 104 bytes: a ControlPath under a deep state
// root overflows it, ssh exits 255 before the forward is up, and every remote machine reads
// `unverifiable` while `ssh -L …` by hand works fine. The diagnosis is only in ssh's stderr, so the
// transport keeps it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // ── an ssh that exits 0 ──────────────────────────────────────────────────────────────────────
  //
  // With ControlPersist, starting a master forks it into the background and the client we spawned
  // returns 0 the moment the forward is up. Reading that exit as "ssh gave up" reported every remote
  // `unverifiable: ssh exited 0` while the tunnel was answering — so the fake here does exactly what
  // a real ssh does: it binds the forwarded port, then exits 0.

  /** The far end of the forward: an HTTP server on the port the fake `ssh` was told to listen on. */
  function fakeForward(): string {
    const script = join(dir, "forward.mjs");
    writeFileSync(
      script,
      [
        'import { createServer } from "node:http";',
        'const srv = createServer((_req, res) => (res.writeHead(200, { "content-type": "application/json" }), res.end("{}")));',
        'srv.listen(Number(process.argv[2]), "127.0.0.1");',
        "setTimeout(() => process.exit(0), 10_000);",
      ].join("\n"),
    );
    return script;
  }

  /** A fake `ssh` that backgrounds its forward and exits 0, and records `-O` control commands. */
  function fakeBackgroundingSsh(): void {
    fakeSsh(`
if [[ "$*" == *"-O "* ]]; then printf '%s\\n' "$*" > "${join(dir, "control-command")}"; exit 0; fi
port=""
for a in "$@"; do case "$a" in *:127.0.0.1:8765) port="\${a%%:*}";; esac; done
[[ -n "$port" ]] || exit 255
"${process.execPath}" "${fakeForward()}" "$port" >/dev/null 2>&1 &
exit 0`);
  }

  it("keeps polling when ssh exits 0 — the backgrounded forward is what decides", async () => {
    fakeBackgroundingSsh();
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });

    const endpoint = await transport.endpoint(remote);
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(transport.failureDetail(remote)).toBeNull();
    // …and the cached forward survives a second read, even though its client is long gone.
    expect(await transport.endpoint(remote)).toBe(endpoint);
    transport.close();
  });

  it("cancels the backgrounded master's forward on close, leaving the shared connection up", async () => {
    fakeBackgroundingSsh();
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });
    const endpoint = await transport.endpoint(remote);
    const port = new URL(endpoint!).port;

    transport.close();

    const command = readFileSync(join(dir, "control-command"), "utf8");
    expect(command).toContain("-O cancel"); // not `-O exit`: the master is the reuse we want to keep
    expect(command).toContain(`-L ${port}:127.0.0.1:8765`);
    expect(command).toContain("ops@build-box");
  });

  // ── a stale ControlMaster ────────────────────────────────────────────────────────────────────
  //
  // A master can outlive the connection it multiplexes (the remote server restarted under it, the
  // network path moved). `ssh -O check` still answers `Master running` — it only pings the LOCAL
  // socket — and every forward opened through it fails. The pair (master running, forward failed)
  // is the only available diagnosis, so that pair drops the master and retries once.

  /** A fake `ssh` whose master is a file: while it exists every forward fails, `-O check` says the
   *  master is running, and `-O exit` removes it. `stale` seeds one. */
  function fakeStaleMasterSsh(opts: { forwardWorksAfterExit: boolean }): void {
    const master = join(dir, "master");
    writeFileSync(master, "");
    fakeSsh(`
master="${master}"
case "$*" in
  *"-O check"*) [[ -f "$master" ]] && exit 0 || exit 255;;
  *"-O exit"*)  rm -f "$master"; exit 0;;
  *"-O cancel"*) printf '%s\\n' "$*" > "${join(dir, "control-command")}"; exit 0;;
esac
if [[ -f "$master" ]]; then echo 'mux_client_request_session: session request failed: Session open refused by peer' >&2; exit 255; fi
${"" /* the master is gone: a fresh connection, and the forward comes up */}
[[ "${opts.forwardWorksAfterExit}" == "true" ]] || { echo 'ssh: connect to host build-box port 22: Connection refused' >&2; exit 255; }
port=""
for a in "$@"; do case "$a" in *:127.0.0.1:8765) port="\${a%%:*}";; esac; done
[[ -n "$port" ]] || exit 255
"${process.execPath}" "${fakeForward()}" "$port" >/dev/null 2>&1 &
exit 0`);
  }

  it("drops a stale ControlMaster once and comes up on the connection that replaces it", async () => {
    fakeStaleMasterSsh({ forwardWorksAfterExit: true });
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });

    expect(await transport.endpoint(remote)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(transport.failureDetail(remote)).toBeNull();
    expect(existsSync(join(dir, "master"))).toBe(false); // `-O exit` took it down
    transport.close();
  });

  it("reports both attempts when replacing the master did not help", async () => {
    fakeStaleMasterSsh({ forwardWorksAfterExit: false });
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });

    expect(await transport.endpoint(remote)).toBeNull();
    const detail = transport.failureDetail(remote)!;
    expect(detail).toContain("Connection refused"); // the retry's own reason leads
    expect(detail).toContain("replacing a stale ControlMaster");
    expect(detail).toContain("Session open refused by peer"); // …and the first attempt's is kept
    transport.close();
  });

  it("does not retry when there is no master to blame", async () => {
    fakeSsh("echo 'Permission denied (publickey).' >&2\nexit 255"); // `-O check` fails too: no master
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });

    const detail = (await transport.endpoint(remote), transport.failureDetail(remote)!);
    expect(detail).toContain("Permission denied (publickey).");
    expect(detail).not.toContain("stale ControlMaster");
    transport.close();
  });

  it("counts the /health attempts it actually made", async () => {
    fakeSsh('[[ "$*" == *"-O "* ]] && exit 255\nsleep 5'); // ssh never dies and never forwards: the deadline is what ends it
    const transport = new SshForwardTransport({ connectTimeoutMs: 1000, controlDir: join(dir, "control") });

    expect(await transport.endpoint(remote)).toBeNull();
    expect(transport.failureDetail(remote)).toMatch(/did not answer \/health in [1-9]\d* attempts over 1000ms/);
    transport.close();
  });

  it("leaves no control command behind for a forward that failed outright", async () => {
    fakeSsh("echo 'Permission denied (publickey).' >&2\nexit 255");
    const transport = new SshForwardTransport({ connectTimeoutMs: 5000, controlDir: join(dir, "control") });

    expect(await transport.endpoint(remote)).toBeNull();
    transport.close();
    expect(existsSync(join(dir, "control-command"))).toBe(false);
  });
});
