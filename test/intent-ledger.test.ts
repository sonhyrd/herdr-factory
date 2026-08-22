import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { flushOutbox } from "../src/core/outbox.ts";
import { consumeIntentHandoffs, ledgerFlow } from "../src/core/ledger.ts";
import type { IntentKindDef, IntentOutcome } from "../src/intents/registry.ts";
import { intentKindFor } from "../src/intents/registry.ts";
import type { Deps } from "../src/core/deps.ts";
import type { Run } from "../src/types.ts";

// The intent-ledger contract suite — the analog of the work-source/step-descriptor contract
// suites: what "is a ledger kind" means behaviorally (idempotent enqueue, FIFO blocking, backoff
// on the kind's curve, exactly-once handoff consume), pinned against fake kinds so the kernel's
// mechanics are tested apart from any shipped kind's semantics.

function makeStore(startNow = 1000) {
  let now = startNow;
  const store = new Store(openDb(":memory:"), () => now);
  // intents.run_id REFERENCES runs(id) (foreign_keys ON) — run-scoped test rows need a real run.
  const run = store.createRun({ repo: "r", workSource: "src", belt: "b", ticketKey: "K-1" });
  return { store, run, setNow: (n: number) => (now = n), now: () => now };
}

/** The minimal Deps surface the kernel touches (store/config/now/log/herdr.notify). */
function makeDeps(store: Store, now: () => number, notifies: string[] = []): Deps {
  return {
    store,
    now,
    log: () => {},
    config: { repoName: "r", limits: { attentionRenotifySeconds: 3600 } },
    herdr: {
      notify: async (title: string) => {
        notifies.push(title);
      },
    },
  } as unknown as Deps;
}

const enqueue = (store: Store, over: Partial<Parameters<Store["enqueueIntent"]>[0]> = {}) =>
  store.enqueueIntent({ repo: "r", kind: "k", scope: "run:1", runId: 1, ticketKey: "K-1", ...over });

describe("intents store — enqueue/dedup/FIFO/lease mechanics", () => {
  it("enqueue is idempotent per (kind, scope, dedupKey): a re-enqueue re-opens, KEEPING the FIFO slot", () => {
    const { store, setNow } = makeStore();
    const a = enqueue(store, { dedupKey: "d1", payload: '{"v":1}' });
    expect(a.seq).toBe(a.id); // slot stamped on first insert
    store.markIntentDelivered(a.id);
    // A later, different intent takes a later slot...
    const b = enqueue(store, { dedupKey: "d2" });
    expect(b.seq).toBeGreaterThan(a.seq);
    // ...and re-opening the first keeps its ORIGINAL slot + id, with the fresh payload.
    setNow(2000);
    const reopened = enqueue(store, { dedupKey: "d1", payload: '{"v":2}' });
    expect(reopened.id).toBe(a.id);
    expect(reopened.seq).toBe(a.seq);
    expect(reopened.status).toBe("pending");
    expect(reopened.payload).toBe('{"v":2}');
    expect(reopened.resolvedAt).toBeNull();
  });

  it("supersedeScope (latest-wins): enqueue closes the scope's other live rows, keeping their outcome", () => {
    const { store } = makeStore();
    const a = enqueue(store, { dedupKey: "old" });
    const b = enqueue(store, { dedupKey: "new", supersedeScope: true });
    expect(store.getIntent(a.id)!.status).toBe("superseded");
    expect(store.getIntent(b.id)!.status).toBe("pending");
    // A resolved row is not touched by later supersessions.
    store.markIntentDelivered(b.id);
    enqueue(store, { dedupKey: "newer", supersedeScope: true });
    expect(store.getIntent(b.id)!.status).toBe("delivered");
  });

  it("earlierPendingIntentInScope blocks on an earlier UNRESOLVED sibling even when it isn't due", () => {
    const { store } = makeStore();
    const a = enqueue(store, { dedupKey: "first" });
    store.recordIntentAttempt(a.id, "backend down", "transient", 3600); // backed off — NOT due
    const b = enqueue(store, { dedupKey: "second" });
    expect(store.earlierPendingIntentInScope("k", "run:1", b.seq)).toBe(true);
    store.markIntentDelivered(a.id);
    expect(store.earlierPendingIntentInScope("k", "run:1", b.seq)).toBe(false);
  });

  it("dueIntents honors backoff AND the inline lease; attempts clear the lease", () => {
    const { store, setNow } = makeStore();
    const a = enqueue(store, { dedupKey: "leased", leaseUntil: 1300 });
    expect(store.dueIntents("r").map((i) => i.id)).toEqual([]); // leased — the flush must not steal it
    setNow(1301);
    expect(store.dueIntents("r").map((i) => i.id)).toEqual([a.id]); // lease expired → claimable
    store.recordIntentAttempt(a.id, "boom", "transient", 60);
    expect(store.getIntent(a.id)!.leaseUntil).toBeNull();
    expect(store.dueIntents("r")).toEqual([]); // backed off
    setNow(1362);
    expect(store.dueIntents("r").map((i) => i.id)).toEqual([a.id]);
  });

  it("requeueIntentsByCause is repo+cause scoped, optionally by error class; fulfil only fires on waiting rows", () => {
    const { store, setNow } = makeStore();
    const auth = enqueue(store, { dedupKey: "a", causeScope: "publisher:s3" });
    const flaky = enqueue(store, { dedupKey: "b", causeScope: "publisher:s3" });
    store.recordIntentAttempt(auth.id, "sso expired", "auth", 3600);
    store.recordIntentAttempt(flaky.id, "500", "transient", 3600);
    setNow(1100);
    expect(store.requeueIntentsByCause("r", "publisher:s3", "auth")).toBe(1); // auth-stuck only
    expect(store.getIntent(auth.id)!.nextAttemptAt).toBe(1100);
    expect(store.getIntent(flaky.id)!.nextAttemptAt).toBe(1000 + 3600);
    // fulfil: pending rows are not fulfillable; waiting rows resolve + hand off exactly once.
    expect(store.fulfilIntent(auth.id)).toBeUndefined();
    const wait = enqueue(store, { dedupKey: "w", status: "waiting" });
    const fulfilled = store.fulfilIntent(wait.id, '{"ok":true}')!;
    expect(fulfilled.status).toBe("delivered");
    expect(fulfilled.handoffMarker).toBe("fulfilled");
    expect(store.fulfilIntent(wait.id)).toBeUndefined(); // second fulfil is a no-op
  });

  it("retryIntentsNow (operator bulk due-now) counts only stuck pending rows, keeps attempts, and scopes by run", () => {
    const { store, setNow } = makeStore();
    // A second run, so the run-scoped form can be shown NOT to touch its sibling.
    const other = store.createRun({ repo: "r", workSource: "src", belt: "b", ticketKey: "K-2" });
    const upload = enqueue(store, { dedupKey: "a", causeScope: "publisher:s3" });
    const writeBack = enqueue(store, { dedupKey: "b", kind: "source_transition" });
    const alreadyDue = enqueue(store, { dedupKey: "c" });
    const otherRun = enqueue(store, { dedupKey: "d", scope: `run:${other.id}`, runId: other.id, ticketKey: "K-2" });
    const waiting = enqueue(store, { dedupKey: "w", status: "waiting" });
    store.recordIntentAttempt(upload.id, "timed out reaching S3", "transient", 3600);
    store.recordIntentAttempt(writeBack.id, "500", "transient", 3600);
    store.recordIntentAttempt(otherRun.id, "500", "transient", 3600);
    setNow(1100);

    // Run-scoped: only run 1's backed-off rows. `alreadyDue` was never stuck, so it isn't counted;
    // the sibling run is untouched.
    expect(store.retryIntentsNow("r", { runId: 1 })).toEqual({ requeued: 2, unsuspended: 0 });
    expect(store.getIntent(upload.id)!.nextAttemptAt).toBe(1100);
    expect(store.getIntent(writeBack.id)!.nextAttemptAt).toBe(1100);
    expect(store.getIntent(alreadyDue.id)!.nextAttemptAt).toBe(1000);
    expect(store.getIntent(otherRun.id)!.nextAttemptAt).toBe(1000 + 3600);
    // Attempts survive on a merely mid-interval row: they still count toward the suspension cap.
    expect(store.getIntent(upload.id)!.attempts).toBe(1);
    // A second press re-queues nothing (everything is already due) — the count stays honest.
    expect(store.retryIntentsNow("r", { runId: 1 })).toEqual({ requeued: 0, unsuspended: 0 });

    // Repo-wide picks up the sibling run; `waiting` rows (external-trigger waits) are never retried.
    expect(store.retryIntentsNow("r")).toEqual({ requeued: 1, unsuspended: 0 });
    expect(store.getIntent(otherRun.id)!.nextAttemptAt).toBe(1100);
    expect(store.getIntent(waiting.id)!.status).toBe("waiting");
    expect(store.retryIntentsNow("other-repo")).toEqual({ requeued: 0, unsuspended: 0 });

    // A backed-off row owing an unconsumed handoff is in the RUN's court — skipped, like dueIntents.
    const owed = enqueue(store, { dedupKey: "h" });
    store.recordIntentAttempt(owed.id, "500", "transient", 3600);
    store.markIntentHandoff(owed.id, "stale");
    expect(store.retryIntentsNow("r")).toEqual({ requeued: 0, unsuspended: 0 });
  });

  it("suspension: attempt #10 stamps suspended_at, drops the row from the due walk, and retry-now clears it fresh", () => {
    const { store, setNow } = makeStore();
    const row = enqueue(store, { dedupKey: "s" });
    for (let i = 0; i < 9; i++) store.recordIntentAttempt(row.id, "boom", "transient", 30);
    expect(store.getIntent(row.id)!.suspendedAt).toBeNull();
    store.recordIntentAttempt(row.id, "boom", "transient", 30);
    const suspended = store.getIntent(row.id)!;
    expect(suspended.attempts).toBe(10);
    expect(suspended.suspendedAt).not.toBeNull();
    expect(suspended.status).toBe("pending"); // the obligation stands: claim veto + FIFO keep holding
    // Never due again on its own, no matter how much time passes.
    setNow(999_999);
    expect(store.dueIntents("r").map((i) => i.id)).not.toContain(row.id);
    // It surfaces on the suspended listing and in the timeline.
    expect(store.suspendedIntents("r").map((i) => i.id)).toContain(row.id);
    expect(store.timeline("r", "K-1").some((e) => e.type === "intent_suspended")).toBe(true);
    // The FIFO gate still blocks a later sibling behind it.
    const later = enqueue(store, { dedupKey: "later" });
    expect(store.earlierPendingIntentInScope("k", "run:1", later.seq)).toBe(true);
    // retry-now clears it with a fresh attempt window; it is due (and counted) again. The `later`
    // sibling is already due, so it is not counted — only the suspended row was stuck.
    expect(store.retryIntentsNow("r")).toEqual({ requeued: 1, unsuspended: 1 });
    const cleared = store.getIntent(row.id)!;
    expect(cleared.suspendedAt).toBeNull();
    expect(cleared.attempts).toBe(0);
    expect(store.dueIntents("r").map((i) => i.id)).toContain(row.id);
  });

  it("suspension: a cause-recovery requeue clears it too; a waiting row never suspends; re-enqueue reopens fresh", () => {
    const { store } = makeStore();
    // Cause recovery (the SSO probe path) un-suspends and resets attempts.
    const stuck = enqueue(store, { dedupKey: "c", causeScope: "publisher:s3" });
    for (let i = 0; i < 10; i++) store.recordIntentAttempt(stuck.id, "sso expired", "auth", 30);
    expect(store.getIntent(stuck.id)!.suspendedAt).not.toBeNull();
    expect(store.authStuckIntents("r", "k")).toBe(true); // still drives the probe + dashboard light
    expect(store.requeueIntentsByCause("r", "publisher:s3", "auth")).toBe(1);
    expect(store.getIntent(stuck.id)!).toMatchObject({ suspendedAt: null, attempts: 0 });
    // A waiting row (human poll, external wait) records attempts but never suspends here — its
    // escalation is the run-locked policy's job.
    const waiting = enqueue(store, { dedupKey: "w", status: "waiting" });
    for (let i = 0; i < 12; i++) store.recordIntentAttempt(waiting.id, "poll failed", "transient", 30);
    expect(store.getIntent(waiting.id)!.suspendedAt).toBeNull();
    // A re-enqueue is a fresh obligation: suspension and attempts clear, so the row can deliver.
    const dead = enqueue(store, { dedupKey: "d" });
    for (let i = 0; i < 10; i++) store.recordIntentAttempt(dead.id, "boom", "transient", 30);
    const reopened = enqueue(store, { dedupKey: "d" });
    expect(reopened.id).toBe(dead.id);
    expect(reopened).toMatchObject({ suspendedAt: null, attempts: 0, status: "pending" });
  });

  it("abandonIntentsForRun drops only live rows of the given kinds; a repo-scoped handoff self-acknowledges", () => {
    const { store } = makeStore();
    const keep = enqueue(store, { kind: "keep", dedupKey: "x" });
    const drop = enqueue(store, { kind: "drop", dedupKey: "y" });
    expect(store.abandonIntentsForRun(1, "torn down", ["drop"])).toBe(1);
    expect(store.getIntent(drop.id)!.status).toBe("abandoned");
    expect(store.getIntent(keep.id)!.status).toBe("pending");
    // A handoff with no run has no consumer loop — stamped consumed immediately.
    const repoScoped = enqueue(store, { kind: "keep", scope: "repo", runId: null, dedupKey: "z" });
    store.markIntentHandoff(repoScoped.id, "fulfilled");
    expect(store.getIntent(repoScoped.id)!.consumedResult).toBe("acknowledged (no run)");
  });
});

describe("ledger kernel — outcome application, FIFO gate, deadlines, notify throttle", () => {
  const fakeKind = (kind: string, deliver: (deps: Deps, row: import("../src/types.ts").Intent) => Promise<IntentOutcome>, over: Partial<IntentKindDef> = {}): IntentKindDef => ({
    kind,
    ordering: "independent",
    deliver,
    ...over,
  });

  it("applies each outcome: delivered / retry (flat 30s) / reschedule (no attempt) / failed / handoff", async () => {
    const { store, now } = makeStore();
    const deps = makeDeps(store, now);
    const rows = {
      ok: enqueue(store, { kind: "ok", dedupKey: "1" }),
      retry: enqueue(store, { kind: "retry", dedupKey: "2" }),
      resched: enqueue(store, { kind: "resched", dedupKey: "3" }),
      fail: enqueue(store, { kind: "fail", dedupKey: "4" }),
      hand: enqueue(store, { kind: "hand", dedupKey: "5" }),
    };
    const kinds = [
      fakeKind("ok", async () => ({ kind: "delivered" })),
      fakeKind("retry", async () => ({ kind: "retry", error: "e", errorClass: "transient" })),
      fakeKind("resched", async () => ({ kind: "reschedule", delaySeconds: 120, state: '{"misses":1}' })),
      fakeKind("fail", async () => ({ kind: "failed", reason: "config gone" })),
      fakeKind("hand", async () => ({ kind: "handoff", marker: "stale", resolve: "delivered" })),
    ];
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(store.getIntent(rows.ok.id)!.status).toBe("delivered");
    const r = store.getIntent(rows.retry.id)!;
    expect(r.attempts).toBe(1);
    expect(r.nextAttemptAt).toBe(now() + 30); // the flat interval, attempt 1
    const rs = store.getIntent(rows.resched.id)!;
    expect(rs.attempts).toBe(0); // a miss is not an error
    expect(rs.nextAttemptAt).toBe(now() + 120);
    expect(rs.state).toBe('{"misses":1}');
    expect(store.getIntent(rows.fail.id)!.status).toBe("failed");
    const h = store.getIntent(rows.hand.id)!;
    expect(h.status).toBe("delivered");
    expect(h.handoffMarker).toBe("stale");
    expect(h.consumedAt).toBeNull(); // owed to the run-locked consume
  });

  it("the problem ledger rides the outcomes: an auth retry RECORDS the cause, a delivery CLEARS it", async () => {
    const { store, now } = makeStore();
    const deps = makeDeps(store, now);
    const row = enqueue(store, { kind: "flaky", dedupKey: "1", causeScope: "publisher:s3" });
    let fail = true;
    const kinds = [fakeKind("flaky", async () => (fail ? { kind: "retry", error: "sso expired", errorClass: "auth" } : { kind: "delivered" }))];
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    // Recorded at the source, keyed by the CAUSE — the dashboard reads this, it never re-checks.
    expect(store.listProblems("r")).toEqual([expect.objectContaining({ key: "publisher:s3", kind: "auth" })]);
    // The cause demonstrably works again ⇒ the same machinery clears the record.
    fail = false;
    store.retryIntentNow(row.id);
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(store.getIntent(row.id)!.status).toBe("delivered");
    expect(store.listProblems("r")).toEqual([]);
  });

  it("FIFO ordering: a due row is blocked behind its scope's earlier, backed-off sibling", async () => {
    const { store, setNow, now } = makeStore();
    const deps = makeDeps(store, now);
    const attempts: string[] = [];
    const kinds = [
      fakeKind("f", async (_d, row) => {
        attempts.push(row.dedupKey);
        // "first" fails once, then delivers — the shape that leaves it backed off while "second"
        // is due, which is exactly what the DB-checked gate must block on.
        return row.dedupKey === "first" && row.attempts === 0 ? { kind: "retry", error: "down", errorClass: "transient" } : { kind: "delivered" };
      }, { ordering: "fifo" }),
    ];
    enqueue(store, { kind: "f", dedupKey: "first" });
    enqueue(store, { kind: "f", dedupKey: "second" });
    await flushOutbox(deps, ledgerFlow(deps, kinds)); // first fails (retries in 30s); second is due but BLOCKED
    expect(attempts).toEqual(["first"]);
    setNow(1031);
    // first (due again) delivers; second unblocks within the same pass — the gate re-checks the DB,
    // not a pass-start snapshot (the legacy transition-outbox semantics).
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(attempts).toEqual(["first", "first", "second"]);
    expect(store.listIntents("r", { kind: "f" }).every((i) => i.status === "delivered")).toBe(true);
  });

  it("a waiting row past its deadline fails + hands off 'deadline'; an unknown kind is closed out loudly", async () => {
    const { store, setNow, now } = makeStore();
    const deps = makeDeps(store, now);
    const wait = enqueue(store, { kind: "external_wait", dedupKey: "w", status: "waiting", deadlineAt: 1500 });
    const orphan = enqueue(store, { kind: "gone_kind", dedupKey: "o" });
    setNow(1501);
    await flushOutbox(deps, ledgerFlow(deps, [])); // no kinds registered at all
    const w = store.getIntent(wait.id)!;
    expect(w.status).toBe("failed");
    expect(w.handoffMarker).toBe("deadline");
    expect(store.getIntent(orphan.id)!.status).toBe("failed"); // unknown kind → closed, not retried forever
  });

  it("notify is throttled per row by attention_renotify_seconds", async () => {
    const { store, setNow, now } = makeStore();
    const notifies: string[] = [];
    const deps = makeDeps(store, now, notifies);
    const kinds = [
      fakeKind("n", async () => ({ kind: "retry", error: "sso", errorClass: "auth" }), {
        notify: () => ({ title: "auth stuck", body: "log in again" }),
      }),
    ];
    enqueue(store, { kind: "n", dedupKey: "1" });
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(notifies).toEqual(["auth stuck"]);
    setNow(1061); // due again, but inside the notify window
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(notifies).toEqual(["auth stuck"]);
    setNow(1000 + 3700); // past the throttle
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(notifies).toEqual(["auth stuck", "auth stuck"]);
  });
});

describe("consumeIntentHandoffs — the run-locked half", () => {
  const run = { id: 1, ticketKey: "K-1" } as Run;

  it("consumes each handoff exactly once; no consume() ⇒ acknowledged; a throw ⇒ rejected, not retried", async () => {
    const { store, now } = makeStore(); // makeStore's run is id 1 (first insert)
    const deps = makeDeps(store, now);
    const plain = enqueue(store, { kind: "plain", dedupKey: "1" });
    const throwing = enqueue(store, { kind: "boom", dedupKey: "2" });
    store.markIntentHandoff(plain.id, "fulfilled");
    store.markIntentHandoff(throwing.id, "fulfilled");
    const kinds: IntentKindDef[] = [
      { kind: "boom", ordering: "independent", deliver: async () => ({ kind: "delivered" }), consume: async () => { throw new Error("kaput"); } },
    ];
    expect(await consumeIntentHandoffs(deps, run, kinds)).toBeNull();
    expect(store.getIntent(plain.id)!.consumedResult).toBe("acknowledged");
    expect(store.getIntent(throwing.id)!.consumedResult).toMatch(/^rejected: consume threw/);
    // Second pass: nothing left to consume.
    expect(store.unconsumedIntentHandoffsForRun(1)).toEqual([]);
  });

  it("returns the FIRST escalation verdict for the caller to apply", async () => {
    const { store, now } = makeStore();
    const deps = makeDeps(store, now);
    const row = enqueue(store, { kind: "esc", dedupKey: "1" });
    store.markIntentHandoff(row.id, "deadline");
    const kinds: IntentKindDef[] = [
      {
        kind: "esc",
        ordering: "independent",
        deliver: async () => ({ kind: "delivered" }),
        consume: async () => ({ result: "escalated", escalate: { reason: "external_wait_deadline", attentionReason: "wait expired", body: "b" } }),
      },
    ];
    const escalate = await consumeIntentHandoffs(deps, run, kinds);
    expect(escalate).toMatchObject({ reason: "external_wait_deadline" });
    expect(store.getIntent(row.id)!.consumedResult).toBe("escalated");
  });
});

describe("shipped kinds", () => {
  it("external_wait is registered, externally enqueuable, and never survives teardown", () => {
    const k = intentKindFor("external_wait")!;
    expect(k.externallyEnqueuable).toBe(true);
    expect(k.survivesTeardown ?? false).toBe(false);
    expect(k.ordering).toBe("independent");
  });
});

describe("agent_signal on the ledger (v31 cutover)", () => {
  it("the pending-signal adapters keep the domain shapes: enqueue/supersede/consume round-trip", () => {
    const { store, run } = makeStore();
    const first = store.enqueuePendingSignal({ runId: run.id, repo: "r", ticketKey: "K-1", signal: "ask_human", step: "review", payload: "q1" });
    const second = store.enqueuePendingSignal({ runId: run.id, repo: "r", ticketKey: "K-1", signal: "bounce", step: "review", toStep: "fix", payload: "findings", pass: 2 });
    expect(store.getPendingSignal(first.id)!.consumedResult).toBe("superseded");
    const live = store.unconsumedPendingSignalForRun(run.id)!;
    expect(live).toMatchObject({ id: second.id, signal: "bounce", step: "review", toStep: "fix", payload: "findings", pass: 2 });
    store.markPendingSignalConsumed(second.id, "applied");
    expect(store.unconsumedPendingSignalForRun(run.id)).toBeUndefined();
    expect(store.getPendingSignal(second.id)!.consumedResult).toBe("applied");
    expect(store.getIntent(second.id)!.status).toBe("delivered"); // the row closed with the consume
  });

  it("agent_signal handoffs are invisible to the generic consume loop and to the kernel's due walk", async () => {
    const { store, run, now } = makeStore();
    const deps = makeDeps(store, now);
    const sig = store.enqueuePendingSignal({ runId: run.id, repo: "r", ticketKey: "K-1", signal: "bounce", step: "review", toStep: "fix", payload: "x" });
    // The generic run-locked loop must NOT acknowledge (eat) a reconciler-consumed kind's handoff…
    const { INTENT_KINDS } = await import("../src/intents/registry.ts");
    expect(await consumeIntentHandoffs(deps, { id: run.id, ticketKey: "K-1" } as Run, INTENT_KINDS)).toBeNull();
    expect(store.getIntent(sig.id)!.consumedAt).toBeNull();
    // …and the kernel's due walk must not touch a waiting/handoff row either.
    await flushOutbox(deps, ledgerFlow(deps));
    expect(store.getIntent(sig.id)!.status).toBe("waiting");
    expect(store.unconsumedPendingSignalForRun(run.id)!.id).toBe(sig.id); // still consumable
  });

  it("migration v31 converts unconsumed legacy rows into waiting+handoff ledger rows; v35 drops the table", () => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    const { MIGRATIONS, migrate } = require("../src/db/migrate.ts") as typeof import("../src/db/migrate.ts");
    for (const m of MIGRATIONS.filter((m) => m.version <= 30)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    }
    db.prepare("INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','K-1','running',1,1)").run();
    db.prepare(
      `INSERT INTO pending_signals (run_id, repo, ticket_key, signal, step, to_step, payload, pass, created_at)
       VALUES (1, 'r', 'K-1', 'bounce', 'review', 'fix', 'pre-upgrade findings', 2, 500)`,
    ).run();
    migrate(db);
    const row = db.prepare("SELECT * FROM intents WHERE kind = 'agent_signal'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ scope: "run:1", status: "waiting", handoff_marker: "signal", dedup_key: expect.stringMatching(/^legacy-/) });
    expect(JSON.parse(row.payload as string)).toMatchObject({ signal: "bounce", toStep: "fix", body: "pre-upgrade findings", pass: 2 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain("pending_signals");
  });
});

describe("human_reply_poll on the ledger (v32 cutover)", () => {
  it("the poll clock lives on the ledger: flat 30s misses and errors, reset, and close-on-answer", () => {
    const { store, run, setNow } = makeStore();
    const q = store.createHumanQuestion({ runId: run.id, repo: "r", workSource: "s", ticketKey: "K-1", question: "which flag?" });
    expect(q.nextPollAt).toBeLessThanOrEqual(1000); // armed due-now
    // Two misses: flat 30s each, errors stay 0 (a miss is a successful poll).
    expect(store.recordHumanPollMiss(q.id)).toMatchObject({ pollAttempts: 1, pollErrors: 0, nextPollAt: 1030 });
    setNow(1030);
    expect(store.recordHumanPollMiss(q.id)).toMatchObject({ pollAttempts: 2, pollErrors: 0, nextPollAt: 1030 + 30 });
    // An error is counted separately but keeps the same flat cadence.
    setNow(1180);
    expect(store.recordHumanPollError(q.id)).toMatchObject({ pollAttempts: 2, pollErrors: 1, nextPollAt: 1180 + 30 });
    // A later miss resets the error run.
    setNow(1420);
    expect(store.recordHumanPollMiss(q.id)).toMatchObject({ pollAttempts: 3, pollErrors: 0 });
    // Resume: fresh window, due now.
    store.resetHumanPollBackoff(q.id);
    expect(store.getHumanQuestion(q.id)!).toMatchObject({ pollAttempts: 0, pollErrors: 0 });
    expect(store.getHumanQuestion(q.id)!.nextPollAt).toBeLessThanOrEqual(1420);
    // Answering closes the ledger row (the poll obligation ends with the question).
    store.answerHumanQuestion(q.id, { body: "use A", externalId: "a-1" });
    const intent = store.intentByKey("human_reply_poll", `run:${run.id}`, `q-${q.id}`)!;
    expect(intent.status).toBe("delivered");
    expect(store.getHumanQuestion(q.id)!.pollErrors).toBe(0);
  });

  it("migration v32 carries a mid-backoff, mid-escalation question over exactly", () => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    const { MIGRATIONS, migrate } = require("../src/db/migrate.ts") as typeof import("../src/db/migrate.ts");
    for (const m of MIGRATIONS.filter((m) => m.version <= 31)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    }
    db.prepare("INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','K-1','waiting_for_human',1,1)").run();
    db.prepare(
      `INSERT INTO human_questions (run_id, repo, work_source, ticket_key, step, question, status,
         poll_attempts, poll_errors, next_poll_at, created_at, updated_at)
       VALUES (1, 'r', 's', 'K-1', 'review', 'q?', 'pending', 4, 7, 9999, 100, 100)`,
    ).run();
    db.prepare(
      `INSERT INTO human_questions (run_id, repo, work_source, ticket_key, question, status, created_at, updated_at, answered_at)
       VALUES (1, 'r', 's', 'K-1', 'old q', 'answered', 100, 100, 200)`,
    ).run();
    migrate(db);
    const rows = db.prepare("SELECT * FROM intents WHERE kind = 'human_reply_poll'").all() as Record<string, unknown>[];
    expect(rows.length).toBe(1); // the answered question owes nothing
    expect(rows[0]).toMatchObject({ scope: "run:1", dedup_key: "q-1", status: "waiting", attempts: 7, next_attempt_at: 9999 });
    expect(JSON.parse(rows[0]!.state as string)).toEqual({ pollAttempts: 4 });
  });
});

describe("source_transition on the ledger (v33 cutover)", () => {
  it("migration v33 converts undelivered rows in per-run order and unhandled-stale rows still owing their handoff", () => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    const { MIGRATIONS, migrate } = require("../src/db/migrate.ts") as typeof import("../src/db/migrate.ts");
    for (const m of MIGRATIONS.filter((m) => m.version <= 32)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    }
    db.prepare("INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','K-1','running',1,1)").run();
    // An in-order pair: in_development mid-backoff (attempt 4), then in_review queued behind it.
    db.prepare(
      `INSERT INTO transition_outbox (run_id, repo, work_source, ticket_key, to_state, to_status, attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES (1, 'r', 'jira', 'K-1', 'in_development', '', 4, 8000, 'jira 500', 100, 100),
              (1, 'r', 'jira', 'K-1', 'in_review', '', 0, 100, NULL, 200, 200)`,
    ).run();
    // A second run with an unhandled STALE intent (delivered, policy reaction still owed).
    db.prepare("INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','K-2','running',1,1)").run();
    db.prepare(
      `INSERT INTO transition_outbox (run_id, repo, work_source, ticket_key, to_state, to_status, attempts, next_attempt_at, last_error, created_at, updated_at, delivered_at, stale_at)
       VALUES (2, 'r', 'jira', 'K-2', 'in_development', '', 1, 300, 'issue deleted', 100, 100, 400, 400)`,
    ).run();
    migrate(db);

    const { openDb } = require("../src/db/index.ts") as typeof import("../src/db/index.ts");
    void openDb; // (db already migrated in place)
    const { Store } = require("../src/db/store.ts") as typeof import("../src/db/store.ts");
    const store = new Store(db, () => 10_000);
    // Run 1: both rows pending on the ledger, clocks intact, FIFO order preserved.
    const pending = store.pendingTransitionsForRun(1);
    expect(pending.map((t) => t.toState)).toEqual(["in_development", "in_review"]);
    expect(pending[0]).toMatchObject({ attempts: 4, nextAttemptAt: 8000, lastError: "jira 500" });
    expect(store.undeliveredTransitionBefore(1, pending[1]!.id)).toBe(true); // gate holds across the upgrade
    expect(store.pendingTransitionForKey("r", "jira", "K-1")).toBe(true); // the claim veto too
    // Run 2: the stale intent is resolved but still owes its run-locked policy reaction.
    const stale = store.unhandledStaleIntentForRun(2)!;
    expect(stale).toMatchObject({ toState: "in_development", lastError: "issue deleted" });
    store.markTransitionStaleHandled(stale.id);
    expect(store.unhandledStaleIntentForRun(2)).toBeUndefined(); // exactly once
    // ...and the legacy table is gone (v35), so nothing can double-deliver from it.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain("transition_outbox");
  });
});

describe("watch_state (v34) — per-watch clocks", () => {
  it("migration v34 backfills a mid-flight step's clocks onto watch_state (and v35 drops the source columns)", () => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    const { MIGRATIONS, migrate } = require("../src/db/migrate.ts") as typeof import("../src/db/migrate.ts");
    for (const m of MIGRATIONS.filter((m) => m.version <= 33)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    }
    db.prepare("INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','K-1','running',1,1)").run();
    db.prepare(
      `INSERT INTO run_steps (run_id, step, started_at, progress_sig, progress_at, baseline_sig, baseline_frozen_at)
       VALUES (1, 'work', 500, 'sha-hb', 900, NULL, NULL), (1, 'review', 700, NULL, NULL, 'sha-ro', 800)`,
    ).run();
    migrate(db);
    const rows = db.prepare("SELECT step, watch, sig, based_at FROM watch_state ORDER BY step, watch").all() as Record<string, unknown>[];
    expect(rows).toEqual([
      { step: "review", watch: "budget", sig: null, based_at: 700 },
      { step: "review", watch: "read_only", sig: "sha-ro", based_at: 800 },
      { step: "work", watch: "budget", sig: null, based_at: 500 },
      { step: "work", watch: "heartbeat", sig: "sha-hb", based_at: 900 },
    ]);
    // The columns those clocks came from are gone — watch_state is the only home now.
    const cols = (db.prepare("PRAGMA table_info(run_steps)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("progress_sig");
    expect(cols).not.toContain("baseline_frozen_at");
  });

  it("a re-base writes a NULL row (never deletes), so a cleared clock stays cleared", () => {
    const { store, run } = makeStore();
    // (effectiveWatchClock is exercised through the evaluators in reconcile tests; here we pin the
    // store contract the no-resurrection rule rides on.)
    expect(store.getWatchState(run.id, "review", "read_only")).toBeUndefined();
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-old", basedAt: 42 });
    store.upsertWatchState(run.id, "review", "read_only", { sig: null, basedAt: null }); // a clear
    const ws = store.getWatchState(run.id, "review", "read_only")!;
    expect(ws.sig).toBeNull();
    expect(ws.basedAt).toBeNull(); // the row EXISTS with nulls — "sha-old" cannot come back
    // Partial upserts only touch provided fields.
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-new" });
    expect(store.getWatchState(run.id, "review", "read_only")!).toMatchObject({ sig: "sha-new", basedAt: null });
    store.upsertWatchState(run.id, "review", "read_only", { basedAt: 99 });
    expect(store.getWatchState(run.id, "review", "read_only")!).toMatchObject({ sig: "sha-new", basedAt: 99 });
  });
});
