// The single engine-effect implementation for the run-scoped signals — the agent→dispatcher ones
// (step-done · ask-human · bounce · capture-attempt · set-branch) and the operator's `rework`. BOTH
// the HTTP handler (server/app.ts) and the CLI's in-process fallback (cli/index.ts) call this ONE function, so the two can't drift and the
// per-signal lock discipline — declared as data in SIGNAL_DESCRIPTORS (test-pinned in
// test/step-descriptor-contract.test.ts) — is applied in exactly one place instead of hand-picked
// per call site in each of two files. Adding a run-scoped signal is now: one SIGNAL_DESCRIPTORS
// entry + one `case` here + its route's body/response schema; the server/CLI mounting is generic.
//
// (evidence-upload is intentionally NOT here: it is a `product-outbox` signal that does CLI-local S3
// work, not a run-lock nudge — see cli/index.ts.)
import type { Deps } from "./deps.ts";
import type { Run, RunStep } from "../types.ts";
import { resolveActiveRun } from "../resolve.ts";
import { stepByName } from "./step.ts";
import { bounceStep, consumePendingSignal, reconcileRun, recordCaptureAttempt, withRunLock, withRunLockWaiting } from "./reconcile.ts";
import { setRunBranch } from "./run-branch.ts";
import { checkRequiredChanges, checkStepTree, recordTreeRefusal, requiredChangesMessage, treeRefusalMessage } from "./tree-guard.ts";

/** The parsed body an agent signal carries — a superset; each signal reads only the fields it needs.
 *  Structurally compatible with every run-scoped route's validated JSON body (StepDoneBody, …). */
export interface SignalBody {
  key: string;
  step?: string;
  toStep?: string;
  source?: string;
  question?: string;
  reason?: string;
  /** set-branch: the branch name to put the run's worktree on. */
  branch?: string;
  /** The step pass whose prompt minted this signal (step-done / bounce). Absent on prompts rendered
   *  before pass stamping existed — validation then skips the pass check (upgrade safety). */
  pass?: number | string;
}

/** The union of fields the run-scoped signal responses use; each branch fills only its own. Messages
 *  are BARE (no key prefix) — callers prefix the key when they surface them. */
export interface SignalResult {
  ok: boolean;
  advanced?: boolean; // step-done: did the nudge reconcile the run on this call?
  questionId?: number; // ask-human
  posted?: boolean; // ask-human: was the question posted to the source (vs deferred)?
  attempts?: number; // capture-attempt: attempts recorded this pass
  branch?: string; // set-branch: the branch the run is on afterwards
  fromStep?: string; // step-done: the step that was completed
  nextStep?: string; // step-done: the step the run is on afterwards (absent once the belt is over)
  escalated?: boolean; // bounce / capture-attempt: cap hit → parked for attention
  queued?: boolean; // bounce / ask-human: run lock busy — the durable intent applies on the next pass
  message?: string;
}

/** The `waiting` tail shared by the non-monotonic signals (lockDiscipline "waiting"): run `effect`
 *  under this run's lock, serialized against the tick's pass over the run; report it busy if the
 *  lock can't be taken (the agent retries; the next tick is the backstop). */
async function underRunLockWaiting(deps: Deps, runId: number, name: string, effect: () => Promise<SignalResult>): Promise<SignalResult> {
  const { ran, result } = await withRunLockWaiting(deps, runId, effect);
  return ran ? result! : { ok: false, message: `run busy — retry ${name} in a moment` };
}

/** The enqueuer lost the consume race — a concurrent tick consumed its intent while it waited for
 *  the run lock. Translate the stamped outcome into the caller-facing result so the agent still
 *  learns what actually happened to its signal. */
function consumedElsewhere(deps: Deps, intentId: number): SignalResult {
  const sig = deps.store.getPendingSignal(intentId);
  const r = sig?.consumedResult ?? "applied";
  if (r === "applied") return { ok: true, message: "applied by a concurrent reconcile pass" };
  if (r === "escalated") return { ok: true, escalated: true, message: "cap exceeded — parked for attention" };
  return { ok: false, message: r.replace(/^rejected: /, "") };
}

/** Export this step's WALL / SHELL / MODEL time split into the timeline at step-done.
 *
 *  Reconstructing this previously meant decoding the agent harness's own chat store by hand, which
 *  is how a slow-run analysis ends up being a one-off script instead of a query. The split the
 *  factory can state honestly is the one it MEASURED: wall time is the pass's dispatch → done, and
 *  the shell half is the time spent inside gate commands the step ran through `herdr-factory gate`.
 *
 *  ponytail: `shellMs` counts WRAPPED commands only — a gate run bare, or any other subprocess the
 *  agent spawned, lands in `modelMs`. Widen it when (and only when) the engine can read a harness
 *  transcript: Cursor's chat store and Claude Code's transcript both hold the real per-tool split. */
function recordStepTiming(deps: Deps, run: Run, step: string, rs: RunStep | undefined): void {
  const from = rs?.dispatchedAt ?? rs?.startedAt;
  if (!from) return; // never dispatched (a replay against a row that predates the column) — nothing honest to report
  const pass = rs?.pass ?? 1;
  const wallMs = Math.max(0, (deps.now() - from) * 1000);
  const shellMs = deps.store.gateShellMs(run.id, step, pass);
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "step_timing",
    detail: { step, pass, wallMs, shellMs, modelMs: Math.max(0, wallMs - shellMs), gates: deps.store.gateReceiptsFor(run.id).filter((g) => g.step === step && g.pass === pass).length },
  });
}

/** Apply a run-scoped agent signal to its run: resolve the run, then run the per-signal effect under
 *  the lock discipline the signal declares. Returns a bare-message result the caller renders. */
export async function applySignal(deps: Deps, name: string, body: SignalBody): Promise<SignalResult> {
  const repo = deps.config.repoName;
  const run = resolveActiveRun(deps, body.key, body.source);
  if (!run) {
    deps.log("warn", `${body.key}: no active run for ${name}`);
    return { ok: false, message: "no active run" };
  }
  const fresh = () => deps.store.getRun(run.id)!;
  switch (name) {
    case "step-done": {
      const step = body.step!;
      const belt = deps.resolveBelt(run.belt);
      if (belt && !stepByName(belt, step)) return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
      // Identity checks — bounce rewinds make per-step progress non-monotonic, so a replayed or
      // late step-done (a duplicated CLI call, a server+fallback double-apply, an agent re-running
      // a remembered command) must never complete a pass that hasn't run:
      //  - the signal must name the run's ACTIVE step. A non-active step that is already done is
      //    an idempotent replay (friendly noop — the agent's work is acknowledged); anything else
      //    is misaddressed and rejected loudly instead of being recorded then silently wiped by
      //    the next entry's re-base.
      //  - a carried pass stamp must match the step's CURRENT pass (see SIGNAL_DESCRIPTORS).
      // The PR-opening step is the one exception: enterReviewing hands the run to the PR watch as
      // soon as a review-ready PR is adopted, clearing run.step while that agent is still polling
      // CI. Its step-done still has to land — the "ready to merge" notification waits on it.
      const prWatchDone = run.phase === "reviewing" && !!belt && belt.steps.find((s) => s.opensPr)?.name === step;
      if (step !== run.step && deps.store.getRunStep(run.id, step)?.done) {
        return { ok: true, message: `step "${step}" is already recorded done — nothing to do` };
      }
      if (step !== run.step && !prWatchDone) {
        deps.log("warn", `${body.key}: step-done for "${step}" ignored — the active step is "${run.step ?? "(none)"}"`);
        return { ok: false, message: `"${step}" is not the run's active step ("${run.step ?? "none"}") — signal ignored` };
      }
      const rs = deps.store.getRunStep(run.id, step);
      const pass = body.pass != null ? Number(body.pass) : undefined;
      if (pass != null && rs && pass !== rs.pass) {
        deps.log("warn", `${body.key}: stale step-done for ${step} pass ${pass} ignored — the step is on pass ${rs.pass}`);
        return { ok: false, message: `stale step-done for pass ${pass} — the ${step} step is on pass ${rs.pass}; finish the current pass and run its own step-done command` };
      }
      // TREE GUARD: a step that never commits (evidence/review, a custom read_only gate) must
      // leave the tree exactly as it found it. A dirty tree or a HEAD that moved under it means
      // its verdict covers code that is already gone — refuse the step-done, with the diff stat,
      // so the agent sees WHY instead of the run advancing on a stale assessment.
      const cfg = belt ? stepByName(belt, step) : undefined;
      if (cfg) {
        const tree = await checkStepTree(deps, run, cfg);
        if (!tree.ok) {
          recordTreeRefusal(deps, run, step, tree);
          deps.store.recordEvent({ runId: run.id, repo, ticketKey: body.key, type: "step_done_refused", detail: { step, why: tree.why, stat: tree.stat } });
          deps.log("warn", `${body.key}: step-done for ${step} refused — ${tree.why}`);
          return { ok: false, message: treeRefusalMessage(step, tree) };
        }
        const req = await checkRequiredChanges(deps, run, cfg);
        if (!req.ok) {
          deps.store.recordEvent({ runId: run.id, repo, ticketKey: body.key, type: "step_done_refused", detail: { step, why: req.why, stat: req.stat, globs: cfg.requiresChanges } });
          deps.log("warn", `${body.key}: step-done for ${step} refused — ${req.why}`);
          return { ok: false, message: requiredChangesMessage(step, req) };
        }
      }
      deps.store.markStepDone(run.id, step);
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: body.key, type: "step_done", detail: { step, pass: rs?.pass } });
      recordStepTiming(deps, run, step, rs);
      deps.log("info", `${body.key}: step-done ${step} recorded`);
      // The PR-watch case has NOTHING to advance — the belt already moved when the PR was adopted —
      // and an inline reconcile here is unbatched (no tick ctx), so it costs a per-run `pr view` +
      // review-signature query that the tick's one batched snapshot would have covered for free.
      // The next pass picks the flag up and lifts the ready-to-merge gate. (perf-call-budgets pins
      // watching N PRs at one GitHub query per tick; a per-run call here is exactly the decay it
      // exists to catch.)
      if (prWatchDone) {
        return { ok: true, advanced: false, fromStep: step, message: `${step} recorded done — the PR watch picks it up on the next pass` };
      }
      // fire-and-forget (lockDiscipline "fire-and-forget"): the done flag is a monotonic edge, so a
      // per-run lock is enough — the nudge lands even mid-tick, and if this run is busy the next pass
      // advances it.
      const advanced = await withRunLock(deps, run.id, () => reconcileRun(deps, fresh()));
      if (!advanced) deps.log("info", `${body.key}: run busy — the next pass will advance the belt`);
      // The agent's ONLY window onto what its signal did. A silent exit made the previous step's
      // successor run `status` and sleep-retry to find out whether the belt had moved, so say it:
      // where the run landed, or that the advance is the next tick's job.
      const after = deps.store.getRun(run.id);
      const nextStep = after?.step ?? undefined;
      const landed = after?.phase === "running" ? (nextStep ?? "(none)") : (after?.outcome ?? after?.phase ?? "(gone)");
      const message = advanced && landed !== step ? `advanced ${step} → ${landed}` : `${step} recorded done — the dispatcher advances the belt on its next pass`;
      return { ok: true, advanced, fromStep: step, nextStep, message };
    }
    case "ask-human": {
      const step = body.step!;
      const belt = deps.resolveBelt(run.belt);
      if (belt && !stepByName(belt, step)) return { ok: false, message: `step "${step}" is not in belt "${belt.name}"` };
      const src = deps.resolveSource(run.workSource);
      if (!src) return { ok: false, message: `run has no configured work source "${run.workSource}"` };
      // Durable intent FIRST (the transition-outbox pattern): if the apply below can't take the
      // run lock within the bounded wait, the intent survives — reconcileRun consumes it on the
      // next pass — instead of the old silent drop after the agent had already stopped.
      const intent = deps.store.enqueuePendingSignal({ runId: run.id, repo, ticketKey: run.ticketKey, signal: "ask_human", step, payload: body.question! });
      // Non-monotonic phase flip (running → waiting_for_human): a concurrent reconcile on a stale
      // `running` snapshot could advance the step and orphan the question, so hold the run lock.
      const { ran, result } = await withRunLockWaiting(deps, run.id, async () => {
        const res = await consumePendingSignal(deps, fresh(), belt, src);
        if (res?.ok) await reconcileRun(deps, fresh()); // immediate-pass parity: post/poll right away
        return res;
      });
      if (ran) return result ?? consumedElsewhere(deps, intent.id);
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "signal_queued", detail: { signal: "ask_human", step, intentId: intent.id } });
      deps.log("info", `${body.key}: run busy — ask-human queued (intent #${intent.id}); the next reconcile pass posts it`);
      return { ok: true, queued: true, message: "run busy — question recorded; it will be posted on the next reconcile pass" };
    }
    case "bounce": {
      const belt = deps.resolveBelt(run.belt);
      if (!belt) return { ok: false, message: `run has no configured belt "${run.belt}"` };
      const src = deps.resolveSource(run.workSource);
      if (!src) return { ok: false, message: `run has no configured work source "${run.workSource}"` };
      // Static validation before persisting: a typo'd target fails loudly at the agent, not queued
      // and rejected later out of its sight. Dynamic validity (backward-only, canBounceTo, phase)
      // is re-checked at apply time by bounceStep — run state may shift while the intent waits.
      if (!stepByName(belt, body.toStep!)) return { ok: false, message: `step "${body.toStep}" is not in belt "${belt.name}"` };
      // Durable intent FIRST, then the step rewind + pane re-dispatch under the run lock. A lock
      // that stays contended past the bounded wait no longer drops the bounce — the intent is
      // consumed by the next reconcile pass over this run. The intent carries the ISSUING step
      // (--step, rendered into the bouncing step's prompt; processing-time run.step is only the
      // legacy fallback) and its pass stamp, so consume-time validation rejects a signal that
      // outlived its pass instead of rewinding the wrong one.
      const intent = deps.store.enqueuePendingSignal({
        runId: run.id,
        repo,
        ticketKey: run.ticketKey,
        signal: "bounce",
        step: body.step ?? run.step,
        toStep: body.toStep!,
        payload: body.reason!,
        pass: body.pass != null ? Number(body.pass) : null,
      });
      const { ran, result } = await withRunLockWaiting(deps, run.id, () => consumePendingSignal(deps, fresh(), belt, src));
      if (ran) return result ?? consumedElsewhere(deps, intent.id);
      deps.store.recordEvent({ runId: run.id, repo, ticketKey: run.ticketKey, type: "signal_queued", detail: { signal: "bounce", toStep: body.toStep, intentId: intent.id } });
      deps.log("info", `${body.key}: run busy — bounce to ${body.toStep} queued (intent #${intent.id}); the next reconcile pass applies it`);
      return { ok: true, queued: true, message: `run busy — bounce to ${body.toStep} recorded; it will be applied on the next reconcile pass` };
    }
    case "rework": {
      // The OPERATOR's counterpart to the agents' `bounce`: send a live run back for another pass,
      // from outside the belt. Same rewind, same rework banner, same bounce cap — but from any
      // phase and without the issuing step's `canBounceTo` (a human is allowed to re-run a step
      // the belt would never bounce to, including the one that is running).
      const belt = deps.resolveBelt(run.belt);
      if (!belt) return { ok: false, message: `run has no configured belt "${run.belt}"` };
      const src = deps.resolveSource(run.workSource);
      if (!src) return { ok: false, message: `run has no configured work source "${run.workSource}"` };
      if (!stepByName(belt, body.toStep!)) return { ok: false, message: `step "${body.toStep}" is not in belt "${belt.name}"` };
      // WAITING, like bounce: it stops the running step and re-dispatches another — a non-monotonic
      // rewind a concurrent pass on a stale snapshot would fight. An operator can simply retry, so
      // there is no durable intent behind it (the agent signals need one; a person does not).
      return underRunLockWaiting(deps, run.id, name, () => bounceStep(deps, fresh(), belt, src, body.toStep!, body.reason!, { operator: true }));
    }
    case "set-branch": {
      // Rename + track under the run lock: the effect writes git and the run row together, and a
      // concurrent pass would otherwise observe (or overwrite) half of it.
      return underRunLockWaiting(deps, run.id, name, async () => setRunBranch(deps, fresh(), body.branch ?? ""));
    }
    case "capture-attempt": {
      const belt = deps.resolveBelt(run.belt);
      if (!belt) return { ok: false, message: `run has no configured belt "${run.belt}"` };
      // Past the cap this parks the run (a non-monotonic phase flip) — hold the run lock like bounce.
      return underRunLockWaiting(deps, run.id, name, () => recordCaptureAttempt(deps, fresh(), belt, body.step!));
    }
    default:
      throw new Error(`unknown run-scoped signal "${name}"`);
  }
}
