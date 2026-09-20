// The "why is this run waiting and what would move it" view: one queryable answer assembling a
// run's outstanding DELIVER-lane intents (undelivered source write-backs, pending evidence
// uploads, an unconsumed agent signal, a pending human question) and its armed OBSERVE-lane
// watches (the active step's guards with their live clocks/counters and rescue class, plus the
// engine-universal watches). PURE READS — no locks taken, nothing mutated; the snapshot may be
// a tick stale, which is fine for an introspection surface. Everything here is derived from the
// registries (GuardSpec / BOUNCE_CAP / ENGINE_WATCHES) and the store, so a plugin step's guards
// appear without edits.
import type { StepConfig } from "../config.ts";
import type { Deps } from "./deps.ts";
import type { GuardSpec, Run } from "../types.ts";
import type { RunObligations } from "./obligations-shape.ts";
import { firstStep, stepByName } from "./step.ts";
import { effectiveWatchClock } from "./watches.ts";
import { BOUNCE_CAP } from "../steps/registry.ts";
import { ENGINE_WATCHES } from "../steps/engine-watches.ts";

// The answer's SHAPE lives in obligations-shape.ts (a zero-import leaf the TUI and the explain
// renderer can reach without dragging this module's engine graph); re-exported here so engine-side
// callers keep one import site.
export type { RunObligations } from "./obligations-shape.ts";

/** A guard's rescue class, derived from its declaration — how a park it raised is un-parked. */
export function guardRescueClass(g: GuardSpec): "terminal-signal" | "respawn" | "human" | "none" {
  if (g.autoRescueOnDone) return "terminal-signal";
  if ((g.autoRespawnLimit ?? 0) > 0) return "respawn";
  // exclusive_resource never parks at all; anything else without a rescue declaration is human-only.
  return g.kind === "exclusive_resource" ? "none" : "human";
}

export function runObligations(deps: Deps, run: Run): RunObligations {
  const belt = deps.resolveBelt(run.belt);

  const transitions = deps.store.pendingTransitionsForRun(run.id).map((t) => ({
    toState: t.toState,
    toStatus: t.toStatus,
    attempts: t.attempts,
    nextAttemptAt: t.nextAttemptAt,
    suspended: t.suspendedAt !== null,
    lastError: t.lastError,
    staleUnhandled: t.staleAt !== null && t.staleHandledAt === null,
  }));
  const evidenceUploads = deps.store
    .listIntents(deps.config.repoName, { kind: "evidence_publish", status: "pending", runId: run.id })
    .map((i) => {
      let keyPrefix = "";
      try {
        keyPrefix = (JSON.parse(i.payload) as { keyPrefix?: string }).keyPrefix ?? "";
      } catch {
        /* introspection only — a bad payload just shows an empty prefix */
      }
      return { keyPrefix, attempts: i.attempts, nextAttemptAt: i.nextAttemptAt, suspended: i.suspendedAt !== null, errorKind: i.errorClass as string | null, lastError: i.lastError };
    });
  const sig = deps.store.unconsumedPendingSignalForRun(run.id);
  const q = deps.store.pendingHumanQuestionForRun(run.id);
  const ledger = deps.store
    .listIntents(deps.config.repoName, { runId: run.id })
    .filter((i) => i.status === "pending" || i.status === "waiting" || (i.handoffAt !== null && i.consumedAt === null))
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      status: i.status,
      nextAttemptAt: i.nextAttemptAt,
      suspended: i.suspendedAt !== null,
      deadlineAt: i.deadlineAt,
      handoffOwed: i.handoffAt !== null && i.consumedAt === null,
      lastError: i.lastError,
    }));

  // The step under watch: the active one, or the belt's first while the claim's dispatch is pending.
  const watched: StepConfig | undefined = belt
    ? run.step
      ? stepByName(belt, run.step)
      : run.phase === "claiming"
        ? firstStep(belt)
        : undefined
    : undefined;
  const rs = watched ? deps.store.getRunStep(run.id, watched.name) : undefined;

  const guards = (watched?.guards ?? []).map((g) => {
    const facts: Record<string, string | number | boolean | null> = {};
    switch (g.kind) {
      case "budget": {
        const clock = rs ? effectiveWatchClock(deps, rs, "budget") : { basedAt: null };
        facts.startedAt = clock.basedAt;
        facts.budgetSeconds = watched!.budgetSeconds;
        facts.deadlineAt = clock.basedAt != null ? clock.basedAt + watched!.budgetSeconds : null;
        break;
      }
      case "heartbeat": {
        const clock = rs ? effectiveWatchClock(deps, rs, "heartbeat") : { basedAt: null };
        facts.lastProgressAt = clock.basedAt;
        facts.stallSeconds = deps.config.limits.stallSeconds;
        facts.stallsAt = clock.basedAt != null ? clock.basedAt + deps.config.limits.stallSeconds : null;
        break;
      }
      case "read_only": {
        const clock = rs ? effectiveWatchClock(deps, rs, "read_only") : { sig: null, basedAt: null };
        facts.baselineSig = clock.sig ?? null;
        facts.frozenAt = clock.basedAt ?? null; // null = still tracking (absorbing handoff commits)
        break;
      }
      case "layout_wait":
        facts.waitingSince = rs?.dispatchedAt == null ? (rs?.startedAt ?? null) : null; // null once dispatched
        facts.windowSeconds = deps.config.limits.layoutWaitSeconds;
        facts.respawnsUsed = deps.store.guardCounter(run.id, watched!.name, g.kind);
        facts.respawnLimit = g.autoRespawnLimit ?? 0;
        break;
      case "capture_cap":
        facts.attempts = deps.store.guardCounter(run.id, watched!.name, g.kind);
        facts.cap = deps.config.limits.maxCaptureAttempts;
        break;
      case "exclusive_resource":
        facts.resource = g.resourceName ?? null;
        break;
      default: {
        // A plugin watch: surface its watch_state generically (sig + clock; richer facts live in
        // the row's meta, which the watch owns).
        const ws = rs ? deps.store.getWatchState(rs.runId, rs.step, g.kind) : undefined;
        facts.sig = ws?.sig ?? null;
        facts.basedAt = ws?.basedAt ?? null;
        break;
      }
    }
    return { kind: g.kind, escalationReason: g.escalationReason, rescue: guardRescueClass(g), facts };
  });

  const engine = ENGINE_WATCHES.map((w) => {
    const facts: Record<string, string | number | null> =
      w.kind === "pane_liveness"
        ? { paneId: rs?.paneId ?? null, absentAt: rs?.absentAt ?? null }
        : { pass: rs?.pass ?? null, dispatchedAt: rs?.dispatchedAt ?? null };
    return { kind: w.kind, watches: w.watches, rescue: w.rescue, facts };
  });

  // The proactive idle nudge's episode (watch_state row, not a declared guard — it never parks).
  // `sig` is set only once the nudge has actually been sent, so its row-updated time IS the nudge.
  const nudgeRow = watched ? deps.store.getWatchState(run.id, watched.name, "idle_nudge") : undefined;
  const idleNudge =
    nudgeRow && (nudgeRow.basedAt != null || nudgeRow.sig != null)
      ? { idleSince: nudgeRow.basedAt, nudgedAt: nudgeRow.sig != null ? nudgeRow.updatedAt : null }
      : null;

  const maxBounces = belt?.maxBounces ?? deps.config.limits.maxBounces;
  const bounceCaps = (belt?.steps ?? [])
    .map((s) => ({ step: s.name, count: deps.store.guardCounter(run.id, s.name, BOUNCE_CAP.guard), max: maxBounces }))
    .filter((b) => b.count > 0);

  return {
    run: {
      id: run.id,
      key: run.ticketKey,
      phase: run.phase,
      step: run.step,
      belt: run.belt,
      workSource: run.workSource,
      prNumber: run.prNumber,
      resolverActive: run.resolverActive,
      attentionReason: run.attentionReason,
      attentionReasonCode: run.attentionReasonCode,
    },
    intents: {
      transitions,
      evidenceUploads,
      pendingSignal: sig ? { signal: sig.signal, step: sig.step, toStep: sig.toStep, createdAt: sig.createdAt } : null,
      humanQuestion: q ? { id: q.id, step: q.step, posted: q.externalId !== null, pollAttempts: q.pollAttempts, pollErrors: q.pollErrors, nextPollAt: q.nextPollAt } : null,
      ledger,
    },
    watches: { step: watched?.name ?? null, guards, engine, bounceCaps, idleNudge },
  };
}
