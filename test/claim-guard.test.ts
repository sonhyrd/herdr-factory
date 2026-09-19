import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { claimTicket } from "../src/core/reconcile.ts";
import { arbitrateClaim, claimMarker, claimWinner, releaseClaim, releaseMarker, type LedgerComment } from "../src/core/claim-guard.ts";
import { bearsHerdrMarker, type BeltRuntime, type Deps, type SourceRuntime, type WorkSource } from "../src/core/deps.ts";
import type { Config } from "../src/config.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/types.ts";

/** One tracker shared by every factory: an append-only comment stream with server-assigned ids. */
function fakeTracker() {
  let nextId = 100;
  const comments = new Map<string, LedgerComment[]>();
  const list = (key: string) => comments.get(key) ?? [];
  return {
    comments: list,
    post(key: string, body: string) {
      comments.set(key, [...list(key), { id: String(nextId++), body }]);
    },
    failPosts: false,
  };
}
type Tracker = ReturnType<typeof fakeTracker>;

/** A minimal factory: its OWN DB, a guarded source over the shared tracker, and a claim that throws
 *  past the guard stops at a throwing herdr stub. */
function factory(tracker: Tracker, host: string, opts: { guard?: boolean; sleep?: () => Promise<void> } = {}) {
  const store = new Store(openDb(":memory:"), () => 1000);
  const client: WorkSource = {
    spec: { statusOfRecord: "external", mappedStates: ["in_development"], replyChannel: "comments" },
    authStatus: async () => ({ state: "ok" }),
    listEligible: async () => [],
    describe: async (key) => ({ key, summary: "s", type: "Bug" }),
    transition: async () => ({ kind: "applied" }),
    materialize: async () => {},
    workDoc: async () => ({ path: "t", kind: "t" }),
    postNote: async () => {},
    askHuman: async () => ({ externalId: "q" }),
    pollHumanReply: async () => null,
    health: async () => {},
    postClaimComment: async (key, body) => {
      if (tracker.failPosts) throw new Error("tracker down");
      tracker.post(key, body);
    },
    listClaimComments: async (key) => tracker.comments(key),
  };
  const src: SourceRuntime = {
    name: "jira",
    type: "jira",
    client,
    pollIntervalSeconds: 60,
    maxActiveWorkspaces: 9,
    lastPolledAt: new Map(), lastEligible: new Map(),
    claimGuard: opts.guard === false ? undefined : { host, settleMs: 2000 },
  };
  const belt: BeltRuntime = { name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, steps: [], watchPr: true };
  const logs: string[] = [];
  const deps = {
    config: { repoName: "demo", repo: { path: "/m", baseRef: "origin/main" }, limits: { maxActiveWorkspaces: 9 }, agent: DEFAULT_AGENT_CONFIG } as unknown as Config,
    env: {},
    store,
    ghRepo: "o/n",
    // Past the guard the claim goes on to reconcileRun; these tests stop caring there.
    herdr: new Proxy({}, { get: () => async () => { throw new Error("stop after guard"); } }),
    sources: [src],
    resolveSource: () => src,
    belts: [belt],
    resolveBelt: () => belt,
    github: {},
    git: {},
    log: (_l: string, m: string) => logs.push(m),
    now: () => 1000,
    uid: () => "u",
    sleep: opts.sleep ?? (async () => {}),
    rmrf: async () => {},
  } as unknown as Deps;
  const newRun = (key: string) => store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: key, branch: `b-${key}` });
  return { deps, store, src, logs, newRun };
}

/** Claims that got past the guard (the `claimed` event is recorded right after it). */
const claimed = (store: Store) => store.eventsSince("demo", 0).filter((e) => e.type === "claimed").length;
const active = (store: Store, key: string) => store.activeRunForTicket("demo", "jira", key);

describe("claim ledger — claimWinner", () => {
  it("the lowest open claim comment id wins, whatever the post order", () => {
    const c = (id: string, body: string): LedgerComment => ({ id, body });
    const w = claimWinner([c("205", claimMarker({ runId: 1, host: "b" })), c("99", claimMarker({ runId: 7, host: "a" }))]);
    expect(w).toMatchObject({ runId: 7, host: "a", commentId: 99 }); // numeric, not lexical ("205" < "99")
  });

  it("a released claim no longer counts; the release matches on run id AND host", () => {
    const comments = [
      { id: "1", body: claimMarker({ runId: 3, host: "a" }) },
      { id: "2", body: claimMarker({ runId: 3, host: "b" }) }, // same run id, other DB
      { id: "3", body: releaseMarker({ runId: 3, host: "a" }) },
    ];
    expect(claimWinner(comments)).toMatchObject({ runId: 3, host: "b" });
    expect(claimWinner([...comments, { id: "4", body: releaseMarker({ runId: 3, host: "b" }) }])).toBeNull();
  });

  it("ignores quoted markers and unrelated comments", () => {
    const quoted = `> ${claimMarker({ runId: 1, host: "a" })}\nwho is on this?`;
    expect(claimWinner([{ id: "1", body: quoted }, { id: "2", body: "hello" }])).toBeNull();
  });

  it("claim and release comments are ignored by human-reply polling (INV-6)", () => {
    expect(bearsHerdrMarker(claimMarker({ runId: 1, host: "a" }))).toBe(true);
    expect(bearsHerdrMarker(releaseMarker({ runId: 1, host: "a" }))).toBe(true);
  });
});

describe("claim ledger — arbitrateClaim", () => {
  it("winner: posts its claim, keeps the run row", async () => {
    const t = fakeTracker();
    const f = factory(t, "mac");
    const run = f.newRun("K-1");
    expect(await arbitrateClaim(f.deps, f.src, run)).toBeNull();
    expect(f.store.getRun(run.id)).toBeTruthy();
    expect(t.comments("K-1").map((c) => c.body)).toEqual([claimMarker({ runId: run.id, host: "mac" })]);
  });

  it("loser of a race: releases its claim, deletes its run row", async () => {
    const t = fakeTracker();
    const a = factory(t, "a");
    const b = factory(t, "b");
    const ra = a.newRun("K-1");
    const rb = b.newRun("K-1");
    // Both see an empty ledger and post before either re-reads.
    const [wa, wb] = await Promise.all([arbitrateClaim(a.deps, a.src, ra), arbitrateClaim(b.deps, b.src, rb)]);
    expect(wa).toBeNull();
    expect(wb).toEqual(expect.objectContaining({ host: "a", runId: ra.id }));
    expect(b.store.getRun(rb.id)).toBeUndefined();
    expect(t.comments("K-1").map((c) => c.body)).toContain(releaseMarker({ runId: rb.id, host: "b" }));
  });

  it("an item already claimed elsewhere is skipped WITHOUT posting (a stale claim is never reaped)", async () => {
    const t = fakeTracker();
    t.post("K-1", claimMarker({ runId: 42, host: "dead-host" }));
    const f = factory(t, "mac");
    for (let i = 0; i < 3; i++) {
      const run = f.newRun("K-1");
      expect(await arbitrateClaim(f.deps, f.src, run)).toEqual({ runId: 42, host: "dead-host", commentId: 100 });
      expect(f.store.getRun(run.id)).toBeUndefined();
    }
    expect(t.comments("K-1")).toHaveLength(1); // no claim/release noise, and the dead claim stays open
  });

  it("our OWN stale claim (the run is gone locally) is released, and the item re-claimed", async () => {
    const t = fakeTracker();
    t.post("K-1", claimMarker({ runId: 7, host: "mac" })); // a crashed run of ours — no such row here
    const f = factory(t, "mac");
    const run = f.newRun("K-1");
    expect(await arbitrateClaim(f.deps, f.src, run)).toBeNull();
    expect(f.store.getRun(run.id)).toBeTruthy();
    expect(t.comments("K-1").map((c) => c.body)).toEqual([
      claimMarker({ runId: 7, host: "mac" }),
      releaseMarker({ runId: 7, host: "mac" }),
      claimMarker({ runId: run.id, host: "mac" }),
    ]);
    expect(f.logs.some((l) => l.includes("released our own stale claim (run 7"))).toBe(true);
  });

  it("our own claim for an ENDED run is stale too (a teardown whose release never landed)", async () => {
    const t = fakeTracker();
    const f = factory(t, "mac");
    const dead = f.newRun("K-1");
    f.store.endRun(dead.id, "merged");
    t.post("K-1", claimMarker({ runId: dead.id, host: "mac" }));
    const run = f.newRun("K-1");
    expect(await arbitrateClaim(f.deps, f.src, run)).toBeNull();
    expect(t.comments("K-1").map((c) => c.body)).toContain(releaseMarker({ runId: dead.id, host: "mac" }));
  });

  it("our own claim for a LIVE run still fences the item (only stale ones are released)", async () => {
    const t = fakeTracker();
    const f = factory(t, "mac");
    const live = f.newRun("K-1");
    t.post("K-1", claimMarker({ runId: live.id, host: "mac" }));
    const run = f.newRun("K-2"); // a second row; the ledger read is what matters
    expect(await arbitrateClaim(f.deps, f.src, { ...run, ticketKey: "K-1" })).toMatchObject({ runId: live.id, host: "mac" });
    expect(t.comments("K-1")).toHaveLength(1); // untouched
  });

  it("another host's stale claim is never released for it (fence, never reap)", async () => {
    const t = fakeTracker();
    t.post("K-1", claimMarker({ runId: 7, host: "other" }));
    const f = factory(t, "mac");
    expect(await arbitrateClaim(f.deps, f.src, f.newRun("K-1"))).toMatchObject({ host: "other" });
    expect(t.comments("K-1")).toHaveLength(1);
  });

  it("a human-posted release frees a stale claim", async () => {
    const t = fakeTracker();
    t.post("K-1", claimMarker({ runId: 42, host: "dead-host" }));
    t.post("K-1", releaseMarker({ runId: 42, host: "dead-host" }));
    const f = factory(t, "mac");
    expect(await arbitrateClaim(f.deps, f.src, f.newRun("K-1"))).toBeNull();
  });

  it("a backend failure deletes the row and throws (the next pass retries from scratch)", async () => {
    const t = fakeTracker();
    t.failPosts = true;
    const f = factory(t, "mac");
    const run = f.newRun("K-1");
    await expect(arbitrateClaim(f.deps, f.src, run)).rejects.toThrow("tracker down");
    expect(f.store.getRun(run.id)).toBeUndefined();
  });

  it("releaseClaim posts the release; disabled guard posts nothing", async () => {
    const t = fakeTracker();
    const f = factory(t, "mac");
    const run = f.newRun("K-1");
    await releaseClaim(f.deps, f.src, run);
    expect(t.comments("K-1").map((c) => c.body)).toEqual([releaseMarker({ runId: run.id, host: "mac" })]);
    const off = factory(t, "mac", { guard: false });
    const run2 = off.newRun("K-2");
    expect(await arbitrateClaim(off.deps, off.src, run2)).toBeNull();
    await releaseClaim(off.deps, off.src, run2);
    expect(t.comments("K-2")).toEqual([]);
  });
});

describe("claim ledger — claim path", () => {
  it("disabled = the old path: no tracker traffic, the claim proceeds to the worktree", async () => {
    const t = fakeTracker();
    const f = factory(t, "mac", { guard: false });
    await claimTicket(f.deps, "ship", "K-1").catch(() => {});
    expect(t.comments("K-1")).toEqual([]);
    expect(claimed(f.store)).toBe(1);
  });

  it("a loser never proceeds past the guard and records claimed_elsewhere once per winner", async () => {
    const t = fakeTracker();
    t.post("K-1", claimMarker({ runId: 42, host: "linux-1" }));
    const f = factory(t, "mac");
    await claimTicket(f.deps, "ship", "K-1");
    await claimTicket(f.deps, "ship", "K-1");
    expect(claimed(f.store)).toBe(0);
    expect(active(f.store, "K-1")).toBeUndefined();
    expect(f.logs.some((l) => l.includes("claimed elsewhere by linux-1"))).toBe(true);
    const events = f.store.eventsSince("demo", 0).filter((e) => e.type === "claimed_elsewhere");
    expect(events).toHaveLength(1);
  });

  it("race: two factories with separate DBs, one tracker — exactly one claim proceeds (50 iterations)", async () => {
    for (let i = 0; i < 50; i++) {
      const t = fakeTracker();
      // Interleave the settle window randomly so post/read orders vary run to run.
      const jitter = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 3)));
      const a = factory(t, "mac", { sleep: jitter });
      const b = factory(t, "linux", { sleep: jitter });
      await Promise.all([claimTicket(a.deps, "ship", "K-1").catch(() => {}), claimTicket(b.deps, "ship", "K-1").catch(() => {})]);
      const survivors = [active(a.store, "K-1"), active(b.store, "K-1")].filter(Boolean);
      expect(survivors).toHaveLength(1);
      expect(claimed(a.store) + claimed(b.store)).toBe(1); // exactly one got past the guard
    }
  });
});
