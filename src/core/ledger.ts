// The intent-ledger KERNEL: the generic scheduling engine over the `intents` table (v29), driving
// whatever the INTENT_KINDS registry declares. Two halves, split exactly on the codebase's
// lock-free/run-locked line (the stale two-phase, generalized):
//
//  - `ledgerFlow` — the Phase-0 flush (an OutboxFlow, sharing the driver every outbox uses):
//    kind prePasses (cause-recovery probes), deadline sweeps for waiting rows, then the due walk —
//    FIFO gate per the kind's ordering, `deliver()`, outcome application, throttled notifies.
//    LOCK-FREE: nothing here mutates a run; run reactions are stamped as handoffs.
//  - `consumeIntentHandoffs` — the run-locked half, called from reconcileRun's pass: each owed
//    handoff is consumed exactly once via the kind's `consume()`, whose verdict (including any
//    attention escalation) the CALLER applies — kinds never import reconciler machinery.
import type { Deps } from "./deps.ts";
import type { Intent, Run } from "../types.ts";
import type { OutboxFlow } from "./outbox.ts";
import { INTENT_KINDS, intentKindFor, type IntentConsumeVerdict, type IntentKindDef } from "../intents/registry.ts";
import { MAX_RETRY_ATTEMPTS, notifyDue, RETRY_INTERVAL_SECONDS } from "../schedule.ts";
import { reportToPane } from "./pane-display.ts";

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Apply one delivery outcome to its row (the kernel's half of the outcome contract). The problem
 *  ledger rides the outcomes GENERICALLY, keyed by the row's cause: an `auth`-classified retry
 *  reports the cause as an open problem (the dashboard's red repo light — recorded here, never
 *  re-checked on load); a delivery clears it (the cause demonstrably works again). Kind-specific
 *  detectors (the evidence creds probe) report/clear the same cause key, so the two agree. */
async function applyOutcome(deps: Deps, kind: IntentKindDef, row: Intent, outcome: Awaited<ReturnType<IntentKindDef["deliver"]>>): Promise<void> {
  switch (outcome.kind) {
    case "delivered":
      deps.store.markIntentDelivered(row.id);
      if (row.causeScope) deps.store.clearProblem(row.repo, row.causeScope);
      return;
    case "reschedule":
      deps.store.rescheduleIntent(row.id, outcome.delaySeconds, outcome.state);
      return;
    case "failed":
      deps.store.markIntentFailed(row.id, outcome.reason);
      await maybeNotify(deps, kind, row, { errorClass: "permanent", reason: outcome.reason });
      return;
    case "handoff":
      deps.store.markIntentHandoff(row.id, outcome.marker, { resolve: outcome.resolve, error: outcome.error });
      return;
    case "retry": {
      const updated = deps.store.recordIntentAttempt(row.id, outcome.error, outcome.errorClass, RETRY_INTERVAL_SECONDS);
      if (outcome.errorClass === "auth" && row.causeScope) {
        deps.store.reportProblem(row.repo, row.causeScope, "auth", `${row.kind.replaceAll("_", " ")} blocked on credentials: ${outcome.error}`);
      }
      // The attempt that crossed MAX_RETRY_ATTEMPTS suspended the row (the store stamps it):
      // retries stop until an operator (`s` / retry-now) or a cause probe clears it. That is a
      // state change the operator must hear about NOW — notify unthrottled, once.
      if (updated?.suspendedAt != null && row.suspendedAt == null) {
        deps.log("error", `${row.ticketKey ?? row.scope}: ${row.kind} intent SUSPENDED after ${updated.attempts} failed attempts: ${outcome.error}`);
        await notifySuspended(deps, kind.kind, updated, outcome.error);
        return;
      }
      deps.log("warn", `${row.ticketKey ?? row.scope}: ${row.kind} intent deferred (attempt ${updated?.attempts} of ${MAX_RETRY_ATTEMPTS}): ${outcome.error}`);
      await maybeNotify(deps, kind, row, { errorClass: outcome.errorClass, reason: outcome.error });
      return;
    }
  }
}

/** The one-time SUSPENSION notify: unthrottled (it fires exactly once per suspension — the row
 *  stops retrying, so there is no repeat), naming the failure and both recovery paths. A suspension
 *  is a MECHANICAL failure (the factory's own delivery machinery), so it also reports into the
 *  run's own agent pane when the run is still live — never onto the work item. Exported for the
 *  reconciler's transition flow, which delivers its kind outside this kernel. */
export async function notifySuspended(deps: Deps, kindName: string, row: { id: number; runId: number | null; ticketKey: string | null }, reason: string): Promise<void> {
  const what = row.ticketKey ? `${row.ticketKey}'s ${kindName.replaceAll("_", " ")}` : `a ${kindName.replaceAll("_", " ")} job`;
  const body = `${what} failed ${MAX_RETRY_ATTEMPTS} times and stopped retrying (${reason}). Fix the cause, then press s on the dashboard or run \`herdr-factory --repo ${deps.config.repoName} retry-now\`.`;
  await deps.herdr.notify(`herdr-factory: ${deps.config.repoName} — job suspended`, body).catch(() => {});
  const run = row.runId != null ? deps.store.getRun(row.runId) : undefined;
  if (run && run.endedAt == null) await reportToPane(deps, run, `⚠ background job suspended: ${body}`);
  deps.store.markIntentNotified(row.id);
}

/** The kind's operator notify for a failure, throttled per row by attention_renotify_seconds.
 *  A failing background delivery is a MECHANICAL error, so the same (throttled) message also
 *  reports into the run's own agent pane when the run is still live — where the work happened,
 *  and where the operator is already looking. Never onto the work item. */
async function maybeNotify(deps: Deps, kind: IntentKindDef, row: Intent, failure: { errorClass: string; reason: string }): Promise<void> {
  if (!kind.notify) return;
  if (!notifyDue(row.notifiedAt, deps.config.limits.attentionRenotifySeconds, deps.now())) return;
  const note = kind.notify(deps, row, failure);
  if (!note) return;
  await deps.herdr.notify(note.title, note.body).catch(() => {});
  const run = row.runId != null ? deps.store.getRun(row.runId) : undefined;
  if (run && run.endedAt == null) await reportToPane(deps, run, `⚠ ${note.title}: ${note.body}`);
  deps.store.markIntentNotified(row.id);
}

/** Deliver ONE row now, outside the flush — the caller already OWNS it (it holds the enqueue lease,
 *  e.g. the `evidence-upload` background child). Same deliver + outcome bookkeeping as the flush,
 *  so a failure lands on the normal retry clock (a retry clears the lease; the flush takes over). */
export async function deliverIntentNow(deps: Deps, row: Intent): Promise<void> {
  const kind = intentKindFor(row.kind);
  if (!kind) return;
  await applyOutcome(deps, kind, row, await kind.deliver(deps, row));
}

/** The ledger as a Phase-0 flush flow — plugged into `outboxFlows` beside the legacy outboxes. */
export function ledgerFlow(deps: Deps, kinds: readonly IntentKindDef[] = INTENT_KINDS): OutboxFlow<Intent> {
  const repo = deps.config.repoName;
  const kindFor = (name: string) => kinds.find((k) => k.kind === name);
  // Reconciler-delivered kinds are excluded from the DUE QUERY, not just skipped per row — a
  // backlog of skipped rows would otherwise fill the batch limit and starve kernel-owned kinds.
  const excludeKinds = kinds.filter((k) => k.deliveredBy === "reconciler").map((k) => k.kind);
  return {
    name: "intent ledger",
    prePass: async () => {
      // Kind pre-passes: cause-recovery probes and the like. Isolated per kind — one kind's probe
      // failure must not stall another kind's delivery.
      for (const k of kinds) {
        if (!k.prePass) continue;
        try {
          await k.prePass(deps);
        } catch (e) {
          deps.log("warn", `${k.kind} intent pre-pass failed: ${err(e)}`);
        }
      }
      // Deadline sweep: a waiting row past its deadline fails and owes the run a 'deadline'
      // handoff (consumed under the run lock — never a run mutation here).
      for (const row of deps.store.dueIntentDeadlines(repo)) {
        deps.store.markIntentHandoff(row.id, "deadline", { resolve: "failed", error: "deadline expired" });
        deps.store.recordEvent({ runId: row.runId, repo, ticketKey: row.ticketKey, type: "intent_deadline", detail: { intentId: row.id, kind: row.kind } });
        deps.log("warn", `${row.ticketKey ?? row.scope}: ${row.kind} intent #${row.id} deadline expired`);
      }
    },
    due: () => deps.store.dueIntents(repo, 25, excludeKinds),
    attempt: async (row) => {
      const kind = kindFor(row.kind);
      if (kind?.deliveredBy === "reconciler") return; // its own flow drives it (belt-and-braces)
      if (!kind) {
        // A kind removed from the registry (or a downgrade artifact): close it out loudly rather
        // than retrying forever against nothing — mirrors the orphaned-source close-out.
        deps.store.markIntentFailed(row.id, `unknown intent kind "${row.kind}"`);
        deps.log("warn", `${row.ticketKey ?? row.scope}: dropping ${row.kind} intent #${row.id} — kind not registered`);
        return;
      }
      // The FIFO gate, checked against the DB (not the pass): an earlier unresolved sibling that
      // is backed off (not due) must still block this row — in-order-per-scope is the invariant
      // that keeps a retried earlier write-back from landing after a later one.
      if (kind.ordering === "fifo" && deps.store.earlierPendingIntentInScope(row.kind, row.scope, row.seq)) return;
      const outcome = await kind.deliver(deps, row);
      await applyOutcome(deps, kind, row, outcome);
    },
  };
}

/**
 * The run-locked half: consume every handoff owed to this run, exactly once, in order. MUST be
 * called under the run's `run:<id>` lock (reconcileRun's pass); takes no locks itself. Returns an
 * escalation verdict for the CALLER to apply (kinds never park runs themselves), or null when
 * nothing escalated. A consume() throw stamps the handoff `rejected` (loudly) rather than
 * re-consuming it forever — the row's timeline keeps the reason.
 */
export async function consumeIntentHandoffs(
  deps: Deps,
  run: Run,
  kinds: readonly IntentKindDef[] = INTENT_KINDS,
): Promise<IntentConsumeVerdict["escalate"] | null> {
  for (const row of deps.store.unconsumedIntentHandoffsForRun(run.id)) {
    const kind = kinds.find((k) => k.kind === row.kind);
    // A reconciler-consumed kind's handoffs are OWNED by bespoke reconciler code (agent_signal →
    // consumePendingSignal); acknowledging them here would eat the signal before it applies.
    if (kind?.consumedBy === "reconciler") continue;
    if (!kind?.consume) {
      deps.store.markIntentConsumed(row.id, "acknowledged");
      continue;
    }
    try {
      const verdict = await kind.consume(deps, run, row);
      deps.store.markIntentConsumed(row.id, verdict.result);
      if (verdict.escalate) return verdict.escalate;
    } catch (e) {
      deps.store.markIntentConsumed(row.id, `rejected: consume threw (${err(e).slice(0, 200)})`);
      deps.log("error", `${run.ticketKey}: consuming ${row.kind} intent #${row.id} handoff failed: ${err(e)}`);
    }
  }
  return null;
}
