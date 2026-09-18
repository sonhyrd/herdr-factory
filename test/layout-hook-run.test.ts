// runLayoutHook end to end with herdr, config and the runner stubbed: what the freshness gate does
// when a pane/tab is already open beside the worktree's root pane (issue #11).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  info: {} as Record<string, unknown>,
  panes: [] as { paneId: string; tabId: string; label: string | null }[],
  ownerRun: undefined as { id: number; ticketKey: string; belt: string } | undefined,
  applied: [] as { rootTabId?: string; rootPaneId?: string }[],
}));

vi.mock("../src/clients/herdr.ts", () => ({
  HerdrClient: class {
    workspaceInfo = async () => h.info;
  },
}));
vi.mock("../src/config-paths.ts", async (orig) => ({ ...(await orig<object>()), listConfiguredRepos: () => ["demo"] }));
vi.mock("../src/config.ts", () => ({ loadConfig: () => ({ config: { repo: { path: "/repo" } } }) }));
vi.mock("../src/core/layout.ts", () => ({
  applyLayout: async (_deps: unknown, target: { rootTabId?: string; rootPaneId?: string }) => void h.applied.push(target),
}));
vi.mock("../src/build-deps.ts", () => ({
  buildDeps: async () => ({
    config: {
      belts: [{ name: "b", beltType: "custom", source: "s", priority: 1, active: true, steps: [], watchPr: false, defaultLayout: "web" }],
      layouts: [{ id: "web", tabs: [{ title: "main", panes: [{ title: "agent", persist: true, env: {}, setup: false }] }] }],
    },
    herdr: {
      worktreeBranch: async () => "fix/1",
      listPanes: async () => h.panes,
      firstTabId: async () => "w1:t1",
      firstPaneOfTab: async () => "w1:p1",
    },
    store: { activeRunForWorktree: () => h.ownerRun, recordEvent: () => {} },
    log: () => {},
  }),
}));

const { runLayoutHook } = await import("../src/core/layout-hook.ts");

let stateDir = "";
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "lh-run-"));
  process.env.HERDR_FACTORY_LAYOUT_STATE_DIR = stateDir;
  h.applied = [];
  h.ownerRun = undefined;
  // A fresh worktree workspace, plus a second pane the operator opened before the hook ran.
  h.info = { checkoutPath: stateDir, repoRoot: "/repo", isLinkedWorktree: true, tabCount: 1, paneCount: 2, activeTabId: "w1:t1" };
  h.panes = [
    { paneId: "w1:p1", tabId: "w1:t1", label: null },
    { paneId: "w1:p2", tabId: "w1:t1", label: "preview" },
  ];
});
afterEach(() => {
  delete process.env.HERDR_FACTORY_LAYOUT_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

const focus = { HERDR_PLUGIN_EVENT: "workspace.focused", HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { workspace_id: "w1" } }) };

describe("runLayoutHook — a pane opened before the hook ran", () => {
  it("a factory run's worktree still gets its layout, as new tabs beside the user's", async () => {
    h.ownerRun = { id: 7, ticketKey: "GH-1", belt: "b" };
    expect(await runLayoutHook(focus)).toEqual({ applied: "web" });
    expect(h.applied).toEqual([expect.objectContaining({ rootTabId: undefined, rootPaneId: "w1:p1" })]);
  });
  it("an extra tab is no different", async () => {
    h.ownerRun = { id: 7, ticketKey: "GH-1", belt: "b" };
    h.info = { ...h.info, tabCount: 2, paneCount: 1 };
    expect(await runLayoutHook(focus)).toEqual({ applied: "web" });
  });
  it("a fresh run worktree rebuilds its root tab as before", async () => {
    h.ownerRun = { id: 7, ticketKey: "GH-1", belt: "b" };
    h.info = { ...h.info, paneCount: 1 };
    await runLayoutHook(focus);
    expect(h.applied).toEqual([expect.objectContaining({ rootTabId: "w1:t1" })]);
  });
  it("a hand-created worktree someone already arranged is still left alone", async () => {
    expect(await runLayoutHook(focus)).toEqual({ skipped: "workspace w1 is not a fresh 1-tab/1-pane workspace; skipping" });
    expect(h.applied).toEqual([]);
  });
  it("builds once: a later focus finds the claim", async () => {
    h.ownerRun = { id: 7, ticketKey: "GH-1", belt: "b" };
    await runLayoutHook(focus);
    expect((await runLayoutHook(focus)).skipped).toBe("already decided");
    expect(h.applied).toHaveLength(1);
  });
});
