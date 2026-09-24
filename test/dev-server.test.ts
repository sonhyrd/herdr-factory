import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/clients/exec.ts";
import { gitDir, killPortListeners, listenerPids, readRunPort, type ReapIO } from "../src/core/dev-server.ts";

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
    expect(await killPortListeners(1, tmp("hf-wt-"))).toEqual({ killed: [], skipped: [], lsof: "lsof -nP -ti tcp:1 -sTCP:LISTEN" });
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
    const wt = tmp("hf-wt-");
    const child = spawn(process.execPath, ["-e", script], { cwd: wt, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const [pid, port] = (await new Promise<string>((resolve) => child.stdout!.once("data", (b) => resolve(String(b)))))
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10)) as [number, number];
    try {
      expect(await listenerPids(port)).toContain(pid);
      // Not ours from a sibling worktree: left running, port still held.
      expect(await killPortListeners(port, tmp("hf-sibling-"))).toMatchObject({ killed: [], skipped: [{ pid }] });
      expect(await listenerPids(port)).toContain(pid);
      const { killed } = await killPortListeners(port, wt);
      expect(killed.map((k) => k.pid)).toContain(pid);
      expect(killed[0]!.rssKb).toBeGreaterThan(0);
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

describe("killPortListeners — ownership (injected io, no real processes)", () => {
  /** A fake host: pid → cwd (null = unreadable, "throw" = lsof failed), every signal recorded. */
  function fakeIO(cwds: Record<number, string | null | "throw">) {
    const signals: string[] = [];
    const listening = new Set(Object.keys(cwds).map(Number));
    const io: ReapIO = {
      listenerPids: async () => [...listening],
      cwdOf: async (pid) => {
        const c = cwds[pid];
        if (c === "throw") throw new Error("lsof: permission denied");
        return c ?? null;
      },
      rssKbOf: async (pid) => pid * 1000,
      signal: async (pid, sig) => {
        signals.push(`${sig} ${pid}`);
        if (sig === "SIGTERM" && pid !== 12) listening.delete(pid); // 12 ignores TERM
      },
      sleep: async () => {},
    };
    return { io, signals };
  }

  it("kills a listener whose cwd is inside the worktree, with its RSS and cwd", async () => {
    const wt = tmp("hf-wt-");
    const { io, signals } = fakeIO({ 11: join(wt, "apps/web"), 12: wt });
    const r = await killPortListeners(4100, wt, io);
    expect(r.killed).toEqual([{ pid: 11, rssKb: 11_000, cwd: join(wt, "apps/web") }, { pid: 12, rssKb: 12_000, cwd: wt }]);
    expect(r.skipped).toEqual([]);
    expect(signals).toEqual(["SIGTERM 11", "SIGTERM 12", "SIGKILL 12"]); // the sweep hits only what still listens
  });

  it("leaves a sibling worktree's listener running — a shared prefix is not inside", async () => {
    const wt = tmp("hf-wt-");
    const { io, signals } = fakeIO({ 21: `${wt}-sibling`, 22: "/somewhere/else" });
    const r = await killPortListeners(4100, wt, io);
    expect(r).toMatchObject({ killed: [], skipped: [{ pid: 21, cwd: `${wt}-sibling` }, { pid: 22, cwd: "/somewhere/else" }] });
    expect(signals).toEqual([]);
  });

  it("never signals a listener whose cwd can't be read", async () => {
    const wt = tmp("hf-wt-");
    const { io, signals } = fakeIO({ 31: null, 32: "throw" });
    expect((await killPortListeners(4100, wt, io)).skipped).toEqual([{ pid: 31, cwd: null }, { pid: 32, cwd: null }]);
    expect(signals).toEqual([]);
  });

  it("matches through symlinks, and still matches once teardown has removed the worktree", async () => {
    const real = tmp("hf-real-");
    const link = join(tmp("hf-link-"), "wt");
    symlinkSync(real, link);
    const { io } = fakeIO({ 41: real });
    expect((await killPortListeners(4100, link, io)).killed.map((k) => k.pid)).toEqual([41]);
    const gone = join(real, "removed-worktree"); // never created: the dir teardown already destroyed
    const { io: io2 } = fakeIO({ 42: join(gone, "src") });
    expect((await killPortListeners(4100, gone, io2)).killed.map((k) => k.pid)).toEqual([42]);
  });
});
