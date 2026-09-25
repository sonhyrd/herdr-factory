// The TREE GUARD: a step that never commits (evidence, review, or a custom `read_only` gate) must
// find the worktree exactly as it was handed to it — CLEAN.
//
// Why this exists (the incident it is named after): an operator typed a follow-up question into the
// work pane AFTER its step-done; the work agent edited a file and left it UNCOMMITTED. Evidence
// filmed code that was about to change, reported success, and review then spent five minutes
// working out who had made the edit before bouncing the whole run. Nothing in the engine looked at
// the tree — `step-done` and step spawn only ever read the run row.
//
// So the tree is checked at the two seams where a read-only step's verdict is about to be trusted:
//   - its `step-done` (core/signals.ts) — refused, so the AGENT sees the reason on stderr;
//   - its spawn (core/reconcile.ts) — parked, so the run stops loudly instead of filming a tree
//     that is about to change.
// Both refusals carry the diff stat, and the refusal is recorded on the step's `read_only` watch
// state so `explain` can tell an operator what is blocking the step.
//
// SCOPE — this guard is about UNCOMMITTED work, and deliberately says nothing about HEAD. A commit
// made by (or under) a read-only step is the `read_only` WATCH's business (core/watches.ts): it
// pins HEAD at spawn, absorbs the previous step's trailing handoff commits until this step's agent
// is first seen working, and parks `read_only_violation` on any later move — a park that a genuine
// step-done deliberately RESCUES, because the engine never throws away a completed verdict over
// misbehaviour on the way to it (RWR-18204). Refusing that step-done here as well would wedge the
// run: the agent cannot un-commit, so nothing it can do would clear the refusal. An uncommitted
// edit is the opposite — invisible to HEAD, and trivially actionable (commit it, or revert it).
import { matchesGlob } from "node:path";
import type { StepConfig } from "../config.ts";
import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";

export interface TreeVerdict {
  ok: boolean;
  /** Why the tree is not acceptable (a bare clause — callers compose the sentence). */
  why?: string;
  /** The diff stat that proves it (never empty when `ok` is false). */
  stat?: string;
}

/** Is `step`'s worktree still clean? Always ok for a step that commits (work/custom/pr): a dirty
 *  tree is exactly what those steps are for. */
export async function checkStepTree(deps: Deps, run: Run, step: StepConfig): Promise<TreeVerdict> {
  if (!step.readOnly || !run.worktreePath) return { ok: true };
  const dirty = await deps.git.dirtyStat(run.worktreePath).catch(() => null);
  return dirty ? { ok: false, why: "the worktree has uncommitted changes", stat: dirty } : { ok: true };
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

/** The `requires_changes` guard (issue #125): a step that opts in cannot finish until the branch's
 *  diff against the base touches at least one matching path. Against the BASE, not the pass's own
 *  commits, so a file added on pass 1 still counts on a bounce pass. Only commits count — an
 *  uncommitted file never reaches the PR. Fails open when git can't diff (an unresolvable base):
 *  a guard the agent cannot satisfy would wedge the run, and the later steps still check the work. */
export async function checkRequiredChanges(deps: Deps, run: Run, step: StepConfig): Promise<TreeVerdict> {
  const globs = step.requiresChanges;
  if (!globs?.length || !run.worktreePath) return { ok: true };
  const files = await deps.git.changedSince(run.worktreePath, deps.config.repo.baseRef).catch(() => null);
  if (files == null) {
    deps.log("warn", `${run.ticketKey}: requires_changes on ${step.name} skipped — could not diff against ${deps.config.repo.baseRef}`);
    return { ok: true };
  }
  if (files.some((f) => globs.some((g) => matchesGlob(f, g)))) return { ok: true };
  return {
    ok: false,
    why: `the branch changes no file matching requires_changes (${globs.join(", ")})`,
    stat: files.length ? `changed since ${deps.config.repo.baseRef}:\n${files.join("\n")}` : `nothing changed since ${deps.config.repo.baseRef}`,
  };
}

/** The `requires_changes` refusal an agent reads on stderr. */
export function requiredChangesMessage(step: string, verdict: TreeVerdict): string {
  return `the ${step} step cannot finish yet — ${verdict.why}. Add (or extend) a file under one of those paths, commit it, then retry.\n${verdict.stat}`;
}
