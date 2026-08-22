// source_transition: the source status write-backs (cut over from `transition_outbox` in v33) —
// the ledger's most constrained kind, and deliberately the LAST one over:
//
//  - ordering "fifo" per run scope: delivery is strictly in-order per run — a retried
//    in_development landing after in_review would walk the source backward. The gate is checked
//    against the DB (an earlier sibling that is backed off still blocks).
//  - dedup `<toState>:<toStatus>` reproduces the legacy UNIQUE(run_id, to_state, to_status):
//    enqueue is idempotent, a re-open keeps the row's original FIFO slot, and a belt effect's
//    custom status coexists with a canonical transition at the same anchor.
//  - the stale two-phase IS the handoff, un-generalized back to its origin: delivery finding the
//    item gone stamps a 'stale' handoff (resolved — the kernel is done) that the RUN-LOCKED stale
//    policy consumes exactly once (abort pre-work / park mid-flight, keyed on run progress).
//  - deliveredBy + consumedBy "reconciler": delivery needs the resolved SourceRuntime, the belt's
//    pickup label, the TransitionContext and the auth gate — all reconciler-owned (the
//    transitionOutboxFlow drives ledger rows through the store adapters; deliverTransition is
//    byte-identical to its pre-ledger self) — and the stale policy needs teardown/escalation.
//    The kernel's due walk skips reconciler-delivered kinds entirely.
//  - survivesTeardown: a TERMINAL write-back must outlive its run (the outbox keeps retrying
//    after the run ends; the Phase-B claim gate on pending write-backs depends on it).
//  - cause "source:<name>" powers the auth-gate recovery requeue (all classes — a source coming
//    back should also retry the merely network-flaky rows, the legacy semantics).
import type { IntentKindDef } from "../registry.ts";

/** The kind-owned payload of a source_transition row. */
export interface SourceTransitionPayload {
  toState: string;
  toStatus: string; // '' = the canonical mapping for toState (a belt effect's custom status else)
  workSource: string;
}

export const sourceTransitionKind: IntentKindDef = {
  kind: "source_transition",
  ordering: "fifo",
  deliveredBy: "reconciler",
  consumedBy: "reconciler",
  survivesTeardown: true,
  // Unreachable: the kernel skips reconciler-delivered kinds. Kept alive (retry, never terminal)
  // so a skip-logic regression surfaces as a loud log loop instead of a silently failed write-back.
  deliver: async () => ({ kind: "retry", error: "source_transition is reconciler-delivered (kernel skip regression)", errorClass: "transient" }),
};
