import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { isUniqueViolation, Store } from "../src/db/store.ts";

function makeStore(start = 1000) {
  let now = start;
  const db = openDb(":memory:");
  const store = new Store(db, () => now);
  return { store, db, setNow: (n: number) => { now = n; }, tick: (d: number) => { now += d; } };
}

describe("Store — guard_counters (generalized capped-guard storage)", () => {
  it("counts (run, step, guard) triples independently — two capped guards on one step never collide", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-GC" });
    // same run+step, two different guards → independent counters (the collision the old single
    // capture_attempts column could not represent).
    expect(store.bumpGuardCounter(run.id, "evidence", "capture_cap")).toBe(1);
    expect(store.bumpGuardCounter(run.id, "evidence", "capture_cap")).toBe(2);
    expect(store.bumpGuardCounter(run.id, "evidence", "other_cap")).toBe(1);
    expect(store.guardCounter(run.id, "evidence", "capture_cap")).toBe(2);
    expect(store.guardCounter(run.id, "evidence", "other_cap")).toBe(1);
    // reset is per-triple + a no-op when nothing is counted (the fixed resume leak).
    store.resetGuardCounter(run.id, "evidence", "capture_cap");
    expect(store.guardCounter(run.id, "evidence", "capture_cap")).toBe(0);
    expect(store.guardCounter(run.id, "evidence", "other_cap")).toBe(1); // untouched
    expect(() => store.resetGuardCounter(run.id, "review", "capture_cap")).not.toThrow(); // no counter → no-op
  });
});

describe("Store — belt admin (rename migration + delete purge)", () => {
  it("activeRunsForBelt counts only non-ended runs; reassignBelt moves active + ended", () => {
    const { store } = makeStore();
    const a = store.createRun({ repo: "r", workSource: "jira", belt: "old", ticketKey: "K-1" });
    const e = store.createRun({ repo: "r", workSource: "jira", belt: "old", ticketKey: "K-2" });
    store.endRun(e.id, "merged");
    expect(store.activeRunsForBelt("r", "old")).toHaveLength(1); // only the active one

    expect(store.reassignBelt("r", "old", "new")).toBe(2); // BOTH move (active + historical)
    expect(store.getRun(a.id)!.belt).toBe("new");
    expect(store.getRun(e.id)!.belt).toBe("new");
    expect(store.reassignBelt("r", "old", "new")).toBe(0); // idempotent
  });

  it("purgeBeltRuns deletes runs + child rows but KEEPS events (detached, run_id → NULL)", () => {
    const { store, db } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1" });
    store.upsertRunStep(run.id, "work", { paneId: "p" });
    store.bumpGuardCounter(run.id, "work", "bounce_cap");
    store.updateRun(run.id, { prNumber: 7 }); // creates a run_products row
    store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "in_development" });
    store.createHumanQuestion({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", question: "?" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-1", type: "claimed" });
    store.endRun(run.id, "merged");

    const purged = store.purgeBeltRuns("r", "ship");
    expect(purged).toBe(1);
    expect(store.getRun(run.id)).toBeUndefined();
    const childCount = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE run_id = ?`).get(run.id) as { n: number }).n;
    for (const t of ["run_steps", "run_products", "guard_counters", "human_questions", "intents", "watch_state"]) {
      expect(childCount(t)).toBe(0);
    }
    // events survive, detached from the deleted run
    const evs = db.prepare("SELECT run_id, type FROM events WHERE repo = ? AND ticket_key = ?").all("r", "K-1") as { run_id: number | null; type: string }[];
    expect(evs.map((e) => e.type)).toContain("claimed");
    expect(evs.every((e) => e.run_id === null)).toBe(true);
  });
});

describe("Store", () => {
  it("creates a run in claiming and counts it active", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1", summary: "s", issueType: "Bug", branch: "fix/K-1-s" });
    expect(run.phase).toBe("claiming");
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "jira", "K-1")?.id).toBe(run.id);
  });

  it("activeRunForWorktree: matches by checkout path, by the worktree's name, and by its CURRENT branch", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-WT", branch: "fix/K-WT-u1" });
    expect(store.getRun(run.id)!.worktreeName).toBe("fix/K-WT-u1"); // defaults to the claim-time branch
    store.updateRun(run.id, { worktreePath: "/wt/K-WT", branch: "fix/RWR-1-renamed" }); // the agent renamed it
    expect(store.activeRunForWorktree("r", { path: "/wt/K-WT" })?.id).toBe(run.id);
    expect(store.activeRunForWorktree("r", { branch: "fix/K-WT-u1" })?.id).toBe(run.id); // the name it was created under
    expect(store.activeRunForWorktree("r", { branch: "fix/RWR-1-renamed" })?.id).toBe(run.id); // where it is now
    expect(store.activeRunForWorktree("r", { branch: "someone/elses-branch" })).toBeUndefined();
    expect(store.activeRunForWorktree("other-repo", { path: "/wt/K-WT" })).toBeUndefined();
    store.endRun(run.id, "merged");
    expect(store.activeRunForWorktree("r", { path: "/wt/K-WT" })).toBeUndefined(); // ended runs own nothing
  });

  it("updates fields and bumps updated_at", () => {
    const { store, tick } = makeStore(1000);
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-2" });
    tick(5);
    store.updateRun(run.id, { phase: "running", step: "fix", prNumber: 42, workspaceId: "w1" });
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix");
    expect(got.prNumber).toBe(42);
    expect(got.workspaceId).toBe("w1");
    expect(got.updatedAt).toBe(1005);
  });

  it("run_steps: upsert inserts then patches, markStepDone, per-run listing", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-R" });
    expect(store.getRunStep(run.id, "fix")).toBeUndefined();

    // first upsert inserts the row + applies the patch
    const fix = store.upsertRunStep(run.id, "fix", { paneId: "w1:p1" });
    expect(fix.step).toBe("fix");
    expect(fix.paneId).toBe("w1:p1");
    expect(fix.done).toBe(false);
    expect(fix.startedAt).not.toBeNull();

    // subsequent upserts patch in place (no duplicate row)
    store.upsertRunStep(run.id, "fix", { sessionId: "sess-1", dispatchedAt: 1234 });
    const got = store.getRunStep(run.id, "fix")!;
    expect(got.paneId).toBe("w1:p1"); // preserved
    expect(got.sessionId).toBe("sess-1");
    expect(got.dispatchedAt).toBe(1234);

    store.markStepDone(run.id, "fix");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(true);
    expect(store.getRunStep(run.id, "fix")!.doneAt).not.toBeNull();

    store.upsertRunStep(run.id, "review", { paneId: "w1:p2" });
    expect(store.runStepsFor(run.id).map((s) => s.step)).toEqual(["fix", "review"]);
  });

  it("countOccupying: parks and idle PR-watches hold no slot; a reviewing run counts only while resolving", () => {
    const { store } = makeStore();
    const mk = (key: string, phase: string, extra: Record<string, unknown> = {}) => {
      const r = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: key });
      store.updateRun(r.id, { phase: phase as never, ...extra });
      return r;
    };
    mk("W-run", "running", { step: "fix" }); // actively worked → occupies
    mk("W-park", "attention"); // parked → no slot
    mk("W-human", "waiting_for_human"); // parked → no slot
    const rev = mk("W-rev", "reviewing", { prNumber: 1, resolverActive: false }); // idle watch → no slot
    expect(store.countActive("r")).toBe(4);
    expect(store.countOccupying("r")).toBe(1); // only the running one

    // The resolver starts working → the reviewing run now occupies a slot.
    store.updateRun(rev.id, { resolverActive: true });
    expect(store.countOccupying("r")).toBe(2);

    // It finishes and goes idle again → slot released, PR still watched.
    store.updateRun(rev.id, { resolverActive: false });
    expect(store.countOccupying("r")).toBe(1);
  });

  it("ends a run -> not active, has outcome + ended_at", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-3" });
    store.endRun(run.id, "merged");
    expect(store.countActive("r")).toBe(0);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(got.endedAt).not.toBeNull();
  });

  it("supports multiple attempts per ticket and keeps history", () => {
    const { store, db } = makeStore();
    const a = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-4" });
    store.endRun(a.id, "closed");
    const b = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-4" }); // re-claim after a failed attempt
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "jira", "K-4")?.id).toBe(b.id);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE ticket_key = 'K-4'").get() as { n: number };
    expect(n).toBe(2);
  });

  it("records events with JSON detail", () => {
    const { store, db } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-5" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-5", type: "claimed" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-5", type: "pr_opened", detail: { number: 7 } });
    const evs = db.prepare("SELECT type, detail FROM events WHERE run_id = ? ORDER BY id").all(run.id) as {
      type: string;
      detail: string | null;
    }[];
    expect(evs.map((e) => e.type)).toEqual(["claimed", "pr_opened"]);
    expect(JSON.parse(evs[1]!.detail!)).toEqual({ number: 7 });
  });

  it("scopes activeRunForTicket by source — same key in two sources is two runs", () => {
    const { store } = makeStore();
    const j = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "DUP-1", branch: "fix/DUP-1" });
    const m = store.createRun({ repo: "r", workSource: "local_markdown", belt: "gen", ticketKey: "DUP-1", branch: "feature/DUP-1" });
    expect(store.countActive("r")).toBe(2);
    expect(store.activeRunForTicket("r", "jira", "DUP-1")?.id).toBe(j.id);
    expect(store.activeRunForTicket("r", "local_markdown", "DUP-1")?.id).toBe(m.id);
    // The key-only lookup (for the manual CLI) returns BOTH — the caller errors on ambiguity.
    expect(store.activeRunsForKey("r", "DUP-1").map((x) => x.workSource).sort()).toEqual(["jira", "local_markdown"]);
  });

  it("records the work_source + belt on each run, and the active step", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "local_markdown", belt: "gen", ticketKey: "M-1" });
    expect(store.getRun(run.id)!.workSource).toBe("local_markdown");
    expect(store.getRun(run.id)!.belt).toBe("gen");
    expect(store.getRun(run.id)!.step).toBeNull();
    store.updateRun(run.id, { phase: "running", step: "research" });
    expect(store.getRun(run.id)!.step).toBe("research");
  });

  it("work_items accepts the custom-belt terminal state 'done' (migration v7)", () => {
    const { store } = makeStore();
    expect(store.setWorkItemStatus("r", "lm", "idea-1", "done")).toBe(true);
    expect(store.getWorkItem("r", "lm", "idea-1")!.status).toBe("done");
    // a 'done' item is terminal — listing by 'todo' must not surface it
    expect(store.listWorkItems("r", "lm", "todo").map((x) => x.key)).not.toContain("idea-1");
  });

  it("work_items: upsert status is idempotent, tolerant of any→any, and merges metadata", () => {
    const { store, setNow } = makeStore(1000);
    expect(store.getWorkItem("r", "lm", "task-a")).toBeUndefined();

    // first set inserts (todo), reports a change
    expect(store.setWorkItemStatus("r", "lm", "task-a", "todo", { title: "Task A", path: "/f/task-a.md" })).toBe(true);
    let wi = store.getWorkItem("r", "lm", "task-a")!;
    expect(wi.status).toBe("todo");
    expect(wi.title).toBe("Task A");

    // same status again → no change (false), but metadata still refreshes
    expect(store.setWorkItemStatus("r", "lm", "task-a", "todo", { itemType: "task" })).toBe(false);
    expect(store.getWorkItem("r", "lm", "task-a")!.itemType).toBe("task");
    expect(store.getWorkItem("r", "lm", "task-a")!.title).toBe("Task A"); // preserved

    // non-adjacent jump (in_development → merged) is allowed, never throws
    store.setWorkItemStatus("r", "lm", "task-a", "in_development");
    setNow(1100);
    expect(store.setWorkItemStatus("r", "lm", "task-a", "merged")).toBe(true);
    wi = store.getWorkItem("r", "lm", "task-a")!;
    expect(wi.status).toBe("merged");
    expect(wi.path).toBe("/f/task-a.md"); // metadata preserved across status changes

    // listing filters by status + source
    store.setWorkItemStatus("r", "lm", "task-b", "todo");
    expect(store.listWorkItems("r", "lm", "todo").map((x) => x.key)).toEqual(["task-b"]);
    expect(store.listWorkItems("r", "lm").length).toBe(2);
  });

  it("migration v6 backfills pre-existing runs to 'jira' and adds work_items (idempotent)", () => {
    const db = new DatabaseSync(":memory:");
    // Simulate a pre-v6 DB: schema_version=5, a runs table WITHOUT work_source, one in-flight row.
    // Include watch_deadline + pr_number + last_thread_sig + outcome (all part of the v1 CREATE
    // TABLE) so v17's and v18's DROP COLUMNs and v25's duplicate-active sweep apply cleanly
    // (resolver_active is ADDED by v17, then dropped by v18); seed run_steps (created back in v4)
    // so v9's ALTER applies, `branch` (v1) so v38's worktree_name backfill applies, `repos` (v1) so v40's ALTER applies, and events
    // (created in v1) so v28's attention backfill applies — a genuine v5 DB always has all of them.
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (5);
      CREATE TABLE repos (name TEXT PRIMARY KEY, repo_path TEXT, base_ref TEXT, github TEXT,
        last_tick_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, ticket_key TEXT, phase TEXT,
        pr_number INTEGER, last_thread_sig TEXT, outcome TEXT,
        branch TEXT, watch_deadline INTEGER, created_at INTEGER, updated_at INTEGER, ended_at INTEGER);
      INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at)
        VALUES ('r','OLD-1','attention',1,1), ('r','OLD-2','fixing',1,1);
      CREATE TABLE run_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, step TEXT NOT NULL,
        pane_id TEXT, session_id TEXT, progress_sig TEXT, progress_at INTEGER,
        done INTEGER NOT NULL DEFAULT 0, started_at INTEGER, done_at INTEGER);
      INSERT INTO run_steps (run_id, step, progress_sig, progress_at) VALUES (1, 'review', 'sha-ro', 42);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, repo TEXT, ticket_key TEXT,
        ts INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT);
      INSERT INTO events (run_id, repo, ticket_key, ts, type, detail)
        VALUES (1, 'r', 'OLD-1', 5, 'attention', '{"reason":"step_budget"}'),
               (1, 'r', 'OLD-1', 9, 'attention', '{"reason":"pr_closed"}'),
               (1, 'r', 'OLD-1', 12, 'attention', 'not json — must not brick the migration'),
               (2, 'r', 'OLD-2', 7, 'attention', '{"reason":"bounce_limit"}');
    `);
    migrate(db);
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(6);
    const row = db.prepare("SELECT work_source, attention_reason_code FROM runs WHERE ticket_key = 'OLD-1'").get() as { work_source: string; attention_reason_code: string };
    expect(row.work_source).toBe("jira"); // backfilled in the same migration
    expect(row.attention_reason_code).toBe("pr_closed"); // v28: LATEST valid attention reason wins; garbage skipped
    // v28's attention backfill is SCOPED to currently-PARKED runs: a healthy run's historical park
    // must stay NULL, or the stale code would shadow a fresher old-code park during the drain
    // window (the runtime read falls back to the events log only when the column is NULL).
    const healthy = db.prepare("SELECT attention_reason_code AS c FROM runs WHERE ticket_key = 'OLD-2'").get() as { c: string | null };
    expect(healthy.c).toBeNull();
    // The step-clock chain end to end for an ancient DB: v28 de-aliases the read-only baseline out
    // of the heartbeat columns, v34 lifts both onto watch_state, v35 drops the columns. What the
    // step was mid-flight with must arrive intact on the far side of all three.
    const ws = db.prepare("SELECT watch, sig, based_at FROM watch_state WHERE run_id = 1 ORDER BY watch").all() as Record<string, unknown>[];
    expect(ws).toEqual([
      { watch: "heartbeat", sig: "sha-ro", based_at: 42 },
      { watch: "read_only", sig: "sha-ro", based_at: 42 },
    ]);
    const stepCols = (db.prepare("PRAGMA table_info(run_steps)").all() as { name: string }[]).map((c) => c.name);
    expect(stepCols).not.toContain("progress_sig");
    expect(stepCols).not.toContain("baseline_sig");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'").get()).toBeTruthy();
    expect(() => migrate(db)).not.toThrow(); // re-running is a no-op
  });

  it("run_products backs prNumber/resolverActive/lastThreadSig + gates reviewing occupancy (v18)", () => {
    const { store } = makeStore(1000);
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "b", ticketKey: "K-1" });
    // A fresh run has no pull_request row → the LEFT JOIN yields null/idle.
    expect(store.getRun(run.id)!.prNumber).toBeNull();
    expect(store.getRun(run.id)!.resolverActive).toBe(false);
    // Adopting a PR + recording a thread signature routes into run_products (not the runs table).
    store.updateRun(run.id, { prNumber: 42, lastThreadSig: "sig-1" });
    const r = store.getRun(run.id)!;
    expect(r.prNumber).toBe(42);
    expect(r.lastThreadSig).toBe("sig-1");
    expect(r.resolverActive).toBe(false); // partial upsert left active untouched
    // A reviewing run with an idle resolver holds NO slot; an active resolver holds one.
    store.updateRun(run.id, { phase: "reviewing", resolverActive: false });
    expect(store.countOccupying("r")).toBe(0);
    store.updateRun(run.id, { resolverActive: true });
    expect(store.getRun(run.id)!.resolverActive).toBe(true);
    expect(store.countOccupying("r")).toBe(1);
  });

  it("TTL lock: acquire, block, steal after expiry, release", () => {
    const { store, setNow } = makeStore(1000);
    expect(store.acquireLock("capture", "A", 100)).toBe(true); // held until 1100
    expect(store.acquireLock("capture", "B", 100)).toBe(false); // blocked
    setNow(1101); // A expired
    expect(store.acquireLock("capture", "B", 100)).toBe(true); // steal
    store.releaseLock("capture", "A"); // wrong owner -> no-op
    expect(store.acquireLock("capture", "C", 100)).toBe(false); // B still holds
    store.releaseLock("capture", "B");
    expect(store.acquireLock("capture", "C", 100)).toBe(true);
  });

  describe("source OAuth tokens (source_auth)", () => {
    it("save / get / clear round-trips; upsert rotates tokens but keeps created_at; scoped by (repo, source)", () => {
      const { store, setNow } = makeStore(1000);
      expect(store.getSourceAuth("r", "jira")).toBeUndefined();
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a1", refreshToken: "r1", expiresAt: 5000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "read:jira-work offline_access" });
      const t1 = store.getSourceAuth("r", "jira")!;
      expect([t1.accessToken, t1.refreshToken, t1.cloudId, t1.method]).toEqual(["a1", "r1", "c1", "oauth"]);
      expect(t1.createdAt).toBe(1000);

      setNow(2000);
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a2", refreshToken: "r2", expiresAt: 9000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "read:jira-work offline_access" });
      const t2 = store.getSourceAuth("r", "jira")!;
      expect([t2.accessToken, t2.refreshToken, t2.expiresAt]).toEqual(["a2", "r2", 9000]);
      expect(t2.createdAt).toBe(1000); // preserved
      expect(t2.updatedAt).toBe(2000);

      expect(store.getSourceAuth("r", "other")).toBeUndefined(); // scoped by source
      expect(store.getSourceAuth("other-repo", "jira")).toBeUndefined(); // and by repo
      expect(store.clearSourceAuth("r", "jira")).toBe(true);
      expect(store.getSourceAuth("r", "jira")).toBeUndefined();
      expect(store.clearSourceAuth("r", "jira")).toBe(false); // already gone
    });

    it("setSourceAuthAccount records the whoami label + it survives a token refresh (upsert)", () => {
      const { store, setNow } = makeStore(1000);
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a1", refreshToken: "r1", expiresAt: 5000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "s" });
      expect(store.getSourceAuth("r", "jira")!.accountLabel).toBeNull(); // not set at first save

      store.setSourceAuthAccount("r", "jira", "Raza Jamil <raza@x.com>");
      expect(store.getSourceAuth("r", "jira")!.accountLabel).toBe("Raza Jamil <raza@x.com>");

      // A later token refresh (saveSourceAuth upsert) rotates the token but must NOT wipe the account.
      setNow(2000);
      store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "a2", refreshToken: "r2", expiresAt: 9000, cloudId: "c1", cloudUrl: "https://x.atlassian.net", scopes: "s" });
      const t = store.getSourceAuth("r", "jira")!;
      expect([t.accessToken, t.accountLabel]).toEqual(["a2", "Raza Jamil <raza@x.com>"]);
    });
  });

  describe("transition outbox — auth recovery", () => {
    it("retryTransitionsForSource makes a source's undelivered write-backs due now (only that source, only undelivered)", () => {
      const { store } = makeStore();
      const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1", branch: "b" });
      const other = store.createRun({ repo: "r", workSource: "gh", belt: "ship2", ticketKey: "G-1", branch: "b2" });
      const held = store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "in_review" });
      const otherSrc = store.enqueueTransition({ runId: other.id, repo: "r", workSource: "gh", ticketKey: "G-1", toState: "in_review" });
      // Back the jira intent off (as an auth failure would), so it's no longer due.
      store.recordTransitionAttempt(held.id, "401 not authenticated");
      expect(store.getTransitionIntent(held.id)!.nextAttemptAt).toBe(1030);
      expect(store.dueTransitions("r").map((i) => i.id)).not.toContain(held.id);

      const requeued = store.retryTransitionsForSource("r", "jira");
      expect(requeued).toBe(1); // only the jira intent, and it was undelivered
      expect(store.getTransitionIntent(held.id)!.nextAttemptAt).toBe(1000); // due now
      expect(store.dueTransitions("r").map((i) => i.id)).toContain(held.id);
      // A different source's intent is untouched by a jira recovery.
      expect(store.getTransitionIntent(otherSrc.id)!.nextAttemptAt).toBe(1000);

      // A delivered intent is never resurrected.
      store.markTransitionDelivered(held.id);
      expect(store.retryTransitionsForSource("r", "jira")).toBe(0);
    });
  });

  describe("transition outbox — belt-effect custom status (to_status)", () => {
    it("a canonical transition and a custom status at the same anchor are DISTINCT intents", () => {
      const { store } = makeStore();
      const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1", branch: "b" });
      const qa = store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "in_review", toStatus: "qa" });
      const review = store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "in_review" });
      // Same anchor (in_review), different to_status → two rows, not an overwrite (old UNIQUE(run,to_state) would collide).
      expect(qa.id).not.toBe(review.id);
      expect(qa.toStatus).toBe("qa");
      expect(review.toStatus).toBe("");
      const targets = store.transitionTargetsForRun(run.id);
      expect(targets).toEqual(expect.arrayContaining([
        { toState: "in_review", toStatus: "qa" },
        { toState: "in_review", toStatus: "" },
      ]));
    });

    it("re-enqueueing the same (run, to_state, to_status) re-opens the SAME intent (idempotent)", () => {
      const { store, tick } = makeStore();
      const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1", branch: "b" });
      const first = store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "in_review", toStatus: "qa" });
      store.markTransitionDelivered(first.id);
      tick(5);
      const again = store.enqueueTransition({ runId: run.id, repo: "r", workSource: "jira", ticketKey: "K-1", toState: "in_review", toStatus: "qa" });
      expect(again.id).toBe(first.id); // same row
      expect(again.deliveredAt).toBeNull(); // re-opened for delivery
    });
  });
});

describe("Store — uniqueness guarantees (v25)", () => {
  it("rejects a second ACTIVE run for the same (repo, source, key); ending the first frees the slot", () => {
    const { store } = makeStore();
    const first = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-U1" });
    // The concurrent-claim loser: same item while the first run is still active.
    expect(() => store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-U1" }))
      .toThrow(/UNIQUE constraint failed/);
    expect(store.countActive("r")).toBe(1);
    // History is not uniqueness: once the first run ends, a re-claim gets a fresh run.
    store.endRun(first.id, "merged");
    const again = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-U1" });
    expect(again.id).not.toBe(first.id);
    expect(store.countActive("r")).toBe(1);
  });

  it("the same key stays claimable in two different sources (dedup is source-scoped)", () => {
    const { store } = makeStore();
    store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-U2" });
    expect(() => store.createRun({ repo: "r", workSource: "lm", belt: "lmship", ticketKey: "K-U2" })).not.toThrow();
    expect(store.activeRunsForKey("r", "K-U2")).toHaveLength(2);
  });

  it("isUniqueViolation matches the node:sqlite constraint error and nothing else", () => {
    const { store } = makeStore();
    store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-U3" });
    try {
      store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-U3" });
      expect.unreachable("duplicate active run must throw");
    } catch (e) {
      expect(isUniqueViolation(e)).toBe(true);
    }
    expect(isUniqueViolation(new Error("some other failure"))).toBe(false);
    expect(isUniqueViolation("not an error")).toBe(false);
  });

  it("run_steps holds exactly one row per (run, step): upsert never duplicates, a raw racer's insert loses", () => {
    const { store, db } = makeStore();
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-U4" });
    store.upsertRunStep(run.id, "fix", { paneId: "p1" });
    store.upsertRunStep(run.id, "fix", { done: true }); // patch, not a second insert
    const rows = db.prepare("SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND step = 'fix'").get(run.id) as { n: number };
    expect(rows.n).toBe(1);
    // A racer that skipped the upsert (the old unlocked read-then-insert shape) is rejected by the index.
    expect(() => db.prepare("INSERT INTO run_steps (run_id, step, started_at) VALUES (?, 'fix', 1)").run(run.id))
      .toThrow(/UNIQUE constraint failed/);
  });
});

describe("Store — eventsSince / maxEventId (the foreground `run` feed)", () => {
  it("streams repo events created after a cursor, oldest-first, and spans runs + admin events", () => {
    const { store } = makeStore();
    const a = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1" });
    const b = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-2" });
    store.recordEvent({ runId: a.id, repo: "r", ticketKey: "K-1", type: "claimed", detail: { belt: "ship", source: "jira" } });
    const cursor = store.maxEventId("r"); // a follower seeds here — everything below is "new"
    store.recordEvent({ runId: a.id, repo: "r", ticketKey: "K-1", type: "step_spawned", detail: { step: "work" } });
    store.recordEvent({ runId: b.id, repo: "r", ticketKey: "K-2", type: "step_done", detail: { step: "work" } });
    store.recordEvent({ repo: "r", type: "belt_deleted", detail: { belt: "old" } }); // run-id-less admin event

    const fresh = store.eventsSince("r", cursor);
    expect(fresh.map((e) => e.type)).toEqual(["step_spawned", "step_done", "belt_deleted"]);
    expect(fresh.map((e) => e.ticketKey)).toEqual(["K-1", "K-2", null]);
    expect(fresh.every((e) => e.id > cursor)).toBe(true); // strictly after the cursor
    expect(fresh[0]!.detail).toContain('"step":"work"'); // raw JSON string, parsed by the formatter

    // Advancing the cursor to the last id drains the feed to empty (no re-delivery).
    expect(store.eventsSince("r", fresh.at(-1)!.id)).toHaveLength(0);
  });

  it("is repo-scoped and returns 0 for a repo with no events", () => {
    const { store } = makeStore();
    expect(store.maxEventId("empty")).toBe(0);
    const run = store.createRun({ repo: "r", workSource: "jira", belt: "ship", ticketKey: "K-1" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-1", type: "claimed" });
    expect(store.maxEventId("other")).toBe(0); // a different repo's events are invisible
    expect(store.eventsSince("other", 0)).toHaveLength(0);
    expect(store.eventsSince("r", 0)).toHaveLength(1);
  });
});

describe("Store — the problem ledger (v37): report / clear / list", () => {
  it("report upserts on (repo, key) keeping created_at; clear deletes and reports whether anything was open", () => {
    const { store, tick } = makeStore();
    store.reportProblem("r", "source:jira", "auth", "jira: token rejected");
    tick(60);
    // A re-report refreshes detail + updated_at but keeps the first-observed time.
    store.reportProblem("r", "source:jira", "auth", "jira: still rejected");
    const [p] = store.listProblems("r");
    expect(p).toMatchObject({ key: "source:jira", kind: "auth", detail: "jira: still rejected", createdAt: 1000, updatedAt: 1060 });
    expect(store.listProblems("r").length).toBe(1); // upsert, not a second row
    // Repo-scoped: another repo's ledger is untouched.
    expect(store.listProblems("other")).toEqual([]);
    expect(store.clearProblem("r", "source:jira")).toBe(true);
    expect(store.clearProblem("r", "source:jira")).toBe(false); // already clear — idempotent
    expect(store.listProblems("r")).toEqual([]);
  });

  it("lists oldest-first — the dashboard shows the longest-standing problem first", () => {
    const { store, tick } = makeStore();
    store.reportProblem("r", "publisher:s3", "auth", "sso expired");
    tick(10);
    store.reportProblem("r", "source:jira", "auth", "token missing");
    expect(store.listProblems("r").map((p) => p.key)).toEqual(["publisher:s3", "source:jira"]);
  });
});

describe("Store — workingWorktreePaths (doctor's orphaned-dev-server check)", () => {
  it("omits parked and ended runs — a listener in their worktree is an orphan (#98)", () => {
    const { store } = makeStore();
    const wt = (key: string, phase: "running" | "attention" | "waiting_for_human" | "reviewing") => {
      const r = store.createRun({ repo: "r", workSource: "jira", belt: "b", ticketKey: key });
      store.updateRun(r.id, { phase, worktreePath: `/wt/${key}` });
      return r;
    };
    wt("K-RUN", "running");
    wt("K-REV", "reviewing");
    wt("K-ATT", "attention");
    wt("K-HUM", "waiting_for_human");
    store.endRun(wt("K-END", "running").id, "merged");
    expect(store.workingWorktreePaths().sort()).toEqual(["/wt/K-REV", "/wt/K-RUN"]);
  });
});
