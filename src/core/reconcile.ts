import { arbitrateClaim, releaseClaim } from "./claim-guard.ts";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import { createEvidencePublisher } from "../clients/evidence.ts";
import { runEffect } from "../runtime/effect.ts";
import { HerdrUnreachableError, type BeltRuntime, type Deps, type SourceRuntime } from "./deps.ts";
import type { LayoutAgent, StepConfig } from "../config.ts";
import type { BeltEffectTrigger, GuardSpec, HumanQuestion, HumanReply, MatchItem, Outcome, PrInfo, PrSnapshot, ReviewSig, Run, RunStep, Ticket, TransitionIntent, WorkState } from "../types.ts";
import { EFFECT_PRODUCE_PRODUCTS, effectRank, isReadyForInput, outcomeToWorkState, StaleItemError, ticketOf, type TransitionContext } from "../types.ts";
import { isUniqueViolation } from "../db/store.ts";
import { availableMemoryMb, capacityGate, claimDeferralNote, memoryGate, noteMachineGate } from "../machine.ts";
import { MAX_RETRY_ATTEMPTS, notifyDue } from "../schedule.ts";
import { branchName } from "./branch.ts";
import { fmtDur } from "./explain.ts";
import { killPortListeners, readRunPort } from "./dev-server.ts";
import { protectedBranches, runBranchNames, syncRunBranch } from "./run-branch.ts";
import { firstStep, indexOfStep, materializeWork, MEMORY_DIR, nextStep, scrubCommittedMemoryDir, spawnStep, stepByName } from "./step.ts";
import { BOUNCE_CAP, CAPTURE_CAP_GUARD, guardsResetOn, STEP_DESCRIPTORS } from "../steps/registry.ts";
import { adoptLayoutAgent, deriveAgentName } from "./layout.ts";
import { pruneLayoutToBelt, resolveBeltLayout } from "./layout-match.ts";
import { applyWatchRebase, evaluateStepWatches } from "./watches.ts";
import { checkStepTree, recordTreeRefusal } from "./tree-guard.ts";
import { reportToPane, showRunPane, type PaneRunState } from "./pane-display.ts";
import { PANE_ABSENCE_CONFIRM_SECONDS } from "../steps/engine-watches.ts";
import { flushOutbox, type OutboxFlow } from "./outbox.ts";
import { consumeIntentHandoffs, ledgerFlow, notifySuspended } from "./ledger.ts";
import { INTENT_KINDS } from "../intents/registry.ts";
import { wakeResolver } from "./watch.ts";
import { observeEvidenceHead, verificationSteps } from "./evidence-head.ts";
import { fixBrief, HF_REVIEW_WATCH, MAX_SELF_CHECKS, parseVerdict, readHfReview, selfCheckNote, wantsFix, writeHfReview, type HfReview } from "./review-verdict.ts";
import { recordSourceAuthEvent, recordTick, recordTickDuration, recordTickLockSkipped, telemetryEvent, telemetrySpan } from "../telemetry/index.ts";
import { isSourceUnauthenticated, type SourceUnauthenticatedError } from "../auth/errors.ts";
import { getAuthFailure, markAuthNotified, recordAuthFailure, recordAuthOk } from "../auth/gate.ts";
import { clearRateLimit, getRateLimit, isSourceRateLimited, markRateLimitNotified, recordRateLimited, type SourceRateLimitedError } from "./rate-limit-gate.ts";
import { githubCallCounts } from "../clients/github-budget.ts";

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- work-source auth gate (resilience: pause + auto-resume, never haywire) -------------------
// A work source that can't authenticate (missing creds, or a live 401/403 → SourceUnauthenticatedError)
// must not silently vanish (the poll path used to degrade to []) or retry forever (the outbox). These
// two helpers record the gate state (src/auth/gate.ts — surfaced on the dashboard + doctor), notify the
// operator ONCE per source (throttled by attentionRenotifySeconds, mirroring the AWS-SSO evidence path),
// and — on recovery — re-queue the source's held write-backs so a restored session catches up promptly.
// Claiming/outbox/human-poll all call these; auto-resume falls out of the normal tick the moment a call
// to the source succeeds again.

/** Record + (throttled) notify that a work source is unauthenticated. Idempotent per source. */
async function noteSourceAuthFailure(deps: Deps, source: string, e: SourceUnauthenticatedError): Promise<void> {
  const repo = deps.config.repoName;
  const detail = e.hint ?? e.message;
  const wasDown = getAuthFailure(repo, source) !== undefined;
  recordAuthFailure(repo, source, { reason: e.reason, detail, now: deps.now() });
  // Record on the problem ledger (the dashboard's red repo light reads it — never re-checks): the
  // cause key matches the source's intent causeScope, so gate and delivery failures agree on one row.
  deps.store.reportProblem(repo, `source:${source}`, "auth", `${source}: ${detail}`);
  if (!wasDown) {
    deps.log("warn", `${source}: work source not authenticated (${e.reason}) — pausing its claims + status write-backs until re-authenticated`);
    telemetryEvent("source.auth.unauthenticated", { "work.source": source, "auth.reason": e.reason });
    recordSourceAuthEvent({ "work.source": source, "auth.state": "unauthenticated", "auth.reason": e.reason });
  }
  const f = getAuthFailure(repo, source)!;
  if (notifyDue(f.notifiedAt, deps.config.limits.attentionRenotifySeconds, deps.now())) {
    await deps.herdr
      .notify(
        `herdr-factory: ${source} not authenticated`,
        `Work source "${source}" can't authenticate: ${detail}. Its claims + status write-backs are paused; they resume automatically once it's authenticated again.`,
      )
      .catch(() => {});
    markAuthNotified(repo, source, deps.now());
  }
}

/** A source call SUCCEEDED — clear any auth failure. On recovery, re-queue held write-backs + notify.
 *  The problem-ledger clear runs UNCONDITIONALLY (a PK delete, cheap): the in-memory gate resets on
 *  restart, so it alone cannot be trusted to clear a persisted problem row from a previous life. */
function noteSourceAuthRecovered(deps: Deps, source: string): void {
  const repo = deps.config.repoName;
  const clearedProblem = deps.store.clearProblem(repo, `source:${source}`);
  if (clearedProblem) deps.log("info", `${source}: auth problem cleared on the problem ledger`);
  if (!recordAuthOk(repo, source)) return; // wasn't down — the common, hot path
  const requeued = deps.store.retryTransitionsForSource(repo, source);
  deps.log("info", `${source}: re-authenticated — resuming work${requeued ? ` (${requeued} held write-back(s) re-queued)` : ""}`);
  telemetryEvent("source.auth.recovered", { "work.source": source, "transition.requeued": requeued });
  recordSourceAuthEvent({ "work.source": source, "auth.state": "recovered" });
  void deps.herdr.notify(`herdr-factory: ${source} re-authenticated`, `Work source "${source}" is authenticated again — paused work is resuming.`).catch(() => {});
}

// --- work-source rate-limit gate (back off until the backend's own reset) ---------------------
// GitHub's primary limit is per ACCOUNT: several hosts sharing one `gh` login spend one 5,000/hr
// budget, so once the backend answers 403/429 with an exhausted budget, re-polling next tick is
// both futile and part of what keeps it exhausted. These two helpers hold the source until the
// reset stamp it named (core/rate-limit-gate.ts — an in-memory hold, like the auth gate) and
// mirror it onto the PROBLEM LEDGER, which is what `status`/`explain` read out of process.

/** The problem-ledger key for a source's rate-limit hold. Distinct from the auth gate's
 *  `source:<name>` so a backoff can never clear (or be cleared by) an auth problem. */
const rateLimitProblemKey = (source: string): string => `source:${source}:rate-limit`;

/** Record + (throttled) notify that a work source is rate-limited until `resetAt`. */
async function noteSourceRateLimited(deps: Deps, source: string, e: SourceRateLimitedError): Promise<void> {
  const repo = deps.config.repoName;
  const now = deps.now();
  const until = Math.max(now + 1, Math.ceil(e.resetAtMs / 1000));
  const wasHeld = getRateLimit(repo, source, now) !== undefined;
  recordRateLimited(repo, source, { until, detail: e.detail, exhausted: e.exhausted, now });
  const held = getRateLimit(repo, source, now)!;
  deps.store.reportProblem(repo, rateLimitProblemKey(source), "rate_limit", `${source}: rate limited — holding polls for ${held.until - now}s. ${e.detail}`);
  if (!wasHeld) {
    deps.log("warn", `${source}: rate limited — holding its polls for ${held.until - now}s (until the backend's own reset). ${e.detail}`);
    telemetryEvent("source.rate_limit.held", { "work.source": source, "rate_limit.until": held.until, "rate_limit.exhausted": e.exhausted });
  }
  if (notifyDue(held.notifiedAt, deps.config.limits.attentionRenotifySeconds, now)) {
    await deps.herdr
      .notify(
        `herdr-factory: ${source} rate limited`,
        `Work source "${source}" hit its API rate limit: ${e.detail} Polls and write-backs resume automatically at the reset.`,
      )
      .catch(() => {});
    markRateLimitNotified(repo, source, now);
  }
}

/** A source call SUCCEEDED — release any hold. The problem-ledger clear runs UNCONDITIONALLY (a PK
 *  delete, cheap): the in-memory hold resets on restart, so it alone cannot be trusted to clear a
 *  persisted row from a previous life. */
function noteSourceRateLimitCleared(deps: Deps, source: string): void {
  const repo = deps.config.repoName;
  deps.store.clearProblem(repo, rateLimitProblemKey(source));
  if (!clearRateLimit(repo, source)) return; // wasn't held — the common, hot path
  deps.log("info", `${source}: rate limit cleared — polls resuming`);
  telemetryEvent("source.rate_limit.cleared", { "work.source": source });
}

// --- source status write-backs (the transition outbox) -----------------------
// A transition is an INTENT persisted until the source confirms it, not a one-shot call: run
// phases advance regardless (a flaky Jira must never wedge the pipeline), and the outbox retries
// every 30s (suspending + flagging at MAX_RETRY_ATTEMPTS) until the status of record converges
// or an operator steps in. Without this, a dropped in_development
// transition left the ticket To Do — and since eligibility queries by status, the ticket would be
// claimed AGAIN after teardown and the merged work re-done.

/** One delivery attempt for an intent. `applied`/`noop` mark it delivered; `stale` (the item is
 *  gone — deleted/transferred; retrying cannot help) ALSO marks it delivered but stamps stale_at
 *  for the run-locked Phase A stale policy. This function is called LOCK-FREE from the Phase 0
 *  outbox flush, so it must never mutate the run itself — only the intent row + events.
 *  On a throw it records the attempt (suspending at the cap) and returns false (throw = retry me). */
async function deliverTransition(deps: Deps, src: SourceRuntime, intent: TransitionIntent): Promise<boolean> {
  try {
    // The run's belt's pickup label, so a label-driven source can clear what listEligible filtered
    // on (INV-1; github_issues consumes the trigger label on in_development). Lock-free read — the
    // run row is only read here, never mutated. Undefined when the belt was renamed/removed (a
    // stranded run, INV-9) or the source has no label concept; the source treats that as "nothing
    // to clear". Terminal transitions don't use it (they strip state labels + close).
    const run = deps.store.getRun(intent.runId);
    const pickupLabel = deps.resolveBelt(run?.belt ?? null)?.label;
    // A merge write-back gets the PR facts, so an internal-ledger source (sentry) can note "fixed by
    // PR" on the item. Built here because only the engine knows the run's PR number + the GitHub repo;
    // every other source ignores it. May be undefined (a retried intent for an ended run has no PR).
    const ctx: TransitionContext | undefined =
      intent.toState === "merged" && run?.prNumber != null
        ? { prNumber: run.prNumber, prUrl: deps.ghRepo ? `https://github.com/${deps.ghRepo}/pull/${run.prNumber}` : null }
        : undefined;
    // A belt effect's source-native status (toStatus) is delivered INSTEAD of the canonical mapping
    // for to_state ('' ⇒ the canonical mapping, unchanged). The source validated it at config-load.
    const statusOverride = intent.toStatus || undefined;
    const result = await src.client.transition(intent.ticketKey, intent.toState, pickupLabel, ctx, statusOverride);
    noteSourceAuthRecovered(deps, src.name); // delivery succeeded ⇒ auth is fine (clears any gate)
    noteSourceRateLimitCleared(deps, src.name); // …and the budget is back (releases the poll hold)
    switch (result.kind) {
      case "applied":
        deps.store.markTransitionDelivered(intent.id);
        deps.store.recordEvent({
          runId: intent.runId,
          repo: intent.repo,
          ticketKey: intent.ticketKey,
          type: "transition",
          detail: { to: intent.toState, status: intent.toStatus || undefined, attempts: intent.attempts },
        });
        break;
      case "noop":
        deps.store.markTransitionDelivered(intent.id); // already there / unmapped / automation won the race
        break;
      case "stale": {
        const detail = result.detail ?? "item no longer exists at the source";
        deps.store.markTransitionStale(intent.id, detail);
        deps.store.recordEvent({
          runId: intent.runId,
          repo: intent.repo,
          ticketKey: intent.ticketKey,
          type: "stale",
          detail: { to: intent.toState, reason: detail },
        });
        // An ended (or already tearing-down) run needs no policy reaction — consume the flag here
        // so Phase A never sees it. Reading the run lock-free is fine; only mutation is not.
        const curRun = deps.store.getRun(intent.runId);
        if (!curRun || curRun.endedAt !== null || curRun.phase === "done" || curRun.phase === "tearing_down") {
          deps.store.markTransitionStaleHandled(intent.id);
          deps.log("warn", `${intent.ticketKey}: ${intent.toState} write-back found the item gone (${detail}) — run already ${curRun?.phase ?? "gone"}, nothing to do`);
        } else {
          deps.log("warn", `${intent.ticketKey}: ${intent.toState} write-back found the item gone (${detail}) — stale policy will handle the run`);
        }
        break;
      }
    }
    return true;
  } catch (e) {
    // An auth failure here is a PAUSE, not a lost write-back: record + notify (once) so the operator
    // knows why the status isn't moving. The intent stays queued and re-queues promptly on recovery
    // (retryTransitionsForSource) instead of waiting out its retry interval.
    // Same posture for a rate limit: the intent stays queued, and recording the hold stops the
    // poll path from spending what little budget is left before this write-back can land.
    if (isSourceUnauthenticated(e)) await noteSourceAuthFailure(deps, src.name, e);
    else if (isSourceRateLimited(e)) await noteSourceRateLimited(deps, src.name, e);
    const after = deps.store.recordTransitionAttempt(intent.id, err(e));
    // The attempt that crossed MAX_RETRY_ATTEMPTS suspended the row (the store stamps it): the
    // write-back stops retrying — and keeps vetoing a re-claim of the item — until an operator
    // (`s` / retry-now) or the source's auth-recovery requeue clears it. Say so loudly, once.
    if (after.suspendedAt != null && intent.suspendedAt == null) {
      deps.log("error", `${intent.ticketKey}: ${intent.toState} write-back SUSPENDED after ${after.attempts} failed attempts: ${err(e)}`);
      await notifySuspended(deps, "source_transition", { id: after.id, runId: after.runId, ticketKey: after.ticketKey }, err(e));
      return false;
    }
    deps.log(
      "warn",
      `${intent.ticketKey}: ${intent.toState} transition deferred (attempt ${after.attempts} of ${MAX_RETRY_ATTEMPTS}, retry in ${after.nextAttemptAt - deps.now()}s): ${err(e)}`,
    );
    return false;
  }
}

/** Enqueue a transition intent and try to deliver it immediately (the common, healthy path — the
 *  status moves on the same tick it used to). Skips the immediate attempt when an EARLIER intent
 *  for the run is still undelivered: per-run delivery is strictly in-order, else a retried
 *  in_development could fire after in_review already landed and walk the source backward.
 *  `toStatus` (a belt effect's source-native status key) rides alongside the canonical `to` anchor;
 *  '' ⇒ the canonical mapping. */
async function requestTransition(deps: Deps, run: Run, src: SourceRuntime, to: WorkState, toStatus = ""): Promise<void> {
  const intent = deps.store.enqueueTransition({
    runId: run.id,
    repo: deps.config.repoName,
    workSource: src.name,
    ticketKey: run.ticketKey,
    toState: to,
    toStatus,
  });
  if (deps.store.undeliveredTransitionBefore(run.id, intent.id)) {
    deps.log("warn", `${run.ticketKey}: ${to}${toStatus ? `/${toStatus}` : ""} transition queued behind an undelivered earlier transition`);
    return;
  }
  await deliverTransition(deps, src, intent);
}

/**
 * Fire the belt's configured effect for a trigger, else the engine `defaultTo` (unchanged behavior
 * when a belt declares no effect for the trigger). FORWARD-ONLY: an effect whose monotonicity rank
 * is BELOW the highest rank already enqueued for the run is a noop — so a bounce re-entry / forward
 * re-advance can never walk the source backward (the outbox re-open on enqueue would otherwise
 * re-deliver an earlier transition). Routes through the outbox exactly like every transition.
 * `defaultTo` omitted ⇒ no engine default: fire only if the belt configured this trigger.
 */
async function fireEffect(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  trigger: BeltEffectTrigger,
  defaultTo?: WorkState,
): Promise<void> {
  const configured = (belt.effects ?? []).find((e) => sameTrigger(e.trigger, trigger));
  const target: { to: WorkState; status?: string } | undefined = configured
    ? { to: configured.to, status: configured.status }
    : defaultTo != null
      ? { to: defaultTo }
      : undefined;
  if (!target) return; // no belt effect + no engine default for this trigger
  const rank = effectRank(target);
  // Highest rank already enqueued for the run (delivered or pending). Equal ranks are allowed (a
  // custom status and its anchor at the same stage), so only a STRICTLY-lower rank is a backward noop.
  const maxRank = deps.store
    .transitionTargetsForRun(run.id)
    .reduce((m, t) => Math.max(m, effectRank({ to: t.toState, status: t.toStatus || undefined })), Number.NEGATIVE_INFINITY);
  if (rank < maxRank) {
    deps.log("info", `${run.ticketKey}: effect → ${target.status ?? target.to} skipped (would move backward, rank ${rank} < ${maxRank})`);
    return;
  }
  await requestTransition(deps, run, src, target.to, target.status ?? "");
}

/** Structural equality of two belt-effect triggers (the config effect vs the fire-site trigger). */
function sameTrigger(a: BeltEffectTrigger, b: BeltEffectTrigger): boolean {
  if (a.on !== b.on) return false;
  if (a.on === "enter" && b.on === "enter") return a.step === b.step;
  if (a.on === "produce" && b.on === "produce") return a.product === b.product;
  if (a.on === "teardown" && b.on === "teardown") return a.outcome === b.outcome;
  return false;
}

/** The source status write-backs (transition outbox) as a flush flow: retry every due undelivered
 *  intent, strictly in-order per run. */
function transitionOutboxFlow(deps: Deps): OutboxFlow<TransitionIntent> {
  return {
    name: "transition outbox",
    due: () => deps.store.dueTransitions(deps.config.repoName),
    attempt: async (intent) => {
      const src = deps.resolveSource(intent.workSource);
      if (!src) {
        // Source removed from config — the intent can never deliver; close it out loudly rather
        // than retrying forever against nothing.
        deps.store.recordTransitionAttempt(intent.id, `work source "${intent.workSource}" no longer configured`);
        deps.store.markTransitionDelivered(intent.id);
        deps.log("warn", `${intent.ticketKey}: dropping ${intent.toState} write-back — source "${intent.workSource}" is gone`);
        return;
      }
      // In-order per run, checked against the DB (not just this pass): an earlier sibling that is
      // undelivered but backed off (not due) must still block this one — delivering out of order
      // would let a retried in_development land after in_review and walk the source backward.
      if (deps.store.undeliveredTransitionBefore(intent.runId, intent.id)) return;
      await deliverTransition(deps, src, intent);
    },
  };
}

/** The Phase 0 outbox flows, in delivery order: status write-backs first (they gate claiming — the
 *  known-stale-eligibility veto — so they converge before anything else), then the intent ledger
 *  (the generic kernel every other durable intent now lives on). */
function outboxFlows(deps: Deps): OutboxFlow<unknown>[] {
  return [transitionOutboxFlow(deps), ledgerFlow(deps)];
}

/** Retry every due undelivered transition intent (in per-run order, stopping a run's chain at its
 *  first failure). Runs at the top of each tick so write-backs converge even while the repo is at
 *  capacity or the affected runs are parked/ended. */
export async function flushTransitionOutbox(deps: Deps): Promise<void> {
  return flushOutbox(deps, transitionOutboxFlow(deps));
}

/** Phase 0 as a callable unit: one flush pass over every registered durable-intent outbox, isolating
 *  a failing flow so it can't starve the others. The tick's own Phase 0, and also what the operator
 *  due-now paths (`retry-now`) run straight after re-queueing — the point of clearing suspensions
 *  and due times is that the rows land now, not on the next tick. LOCK-FREE by the OutboxFlow
 *  contract, but callers
 *  outside the tick must still hold the repo tick lock so two passes never walk the same rows. */
export async function flushDurableIntents(deps: Deps): Promise<void> {
  for (const flow of outboxFlows(deps)) {
    try {
      await flushOutbox(deps, flow);
    } catch (e) {
      deps.log("error", `${flow.name} flush failed: ${err(e)}`);
    }
  }
}

/**
 * Acquire lock `key`, run `fn` under it with a keep-alive heartbeat, then release. Returns false
 * (fn not run) when the lock is already held.
 *
 * The heartbeat re-extends the TTL every ttl/3 while `fn` is in flight: the event loop stays free
 * during awaited subprocesses/fetches, so a long-but-ALIVE holder keeps its lock no matter how
 * slow the pass gets (at 50-100 active runs a healthy tick can legitimately outlive any fixed
 * TTL — under the old fixed-TTL scheme that expiry mid-tick reopened the concurrent-reconcile /
 * double-spawn window the lock exists to close). Extensions stop the moment the process dies —
 * crash, kill, or the supervisor's wedged-tick watchdog restart — and the TTL then expires
 * normally, so a dead holder still recovers within one TTL. The owner token is unique per
 * ACQUISITION (not per process): two contexts in one process can never mistake each other's hold
 * for their own.
 */
let lockSeq = 0; // per-process acquisition counter (deps.uid() is reserved for branch suffixes)

async function withHeartbeatLock(deps: Deps, key: string, ttlSec: number, fn: () => Promise<void>): Promise<boolean> {
  const owner = `pid:${process.pid}:${++lockSeq}`;
  if (!deps.store.acquireLock(key, owner, ttlSec)) return false;
  const timer = setInterval(
    () => {
      try {
        if (!deps.store.extendLock(key, owner, ttlSec)) {
          // The lock is no longer ours: the TTL lapsed (e.g. an event-loop stall starved the
          // heartbeat past it) and another actor stole the lock. `fn` is already mid-flight and
          // can't be safely aborted — but the loss must be LOUD, because from here this pass may
          // be racing the new holder on the same run/repo. Stop beating (re-extending would rip
          // the lock back out from under the new holder mid-pass); the owner-scoped release in
          // the finally is a no-op against the stolen row, so the new holder is undisturbed.
          clearInterval(timer);
          deps.log("error", `lock ${key} lost mid-hold (owner ${owner}) — a concurrent holder may be reconciling the same target`);
          telemetryEvent("store.lock.lost", { "lock.name": key, "lock.owner": owner });
        }
      } catch {
        /* next beat retries; TTL expiry is the backstop */
      }
    },
    Math.max(5_000, (ttlSec * 1000) / 3),
  );
  try {
    await fn();
  } finally {
    clearInterval(timer);
    deps.store.releaseLock(key, owner);
  }
  return true;
}

/**
 * withHeartbeatLock + a bounded poll-wait: keep re-trying the acquire until `fn` runs or the wait
 * is spent. For a lock whose holders release within SECONDS, where a plain try-lock is not merely
 * lossy but UNFAIR — callers that contend on a fixed cadence and in a fixed order (the serve
 * loop's per-repo ticks) have the same loser every round, so the same repo skips forever.
 */
async function withHeartbeatLockWaiting(deps: Deps, key: string, ttlSec: number, tries: number, delayMs: number, fn: () => Promise<void>): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await withHeartbeatLock(deps, key, ttlSec, fn)) return true;
    if (i < tries - 1) await deps.sleep(delayMs);
  }
  return false;
}

const tickLockTtl = (deps: Deps): number => Math.max(deps.config.limits.tickIntervalSeconds * 2, 300);

/** Machine-wide: serializes every repo's machine-count + claim section when machine.yml sets a cap. */
export const MACHINE_CLAIM_LOCK = "machine:claim";

/** How long Phase B waits for the machine claim lock before deferring its claims, in 500 ms polls:
 *  HALF a tick interval, floor 10 s. Half, so the pass still finishes well inside its own interval
 *  and the next tick is never skipped for waiting; a whole interval's worth of holders is what the
 *  old try-lock silently lost anyway. It scales with the tick because the number of repos sharing
 *  the lock does: a claim section is a count plus at most `max_claims_per_tick` claims — seconds
 *  each — and a flat 10 s is already thin for six repos on a 60 s tick. */
const MACHINE_CLAIM_POLL_MS = 500;
const machineClaimWaitTries = (deps: Deps): number =>
  Math.max(1, Math.round(Math.max(10_000, (deps.config.limits.tickIntervalSeconds * 1000) / 2) / MACHINE_CLAIM_POLL_MS));

/**
 * Run `fn` under the per-repo single-instance tick lock (heartbeat-extended; see
 * withHeartbeatLock); returns true if it ran, false if a tick is already mid-flight.
 * Shared by the `tick` command and the server's periodic loop.
 */
export async function withTickLock(deps: Deps, fn: () => Promise<void>): Promise<boolean> {
  return telemetrySpan("tick.lock", { repo: deps.config.repoName }, async (span) => {
    const ttl = tickLockTtl(deps);
    const startedAt = Date.now();
    const ran = await withHeartbeatLock(deps, `tick:${deps.config.repoName}`, ttl, fn);
    span.setAttribute("lock.acquired", ran);
    if (!ran) {
      recordTick(false, { repo: deps.config.repoName, "tick.skip_reason": "lock_held" });
      recordTickLockSkipped({ repo: deps.config.repoName });
      return false;
    }
    recordTickDuration(Date.now() - startedAt, { repo: deps.config.repoName });
    recordTick(true, { repo: deps.config.repoName });
    return true;
  });
}

/** Per-run lock TTL. A single run's reconcile is bounded by the item-1 exec/fetch timeouts;
 *  the heartbeat covers the legitimately-slow tail (worktree create, attachment downloads). */
const RUN_LOCK_TTL_SECONDS = 300;

/**
 * Run `fn` under `run:<id>` — the mutual exclusion for everything that MUTATES one run: the
 * tick's Phase A reconcile of that run, and the event nudges (step-done / bounce / ask-human /
 * resume). Per-run locks are what let a nudge land IMMEDIATELY while a long tick is mid-pass
 * (the old design serialized nudges behind the whole repo-wide tick lock, so at scale every
 * advance degraded to tick latency): a nudge only contends with work on its own run.
 * Returns false (fn not run) when the run is being reconciled by someone else right now.
 */
export async function withRunLock(deps: Deps, runId: number, fn: () => Promise<void>): Promise<boolean> {
  return telemetrySpan("run.lock", { repo: deps.config.repoName, "run.id": runId }, async (span) => {
    const ran = await withHeartbeatLock(deps, `run:${runId}`, RUN_LOCK_TTL_SECONDS, fn);
    span.setAttribute("lock.acquired", ran);
    return ran;
  });
}

/**
 * withRunLock + a bounded wait (~15s), returning `fn`'s result. For the NON-monotonic run
 * mutations that must not be dropped on contention: a bounce rewinds `run.step` AND re-dispatches
 * a pane, ask-human flips the phase to waiting_for_human, resume un-parks — a concurrent
 * reconcile working from a stale pre-mutation snapshot would respawn/double-spawn the wrong step
 * or overwrite the phase flip (the old unserialized ask-human could orphan its question forever).
 * step-done stays fire-and-forget (a monotonic flag whose stale read only defers an idempotent
 * advance). Returns { ran: false } when the run stays busy past the wait — caller reports "busy".
 */
export async function withRunLockWaiting<T>(
  deps: Deps,
  runId: number,
  fn: () => Promise<T>,
  opts: { tries?: number; delayMs?: number } = {},
): Promise<{ ran: boolean; result?: T }> {
  const tries = opts.tries ?? 30;
  const delayMs = opts.delayMs ?? 500;
  for (let i = 0; i < tries; i++) {
    let result: T | undefined;
    const ran = await withRunLock(deps, runId, async () => {
      result = await fn();
    });
    if (ran) return { ran: true, result };
    await deps.sleep(delayMs);
  }
  return { ran: false };
}

/** Per-tick shared context. `prSnapshots` is the batched GitHub fetch for every watched PR
 *  (reviewing/attention/waiting_for_human) — one GraphQL request replaces 3 gh calls per run per
 *  tick. Undefined ⇒ the batch fetch failed or the caller is a single-run nudge; per-run fallback
 *  polling applies. */
export interface TickCtx {
  prSnapshots?: Map<number, PrSnapshot>;
}

/** Bulk-fetch PR state + review signatures for every run that watches a PR by number — the
 *  `reviewing`/`attention` watches plus a `waiting_for_human` park that has already adopted a PR
 *  (so a merge that lands while a human question is outstanding still tears the run down). */
async function fetchPrSnapshots(deps: Deps, runs: Run[]): Promise<Map<number, PrSnapshot> | undefined> {
  const numbers = [
    ...new Set(
      runs
        .filter(
          (r) => (r.phase === "reviewing" || r.phase === "attention" || r.phase === "waiting_for_human") && r.prNumber != null,
        )
        .map((r) => r.prNumber!),
    ),
  ];
  if (numbers.length === 0) return new Map();
  try {
    return await deps.github.prSnapshots(deps.ghRepo, numbers);
  } catch (e) {
    deps.log("warn", `batched PR fetch failed (${numbers.length} PRs) — falling back to per-run polling: ${err(e)}`);
    return undefined;
  }
}

/** One reconcile pass: advance active runs, then claim new work up to the cap. */
export async function reconcileRepo(deps: Deps): Promise<void> {
  return telemetrySpan("reconcile.repo", { repo: deps.config.repoName }, () => reconcileRepoImpl(deps));
}

/** One pass, with its GitHub spend reported. The account's rate budget is shared — across belts,
 *  across repos, and (on one `gh` login) across hosts — so "how many calls did a tick cost, and
 *  through which transport" is the only number that lets an operator find who is eating it. */
async function reconcileRepoImpl(deps: Deps): Promise<void> {
  const before = githubCallCounts();
  try {
    await reconcileRepoPhases(deps);
  } finally {
    const after = githubCallCounts();
    const rest = after.rest - before.rest;
    const cli = after.cli - before.cli;
    if (rest + cli > 0) {
      deps.log("info", `github: ${rest + cli} call(s) this tick (${rest} REST, ${cli} gh CLI) — shared with every other host on the same account`);
      telemetryEvent("github.calls_per_tick", { repo: deps.config.repoName, "github.calls.rest": rest, "github.calls.cli": cli });
    }
  }
}

async function reconcileRepoPhases(deps: Deps): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.upsertRepo(repo, deps.config.repo.path, deps.config.repo.baseRef, deps.ghRepo);

  // Phase 0 — flush every registered durable-intent outbox (before anything else, so intents
  // converge even at capacity and for already-ended runs): source status write-backs, then
  // evidence uploads. One failing flow must not starve the others.
  await flushDurableIntents(deps);

  // Phase A — advance everything in flight, in parallel with bounded concurrency (most of a
  // run's reconcile is subprocess/network wait, so the wall-clock of a pass stops growing
  // linearly with the active-run count). Each run is guarded by its own run lock: an event nudge
  // (step-done/bounce/ask-human/resume) holding a run just skips it this pass — that run is
  // being advanced anyway — and nudges for OTHER runs land mid-pass unimpeded.
  const activeRuns = deps.store.activeRuns(repo);
  const ctx: TickCtx = { prSnapshots: await fetchPrSnapshots(deps, activeRuns) };
  await runEffect(
    Effect.forEach(
      activeRuns,
      (run) =>
        Effect.tryPromise({
          try: async () => {
            const ran = await withRunLock(deps, run.id, () => reconcileRun(deps, run, ctx));
            if (!ran) deps.log("info", `${run.ticketKey}: busy (nudge in flight) — skipped this pass`);
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              deps.log("error", `${run.ticketKey}: ${err(e)}`);
              deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "error", detail: { message: err(e) } });
            }),
          ),
        ),
      { concurrency: deps.config.limits.reconcileConcurrency, discard: true },
    ),
  );

  // Phase B — claim new work, behind the host-local machine.yml gate (ARCHITECTURE §7 Phase B). Absent machine.yml
  // ⇒ straight to claimNewWork, exactly as before.
  const machine = deps.machine ?? {};
  // The deferral count describes the repo's MOST RECENT Phase B pass, so every exit that is not a
  // lock deferral clears it. Both gates below return before the lock is even taken: a count left
  // standing by one of them would keep `status`/`explain` reporting a lock race that is not
  // happening — and with `max_active_workspaces` removed from machine.yml, nothing would ever
  // clear it again. Any exit added to Phase B has to keep this invariant.
  const notDeferred = () => void deps.store.recordClaimDeferral(repo, false);
  const lowMemory = memoryGate(machine, deps.availableMemoryMb ?? availableMemoryMb);
  if (lowMemory) {
    // Admission only: running work is untouched — Phase A above already advanced it.
    noteMachineGate(deps.log, lowMemory);
    notDeferred();
    deps.store.touchTick(repo);
    return;
  }
  if (machine.maxActiveWorkspaces === undefined) {
    noteMachineGate(deps.log, null);
    notDeferred();
    return claimNewWork(deps);
  }
  // The machine count and the claims must be one critical section: repos tick on separate timers
  // and Phase B awaits the network between its count and its createRun, so two repos could each
  // read "1/2" and both claim (3/2). The machine claim lock (a DB lock — it also covers a CLI
  // `tick`/`claim` in another process) serializes them. It is WAITED on, not try-locked: `serve`
  // ticks every repo on one cadence and in one order, so a repo that skipped on contention hit
  // the same mid-hold instant every tick and never claimed again (issue #72 — four hours of it).
  const ran = await withHeartbeatLockWaiting(deps, MACHINE_CLAIM_LOCK, tickLockTtl(deps), machineClaimWaitTries(deps), MACHINE_CLAIM_POLL_MS, async () => {
    const occupying = deps.store.countOccupyingAll();
    const atCapacity = capacityGate(machine, occupying);
    noteMachineGate(deps.log, atCapacity);
    if (atCapacity) {
      deps.store.touchTick(repo);
      return;
    }
    await claimNewWork(deps, machine.maxActiveWorkspaces! - occupying);
  });
  // Deferring is now the rare tail (a holder that outlived the whole wait), and the starvation it
  // used to hide was silent — so the consecutive count is durable and reported by status/explain.
  // Reaching the claim section at all clears it, capacity gate included: being full is not losing
  // a race, and `describeMachine` already says so on its own line.
  if (ran) {
    notDeferred();
    return;
  }
  const deferrals = deps.store.recordClaimDeferral(repo, true);
  deps.log("info", `machine claim lock held (another repo is claiming) — ${claimDeferralNote(deferrals)}`);
  deps.store.touchTick(repo);
}

/** Phase B proper: claim new work up to the cap, walking BELTS in priority order. The cap is global
 *  across all belts; a higher-priority belt drains its eligible work first, and the FIRST belt whose
 *  `match` predicate accepts an item claims it (first match wins). Capacity counts only WORKING runs
 *  — parked runs (attention / waiting_for_human) keep their worktree but no agent is consuming
 *  machine resources, and a pile of them must not starve the belt. `machineSlots` is the remaining
 *  machine.yml headroom (the caller holds the machine claim lock). */
async function claimNewWork(deps: Deps, machineSlots = Infinity): Promise<void> {
  const repo = deps.config.repoName;
  const occupying = deps.store.countOccupying(repo);
  // Active-but-not-occupying: the parks (attention, waiting_for_human) plus idle PR-watches
  // (reviewing with no active resolver). None hold a slot; all still own a worktree on disk.
  const idleOrParked = deps.store.countActive(repo) - occupying;
  let slots = deps.config.limits.maxActiveWorkspaces - occupying;
  if (slots <= 0) {
    deps.log("info", `at capacity (${occupying}/${deps.config.limits.maxActiveWorkspaces} working, ${idleOrParked} idle/parked)`);
    deps.store.touchTick(repo);
    return;
  }
  // Admission control: each claim is a burst of real work (worktree checkout, ticket + attachment
  // materialize, status transition ≈ 5+ source calls). Capping claims per pass smooths a cold
  // start with a big backlog into successive ticks instead of one source-hammering mega-tick.
  if (slots > deps.config.limits.maxClaimsPerTick) slots = deps.config.limits.maxClaimsPerTick;
  if (slots > machineSlots) slots = machineSlots;

  // Per-source concurrency: each source contributes at most its own max_active_workspaces occupying
  // runs, summed across every belt that pulls from it. Remaining source slots are computed once from
  // current occupancy (same posture as the global cap) and decremented as we claim, so a busy
  // high-priority source can't monopolize the repo-wide cap and starve the others.
  const occupyingBySource = deps.store.countOccupyingBySource(repo);
  const srcRemaining = new Map<string, number>();
  const sourceSlots = (src: SourceRuntime): number => {
    let remaining = srcRemaining.get(src.name);
    if (remaining === undefined) {
      remaining = src.maxActiveWorkspaces - (occupyingBySource.get(src.name) ?? 0);
      srcRemaining.set(src.name, remaining);
    }
    return remaining;
  };

  // One eligible query per (source, pickup label) per pass: a source feeding several belts is
  // fetched once PER DISTINCT label (label-driven sources filter server-side on it, so different
  // belts see disjoint items; a label-less source ignores it and collapses to one fetch).
  const eligibleCache = new Map<string, MatchItem[]>();
  // Which active belts share each (source, label) fetch — so the cached snapshot can be narrowed to
  // what those belts would actually claim, below.
  const beltsForFetch = new Map<string, BeltRuntime[]>();
  for (const belt of deps.belts) {
    if (!belt.active) continue;
    const src = deps.resolveSource(belt.source);
    if (!src) continue;
    const key = `${src.name}\0${belt.label ?? ""}`;
    const group = beltsForFetch.get(key) ?? [];
    group.push(belt);
    beltsForFetch.set(key, group);
  }
  /** Each belt's `match` verdict for each polled item, decided ONCE per poll and read again at the
   *  claim below — so a predicate is evaluated (and a throwing one logged) exactly once per pass,
   *  and the claim can never disagree with what the board showed as ready. Keyed by belt+item; a
   *  belt with no `match` gets no entry, because it accepts everything. */
  const matchVerdict = new Map<string, boolean>();
  const verdictKey = (belt: BeltRuntime, item: MatchItem) => `${belt.name}\0${item.key}`;
  /** Run those verdicts and return the union: the items SOME belt on this fetch would claim, which
   *  is the only thing the board may call "ready". Two repo configs polling one Jira query differ
   *  only in their belts' `match`, so an unfiltered snapshot showed each repo the OTHER's tickets —
   *  items it would never claim. A throwing predicate drops the item, exactly as at the claim.
   *
   *  Note this evaluates every belt in the group, where the claim loop used to stop at the first
   *  belt that accepted an item: a `match` is a pure predicate on the item (README), so the only
   *  cost is the extra calls, and knowing the whole group's verdicts is what the snapshot needs. */
  const matchAccepted = async (cacheKey: string, src: SourceRuntime, items: MatchItem[]): Promise<MatchItem[]> => {
    const belts = beltsForFetch.get(cacheKey) ?? [];
    const accepted: MatchItem[] = [];
    for (const item of items) {
      let anyBelt = false;
      for (const belt of belts) {
        if (!belt.match) {
          anyBelt = true; // a belt with no match accepts everything its label surfaced
          continue;
        }
        let ok = false;
        try {
          ok = !!(await belt.match({ item, source: { name: src.name, type: src.type } }));
        } catch (e) {
          deps.log("warn", `belt ${belt.name}: match predicate threw for ${item.key}: ${err(e)}`);
        }
        matchVerdict.set(verdictKey(belt, item), ok);
        anyBelt ||= ok;
      }
      if (anyBelt) accepted.push(item);
    }
    return accepted;
  };
  const getEligible = async (src: SourceRuntime, label: string | undefined): Promise<MatchItem[]> => {
    const cacheKey = `${src.name}\0${label ?? ""}`;
    const cached = eligibleCache.get(cacheKey);
    if (cached) return cached;
    // Poll-window gate (drain-per-window): when a source's interval exceeds the tick, skip its poll
    // — and thus all its claims — until the interval elapses. Only engages when interval > tick, so
    // the default (interval == tick) polls every pass exactly as before; a small tolerance below the
    // interval keeps a "5 min" cadence from slipping a whole tick on timer jitter. Between polls the
    // source contributes no eligible items, so nothing new is claimed from it this tick.
    if (src.pollIntervalSeconds > deps.config.limits.tickIntervalSeconds) {
      const last = src.lastPolledAt.get(label ?? ""); // epoch seconds (deps.now() is seconds)
      const toleranceSec = Math.min(deps.config.limits.tickIntervalSeconds / 2, 5);
      if (last != null && deps.now() - last < src.pollIntervalSeconds - toleranceSec) {
        eligibleCache.set(cacheKey, []);
        return [];
      }
    }
    // Rate-limit hold: the backend named a reset stamp, and polling before it can only fail — and
    // on GitHub's per-account budget, fail while spending someone else's calls too. Skip WITHOUT
    // stamping lastPolledAt: the hold is the cadence here, and the gate drops itself at the reset.
    const held = getRateLimit(deps.config.repoName, src.name, deps.now());
    if (held) {
      deps.log("info", `${src.name}: rate limited — not polling for another ${held.until - deps.now()}s (${held.detail})`);
      eligibleCache.set(cacheKey, []);
      return [];
    }
    let items: MatchItem[];
    // Stamp the poll BEFORE the call (on the attempt, not just success): a paused/erroring source
    // then backs off to its interval instead of retrying every tick — matching the degrade-to-[]
    // path below, which is also a completed poll for cadence purposes.
    src.lastPolledAt.set(label ?? "", deps.now());
    try {
      items = await src.client.listEligible(label);
      noteSourceAuthRecovered(deps, src.name); // a successful poll ⇒ auth is fine (clears any gate)
      noteSourceRateLimitCleared(deps, src.name); // …and that the budget is back
      // The tick's poll is the ONLY thing that queries a source for eligible work; `/eligible` serves
      // this snapshot. Only a success overwrites it, so a blip keeps the last good list on the board.
      src.lastEligible.set(label ?? "", { items: await matchAccepted(cacheKey, src, items), at: deps.now() });
    } catch (e) {
      // A source that can't authenticate is PAUSED, not broken: record + notify (once) and skip its
      // claims this tick — it auto-resumes when a later poll succeeds. A rate-limited source is held
      // the same way, until the reset it named. Any other backend hiccup must still not starve the
      // other sources, so it also degrades to [] (just logged, not gated).
      if (isSourceUnauthenticated(e)) await noteSourceAuthFailure(deps, src.name, e);
      else if (isSourceRateLimited(e)) await noteSourceRateLimited(deps, src.name, e);
      else deps.log("warn", `${src.name}: eligible query failed: ${err(e)}`);
      items = [];
    }
    eligibleCache.set(cacheKey, items);
    return items;
  };

  let claimed = 0;
  for (const belt of deps.belts) {
    if (slots <= 0) break;
    // An inactive belt takes on no new work — skipped BEFORE polling (so its source isn't polled or
    // poll-window-stamped on its behalf). In-flight runs of this belt keep reconciling in Phase A;
    // the flag only gates new claims, so it's a no-cost way to temporarily pause a belt.
    if (!belt.active) {
      deps.log("info", `belt ${belt.name}: inactive — skipping (no new claims; in-flight runs continue)`);
      continue;
    }
    const src = deps.resolveSource(belt.source);
    if (!src) {
      deps.log("warn", `belt ${belt.name}: source "${belt.source}" not configured — skipping`);
      continue;
    }
    // Skip a belt whose source is already at its concurrency cap — checked BEFORE polling, so an
    // exhausted source isn't polled (and doesn't have its poll-window stamped) needlessly.
    if (sourceSlots(src) <= 0) {
      deps.log("info", `belt ${belt.name}: source "${src.name}" at its concurrency cap (${src.maxActiveWorkspaces}) — skipping`);
      continue;
    }
    for (const item of await getEligible(src, belt.label)) {
      if (slots <= 0) break;
      if (sourceSlots(src) <= 0) break; // source hit its per-source cap mid-belt
      // Dedup is per (source, key): once any belt has an active run for the item, no other belt
      // claims it — which is exactly what makes "first matching belt wins" hold across the pass.
      if (deps.store.activeRunForTicket(repo, src.name, item.key)) continue;
      // An undelivered write-back means this item's source status is known-stale — its "eligible"
      // listing can't be trusted (e.g. a merged run whose transition never landed would be
      // re-claimed here and the work re-done). Let the outbox converge first.
      if (deps.store.pendingTransitionForKey(repo, src.name, item.key)) {
        deps.log("warn", `${item.key}: skipping claim — a status write-back to "${src.name}" is still pending`);
        continue;
      }
      // The verdict was decided by this pass's poll (`matchAccepted` above), which is also what the
      // board's snapshot was built from — so the predicate is not re-run here, a throwing one is not
      // logged twice, and a claim can never disagree with what `/eligible` listed as ready.
      if (belt.match && !matchVerdict.get(verdictKey(belt, item))) continue;
      // claim() creates the run row FIRST (which immediately counts toward countActive), so the
      // slot is consumed even if the rest of the claim throws — decrement before the try, or a
      // burst of claim failures in one pass would transiently spawn past maxActive. Decrement the
      // per-source slot the same way, for the same reason.
      slots -= 1;
      srcRemaining.set(src.name, sourceSlots(src) - 1);
      try {
        await claim(deps, belt, src, ticketOf(item));
        claimed += 1;
      } catch (e) {
        deps.log("error", `${belt.name}/${item.key}: claim failed: ${err(e)}`);
      }
    }
  }
  deps.log("info", `claimed ${claimed}; working ${deps.store.countOccupying(repo)}/${deps.config.limits.maxActiveWorkspaces}, idle/parked ${idleOrParked}`);
  deps.store.touchTick(repo);
}

async function claim(deps: Deps, belt: BeltRuntime, src: SourceRuntime, ticket: Ticket): Promise<void> {
  return telemetrySpan(
    "reconcile.claim",
    { repo: deps.config.repoName, "work.source": src.name, belt: belt.name, "work.key": ticket.key, "work.type": ticket.type },
    () => claimImpl(deps, belt, src, ticket),
  );
}

async function claimImpl(deps: Deps, belt: BeltRuntime, src: SourceRuntime, ticket: Ticket): Promise<void> {
  const repo = deps.config.repoName;
  // The name the worktree + workspace are created under, and the branch it starts on — one name at
  // claim time, and the run's identity from here (`worktree_name`, frozen). The per-run uid makes it
  // unique to THIS attempt, so a re-claimed ticket doesn't reuse a name whose prior PR was already
  // merged (which the pr step would otherwise treat as done). The BRANCH may move off it later: an
  // agent can rename it to the repo's convention (see core/run-branch.ts).
  const worktreeName = branchName(ticket.key, ticket.type, ticket.summary, belt.workspaceName, deps.uid(), belt.branch);
  let run: Run;
  try {
    run = deps.store.createRun({
      repo,
      workSource: src.name,
      belt: belt.name,
      ticketKey: ticket.key,
      summary: ticket.summary,
      issueType: ticket.type,
      worktreeName,
      branch: worktreeName,
    });
  } catch (e) {
    // The v25 one-active-run-per-(repo, source, key) index is the arbiter of the claim race both
    // paths leave open: each is check-then-create with a network call between the dedup check and
    // this insert (Phase B's listEligible, the manual claim's describe()), and the manual path
    // holds no tick lock. Losing the insert means the item IS claimed — the end state the caller
    // wanted — so log and stop instead of surfacing a constraint error (Phase B would record it
    // as a claim failure; the manual CLI would exit 1 on a success).
    if (isUniqueViolation(e)) {
      deps.log("warn", `${belt.name}/${ticket.key}: already claimed by a concurrent pass — skipping duplicate claim`);
      return;
    }
    throw e;
  }
  // Cross-host arbitration (INV-10), before anything references the row. Losing is not a failure: the
  // item IS claimed, by another factory.
  const winner = await arbitrateClaim(deps, src, run);
  if (winner) {
    deps.log("info", `${belt.name}/${ticket.key}: claimed elsewhere by ${winner.host} (run ${winner.runId}) — skipping`);
    // Recorded once per distinct winner, not once per tick: a stale claim is re-seen every pass.
    const last = deps.store.lastEventForKey(repo, ticket.key);
    const detail = { host: winner.host, runId: winner.runId, source: src.name, belt: belt.name };
    if (last?.type !== "claimed_elsewhere" || last.detail !== JSON.stringify(detail)) {
      deps.store.recordEvent({ repo, ticketKey: ticket.key, type: "claimed_elsewhere", detail });
    }
    return;
  }
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: ticket.key, type: "claimed", detail: { branch: worktreeName, worktreeName, source: src.name, belt: belt.name } });
  deps.log("info", `${belt.name}/${ticket.key}: claimed -> ${worktreeName}`);
  // Under the run lock like every other mutation of this run (uncontended for a fresh claim; the
  // guard matters once its first agent exists and can nudge).
  await withRunLock(deps, run.id, () => reconcileRun(deps, run));
}

export async function reconcileRun(deps: Deps, run: Run, ctx: TickCtx = {}): Promise<void> {
  return telemetrySpan(
    "reconcile.run",
    {
      repo: deps.config.repoName,
      "run.id": run.id,
      "work.key": run.ticketKey,
      "work.source": run.workSource ?? undefined,
      belt: run.belt ?? undefined,
      phase: run.phase,
      step: run.step ?? undefined,
    },
    () => reconcileRunImpl(deps, run, ctx),
  );
}

async function reconcileRunImpl(deps: Deps, run: Run, ctx: TickCtx): Promise<void> {
  // The caller's `run` is a SNAPSHOT — the tick reads every active run up front and reconciles them
  // with bounded concurrency, so a run torn down (by an earlier phase of this pass, a nudge, or the
  // CLI) while this one waited for its turn still arrives here as `running`. Acting on that stale
  // phase dispatches work for a run that no longer exists — a spawn minutes AFTER teardown, into a
  // worktree that has been removed. Re-read under the run lock and stop if it ended.
  const live = deps.store.getRun(run.id);
  if (!live || live.endedAt !== null) return;
  run = live;
  // Resolve the run's source + belt ONCE and thread them down. The belt carries the step sequence
  // + lifecycle; the source materializes the work doc and owns the lifecycle write-back.
  const src = deps.resolveSource(run.workSource);
  const belt = deps.resolveBelt(run.belt);
  if (!src || !belt) {
    // Config changed between claim and now (source/belt renamed or removed). A tearing_down run
    // must still finish its local cleanup (worktree/branch) — neither is needed for that. Anything
    // else can't be advanced: escalate to attention (idempotent) so an operator notices.
    if (run.phase === "tearing_down") {
      await teardown(deps, run, run.outcome ?? "abandoned", src);
    } else if (run.phase !== "attention" && run.phase !== "done") {
      const what = !belt ? `belt "${run.belt}"` : `work source "${run.workSource}"`;
      deps.log("error", `${run.ticketKey}: ${what} is not configured — escalating`);
      await escalateAttention(deps, run, {
        reason: !belt ? "belt_missing" : "source_missing",
        attentionReason: `${what} not configured`,
        body: `${run.ticketKey}: its ${what} is no longer in this repo's config — re-add it or tear the run down.`,
        detail: { belt: run.belt, workSource: run.workSource },
      });
    }
    return;
  }
  // Stale policy (run-locked half of the two-phase handling — the lock-free outbox flush only
  // stamped stale_at): a write-back found this run's item GONE at the source. Consume the flag
  // exactly once, then abort or park per policy.
  if (run.phase !== "done" && run.phase !== "tearing_down") {
    const stale = deps.store.unhandledStaleIntentForRun(run.id);
    if (stale) {
      deps.store.markTransitionStaleHandled(stale.id);
      const why = stale.lastError ?? "item no longer exists at the source";
      // Abort vs park keys on the RUN'S progress, not just which intent went stale: a claim-time
      // in_development intent can deliver stale long after the run advanced (the outbox backs
      // off up to 1h while phases move on) — destroying a reviewing run's worktree with an open
      // PR is exactly what the park branch exists to prevent.
      const preWork = stale.toState === "in_development" && run.prNumber == null && (run.phase === "claiming" || run.phase === "running");
      if (preWork) {
        // The claim write-back found the item gone: a human deleted/closed it during claim —
        // "don't do this work". Abort promptly, bounding further token spend (the first agent may
        // already be running; the claim transition fires after the first spawn). Teardown's own
        // `aborted` intent going stale again lands in the ended-run path — no double-fire.
        deps.log("warn", `${run.ticketKey}: aborting — ${why}`);
        await deps.herdr.notify(`herdr-factory: ${run.ticketKey} aborted`, `Work item gone at the source (${why}) — run aborted.`).catch(() => {});
        await teardown(deps, run, "abandoned", src);
      } else {
        // Mid-flight (e.g. in_review): the work exists — a PR may be up — so park for a human
        // instead of destroying it. No source note: the item it would go to is gone.
        await escalateAttention(deps, run, {
          reason: "source_item_stale",
          attentionReason: `work item gone at the source (${why})`,
          body: `${run.ticketKey}: the ${stale.toState} write-back found the item gone (${why}). Resume to continue anyway, or tear the run down.`,
          detail: { toState: stale.toState, why },
          skipSourceNote: true,
        });
      }
      return;
    }
  }
  // Consume a durable pending agent signal (bounce / ask-human) exactly once, before the phase
  // dispatch. The immediate apply at signal time is only the low-latency path — this is the
  // convergence backstop for an intent whose apply lost the run-lock race or crashed mid-way
  // (see applySignal). Applied ⇒ the signal re-pointed the run and dispatched what it needed, so
  // the pass is complete; rejected ⇒ stamped + logged, and the normal pass continues fresh.
  if (run.phase !== "done" && run.phase !== "tearing_down") {
    const consumed = await consumePendingSignal(deps, run, belt, src);
    if (consumed) {
      if (consumed.ok) return;
      run = deps.store.getRun(run.id)!;
    }
  }
  // Consume ledger handoffs owed to this run (the run-locked half of the intent kernel — the
  // generalized stale two-phase): each is consumed exactly once; an escalation verdict parks here,
  // where the escalation machinery lives (kinds never park runs themselves).
  if (run.phase !== "done" && run.phase !== "tearing_down") {
    const escalate = await consumeIntentHandoffs(deps, run);
    if (escalate) return escalateAttention(deps, run, escalate);
    run = deps.store.getRun(run.id)!;
  }
  // The branch is TRACKED, not fixed: follow the worktree onto whatever it is on now (an agent may
  // rename it to the repo's branch convention) BEFORE the phase dispatch, so this pass's prompt
  // render, PR discovery, and branch cleanup all read the branch that actually exists.
  if (run.phase !== "done" && run.phase !== "tearing_down") run = await syncRunBranch(deps, run);
  await dispatchPhase(deps, run, belt, src, ctx);
  // Then, on every pass for every active run, try to apply any deferred focus shift. Doing
  // it here (not only on the tick that transitioned) is what lets a transition in an
  // unfocused worktree be picked up later, once the user navigates to it.
  const fresh = deps.store.getRun(run.id);
  if (fresh) await applyPendingFocus(deps, fresh);
}

async function dispatchPhase(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, ctx: TickCtx): Promise<void> {
  return telemetrySpan(
    `reconcile.phase.${run.phase}`,
    {
      repo: deps.config.repoName,
      "run.id": run.id,
      "work.key": run.ticketKey,
      "work.source": src.name,
      belt: belt.name,
      phase: run.phase,
      step: run.step ?? undefined,
    },
    async () => {
      switch (run.phase) {
        case "claiming":
          return reconcileClaiming(deps, run, belt, src);
        case "running": {
          const step = stepByName(belt, run.step);
          if (step) return reconcileStep(deps, run, belt, src, step);
          // The active step isn't in this belt anymore (belt steps reordered/renamed mid-flight).
          return escalateAttention(deps, run, {
            reason: "unknown_step",
            attentionReason: `step "${run.step}" is not in belt "${belt.name}"`,
            body: `${run.ticketKey}: its active step "${run.step}" no longer exists in belt "${belt.name}".`,
            detail: { step: run.step, belt: belt.name },
          });
        }
        case "waiting_for_human":
          return reconcileWaitingForHuman(deps, run, belt, src, ctx);
        case "reviewing":
          return reconcileReviewing(deps, run, src, ctx);
        case "tearing_down":
          return teardown(deps, run, run.outcome ?? "abandoned", src);
        case "attention":
          return reconcileAttention(deps, run, belt, src, ctx);
        case "done":
          return;
      }
    },
  );
}

/**
 * Apply a deferred focus shift, if one is pending. The active step's pane is brought to the
 * front ONLY when the user is currently viewing this run's worktree AND sitting on one of its
 * belt panes — so we never steal focus from another worktree, and never yank the user off
 * an unrelated (editor/server/scratch) pane. If those conditions don't hold, the pending flag
 * is left set and re-checked on later ticks. herdr exposes no focus-change event, so we poll
 * the focused pane here — but only when there's actually something pending (the cheap path
 * for the common case is a single boolean read).
 */
export async function applyPendingFocus(deps: Deps, run: Run): Promise<void> {
  if (!run.focusPending) return;
  if (run.phase !== "running" || !run.step) {
    // No active belt step (claiming/reviewing/teardown/done) — nothing to focus; clear the flag.
    deps.store.updateRun(run.id, { focusPending: false });
    return;
  }
  const belt = deps.resolveBelt(run.belt);
  if (!belt) {
    deps.store.updateRun(run.id, { focusPending: false });
    return;
  }
  const focused = await deps.herdr.focusedPane();
  if (!focused) return; // herdr not frontmost / no focused pane — keep pending
  if (focused.workspaceId !== run.workspaceId) return; // user is in another worktree — keep pending

  // "one of this belt's step panes" = the panes we've dispatched steps to for this run. If the
  // user is parked on some other pane, hold the focus rather than pull them.
  const beltPanes = belt.steps.map((s) => deps.store.getRunStep(run.id, s.name)?.paneId).filter(Boolean);
  if (!beltPanes.includes(focused.paneId)) return; // on a non-belt pane — keep pending

  const target = deps.store.getRunStep(run.id, run.step)?.paneId;
  if (!target) {
    deps.store.updateRun(run.id, { focusPending: false });
    return;
  }
  await deps.herdr.agentFocus(target);
  deps.store.updateRun(run.id, { focusPending: false });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "focus_applied",
    detail: { step: run.step, paneId: target },
  });
}

/**
 * Fetch the base ref before a worktree is cut from it. Nothing else in the factory fetches the
 * target checkout, so a clone that is only ever read (the normal case — the factory works in linked
 * worktrees, never in `repo.path` itself) keeps the `origin/main` it was cloned with, and every run
 * is based on code that may be many merges old.
 *
 * A failed fetch NEVER blocks the claim: the local ref is a worse base, not an unusable one, and
 * parking every run because the network blinked would be worse than building on a known-old base.
 * It logs a warning naming the base's age instead, so the staleness is visible in the run's log.
 * Only `<remote>/<branch>` base refs are fetchable — a local base ref (`main`) is whatever the
 * checkout itself holds, which no fetch would move.
 */
async function refreshBaseRef(deps: Deps, run: Run): Promise<void> {
  const baseRef = deps.config.repo.baseRef;
  const slash = baseRef.indexOf("/");
  if (slash <= 0) return;
  const [remote, branch] = [baseRef.slice(0, slash), baseRef.slice(slash + 1)];
  if (await deps.git.fetchRef(deps.config.repo.path, remote, branch)) return;
  const age = await deps.git.refAge(deps.config.repo.path, baseRef);
  deps.log(
    "warn",
    `${run.ticketKey}: could not fetch ${baseRef} in ${deps.config.repo.path} — cutting the worktree from the local ref (${baseRef} is ${age ?? "of unknown age"}); the base may be stale`,
  );
}

async function reconcileClaiming(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime): Promise<void> {
  const repo = deps.config.repoName;
  // The worktree is created FROM (or re-attached BY) the branch the run is on: at claim these are
  // the same string as `worktree_name`, and a re-attach after an agent renamed the branch resolves
  // the worktree by the name it now carries.
  const branch = run.branch ?? run.worktreeName;
  if (!branch) throw new Error(`${run.ticketKey}: claiming without a branch`);

  // 1. ensure worktree
  if (!run.workspaceId || !(await deps.herdr.workspaceExists(run.workspaceId))) {
    const exists = await deps.git.branchExists(deps.config.repo.path, branch);
    if (!exists) await refreshBaseRef(deps, run);
    const wt = exists
      ? await deps.herdr.worktreeOpen(deps.config.repo.path, branch)
      : await deps.herdr.worktreeCreate(deps.config.repo.path, branch, deps.config.repo.baseRef);
    // A freshly CREATED checkout owes its .memory/herdr-factory (if any) to the repo's committed
    // tree — scrub it before materialize, whose skip-if-exists idempotence would otherwise let a
    // committed task doc supplant this run's real work item. Never on the reopen path: a
    // re-attached worktree's memory dir is the run's own live state.
    if (!exists && scrubCommittedMemoryDir(wt.worktreePath)) {
      deps.log("warn", `${run.ticketKey}: removed a committed ${MEMORY_DIR} from the fresh worktree — the repo should not track factory memory (add .memory/ to its .gitignore)`);
    }
    deps.store.updateRun(run.id, { workspaceId: wt.workspaceId, worktreePath: wt.worktreePath });
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "worktree_created", detail: { workspaceId: wt.workspaceId } });
    run = deps.store.getRun(run.id)!;
    deps.log("info", `${run.ticketKey}: worktree ready (${wt.workspaceId})`);
  }

  // 2. materialize the work item (idempotent) and dispatch the belt's FIRST step. If the
  //    configured layout pane isn't up yet, stay in `claiming` and retry next tick (bounded;
  //    escalate to attention on timeout) — never spawn our own when a tab/pane is configured.
  const first = firstStep(belt);
  if (!deps.store.getRunStep(run.id, first.name)?.paneId) {
    await materializeWork(deps, run, src);
    // Record the ACTIVE STEP before dispatching, not after. `spawnStep` blocks until herdr reports
    // the agent ready for input — and the prompt already rode in on its argv — so the agent can be
    // working, and can even signal, while this call is still outstanding. A signal naming a step the
    // run isn't on is rejected ("not the run's active step"), and the run then waits for a signal
    // that never comes again until its budget expires. Every later step already sets `step` before
    // its dispatch (see the forward advance in reconcileStep); this makes the first one agree.
    // The PHASE stays `claiming` until the dispatch lands — the layout-wait path depends on it —
    // so "still claiming" is now read from the first step's pane id (`isPreDispatchClaim`), which is
    // what `run.step == null` used to stand for.
    deps.store.updateRun(run.id, { step: first.name });
    run = deps.store.getRun(run.id)!;
    const res = await spawnStep(deps, run, belt, src, first.name);
    if (res.status === "waiting") return handleLayoutWait(deps, run, belt, first);
    run = deps.store.getRun(run.id)!;
  }

  // 3. Advance to running FIRST, then request the in-development transition. Gating the phase on
  //    the transition would pin the run in `claiming` forever if the transition keeps failing
  //    (auth/workflow) while its first agent runs and finishes unobserved. The outbox owns the
  //    write-back from here: a failed attempt is retried each tick until the source confirms.
  deps.store.updateRun(run.id, { phase: "running", step: first.name });
  deps.log("info", `${run.ticketKey}: running ${first.name} on ${branch}`);
  // belt_start: entering the first step. Engine default in_development, overridable by a belt effect
  // on entering that step (e.g. a custom "picked up" status).
  await fireEffect(deps, run, belt, src, { on: "enter", step: first.name }, "in_development");
}

/** Is this run still in its INITIAL CLAIM — has NO step of it ever been dispatched?
 *
 *  `run.step` is now set before the first dispatch (so a fast agent's signal isn't rejected against an
 *  empty active step), so it can no longer stand in for "is this run still claiming?". A pane id is
 *  the durable marker of a dispatch: written by the first successful one and KEPT across re-entries,
 *  so a bounce back to the first step reads as `running`, not as a fresh claim.
 *
 *  Asked of the RUN, never of the belt's current first step: belts are edited mid-flight (steps get
 *  reordered, renamed, prepended — §7), and keying on `firstStep(belt)` would then read an advanced
 *  run that is parked at a later step as an un-dispatched claim, re-materialize its work doc and
 *  dispatch the new first step, abandoning the step it was actually parked on. */
function isPreDispatchClaim(deps: Deps, run: Run): boolean {
  return !deps.store.runStepsFor(run.id).some((s) => s.paneId);
}

/** Attention reasons that are about the DESIGNATED WORK itself — a rework loop that cannot agree
 *  (`bounce_limit`), a PR a human closed (`pr_closed`). These are the only parks whose reason is
 *  written back to the work item: the people who read the ticket care about the work, and a
 *  comment about factory plumbing (a budget, a stalled pane, a failed login) is noise to them.
 *  Everything else — including plugin guard codes — is MECHANICAL and reports into the run's own
 *  agent pane instead (`reportToPane`), alongside the desktop notification. */
const WORK_ERROR_REASONS = new Set(["bounce_limit", "pr_closed"]);

/** Publish run state on `run.paneId` — the pane of whichever step DISPATCHED LAST, which is not
 *  necessarily `run.step`.
 *
 *  A step that is still waiting for its own layout pane never dispatched, so `run.paneId` is the
 *  PREVIOUS step's pane; naming `run.step` on it retags that pane as a step it does not host, and
 *  the operator (and herdr's sidebar/agent-view queries, which read the `hf_*` tokens) then sees
 *  the waiting step's tokens sitting on a pane that is done — while the pane the step is actually
 *  waiting for carries none (issue #80). So the label is always the step that OWNS this pane, taken
 *  from the run's own step rows; `fallback` covers a pane no run_step claims (a PR-watch pane).
 *  The run-level posture (`hf_state`) still rides on the last active pane — that is a property of
 *  the RUN, and it is the pane the operator is looking at. */
async function showRunPaneOwner(deps: Deps, run: Run, state: PaneRunState, fallback?: string | null): Promise<void> {
  if (!run.paneId) return;
  const owner = deps.store.runStepsFor(run.id).find((s) => s.paneId === run.paneId)?.step;
  await showRunPane(deps, run.paneId, { key: run.ticketKey, step: owner ?? fallback ?? run.step, state });
}

/** Park a run for human attention: flip phase, record the reason, fire a notification, and put
 *  the reason where the humans already look. WHERE depends on what broke: a mechanical failure
 *  (the factory's own workings) reports into the run's agent pane; an error about the designated
 *  work is posted on the work item — except for a file-channel source (local_markdown), whose
 *  "notes" are hidden files nobody watches, so its work errors go to the pane too. */
async function escalateAttention(
  deps: Deps,
  run: Run,
  opts: { reason: string; attentionReason: string; body: string; detail?: Record<string, unknown>; skipSourceNote?: boolean },
): Promise<void> {
  deps.store.updateRun(run.id, { phase: "attention", attentionReason: opts.attentionReason, attentionReasonCode: opts.reason, attentionNotifiedAt: deps.now() });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "attention",
    detail: { reason: opts.reason, ...(opts.detail ?? {}) },
  });
  // Make it obvious in herdr: flag the active pane. herdr won't let us set agent_status to
  // "blocked" (that's owned by the agent's own lifecycle hook), so a glaring pane TITLE is the
  // most visible persistent cue — unlike the one-shot notification, it stays in the tab/pane list
  // until the run resolves. Published as display metadata (never a rename), so it decorates the pane
  // without touching the label a step's `pane:` target resolves by. Best-effort.
  await showRunPaneOwner(deps, run, "attention");
  await deps.herdr.notify(`herdr-factory: ${run.ticketKey} needs attention`, opts.body).catch(() => {});
  const commands = `Resume with: herdr-factory --repo ${deps.config.repoName} resume ${run.ticketKey}\nOr let your agent diagnose it: herdr-factory --repo ${deps.config.repoName} triage ${run.ticketKey}`;
  // Work errors write back to the source (once, on escalation — the periodic re-notify stays
  // local), unless the escalation IS about the source item being gone (posting to it can't work)
  // or the source's reply channel is a local file (report to the pane instead — see the routing
  // note above). Mechanical errors never reach the source: they report into the run's pane.
  const src = opts.skipSourceNote || !WORK_ERROR_REASONS.has(opts.reason) ? undefined : deps.resolveSource(run.workSource);
  if (src && src.client.spec.replyChannel === "comments") {
    await src.client
      .postNote(run.ticketKey, `⚠ ${deps.config.sourceComments.brand} parked this run for attention: ${opts.attentionReason}\n\n${opts.body}\n\n${commands}`)
      .catch((e) => deps.log("warn", `${run.ticketKey}: attention note not posted to ${src.name}: ${err(e)}`));
    return;
  }
  const landed = await reportToPane(deps, run, `⚠ parked for attention: ${opts.attentionReason}. ${opts.body}\n${commands}`);
  if (!landed) deps.log("info", `${run.ticketKey}: attention report not delivered to a pane (none live) — the notification is the record`);
}

async function postHumanQuestion(deps: Deps, src: SourceRuntime, q: HumanQuestion): Promise<HumanQuestion> {
  if (q.externalId) return q;
  const res = await src.client.askHuman({
    repo: deps.config.repoName,
    runId: q.runId,
    questionId: q.id,
    key: q.ticketKey,
    step: q.step,
    question: q.question,
  });
  deps.store.updateHumanQuestion(q.id, { externalId: res.externalId, externalCreatedAt: res.externalCreatedAt ?? null });
  return deps.store.getHumanQuestion(q.id)!;
}

/** Agent-facing pause primitive: persist a human question, post it through the run's source, and
 *  park the run until `reconcileWaitingForHuman` sees a source-native reply. */
export async function requestHumanInput(
  deps: Deps,
  run: Run,
  step: string,
  question: string,
): Promise<{ ok: boolean; questionId: number; posted: boolean; message?: string }> {
  const src = deps.resolveSource(run.workSource);
  if (!src) throw new Error(`${run.ticketKey}: work source "${run.workSource}" not configured`);

  // Reuse a pending question only when it IS this question (same step + text) — the idempotent
  // re-ask path. A DIFFERENT pending question (possible after a resume out of a parked human
  // loop) must be superseded, not silently reused: binding the new ask to the old row would post
  // nothing to the source and anchor the reply poll on a comment no human is answering.
  const pending = deps.store.pendingHumanQuestionForRun(run.id);
  const existing = pending && pending.step === step && pending.question === question.trim() ? pending : undefined;
  if (pending && !existing) {
    deps.store.updateHumanQuestion(pending.id, {
      status: "answered",
      answer: "(superseded by a newer question from the agent — no human reply was received)",
      answeredAt: deps.now(),
    });
    deps.log("warn", `${run.ticketKey}: superseding stale pending question #${pending.id} with a new ask`);
  }
  let q = existing ?? deps.store.createHumanQuestion({
    runId: run.id,
    repo: deps.config.repoName,
    workSource: src.name,
    ticketKey: run.ticketKey,
    step,
    question: question.trim(),
  });

  deps.store.updateRun(run.id, { phase: "waiting_for_human", step, attentionReason: null });
  let posted = q.externalId !== null;
  let message: string | undefined;
  try {
    q = await postHumanQuestion(deps, src, q);
    posted = q.externalId !== null;
  } catch (e) {
    message = `question recorded; posting deferred: ${err(e)}`;
    deps.log("warn", `${run.ticketKey}: human question #${q.id} post deferred: ${err(e)}`);
  }

  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "human_question",
    detail: { step, questionId: q.id, externalId: q.externalId, posted, reused: existing !== undefined },
  });
  deps.log("info", `${run.ticketKey}: waiting for human answer to question #${q.id}`);
  return { ok: true, questionId: q.id, posted, message };
}

function writeHumanReply(run: Run, q: HumanQuestion, replyBody: string, author: string | null | undefined): string | null {
  if (!run.worktreePath) return null;
  const dir = join(run.worktreePath, MEMORY_DIR, "human-replies");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `question-${q.id}.md`);
  writeFileSync(
    file,
    [
      `# Human reply for ${run.ticketKey}`,
      "",
      `Question: #${q.id}`,
      `Step: ${q.step ?? "unknown"}`,
      author ? `Author: ${author}` : null,
      "",
      "## Question",
      "",
      q.question,
      "",
      "## Reply",
      "",
      replyBody,
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
  return file;
}

async function resumeAfterHumanReply(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, q: HumanQuestion, replyFile: string | null): Promise<void> {
  const step = q.step ?? run.step;
  if (!step || !stepByName(belt, step)) {
    await escalateAttention(deps, run, {
      reason: "human_reply_unknown_step",
      attentionReason: `human reply arrived for unknown step "${step ?? "(none)"}"`,
      body: `${run.ticketKey}: a human replied to question #${q.id}, but the original step no longer exists in belt "${belt.name}".`,
      detail: { questionId: q.id, step },
    });
    return;
  }

  // Re-base the step for the continuation. Two halves, both load-bearing:
  //  - done:false — clear a step-done that landed CONCURRENTLY with this pass. Since the ask-human
  //    park is rescued by a step-done (reconcileWaitingForHuman advances instead of polling), a done
  //    recorded before this pass never reaches here — but `markStepDone` runs OUTSIDE the run lock
  //    (applySignal), so one can still land while we hold it. This pass has already told the agent
  //    below to CONTINUE and only step-done when the step is actually complete, so the flag must not
  //    survive to auto-advance the step out from under that instruction.
  //  - fresh budget/absence clocks — the run may have waited on the human far past the step
  //    budget; without a re-base the next watchdog pass reads the pre-ask clock and re-parks the
  //    freshly-resumed step. The "reply_resume" rebase is deliberately NARROW (budget only): the
  //    agent CONTINUES the same pass, so the frozen read-only baseline and the stall history
  //    survive. The pass is NOT bumped: the --pass stamp baked into its prompt's commands must
  //    stay valid.
  deps.store.upsertRunStep(run.id, step, { done: false, startedAt: deps.now(), absentAt: null });
  applyWatchRebase(deps, run.id, stepByName(belt, step)!, "reply_resume");
  deps.store.updateRun(run.id, { phase: "running", step, attentionReason: null, focusPending: true });
  const prompt =
    `Human guidance has arrived for ${run.ticketKey} question #${q.id}. ` +
    (replyFile ? `Read ${replyFile} in this worktree, ` : "Read the latest human reply in this worktree, ") +
    `continue the ${step} step, and only run step-done when the step is actually complete.`;

  if (run.paneId && (await deps.herdr.paneAlive(run.paneId))) {
    // Confirmed submission: if the reply prompt never landed, fall through to a respawn rather than
    // leaving the run "running" against an agent that never heard the answer it was waiting for.
    if (await deps.herdr.agentSend(run.paneId, prompt, { confirm: true })) {
      await showRunPaneOwner(deps, run, "running", step);
      deps.log("info", `${run.ticketKey}: resumed ${step} with human reply #${q.id}`);
      return;
    }
    deps.log("warn", `${run.ticketKey}: human-reply prompt to ${run.paneId} was not confirmed — respawning ${step}`);
  }

  await spawnStep(deps, deps.store.getRun(run.id)!, belt, src, step);
  deps.log("info", `${run.ticketKey}: respawned ${step} after human reply #${q.id}`);
}

/** Persist a bounce's findings where the bounced-to step's agent will read them. Named by the
 *  TARGET step (feedback-<toStep>.md, overwritten on each bounce) so the target's prompt can surface
 *  it deterministically (see renderStepPromptImpl's rework banner). Returns the worktree-relative
 *  path (for the event + re-dispatch prompt), or null if the run has no worktree. */
function writeBounceNote(run: Run, sender: string, toStep: string, reason: string): string | null {
  if (!run.worktreePath) return null;
  const dir = join(run.worktreePath, MEMORY_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `feedback-${toStep}.md`),
    [
      `# Rework requested for ${run.ticketKey}`,
      "",
      `The **${sender}** sent this work back to the **${toStep}** step. Address the findings`,
      `below, then finish the ${toStep} step as normal (the pipeline will run forward from here again).`,
      "",
      "## Findings to address",
      "",
      reason.trim(),
      "",
    ].join("\n"),
  );
  return `${MEMORY_DIR}/feedback-${toStep}.md`;
}

/**
 * Backward transition: the current (running) step sends the run BACK to an earlier step for rework.
 * The counterpart to reconcileStep's forward `nextStep` advance and the analog of the ask-human
 * park/resume — but re-pointed at an earlier step, with three load-bearing extras beyond a human
 * resume's own-step re-base (resumeAfterHumanReply clears only the RESUMED step's done + clocks):
 *   1. CLEAR the target step's `done` (+ reset its heartbeat clocks) — else reconcileStep advances
 *      the just-bounced step instantly on the next tick (it re-reads rs.done, reconcileStep §done).
 *   2. Re-dispatch the TARGET step's own pane (getRunStep(toStep).paneId) — NOT run.paneId, which is
 *      the bouncer's (latest-dispatched) pane.
 *   3. Bump + cap a per-target bounce counter, escalating to attention past limits.maxBounces.
 * Guarded: only from a `running` step (or one whose park a terminal may rescue — see rescuablePark),
 * only to an earlier step the current step declares in `canBounceTo`. The bouncer does NOT step-done,
 * so after the target re-completes the pipeline runs forward and re-enters the (still-not-done)
 * bouncer cleanly.
 *
 * `opts.operator` is the OPERATOR's `rework` (core/signals.ts): the same rewind, driven by a person
 * instead of by the belt. It relaxes exactly the three guards that exist to keep AGENTS inside the
 * belt's control flow — any park (not just the rescuable ones), the issuing step's `canBounceTo`,
 * and the strictly-backward rule (a person may re-run the RUNNING step) — and records a `rework`
 * event instead of `bounced`. Everything else, the bounce cap included, is identical.
 */
export async function bounceStep(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  toStep: string,
  reason: string,
  opts: { operator?: boolean; watch?: boolean } = {},
): Promise<{ ok: boolean; escalated?: boolean; message?: string }> {
  // `watch`: the PR watch sending a `reviewing` run back through its gates because the PR head moved
  // past the evidence (issue #84). It "bounces" from the belt's PR-opening step, which is re-run too
  // so it can relink the fresh evidence in the PR body.
  const watch = opts.watch === true;
  const fromStep = watch ? (belt.steps.find((s) => s.opensPr)?.name ?? null) : run.step;
  const operator = opts.operator === true || watch;
  // A bounce is one of the step's three legal terminals, so it lands from a RESCUABLE park exactly
  // as a step-done does (rescuablePark): the agent finished its assessment and concluded the work
  // has to go back — whether a watchdog had parked the run as a stuck-agent backstop, or the agent
  // had asked a human and then decided it doesn't need the answer to send the work back. Every
  // other park (source stale, PR closed, bounce cap, failing reply poll, config error) stays a hard
  // gate — those need a human decision.
  // An OPERATOR rework lands from ANY park, not just the terminal-rescuable ones: a person is
  // making the judgement the park was waiting for. It is still refused once the belt is over —
  // `reviewing` watches a PR that already exists, and teardown is irreversible.
  const parked = watch ? null : operator ? (run.phase === "waiting_for_human" ? "human" : run.phase === "attention" ? "watchdog" : null) : rescuablePark(deps, run);
  if ((run.phase !== (watch ? "reviewing" : "running") && !parked) || !fromStep) {
    return {
      ok: false,
      message: operator
        ? `the run is in phase "${run.phase}"${fromStep ? "" : " with no active step"} — rework only applies while the belt is still running (running, waiting_for_human or attention)`
        : "no running step to bounce from",
    };
  }
  const from = stepByName(belt, fromStep);
  const to = stepByName(belt, toStep);
  if (!from || !to) return { ok: false, message: `step "${toStep}" is not in belt "${belt.name}"` };
  const idxTo = indexOfStep(belt, toStep);
  const idxFrom = indexOfStep(belt, fromStep);
  // An operator may also re-run the step that is RUNNING (idxTo === idxFrom) — "take this again,
  // with this note" — and is not bound by the issuing step's declared `canBounceTo`, which exists
  // to keep AGENTS from inventing their own control flow. Forward is still refused for both: a
  // step further down the belt has not run yet, so there is nothing to rework.
  if (operator ? idxTo > idxFrom : idxTo >= idxFrom) {
    return { ok: false, message: `${toStep} is not before ${fromStep} — ${operator ? "rework goes backward (or re-runs the running step)" : "bounces only go backward"}` };
  }
  if (!operator && !from.canBounceTo.includes(toStep)) {
    return { ok: false, message: `the ${fromStep} step may not bounce to ${toStep}` };
  }

  const repo = deps.config.repoName;
  // Close a moot question BEFORE the cap check, not with the un-park bookkeeping below: the bounce is
  // valid from here on, so the agent has moved past its question either way — and if the cap escalates
  // to attention, a question left pending would send the eventual `resume` straight back to
  // waiting_for_human on a reply that is never coming.
  if (parked === "human") await closePendingQuestionAsMoot(deps, run, "bounce");
  // Safety backstop only: the loop is meant to end when the later step passes (aligned) or the fix
  // agent asks a human — this cap just catches oscillation. Per-belt override wins over the repo limit.
  const maxBounces = belt.maxBounces ?? deps.config.limits.maxBounces;
  const bounces = deps.store.bumpGuardCounter(run.id, toStep, BOUNCE_CAP.guard);
  if (bounces > maxBounces) {
    await escalateAttention(deps, run, {
      reason: BOUNCE_CAP.escalationReason,
      attentionReason: `bounced to ${toStep} ${bounces}× (max ${maxBounces})`,
      body: `${run.ticketKey}: the work has been bounced back to the ${toStep} step ${bounces} times (from ${fromStep}), exceeding max_bounces (${maxBounces}). A human should look — the agents may be stuck in a rework loop.`,
      detail: { fromStep, toStep, bounces },
    });
    return { ok: true, escalated: true, message: `bounce limit exceeded — escalated to attention` };
  }

  // Un-park bookkeeping for a bounce that rescues a park (the rewind below flips the phase back to
  // running anyway): record the rescue and clear the "⚠ ATTENTION …" cue the escalation published —
  // mirrors reconcileAttention's / reconcileWaitingForHuman's step-done rescues.
  if (parked) {
    const reason = operator ? "rework_from_park" : parked === "human" ? "bounce_after_human_park" : "bounce_after_watchdog_park";
    deps.store.recordEvent({
      runId: run.id,
      repo: deps.config.repoName,
      ticketKey: run.ticketKey,
      type: "resumed",
      detail: { reason, step: fromStep },
    });
    await showRunPaneOwner(deps, run, "running", fromStep);
    deps.log("info", `${run.ticketKey}: ${fromStep} bounced after a ${parked === "human" ? "human" : "watchdog"} park — un-parking`);
  }

  releaseStepLocks(deps, run, from); // bouncing away from this step → free any exclusive_resource it held

  // (1) Clear done + reset heartbeat clocks for the TARGET *and every completed step between it and
  //     the bouncer* — those intermediate steps must actually re-run on the forward pass, not be
  //     skipped on their stale done=true (e.g. a review→fix bounce must force the evidence step to
  //     re-capture the reworked change, not re-PR the pre-fix evidence). The bouncer (idxFrom) didn't
  //     step-done, so it's excluded; its clocks reset when the forward pass respawns it.
  for (let i = idxTo; i < idxFrom; i++) {
    deps.store.upsertRunStep(run.id, belt.steps[i]!.name, { done: false });
    // A re-entry is opening for this step (now, for the target; at the forward re-advance, for an
    // intermediate) — its watch clocks must not survive the prior pass (RWR-18147).
    applyWatchRebase(deps, run.id, belt.steps[i]!, "entry");
  }
  // (2) Open the TARGET's next pass — it re-enters NOW, and its re-rendered prompt stamps the new
  //     pass into its commands so a stale step-done from the pre-bounce pass can't complete the
  //     rework (see applySignal). Intermediates get their bump when the forward advance re-enters.
  //     The pass starts UNDISPATCHED with a fresh wait clock: if the re-dispatch below returns
  //     "waiting" (target pane dead + layout pane unresolvable), later ticks route through the
  //     spawn branch + bounded layout wait instead of the budget watchdog reading the PRIOR pass's
  //     stale started_at and parking the run as "over budget (worker: gone)".
  // (The target's WATCH clocks were re-based by the "entry" rebase above; startedAt here is the
  // pass bookkeeping clock — the fresh layout-wait window for the undispatched rework pass.)
  deps.store.upsertRunStep(run.id, toStep, {
    pass: (deps.store.getRunStep(run.id, toStep)?.pass ?? 0) + 1,
    dispatchedAt: null,
    startedAt: deps.now(),
    absentAt: null,
  });
  const notePath = writeBounceNote(run, watch ? "PR watch" : operator ? "operator" : `${fromStep} step`, toStep, reason);
  // (5) Rewind the active-step pointer. Leaving the watch also ends its green episode: the PR is not
  //     ready to merge until the gates have judged the new head.
  if (watch) deps.store.upsertWatchState(run.id, GREEN_WATCH.step, GREEN_WATCH.watch, { sig: null });
  deps.store.updateRun(run.id, { phase: "running", step: toStep, attentionReason: null, focusPending: true, ...(watch ? { resolverActive: false } : {}) });
  const pass = deps.store.getRunStep(run.id, toStep)?.pass ?? 1;
  deps.store.recordEvent({
    runId: run.id,
    repo,
    ticketKey: run.ticketKey,
    type: operator ? "rework" : "bounced",
    detail: operator ? { by: watch ? "pr_watch" : "operator", fromStep, toStep, pass, bounces, notePath } : { fromStep, toStep, bounces, notePath },
  });
  deps.log("info", `${run.ticketKey}: ${watch ? "PR watch reworked" : operator ? "operator reworked" : `${fromStep} bounced work back`} to ${toStep} (pass ${pass}, #${bounces})`);

  // (6) Re-dispatch the TARGET step through spawnStep — the single dispatch path. It re-renders the
  //     step's prompt (the rework banner surfacing the feedback note first, plus the fresh pass
  //     stamp in every command) and re-prompts the step's own live pane via knownPaneId — layout
  //     and dedicated panes alike — or waits/spawns per the step's config. The old bespoke
  //     live-pane message skipped the re-render, so the agent would finish the rework and run the
  //     PRIOR pass's remembered step-done command — rejected as stale under pass validation.
  // The rewind stands either way; the DISPATCH still obeys the tree guard (a rework target that
  // never commits must not start on someone's uncommitted edit — see parkIfTreeDirty).
  if (await parkIfTreeDirty(deps, deps.store.getRun(run.id)!, to)) {
    return { ok: true, message: `${toStep} was rewound but not dispatched — the worktree is dirty; the run is parked for attention` };
  }
  await spawnStep(deps, deps.store.getRun(run.id)!, belt, src, toStep);
  deps.log("info", `${run.ticketKey}: re-dispatched ${toStep} for rework`);
  return { ok: true };
}

/**
 * Consume the run's unconsumed pending signal, if any — the durable half of the non-monotonic
 * agent signals (bounce / ask-human; see applySignal and the `agent_signal` ledger kind). MUST be
 * called under the run's lock; takes no locks itself. Applies the effect, stamps the intent with
 * its outcome, and returns the effect's result — or null when there was nothing to consume (the
 * common case, and the consume race: an intent enqueued by applySignal may be consumed by a tick
 * that beat the enqueuer to the lock; the enqueuer then reads the stamped outcome instead).
 * A bounce intent whose issuing step is no longer the run's active step is STALE — the run moved
 * on (e.g. a racing step-done advanced it) — and is rejected rather than applied to the wrong step.
 */
export async function consumePendingSignal(
  deps: Deps,
  run: Run,
  belt: BeltRuntime | undefined,
  src: SourceRuntime,
): Promise<{ ok: boolean; escalated?: boolean; questionId?: number; posted?: boolean; message?: string } | null> {
  const sig = deps.store.unconsumedPendingSignalForRun(run.id);
  if (!sig) return null;
  const reject = (why: string) => {
    deps.store.markPendingSignalConsumed(sig.id, `rejected: ${why}`);
    deps.store.recordEvent({
      runId: run.id,
      repo: deps.config.repoName,
      ticketKey: run.ticketKey,
      type: "signal_rejected",
      detail: { signal: sig.signal, step: sig.step, toStep: sig.toStep, why },
    });
    deps.log("warn", `${run.ticketKey}: queued ${sig.signal} signal rejected: ${why}`);
    return { ok: false, message: why };
  };
  if (sig.signal === "bounce") {
    if (!belt) return reject(`belt "${run.belt}" is not configured`);
    if (sig.step && sig.step !== run.step) return reject(`issued by step "${sig.step}" but the run has moved to "${run.step ?? "(none)"}"`);
    // Pass stamp (when the signal carried one): the issuing step must still be on the pass whose
    // prompt minted this bounce — a replay surviving a full rework cycle back to the same step
    // must not rewind the NEW pass on the old pass's findings.
    if (sig.pass != null && sig.step) {
      const cur = deps.store.getRunStep(run.id, sig.step)?.pass;
      if (cur != null && sig.pass !== cur) return reject(`issued on pass ${sig.pass} of "${sig.step}" but that step is on pass ${cur}`);
    }
    const res = await bounceStep(deps, run, belt, src, sig.toStep ?? "", sig.payload);
    if (!res.ok) return reject(res.message ?? "bounce not applicable");
    deps.store.markPendingSignalConsumed(sig.id, res.escalated ? "escalated" : "applied");
    return res;
  }
  const res = await requestHumanInput(deps, run, sig.step ?? run.step ?? "", sig.payload);
  deps.store.markPendingSignalConsumed(sig.id, "applied");
  return res;
}

/**
 * The evidence agent signals it is starting a capture attempt. Bumps the running step's
 * capture-attempt counter and — once it exceeds `limits.maxCaptureAttempts` — parks the run for a
 * human (a flaky app that can't be captured cleanly should surface, not loop forever). This is the
 * ENGINE BACKSTOP behind the evidence prompt's cooperative "re-record a bad take, then ask-human"
 * guidance — the analog of the bounce cap, but the counter is reset on each fresh pass INTO the step
 * (reconcileStep's forward advance + resumeRun), so a legitimate re-capture after a fix rework gets a
 * full budget instead of inheriting the previous pass's count. Only valid for a `gathersEvidence`
 * step that is currently running.
 */
export async function recordCaptureAttempt(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  stepArg?: string,
): Promise<{ ok: boolean; attempts?: number; escalated?: boolean; message?: string }> {
  const step = run.step;
  if (run.phase !== "running" || !step) return { ok: false, message: "no running step to record a capture attempt for" };
  // The signal now names its step explicitly (a belt may have >1 evidence step); reject one
  // addressed to a step that isn't the one currently running (a stale/misaddressed capture-attempt).
  if (stepArg && stepArg !== step) return { ok: false, message: `capture-attempt names step "${stepArg}" but the running step is "${step}"` };
  const s = stepByName(belt, step);
  if (!s) return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
  if (!s.gathersEvidence) return { ok: false, message: `the ${step} step does not gather evidence` };

  const repo = deps.config.repoName;
  const cap = deps.config.limits.maxCaptureAttempts;
  const attempts = deps.store.bumpGuardCounter(run.id, step, CAPTURE_CAP_GUARD.kind);
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "capture_attempt", detail: { step, attempts, cap } });
  if (attempts > cap) {
    await escalateAttention(deps, run, {
      reason: CAPTURE_CAP_GUARD.escalationReason,
      attentionReason: `capture attempt ${attempts} over cap (${cap}) on ${step}`,
      body: `${run.ticketKey}: the ${step} step has begun ${attempts} capture attempts (cap ${cap}) without passing evidence forward. The app may be too flaky to capture cleanly, or the change isn't demonstrable — a human should look.`,
      detail: { step, attempts, cap },
    });
    return { ok: true, attempts, escalated: true, message: `capture attempt cap (${cap}) exceeded — parked for attention` };
  }
  deps.log("info", `${run.ticketKey}: ${step} capture attempt #${attempts}/${cap}`);
  return { ok: true, attempts };
}

/** Consecutive pollHumanReply THROWS before a waiting run escalates (misses never count — humans
 *  are allowed to be slow). Matches MAX_RETRY_ATTEMPTS: on the flat 30s cadence this is ~5 min of
 *  a failing source before the run parks for attention. */
const HUMAN_POLL_ERROR_ESCALATE = MAX_RETRY_ATTEMPTS;

/** Attention reasons raised by a STEP's own execution while its agent is RUNNING — the evidence
 *  flaky-capture cap, the per-step budget, the commit-stall heartbeat, AND the read-only-posture
 *  HEAD-move guard. These are backstops against a misbehaving agent, NOT a veto on its terminal
 *  decision: an agent that reaches a terminal signal is by definition not looping, so a genuine
 *  step-done from the parked step un-parks the run and advances it (reconcileAttention), and a
 *  genuine BOUNCE from it lands the same way (bounceStep accepts a watchdog-parked bouncer). The
 *  layout-pane wait is NOT here: it trips BEFORE the agent exists (no pane ⇒ no agent ⇒ no terminal
 *  signal can ever arrive), so it is rescued by re-attempting the spawn instead — see
 *  STEP_RESPAWN_ATTENTION. The ask-human park is rescued the same way but does not need a reason
 *  code (the PHASE is the park) — see rescuablePark, which routes both. Every OTHER park — source
 *  item gone, PR closed, bounce oscillation, a failing reply poll, config error — needs a human
 *  decision and is never auto-rescued. */
// The union of every registered step primitive's guards whose `autoRescueOnDone` is true — a plugin
// guard participates automatically, no edit to a literal Set. `read_only_violation` arrives via
// READ_ONLY_GUARD on the read-only primitives (its evaluate() lives in core/watches.ts, run by the
// pre-advance watch harness; the guard is the declaration the rescue routing derives from). A completed
// read-only step must never wedge forever on a commit it didn't make (RWR-18204: an evidence step
// parked permanently after the PRIOR work step's still-alive agent committed a trailing lint fix).
// source_item_stale / pr_closed / bounce_limit / human_poll_failing / config parks stay non-auto-rescued.
const STEP_WATCHDOG_ATTENTION = new Set(
  STEP_DESCRIPTORS.flatMap((d) => d.guards)
    .filter((g) => g.autoRescueOnDone)
    .map((g) => g.escalationReason),
);

/** Attention reasons whose park is rescued by RE-ATTEMPTING THE SPAWN, bounded by the guard's
 *  `autoRespawnLimit` — today only the layout-pane wait (`layout_wait_timeout`). Its park means the
 *  step's pane never came up, so no agent exists to ever signal step-done; the only recovery that can
 *  work is re-running the dispatch (RWR-18147: the same spawn succeeded immediately on manual resume —
 *  the original timeout was a transient race, and every such park used to be permanent until a human
 *  resumed it). Derived like STEP_WATCHDOG_ATTENTION, so a plugin guard participates automatically. */
const STEP_RESPAWN_ATTENTION = new Set(
  STEP_DESCRIPTORS.flatMap((d) => d.guards)
    .filter((g) => (g.autoRespawnLimit ?? 0) > 0)
    .map((g) => g.escalationReason),
);

/**
 * Is this run PARKED in a way a genuine terminal signal from the parked step may RESCUE?
 *
 * A step has three legal terminals: step-done, bounce, ask-human. Two kinds of park are backstops
 * around a step whose agent is still alive and can still reach one of them, so a terminal that
 * arrives afterwards must be honored rather than vetoed:
 *   - `"watchdog"` — a step-execution watchdog park (budget / stall / flaky-capture cap /
 *     read-only HEAD move): a backstop against a STUCK agent. An agent that reaches a terminal is
 *     by definition not looping.
 *   - `"human"` — the ask-human park. The agent asked a question and then got past the blocker on
 *     its own (or concluded the work has to go back regardless). Without this, a step that
 *     finished after asking sat in `waiting_for_human` forever: `step-done` recorded `rs.done`,
 *     and reconcileWaitingForHuman — which only ever exits on a reply — ignored it (RWR-18609:
 *     an evidence step blocked on a local login asked a human, unblocked itself an hour later,
 *     signalled step-done, and the run never advanced to review).
 *
 * Every OTHER park needs a human decision and is never auto-rescued: source item gone, PR closed,
 * bounce oscillation, a failing reply poll, config error. The layout-pane wait is also excluded —
 * it trips BEFORE the agent exists (no pane ⇒ no agent ⇒ no terminal can ever arrive), so it is
 * rescued by re-attempting the spawn instead (STEP_RESPAWN_ATTENTION).
 */
function rescuablePark(deps: Deps, run: Run): "watchdog" | "human" | null {
  if (run.phase === "waiting_for_human") return "human";
  if (run.phase === "attention" && STEP_WATCHDOG_ATTENTION.has(deps.store.lastAttentionReasonCode(run.id) ?? "")) return "watchdog";
  return null;
}

/**
 * The step that asked a human reached a terminal on its own, so its pending question can never be
 * usefully answered — close it. Three reasons this is not optional bookkeeping:
 *   1. the reply poller runs off `pendingHumanQuestionForRun`, so a row left pending keeps polling
 *      the source for an answer to a dead question;
 *   2. `resumeRun` sends any run holding a pending question straight back to `waiting_for_human`,
 *      so a later attention-resume would re-wedge the very run this rescue just freed;
 *   3. a human staring at the posted comment deserves to know it no longer needs an answer.
 * Closed the way requestHumanInput supersedes a stale ask (`answered` + a synthetic answer), so no
 * new HumanQuestionStatus — and the note is best-effort + only when the question was actually
 * posted. A no-op when nothing is pending, so the rescue paths can call it unconditionally.
 */
async function closePendingQuestionAsMoot(deps: Deps, run: Run, terminal: "step-done" | "bounce"): Promise<void> {
  const q = deps.store.pendingHumanQuestionForRun(run.id);
  if (!q) return;
  const step = q.step ?? run.step ?? "step";
  deps.store.updateHumanQuestion(q.id, {
    status: "answered",
    answer: `(no human reply needed — the ${step} agent resolved this itself and signalled ${terminal})`,
    answeredAt: deps.now(),
  });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "human_question_moot",
    detail: { questionId: q.id, step: q.step, terminal },
  });
  deps.log("info", `${run.ticketKey}: question #${q.id} closed unanswered — the ${step} step signalled ${terminal} on its own`);
  if (!q.externalId) return; // never posted ⇒ nothing for a human to be looking at
  const src = deps.resolveSource(run.workSource);
  if (!src) return;
  await src.client
    .postNote(
      run.ticketKey,
      `✅ ${deps.config.sourceComments.brand}: no answer needed for the question above — the ${step} step resolved it itself and moved on (${terminal}). Leaving this thread here for the record.`,
    )
    .catch((e) => deps.log("warn", `${run.ticketKey}: moot-question note not posted to ${src.name}: ${err(e)}`));
}

/** The item backing a pending human question is gone (deleted/transferred) — the reply can never
 *  arrive. Park for a human; no source note (the item it would go to is what's gone). */
function humanLoopStale(deps: Deps, run: Run, q: HumanQuestion, why: string): Promise<void> {
  return escalateAttention(deps, run, {
    reason: "source_item_stale",
    attentionReason: `work item gone while waiting for a human reply (${why})`,
    body: `${run.ticketKey}: question #${q.id} can never be answered — the work item is gone at the source (${why}). Tear the run down (resuming would just re-park after the next poll finds the item still gone).`,
    detail: { questionId: q.id, why },
    skipSourceNote: true,
  });
}

async function reconcileWaitingForHuman(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, ctx: TickCtx): Promise<void> {
  // A PR merged out from under a parked run must still tear it down — even while we wait on a human
  // question. Mirrors the attention-phase watch (reconcileAttention): once a PR is adopted, a merge
  // (a human merging early without waiting for the step, or CI auto-merge) ends the run and fires the
  // terminal transition, instead of the merge going unnoticed until the question is answered or the
  // run is abandoned (RWR-18204).
  if (belt.watchPr && run.prNumber) {
    const pr = ctx.prSnapshots?.get(run.prNumber) ?? (await currentPr(deps, run));
    if (pr?.state === "MERGED") return teardown(deps, run, "merged", src);
  }

  // The parked step FINISHED while its question was pending: the agent got past whatever blocked it
  // and signalled step-done, which set rs.done while the run sat here. The ask-human park is a wait
  // for guidance the agent no longer needs, never a veto on a completed step (rescuablePark) — so
  // honor the step-done: close the moot question, un-park, and delegate to reconcileStep, which sees
  // rs.done and advances forward normally (evidence → review, etc.). Placed BEFORE the reply poll so
  // a finished step is never polled for again. Fires on the step-done nudge AND on any later tick, so
  // a nudge dropped on run-lock contention still heals here (RWR-18609).
  //
  // The mirror case — a reply landing on a step that already recorded done — stays
  // resumeAfterHumanReply's: `markStepDone` runs OUTSIDE the run lock (applySignal), so a done can
  // still land while this pass holds the lock, and there the human's answer wins.
  if (run.step) {
    const step = stepByName(belt, run.step);
    const rs = deps.store.getRunStep(run.id, run.step);
    if (step && rs?.done) {
      await closePendingQuestionAsMoot(deps, run, "step-done");
      deps.store.updateRun(run.id, { phase: "running", attentionReason: null });
      deps.store.recordEvent({
        runId: run.id,
        repo: deps.config.repoName,
        ticketKey: run.ticketKey,
        type: "resumed",
        detail: { reason: "step_done_after_human_park", step: run.step },
      });
      await showRunPaneOwner(deps, run, "running");
      deps.log("info", `${run.ticketKey}: ${run.step} finished while waiting for a human — un-parking and advancing`);
      return reconcileStep(deps, deps.store.getRun(run.id)!, belt, src, step);
    }
  }

  let q = deps.store.pendingHumanQuestionForRun(run.id);
  if (!q) {
    if (run.step && stepByName(belt, run.step)) {
      deps.log("warn", `${run.ticketKey}: waiting_for_human without a pending question — resuming ${run.step}`);
      deps.store.updateRun(run.id, { phase: "running", attentionReason: null });
    } else {
      await escalateAttention(deps, run, {
        reason: "human_wait_missing_question",
        attentionReason: "waiting_for_human without a pending question",
        body: `${run.ticketKey}: run is waiting_for_human but no pending question exists in the database.`,
      });
    }
    return;
  }

  if (!q.externalId) {
    try {
      q = await postHumanQuestion(deps, src, q);
      deps.store.recordEvent({
        runId: run.id,
        repo: deps.config.repoName,
        ticketKey: run.ticketKey,
        type: "human_question",
        detail: { step: q.step, questionId: q.id, externalId: q.externalId, posted: true, retry: true },
      });
    } catch (e) {
      if (e instanceof StaleItemError) return humanLoopStale(deps, run, q, err(e));
      deps.log("warn", `${run.ticketKey}: human question #${q.id} still not posted: ${err(e)}`);
      return;
    }
  }
  const externalId = q.externalId;
  if (!externalId) return;

  // Poll cadence: a flat 30s clock (RETRY_INTERVAL_SECONDS), gated here so a waiting run isn't
  // polled hot on every event nudge between ticks.
  if (deps.now() < q.nextPollAt) return;

  let reply: HumanReply | null;
  try {
    reply = await src.client.pollHumanReply({
      key: run.ticketKey,
      questionId: q.id,
      externalId,
      externalCreatedAt: q.externalCreatedAt,
    });
  } catch (e) {
    // The item backing the question is gone → escalate now. Anything else is a poll ERROR:
    // rescheduled like a miss (a rate-limited source must not make the Phase A error path hot
    // every tick) but counted separately — a slow HUMAN is normal, a persistently-throwing source
    // is not, and a parked run doesn't occupy capacity so it would otherwise wedge invisibly.
    if (e instanceof StaleItemError) return humanLoopStale(deps, run, q, err(e));
    if (isSourceUnauthenticated(e)) {
      // Auth-held, NOT a poll failure: record + notify (once), reschedule like a normal miss, and
      // NEVER count toward the poll-error escalation. A human is still expected to answer — the
      // source just needs re-auth — so parking the run for attention would be wrong.
      await noteSourceAuthFailure(deps, src.name, e);
      const held = deps.store.recordHumanPollMiss(q.id);
      deps.log("warn", `${run.ticketKey}: reply poll for #${q.id} held — ${src.name} not authenticated (next poll in ${held.nextPollAt - deps.now()}s)`);
      return;
    }
    if (isSourceRateLimited(e)) {
      // Rate-limit-held, NOT a poll failure — same reasoning as the auth branch above: the human is
      // still expected to answer, the backend just needs time, so parking the run would be wrong.
      await noteSourceRateLimited(deps, src.name, e);
      const held = deps.store.recordHumanPollMiss(q.id);
      deps.log("warn", `${run.ticketKey}: reply poll for #${q.id} held — ${src.name} rate limited (next poll in ${held.nextPollAt - deps.now()}s)`);
      return;
    }
    const errored = deps.store.recordHumanPollError(q.id);
    deps.log("warn", `${run.ticketKey}: reply poll for question #${q.id} failed (${errored.pollErrors} consecutive): ${err(e)}`);
    if (errored.pollErrors >= HUMAN_POLL_ERROR_ESCALATE) {
      await escalateAttention(deps, run, {
        reason: "human_poll_failing",
        attentionReason: `reply polling has failed ${errored.pollErrors} times in a row`,
        body: `${run.ticketKey}: polling for a reply to question #${q.id} keeps failing (${err(e)}). The question may need re-posting, or the source is unhealthy — run doctor.`,
        detail: { questionId: q.id, pollErrors: errored.pollErrors },
      });
    }
    return;
  }
  noteSourceAuthRecovered(deps, src.name); // the poll call itself succeeded ⇒ auth is fine
  noteSourceRateLimitCleared(deps, src.name); // …and the budget is back
  if (!reply) {
    const missed = deps.store.recordHumanPollMiss(q.id);
    deps.log("info", `${run.ticketKey}: waiting for human reply to question #${q.id} (next poll in ${missed.nextPollAt - deps.now()}s)`);
    return;
  }

  const answered = deps.store.answerHumanQuestion(q.id, reply);
  const replyFile = writeHumanReply(run, q, reply.body, reply.author);
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "human_reply",
    detail: { questionId: q.id, externalId: reply.externalId, author: reply.author ?? null, replyFile },
  });
  await resumeAfterHumanReply(deps, run, belt, src, answered, replyFile);
}

/** The step's layout-wait guard (attached only when the step ref configures a tab/pane) and its
 *  bounded respawn budget. The budget's counter lives in `guard_counters` keyed by the guard's kind,
 *  bumped once per consumed wait window and reset on successful dispatch (spawnStep) or human resume. */
const layoutWaitGuard = (step: StepConfig): GuardSpec | undefined => step.guards.find((g) => g.kind === "layout_wait");

/** Re-attempt the layout's own `agent start` for a step whose configured pane is up but has no agent.
 *
 *  The layout hook builds a worktree's panes ONCE and starts their agents once; a start that fails
 *  (herdr's `agent_not_ready` — Claude Code's folder-trust prompt, a cold harness, a transient race)
 *  leaves the pane sitting at a shell prompt forever, and every window of the step's layout wait then
 *  expires against a pane nothing will ever bring an agent to. Re-running the SAME adoption (kind and
 *  args straight from the layout pane's `agent:` block, trust pre-answered) is the only recovery that
 *  can work without a human.
 *
 *  One ordering note: herdr keeps a starting agent's NAME reserved for as long as its own `agent start`
 *  is waiting out the pane's readiness timeout, so a re-adopt issued INSIDE that window is refused
 *  `agent_name_taken` — logged like any other failed start, and retried by the next window. With the
 *  defaults that cannot happen (a 60s start timeout inside a 600s wait); it only bites where both are
 *  compressed.
 *
 *  Deliberately narrow: only a pane that resolves by its configured label AND is at an available shell
 *  prompt is touched — that state is herdr's own definition of "no agent here" and of a pane `agent
 *  start` will accept, so this can never interrupt an agent that is merely slow or mid-turn. Answers
 *  whether an agent was started. Never throws (herdr being unreachable is the wait's problem, not
 *  this retry's). */
async function retryLayoutAgent(deps: Deps, run: Run, belt: BeltRuntime, step: StepConfig): Promise<boolean> {
  if (!run.workspaceId || !step.tab || !step.pane) return false;
  try {
    const target = layoutAgentForStep(deps, run, belt, step);
    if (!target) return false; // a pane the layout doesn't declare an agent for — nothing to restart
    const paneId = await deps.herdr.tabPaneByLabel(run.workspaceId, step.tab, step.pane);
    if (!paneId) return false; // the layout hasn't built the pane yet — wait, don't build it here
    if (!(await deps.herdr.paneAtShellPrompt(paneId))) return false; // an agent IS there (or the pane is busy)
    deps.log("warn", `${run.ticketKey}: ${step.tab}/${step.pane} is at a shell prompt with no agent — re-starting ${target.agent.kind}`);
    const name = await adoptLayoutAgent(deps, target.layoutId, target.agent, paneId, run.workspaceId, {
      cwd: run.worktreePath ?? undefined,
      name: target.name,
    });
    return name != null;
  } catch {
    return false; // herdr unreachable / a pane that vanished mid-check — the wait re-arms as before
  }
}

/** The layout pane a step dispatches into: its `agent:` block and the herdr agent NAME the layout
 *  BUILD gave it — which the retry has to reuse exactly.
 *
 *  herdr requires an agent name to be unique among LIVE agents, so the build numbers the agent panes
 *  it walks (`claude-w1`, `claude-w1-2`, …) rather than naming them all after the workspace. A retry
 *  that asked for the bare base name would therefore be refused `agent_name_taken` for every pane but
 *  the first whenever an earlier same-kind pane's agent is alive — which is the normal case (this
 *  repo's own ship layout has four agent panes in one workspace), and it would leave exactly the park
 *  this retry exists to prevent. So the walk here mirrors `applyLayoutImpl`: the layout PRUNED the way
 *  the hook prunes it for a factory-owned run (a dropped tab shifts every later pane's number), tabs
 *  in order, panes in order, accumulating names until the step's own pane. That name is free precisely
 *  because this pane's agent is the one that is not live. A pane with an explicit `agent_name` keeps
 *  it, exactly as the build does. */
function layoutAgentForStep(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  step: StepConfig,
): { layoutId: string; agent: LayoutAgent; name: string } | undefined {
  const resolved = resolveBeltLayout(belt, run.branch ?? undefined, deps.config.layouts);
  if (!resolved || !run.workspaceId) return undefined;
  const { layout } = pruneLayoutToBelt(resolved, belt);
  const taken: string[] = [];
  for (const tab of layout.tabs) {
    for (const pane of tab.panes) {
      if (!pane.agent) continue;
      const name = pane.agent.name ?? deriveAgentName(pane.agent.kind, run.workspaceId, taken);
      if (tab.title === step.tab && pane.title === step.pane) return { layoutId: layout.id, agent: pane.agent, name };
      taken.push(name);
    }
  }
  return undefined;
}

/** A step is waiting for its configured layout pane to come up (an idle agent in tab/pane).
 *  Stay put and retry next tick. Once we've waited past `layout_wait_seconds` (measured from the
 *  step row's started_at), consume one of the guard's bounded respawn credits and RE-ARM the wait in
 *  place: this guard trips before the step's agent exists, so a transient herdr/layout race must be
 *  retried by the engine, not handed to a human (RWR-18147: the identical spawn succeeded the moment
 *  a human resumed — the timeout was a race, not a down layout). Only once the credits are exhausted
 *  does the run park for attention — a pane that is genuinely never coming up still surfaces, just
 *  after (1 + autoRespawnLimit) full windows. Only steps that HAVE a tab/pane ever wait — steps
 *  without one spawn their own pane and never reach here. */
async function handleLayoutWait(deps: Deps, run: Run, belt: BeltRuntime, step: StepConfig): Promise<void> {
  const where = `${step.tab}/${step.pane}`;
  const since = deps.store.getRunStep(run.id, step.name)?.startedAt ?? deps.now();
  const waited = deps.now() - since;
  if (waited <= deps.config.limits.layoutWaitSeconds) {
    deps.log("info", `${run.ticketKey}: ${step.name} waiting for layout pane ${where} (${waited}s/${deps.config.limits.layoutWaitSeconds}s)`);
    return;
  }
  const guard = layoutWaitGuard(step);
  const limit = guard?.autoRespawnLimit ?? 0;
  if (guard && deps.store.guardCounter(run.id, step.name, guard.kind) < limit) {
    const attempt = deps.store.bumpGuardCounter(run.id, step.name, guard.kind);
    // The pane may be up with NO agent in it — the layout's `agent start` failed (a claude stopped at
    // the folder-trust prompt is the case this was built for). Re-arming alone would then wait out
    // every remaining window for an agent nothing is bringing up, so re-attempt the adoption first.
    const restarted = await retryLayoutAgent(deps, run, belt, step);
    // Re-arm: each retry gets a FULL fresh window, so the budget bounds wall-clock at
    // (1 + limit) × layout_wait_seconds rather than being burned in `limit` consecutive ticks.
    deps.store.upsertRunStep(run.id, step.name, { startedAt: deps.now() });
    deps.store.recordEvent({
      runId: run.id,
      repo: deps.config.repoName,
      ticketKey: run.ticketKey,
      type: "layout_wait_retry",
      detail: { step: step.name, tab: step.tab, pane: step.pane, attempt, limit, agentRestarted: restarted },
    });
    deps.log("warn", `${run.ticketKey}: ${step.name} layout pane ${where} not up after ${waited}s — re-arming the wait (retry ${attempt}/${limit})`);
    return;
  }
  await escalateAttention(deps, run, {
    reason: "layout_wait_timeout",
    attentionReason: `${step.name}: layout pane ${where} never became available`,
    body: `${step.name} step (belt ${belt.name}): configured pane ${where} didn't come up with an idle agent within ${Math.round(deps.config.limits.layoutWaitSeconds / 60)}min${limit > 0 ? ` (${limit} automatic retries exhausted)` : ""} — is the herdr layout for this worktree running?`,
    detail: { step: step.name, tab: step.tab, pane: step.pane, respawnsUsed: limit },
  });
}

/** Clock slack when comparing GitHub's PR timestamp against the run's own start — the two clocks
 *  are independent, and only a PR from a PREVIOUS attempt (hours/days old) is being excluded. */
const PR_AGE_SLACK_SECONDS = 300;

/**
 * Resolve the run's PR. Once a number has been adopted we poll BY NUMBER — that's the PR's durable
 * identity and it keeps resolving after the head branch is deleted (GitHub auto-delete-on-merge).
 * Only the first sighting, before any number is recorded, falls back to branch discovery.
 *
 * Discovery tries every name this run may have pushed — the branch it is on now, then the name its
 * worktree was created under — because an agent may rename the branch to the repo's convention
 * before pushing, and either name can be the PR's head.
 *
 * A discovered PR must be NEWER than the run. A head-branch name is not unique over time: a
 * re-claim, or a convention-shaped rename that drops the per-claim uid, can resolve to the previous
 * attempt's already-merged PR — and adopting that would hand off to the reviewing watch and tear
 * this attempt down on someone else's merge. An unknown `createdAt` (a fake, an older `gh`) is
 * accepted, keeping the old behaviour where the age can't be established.
 */
async function currentPr(deps: Deps, run: Run): Promise<PrInfo | null> {
  if (run.prNumber) return deps.github.prByNumber(deps.ghRepo, run.prNumber);
  for (const branch of runBranchNames(run)) {
    const pr = await deps.github.prForBranch(deps.ghRepo, branch);
    if (!pr) continue;
    if (pr.createdAt != null && pr.createdAt < run.createdAt - PR_AGE_SLACK_SECONDS) {
      deps.log("info", `${run.ticketKey}: ignoring PR #${pr.number} on ${branch} — it predates this run (a previous attempt's PR)`);
      continue;
    }
    return pr;
  }
  return null;
}

/** A PR we own was closed without merging — hand it to a human rather than tearing down silently. */
function prClosedAttention(deps: Deps, run: Run, pr: PrInfo): Promise<void> {
  return escalateAttention(deps, run, {
    reason: "pr_closed",
    attentionReason: `PR #${pr.number} closed without merging`,
    body: `${run.ticketKey}: PR #${pr.number} was closed without being merged (${pr.url}). Reopen it and let the run continue, or tear the run down.`,
    detail: { number: pr.number, url: pr.url },
  });
}

/**
 * Generic per-step gate. Ensures the step's agent is alive, advances on `step-done` (or a merged
 * PR for a PR-opening step), else runs the watchdog: a commit-HEAD stall heartbeat (when the step
 * declares one), a per-step budget, and liveness — escalating to `attention` only when the agent
 * isn't actively working. Re-spawns a dead pane idempotently. When the belt's last step finishes:
 * a work_to_pull_request belt hands off to the reviewing PR-watch; any other belt is done.
 */
/** Release any machine-global exclusive_resource lock a step holds (owner = the run's key), called
 *  when the run LEAVES the step (forward advance or bounce). The step's agent releases its own lock
 *  in the normal path, so this is a backstop: a forgotten or crashed release frees the resource
 *  immediately for the next run instead of waiting out the lock's TTL. Idempotent — a no-op when
 *  nothing is held (releaseLock is owner-scoped to this run's key). */
function releaseStepLocks(deps: Deps, run: Run, step: StepConfig): void {
  for (const g of step.guards) {
    if (g.kind === "exclusive_resource" && g.resourceName) deps.store.releaseLock(g.resourceName, run.ticketKey);
  }
}

/** TREE GUARD at DISPATCH: never start a step that doesn't commit (evidence/review, a custom
 *  read_only gate) on a dirty tree. The alternative is what the factory used to do — film or review
 *  a worktree with someone's uncommitted edit in it, pass, and have the next step discover it — so
 *  this parks the run WITH the diff stat instead of waiting silently. Human-only rescue: only a
 *  person can decide whether that edit should be committed or thrown away. Returns true when it
 *  parked (the caller must not dispatch). */
async function parkIfTreeDirty(deps: Deps, run: Run, step: StepConfig): Promise<boolean> {
  const tree = await checkStepTree(deps, run, step);
  if (tree.ok) return false;
  recordTreeRefusal(deps, run, step.name, tree);
  await escalateAttention(deps, run, {
    reason: "dirty_tree",
    attentionReason: `${step.name} cannot start — ${tree.why}`,
    body: `${run.ticketKey}: the ${step.name} step never commits, so it must start from a clean tree — but ${tree.why}.\n\n${tree.stat}\n\nCommit or revert the change in the worktree, then resume.`,
    detail: { step: step.name, why: tree.why, stat: tree.stat },
  });
  return true;
}

async function reconcileStep(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, step: StepConfig): Promise<void> {
  const rs = deps.store.getRunStep(run.id, step.name);

  // (Re)spawn while the current pass is UNDISPATCHED: first entry (no row / no pane), or a
  // re-entry (bounce rewind, forward re-advance) whose dispatch hasn't landed yet — pane_id alone
  // can't tell those apart, since it's kept across re-entries as the pane-reuse handle
  // (dispatched_at is the per-pass truth). If the step's configured layout pane isn't up yet,
  // wait (bounded → attention) rather than spawning our own.
  //
  // `done` vetoes the respawn: a dispatch that FAILED to record (a dedicated spawn whose readiness
  // wait timed out and threw, leaving pane_id/dispatched_at unset) can still have a live agent that
  // did the work and signalled step-done. Re-spawning then puts a SECOND agent on a finished step —
  // and on the belt's last step it loops forever, because the advance that would end the run sits
  // below this branch and is never reached. The step's work is done; fall through and advance it.
  if (!rs?.done && (!rs || !rs.paneId || rs.dispatchedAt == null)) {
    if (await parkIfTreeDirty(deps, run, step)) return;
    const res = await spawnStep(deps, run, belt, src, step.name);
    if (res.status === "waiting") await handleLayoutWait(deps, run, belt, step);
    return;
  }

  // Only a PR-opening step (work_to_pull_request's `pr`) watches GitHub. Adopt a live (open/merged)
  // PR's number on first sighting; thereafter currentPr polls by that number. Act on a CLOSED PR
  // only when it is *ours* (an adopted number) — a stale CLOSED PR discovered by a reused branch
  // name must not disturb a fresh attempt.
  const pr = step.opensPr ? await currentPr(deps, run) : null;
  if (pr && pr.state !== "CLOSED" && run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });
  if (pr && pr.state === "CLOSED" && pr.number === run.prNumber) return prClosedAttention(deps, run, pr);
  const livePr = pr && pr.state !== "CLOSED" ? pr : null;

  // PRE-ADVANCE watches (the read-only contract, plus any plugin watch declaring the stage): run
  // BEFORE the done-advance, so a completed-but-violating step still parks with its trail and
  // heals through its declared rescue (advance via STEP_WATCHDOG_ATTENTION) instead of slipping
  // through silently. The watch's policy — the tracks-until-working baseline (RWR-18204) — lives
  // in its evaluator (core/watches.ts); the harness applies the declarations.
  const pre = await evaluateStepWatches(deps, run, step, rs, "pre_advance");
  if (pre.action === "park") {
    return escalateAttention(deps, run, { reason: pre.reason, attentionReason: pre.attentionReason, body: pre.body, detail: pre.detail });
  }
  if (pre.action === "defer") return;
  if (pre.action === "extend") deps.log("info", pre.note);

  // Hand off to the reviewing watch the moment a live, review-ready PR is adopted — WITHOUT waiting
  // for step-done. Once the PR exists the run's job is to WATCH it (merge → teardown → done), and a
  // pr-step agent that keeps working or stalls on a human question must not strand a mergeable PR
  // (RWR-18204: the pr agent opened the PR, then blocked on unanswered questions; the run was
  // abandoned and the human's later merge moved nothing). A DRAFT PR is not up for review yet, so it
  // keeps the step-done gate; a MERGED PR always hands off (even if it merged straight from a draft).
  // Scoped to the belt's TERMINAL PR-opening step — enterReviewing ends the step sequence, so a PR
  // opened by a non-last step (unusual) keeps its existing step-done/merge advance below.
  const prReadyForReview =
    step.opensPr && belt.watchPr && !nextStep(belt, step.name) && !!livePr && (livePr.state === "MERGED" || !livePr.isDraft);

  // Advance when the agent signalled step-done (or its PR merged out from under us, or a review-ready
  // PR was adopted before step-done).
  if (rs.done || livePr?.state === "MERGED" || prReadyForReview) {
    releaseStepLocks(deps, run, step); // leaving the step → free any exclusive_resource it held
    // The step completed this pass — archive an addressed rework note (feedback-<step>.md) under a
    // pass-stamped name. The rework banner keys on the file's existence, so a re-render in a LATER
    // pass must not resurrect findings that were already addressed; the archived copy keeps the
    // trail. Best-effort (a worktree mid-teardown must not fail the advance).
    if (run.worktreePath) {
      const fb = join(run.worktreePath, MEMORY_DIR, `feedback-${step.name}.md`);
      try {
        if (existsSync(fb)) renameSync(fb, join(run.worktreePath, MEMORY_DIR, `feedback-${step.name}-addressed-pass${rs.pass}.md`));
      } catch {
        /* best-effort */
      }
    }
    // produce(...) effects for the products this step just produced — e.g. "on evidence produce →
    // QA". pull_request is excluded here: its effect fires in enterReviewing when the PR is actually
    // adopted (a step-done before the PR is visible must not move the source to in_review). Forward-
    // only through the outbox, like every transition.
    for (const product of step.produces) {
      if (product === "pull_request") continue;
      if ((EFFECT_PRODUCE_PRODUCTS as readonly string[]).includes(product)) {
        await fireEffect(deps, run, belt, src, { on: "produce", product });
      }
    }
    const next = nextStep(belt, step.name);
    if (next) {
      // TREE GUARD before ANY of the next step's entry bookkeeping (the pointer move, the enter
      // effect, the pass bump): a park here leaves the run on the step that just finished, so the
      // resume re-runs this same advance once the tree is clean.
      if (await parkIfTreeDirty(deps, run, next)) return;
      deps.store.updateRun(run.id, { phase: "running", step: next.name });
      // enter(next) effect: a belt may move the source status on entering a step (e.g. entering the
      // QA/review step). No engine default for a non-first step, so it fires only if configured.
      await fireEffect(deps, run, belt, src, { on: "enter", step: next.name });
      // Fresh FORWARD pass into the next step ⇒ reset every counter guard that declares a
      // forward-entry refund (the evidence capture cap). Reset ONLY here on the forward path; a
      // crash-recovery respawn below deliberately does NOT reset (a self-crash can't refill its own
      // cap — GuardSpec.resetOn has no such trigger). Derived from the step's declarations.
      for (const g of guardsResetOn(next.guards, "forward_entry")) deps.store.resetGuardCounter(run.id, next.name, g.kind);
      // Re-base the next step's execution state as we ENTER it, so a stale clock left by a PRIOR
      // pass into that step can't misfire. This bites after a bounce: bounceStep clears an intermediate
      // step's `done` (so it re-runs) but its started_at survives from the first pass — and if
      // the layout pane isn't instantly ready, spawnStep returns "waiting" WITHOUT re-basing the clock,
      // so the very next tick's budget watchdog sees the ancient started_at and parks the run in
      // `attention` before it ever re-runs (RWR-18147: review→work bounce → work re-done → evidence
      // "over budget (idle)", never re-spawned). A first-ever entry is unaffected — the row doesn't
      // exist yet, so this is a plain insert. pane_id is deliberately KEPT: on re-entry it is this
      // step's already-owned layout pane, and spawnStep re-prompts that live pane rather than
      // re-resolving the configured label (which the first dispatch renamed — re-resolution would fail
      // and wedge the run in a layout-wait timeout). A dead pane there falls back to a fresh lookup.
      // `pass` opens the step's next entry: the re-rendered prompt stamps its commands with it, so a
      // stale step-done/bounce minted by a PRIOR pass is rejectable (see applySignal). The new pass
      // starts UNDISPATCHED (dispatched_at null) — if the spawn below returns "waiting" (the reused
      // pane died and the configured label isn't resolvable), the spawn branch + layout-wait
      // machinery own the retry on later ticks, instead of the kept pane_id masking the pass as
      // dispatched and the budget watchdog parking it on a misleading "over budget (worker: gone)".
      const prevPass = deps.store.getRunStep(run.id, next.name)?.pass ?? 0;
      // startedAt here is the PASS bookkeeping clock (the layout-wait window for an undispatched
      // pass, per-attempt dispatch timing) — the budget's own clock lives in watch_state and
      // re-bases via applyWatchRebase below.
      deps.store.upsertRunStep(run.id, next.name, { done: false, startedAt: deps.now(), absentAt: null, pass: prevPass + 1, dispatchedAt: null });
      applyWatchRebase(deps, run.id, next, "entry"); // budget/heartbeat/read-only clocks, per declaration
      deps.log("info", `${run.ticketKey}: ${step.name} done -> ${next.name}`);
      const res = await spawnStep(deps, run, belt, src, next.name);
      if (res.status === "waiting") await handleLayoutWait(deps, run, belt, next);
      return;
    }
    // Last step of the belt.
    if (belt.watchPr) {
      // Hand off to the human-review watch, but only with a real PR. If the agent signalled done
      // before a PR is visible (push lag / never opened), fall through to the watchdog rather than
      // wedging in `reviewing` with no PR to watch.
      if (livePr) return enterReviewing(deps, run, belt, src, livePr.number);
    } else {
      // A non-PR belt is complete the moment its last step signals done.
      deps.log("info", `${run.ticketKey}: ${step.name} done — belt ${belt.name} complete`);
      return teardown(deps, run, "completed", src);
    }
  }

  // Not done — the WATCHDOG-stage watches: the commit-stall heartbeat (which owns its progress
  // tracking) and the per-step budget, in guard order (heartbeat first — the more specific
  // diagnosis wins a double-trip), plus any plugin watchdog. The harness owns the declared
  // working-pane veto (a LIVE agent is never parked by a timer — the trade being a
  // working-but-wedged agent that never commits falls to the dead-pane recovery below and the
  // operator) and defers the whole pass when herdr can't be asked.
  const outcome = await evaluateStepWatches(deps, run, step, rs, "watchdog");
  if (outcome.action === "defer") return;
  if (outcome.action === "extend") {
    deps.log("info", outcome.note);
    return;
  }
  if (outcome.action === "park") {
    await escalateAttention(deps, run, { reason: outcome.reason, attentionReason: outcome.attentionReason, body: outcome.body, detail: outcome.detail });
    return;
  }

  // Agent pane died before signalling → re-spawn (idempotent recovery). Guarded three ways,
  // because the respawn of a NOT-actually-dead pane puts a duplicate agent into the worktree:
  //  1. herdr unreachable ≠ pane dead — HerdrUnreachableError defers the check to a later tick.
  //  2. A memoized "absent" is re-checked with a FRESH `herdr agent list` before it counts.
  //  3. Two-strike confirmation: the first confirmed absence only records `absentAt`; only a
  //     second confirmed absence past the confirmation window respawns (a herdr-daemon restart
  //     that briefly drops every pane from the list heals in between).
  // A step with NO recorded pane reaches here only when its `done` vetoed the respawn branch above
  // and the advance didn't fire (a PR belt's last step, done before its PR is visible): there is no
  // pane to ask about, so it counts as gone and falls into the same two-strike recovery.
  let alive: boolean;
  try {
    alive = rs.paneId != null && (await deps.herdr.paneAlive(rs.paneId));
    if (!alive && rs.paneId != null) alive = await deps.herdr.paneAlive(rs.paneId, { fresh: true });
  } catch (e) {
    if (e instanceof HerdrUnreachableError) {
      deps.log("warn", `${run.ticketKey}: ${step.name} liveness check deferred — ${e.message}`);
      return;
    }
    throw e;
  }
  if (!alive) {
    // Re-check `done` first: it may have flipped (step-done) after our earlier read, in which
    // case the agent finished and exited — don't relaunch a completed step into a duplicate agent.
    const freshRow = deps.store.getRunStep(run.id, step.name);
    if (freshRow?.done) return; // finished; the next tick advances
    if (freshRow?.absentAt == null) {
      deps.store.upsertRunStep(run.id, step.name, { absentAt: deps.now() });
      deps.log("info", `${run.ticketKey}: ${step.name} pane ${rs.paneId} not listed — confirming before re-spawn`);
      return;
    }
    if (deps.now() - freshRow.absentAt < PANE_ABSENCE_CONFIRM_SECONDS) return; // within the window — wait
    deps.log("info", `${run.ticketKey}: ${step.name} pane gone (confirmed twice) — re-spawning`);
    const res = await spawnStep(deps, run, belt, src, step.name);
    if (res.status === "waiting") {
      // The pane died AND its replacement isn't resolvable right now (a dead layout pane is not
      // recreated by the engine — the layout hook fires once per worktree). Mark the pass
      // undispatched with a fresh wait clock so the spawn branch + bounded layout wait own the
      // retry and the eventual escalation — instead of this branch silently re-trying every tick
      // until the budget watchdog parks the run with a misleading "over budget (worker: gone)".
      deps.store.upsertRunStep(run.id, step.name, { dispatchedAt: null, startedAt: deps.now(), absentAt: null });
      deps.log("warn", `${run.ticketKey}: ${step.name} replacement pane not available — handing the retry to the layout wait`);
    }
    return;
  }
  if (rs.absentAt != null) deps.store.upsertRunStep(run.id, step.name, { absentAt: null }); // seen alive again
  // Alive, not done, no watchdog verdict: the one remaining shape is an agent sitting at its prompt
  // with nothing prompting it. Nudge it once, well before any watch trips.
  await nudgeIdleStepAgent(deps, run, step, rs);
  deps.log("info", `${run.ticketKey}: awaiting step-done ${step.name} (pane ${rs.paneId})`);
}

// --- the idle-agent nudge (one code path, two callers) ----------------------------------------
// The commonest wedge in the factory is an agent that finished its work — or drifted off — and
// never ran `step-done`. It sits at its prompt, perfectly alive, until the stall or budget window
// expires 45-60 minutes later and parks the run for a human. One message heals it.
//
// Only a pane at its PROMPT is nudged (idle, or done having finished a turn — isReadyForInput): a
// `working` pane is mid-turn (its own work, an on-demand question, or human-driven — injecting a
// foreign turn interleaves two conversations), and a dead pane is the respawn machinery's job
// (absence confirmation → spawnStep). The nudge points at the pass's rendered prompt file, whose
// baked step-done command carries the still-valid --pass stamp (neither a resume nor a nudge ever
// bumps the pass).
//
// Both callers — the human `resume` and the proactive idle nudge below — send the IDENTICAL text to
// the identical set of pane states, so that lives here once: a drift between "what resume sends" and
// "what the watchdog-preempting nudge sends" is a silent bug nobody would see until an agent
// answered one and not the other.
//
// What the two callers do NOT share is the handshake, and they must not:
//
//  * `fresh` — resume forces an unmemoized pane read (a one-shot operator action arriving right
//    after the agent finished); the per-tick nudge rides the ~5s agents memo.
//  * `confirm` — `agentSend({ confirm: true })` is `agent prompt --wait --until working --timeout
//    20s`, and BOTH callers run inside the run lock. For a human resume that is fine (one action,
//    one run). For the per-tick nudge it is actively self-defeating: the lock it pins for up to 20s
//    is the same lock the `step-done` it is trying to elicit needs, so the agent's signal comes
//    back `run busy — the next pass will advance the belt` and the step advances a tick later than
//    it should. A scripted/quiet agent that never reports `working` makes that the COMMON case, not
//    the rare one. The nudge is therefore fire-and-forget: `nudged` then means "herdr accepted the
//    submission", not "the agent demonstrably woke up", and the next tick's pane state tells us the
//    rest for free.
async function nudgeStepAgent(
  deps: Deps,
  run: Run,
  stepName: string,
  paneId: string,
  lead: string,
  opts: { fresh?: boolean; confirm?: boolean } = {},
): Promise<{ nudged: boolean; worker?: string }> {
  try {
    const worker = await deps.herdr.paneState(paneId, opts.fresh ? { fresh: true } : undefined);
    if (!isReadyForInput(worker)) return { nudged: false, worker };
    const nudged = await deps.herdr.agentSend(
      paneId,
      `${lead} Continue the ${stepName} step in this worktree — re-read ${MEMORY_DIR}/prompt-${stepName}.md if you need the full brief. ` +
        `If the step is already complete, write your handoff note and run the step-done command from that prompt now, then stop.`,
      { confirm: opts.confirm === true },
    );
    deps.log(nudged ? "info" : "warn", `${run.ticketKey}: nudge of the ${stepName} agent (pane ${paneId}) ${nudged ? "submitted" : "was not accepted"}`);
    return { nudged, worker };
  } catch {
    /* best-effort — herdr unreachable / pane gone; the caller's own recovery owns it */
    return { nudged: false };
  }
}

// The PROACTIVE half: nudge that idle agent ~5 minutes in instead of parking the run 45 minutes
// later. Runs every tick for every running step whose watchdogs said `none`, so two properties are
// load-bearing:
//
//  * It rides the MEMOIZED pane state (no `fresh: true`). The resume path forces a fresh read
//    because it is a one-shot interactive action; this one is O(runs) per tick, and a fresh read
//    here would re-add exactly the per-run herdr call the batched snapshot work removed.
//  * Once per idle EPISODE, not once per tick. The mark is one `watch_state` row (run, step,
//    `idle_nudge`) — no new run column, the same shape as the `pr_green` mark: `basedAt` = when the
//    pane was first seen idle, `sig` = the HEAD at the moment the nudge was sent (or "nudged" when
//    there is no worktree HEAD to read). The episode ends — and the row clears — when the pane goes
//    `working` again, or when the branch HEAD moves: either is real progress, and the next idle
//    stretch is news again. So idle → nudge → work → idle is two nudges, and idle for an hour is one.
const IDLE_NUDGE = "idle_nudge";

async function nudgeIdleStepAgent(deps: Deps, run: Run, step: StepConfig, rs: RunStep): Promise<void> {
  const window = deps.config.limits.idleNudgeSeconds;
  if (window <= 0 || !rs.paneId) return; // 0 disables the nudge entirely
  const clear = (): void => void deps.store.upsertWatchState(run.id, step.name, IDLE_NUDGE, { sig: null, basedAt: null });

  let worker: string;
  try {
    worker = await deps.herdr.paneState(rs.paneId); // memoized — no extra herdr call per tick
  } catch {
    return; // herdr unreachable / pane gone: the liveness + watchdog paths own recovery
  }
  const st = deps.store.getWatchState(run.id, step.name, IDLE_NUDGE);
  if (worker === "working") {
    if (st?.basedAt != null || st?.sig != null) clear(); // the episode ended — the agent is busy again
    return;
  }
  if (!isReadyForInput(worker)) return; // gone/unknown/blocked: not ours to prompt into

  if (st?.sig != null) {
    // Already nudged in this episode. The only thing that can re-open it from here is a HEAD move
    // (the agent worked and finished between two ticks, so we never observed `working`).
    const head = run.worktreePath ? await deps.git.headSha(run.worktreePath).catch(() => null) : null;
    if (head && head !== st.sig) clear();
    return;
  }
  if (st?.basedAt == null) {
    deps.store.upsertWatchState(run.id, step.name, IDLE_NUDGE, { basedAt: deps.now() });
    return; // first tick that saw it idle — start the clock
  }
  if (deps.now() - st.basedAt < window) return;

  const { nudged } = await nudgeStepAgent(
    deps,
    run,
    step.name,
    rs.paneId,
    `${run.ticketKey}: this pane has been idle for ~${fmtDur(deps.now() - st.basedAt)} and the ${step.name} step has not been signalled done.`,
  );
  // Mark the episode nudged EVEN IF the send wasn't confirmed: one nudge per idle stretch is the
  // contract, and a retry loop on an unconfirmed send is how a wedged pane gets spammed every tick.
  const head = run.worktreePath ? await deps.git.headSha(run.worktreePath).catch(() => null) : null;
  deps.store.upsertWatchState(run.id, step.name, IDLE_NUDGE, { sig: head || "nudged" });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "idle_nudge",
    detail: { step: step.name, pane: rs.paneId, nudged, idleSeconds: deps.now() - st.basedAt },
  });
}

/** Transition the work item to its review state and move the run into the human-review watch.
 *  work_to_pull_request belts only — reached after the PR step opens a PR. */
async function enterReviewing(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, prNumber: number): Promise<void> {
  const repo = deps.config.repoName;
  // produce(pull_request): engine default in_review, overridable by a belt effect on producing it.
  await fireEffect(deps, run, belt, src, { on: "produce", product: "pull_request" }, "in_review");
  // Clear the active step: in `reviewing` there's no belt step running (the engine watches the PR
  // by number). Record prNumber here too so the watch is self-sufficient even if step-adoption was
  // skipped. The watch starts idle (resolverActive=false) — it holds no slot until an actionable
  // review state wakes the resolver. There is no time limit; the watch rides until the PR resolves.
  deps.store.updateRun(run.id, { phase: "reviewing", step: null, prNumber, resolverActive: false });
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "pr_opened", detail: { number: prNumber } });
  deps.log("info", `${run.ticketKey}: PR #${prNumber} -> reviewing`);
}

// --- "ready to merge" notification (the factory NEVER merges) --------------------------------
// Waiting for a human to press Merge is the biggest single cost in the factory, and nothing used to
// tell the operator a PR was ready. When a watched PR goes green — open, not a draft, no unresolved
// review threads, and every check CONCLUDED successfully (pending ≠ green) — notify once, through
// the same `deps.herdr.notify` path as attention/auth so Collie carries it to the phone.
//
// "Once" is keyed on the PR's HEAD COMMIT, stored as the mark in `watch_state` (run, 'pull_request',
// 'pr_green') — no new run column. Two things end an episode, and both have to, because either alone
// is inert on some real repo:
//   * the PR stops being green (a failing or still-running check, a new review thread) — the mark is
//     cleared, so the next green is news again; and
//   * the head commit CHANGES — a push is a new green even on a repo with NO CI at all, where the
//     rollup never moves and nothing else in the signature would change (the factory's own repo is
//     exactly that case, so keying only on green/not-green would make the rule inert where it matters).
// Between them: once per green head, never once per tick, and red → green → red → green is two.
//
// Known, accepted: on a repo that DOES run CI, GitHub can report a pushed commit for a few seconds
// before its check runs exist — an empty rollup reads as green, so a tick landing in that window
// pings early. We take it deliberately. The alternative (wait a tick to confirm) breaks the issue's
// own acceptance criterion ("within a tick of the rollup going green") for every normal case in order
// to smooth a rare one, and the mis-timed ping self-corrects: the next tick sees the checks pending,
// which ends the episode, and the real green notifies again.
//
// No duration is reported. The watch notifies on the FIRST tick that sees a green PR, so any "green
// for …" it could print is either zero or invented from a timestamp that doesn't mean "green since"
// (a head commit's date says nothing about when the last review thread was resolved).
//
// attentionRenotifySeconds throttles nothing here on purpose — a *new* green is news however soon it
// lands, and the episode rule already makes repeats impossible.
const GREEN_WATCH = { step: "pull_request", watch: "pr_green" } as const;

async function noteGreenPr(deps: Deps, run: Run, pr: PrInfo, sig: ReviewSig, evidenceStale: boolean): Promise<void> {
  const st = deps.store.getWatchState(run.id, GREEN_WATCH.step, GREEN_WATCH.watch);
  // The PR-opening step may still be RUNNING: enterReviewing hands off the moment a review-ready PR
  // is adopted, WITHOUT waiting for step-done (see prReadyForReview). Its agent is still polling CI
  // and bot reviews and may still push, so "ready to merge" is a lie until it signals done. Gate on
  // the step's own `done` flag — a bounce clears it, so this also re-arms for a rework pass. Only
  // when the step actually ran here (a row exists): an adopted/resumed run that never spawned a pr
  // step has no row and keeps the old behaviour.
  const prStep = deps.resolveBelt(run.belt)?.steps.find((s) => s.opensPr);
  const prStepState = prStep ? deps.store.getRunStep(run.id, prStep.name) : undefined;
  const stepRunning = prStepState != null && !prStepState.done;
  // Green also needs the gates' verdict to cover this head (issue #84): CI alone is not "ready".
  const green =
    !stepRunning && !evidenceStale && pr.state === "OPEN" && !pr.isDraft && sig.unresolved === 0 && sig.failing === 0 && sig.pending === 0;
  if (!green) {
    if (st?.sig != null) deps.store.upsertWatchState(run.id, GREEN_WATCH.step, GREEN_WATCH.watch, { sig: null });
    return;
  }
  // The head SHA when the lookup carries one; a lookup that doesn't degrades to the green/not-green
  // rule alone (still once per green — it just can't see a push that changes nothing else).
  const mark = pr.headOid || "green";
  if (st?.sig === mark) return; // already told the operator about THIS green, on THIS head

  const title = pr.title ?? run.summary ?? "";
  const body = `${run.ticketKey} is ready to merge — PR #${pr.number}${title ? ` "${title}"` : ""} in ${deps.ghRepo} is green with no unresolved threads · ${pr.url}`;
  await deps.herdr.notify(`herdr-factory: ${run.ticketKey} ready to merge`, body).catch(() => {});
  deps.store.upsertWatchState(run.id, GREEN_WATCH.step, GREEN_WATCH.watch, { sig: mark });
  deps.store.recordEvent({ runId: run.id, repo: deps.config.repoName, ticketKey: run.ticketKey, type: "pr_green", detail: { number: pr.number, head: pr.headOid } });
  deps.log("info", `${run.ticketKey}: PR #${pr.number} is green and mergeable — notified the operator (the factory never merges)`);
}

async function reconcileReviewing(deps: Deps, run: Run, src: SourceRuntime, ctx: TickCtx): Promise<void> {
  const repo = deps.config.repoName;
  // Prefer the tick's batched snapshot (state + signature in one shared GraphQL request);
  // fall back to per-run polling for nudge callers or when the batch fetch failed.
  const snap = run.prNumber != null ? ctx.prSnapshots?.get(run.prNumber) : undefined;
  const pr = snap ?? (await currentPr(deps, run));
  if (!pr) return;
  if (run.prNumber !== pr.number) deps.store.updateRun(run.id, { prNumber: pr.number });

  if (pr.state === "MERGED") return teardown(deps, run, "merged", src);
  if (pr.state === "CLOSED") return prClosedAttention(deps, run, pr);

  // The watch has NO time limit (there is no watch_hours) — it rides until the PR merges or closes.
  const sig = snap?.sig ?? (await deps.github.reviewSignature(deps.ghRepo, pr.number));
  const actionable = sig.unresolved > 0 || sig.failing > 0;
  // Evidence belongs to a head: a code change pushed since the gates judged the PR sends the run back
  // through them — once the pushing agent is done (the pr step signalled, the resolver went idle).
  const belt = deps.resolveBelt(run.belt);
  const gates = belt ? verificationSteps(belt.steps) : [];
  const ev = await observeEvidenceHead(deps, run, gates, pr.headOid);
  const prStep = belt?.steps.find((s) => s.opensPr);
  const prStepRunning = prStep != null && deps.store.getRunStep(run.id, prStep.name)?.done === false;
  // Self-check (issue #86): once the resolver has pushed its fix for a review verdict, the gates re-run
  // over reviewed-head..new-head — even for a docs-only fix, so the next round is always posted.
  const hf = readHfReview(deps, run);
  const selfCheck = hf?.phase === "fixing" && gates.length > 0 && !!pr.headOid && !pr.headOid.startsWith(hf.reviewedHead ?? "\0");
  if ((ev?.stale || selfCheck) && belt && !run.resolverActive && !prStepRunning) {
    const files = !ev ? "" : ev.files.length ? ev.files.map((f) => `- \`${f}\``).join("\n") : "- (git could not list them — treat everything as changed)";
    const reason = !ev?.stale
      ? ""
      : `PR #${pr.number}'s head moved from \`${ev.evidenceHead}\` (what the evidence and review covered) to \`${ev.prHead}\` ` +
      `with code changes — pushed while the run was watching the PR (a review-thread fix or a CI fix). ` +
      `Judge the NEW head: re-verify every criterion these files could affect.\n\n` +
      `Before anything else, if PR #${pr.number}'s description embeds evidence, mark it stale in place — add ` +
      `\`> ⚠ Evidence filmed at ${ev.evidenceHead.slice(0, 7)}, superseded by ${ev.prHead.slice(0, 7)} — re-filming.\` ` +
      `at the top of the evidence block (\`gh pr view ${pr.number} --json body\`, then \`gh pr edit ${pr.number} --body-file <file>\`; change nothing else). ` +
      `The pr step replaces the block with this pass's evidence.\n\nChanged since the evidence:\n${files}`;
    const next: HfReview | null = selfCheck ? { ...hf!, phase: "self-check", round: hf!.round + 1 } : null;
    const note = (last: boolean) => selfCheckNote({ prNumber: pr.number, brand: deps.config.sourceComments.brand, hf: next!, newHead: pr.headOid!, last });
    const lead = next ? note(gates.length === 1) + (reason ? "\n\n" + reason : "") : reason;
    const res = await bounceStep(deps, run, belt, src, gates[0]!.name, lead, { watch: true });
    if (res.ok && next && !res.escalated) {
      // The later gates enter on the forward pass; each reads its own self-check note there.
      gates.slice(1).forEach((g, i) => writeBounceNote(run, "PR watch", g.name, note(i === gates.length - 2)));
      writeHfReview(deps, run, next);
    }
    if (res.ok) return;
    deps.log("warn", `${run.ticketKey}: PR #${pr.number} evidence is stale but the rework did not start — ${res.message}`);
  }
  const handoff = await observeReviewVerdict(deps, run, pr, snap?.review);
  const hfNow = readHfReview(deps, run);
  // A verdict still being fixed (or left to the operator) is not ready to merge, whatever CI says.
  const hfBusy = handoff != null || (hfNow != null && hfNow.phase !== "clean");
  await noteGreenPr(deps, run, pr, sig, ev?.stale === true || hfBusy);
  // A review state we haven't handled yet — the trigger to (re)wake the resolver.
  const fresh = (actionable && sig.sig !== run.lastThreadSig) || handoff != null;

  // Dynamic occupancy: a reviewing run holds a max_active_workspaces slot ONLY while its resolver
  // is actively working. We need the resolver's live pane state only when there's fresh work to
  // hand it, OR when we currently believe it's active (to notice it going idle and release the
  // slot). Pure idle-watching — nothing fresh, resolver already idle — skips the pane call entirely
  // and holds no slot, so a PR can sit in review indefinitely without starving new claims.
  if (!fresh && !run.resolverActive) return;

  let wstate: string;
  try {
    wstate = run.paneId ? await deps.herdr.paneState(run.paneId) : "gone";
  } catch (e) {
    if (e instanceof HerdrUnreachableError) return; // can't tell if the resolver is mid-fix — retry next tick
    throw e;
  }
  const working = wstate === "working";

  if (!fresh) {
    // Reached only when we believed the resolver was active (guard above): once it goes idle, drop
    // the flag so the watch stops holding a slot. The PR keeps being watched — just for free.
    if (!working) {
      // A fix pass that pushed nothing never trips the self-check (the head is still reviewedHead).
      // Settle it here, or hfBusy stays true and the board never says ready to merge.
      settleIdleFix(deps, run, pr);
      deps.store.updateRun(run.id, { resolverActive: false });
      deps.log("info", `${run.ticketKey}: resolver idle — PR #${pr.number} watch no longer holds a slot`);
    }
    return;
  }

  // Fresh review state to address.
  if (working) {
    // Resolver already mid-fix — it holds a slot; don't pile on. Ensure the flag reflects that.
    if (!run.resolverActive) deps.store.updateRun(run.id, { resolverActive: true });
    return;
  }

  // Only record the signature as handled (and claim a slot) if the resolver actually launched —
  // otherwise a failed spawn would mark it done and never retry, silently dropping the review round.
  const woke = await wakeResolver(deps, run, pr.number, handoff ? fixBrief(pr.number, handoff.id, handoff.verdict, handoff.body, pr.headOid) : "");
  if (!woke) {
    deps.log("warn", `${run.ticketKey}: resolver spawn failed; retrying next tick`);
    return;
  }
  deps.store.updateRun(run.id, { lastThreadSig: sig.sig, resolverActive: true });
  if (handoff) {
    const v = handoff.verdict;
    const fixing: HfReview = { phase: "fixing", round: v.round ?? (hfNow?.round ?? 0) + 1, reviewedHead: v.head, findings: v.must + v.should + v.nit, fixes: (hfNow?.fixes ?? 0) + 1, must: v.must };
    writeHfReview(deps, run, fixing, handoff.id);
    deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "review_handoff", detail: { number: pr.number, review: handoff.id, ...fixing } });
    deps.log("info", `${run.ticketKey}: PR #${pr.number} review round ${fixing.round} handed to the resolver (${fixing.findings} findings, fix ${fixing.fixes}/${MAX_SELF_CHECKS})`);
  }
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "resolver_woken", detail: { unresolved: sig.unresolved, failing: sig.failing } });
}

/**
 * Read the PR's latest review verdict (issue #86) and decide what the watching run does with it.
 * Returns the verdict to hand to the resolver — the caller marks it handled only once the resolver
 * actually woke — or null. A verdict is accepted only from the factory's own GitHub login, and only
 * when its head is the PR's current head or an ancestor of it. Anything else is marked seen
 * (`review_verdict_skipped`) except a login that could not be resolved, which is retried next tick.
 * A `clean` / `unchanged` / `needs-human` verdict is recorded; past MAX_SELF_CHECKS fix passes a
 * verdict that still wants a fix goes to the operator instead of another round.
 */
async function observeReviewVerdict(
  deps: Deps,
  run: Run,
  pr: PrInfo,
  review: PrSnapshot["review"],
): Promise<{ id: string; body: string; verdict: NonNullable<ReturnType<typeof parseVerdict>> } | null> {
  if (!review || review.id === deps.store.getWatchState(run.id, HF_REVIEW_WATCH.step, HF_REVIEW_WATCH.watch)?.sig) return null;
  const v = parseVerdict(review.body);
  if (!v) {
    deps.store.upsertWatchState(run.id, HF_REVIEW_WATCH.step, HF_REVIEW_WATCH.watch, { sig: review.id });
    return null;
  }
  const login = await deps.github.currentLogin();
  if (!login) return null; // can't tell who posted it — leave it unseen and try next tick
  if ((review.author ?? "").toLowerCase() !== login.toLowerCase()) {
    skipReview(deps, run, pr, review, v, "author");
    return null;
  }
  const onHead = !!v.head && !!pr.headOid?.startsWith(v.head);
  if (!onHead) {
    const ancestor = await reviewHeadIsAncestor(deps, run, v.head, pr.headOid);
    if (ancestor == null) return null; // the fetch failed — the objects may arrive next tick
    if (!ancestor) {
      skipReview(deps, run, pr, review, v, "not-ancestor");
      return null;
    }
  }
  const prev = readHfReview(deps, run);
  const fixes = prev?.fixes ?? 0;
  if (wantsFix(v) && fixes < MAX_SELF_CHECKS) return { id: review.id, body: review.body, verdict: v };
  const human = v.verdicts.includes("needs-human") || wantsFix(v);
  const next: HfReview = { phase: human ? "needs-human" : "clean", round: v.round ?? (prev?.round ?? 0) + 1, reviewedHead: v.head, findings: v.must + v.should + v.nit, fixes, must: v.must };
  writeHfReview(deps, run, next, review.id);
  deps.store.recordEvent({ runId: run.id, repo: deps.config.repoName, ticketKey: run.ticketKey, type: "review_verdict", detail: { number: pr.number, review: review.id, ...next } });
  if (human) {
    const body = `${run.ticketKey}: PR #${pr.number} review round ${next.round} still has must-fix findings after ${fixes} fix pass${fixes === 1 ? "" : "es"} — the operator decides now · ${pr.url}`;
    void deps.herdr.notify(`herdr-factory: ${run.ticketKey} review needs a human`, body).catch(() => {});
    deps.log("info", body);
  }
  return null;
}

/** `true` / `false` when ancestry is known. `null` only when a fetch of the run's branch failed, so
 *  the caller leaves the review unseen. A missing object after a successful fetch is not an ancestor
 *  (the commit is gone from the branch — a force-push). */
async function reviewHeadIsAncestor(deps: Deps, run: Run, ancestor: string | null, head: string | undefined): Promise<boolean | null> {
  const wt = run.worktreePath;
  if (!wt || !ancestor || !head) return false;
  let known = await deps.git.isAncestor(wt, ancestor, head);
  if (known != null) return known;
  if (!run.branch || !(await deps.git.fetchRef(wt, "origin", run.branch))) return null;
  known = await deps.git.isAncestor(wt, ancestor, head);
  return known === true;
}

/** Mark a verdict seen and say why it was not handed off. Keeps an in-progress phase; a first
 *  refusal records `clean` so it does not block ready-to-merge. */
function skipReview(deps: Deps, run: Run, pr: PrInfo, review: NonNullable<PrSnapshot["review"]>, v: NonNullable<ReturnType<typeof parseVerdict>>, reason: "not-ancestor" | "author"): void {
  const prev = readHfReview(deps, run);
  const next: HfReview = {
    ...(prev ?? { phase: "clean", round: v.round ?? 0, reviewedHead: v.head, findings: 0, fixes: 0, must: 0 }),
    skipped: { review: review.id, reason, head: v.head },
  };
  writeHfReview(deps, run, next, review.id);
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "review_verdict_skipped",
    detail: { number: pr.number, review: review.id, reason, head: v.head, author: review.author ?? null },
  });
  deps.log("info", `${run.ticketKey}: PR #${pr.number} review ${review.id} ignored (${reason})`);
}

/** The resolver stopped and the PR head is still the commit the verdict judged. A must-fix that
 *  nobody pushed a fix for needs the operator; anything else is clean, so ready-to-merge can fire. */
function settleIdleFix(deps: Deps, run: Run, pr: PrInfo): void {
  const hf = readHfReview(deps, run);
  if (!hf || hf.phase !== "fixing" || hf.idle) return;
  if (!hf.reviewedHead || !pr.headOid?.startsWith(hf.reviewedHead)) return;
  const noMust = hf.must === 0;
  const next: HfReview = { ...hf, phase: noMust ? "clean" : "needs-human", idle: true };
  writeHfReview(deps, run, next);
  deps.store.recordEvent({ runId: run.id, repo: deps.config.repoName, ticketKey: run.ticketKey, type: "review_verdict", detail: { number: pr.number, idle: true, ...next } });
  if (noMust) {
    deps.log("info", `${run.ticketKey}: PR #${pr.number} review round ${next.round} — the resolver pushed nothing and the verdict had no must-fix, so it is clean`);
    return;
  }
  const body = `${run.ticketKey}: PR #${pr.number} review round ${next.round} — the resolver finished without pushing, and a must-fix remains. The operator decides now · ${pr.url}`;
  void deps.herdr.notify(`herdr-factory: ${run.ticketKey} review needs a human`, body).catch(() => {});
  deps.log("info", body);
}

/**
 * Attention isn't necessarily a dead end. For a work_to_pull_request belt whose run has already
 * opened a PR (prNumber set), keep polling that PR by number even while parked here: a merge that
 * lands while a human is looking — or after an escalation unrelated to the PR (watch timeout, step
 * budget) — should still tear the run down and reclaim its slot. A still-open/closed PR leaves the
 * attention state untouched (the human is handling it); non-PR belts and pre-PR runs stay put.
 * While parked, the operator is re-notified periodically — the one-shot escalation notify is easy
 * to miss, and a parked run must never go silently stale.
 */
async function reconcileAttention(deps: Deps, run: Run, belt: BeltRuntime, src: SourceRuntime, ctx: TickCtx): Promise<void> {
  // A step-execution watchdog (evidence flaky-capture cap, per-step budget/stall) parked this run —
  // but its agent went on to genuinely FINISH the step and signal step-done, which set rs.done while
  // the run sat here. Since that watchdog is a backstop against a stuck agent, not a veto on completed
  // work, honor the step-done: un-park and delegate to reconcileStep, which sees rs.done and advances
  // forward normally (the evidence step → review, etc.). This is what keeps a non-gating step
  // (evidence) from wedging the pipeline when a flaky app needed more than the capped number of takes.
  // Fires on the step-done nudge AND on any later tick, so a nudge dropped on run-lock contention
  // still heals here. Guarded to a still-active belt step that reports done, and only for the watchdog
  // reasons — a source-stale / pr-closed / bounce / human / config park is left for a human, and a
  // layout-wait park (whose step never got an agent, so no step-done can arrive) is rescued by the
  // bounded respawn branch below instead.
  if (run.step) {
    const step = stepByName(belt, run.step);
    const rs = deps.store.getRunStep(run.id, run.step);
    if (step && rs?.done && rescuablePark(deps, run) === "watchdog") {
      // A run parked OUT of waiting_for_human (a failing reply poll) can reach here still holding its
      // question. Advancing with it pending would leave the poller chasing a dead thread and would send
      // a later `resume` back to waiting_for_human — so close it, exactly as the human-park rescue does.
      await closePendingQuestionAsMoot(deps, run, "step-done");
      deps.store.updateRun(run.id, { phase: "running", attentionReason: null });
      // A read_only_violation park heals by ADVANCING the completed step. Clear its enforcement
      // baseline so the pre-advance watch skips the read-only HEAD check (which would otherwise
      // re-detect the same move and re-park before reaching the done-advance) — mirrors resumeRun.
      if (step.readOnly) deps.store.upsertWatchState(run.id, run.step, "read_only", { sig: null, basedAt: null });
      deps.store.recordEvent({
        runId: run.id,
        repo: deps.config.repoName,
        ticketKey: run.ticketKey,
        type: "resumed",
        detail: { reason: "step_done_after_watchdog_park", step: run.step },
      });
      // Clear the "⚠ ATTENTION …" cue the escalation published (best-effort).
      await showRunPaneOwner(deps, run, "running");
      deps.log("info", `${run.ticketKey}: ${run.step} finished after a watchdog park — un-parking and advancing`);
      return reconcileStep(deps, deps.store.getRun(run.id)!, belt, src, step);
    }
  }
  if (belt.watchPr && run.prNumber) {
    const pr = ctx.prSnapshots?.get(run.prNumber) ?? (await currentPr(deps, run));
    if (pr?.state === "MERGED") return teardown(deps, run, "merged", src);
  }
  // A layout-wait park can NEVER heal via step-done — the pane never came up, so no agent exists to
  // signal it. Its rescue is to RE-ATTEMPT THE SPAWN: while the guard's bounded respawn budget lasts,
  // un-park the run back to where it was (running its step, or claiming when the belt's first
  // dispatch never landed), re-arm the wait clock, and re-dispatch on this same pass. This is also
  // what heals runs parked by pre-fix code (their budget is untouched). Once the budget is exhausted
  // the park is a genuine human park: the re-notify below keeps it visible until a human `resume`
  // (which grants a fresh budget). Idempotent + run-locked like every other pass over this run.
  const reasonCode = deps.store.lastAttentionReasonCode(run.id);
  if (reasonCode && STEP_RESPAWN_ATTENTION.has(reasonCode)) {
    const step = run.step ? stepByName(belt, run.step) : firstStep(belt);
    const guard = step ? step.guards.find((g) => g.escalationReason === reasonCode) : undefined;
    const limit = guard?.autoRespawnLimit ?? 0;
    if (step && guard && deps.store.guardCounter(run.id, step.name, guard.kind) < limit) {
      const attempt = deps.store.bumpGuardCounter(run.id, step.name, guard.kind);
      // Re-arm the wait window: handleLayoutWait measures from started_at, so without this the
      // ancient clock would re-expire on the very next pass and burn the budget in a few ticks.
      deps.store.upsertRunStep(run.id, step.name, { startedAt: deps.now(), absentAt: null });
      const phase: Run["phase"] = isPreDispatchClaim(deps, run) ? "claiming" : "running";
      deps.store.updateRun(run.id, { phase, attentionReason: null });
      deps.store.recordEvent({
        runId: run.id,
        repo: deps.config.repoName,
        ticketKey: run.ticketKey,
        type: "resumed",
        detail: { reason: "layout_wait_respawn", phase, step: step.name, attempt, limit },
      });
      // Clear the "⚠ ATTENTION …" cue the escalation published. run.paneId here belongs to some
      // EARLIER step (this step's own spawn never landed — that's why it parked), which is exactly
      // what showRunPaneOwner resolves.
      await showRunPaneOwner(deps, run, "running", step.name);
      deps.log("info", `${run.ticketKey}: layout-wait park auto-rescue (${attempt}/${limit}) — re-attempting the ${step.name} dispatch`);
      return dispatchPhase(deps, deps.store.getRun(run.id)!, belt, src, ctx);
    }
  }
  if (notifyDue(run.attentionNotifiedAt, deps.config.limits.attentionRenotifySeconds, deps.now())) {
    deps.store.updateRun(run.id, { attentionNotifiedAt: deps.now() });
    const parkedFor = Math.round((deps.now() - run.updatedAt) / 60);
    await deps.herdr
      .notify(
        `herdr-factory: ${run.ticketKey} still needs attention`,
        `${run.attentionReason ?? "parked"} — resume with \`herdr-factory --repo ${deps.config.repoName} resume ${run.ticketKey}\` or tear it down. (parked ~${parkedFor}min)`,
      )
      .catch(() => {});
  }
}

/**
 * Operator entry point: un-park a run from `attention` and put it back where it was. Most
 * attention reasons are transient (layout pane came up late, a budget expired on a slow-but-fine
 * step, a herdr blip) — before this existed the only way out was teardown, which threw the
 * worktree and all completed work away.
 *
 * The return target is derived from what the run had already reached:
 *   - an active step (`run.step` still in the belt) → `running` with that step's clocks reset
 *     (fresh budget/heartbeat/absence — the stale ones are usually why it parked), and the step's
 *     own IDLE agent re-prompted — the commonest watchdog park is an agent that finished without
 *     running step-done, and without the nudge the resumed run would sit "awaiting step-done"
 *     until the fresh budget re-parked it (a `working` pane is left mid-turn; a dead one is the
 *     respawn path's job);
 *   - a PR being watched (`prNumber` on a watchPr belt) → `reviewing`, idle, with a cleared thread
 *     signature (so the next actionable review state re-wakes the resolver);
 *   - neither → back to `claiming` (materialize + first dispatch are idempotent).
 * The caller reconciles right after, so the re-dispatch happens on this same pass. A resume from a
 * `bounce_limit` park also refunds the bounce budget (matching the capture/layout refunds) — the
 * human has judged the loop worth continuing, and without the refund the next bounce would re-park
 * immediately.
 */
export async function resumeRun(deps: Deps, run: Run): Promise<{ ok: boolean; phase?: string; message?: string }> {
  if (run.phase !== "attention") {
    return { ok: false, message: `run is ${run.phase}, not attention — nothing to resume` };
  }
  const belt = deps.resolveBelt(run.belt);
  if (!belt) return { ok: false, message: `belt "${run.belt}" is not configured — re-add it or tear the run down` };

  const repo = deps.config.repoName;
  // Resuming a bounce-cap park = the human judged the rework loop worth continuing — refund the
  // bounce budget like the capture/layout budgets below, or the very next bounce would land at
  // cap+1 and re-park the run on the same cycle that resumed it, making resume a dead end for this
  // park reason (teardown was effectively the only exit). Scoped to bounce_limit parks: a resume
  // from any other reason leaves the oscillation backstop's counts intact. The counter is keyed on
  // the bounce TARGET step, so refund across the belt's steps.
  if (deps.store.lastAttentionReasonCode(run.id) === BOUNCE_CAP.escalationReason) {
    for (const s of belt.steps) deps.store.resetGuardCounter(run.id, s.name, BOUNCE_CAP.guard);
    deps.log("info", `${run.ticketKey}: bounce budget refunded on resume from a bounce_limit park`);
  }
  // Ledger refunds, derived from the kind declarations: a human resume makes any of the run's
  // pending intents whose kind declares `refundOnResume: "due_now"` due immediately.
  for (const k of INTENT_KINDS) {
    if (k.refundOnResume !== "due_now") continue;
    for (const row of deps.store.listIntents(repo, { runId: run.id, kind: k.kind, status: "pending" })) deps.store.retryIntentNow(row.id);
  }
  const pendingQuestion = deps.store.pendingHumanQuestionForRun(run.id);
  let phase: Run["phase"];
  if (pendingQuestion && run.step && stepByName(belt, run.step)) {
    // The run was parked OUT of waiting_for_human (poll failures / a stale item) with its
    // question still pending. Resuming to `running` would orphan it — the reply poller only
    // runs for waiting_for_human — silently dropping whatever the human answered. Go back to
    // waiting with a fresh poll window instead.
    deps.store.resetHumanPollBackoff(pendingQuestion.id);
    phase = "waiting_for_human";
  } else if (run.step && stepByName(belt, run.step) && !isPreDispatchClaim(deps, run)) {
    // Fresh slate on human resume: re-base every watch clock that declares a resume rebase
    // (budget/heartbeat/read-only) AND reset every counter guard that declares a resume refund
    // (the flaky-capture cap, the layout-wait respawn budget) — a human just intervened, so a
    // capture-cap park must not immediately re-park on the next attempt, and a layout-wait park
    // gets its full bounded respawn budget back. Both derived from the step's guard declarations
    // (rebaseOn / resetOn), so a plugin watch resumes correctly for free.
    const step = stepByName(belt, run.step)!;
    deps.store.upsertRunStep(run.id, run.step, { startedAt: deps.now(), absentAt: null });
    applyWatchRebase(deps, run.id, step, "resume");
    for (const g of guardsResetOn(step.guards, "resume")) deps.store.resetGuardCounter(run.id, step.name, g.kind);
    phase = "running";
  } else if (belt.watchPr && run.prNumber) {
    // Back to watching the PR: clear the handled-signature so the next actionable review state
    // re-wakes the resolver, and start idle (holds no slot until it's actually resolving again).
    deps.store.updateRun(run.id, { lastThreadSig: null, resolverActive: false });
    phase = "reviewing";
  } else {
    // Parked before the first dispatch ever landed (a claiming-time layout wait). Give the resumed
    // claim a fresh wait window + respawn budget, or reconcileClaiming would see the ancient
    // started_at and the spent budget and re-park on the same pass that resumed it.
    const first = firstStep(belt);
    deps.store.upsertRunStep(run.id, first.name, { startedAt: deps.now(), absentAt: null });
    applyWatchRebase(deps, run.id, first, "resume"); // fresh wait/budget window for the resumed claim
    for (const g of guardsResetOn(first.guards, "resume")) deps.store.resetGuardCounter(run.id, first.name, g.kind);
    phase = "claiming";
  }
  deps.store.updateRun(run.id, { phase, attentionReason: null, focusPending: true });
  // Re-prompt the resumed step's own agent when it's sitting idle (best-effort). A human resume is
  // a signal the pane never receives on its own, and the commonest watchdog park is an agent that
  // finished (or drifted off) WITHOUT running step-done — un-parking alone left that agent idle
  // until the fresh budget expired and re-parked the run, making resume a dead end for exactly the
  // case it exists to heal. Same code path as the proactive idle nudge (nudgeStepAgent), with one
  // difference: the read is FRESH, not the ~5s agent-list memo. That memo exists to collapse
  // O(runs) liveness polling inside one tick, and a human resume is a one-shot interactive action
  // arriving right after the agent finished — deciding "still working, don't nudge" from a snapshot
  // taken seconds before the operator acted is how a resume silently nudges nobody.
  let nudged = false;
  let worker: string | undefined;
  if (phase === "running" && run.step) {
    const paneId = deps.store.getRunStep(run.id, run.step)?.paneId;
    if (paneId) {
      ({ nudged, worker } = await nudgeStepAgent(
        deps,
        run,
        run.step,
        paneId,
        `A human resumed ${run.ticketKey} after it was parked (${run.attentionReason ?? "attention"}).`,
        { fresh: true, confirm: true }, // the recorded `nudged` then means "the agent demonstrably woke up"
      ));
      // A human resume is a fresh start for the step — including its idle-nudge episode, so an
      // agent that sat idle through the park can be nudged again if it idles after the resume.
      deps.store.upsertWatchState(run.id, run.step, IDLE_NUDGE, { sig: null, basedAt: null });
    }
  }
  // `worker` rides along so an unexplained `nudged:false` is diagnosable: it names the state the
  // resume actually saw (working ⇒ left mid-turn by design, gone ⇒ the respawn path owns it).
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "resumed", detail: { phase, step: run.step, nudged, worker } });
  // Clear the ⚠ cue (best-effort; a re-spawn would re-publish it anyway).
  await showRunPaneOwner(deps, run, run.step ? "running" : "watching");
  deps.log("info", `${run.ticketKey}: resumed from attention -> ${phase}${run.step ? ` (${run.step})` : ""}`);
  return { ok: true, phase };
}

/**
 * herdr owns workspace+dir+registration; we delete only the local branch. Robust to a
 * partial `worktree remove`: herdr can deregister the git worktree but then error before
 * closing the workspace (and exits 0 with an error body), leaking the workspace + dir.
 * So: remove → verify the workspace is gone, else close it directly → clear the checkout
 * dir → prune the stale git registration → delete the branch (now safely not "checked out").
 */
/**
 * herdr-first, verify-and-fall-back removal of a run's worktree + local branch (§9). Extracted
 * from teardown so belt deletion can reap a LEAKED worktree with the identical sequence — this is
 * the one place the §9 remove→verify→close→rmrf→prune→branch-delete order lives. Pure herdr/git/fs
 * cleanup: it touches neither the DB nor the work source (teardown owns the run-state + write-back).
 */
export async function removeRunWorktree(deps: Deps, run: Run): Promise<void> {
  // The port this run's dev server reserved (hf-port handshake), read BEFORE the checkout — and
  // its git dir — are destroyed. Absent/unreadable ⇒ null ⇒ nothing to reap.
  const devPort = run.worktreePath ? readRunPort(run.worktreePath) : null;
  // Read the worktree's branch BEFORE the checkout is destroyed — it is the last chance to see a
  // rename this run never reconciled (teardown can be the very next thing after it).
  const observed = run.worktreePath ? await deps.git.currentBranch(run.worktreePath).catch(() => null) : null;
  const deleted = new Set<string>();
  if (run.workspaceId) {
    await deps.herdr.worktreeRemove(run.workspaceId);
    if (await deps.herdr.workspaceExists(run.workspaceId)) {
      deps.log("warn", `${run.ticketKey}: worktree remove left workspace ${run.workspaceId} — closing it directly`);
      await deps.herdr.workspaceClose(run.workspaceId);
    }
  }
  // The workspace is closed, so any dev server the layout started has just been reparented —
  // kill the listener on the run's own port (never a pattern kill) before the dir goes. Teardown
  // must never fail because a server was already gone: every outcome here is one log line.
  if (devPort != null) {
    try {
      const killed = await (deps.killPortListeners ?? killPortListeners)(devPort);
      deps.log("info", `${run.ticketKey}: dev server port ${devPort} — ${killed.length > 0 ? `killed pid(s) ${killed.join(", ")}` : "nothing was listening"}`);
    } catch (e) {
      deps.log("warn", `${run.ticketKey}: could not reap the dev server on port ${devPort} — ${err(e)}`);
    }
  }
  // The checkout dir can survive a partial remove. It's always a linked worktree under
  // herdr's worktrees dir, never the main checkout — guard anyway, then prune the now-stale
  // git registration so a re-claim of the same ticket starts clean.
  if (run.worktreePath && run.worktreePath !== deps.config.repo.path) {
    await deps.rmrf(run.worktreePath).catch(() => {});
  }
  await deps.git.worktreePrune(deps.config.repo.path).catch(() => {});
  // Delete EVERY local branch this run may have left behind: the name its worktree was created
  // under, the branch it ended up on (an agent may have renamed it to the repo's convention), and
  // whatever HEAD was pointing at just now — a rename between the last pass and this teardown would
  // otherwise leak. Never a protected branch: a worktree that ended up on the base ref (or the main
  // checkout's branch) is an accident, and deleting a shared branch is not this function's job.
  const protectedNames = await protectedBranches(deps);
  for (const branch of [...runBranchNames(run), observed].filter((b): b is string => !!b)) {
    if (deleted.has(branch)) continue;
    deleted.add(branch);
    if (protectedNames.has(branch)) {
      deps.log("warn", `${run.ticketKey}: not deleting "${branch}" — it is a protected branch (base ref / main checkout)`);
      continue;
    }
    // branchDelete force-removes any worktree still on the branch (an abandoned-while-running run
    // whose agent kept the dir busy) and retries; only warn if the branch STILL can't be deleted.
    const gone = await deps.git.branchDelete(deps.config.repo.path, branch);
    if (!gone) deps.log("warn", `${run.ticketKey}: branch ${branch} could not be deleted (still present after force-prune) — remove it manually`);
  }
}

async function teardown(deps: Deps, run: Run, outcome: Outcome, src: SourceRuntime | undefined): Promise<void> {
  return telemetrySpan(
    "reconcile.teardown",
    {
      repo: deps.config.repoName,
      "run.id": run.id,
      "work.key": run.ticketKey,
      "work.source": src?.name,
      belt: run.belt ?? undefined,
      outcome,
    },
    () => teardownImpl(deps, run, outcome, src),
  );
}

/** Is this process standing inside `dir`? The one question teardown has to ask before it removes a
 *  worktree — see the hand-over in teardownImpl. Resolved, and matched on a path SEGMENT boundary
 *  so `/w/run-1` never counts as inside `/w/run-10`. */
function runningInside(dir: string | null): boolean {
  if (!dir) return false;
  const root = resolve(dir);
  const here = resolve(process.cwd());
  return here === root || here.startsWith(root + sep);
}

async function teardownImpl(deps: Deps, run: Run, outcome: Outcome, src: SourceRuntime | undefined): Promise<void> {
  const repo = deps.config.repoName;
  deps.store.updateRun(run.id, { phase: "tearing_down", outcome });

  // NEVER saw off the branch we are standing on. A terminal signal (`step-done` on a belt's last
  // step, a `bounce` that ends the run, an operator's `teardown`) is applied IN-PROCESS by the CLI
  // the agent runs — and that CLI lives inside the run's own worktree, in a pane of the workspace
  // the next line would remove. `herdr worktree remove --force` HUPs every pane in that workspace,
  // so it kills THIS process mid-call: the run lock it holds is then never released and sits stale
  // for its whole 300s TTL while every tick logs "busy (nudge in flight)" and the run never reaches
  // `ended_at`. (It reproduces on any non-PR belt whose last step signals done from its own pane —
  // a PR belt hides it because teardown lands on the merge watch, which only a tick runs.)
  //
  // The tick loop runs OUTSIDE every worktree, and `tearing_down` is re-entered by reconcileRun
  // (idempotently, from the top), so the safe move is to stamp the phase and hand over. The cost is
  // one tick of latency on a self-signalled teardown; the alternative is a wedged run.
  //
  // The hand-over assumes SOMEONE is outside — true for the in-pane agent CLI this exists for, and
  // for the `teardown` command an operator runs from a worktree. It is NOT true if the engine
  // itself was started from inside a run's worktree: then every tick defers and the run never
  // reaches `ended_at`. That state can't be fixed from here (there is no other process to hand to)
  // but it must not be SILENT, so a deferral that is already re-entering `tearing_down` — i.e. at
  // least the second one for this run — logs at warn. One `info` line is a hand-over; a stream of
  // `warn` lines naming this run is the operator's cue to restart the engine from outside.
  if (runningInside(run.worktreePath)) {
    const repeat = run.phase === "tearing_down"; // the snapshot's phase, before the stamp above
    deps.log(
      repeat ? "warn" : "info",
      `${run.ticketKey}: teardown (${outcome}) deferred — this process is inside the worktree it would remove` +
        (repeat
          ? " — and it has deferred before: if the engine itself was started inside this worktree, nothing will ever finish it. Restart it from outside."
          : " (the next tick, which runs outside it, will finish it)"),
    );
    return;
  }

  // Write the terminal lifecycle state back to the source (never blocks cleanup — the outbox
  // keeps retrying after the run ends). No-op for Jira (merged/aborted/done are unmapped → no
  // network); records merged/aborted/done for local_markdown so the file is never re-listed.
  // Skipped entirely if the source is gone. A belt effect on teardown(outcome) overrides the
  // canonical terminal (e.g. merged → a custom "Shipped" status); the default is unchanged
  // (outcomeToWorkState). When the belt itself is gone (a stranded run), fall back to the default.
  if (src) {
    const belt = deps.resolveBelt(run.belt ?? null);
    const defaultTo = outcomeToWorkState(outcome);
    if (belt) await fireEffect(deps, run, belt, src, { on: "teardown", outcome }, defaultTo);
    else await requestTransition(deps, run, src, defaultTo);
  }

  await removeRunWorktree(deps, run);
  // Free the item for every factory sharing the source (no-op unless its claim guard is on).
  if (src) await releaseClaim(deps, src, run);

  // Still-pending evidence publishes die with the worktree (their bytes lived in the evidence dir
  // just removed). The generic abandon below is what actually drops them — evidence_publish is not
  // survivesTeardown — but count them first so the loss is logged in ITS terms, not as an opaque
  // "N intents abandoned": this is the SSO-was-down-through-merge case, worth naming.
  const droppedUploads = deps.store.listIntents(repo, { kind: "evidence_publish", status: "pending", runId: run.id }).length;
  if (droppedUploads > 0)
    deps.log("warn", `${run.ticketKey}: ${droppedUploads} evidence upload(s) dropped at teardown — bytes never reached S3 (likely SSO was down through merge)`);
  // Drop the run's live ledger intents whose kind dies with the run (external waits, and anything
  // else not marked survivesTeardown; terminal write-backs must outlive the run).
  const teardownKinds = INTENT_KINDS.filter((k) => !k.survivesTeardown).map((k) => k.kind);
  const droppedIntents = teardownKinds.length > 0 ? deps.store.abandonIntentsForRun(run.id, `run torn down (${outcome})`, teardownKinds) : 0;
  if (droppedIntents > 0) deps.log("warn", `${run.ticketKey}: ${droppedIntents} pending intent(s) abandoned at teardown`);

  deps.store.endRun(run.id, outcome);
  deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "torn_down", detail: { outcome } });
  deps.log("info", `${run.ticketKey}: torn down (${outcome})`);
}

// --- manual entry points (used by the CLI) ----------------------------------

/** Manually claim + start a single item on a named belt (the `claim` command). */
export async function claimTicket(deps: Deps, beltName: string, ticketKey: string): Promise<void> {
  const belt = deps.resolveBelt(beltName);
  if (!belt) {
    throw new Error(`unknown belt "${beltName}" — configured: ${deps.belts.map((b) => b.name).join(", ") || "(none)"}`);
  }
  const src = deps.resolveSource(belt.source);
  if (!src) throw new Error(`belt "${beltName}" references unconfigured work source "${belt.source}"`);
  if (deps.store.activeRunForTicket(deps.config.repoName, src.name, ticketKey)) {
    deps.log("warn", `${ticketKey}: already has an active run in source "${src.name}"`);
    return;
  }
  const ticket = await src.client.describe(ticketKey);
  // INV-11: describe may normalize an alternate identifier to the canonical key (e.g. a display
  // id → immutable id). Re-check dedup against the key that will actually be claimed, or the same
  // item could be claimed twice under two spellings.
  if (ticket.key !== ticketKey && deps.store.activeRunForTicket(deps.config.repoName, src.name, ticket.key)) {
    deps.log("warn", `${ticketKey}: already has an active run in source "${src.name}" (as ${ticket.key})`);
    return;
  }
  const cap = deps.machine?.maxActiveWorkspaces;
  if (cap === undefined) return claim(deps, belt, src, ticket);
  // The manual path honours the machine cap too, under the same lock Phase B takes — so it holds
  // whether it runs inside the server or directly against the DB with the server down.
  const ran = await withHeartbeatLock(deps, MACHINE_CLAIM_LOCK, tickLockTtl(deps), async () => {
    const full = capacityGate(deps.machine!, deps.store.countOccupyingAll());
    if (full) throw new Error(`${ticketKey}: not claimed — ${full.message}; raise max_active_workspaces in machine.yml or wait for a run to finish`);
    await claim(deps, belt, src, ticket);
  });
  if (!ran) throw new Error(`${ticketKey}: not claimed — another repo is claiming right now (machine claim lock held); retry in a moment`);
}

/** Manually tear down an item's active run (the `teardown` command). With no `sourceName`,
 *  resolves the run by key across sources and errors if the key is ambiguous (active in >1). */
export async function teardownTicket(deps: Deps, ticketKey: string, sourceName?: string): Promise<void> {
  const repo = deps.config.repoName;
  let run: Run | undefined;
  if (sourceName) {
    run = deps.store.activeRunForTicket(repo, sourceName, ticketKey);
  } else {
    const runs = deps.store.activeRunsForKey(repo, ticketKey);
    if (runs.length > 1) {
      throw new Error(`${ticketKey}: active in multiple sources (${runs.map((r) => r.workSource).join(", ")}) — pass --source <name>`);
    }
    run = runs[0];
  }
  if (!run) {
    deps.log("warn", `${ticketKey}: no active run`);
    return;
  }
  // Resolve the source for the lifecycle write-back; undefined (removed source) → teardown skips it.
  await teardown(deps, run, "abandoned", deps.resolveSource(run.workSource));
}
