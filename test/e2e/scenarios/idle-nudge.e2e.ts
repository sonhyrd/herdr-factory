// The proactive idle nudge (issue #54). The commonest wedge in the factory is an agent that
// finishes its work — or drifts off — and never runs `step-done`: it sits at its prompt, perfectly
// alive, until the stall or budget window expires 45-60 minutes later and parks the run for a
// human who then types `resume` and watches it finish in three minutes. One message sent ~5
// minutes in heals the same wedge with nobody watching.
//
// Four properties, in one run, because they only mean anything together:
//   * an idle step agent is nudged within idle_nudge_seconds + one tick and COMPLETES — no park;
//   * a `working` pane is never nudged, however long its turn runs (injecting a foreign turn into
//     a live conversation interleaves two conversations, which is the bug the rule prevents);
//   * exactly ONE nudge per idle episode, however many ticks pass in it; and
//   * it costs no herdr call per tick beyond the memoized pane state — the whole point of riding
//     the ~5s agent-list memo instead of the resume path's `fresh: true` read.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const IDLE_NUDGE_SECONDS = 8;
// Long enough that the engine gets many ticks INSIDE one `working` turn — the pane state that
// must never be nudged, however long it runs.
const HANG_MS = (IDLE_NUDGE_SECONDS + 32) * 1000;

scenario(
  {
    name: "idle-nudge",
    // Discrete ticks: a per-tick call budget is only meaningful against a known number of passes
    // (the same reason perf-call-budgets drives its own), and the idle window is wall-clock either way.
    driver: "tick",
    timeoutMs: 300_000,
    briefs: { forgetful: "# Forgetful\n\nCommits the work and forgets to signal.\n" },
    config: (p) => ({
      // Generous watchdogs: this scenario must prove the nudge fires BEFORE any of them, so a park
      // here would be the failure, not the rescue.
      limits: { idle_nudge_seconds: IDLE_NUDGE_SECONDS, stall_seconds: 900, step_budget_seconds: 900, tick_interval_seconds: 3600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "nudging", source: "briefs", workspace_name: "n/{{work_id}}", steps: [{ type: "work", budget_seconds: 900 }, { type: "review" }] }],
    }),
    agent: {
      steps: {
        // Commits, then sits at its prompt reporting `idle` and never signals — the wedge itself.
        work: { signal: "none", status: "idle", workMs: 0 },
        // Holds `working` well past the idle window before going idle without signalling: the pane
        // state that must NEVER be nudged, followed by the one that must be.
        review: { commit: false, hangMs: HANG_MS },
      },
    },
  },
  async (w) => {
    const key = "forgetful";
    const nudges = (step?: string) =>
      w.db
        .events(key)
        .filter((e) => e.type === "idle_nudge")
        .filter((e) => step === undefined || JSON.parse(e.detail ?? "{}").step === step);

    // ── the wedge ─────────────────────────────────────────────────────────────────────────────
    const run = await w
      .waitFor(() => !!w.db.run(key)?.branch && /chore\(work\)/.test(w.git(["log", "--oneline", w.db.run(key)!.branch!])), {
        label: "the work agent commits its work",
        timeoutMs: 120_000,
      })
      .then(() => w.db.run(key)!);
    expect(w.db.step(run.id, "work")?.done, "…and then never signals").toBe(0);

    // Give the still-idle agent something to do when it is finally prompted. This is the whole
    // point: the nudge it is about to receive is the only thing that will ever reach it.
    w.setAgentScript({
      steps: { work: { signal: "step-done", commit: false, status: "idle" }, review: { commit: false, hangMs: HANG_MS } },
    });

    await w.waitForEvent(key, "idle_nudge", { label: `the idle work agent is nudged ~${IDLE_NUDGE_SECONDS}s in`, timeoutMs: 120_000 });
    expect(w.db.run(key)!.phase, "the nudge sits in FRONT of the watches — it never parks anything").not.toBe("attention");
    const sent = w.herdr
      .calls()
      .filter((c) => c.argv[0] === "agent" && c.argv[1] === "prompt")
      .filter((c) => c.argv.some((a) => /has been idle for ~/.test(a)));
    expect(sent.length, "one nudge submission, pointing the agent back at its own brief").toBe(1);
    expect(sent[0]!.argv.join("\n"), "…and at the step-done it forgot").toMatch(/prompt-work\.md[\s\S]*step-done/);
    expect(sent[0]!.argv.join("\n"), "…and at its TASKS.md checklist, if it wrote one (issue #106)").toContain("TASKS.md");

    // The nudged agent finishes the step it had already done the work for — no human, no park.
    await w.waitFor(() => w.db.step(run.id, "work")?.done === 1, { label: "the nudged agent signals step-done", timeoutMs: 120_000 });
    expect(nudges("work").length, "exactly one nudge per idle episode").toBe(1);

    // ── a working pane is never nudged ────────────────────────────────────────────────────────
    // The review agent holds `working` for longer than the whole idle window. Drive real ticks
    // through it and assert nothing was injected into its live turn.
    await w.waitFor(() => w.db.step(run.id, "review")?.pane_id != null, { label: "the review step is dispatched", timeoutMs: 120_000 });
    const reviewPane = w.db.step(run.id, "review")!.pane_id!;
    const reviewState = () => w.herdr.agents().find((a) => a.pane_id === reviewPane)?.agent_status;
    await w.waitFor(() => reviewState() === "working", { label: "the review agent starts its long turn", timeoutMs: 120_000 });

    const before = w.herdr.calls().length;
    const until = Date.now() + (IDLE_NUDGE_SECONDS + 6) * 1000; // strictly longer than the idle window
    let ticks = 0;
    while (Date.now() < until) {
      await w.tick();
      ticks++;
      expect(nudges("review").length, "a working pane is never nudged, however long its turn runs").toBe(0);
    }
    expect(reviewState(), "…and it really was mid-turn for that whole window").toBe("working");

    // ── the per-tick call budget ──────────────────────────────────────────────────────────────
    // Those ticks each evaluated the idle nudge for a running step. If the nudge had used the
    // resume path's `fresh: true` read it would have cost one `herdr agent list` per run per tick;
    // riding the memo, the whole tick still costs at most one.
    const listCalls = w.herdr
      .calls()
      .slice(before)
      .filter((c) => c.argv[0] === "agent" && c.argv[1] === "list").length;
    w.recordMetrics({ ticks, agentListCalls: listCalls });
    expect(listCalls, `${listCalls} \`agent list\` calls over ${ticks} ticks`).toBeLessThanOrEqual(ticks);

    // ── and the SECOND episode ────────────────────────────────────────────────────────────────
    // The review agent's hang ends without a signal, so it too goes idle — a fresh episode, and a
    // second nudge. Same rule, a different step: idle → nudge → working → idle is two nudges.
    w.setAgentScript({ steps: { review: { commit: false, signal: "step-done" } } });
    await w.waitFor(() => nudges("review").length === 1, { label: "the review agent goes idle and is nudged too", timeoutMs: 120_000 });
    await w.waitForEnd(key, "completed", { label: "the belt completes with no park at all", timeoutMs: 180_000 });
    expect(w.db.eventTypes(key), "no watchdog ever had to park this run").not.toContain("attention");
    expect(nudges().length, "one nudge per idle episode, two episodes").toBe(2);
  },
);
