// The doctor `auto-update` check surfaces the recorded update-status file — an amber (warn) line on
// a failed / dirty-skipped / behind-target box, and a plain ✓ when up to date. Writes a temp state
// root so it reads a controlled status file (not this box's real one).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCheck } from "../src/doctor.ts";
import { updateStatusPath } from "../src/config-paths.ts";
import { type UpdateStatus } from "../src/watchers/updater.ts";

const tmps: string[] = [];
const orig = process.env.HERDR_FACTORY_STATE_ROOT;
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
  if (orig === undefined) delete process.env.HERDR_FACTORY_STATE_ROOT;
  else process.env.HERDR_FACTORY_STATE_ROOT = orig;
});

function withStatus(status: UpdateStatus): void {
  const stateRoot = mkdtempSync(join(tmpdir(), "doc-upd-"));
  tmps.push(stateRoot);
  process.env.HERDR_FACTORY_STATE_ROOT = stateRoot;
  writeFileSync(updateStatusPath(), JSON.stringify(status));
}
const base: UpdateStatus = { channel: "main", at: Date.now(), outcome: "up_to_date", behind: false, targetRef: "origin/main" };

describe("doctor updateCheck — amber surfacing", () => {
  it("up to date → ✓ (no warn)", async () => {
    withStatus(base);
    const c = await updateCheck();
    expect(c.ok).toBe(true);
    expect(c.warn).toBeFalsy();
    expect(c.detail).toContain("main");
  });

  it("failed → amber warn with the reason", async () => {
    withStatus({ ...base, outcome: "failed", reason: "fetch failed", behind: true });
    const c = await updateCheck();
    expect(c).toMatchObject({ ok: true, warn: true });
    expect(c.detail).toMatch(/FAILED.*fetch failed/);
  });

  it("dirty skip → amber warn naming the uncommitted-changes skip", async () => {
    withStatus({ ...base, outcome: "skipped", behind: true, dirtySkip: true, targetRef: "origin/main", reason: "dirty" });
    const c = await updateCheck();
    expect(c).toMatchObject({ ok: true, warn: true });
    expect(c.detail).toMatch(/uncommitted changes/);
  });

  it("behind its target → amber warn", async () => {
    withStatus({ channel: "stable", at: Date.now(), outcome: "skipped", behind: true, reason: "no release tags yet (stable channel)" });
    const c = await updateCheck();
    expect(c).toMatchObject({ ok: true, warn: true });
    expect(c.detail).toMatch(/stable/);
  });

  it("updated-but-degraded (post-step warning) → amber warn", async () => {
    withStatus({ ...base, outcome: "updated", behind: false, warning: "dependency install failed — boom" });
    const c = await updateCheck();
    expect(c).toMatchObject({ ok: true, warn: true });
    expect(c.detail).toMatch(/updated but .*dependency install failed/);
  });

  it("stalled (no attempt recorded for hours) → amber warn with the age", async () => {
    withStatus({ ...base, at: Date.now() - 5 * 3600_000 });
    const c = await updateCheck();
    expect(c).toMatchObject({ ok: true, warn: true });
    expect(c.detail).toMatch(/auto-update stalled — last check 5h ago/);
  });
});
