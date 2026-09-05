// The run's BRANCH as tracked state.
//
// A run's identity is its worktree — `runs.worktree_name` (the rendered `workspace_name`, frozen at
// claim) plus the herdr workspace id and checkout path. The BRANCH is not identity: the factory can
// only mint a name from what the work source knows at claim time, and every project has its own
// branching/CI convention (a ticket key the agent only obtains mid-run, a required prefix, a
// validated shape). So an agent may move the worktree onto another branch — through the `set-branch`
// signal (the front door: validated, recorded, refused once a PR is open) or a bare `git branch -m`
// (followed by `syncRunBranch` on the next pass) — and the engine follows it for prompts, PR
// discovery, and branch cleanup.
//
// Two rules keep that safe:
//   - PROTECTED branches are never tracked and never deleted (the base ref, and whatever the MAIN
//     checkout has checked out). A worktree parked on `master` is a mistake, not a rename.
//   - Teardown reaps BOTH names (see reconcile's removeRunWorktree): a rename leaves nothing behind,
//     and an agent that branched off instead of renaming leaves no orphan either.
import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";

/** Why `name` can't be a branch, or null when it's a usable ref name. Mirrors git's own rules
 *  closely enough to fail an agent's typo AT the signal, with a message it can act on, instead of
 *  letting `git branch -m` fail deep inside the engine. */
export function invalidBranchName(name: string): string | null {
  if (!name || !name.trim()) return "a branch name is required";
  if (name !== name.trim()) return "leading/trailing whitespace";
  if (/[\x00-\x20~^:?*[\\]/.test(name)) return "whitespace or one of git's illegal ref characters (~ ^ : ? * [ \\)";
  if (name.includes("..")) return '".." is not allowed in a ref name';
  if (name.includes("@{")) return '"@{" is not allowed in a ref name';
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith(".")) return "a ref name cannot start with -, / or .";
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return "a ref name cannot end with /, . or .lock";
  if (name.includes("//")) return "empty path segment (//)";
  return null;
}

/** Every local branch name this run may have created: the name its worktree was created under and
 *  the branch it is on now (the same string until something renames it). Deduped, in
 *  most-current-first order — the order PR discovery should try them in. */
export function runBranchNames(run: Run): string[] {
  const out: string[] = [];
  for (const n of [run.branch, run.worktreeName]) {
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Branches the factory must never track onto or delete: the configured base ref (both `origin/x`
 *  and the bare `x`) and whatever the MAIN checkout currently has checked out. Cheap, but a git
 *  call — callers only reach for it when a branch actually changed or a teardown is deleting. */
export async function protectedBranches(deps: Deps): Promise<Set<string>> {
  const out = new Set<string>();
  const baseRef = deps.config.repo.baseRef;
  if (baseRef) {
    out.add(baseRef);
    const slash = baseRef.indexOf("/");
    if (slash > 0) out.add(baseRef.slice(slash + 1));
  }
  const mainBranch = await deps.git.currentBranch(deps.config.repo.path).catch(() => null);
  if (mainBranch) out.add(mainBranch);
  return out;
}

/** Persist a branch change: patch the run, record it on the timeline, log it. Returns the fresh run. */
function recordBranchChange(deps: Deps, run: Run, to: string, via: "signal" | "observed"): Run {
  const from = run.branch;
  deps.store.updateRun(run.id, { branch: to });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "branch_changed",
    detail: { from, to, via, worktreeName: run.worktreeName },
  });
  deps.log("info", `${run.ticketKey}: branch ${from ?? "(none)"} -> ${to} (${via})`);
  return deps.store.getRun(run.id) ?? { ...run, branch: to };
}

/**
 * Follow the worktree onto whatever branch it is actually on — the engine's backstop for a rename
 * made without the `set-branch` signal (an agent running `git branch -m`, or a human in the
 * worktree). Called once per pass before the phase dispatch, so this pass's prompt render, PR
 * discovery, and teardown all read the branch that exists rather than the name minted at claim.
 *
 * A DETACHED head (mid-rebase, a `git checkout <sha>`) reads as "unknown" and changes nothing — the
 * recorded branch stays until the worktree is back on one. A PROTECTED branch is refused the same
 * way: a worktree sitting on the base ref is an accident, and tracking it would point PR discovery
 * and branch deletion at a shared branch.
 */
export async function syncRunBranch(deps: Deps, run: Run): Promise<Run> {
  if (!run.worktreePath) return run;
  const live = await deps.git.currentBranch(run.worktreePath).catch(() => null);
  if (!live || live === run.branch) return run;
  if ((await protectedBranches(deps)).has(live)) {
    deps.log("warn", `${run.ticketKey}: worktree is on protected branch "${live}" — keeping ${run.branch ?? "(none)"} as the run's branch`);
    return run;
  }
  return recordBranchChange(deps, run, live, "observed");
}

export interface SetBranchResult {
  ok: boolean;
  branch?: string;
  message?: string;
}

/**
 * The `set-branch` signal's engine effect: put this run's worktree on `to` and track it there.
 *
 * The front door for "this repo's branches must look like X" — the agent learns the real name
 * (a ticket key it just created, a convention it just read) mid-run and renames once, before it
 * pushes. Validated rather than trusted: a bad ref name, a name already taken, a detached head, a
 * protected branch, or a rename AFTER the PR is open are all refused with a message the agent can
 * act on. Idempotent when the worktree is already on `to`.
 */
export async function setRunBranch(deps: Deps, run: Run, to: string): Promise<SetBranchResult> {
  const bad = invalidBranchName(to);
  if (bad) return { ok: false, message: `"${to}" is not a valid branch name: ${bad}` };
  if (!run.worktreePath) return { ok: false, message: "this run has no worktree yet — retry once your step is running" };

  const live = await deps.git.currentBranch(run.worktreePath).catch(() => null);
  // Already there: record it (the branch may have been renamed by hand) and stop — an idempotent
  // replay must not trip the PR guard below.
  if (live === to) {
    if (run.branch === to) return { ok: true, branch: to, message: `already on ${to}` };
    recordBranchChange(deps, run, to, "signal");
    return { ok: true, branch: to, message: `tracking ${to}` };
  }
  if (!live) {
    return { ok: false, message: "the worktree's HEAD is detached — check out your branch (git switch -c <name>) before setting it" };
  }
  // Once a PR exists it is the run's identity, and its head is the branch that was PUSHED. Renaming
  // the local branch now would leave the PR on the old head with nothing tracking it.
  if (run.prNumber != null) {
    return {
      ok: false,
      message: `PR #${run.prNumber} is already open from "${live}" — renaming now would strand it. Rename BEFORE you push, or ask a human (see the ask-human command).`,
    };
  }
  if ((await protectedBranches(deps)).has(to)) {
    return { ok: false, message: `"${to}" is a protected branch (the base ref or the main checkout's branch) — pick a name for this work` };
  }
  if (await deps.git.branchExists(deps.config.repo.path, to)) {
    return { ok: false, message: `branch "${to}" already exists in this repo — pick a name that doesn't collide (another run may own it)` };
  }
  if (!(await deps.git.branchRename(run.worktreePath, to))) {
    return { ok: false, message: `git refused to rename "${live}" to "${to}" — run \`git branch -m ${to}\` in ${run.worktreePath} to see why` };
  }
  // Trust git's answer, not the return code: confirm the worktree really moved before recording it.
  const now = await deps.git.currentBranch(run.worktreePath).catch(() => null);
  if (now !== to) {
    return { ok: false, message: `the rename did not take — the worktree is on "${now ?? "(detached)"}"` };
  }
  recordBranchChange(deps, run, to, "signal");
  // A pushed old head is now orphaned: nothing else will notice it, and the run's own teardown only
  // reaps LOCAL branches. Tell the agent, which is the only party that can clean it up.
  const pushed = await deps.git.remoteBranchExists(run.worktreePath, live).catch(() => false);
  const note = pushed ? ` — note: "${live}" was already pushed; delete the stale remote branch (git push origin --delete ${live})` : "";
  return { ok: true, branch: to, message: `branch renamed ${live} -> ${to}${note}` };
}
