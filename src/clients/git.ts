import { run } from "./exec.ts";

/** A fetch talks to the network, so it gets a tighter budget than the default exec timeout — a slow
 *  remote must delay one claim, never the tick. */
const FETCH_TIMEOUT_MS = 30_000;

/** Git operations herdr-factory performs directly (outside herdr's model). */
export class GitClient {
  /** Refresh one remote branch's tracking ref, so a worktree cut from `<remote>/<branch>` starts at
   *  the remote's tip rather than at whatever the checkout happened to have when it was cloned.
   *  Never prompts (`GIT_TERMINAL_PROMPT=0`: a credential prompt would hang the subprocess until its
   *  timeout), never throws — a timed-out fetch is just a failed one, which the caller degrades on. */
  async fetchRef(repoCwd: string, remote: string, branch: string): Promise<boolean> {
    try {
      const r = await run("git", ["-C", repoCwd, "fetch", "--no-tags", "--quiet", remote, branch], {
        allowFail: true,
        timeoutMs: FETCH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /** How long ago `ref`'s tip commit was made ("4 days ago"), or null when git can't resolve it —
   *  the human-readable age a failed fetch reports so a stale base is visible in the log. */
  async refAge(repoCwd: string, ref: string): Promise<string | null> {
    const r = await run("git", ["-C", repoCwd, "log", "-1", "--format=%cr", ref], { allowFail: true });
    const age = r.stdout.trim();
    return r.code === 0 && age ? age : null;
  }

  async branchExists(repoCwd: string, branch: string): Promise<boolean> {
    const r = await run("git", ["-C", repoCwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      allowFail: true,
    });
    return r.code === 0;
  }

  /** Delete a local branch, returning whether it's gone afterward. Robust to the abandoned-run leak:
   *  `git branch -D` REFUSES to delete a branch that's still checked out in a worktree, and a partial
   *  teardown (an abandoned run whose agent kept the worktree dir busy, so herdr's remove + our
   *  rmrf/prune didn't fully clear it) leaves exactly that. On the first `-D` failing silently
   *  (allowFail), force-remove the worktree(s) still on the branch — `worktree remove --force` clears
   *  the dir + registration even when busy/dirty — prune, and retry, so the branch never silently leaks. */
  async branchDelete(repoCwd: string, branch: string): Promise<boolean> {
    await run("git", ["-C", repoCwd, "branch", "-D", branch], { allowFail: true });
    if (!(await this.branchExists(repoCwd, branch))) return true; // deleted, or never existed
    for (const path of await this.worktreesOnBranch(repoCwd, branch)) {
      await run("git", ["-C", repoCwd, "worktree", "remove", "--force", path], { allowFail: true });
    }
    await run("git", ["-C", repoCwd, "worktree", "prune"], { allowFail: true });
    await run("git", ["-C", repoCwd, "branch", "-D", branch], { allowFail: true });
    return !(await this.branchExists(repoCwd, branch));
  }

  /** Worktree paths currently checking out `branch` (parsed from `worktree list --porcelain`). */
  private async worktreesOnBranch(repoCwd: string, branch: string): Promise<string[]> {
    const r = await run("git", ["-C", repoCwd, "worktree", "list", "--porcelain"], { allowFail: true });
    if (r.code !== 0) return [];
    const out: string[] = [];
    let path: string | null = null;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9).trim();
      else if (line.startsWith("branch ") && path && line.slice(7).trim() === `refs/heads/${branch}`) out.push(path);
    }
    return out;
  }

  async worktreePrune(repoCwd: string): Promise<void> {
    await run("git", ["-C", repoCwd, "worktree", "prune"], { allowFail: true });
  }

  async originUrl(repoCwd: string): Promise<string> {
    const r = await run("git", ["-C", repoCwd, "remote", "get-url", "origin"], { allowFail: true });
    return r.stdout.trim();
  }

  /** The branch a checkout currently has checked out, or null when HEAD is DETACHED (rev-parse
   *  prints the literal "HEAD" then) or git can't resolve it. This is how a run's branch is
   *  TRACKED rather than fixed: the name is the factory's only at claim time, and an agent may
   *  rename it to the repo's own convention mid-run (see core/run-branch.ts). */
  async currentBranch(repoCwd: string): Promise<string | null> {
    const r = await run("git", ["-C", repoCwd, "rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
    const name = r.stdout.trim();
    return r.code === 0 && name && name !== "HEAD" ? name : null;
  }

  /** Does a remote-tracking ref for `branch` exist in this checkout (i.e. was it ever pushed with
   *  `-u`/fetched)? Local-only — no network. Used to warn that a rename leaves a stale remote head. */
  async remoteBranchExists(repoCwd: string, branch: string): Promise<boolean> {
    const r = await run("git", ["-C", repoCwd, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
      allowFail: true,
    });
    return r.code === 0;
  }

  /** Rename the checkout's CURRENT branch to `to` (`git branch -m`). Returns whether git accepted it. */
  async branchRename(repoCwd: string, to: string): Promise<boolean> {
    const r = await run("git", ["-C", repoCwd, "branch", "-m", to], { allowFail: true });
    return r.code === 0;
  }

  /** The worktree's uncommitted work as a diff stat, or null when the tree is CLEAN. The porcelain
   *  listing is appended because untracked files never appear in a diff — and an untracked file the
   *  agent forgot to `git add` is exactly the change a later step would film or review blind. */
  async dirtyStat(repoCwd: string): Promise<string | null> {
    const st = await run("git", ["-C", repoCwd, "status", "--porcelain"], { allowFail: true });
    if (st.code !== 0 || !st.stdout.trim()) return null;
    const diff = await run("git", ["-C", repoCwd, "diff", "--stat", "HEAD"], { allowFail: true });
    return [diff.stdout.trim(), st.stdout.trim()].filter(Boolean).join("\n");
  }

  /** Current HEAD commit of a worktree, or null if git can't resolve it. Used as the
   *  worker's progress heartbeat — a moving HEAD means real work happened. */
  async headSha(repoCwd: string): Promise<string | null> {
    const r = await run("git", ["-C", repoCwd, "rev-parse", "HEAD"], { allowFail: true });
    const sha = r.stdout.trim();
    return r.code === 0 && sha ? sha : null;
  }

  /** Paths that differ between two commits, or null when git can't diff them (a commit it doesn't
   *  have). The PR watch classifies a pushed fix by these (core/evidence-head.ts). */
  async changedFiles(repoCwd: string, from: string, to: string): Promise<string[] | null> {
    const r = await run("git", ["-C", repoCwd, "diff", "--name-only", from, to], { allowFail: true });
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : null;
  }

  /** Whether `ancestor` is an ancestor of `head` (or the same commit). `true` / `false` when both
   *  resolve; `null` when git cannot tell (a missing object — exit 128, not the "not an ancestor"
   *  exit 1). The PR watch uses this for a review whose head the PR has moved past. */
  async isAncestor(repoCwd: string, ancestor: string, head: string): Promise<boolean | null> {
    const r = await run("git", ["-C", repoCwd, "merge-base", "--is-ancestor", ancestor, head], { allowFail: true });
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    return null;
  }
}

/** owner/name from a git origin URL (ssh or https), or null. */
export function parseGhRepo(originUrl: string): string | null {
  const m = originUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : null;
}
