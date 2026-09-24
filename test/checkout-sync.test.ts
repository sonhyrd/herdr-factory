// ensure-up's main-checkout fast-forward (issue #71). Real temp git repos + a bare remote, so the
// fetch/ff/divergence semantics are the real ones. Covers: ff on a clean base branch, the three
// skips (other branch, dirty tree, diverged), the 10-minute throttle, and one repo's fetch failure
// leaving the rest of the sweep alone.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/clients/exec.ts";
import { checkoutSyncCheck, liveConfigCheck } from "../src/doctor.ts";
import { syncCheckouts, splitBaseRef, type CheckoutTarget } from "../src/watchers/checkouts.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});
const mkTmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};

const logs: string[] = [];
const log = (level: string, msg: string) => void logs.push(`${level}: ${msg}`);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", cwd, ...args])).stdout.trim();
}
async function commit(cwd: string, file: string, body: string, msg: string): Promise<string> {
  writeFileSync(join(cwd, file), body);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}
async function configUser(cwd: string): Promise<void> {
  await git(cwd, "config", "user.email", "t@example.com");
  await git(cwd, "config", "user.name", "Test");
}

/** A bare remote, a seed clone that pushes new upstream commits, and the `local` main checkout. */
async function setup(): Promise<{ remote: string; seed: string; local: string; statePath: string }> {
  const remote = mkTmp("ck-remote-");
  await git(remote, "init", "--bare", "-q");
  const seed = mkTmp("ck-seed-");
  await git(seed, "init", "-q");
  await configUser(seed);
  await commit(seed, "app.txt", "v1", "c1");
  await git(seed, "branch", "-M", "main");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  const local = mkTmp("ck-local-");
  await git(local, "clone", "-q", remote, ".");
  await configUser(local);
  return { remote, seed, local, statePath: join(mkTmp("ck-state-"), "checkout-sync.json") };
}

const target = (local: string, name = "demo"): CheckoutTarget => ({ name, path: local, baseRef: "origin/main" });

describe("splitBaseRef", () => {
  it("splits remote from branch, defaulting a bare branch to origin", () => {
    expect(splitBaseRef("origin/main")).toEqual({ remote: "origin", branch: "main" });
    expect(splitBaseRef("upstream/release/v2")).toEqual({ remote: "upstream", branch: "release/v2" });
    expect(splitBaseRef("main")).toEqual({ remote: "origin", branch: "main" });
  });
});

describe("syncCheckouts", () => {
  it("fast-forwards a clean checkout sitting on its base branch", async () => {
    const { seed, local, statePath } = await setup();
    const c2 = await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");

    const state = await syncCheckouts(log, { repos: [target(local)], statePath });
    expect(state.demo?.outcome).toBe("fast_forwarded");
    expect(await git(local, "rev-parse", "HEAD")).toBe(c2);
  });

  it("reports up_to_date when there is nothing to pull, and leaves untracked files alone", async () => {
    const { local, statePath } = await setup();
    writeFileSync(join(local, "scratch.txt"), "mine");
    const state = await syncCheckouts(log, { repos: [target(local)], statePath });
    expect(state.demo?.outcome).toBe("up_to_date");
  });

  it("skips a checkout parked on another branch", async () => {
    const { seed, local, statePath } = await setup();
    await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");
    await git(local, "checkout", "-q", "-b", "sonhyrd/1540-thing");

    const state = await syncCheckouts(log, { repos: [target(local)], statePath });
    expect(state.demo?.outcome).toBe("skipped");
    expect(state.demo?.reason).toContain("on sonhyrd/1540-thing");
  });

  it("skips a dirty tree without stashing or discarding the change", async () => {
    const { seed, local, statePath } = await setup();
    await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");
    writeFileSync(join(local, "app.txt"), "hand-patched");

    const state = await syncCheckouts(log, { repos: [target(local)], statePath });
    expect(state.demo?.reason).toBe("dirty tree, skipped");
    expect((await run("cat", [join(local, "app.txt")])).stdout.trim()).toBe("hand-patched");
  });

  it("skips diverged history rather than merging or resetting", async () => {
    const { seed, local, statePath } = await setup();
    await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");
    const mine = await commit(local, "local.txt", "local work", "local commit");

    const state = await syncCheckouts(log, { repos: [target(local)], statePath });
    expect(state.demo?.reason).toBe("diverged, skipped");
    expect(await git(local, "rev-parse", "HEAD")).toBe(mine);
  });

  it("respects the throttle — a second sweep inside the window does nothing", async () => {
    const { seed, local, statePath } = await setup();
    const t0 = 1_000_000;
    const first = await syncCheckouts(log, { repos: [target(local)], statePath, now: t0 });
    expect(first.demo?.outcome).toBe("up_to_date");

    const c2 = await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");

    const early = await syncCheckouts(log, { repos: [target(local)], statePath, now: t0 + 9 * 60_000 });
    expect(early.demo?.at).toBe(t0);
    expect(await git(local, "rev-parse", "HEAD")).not.toBe(c2);

    const due = await syncCheckouts(log, { repos: [target(local)], statePath, now: t0 + 11 * 60_000 });
    expect(due.demo?.outcome).toBe("fast_forwarded");
    expect(await git(local, "rev-parse", "HEAD")).toBe(c2);
  });

  it("keeps going when one repo's fetch fails", async () => {
    const { seed, local, statePath } = await setup();
    const c2 = await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");
    const broken = mkTmp("ck-broken-");
    await git(broken, "init", "-q");
    await configUser(broken);
    await commit(broken, "x.txt", "x", "c1");
    await git(broken, "branch", "-M", "main");
    await git(broken, "remote", "add", "origin", "/nonexistent/remote.git");

    const state = await syncCheckouts(log, {
      repos: [{ name: "broken", path: broken, baseRef: "origin/main" }, target(local), { name: "gone", path: mkTmp("ck-gone-"), baseRef: "origin/main" }],
      statePath,
    });
    expect(state.broken?.outcome).toBe("failed");
    expect(state.gone?.reason).toBe("not a git checkout");
    expect(state.demo?.outcome).toBe("fast_forwarded");
    expect(await git(local, "rev-parse", "HEAD")).toBe(c2);
  });

  it("logs a skip once per state change, not every sweep", async () => {
    const { local, statePath } = await setup();
    await git(local, "checkout", "-q", "-b", "feature/x");
    logs.length = 0;
    const t0 = 2_000_000;
    await syncCheckouts(log, { repos: [target(local)], statePath, now: t0 });
    await syncCheckouts(log, { repos: [target(local)], statePath, now: t0 + 11 * 60_000 });
    expect(logs.filter((l) => l.includes("on feature/x"))).toHaveLength(1);
  });
});

describe("checkoutSyncCheck", () => {
  const now = 5_000_000;
  it("says nothing has been recorded on a fresh box", () => {
    const fresh = checkoutSyncCheck({}, now);
    expect(fresh.ok).toBe(true);
    expect(fresh.warn).toBeUndefined();
    expect(fresh.detail).toContain("no sync recorded yet");
  });
  it("is green when every checkout is current and amber when one is not", () => {
    const green = checkoutSyncCheck({ a: { repo: "a", path: "/p", at: now - 60_000, outcome: "up_to_date" } }, now);
    expect(green.warn).toBeUndefined();
    expect(green.detail).toContain("a: up to date");
    const amber = checkoutSyncCheck(
      {
        a: { repo: "a", path: "/p", at: now - 60_000, outcome: "up_to_date" },
        b: { repo: "b", path: "/q", at: now - 60_000, outcome: "skipped", reason: "dirty tree, skipped" },
      },
      now,
    );
    expect(amber.warn).toBe(true);
    expect(amber.detail).toContain("b: dirty tree, skipped");
  });
});

// The live config dir is rolled out by hand; doctor only reports how far it lags (issue #115).
describe("liveConfigCheck", () => {
  it("warns with the count and first subject when behind, ✓ once current — without moving HEAD", async () => {
    const { seed, local } = await setup();
    const head = await git(local, "rev-parse", "HEAD");
    await commit(seed, "app.txt", "v2", "fix the port race");
    await commit(seed, "app.txt", "v3", "c3");
    await git(seed, "push", "-q", "origin", "main");

    const behind = await liveConfigCheck(local, true);
    expect(behind.ok).toBe(true);
    expect(behind.warn).toBe(true);
    expect(behind.detail).toContain("live config 2 commit(s) behind origin/main (fix the port race)");
    expect(await git(local, "rev-parse", "HEAD")).toBe(head); // fetch only, never a pull

    await git(local, "merge", "-q", "--ff-only", "origin/main");
    const current = await liveConfigCheck(local, true);
    expect(current.warn).toBeUndefined();
    expect(current.detail).toBe("at origin/main");
  });

  it("warns naming a modified tracked file, ignoring untracked ones", async () => {
    const { local } = await setup();
    writeFileSync(join(local, "app.txt"), "edited");
    writeFileSync(join(local, "scratch.txt"), "untracked");
    const dirty = await liveConfigCheck(local);
    expect(dirty.warn).toBe(true);
    expect(dirty.detail).toContain("uncommitted changes to app.txt");
    expect(dirty.detail).not.toContain("scratch.txt");
  });

  it("is quiet when the dir is not a git checkout", async () => {
    const r = await liveConfigCheck(mkTmp("ck-plain-"));
    expect(r.warn).toBeUndefined();
    expect(r.detail).toContain("not a git checkout");
  });
});
