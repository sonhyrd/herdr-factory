import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEventPayload, claimApply, releaseApply, alreadyApplied, isDecided, markDecided, reapOrphanClaims, runLayoutStartup } from "../src/core/layout-hook.ts";
import { resolveHookLayout } from "../src/core/layout-match.ts";
import type { BeltConfig, LayoutConfig } from "../src/config.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
  delete process.env.HERDR_FACTORY_LAYOUT_STATE_DIR;
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
function useStateDir(): string {
  const d = tmp("lh-state-");
  process.env.HERDR_FACTORY_LAYOUT_STATE_DIR = d;
  return d;
}

describe("parseEventPayload", () => {
  it("reads the nested created shape (workspace + active_tab_id)", () => {
    const p = parseEventPayload({ HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: "worktree_created", data: { workspace: { workspace_id: "wZ", active_tab_id: "wZ:t1" } } }) });
    expect(p.workspaceId).toBe("wZ");
    expect(p.tabId).toBe("wZ:t1");
  });
  it("reads the workspace.focused id-only shape", () => {
    const p = parseEventPayload({ HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: "workspace_focused", data: { workspace_id: "wY" } }) });
    expect(p.workspaceId).toBe("wY");
  });
  it("reads the root_pane fallback", () => {
    const p = parseEventPayload({ HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "w1:p0" } } }) });
    expect(p.rootPaneId).toBe("w1:p0");
  });
  it("ignores ambient env vars and malformed json", () => {
    expect(parseEventPayload({ HERDR_WORKSPACE_ID: "wAmbient" }).workspaceId).toBeUndefined();
    expect(parseEventPayload({ HERDR_PLUGIN_EVENT_JSON: "not json" }).workspaceId).toBeUndefined();
    expect(parseEventPayload({}).workspaceId).toBeUndefined();
  });
});

describe("claim / decided / reap — filesystem idempotency", () => {
  it("claim is atomic + idempotent per checkout path; release re-opens it", () => {
    useStateDir();
    const wt = tmp("wt-");
    expect(alreadyApplied(wt)).toBe(false);
    expect(claimApply(wt)).toBe(true); // first wins
    expect(alreadyApplied(wt)).toBe(true);
    expect(claimApply(wt)).toBe(false); // second loses
    expect(claimApply(tmp("wt-other-"))).toBe(true); // a different path is independent
    releaseApply(wt);
    expect(alreadyApplied(wt)).toBe(false);
    expect(claimApply(wt)).toBe(true); // re-claim after release (transient-failure retry)
  });

  it("an unchanged (restored) worktree stays claimed — not re-applied", () => {
    useStateDir();
    const wt = tmp("wt-");
    expect(claimApply(wt)).toBe(true);
    expect(claimApply(wt)).toBe(false);
  });

  it("re-claims a worktree recreated at the same path (identity mismatch)", () => {
    const state = useStateDir();
    const wt = tmp("wt-");
    expect(claimApply(wt)).toBe(true);
    expect(claimApply(wt)).toBe(false);
    // Simulate a remove+recreate: the recorded inode no longer matches the live dir.
    const meta = join(state, "applied", createHash("sha1").update(resolve(wt)).digest("hex"), "meta.json");
    writeFileSync(meta, JSON.stringify({ path: resolve(wt), ino: "0", birthtimeMs: 0 }));
    expect(claimApply(wt)).toBe(true); // stale → reset → re-applies
    expect(claimApply(wt)).toBe(false); // refreshed claim honoured again
  });

  it("reapOrphanClaims drops gone worktrees, keeps live ones", () => {
    useStateDir();
    const live = tmp("wt-live-");
    const gone = tmp("wt-gone-");
    expect(claimApply(live)).toBe(true);
    expect(claimApply(gone)).toBe(true);
    rmSync(gone, { recursive: true, force: true }); // removed out-of-band
    expect(reapOrphanClaims()).toBe(1);
    expect(alreadyApplied(gone)).toBe(false);
    expect(alreadyApplied(live)).toBe(true);
    expect(reapOrphanClaims()).toBe(0); // second sweep is a no-op
  });

  it("decided cache is per workspace id", () => {
    useStateDir();
    expect(isDecided("w5")).toBe(false);
    markDecided("w5");
    expect(isDecided("w5")).toBe(true);
    expect(isDecided("w6")).toBe(false);
  });

  it("the [[startup]] hook reaps orphans and clears the decided cache, keeping live claims", () => {
    // Workspace ids are per-server-session and RECYCLED, so a decided entry surviving a herdr restart
    // could make the hook skip a layout for a different workspace that inherited the id. The
    // per-path claim is the real guard, and it must survive.
    useStateDir();
    const live = tmp("wt-live-");
    const gone = tmp("wt-gone-");
    expect(claimApply(live)).toBe(true);
    expect(claimApply(gone)).toBe(true);
    rmSync(gone, { recursive: true, force: true });
    markDecided("w1");

    expect(runLayoutStartup()).toEqual({ reaped: 1, decidedCleared: true });
    expect(isDecided("w1")).toBe(false);
    expect(alreadyApplied(live)).toBe(true); // the durable claim is untouched
    expect(alreadyApplied(gone)).toBe(false);
    expect(runLayoutStartup()).toEqual({ reaped: 0, decidedCleared: false }); // idempotent
  });
});

describe("resolveHookLayout — factory-owned vs manual worktree", () => {
  const layouts: LayoutConfig[] = [
    { id: "web", tabs: [{ panes: [{ persist: true, env: {}, setup: false }] }] },
    { id: "hot", tabs: [{ panes: [{ persist: true, env: {}, setup: false }] }] },
  ];
  const belt = (over: Partial<BeltConfig>): BeltConfig => ({ name: "b", beltType: "custom", source: "s", priority: 100, active: true, steps: [], watchPr: false, ...over });

  it("uses the owning run's belt when the worktree is factory-owned", () => {
    const belts = [belt({ name: "a", priority: 1, defaultLayout: "web" }), belt({ name: "b", priority: 2, defaultLayout: "hot" })];
    expect(resolveHookLayout(belts, layouts, "b", "any-branch")?.layout.id).toBe("hot");
  });
  it("walks belts in order for a manual worktree (first that yields a layout wins)", () => {
    const belts = [belt({ name: "a", priority: 1, defaultLayout: "web" }), belt({ name: "b", priority: 2, defaultLayout: "hot" })];
    expect(resolveHookLayout(belts, layouts, undefined, "any-branch")?.layout.id).toBe("web");
  });
  it("an owned layout-less belt yields nothing — never another belt's layout", () => {
    // The owning run's steps spawn dedicated panes; painting "web" here breaks that spawn (#12).
    const belts = [belt({ name: "a", priority: 1, defaultLayout: "web" }), belt({ name: "b", priority: 2 })];
    expect(resolveHookLayout(belts, layouts, "b", "any-branch")).toBeUndefined();
  });
  it("falls back to walking belts when the named owner belt is gone from the config", () => {
    const belts = [belt({ name: "a", priority: 1, defaultLayout: "web" })];
    expect(resolveHookLayout(belts, layouts, "removed", "any-branch")?.layout.id).toBe("web");
  });
  it("undefined when no belt yields a layout", () => {
    expect(resolveHookLayout([belt({})], layouts, undefined, "any-branch")).toBeUndefined();
  });
});
