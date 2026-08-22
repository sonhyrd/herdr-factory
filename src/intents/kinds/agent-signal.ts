// agent_signal: the durable bounce/ask-human intents (cut over from `pending_signals` in v31).
// A PURE-HANDOFF kind: the row is born `waiting` with its 'signal' handoff stamped atomically at
// enqueue — the kernel never retries it, and the run reaction (step rewind / phase flip) is so
// entangled with the step machinery (bounceStep, requestHumanInput, pass validation) that the
// RECONCILER owns the consume (`consumedBy: "reconciler"` — consumePendingSignal in
// core/reconcile.ts, which both the inline signal path and the tick's pass call). The ledger owns
// durability, single-slot supersession (latest-wins: an agent re-deciding replaces its prior
// signal), the timeline, and teardown abandonment.
import type { IntentKindDef } from "../registry.ts";

export const agentSignalKind: IntentKindDef = {
  kind: "agent_signal",
  ordering: "latest-wins",
  consumedBy: "reconciler",
  // Crash backstop only: a mis-created pending row (enqueue stamps the handoff atomically, so this
  // should never run) converts itself into the handoff it was meant to be.
  deliver: async () => ({ kind: "handoff", marker: "signal", resolve: undefined }),
};
