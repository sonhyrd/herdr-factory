// The TREE GUARD: a step that never commits (evidence, review, or a custom `read_only` gate) is
// pinned to the HEAD it was spawned on, and must find the tree exactly as it was left.
//
// Why this exists (the incident it is named after): an operator typed a follow-up question into the
// work pane AFTER its step-done; the work agent edited a file and left it UNCOMMITTED. Evidence
// filmed code that was about to change, reported success, and review then spent five minutes
// working out who had made the edit before bouncing the whole run. Nothing in the engine looked at
// the tree — `step-done` and step spawn only ever read the run row.
//
// So this is checked at the two seams where a read-only step's verdict is about to be trusted:
//   - its `step-done` (core/signals.ts) — refused, so the AGENT sees the reason on stderr;
//   - its spawn (core/reconcile.ts) — parked, so the run stops loudly instead of filming a tree
//     that is about to change.
// Both refusals carry the diff stat, and the refusal is recorded on the step's `read_only` watch
// state so `explain` can tell an operator what is blocking the step.
//
// The HEAD-moved half deliberately reuses the `read_only` watch's enforcement BASELINE rather than
// a second pin: that baseline tracks live HEAD until this step's own agent is first observed
// working, which is what absorbs the previous step's trailing handoff commits (RWR-18204). An
// unfrozen baseline therefore never refuses — a commit that landed before this agent took over is
// the prior step's, not this one's.
import type { StepConfig } from "../config.ts";
import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";
import { effectiveWatchClock } from "./watches.ts";

export interface TreeVerdict {
  ok: boolean;
  /** Why the tree is not acceptable (a bare clause — callers compose the sentence). */
  why?: string;
  /** The diff stat that proves it (never empty when `ok` is false). */
  stat?: string;
}

/** Is `step`'s worktree still the one it was pinned to — clean, and on the HEAD it started from?
 *  Always ok for a step that commits (work/custom/pr): they are SUPPOSED to move HEAD. */
export async function checkStepTree(deps: Deps, run: Run, step: StepConfig): Promise<TreeVerdict> {
  if (!step.readOnly || !run.worktreePath) return { ok: true };
  const dirty = await deps.git.dirtyStat(run.worktreePath).catch(() => null);
  if (dirty) return { ok: false, why: "the worktree has uncommitted changes", stat: dirty };

  const rs = deps.store.getRunStep(run.id, step.name);
  const baseline = rs ? effectiveWatchClock(deps, rs, "read_only") : { sig: null, basedAt: null };
  if (!baseline.sig || baseline.basedAt == null) return { ok: true }; // not frozen yet — still absorbing the prior step's commits
  const head = await deps.git.headSha(run.worktreePath).catch(() => null);
  if (!head || head === baseline.sig) return { ok: true };
  const stat = await deps.git.diffStat(run.worktreePath, `${baseline.sig}..${head}`).catch(() => "");
  return {
    ok: false,
    why: `HEAD moved from ${baseline.sig.slice(0, 8)} to ${head.slice(0, 8)} while this step ran`,
    stat: stat || `${baseline.sig.slice(0, 8)}..${head.slice(0, 8)} (no stat available)`,
  };
}

/** Record a tree refusal on the step's `read_only` watch state, so `explain` can show an operator
 *  what is blocking the step (the agent already has it on stderr, the operator has nowhere else to
 *  look). Rides the existing watch row's `meta` — no new table, and the row's re-base clears it. */
export function recordTreeRefusal(deps: Deps, run: Run, step: string, verdict: TreeVerdict): void {
  deps.store.upsertWatchState(run.id, step, "read_only", {
    meta: JSON.stringify({ treeRefusedAt: deps.now(), treeRefusedWhy: verdict.why ?? "" }),
  });
}

/** The refusal an agent reads on stderr (and the operator reads in the attention body). */
export function treeRefusalMessage(step: string, verdict: TreeVerdict): string {
  return (
    `the ${step} step cannot finish on this tree — ${verdict.why}. ` +
    `A step that never commits must leave the tree exactly as it found it; commit (or revert) the change on the step that owns it, then retry.\n${verdict.stat}`
  );
}
