// Shared guard builders for the shipped step descriptors. A LEAF module (imports only the GuardSpec
// type) so descriptors can import these without creating a cycle through registry.ts — registry.ts
// imports the descriptors, so it can't also be the module that defines what the descriptors need at
// import-eval time (that was a temporal-dead-zone crash on load).
//
// The union of guards with autoRescueOnDone===true is STEP_WATCHDOG_ATTENTION (a genuine terminal
// signal — step-done OR bounce — from the parked step un-parks a run a watchdog parked; the park
// is a backstop against a stuck agent, never a veto on its decision); bounce_limit / pr_closed /
// source_item_stale / human_poll_failing / config parks are not here. Nor is the ask-human park —
// it isn't a guard at all (the PHASE is the park) — but it IS rescued by the same terminal signals,
// routed by reconcile's `rescuablePark`. layout_wait is the one guard that trips
// BEFORE the step's agent exists (the pane never came up ⇒ no agent ⇒ no terminal signal can ever
// arrive), so terminal-signal rescue is categorically wrong for it: it declares
// autoRescueOnDone:false and recovers by RE-ATTEMPTING THE SPAWN instead — `autoRespawnLimit`
// bounds how many extra wait windows the engine grants (in place, or by auto-un-parking an
// already-parked run) before the park needs a human `resume`.
import type { GuardCounterReset, GuardSpec } from "../types.ts";

// NOTE the declaration ORDER on descriptors: HEARTBEAT before BUDGET. The harness is
// first-trip-wins in guard order, and when both windows have expired the stall diagnosis wins
// (it names the more specific failure) — the ordering the pre-harness code hardcoded.
export const BUDGET_GUARD: GuardSpec = { kind: "budget", escalationReason: "step_budget", autoRescueOnDone: true, vetoWhenWorking: true, rebaseOn: ["entry", "resume", "reply_resume"] };
export const HEARTBEAT_GUARD: GuardSpec = { kind: "heartbeat", escalationReason: "step_stalled", autoRescueOnDone: true, requiresProduct: "commits", vetoWhenWorking: true, rebaseOn: ["entry", "resume"] };
// The read-only posture's HEAD-move contract check (evidence/review, and a custom step declaring
// read_only). Attached wherever posture.readOnly resolves true — on the descriptor here for the
// shipped read-only primitives, pushed by config's resolveStep for a custom read_only ref — so the
// STEP_WATCHDOG_ATTENTION derivation covers `read_only_violation` from the registry instead of a
// hand-added literal. Its rescue is autoRescueOnDone like the other agent-running watchdogs: the
// park is a backstop against an agent that touched the tree, never a veto on a completed step
// (RWR-18204 — a genuine step-done un-parks and ADVANCES, clearing the enforcement baseline).
export const READ_ONLY_GUARD: GuardSpec = { kind: "read_only", escalationReason: "read_only_violation", autoRescueOnDone: true, stage: "pre_advance", rebaseOn: ["entry", "resume"] };
export const LAYOUT_WAIT_GUARD: GuardSpec = { kind: "layout_wait", escalationReason: "layout_wait_timeout", autoRescueOnDone: false, autoRespawnLimit: 3, attachWhen: "layoutTarget", resetOn: ["dispatch", "resume"] };
/** The `guard_counters` key for the layout wait's one relaunch of an agent herdr never detected
 *  (issue #99). Not a guard of its own — refunded wherever the layout-wait budget is. */
export const PANE_RELAUNCH_COUNTER = "pane_relaunch";
export const CAPTURE_CAP_GUARD: GuardSpec = { kind: "capture_cap", escalationReason: "capture_limit", autoRescueOnDone: true, resetOn: ["forward_entry", "resume"], cumulative: false, requiresProduct: "evidence", counterScope: "run+step+guard" };
// A machine-global exclusive resource the step's agent holds while driving the app (the capture
// mutex). NOT a watchdog (never parks/auto-rescues) and not a counter — its @@CAPTURE_LOCK_*_CMD@@
// tokens are injected only for a step that declares it, and the engine backstop-releases it on step
// exit (owner = the run's key) so a forgotten release frees immediately instead of waiting its TTL.
export const CAPTURE_LOCK_GUARD: GuardSpec = { kind: "exclusive_resource", resourceName: "capture", escalationReason: "capture_lock", autoRescueOnDone: false };

/** The step's counter guards whose `guard_counters` row is cleared at `trigger` — how the engine
 *  derives its reset calls (spawnStep's dispatch-success refund, reconcileStep's forward-entry
 *  reset, resumeRun's human-resume refunds) from the declarations instead of hardcoding guard
 *  names at each seam. A guard with no `resetOn` never participates. */
export function guardsResetOn(guards: readonly GuardSpec[], trigger: GuardCounterReset): GuardSpec[] {
  return guards.filter((g) => g.resetOn?.includes(trigger));
}

/** The bounce-oscillation cap's registry declaration. Deliberately NOT a GuardSpec: the cap itself
 *  is config-owned (`limits.max_bounces` / the belt override), the counter is keyed on the bounce
 *  TARGET step (a cross-step control riding `controls.bounce`, not a per-step watchdog), and its
 *  park is HUMAN-ONLY — never auto-rescued (an oscillating rework loop needs a person). A resume
 *  from a `bounce_limit` park refunds the counter BELT-WIDE (it's per-target, so every step's count
 *  clears — see resumeRun); this declaration is where the routing strings live. */
export const BOUNCE_CAP = {
  guard: "bounce_cap",
  escalationReason: "bounce_limit",
} as const;
