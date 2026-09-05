import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import type { Deps } from "../src/core/deps.ts";
import {
  BeltHasActiveRunsError,
  applyBeltChanges,
  deleteBeltData,
  diffBelts,
  renameBeltRuns,
} from "../src/core/belt-admin.ts";

/** A minimal Deps over a real :memory: store — real store behavior, stubbed herdr/git/fs so the
 *  worktree-cleanup path is observable without herdr. Only the fields belt-admin touches are set. */
function makeDeps(repo = "r") {
  const db = openDb(":memory:");
  const store = new Store(db, () => 1000);
  const eventsForKey = (r: string, key: string) =>
    (db.prepare("SELECT type FROM events WHERE repo = ? AND ticket_key = ?").all(r, key) as { type: string }[]).map((e) => e.type);
  const eventTypes = () => (db.prepare("SELECT type FROM events").all() as { type: string }[]).map((e) => e.type);
  const calls = { worktreeRemove: [] as string[], workspaceClose: [] as string[], rmrf: [] as string[], branchDelete: [] as string[] };
  const deps = {
    config: { repoName: repo, repo: { path: "/main/checkout" } },
    store,
    herdr: {
      worktreeRemove: async (id: string) => { calls.worktreeRemove.push(id); },
      workspaceExists: async () => false,
      workspaceClose: async (id: string) => { calls.workspaceClose.push(id); },
    },
    git: {
      worktreePrune: async () => {},
      // The leaked worktree is already gone by the time a belt is deleted, so HEAD reads as
      // unresolvable — cleanup then falls back to the run's recorded names.
      currentBranch: async () => null,
      branchDelete: async (_cwd: string, branch: string) => { calls.branchDelete.push(branch); return true; },
    },
    rmrf: async (p: string) => { calls.rmrf.push(p); },
    log: () => {},
    now: () => 1000,
  } as unknown as Deps;
  return { deps, store, calls, eventsForKey, eventTypes };
}

/** Create a run and drive it to ended (so it counts as historical, not in-flight). */
function endedRun(store: Store, repo: string, belt: string, key: string, opts: { workspaceId?: string; worktreePath?: string; branch?: string } = {}) {
  const run = store.createRun({ repo, workSource: "jira", belt, ticketKey: key, branch: opts.branch ?? null });
  if (opts.workspaceId || opts.worktreePath) store.updateRun(run.id, { workspaceId: opts.workspaceId ?? null, worktreePath: opts.worktreePath ?? null });
  store.endRun(run.id, "merged");
  return store.getRun(run.id)!;
}

describe("belt-admin — rename migration", () => {
  it("migrates ALL runs (active + historical) from the old belt name to the new one", () => {
    const { deps, store, eventTypes } = makeDeps();
    const active = store.createRun({ repo: "r", workSource: "jira", belt: "old", ticketKey: "K-1" });
    endedRun(store, "r", "old", "K-2");
    endedRun(store, "r", "other", "K-3"); // a different belt — must NOT move
    store.createRun({ repo: "r", workSource: "jira", belt: "other", ticketKey: "K-4" });

    const { runsMoved } = renameBeltRuns(deps, "old", "new");
    expect(runsMoved).toBe(2);
    expect(store.getRun(active.id)!.belt).toBe("new");
    expect(store.activeRunsForBelt("r", "old")).toHaveLength(0);
    expect(store.activeRunsForBelt("r", "new")).toHaveLength(1);
    // the untouched belt keeps its runs
    expect(store.activeRunsForBelt("r", "other")).toHaveLength(1);
    // audit event recorded
    expect(eventTypes()).toContain("belt_reassigned");
  });

  it("is idempotent — a second rename of an already-migrated belt moves nothing", () => {
    const { deps, store } = makeDeps();
    store.createRun({ repo: "r", workSource: "jira", belt: "old", ticketKey: "K-1" });
    expect(renameBeltRuns(deps, "old", "new").runsMoved).toBe(1);
    expect(renameBeltRuns(deps, "old", "new").runsMoved).toBe(0);
  });
});

describe("belt-admin — delete guard", () => {
  it("throws BeltHasActiveRunsError when the belt has an in-flight run (any non-ended, incl. parked)", async () => {
    const { deps, store } = makeDeps();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1" });
    store.updateRun(run.id, { phase: "attention" }); // parked still counts as in progress
    await expect(deleteBeltData(deps, "ship")).rejects.toBeInstanceOf(BeltHasActiveRunsError);
    // nothing purged
    expect(store.getRun(run.id)).toBeDefined();
  });

  it("purges an idle belt's run rows + child rows, KEEPS events (detached), cleans a leaked worktree", async () => {
    const { deps, store, calls, eventsForKey } = makeDeps();
    const run = endedRun(store, "r", "ship", "K-1", { workspaceId: "w1", worktreePath: "/wt/K-1", branch: "fix/K-1" });
    // give the run some child rows + events
    store.upsertRunStep(run.id, "work", { paneId: "w1:p1" });
    store.bumpGuardCounter(run.id, "work", "bounce_cap");
    store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "merged" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-1", type: "merged", detail: { x: 1 } });

    const res = await deleteBeltData(deps, "ship");
    expect(res.runsPurged).toBe(1);
    expect(res.worktreesCleaned).toBe(1);
    // run + child rows gone
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.getRunStep(run.id, "work")).toBeUndefined();
    expect(store.guardCounter(run.id, "work", "bounce_cap")).toBe(0);
    // events KEPT (detached from the run) — the timeline audit survives the purge
    expect(eventsForKey("r", "K-1")).toContain("merged");
    // §9 cleanup sequence ran on the leaked worktree
    expect(calls.worktreeRemove).toContain("w1");
    expect(calls.branchDelete).toContain("fix/K-1");
    expect(calls.rmrf).toContain("/wt/K-1");
  });

  it("is idempotent — deleting an already-purged belt is a clean no-op", async () => {
    const { deps, store } = makeDeps();
    endedRun(store, "r", "ship", "K-1");
    await deleteBeltData(deps, "ship");
    const res = await deleteBeltData(deps, "ship");
    expect(res).toEqual({ runsPurged: 0, worktreesCleaned: 0 });
  });
});

describe("belt-admin — applyBeltChanges (guard-first, all-or-nothing)", () => {
  it("a single busy delete aborts the WHOLE change — no rename migrates", async () => {
    const { deps, store } = makeDeps();
    const renamed = store.createRun({ repo: "r", workSource: "jira", belt: "old", ticketKey: "K-1" });
    store.createRun({ repo: "r", workSource: "jira", belt: "busy", ticketKey: "K-2" }); // in-flight → blocks

    const res = await applyBeltChanges(deps, { renames: [{ from: "old", to: "new" }], deletes: ["busy"] });
    expect(res.blocked).toEqual([{ belt: "busy", activeRuns: 1 }]);
    expect(res.runsMoved).toBe(0);
    // the rename did NOT apply (would have orphaned the run the caller is about to revert)
    expect(store.getRun(renamed.id)!.belt).toBe("old");
  });

  it("applies renames + deletes when every delete is clear", async () => {
    const { deps, store } = makeDeps();
    store.createRun({ repo: "r", workSource: "jira", belt: "old", ticketKey: "K-1" });
    endedRun(store, "r", "gone", "K-2");

    const res = await applyBeltChanges(deps, { renames: [{ from: "old", to: "new" }], deletes: ["gone"] });
    expect(res.blocked).toHaveLength(0);
    expect(res.runsMoved).toBe(1);
    expect(res.runsPurged).toBe(1);
    expect(store.activeRunsForBelt("r", "new")).toHaveLength(1);
  });
});

describe("belt-admin — diffBelts (rename inference)", () => {
  const belt = (name: string, extra: Record<string, unknown> = {}) => ({ name, source: "jira", steps: [{ type: "work" }], ...extra });

  it("infers a rename when exactly one belt is gone and one is added with an identical body", () => {
    const d = diffBelts([belt("a"), belt("b")], [belt("a"), belt("b2")]);
    expect(d.renames).toEqual([{ from: "b", to: "b2" }]);
    expect(d.deletes).toEqual([]);
  });

  it("treats a rename tangled with an edit as delete + add (safe — the guard then catches busy ones)", () => {
    const d = diffBelts([belt("b")], [belt("b2", { priority: 5 })]);
    expect(d.renames).toEqual([]);
    expect(d.deletes).toEqual(["b"]);
    expect(d.adds).toEqual(["b2"]);
  });

  it("a pure delete is a delete (no phantom rename)", () => {
    const d = diffBelts([belt("a"), belt("b")], [belt("a")]);
    expect(d.renames).toEqual([]);
    expect(d.deletes).toEqual(["b"]);
  });

  it("no structural change → nothing", () => {
    const d = diffBelts([belt("a")], [belt("a")]);
    expect(d).toEqual({ renames: [], deletes: [], adds: [] });
  });
});
