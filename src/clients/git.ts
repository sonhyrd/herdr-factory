import { run } from "./exec.ts";

/** Git operations herdr-factory performs directly (outside herdr's model). */
export class GitClient {
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

  /** Current HEAD commit of a worktree, or null if git can't resolve it. Used as the
   *  worker's progress heartbeat — a moving HEAD means real work happened. */
  async headSha(repoCwd: string): Promise<string | null> {
    const r = await run("git", ["-C", repoCwd, "rev-parse", "HEAD"], { allowFail: true });
    const sha = r.stdout.trim();
    return r.code === 0 && sha ? sha : null;
  }
}

/** owner/name from a git origin URL (ssh or https), or null. */
export function parseGhRepo(originUrl: string): string | null {
  const m = originUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : null;
}
