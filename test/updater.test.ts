// Channel-aware self-updater (w2-08). Uses REAL temp git repos + a bare remote so it exercises
// actual fetch/reset/tag semantics, not a fake. Covers: main-channel upstream tracking, stable
// following the newest semver tag (numeric, not lexical) and holding there until a newer tag exists,
// the dirty-checkout guard (skip + one-time notify + survives the reset), and a failed attempt — all
// as surfaced through the recorded update-status file.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/clients/exec.ts";
import { runUpdate, readUpdateStatus, updateChannel, updateWarning, type UpdateStatus, type RunUpdateOpts } from "../src/watchers/updater.ts";

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

const noopLog = () => {};

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

/** A bare remote + a seed working clone (pushes upstream) + a `local` clone (the box being updated,
 *  tracking origin/main). Returns all three plus the local box's initial HEAD. */
async function setup(): Promise<{ remote: string; seed: string; local: string; c1: string }> {
  const remote = mkTmp("upd-remote-");
  await git(remote, "init", "--bare", "-q");
  const seed = mkTmp("upd-seed-");
  await git(seed, "init", "-q");
  await configUser(seed);
  const c1 = await commit(seed, "app.txt", "v1", "c1");
  await git(seed, "branch", "-M", "main");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  const local = mkTmp("upd-local-");
  await git(local, "clone", "-q", remote, ".");
  await configUser(local);
  return { remote, seed, local, c1 };
}

function opts(over: Partial<RunUpdateOpts> & { cwd: string }): RunUpdateOpts {
  return {
    channel: "main",
    statusPath: join(mkTmp("upd-status-"), "update-status.json"),
    notify: vi.fn(async () => {}),
    ...over,
  };
}
const readStatus = (path: string): UpdateStatus => JSON.parse(readFileSync(path, "utf8")) as UpdateStatus;

describe("updateChannel", () => {
  const orig = process.env.HERDR_CHANNEL;
  afterEach(() => {
    if (orig === undefined) delete process.env.HERDR_CHANNEL;
    else process.env.HERDR_CHANNEL = orig;
  });
  it("defaults to main, treats only `stable` (case-insensitive) as stable", () => {
    delete process.env.HERDR_CHANNEL;
    expect(updateChannel()).toBe("main");
    process.env.HERDR_CHANNEL = "STABLE";
    expect(updateChannel()).toBe("stable");
    process.env.HERDR_CHANNEL = "typo";
    expect(updateChannel()).toBe("main");
  });
});

describe("runUpdate — main channel", () => {
  it("hard-resets to the upstream tip and records `updated`", async () => {
    const { seed, local } = await setup();
    const c2 = await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");

    const o = opts({ cwd: local });
    const res = await runUpdate(noopLog, o);

    expect(res.updated).toBe(true);
    expect(res.to).toBe(c2);
    expect(await git(local, "rev-parse", "HEAD")).toBe(c2);
    const st = readStatus(o.statusPath);
    expect(st).toMatchObject({ channel: "main", outcome: "updated", head: c2, target: c2, behind: false });
  });

  it("no upstream commit → `up_to_date`, no reset", async () => {
    const { local, c1 } = await setup();
    const o = opts({ cwd: local });
    const res = await runUpdate(noopLog, o);
    expect(res.updated).toBe(false);
    expect(await git(local, "rev-parse", "HEAD")).toBe(c1);
    expect(readStatus(o.statusPath)).toMatchObject({ outcome: "up_to_date", behind: false });
  });

  it("no upstream configured → `failed` + behind", async () => {
    const bare = mkTmp("upd-plain-");
    await git(bare, "init", "-q");
    await configUser(bare);
    await commit(bare, "a.txt", "x", "c1"); // a repo with a HEAD but no tracking branch
    const o = opts({ cwd: bare });
    const res = await runUpdate(noopLog, o);
    expect(res.updated).toBe(false);
    expect(readStatus(o.statusPath)).toMatchObject({ outcome: "failed", behind: true });
  });

  // Issue #35: on a no-service host a `while :; do herdr-factory ensure-up; sleep 60; done` loop is
  // the only scheduler, so a fetch that never returns froze auto-update for hours. The fetch must be
  // bounded: the tick ends, records a fresh `failed` attempt, and the next tick retries.
  it("a hung fetch is killed at the budget and recorded as `failed` (the tick ends)", async () => {
    const { local } = await setup();
    await git(local, "config", "protocol.ext.allow", "always");
    await git(local, "remote", "set-url", "origin", "ext::sleep 30"); // a remote that never answers
    const o = opts({ cwd: local, gitTimeoutMs: 500 });
    const started = Date.now();
    const res = await runUpdate(noopLog, o);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.updated).toBe(false);
    expect(readStatus(o.statusPath)).toMatchObject({ outcome: "failed", behind: true });
    expect(readStatus(o.statusPath).reason).toMatch(/timed out/);
  });

  it("not a git checkout → `skipped`", async () => {
    const dir = mkTmp("upd-nogit-");
    const o = opts({ cwd: dir });
    const res = await runUpdate(noopLog, o);
    expect(res.updated).toBe(false);
    expect(readStatus(o.statusPath)).toMatchObject({ outcome: "skipped", reason: "not a git checkout" });
  });
});

describe("runUpdate — stable channel", () => {
  it("follows the newest release tag (numeric, not lexical) and holds until a newer tag exists", async () => {
    const { seed, local } = await setup();
    // c1 tagged v1.9.0; c2 tagged v1.10.0 (must beat v1.9.0 numerically); c3 UNTAGGED tip.
    await git(seed, "tag", "v1.9.0");
    const c2 = await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "tag", "v1.10.0");
    await commit(seed, "app.txt", "v3", "c3"); // newer than any tag, no tag of its own
    await git(seed, "push", "-q", "origin", "main");
    await git(seed, "push", "-q", "origin", "--tags");

    const o = opts({ cwd: local, channel: "stable" });
    const res = await runUpdate(noopLog, o);
    expect(res.updated).toBe(true);
    expect(await git(local, "rev-parse", "HEAD")).toBe(c2); // v1.10.0, NOT the untagged c3 tip
    expect(readStatus(o.statusPath)).toMatchObject({ channel: "stable", outcome: "updated", targetRef: "v1.10.0", behind: false });

    // A newer untagged commit lands on main → stable stays on v1.10.0 (up to date w.r.t. its target).
    await commit(seed, "app.txt", "v4", "c4");
    await git(seed, "push", "-q", "origin", "main");
    const o2 = opts({ cwd: local, channel: "stable" });
    expect((await runUpdate(noopLog, o2)).updated).toBe(false);
    expect(await git(local, "rev-parse", "HEAD")).toBe(c2);
    expect(readStatus(o2.statusPath)).toMatchObject({ outcome: "up_to_date", targetRef: "v1.10.0" });

    // Cut v1.11.0 at the new tip → stable advances to it.
    const c4 = await git(seed, "rev-parse", "HEAD");
    await git(seed, "tag", "v1.11.0");
    await git(seed, "push", "-q", "origin", "--tags");
    const o3 = opts({ cwd: local, channel: "stable" });
    expect((await runUpdate(noopLog, o3)).updated).toBe(true);
    expect(await git(local, "rev-parse", "HEAD")).toBe(c4);
    expect(readStatus(o3.statusPath)).toMatchObject({ outcome: "updated", targetRef: "v1.11.0" });
  });

  it("ignores pre-release tags", async () => {
    const { seed, local } = await setup();
    await git(seed, "tag", "v2.0.0"); // at c1
    const c2 = await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "tag", "v2.1.0-rc1"); // pre-release at a NEWER commit — must be ignored
    await git(seed, "push", "-q", "origin", "main");
    await git(seed, "push", "-q", "origin", "--tags");

    const o = opts({ cwd: local, channel: "stable" });
    await runUpdate(noopLog, o);
    expect(readStatus(o.statusPath)).toMatchObject({ targetRef: "v2.0.0" }); // not the rc at c2
    expect(await git(local, "rev-parse", "HEAD")).not.toBe(c2);
  });

  it("no release tags yet → benign `skipped` + behind", async () => {
    const { local } = await setup();
    const o = opts({ cwd: local, channel: "stable" });
    const res = await runUpdate(noopLog, o);
    expect(res.updated).toBe(false);
    expect(readStatus(o.statusPath)).toMatchObject({ channel: "stable", outcome: "skipped", behind: true });
    expect(readStatus(o.statusPath).reason).toMatch(/no release tags/);
  });
});

describe("runUpdate — dirty-checkout guard", () => {
  it("skips the reset, keeps local edits, records the skip, and notifies once", async () => {
    const { seed, local, c1 } = await setup();
    await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");
    // Hand-patch the box: an uncommitted local edit.
    writeFileSync(join(local, "app.txt"), "HAND PATCHED");

    const notify = vi.fn(async () => {});
    const o = opts({ cwd: local, notify });
    const res = await runUpdate(noopLog, o);

    expect(res.updated).toBe(false);
    expect(res.reason).toBe("dirty checkout");
    expect(await git(local, "rev-parse", "HEAD")).toBe(c1); // NOT reset to c2
    expect(readFileSync(join(local, "app.txt"), "utf8")).toBe("HAND PATCHED"); // edit survived
    expect(notify).toHaveBeenCalledOnce();
    const st = readStatus(o.statusPath);
    expect(st).toMatchObject({ outcome: "skipped", dirtySkip: true, behind: true });
    expect(typeof st.notifiedAt).toBe("number");
  });

  it("does not re-notify on the next dirty tick (throttled), reusing the recorded status path", async () => {
    const { seed, local } = await setup();
    await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");
    writeFileSync(join(local, "app.txt"), "HAND PATCHED");

    const statusPath = join(mkTmp("upd-status-"), "update-status.json");
    const notify = vi.fn(async () => {});
    await runUpdate(noopLog, opts({ cwd: local, statusPath, notify }));
    await runUpdate(noopLog, opts({ cwd: local, statusPath, notify }));
    expect(notify).toHaveBeenCalledOnce(); // second dirty tick stays quiet
  });
});

describe("updateWarning", () => {
  const clean: UpdateStatus = { channel: "main", at: Date.now(), outcome: "up_to_date", behind: false, targetRef: "origin/main" };
  it("is null when the last attempt is clean or unrecorded", () => {
    expect(updateWarning(null)).toBeNull();
    expect(updateWarning(clean)).toBeNull();
    expect(updateWarning({ ...clean, outcome: "updated" })).toBeNull();
  });
  it("flags failed / dirty-skip / behind / degraded", () => {
    expect(updateWarning({ ...clean, outcome: "failed", behind: true, reason: "boom" })).toMatch(/failed.*boom/);
    expect(updateWarning({ ...clean, outcome: "skipped", behind: true, dirtySkip: true })).toMatch(/uncommitted changes/);
    expect(updateWarning({ channel: "stable", at: 0, outcome: "skipped", behind: true, targetRef: "v1.2.0" })).toMatch(/stable.*behind.*v1\.2\.0/);
    expect(updateWarning({ ...clean, outcome: "updated", warning: "dep install failed" })).toMatch(/but dep install failed/);
  });
  it("flags a stalled updater — an `up to date` recorded hours ago is stale news", () => {
    expect(updateWarning({ ...clean, at: Date.now() - 3 * 3600_000 })).toMatch(/auto-update stalled — last check 3h ago/);
    expect(updateWarning({ ...clean, at: Date.now() - 5 * 60_000 })).toBeNull(); // a few missed ticks is fine
  });
});

describe("readUpdateStatus", () => {
  const orig = process.env.HERDR_FACTORY_STATE_ROOT;
  afterEach(() => {
    if (orig === undefined) delete process.env.HERDR_FACTORY_STATE_ROOT;
    else process.env.HERDR_FACTORY_STATE_ROOT = orig;
  });
  it("reads back the file the updater wrote at the default state path", async () => {
    const stateRoot = mkTmp("upd-state-");
    process.env.HERDR_FACTORY_STATE_ROOT = stateRoot;
    const { seed, local } = await setup();
    const c2 = await commit(seed, "app.txt", "v2", "c2");
    await git(seed, "push", "-q", "origin", "main");
    await runUpdate(noopLog, opts({ cwd: local, statusPath: join(stateRoot, "update-status.json") }));
    expect(readUpdateStatus()).toMatchObject({ outcome: "updated", head: c2 });
  });
  it("returns null when no status file exists", () => {
    process.env.HERDR_FACTORY_STATE_ROOT = mkTmp("upd-empty-");
    expect(readUpdateStatus()).toBeNull();
  });
});
