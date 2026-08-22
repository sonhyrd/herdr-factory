// The SHAPE of the "why is this run waiting and what would move it" answer, split from its
// computation (obligations.ts) the same way update-status.ts splits the update READER from the
// update executor: the shape is a data contract consumed by leaves — the explain renderer, the
// TUI's bare-fetch client, the HTTP route's response — while the computation drags the engine
// graph (step registry, watches, telemetry). A ZERO-IMPORT leaf on purpose: the TUI's eager
// startup graph (test/tui-startup-graph.test.ts) may reach this file, never obligations.ts.

export interface RunObligations {
  run: {
    id: number;
    key: string;
    phase: string;
    step: string | null;
    belt: string | null;
    workSource: string | null;
    prNumber: number | null;
    resolverActive: boolean;
    attentionReason: string | null;
    attentionReasonCode: string | null;
  };
  /** Deliver-lane: durable intents the engine still owes the world for this run. `suspended` =
   *  the row failed its 10-attempt window and stopped retrying until an operator (`s` /
   *  `retry-now`) or a cause-recovery probe clears it. */
  intents: {
    transitions: { toState: string; toStatus: string; attempts: number; nextAttemptAt: number; suspended: boolean; lastError: string | null; staleUnhandled: boolean }[];
    evidenceUploads: { keyPrefix: string; attempts: number; nextAttemptAt: number; suspended: boolean; errorKind: string | null; lastError: string | null }[];
    pendingSignal: { signal: string; step: string | null; toStep: string | null; createdAt: number } | null;
    humanQuestion: { id: number; step: string | null; posted: boolean; pollAttempts: number; pollErrors: number; nextPollAt: number } | null;
    /** Live ledger rows (pending/waiting) + resolved ones whose run reaction is still owed. */
    ledger: { id: number; kind: string; status: string; nextAttemptAt: number; suspended: boolean; deadlineAt: number | null; handoffOwed: boolean; lastError: string | null }[];
  };
  /** Observe-lane: what is watching the run right now. */
  watches: {
    /** The step whose guards are armed (the active step, or the first step while claiming). */
    step: string | null;
    guards: {
      kind: string;
      escalationReason: string;
      rescue: string;
      /** Live facts per kind: budget/layout_wait clocks, heartbeat progress, read-only baseline,
       *  counter positions — whatever the guard measures, keyed by fact name. */
      facts: Record<string, string | number | boolean | null>;
    }[];
    /** Engine-universal watches (pane liveness, pass staleness) with their live facts. */
    engine: { kind: string; watches: string; rescue: string; facts: Record<string, string | number | null> }[];
    /** Bounce-cap counters (keyed by TARGET step) that have counted at least one bounce. */
    bounceCaps: { step: string; count: number; max: number }[];
  };
}
