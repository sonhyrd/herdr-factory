// GitClient.branchDelete robustness — the teardown branch-leak fix. Uses a REAL temp git repo so it
// exercises actual `git branch -D` / `git worktree` semantics, not a fake.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitClient } from "../src/clients/git.ts";
import { run } from "../src/clients/exec.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

async function tempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "git-test-"));
  tmps.push(dir);
  await run("git", ["-C", dir, "init", "-q"]);
  await run("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", dir, "config", "user.name", "Test"]);
  await run("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("GitClient.branchDelete", () => {
  const git = new GitClient();

  it("deletes a plain (not-checked-out) branch and reports success", async () => {
    const dir = await tempRepo();
    await run("git", ["-C", dir, "branch", "fix/plain"]);
    expect(await git.branchExists(dir, "fix/plain")).toBe(true);
    expect(await git.branchDelete(dir, "fix/plain")).toBe(true);
    expect(await git.branchExists(dir, "fix/plain")).toBe(false);
  });

  it("is idempotent — reports success when the branch never existed", async () => {
    const dir = await tempRepo();
    expect(await git.branchDelete(dir, "fix/never")).toBe(true);
  });

  it("force-removes a lingering worktree still on the branch, then deletes it (the abandoned-run leak)", async () => {
    const dir = await tempRepo();
    const wt = join(tmpdir(), `git-wt-${Math.random().toString(36).slice(2)}`);
    tmps.push(wt);
    // A worktree checked out on the branch — exactly what a partial teardown of an abandoned run
    // leaves behind. Plain `git branch -D` REFUSES this ("checked out at …").
    await run("git", ["-C", dir, "worktree", "add", "-q", wt, "-b", "fix/abandoned"]);
    expect(await git.branchExists(dir, "fix/abandoned")).toBe(true);
    // Sanity: the plain delete really does fail while the worktree is registered.
    await run("git", ["-C", dir, "branch", "-D", "fix/abandoned"], { allowFail: true });
    expect(await git.branchExists(dir, "fix/abandoned")).toBe(true);
    // The robust path: force-remove the worktree + retry.
    expect(await git.branchDelete(dir, "fix/abandoned")).toBe(true);
    expect(await git.branchExists(dir, "fix/abandoned")).toBe(false);
    expect(existsSync(wt)).toBe(false); // the lingering worktree dir is gone too
  });
});

describe("GitClient.fetchRef — the base a worktree is cut from", () => {
  const git = new GitClient();

  it("moves the remote-tracking ref onto the remote's tip (the stale-clone bug)", async () => {
    const upstream = await tempRepo();
    const clone = mkdtempSync(join(tmpdir(), "git-clone-"));
    tmps.push(clone);
    await run("git", ["clone", "-q", upstream, clone]);
    const staleTip = (await run("git", ["-C", clone, "rev-parse", "origin/main"], { allowFail: true })).stdout.trim()
      || (await run("git", ["-C", clone, "rev-parse", "origin/master"])).stdout.trim();
    const branch = (await run("git", ["-C", upstream, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();

    // The upstream moves on — exactly the four-merges-old case: the clone's origin/<branch> is frozen
    // at clone time until something fetches it.
    await run("git", ["-C", upstream, "commit", "-q", "--allow-empty", "-m", "moved on"]);
    const remoteTip = (await run("git", ["-C", upstream, "rev-parse", "HEAD"])).stdout.trim();
    expect((await run("git", ["-C", clone, "rev-parse", `origin/${branch}`])).stdout.trim()).toBe(staleTip);

    expect(await git.fetchRef(clone, "origin", branch)).toBe(true);
    expect((await run("git", ["-C", clone, "rev-parse", `origin/${branch}`])).stdout.trim()).toBe(remoteTip);
  });

  it("reports failure instead of throwing when the remote is unreachable", async () => {
    const dir = await tempRepo();
    await run("git", ["-C", dir, "remote", "add", "origin", join(dir, "no-such-remote.git")]);
    expect(await git.fetchRef(dir, "origin", "main")).toBe(false);
  });

  it("reads a ref's age, and answers null for a ref that doesn't resolve", async () => {
    const dir = await tempRepo();
    expect(await git.refAge(dir, "HEAD")).toMatch(/ago|now/);
    expect(await git.refAge(dir, "origin/nope")).toBeNull();
  });
});

describe("GitClient.excludeMemoryDir — the factory's memory dir never dirties a worktree (#110)", () => {
  const git = new GitClient();

  it("a worktree whose repo lacks a .memory/ ignore reads clean with a .memory/ file present, and the line is added once", async () => {
    const dir = await tempRepo();
    const wts = [1, 2].map(() => join(tmpdir(), `git-wt-${Math.random().toString(36).slice(2)}`));
    tmps.push(...wts);
    for (const [i, wt] of wts.entries()) {
      await run("git", ["-C", dir, "worktree", "add", "-q", wt, "-b", `fix/mem-${i}`]);
      mkdirSync(join(wt, ".memory", "herdr-factory"), { recursive: true });
      writeFileSync(join(wt, ".memory", "herdr-factory", "task.md"), "x");
      // info/exclude is shared by every worktree of the checkout: only the first starts dirty.
      if (i === 0) expect(await git.dirtyStat(wt)).toContain(".memory/");
      await git.excludeMemoryDir(wt);
      await git.excludeMemoryDir(wt);
      expect(await git.dirtyStat(wt)).toBeNull();
    }
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".memory/")).toHaveLength(1);
  });
});
