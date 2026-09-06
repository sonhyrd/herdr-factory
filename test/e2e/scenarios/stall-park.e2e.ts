// The other stuck-agent shape: an agent that is nominally alive but has stopped making progress.
// The commit-HEAD heartbeat is the only thing that can tell the difference between "thinking" and
// "wedged", and it applies to the steps that commit. When both its window and the budget have
// expired the engine reports the STALL, because it names the more specific failure.
import { expect } from "vitest";
import { expectParked, scenario } from "../harness/index.ts";

scenario(
  {
    name: "stall-park",
    briefs: { "no-commits": "# No commits\n\nAn agent that never touches the tree.\n" },
    config: (p) => ({
      limits: { stall_seconds: 5, step_budget_seconds: 600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "stalling", source: "briefs", workspace_name: "s/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { steps: { work: { commit: false, signal: "none" } } },
  },
  async (w) => {
    const key = "no-commits";

    await w.waitFor(() => w.db.run(key)?.phase === "attention", { label: "the heartbeat parks the stalled step", timeoutMs: 90_000 });
    expectParked(w, key, "step_stalled");

    const run = w.db.run(key)!;
    expect(w.git(["log", "--oneline", run.branch!]), "nothing was committed — that is the point").not.toMatch(/chore\(work\)/);
    await w.waitForPaneReport(key); // the operator is told what stalled

    // Let the work agent finish the turn the PARK's own pane report just handed it. `resume`
    // deliberately does not interrupt a `working` pane, so a resume fired microseconds after that
    // report flips the phase and nudges nobody (`resumed {nudged:false}`) — and the step's clock,
    // re-based by the resume, simply expires again. An operator arriving minutes later never sees it.
    const workPane = w.db.step(run.id, "work")!.pane_id!;
    await w.waitFor(() => w.herdr.agents().find((a) => a.pane_id === workPane)?.agent_status !== "working", {
      label: "the work agent finishes its turn before the operator resumes",
    });

    // Resuming re-bases the heartbeat clock, so an agent that starts committing again recovers.
    w.setAgentScript({ steps: { work: { commit: true, signal: "step-done" } } });
    await w.resumeUntilNudged(key);
    await w.waitForEnd(key, "completed", { label: "the resumed step commits and finishes", timeoutMs: 120_000 });
    expect(w.db.eventTypes(key)).toContain("resumed");
  },
);
