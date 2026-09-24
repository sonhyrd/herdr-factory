import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/clients/exec.ts";
import { gitDir, killPortListeners, listenerPids, readRunPort } from "../src/core/dev-server.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

const haveLsof = await run("sh", ["-c", "command -v lsof"], { allowFail: true }).then((r) => r.code === 0);

describe("hf-port handshake", () => {
  it("resolves a LINKED worktree's git dir through its `.git` file, and reads the port", () => {
    const wt = tmp("hf-wt-");
    const gd = tmp("hf-gitdir-");
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    writeFileSync(join(gd, "hf-port"), "4100\n");
    expect(gitDir(wt)).toBe(gd);
    expect(readRunPort(wt)).toBe(4100);
  });

  it("reads the port from a MAIN checkout's `.git` directory too", () => {
    const wt = tmp("hf-main-");
    mkdirSync(join(wt, ".git"));
    writeFileSync(join(wt, ".git", "hf-port"), "4004");
    expect(readRunPort(wt)).toBe(4004);
  });

  it("is null — never a throw — when the worktree, the git dir, or the port is unusable", () => {
    const wt = tmp("hf-empty-");
    expect(readRunPort("/no/such/worktree")).toBeNull(); // worktree already gone
    expect(readRunPort(wt)).toBeNull(); // no .git
    const gd = tmp("hf-gitdir2-");
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    expect(readRunPort(wt)).toBeNull(); // no hf-port
    writeFileSync(join(gd, "hf-port"), "not-a-port\n");
    expect(readRunPort(wt)).toBeNull(); // garbage
    writeFileSync(join(gd, "hf-port"), "99999\n");
    expect(readRunPort(wt)).toBeNull(); // not a port number
  });
});

describe("killPortListeners", () => {
  it("returns empty for a port nothing is listening on", { skip: !haveLsof }, async () => {
    expect(await killPortListeners(1)).toEqual([]);
  });

  it("throws rather than reporting an empty port when lsof is missing", async () => {
    // A host without lsof must not read as "nothing is listening" — that would have teardown log a
    // reap it never did, and doctor report no orphans. The caller logs "could not reap …" instead.
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(listenerPids(4321)).rejects.toThrow(/lsof/);
    } finally {
      process.env.PATH = path;
    }
  });

  it("kills a REAL listener started as a child (the orphan case), and frees its port", { skip: !haveLsof, timeout: 15_000 }, async () => {
    // A listener whose parent is a shell in its own process group — the pnpm→dev-server shape
    // whose reparented child survived teardown. It prints `<pid> <port>` once it is up.
    const script = "const s=require('node:net').createServer().listen(0,()=>console.log(process.pid,s.address().port))";
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const [pid, port] = (await new Promise<string>((resolve) => child.stdout!.once("data", (b) => resolve(String(b)))))
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10)) as [number, number];
    try {
      expect(await listenerPids(port)).toContain(pid);
      expect((await killPortListeners(port)).map((k) => k.pid)).toContain(pid);
      expect(await listenerPids(port)).toEqual([]); // port is free again
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already reaped by the code under test — that is the point */
      }
    }
  });
});
