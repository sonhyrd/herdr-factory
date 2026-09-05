// The repo's branch convention wins over the factory's claim-time name.
//
// The factory can only name a branch from what the work source knows at claim time. Plenty of repos
// (and their CI) require a name it cannot know then — most often "every branch carries a ticket
// key". So the run's identity is its WORKTREE, and the branch is tracked: the work agent renames it
// with the `set-branch` command its prompt renders, and everything downstream — the pr step's push,
// PR discovery, the merge watch, teardown's branch cleanup — follows the new name.
//
// This scenario is the end-to-end proof of that, with nothing mocked below the factory.
import { expect } from "vitest";
import { expectStepDone, scenario } from "../harness/index.ts";

const RENAMED = "fix/RWR-18500-add-hello";

scenario(
  {
    name: "branch-rename",
    briefs: {
      "add-hello": [
        "---",
        "title: Add a hello file",
        "type: task",
        "---",
        "# Add a hello file",
        "",
        "## Acceptance criteria",
        "- `work/hello.txt` exists",
        "",
      ].join("\n"),
    },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "briefs-to-prs",
          source: "briefs",
          workspace_name: "{{semantic_work_prefix}}/{{work_id}}-{{work_full_slug}}",
          steps: [{ type: "work" }, { type: "pr" }],
        },
      ],
    }),
    // The work agent commits, then renames onto the repo's convention BEFORE anything is pushed —
    // which is exactly what the shipped work prompt tells a real agent to do.
    agent: {
      default: { signal: "step-done" },
      steps: { work: { setBranch: RENAMED } },
    },
  },
  async (w) => {
    const key = "add-hello";

    await w.waitFor(() => w.db.run(key) !== undefined, { label: "the brief is claimed" });
    const claimed = w.db.run(key)!;
    const worktreeName = claimed.worktree_name!;
    expect(worktreeName, "worktree named from workspace_name").toMatch(/^chore\/add-hello-add-a-hello-file-[a-z0-9]+$/);
    expect(claimed.branch, "the branch starts on the worktree's name").toBe(worktreeName);

    // ── the rename lands, and only the BRANCH moves ───────────────────────────────────────────
    await w.waitFor(() => w.db.run(key)?.branch === RENAMED, { label: "the work agent renames the branch", timeoutMs: 120_000 });
    expect(w.db.run(key)!.worktree_name, "identity is the worktree, and it does not move").toBe(worktreeName);
    const changed = w.db.event(key, "branch_changed");
    expect(changed?.data, "the rename is on the timeline, attributed to the signal").toMatchObject({
      from: worktreeName,
      to: RENAMED,
      via: "signal",
    });
    expect(w.branchExists(RENAMED), "git really carries the renamed branch").toBe(true);
    expect(w.branchExists(worktreeName), "and the claim-time name is gone (a rename, not a second branch)").toBe(false);

    // ── the pr step pushes and opens the PR under the NEW name; the engine finds it ────────────
    await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: "the pr step opens a PR", timeoutMs: 120_000 });
    const prNumber = w.db.run(key)!.pr_number!;
    expect(w.gh.pr(prNumber)?.headRefName, "the PR is on the RENAMED branch").toBe(RENAMED);
    expect(w.git(["ls-remote", "origin", RENAMED]), "the renamed branch is pushed").not.toBe("");
    expect(w.git(["log", "--oneline", RENAMED]), "the work commits rode the rename").toMatch(/chore\(work\)/);

    await w.waitForPhase(key, "reviewing", { label: "run enters the PR watch" });
    expectStepDone(w, key, ["work"]);

    // ── merge → teardown reaps BOTH names ─────────────────────────────────────────────────────
    w.gh.merge(prNumber);
    await w.waitForEnd(key, "merged", { label: "merge is detected and the run tears down", timeoutMs: 120_000 });
    expect(w.branchExists(RENAMED), `local branch ${RENAMED} deleted`).toBe(false);
    expect(w.branchExists(worktreeName), `no branch is left under the claim-time name ${worktreeName} either`).toBe(false);
    expect(w.git(["worktree", "list"]), "worktree deregistered").not.toContain(worktreeName);
  },
);
