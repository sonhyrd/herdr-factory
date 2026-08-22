// human_reply_poll: the ask-human reply loop's SCHEDULING row (cut over from human_questions'
// poll columns in v32). One `waiting` row per pending question (keyed q-<id>) carries the poll
// clock: next_attempt_at gates the next poll (a flat 30s cadence), state.pollAttempts counts
// misses, attempts counts consecutive poll ERRORS (reset by any successful poll; the
// waiting-run reconciler escalates past its cap). ENGINE-SCHEDULED: the poll itself runs inside
// reconcileWaitingForHuman under the run lock — merge-outranks-park ordering, the auth gate, and
// the reply application (resumeAfterHumanReply) all live there — so the kernel never walks this
// row; the store's human-question methods drive it through the ledger adapters. Moving the poll
// onto the kernel's lock-free walk is a possible follow-up, deliberately separate from the
// storage cutover. The DOMAIN row (question/answer/external ids) stays in human_questions.
import type { IntentKindDef } from "../registry.ts";

export const humanReplyPollKind: IntentKindDef = {
  kind: "human_reply_poll",
  ordering: "independent",
  consumedBy: "reconciler",
  // Never reached in a healthy system: rows are created `waiting` and driven by the run-locked
  // reply loop. A pending row of this kind is a bug — fail it loudly rather than spin on it.
  deliver: async () => ({ kind: "failed", reason: "human_reply_poll rows are engine-scheduled (waiting) — a pending one is a bug" }),
};
