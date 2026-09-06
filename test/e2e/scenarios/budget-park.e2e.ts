// The commonest park in the wild: an agent that finished (or drifted off) without ever running
// step-done. The budget watchdog has to notice, park the run where a human will see it, and then
// `resume` has to actually heal it — which means re-prompting the step's own idle agent, not just
// flipping the phase (un-parking alone would leave the same idle agent to burn a fresh budget and
// re-park, making resume a dead end for exactly the case it exists for).
import { expect } from "vitest";
import { expectParked, expectTimeline, scenario } from "../harness/index.ts";

scenario(
  {
    name: "budget-park",
    briefs: { "silent-agent": "# Silent agent\n\nDoes the work, never signals.\n" },
    config: (p) => ({
      // Generous stall window: this scenario is about the budget guard specifically (the two are
      // ordered stall-first when both windows have expired).
      limits: { stall_seconds: 600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      // The budget goes on the STEP: `limits.step_budget_seconds` is only the fallback for a
      // primitive that declares no default of its own, and `work` declares 5400s.
      belt: [{ name: "quiet", source: "briefs", workspace_name: "q/{{work_id}}", steps: [{ type: "work", budget_seconds: 5 }, { type: "review" }] }],
    }),
    // Commits (so the heartbeat is satisfied) and then goes idle without signalling.
    agent: { steps: { work: { signal: "none" }, review: { commit: false } } },
  },
  async (w) => {
    const key = "silent-agent";

    await w.waitFor(() => w.db.run(key)?.phase === "attention", { label: "the budget watchdog parks the run", timeoutMs: 90_000 });
    expectParked(w, key, "step_budget");

    // A park is a workflow, not a dead end — it has to reach a human three ways.
    const report = await w.waitForPaneReport(key, /budget|resume/i); // submitted just after the phase flips
    expect(report, "with a ready-made resume command").toContain(`resume ${key}`);
    expect(w.herdr.notifications().length, "a desktop notification fired").toBeGreaterThan(0);
    const flagged = w.herdr.paneMetadata().filter((m) => m.argv.join(" ").includes("hf_state=attention"));
    expect(flagged.length, "the pane is flagged ⚠ ATTENTION").toBeGreaterThan(0);

    // The work is not lost: its commits are on the branch, and the step never reported done.
    const run = w.db.run(key)!;
    expect(w.db.step(run.id, "work")?.done).toBe(0);
    expect(w.git(["log", "--oneline", run.branch!])).toMatch(/chore\(work\)/);

    // ── resume ────────────────────────────────────────────────────────────────────────────────
    // The agent that stalled is still sitting there idle. Give it something to do this time.
    // Let the work agent finish the turn the PARK's own pane report just handed it. `resume`
    // deliberately does not interrupt a `working` pane, so a resume fired microseconds after that
    // report flips the phase and nudges nobody (`resumed {nudged:false}`) — and the step's clock,
    // re-based by the resume, simply expires again. An operator arriving minutes later never sees it.
    const workPane = w.db.step(run.id, "work")!.pane_id!;
    await w.waitFor(() => w.herdr.agents().find((a) => a.pane_id === workPane)?.agent_status !== "working", {
      label: "the work agent finishes its turn before the operator resumes",
    });
    w.setAgentScript({ steps: { work: { signal: "step-done" }, review: { commit: false } } });
    // Even then the first resume can read the pane as `working` (the engine's agent list is ~5s
    // memoized), and a resume that nudges nobody lets this step's 5s budget expire again — so
    // resume the way an operator would, until one lands.
    await w.resumeUntilNudged(key);

    await w.waitForEnd(key, "completed", { label: "the resumed step finishes and the belt completes", timeoutMs: 120_000 });
    expectTimeline(w, key, ["claimed", "step_spawned", "attention", "resumed", "step_done", "step_spawned", "step_done", "torn_down"]);
    // `resume` clears the human-readable reason; `attention_reason_code` deliberately KEEPS the last
    // park's code (it is the rescue-routing key, read only while a run is parked).
    expect(w.db.run(key)!.attention_reason, "the park's reason is cleared on resume").toBeNull();
    expect(w.db.run(key)!.phase).toBe("done");
  },
);
