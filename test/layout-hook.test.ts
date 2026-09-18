import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEventPayload, claimApply, releaseApply, alreadyApplied, isDecided, markDecided, reapOrphanClaims, runLayoutStartup, ownPanes, DEFAULT_IGNORED_PANE_LABELS } from "../src/core/layout-hook.ts";
import { resolveHookLayout } from "../src/core/layout-match.ts";
import type { BeltConfig, LayoutConfig, LayoutPane, StepConfig } from "../src/config.ts";

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

describe("ownPanes — freshness ignores a plugin's own panes", () => {
  const pane = (label: string | null) => ({ paneId: "w1:pX", tabId: "w1:t1", label });
  const fresh = (panes: { label: string | null }[], ignored: readonly string[] = DEFAULT_IGNORED_PANE_LABELS) => ownPanes(panes, ignored).length === 1;

  it("a shell pane + a plugin's Sidebar pane is still fresh", () => {
    expect(fresh([pane(null), pane("Sidebar")])).toBe(true);
  });
  it("a shell pane + an unlabeled extra pane (the user split one) is not fresh", () => {
    expect(fresh([pane(null), pane(null)])).toBe(false);
  });
  it("a shell pane + a user-labeled extra pane is not fresh", () => {
    expect(fresh([pane(null), pane("notes")])).toBe(false);
  });
  it("matches labels case-insensitively and trimmed", () => {
    expect(fresh([pane(null), pane(" sidebar ")])).toBe(true);
  });
  it("honours a host's own ignore list; an empty one ignores nothing", () => {
    expect(fresh([pane(null), pane("Files")], ["Files", "Sidebar"])).toBe(true);
    expect(fresh([pane(null), pane("Sidebar")], [])).toBe(false);
  });
  it("blank entries never swallow an unlabeled pane", () => {
    expect(fresh([pane(null), pane(null)], ["", "  "])).toBe(false);
  });
});

describe("resolveHookLayout — factory-owned vs manual worktree", () => {
  const layouts: LayoutConfig[] = [
    { id: "web", tabs: [{ panes: [{ persist: true, env: {}, setup: false }] }] },
    { id: "hot", tabs: [{ panes: [{ persist: true, env: {}, setup: false }] }] },
  ];
  const belt = (over: Partial<BeltConfig>): BeltConfig => ({ name: "b", beltType: "custom", source: "s", priority: 100, active: true, steps: [], watchPr: false, ...over });
  // Terse literals: only the fields resolveHookLayout/pruneLayoutToBelt read matter.
  const stepAt = (name: string, tab?: string, pane?: string): StepConfig => ({ name, type: name, tab, pane }) as StepConfig;
  const agentPane = (title: string): LayoutPane => ({ title, agent: { kind: "claude", args: [] }, persist: true, env: {}, setup: false });

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

  // #29: layouts are a shared library — a short belt reusing a long belt's layout must not come up
  // with tabs (and agents) for steps it never dispatches.
  describe("a factory-owned run only gets the tabs its belt uses", () => {
    // The four-tab ship layout of the issue: work / evidence (+ an SSR server pane) / review / pr.
    const ship: LayoutConfig = {
      id: "ship",
      tabs: [
        { title: "work", panes: [agentPane("agent")] },
        { title: "evidence", panes: [agentPane("agent"), { title: "server", command: "pnpm dev", persist: true, env: {}, setup: false }] },
        { title: "review", panes: [agentPane("agent")] },
        { title: "pr", panes: [agentPane("agent")] },
      ],
    };
    const quick = belt({ name: "quick", defaultLayout: "ship", steps: [stepAt("work", "work", "agent"), stepAt("pr", "pr", "agent")] });

    it("builds only the tabs a step targets, and names what it dropped", () => {
      const got = resolveHookLayout([quick], [ship], "quick", "feature/x");
      expect(got?.layout.tabs.map((t) => t.title)).toEqual(["work", "pr"]);
      expect(got?.prunedTabs).toEqual(["evidence", "review"]);
      expect(ship.tabs).toHaveLength(4); // the config's layout library is not mutated
    });

    it("a belt that uses every tab gets the layout untouched", () => {
      const full = belt({
        name: "ship",
        defaultLayout: "ship",
        steps: [stepAt("work", "work", "agent"), stepAt("evidence", "evidence", "agent"), stepAt("review", "review", "agent"), stepAt("pr", "pr", "agent")],
      });
      const got = resolveHookLayout([full], [ship], "ship", "feature/x");
      expect(got?.layout).toBe(ship);
      expect(got?.prunedTabs).toEqual([]);
    });

    it("a hand-created worktree (no owning run) still gets every tab", () => {
      const got = resolveHookLayout([quick], [ship], undefined, "feature/x");
      expect(got?.layout).toBe(ship);
      expect(got?.prunedTabs).toEqual([]);
    });

    it("keeps an untargeted tab that hosts the layout's setup pane", () => {
      const withSetup: LayoutConfig = {
        id: "ship",
        setup: { command: "pnpm install", blocking: true },
        tabs: [
          { title: "work", panes: [agentPane("agent")] },
          { title: "evidence", panes: [{ title: "server", command: "pnpm dev", persist: true, env: {}, setup: true }] },
          { title: "pr", panes: [agentPane("agent")] },
        ],
      };
      const got = resolveHookLayout([quick], [withSetup], "quick", "feature/x");
      expect(got?.layout.tabs.map((t) => t.title)).toEqual(["work", "evidence", "pr"]);
    });

    it("keeps an untargeted tab whose pane carries its own prompt", () => {
      const withPrompt: LayoutConfig = {
        id: "ship",
        tabs: [
          { title: "work", panes: [agentPane("agent")] },
          { title: "scratch", panes: [{ ...agentPane("agent"), agent: { kind: "claude", args: [], prompt: "watch the logs" } }] },
          { title: "pr", panes: [agentPane("agent")] },
        ],
      };
      const got = resolveHookLayout([quick], [withPrompt], "quick", "feature/x");
      expect(got?.layout.tabs.map((t) => t.title)).toEqual(["work", "scratch", "pr"]);
    });

    it("a belt whose steps target no pane at all leaves the layout whole (never an empty build)", () => {
      const dedicated = belt({ name: "quick", defaultLayout: "ship", steps: [stepAt("work"), stepAt("pr")] });
      expect(resolveHookLayout([dedicated], [ship], "quick", "feature/x")?.layout).toBe(ship);
    });

    it("tab titles that match nothing in the layout leave it whole (the step's layout wait reports it)", () => {
      const elsewhere = belt({ name: "quick", defaultLayout: "ship", steps: [stepAt("work", "dev", "agent")] });
      expect(resolveHookLayout([elsewhere], [ship], "quick", "feature/x")?.layout).toBe(ship);
    });
  });
});
