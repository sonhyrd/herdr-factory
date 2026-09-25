// The factory's own `.memory/` never dirties a run's tree, in a repo that never heard of it (issue
// #110). Every other scenario's target repo commits `.gitignore` with `.memory/`, which hides the
// case: a repo (or an old branch, or an `hf-review` checkout of an old PR) whose `.gitignore`
// predates the dir shows `?? .memory/` in `git status --porcelain`, and the tree guard parks every
// read-only gate `dirty_tree` on the factory's own files.
//
// The engine now appends `.memory/` to the checkout's `info/exclude` on every worktree create and
// reopen. Proven here against real git and real herdr worktrees:
//
//   1. two runs, each materializing its work doc into `.memory/herdr-factory/`, advance into the
//      read-only `review` gate and complete — no `dirty_tree` park, no refused step-done;
//   2. linked worktrees share the main checkout's `info/exclude`, and two worktree creates leave
//      exactly ONE `.memory/` line there — and the tenant's committed `.gitignore` is untouched.
import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { expectNoEvent, expectStepDone, scenario } from "../harness/index.ts";

const NO_MEMORY_IGNORE = "# this repo's .gitignore predates the factory\nnode_modules/\n";

scenario(
  {
    name: "memory-exclude",
    timeoutMs: 300_000,
    repoFiles: { ".gitignore": NO_MEMORY_IGNORE },
    briefs: {
      "first-run": "# First run\n\nAny change, then a read-only review.\n",
      "second-run": "# Second run\n\nA second worktree of the same checkout.\n",
    },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "gated", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }, { type: "review" }] }],
    }),
    agent: { steps: { review: { commit: false } } },
  },
  async (w) => {
    const keys = ["first-run", "second-run"];
    expect(w.git(["show", "HEAD:.gitignore"])).not.toContain(".memory");

    // ── 1. both runs pass the read-only gate with their .memory/ in the worktree ──────────────
    for (const key of keys) {
      await w.waitForEnd(key, "completed", { label: `${key} advances through the read-only gate`, timeoutMs: 180_000 });
      expectStepDone(w, key, ["work", "review"]);
      expectNoEvent(w, key, "attention");
      expectNoEvent(w, key, "step_done_refused");
      expect(w.db.run(key)!.attention_reason ?? null, `${key} never parked`).toBeNull();
    }

    // ── 2. one shared exclude, one line, tenant .gitignore untouched ─────────────────────────
    const exclude = w.git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    const lines = readFileSync(exclude, "utf8").split("\n");
    expect(lines.filter((l) => l === ".memory/"), "two worktree creates leave exactly one .memory/ line").toHaveLength(1);
    expect(w.git(["show", "HEAD:.gitignore"]), "the tenant's .gitignore is never edited").toBe(NO_MEMORY_IGNORE.trim());
    expect(w.git(["status", "--porcelain", "--", ".gitignore"]), "…nor left modified in the main checkout").toBe("");
  },
);
