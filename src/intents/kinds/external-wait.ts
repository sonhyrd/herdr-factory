// external_wait: a first-class "wait for an external trigger" row — the capability nothing in the
// pre-ledger codebase could express. A row is created `waiting` (via POST /repos/:repo/intents —
// the one externally-enqueuable kind — or by engine code that hands a wait to the outside world:
// a webhook, a CI callback, a remote approval). It is NOT retried; it resolves one of two ways:
//   - POST /repos/:repo/intents/:id/fulfil — the external thing happened. The result lands in
//     `state`, the row closes, and a 'fulfilled' handoff is consumed under the run lock (recorded
//     on the timeline; a payload `on_fulfil: "reconcile"` also nudges the run's next pass).
//   - its deadline passes — the kernel fails the row and stamps a 'deadline' handoff; a run-scoped
//     wait then parks for attention (payload `on_deadline: "ignore"` opts out).
import type { IntentConsumeVerdict, IntentKindDef } from "../registry.ts";

/** The payload an external_wait row carries (all optional). */
interface ExternalWaitPayload {
  note?: string; // human-readable "what are we waiting for" (shown in /intents + obligations)
  on_deadline?: "attention" | "ignore"; // default attention (a run-scoped wait that expires parks)
}

function payloadOf(raw: string): ExternalWaitPayload {
  try {
    return JSON.parse(raw) as ExternalWaitPayload;
  } catch {
    return {};
  }
}

export const externalWaitKind: IntentKindDef = {
  kind: "external_wait",
  ordering: "independent",
  externallyEnqueuable: true,
  // Never reached in a healthy system: external_wait rows are created `waiting` (the enqueue
  // endpoint enforces it) and waiting rows are not walked by the due query. A pending row of this
  // kind is a bug — fail it loudly rather than spin on it.
  deliver: async () => ({ kind: "failed", reason: "external_wait rows must be created waiting (enqueue bug)" }),
  consume: async (deps, run, row): Promise<IntentConsumeVerdict> => {
    const p = payloadOf(row.payload);
    if (row.handoffMarker === "fulfilled") {
      deps.store.recordEvent({
        runId: run.id,
        repo: row.repo,
        ticketKey: run.ticketKey,
        type: "intent_fulfilled",
        detail: { intentId: row.id, note: p.note, result: row.state },
      });
      deps.log("info", `${run.ticketKey}: external wait #${row.id} fulfilled${p.note ? ` (${p.note})` : ""}`);
      return { result: "applied" };
    }
    // deadline
    if (p.on_deadline === "ignore") {
      deps.log("warn", `${run.ticketKey}: external wait #${row.id} expired${p.note ? ` (${p.note})` : ""} — configured to ignore`);
      return { result: "deadline ignored (per payload)" };
    }
    return {
      result: "escalated",
      escalate: {
        reason: "external_wait_deadline",
        attentionReason: `external wait expired${p.note ? `: ${p.note}` : ""}`,
        body: `${run.ticketKey}: an external trigger the run was waiting on (intent #${row.id}${p.note ? ` — ${p.note}` : ""}) never arrived before its deadline. Fulfil it late with \`POST /repos/${row.repo}/intents/${row.id}/fulfil\`, or resume/tear down the run.`,
        detail: { intentId: row.id, note: p.note ?? null },
      },
    };
  },
};
