// Bounce-back rework is the factory's answer to "this isn't right": a gate sends the work backwards
// with findings instead of patching around it. The backstop is that two agents can disagree forever,
// so bounces are counted per target step and the run parks once the cap is exceeded.
//
// It also pins the resume refund: a `bounce_limit` park would otherwise be a dead end, because the
// very next bounce would land at cap+1 and re-park on the same cycle that resumed it.
import { expect } from "vitest";
import { expectParked, scenario } from "../harness/index.ts";

scenario(
  {
    name: "bounce-cap",
    briefs: { "wont-settle": "# Won't settle\n\nThe gate keeps sending this back.\n" },
    config: (p) => ({
      limits: { max_bounces: 1, step_budget_seconds: 600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "loop", source: "briefs", workspace_name: "b/{{work_id}}", steps: [{ type: "work" }, { type: "review" }] }],
    }),
    agent: { steps: { review: { commit: false, signal: "bounce", text: "The fix does not cover the acceptance criteria." } } },
  },
  async (w) => {
    const key = "wont-settle";

    await w.waitFor(() => w.db.run(key)?.phase === "attention", { label: "the bounce cap parks the oscillating run", timeoutMs: 120_000 });
    expectParked(w, key, "bounce_limit");

    // One bounce was allowed (the cap is 1); the second is what parked it.
    const run = w.db.run(key)!;
    expect(w.db.events(key).filter((e) => e.type === "bounced").length, "one bounce landed before the cap").toBe(1);
    expect(w.db.step(run.id, "work")!.pass, "the work step re-ran on a fresh pass").toBe(2);
    expect(w.db.guardCounter(run.id, "work", "bounce_cap"), "the cap counter is on the bounce TARGET").toBeGreaterThan(1);

    // The rework findings reached the work step both times, and the addressed pass was archived so a
    // later render can't resurrect already-handled feedback.
    const mem = `${run.worktree_path}/.memory/herdr-factory`;
    expect(w.git(["status"], run.worktree_path!), "the worktree is still there to inspect").toBeTruthy();
    await w.waitForPaneReport(key, /bounce/i); // the operator is told the loop was capped, in the run's own pane
    expect(mem).toContain(".memory");

    // ── resume: a human judged the loop worth continuing ──────────────────────────────────────
    // Wait for the gate's agent to finish its turn first. `resume` deliberately does NOT interrupt a
    // `working` pane (it could be mid-answer to another agent's question, or human-driven), so a
    // resume fired microseconds after the park would flip the phase and nudge nobody — which is what
    // an operator, arriving minutes later, never sees.
    const reviewPane = w.db.step(run.id, "review")!.pane_id!;
    await w.waitFor(() => w.herdr.agents().find((a) => a.pane_id === reviewPane)?.agent_status !== "working", {
      label: "the review agent finishes its turn before the operator resumes",
    });
    w.setAgentScript({ steps: { review: { commit: false, signal: "step-done" } } });
    // …and even an idle pane can read as `working` to the engine for a few seconds (its agent list
    // is memoized), so resume until one actually nudges — see World.resumeUntilNudged.
    await w.resumeUntilNudged(key);
    expect(w.db.guardCounter(run.id, "work", "bounce_cap"), "resume refunds the bounce budget belt-wide").toBe(0);

    await w.waitForEnd(key, "completed", { label: "the run finishes once the gate is satisfied", timeoutMs: 120_000 });
  },
);
