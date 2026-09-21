// A belt must verify a tree ONCE. Before gate receipts, each step could only discover what an
// earlier step had checked by checking it again: on the run this came from, the full spec suite ran
// six times, the unit suite six times and the scoped type-check four times, all against one
// unchanged commit — the review step alone re-ran 6.2 minutes of the work step's gates.
//
// This pins the contract end to end, through the real CLI, the real prompts and the real DB:
//
//   * the `work` prompt's rendered @@GATE_CMD@@ runs the command and leaves a receipt pinned to the
//     commit it ran at, and the wrapper is TRANSPARENT (a failing gate still exits non-zero);
//   * re-running a gate at the same commit REPLACES its receipt — the row count is the count of
//     distinct (gate, SHA) pairs the run actually verified, which is "once per gate per SHA";
//   * the `review` prompt's @@GATE_RECEIPTS_CMD@@ reads them, marked CURRENT against this HEAD;
//   * every `step-done` exports the pass's wall / shell / model split onto the timeline.
import { expect } from "vitest";
import { expectStepDone, scenario } from "../harness/index.ts";

scenario(
  {
    name: "gate-receipts",
    briefs: { "gated-work": "# Gated work\n\nThe work step verifies; the review step reads the receipts.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "gated", source: "briefs", workspace_name: "gr/{{work_id}}", steps: [{ type: "work" }, { type: "review" }] }],
    }),
    agent: {
      steps: {
        // Two gates, and `test` run TWICE at the same commit — the duplicate must collapse into one
        // receipt rather than leave the run looking like it verified three things.
        work: { gates: [["test", "true"], ["typecheck", "true"], ["test", "true"]] },
        // The reader re-runs nothing: it lists the receipts and passes the work forward.
        review: { commit: false, readGates: true },
      },
    },
  },
  async (w) => {
    const key = "gated-work";

    await w.waitForEnd(key, "completed", { label: "the belt completes", timeoutMs: 120_000 });
    expectStepDone(w, key, ["work", "review"]);
    const run = w.db.run(key)!;

    // ── once per gate per SHA ────────────────────────────────────────────────────────────────
    const receipts = w.db.all<{ gate: string; head: string; exit_code: number; step: string; pass: number; command: string }>(
      "SELECT * FROM gate_receipts WHERE run_id = ? ORDER BY gate",
      run.id,
    );
    expect(receipts.map((r) => r.gate), "two gates, three runs, two receipts — the duplicate replaced its own").toEqual(["test", "typecheck"]);
    expect(new Set(receipts.map((r) => r.head)).size, "both were taken at the same commit").toBe(1);
    for (const r of receipts) {
      expect(r.exit_code, `${r.gate} passed`).toBe(0);
      expect(r.step, `${r.gate} is attributed to the step that paid for it`).toBe("work");
      expect(r.pass).toBe(1);
      expect(r.head, "the receipt names the commit it covers").toMatch(/^[0-9a-f]{40}$/);
    }

    // The receipt's own event trail records all three runs (a fact happening twice is not a fact
    // being stored twice) — this is what tells an operator a gate was paid for more than once.
    expect(w.db.eventTypes(key).filter((t) => t === "gate_recorded"), "every gate run is on the timeline").toHaveLength(3);

    // ── the reader trusted them instead of re-running ────────────────────────────────────────
    const log = w.agentLog();
    expect(log, "the review step read the receipts").toMatch(/herdr-factory\s+--repo\s+\S+\s+gates\s+gated-work/);
    expect(log, "and the receipts it read were CURRENT for this HEAD").toContain("CURRENT");
    expect(
      receipts.every((r) => r.step === "work"),
      "no receipt is attributed to review — it re-ran nothing",
    ).toBe(true);

    // ── the timing export ────────────────────────────────────────────────────────────────────
    const timing = w.db.event(key, "step_timing", "first")!;
    expect(timing, "step-done exported a timing split").toBeTruthy();
    expect(timing.data.step).toBe("work");
    expect(timing.data.gates, "the work pass's gate count").toBe(2);
    expect(Number(timing.data.wallMs)).toBeGreaterThanOrEqual(Number(timing.data.shellMs));
    expect(Number(timing.data.modelMs)).toBe(Number(timing.data.wallMs) - Number(timing.data.shellMs));

    // ── step-done says where the run landed ──────────────────────────────────────────────────
    // The agent's only window onto its own signal; a silent exit 0 is what had steps polling
    // `status` and sleeping to find out whether the belt had moved. BOTH documented answers count:
    // the signal advances the belt inline, or the run lock was held by the tick that was already
    // advancing it and the agent is told the next pass will. Asserting only the first makes this
    // scenario fail on lock timing rather than on the contract it is here to pin.
    expect(log, "the work step was told what its signal did").toMatch(
      /advanced work → review|work recorded done — the dispatcher advances the belt on its next pass/,
    );
  },
);
