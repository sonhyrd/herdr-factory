// The INTENT-KIND registry: one descriptor per durable-intent kind the ledger carries. Mirrors
// SOURCE_DESCRIPTORS / STEP_DESCRIPTORS / SIGNAL_DESCRIPTORS — a registry the kernel
// (src/core/ledger.ts), the server (/intents endpoints) and the introspection surfaces ITERATE, so
// behavior lives in code behind declarations and the `intents` table stays a fixed shared schema.
//
// ── Adding intent kind N+1 (the whole checklist) ─────────────────────────────────────────────────
//  1. src/intents/kinds/<name>.ts          — the IntentKindDef (deliver + optional consume/prePass)
//  2. one entry in INTENT_KINDS            — below
//  3. a harness in the ledger contract suite (test/intent-ledger.test.ts)
//  4. enqueue sites route through store.enqueueIntent with this kind (or mark it
//     `externallyEnqueuable` for POST /repos/:repo/intents)
// Zero other core edits — the kernel dispatches on the registry, never on a kind name.
//
// THE TWO-LANE CONTRACT (docs/ARCHITECTURE.md §7): `deliver` runs LOCK-FREE from the Phase-0 flush —
// it must never mutate a run; a run-policy reaction crosses lanes as a HANDOFF (`{kind: "handoff"}`
// outcome, or store.markIntentHandoff) that the run-locked Phase A consumes exactly once via
// `consume`. `consume` runs under the run's lock and returns a VERDICT — including any attention
// escalation — that the reconciler applies; it never imports reconciler machinery (no cycles).
import type { Deps } from "../core/deps.ts";
import type { Intent, Run } from "../types.ts";
import { agentSignalKind } from "./kinds/agent-signal.ts";
import { evidencePublishKind } from "./kinds/evidence-publish.ts";
import { externalWaitKind } from "./kinds/external-wait.ts";
import { humanReplyPollKind } from "./kinds/human-reply-poll.ts";
import { sourceTransitionKind } from "./kinds/source-transition.ts";

/** The outcome of one lock-free delivery attempt. */
export type IntentOutcome =
  /** The obligation is met — the row closes. */
  | { kind: "delivered" }
  /** A retryable failure: attempts++, retry on the flat 30s interval (suspending at
   *  MAX_RETRY_ATTEMPTS), classify for cause recovery. */
  | { kind: "retry"; error: string; errorClass: "auth" | "transient" }
  /** Not an error — probe again later (a reply-poll miss). Optionally replaces kind-owned state. */
  | { kind: "reschedule"; delaySeconds: number; state?: string }
  /** Terminal failure: the row closes as failed (config error, item gone with no run reaction). */
  | { kind: "failed"; reason: string }
  /** The kernel's job is done but a RUN reaction is owed — stamp the handoff for the run-locked
   *  consume. `resolve` closes the row ("delivered"/"failed" as far as scheduling is concerned). */
  | { kind: "handoff"; marker: string; resolve?: "delivered" | "failed"; error?: string };

/** What a run-locked consume decided. `escalate` parks the run (the reconciler applies it — the
 *  kind never imports escalation machinery). `reconcile` asks for an immediate re-pass (the
 *  consume re-pointed the run). */
export interface IntentConsumeVerdict {
  result: string; // stamped as consumed_result: applied | acknowledged | rejected: <why> | …
  escalate?: { reason: string; attentionReason: string; body: string; detail?: Record<string, unknown>; skipSourceNote?: boolean };
}

export interface IntentKindDef {
  readonly kind: string;
  /** Delivery ordering within a scope:
   *  - "fifo"        — an earlier unresolved sibling blocks this row (per-run in-order write-backs);
   *  - "latest-wins" — enqueue supersedes the scope's other live rows (agent signals, re-captures);
   *  - "independent" — rows deliver in any order. */
  readonly ordering: "fifo" | "latest-wins" | "independent";
  /** May POST /repos/:repo/intents create rows of this kind? Off for engine-owned kinds — hand-made
   *  source_transition rows would be a footgun; on for external_wait (webhooks/CI callbacks). */
  readonly externallyEnqueuable?: boolean;
  /** Once per flush pass, before the due walk (cause-recovery probes gated on stuck rows). */
  prePass?(deps: Deps): Promise<void>;
  /** THE delivery attempt. LOCK-FREE — never mutate a run (see the two-lane contract above). */
  deliver(deps: Deps, row: Intent): Promise<IntentOutcome>;
  /** Operator notification for a failure, throttled per row by attention_renotify_seconds against
   *  `notified_at`. null = nothing to say for this failure. */
  notify?(deps: Deps, row: Intent, failure: { errorClass: string; reason: string }): { title: string; body: string } | null;
  /** Who consumes this kind's handoffs. "kernel" (default): the generic run-locked loop calls
   *  `consume` (or stamps 'acknowledged'). "reconciler": the reconciler owns a bespoke consume —
   *  the run reaction is too entangled with step machinery for a registry callback (agent_signal's
   *  bounce rewind, source_transition's stale policy) — and the generic loop must NOT touch it. */
  readonly consumedBy?: "kernel" | "reconciler";
  /** Who attempts this kind's pending rows. "kernel" (default): the ledger flow's due walk calls
   *  `deliver`. "reconciler": a reconciler-owned flow drives the rows through the store adapters
   *  (source_transition — its delivery needs the resolved source/belt/auth-gate machinery); the
   *  kernel's due walk excludes the kind so the two can never double-attempt a row. */
  readonly deliveredBy?: "kernel" | "reconciler";
  /** Run-locked consume of this kind's handoffs. Omitted ⇒ handoffs are stamped 'acknowledged'. */
  consume?(deps: Deps, run: Run, row: Intent): Promise<IntentConsumeVerdict>;
  /** What a human `resume` of the run does to this kind's live rows. */
  readonly refundOnResume?: "due_now" | "none";
  /** True ⇒ this kind's live rows OUTLIVE run teardown (terminal source write-backs). Default:
   *  a run's live rows are abandoned when it tears down (external waits, evidence bytes). */
  readonly survivesTeardown?: boolean;
}

export const INTENT_KINDS: readonly IntentKindDef[] = [agentSignalKind, evidencePublishKind, externalWaitKind, humanReplyPollKind, sourceTransitionKind];

export function intentKindFor(kind: string): IntentKindDef | undefined {
  return INTENT_KINDS.find((k) => k.kind === kind);
}
