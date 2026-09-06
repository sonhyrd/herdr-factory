// A PR closed without merging is a human decision the factory must not paper over: the run parks for
// attention (it is not a watchdog park — no agent misbehaved, so nothing auto-rescues it) and keeps
// its worktree so the work is still there to salvage.
import { expect } from "vitest";
import { expectParked, scenario } from "../harness/index.ts";

scenario(
  {
    name: "pr-closed-park",
    timeoutMs: 240_000,
    briefs: { "rejected-work": "# Rejected work\n\nThe reviewer will close this.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "shipping", source: "briefs", workspace_name: "w/{{work_id}}", steps: [{ type: "work" }, { type: "pr" }] }],
    }),
  },
  async (w) => {
    const key = "rejected-work";

    await w.waitForPhase(key, "reviewing", { label: "the PR is opened and the watch takes over", timeoutMs: 150_000 });
    const run = w.db.run(key)!;

    w.gh.close(run.pr_number!);
    await w.waitFor(() => w.db.run(key)?.phase === "attention", { label: "closing the PR parks the run", timeoutMs: 120_000 });
    expectParked(w, key, "pr_closed");

    // Not a watchdog park: there is nothing for a step-done to rescue, so it waits for a person.
    await w.waitForPaneReport(key, /clos/i);
    expect(w.db.run(key)!.ended_at, "the run is parked, not ended").toBeNull();
    expect(w.git(["worktree", "list"]), "and its worktree is kept for salvage").toContain(run.branch!);
  },
);
