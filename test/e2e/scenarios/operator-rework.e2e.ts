// The operator's own backward edge. A `bounce` belongs to an AGENT — it is stamped with the issuing
// step and pass, and constrained to the targets that step declares. A person watching a run go wrong
// had none of that: the only lever was to type into the step's herdr pane, which a layout belt keeps
// alive for the next pass, so the agent works outside the belt's knowledge and whatever it leaves
// behind is invisible to the run (issue #66 — see `dirty-tree-guard` for the other half).
//
// This proves the front door, end to end and through the real CLI: while the EVIDENCE step is the
// live one, `herdr-factory rework <KEY> work --note "…"` stops it, opens work's next pass with the
// note at the top of the re-rendered prompt, and records a `rework` event the operator can find with
// `timeline`. Then the belt runs forward again on its own, which is the part a unit test cannot show:
// the rework is a rewind, not an abort.
import { existsSync, readFileSync } from "node:fs";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

/** A file in the run's worktree, or "" — the memory dir is written by the engine and the agent, so
 *  every read here is a poll's worth of "not yet" away from existing. */
const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Every step gets a layout pane. `evidence` materialises ONLY when its step ref names a tab+pane,
 *  and a belt that mixes layout panes with dedicated-pane steps silently loses its layout — see
 *  test/e2e/README.md. */
const LAYOUT = {
  id: "reworkable",
  tabs: ["work", "evidence", "review"].map((title) => ({ title, panes: [{ title: "agent", agent: "claude" }] })),
};

const NOTE = "the toast still clips at 320px";

scenario(
  {
    name: "operator-rework",
    timeoutMs: 300_000,
    briefs: { "not-what-i-asked": "# Not what I asked for\n\n## Acceptance criteria\n- the toast fits a narrow viewport\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [LAYOUT],
      belt: [
        {
          name: "reworking",
          source: "briefs",
          workspace_name: "r/{{work_id}}",
          default_layout: "reworkable",
          steps: [
            { type: "work", tab: "work", pane: "agent" },
            { type: "evidence", tab: "evidence", pane: "agent" },
            { type: "review", tab: "review", pane: "agent" },
          ],
        },
      ],
    }),
    // Evidence's FIRST pass never signals, so it stays the active step while the operator types the
    // rework — the 12:22 moment of the incident. It goes idle first (the hang is short) so that the
    // forward pass can re-prompt the same pane once work has re-run. Pass 2 finishes normally.
    agent: {
      steps: { evidence: { commit: false }, review: { commit: false } },
      passes: { "evidence:1": { commit: false, hangMs: 5000 } },
    },
  },
  async (w) => {
    const key = "not-what-i-asked";
    const run = () => w.db.run(key)!;

    await w.waitFor(() => run()?.step === "evidence" && w.db.step(run().id, "evidence")?.dispatched_at != null, {
      label: "the evidence step is live (the operator is watching it run)",
      timeoutMs: 120_000,
    });
    const id = run().id;
    expect(w.db.step(id, "work")!.pass, "work ran once").toBe(1);

    // ── the operator types it, through the real CLI ───────────────────────────────────────────
    const out = w.factory.cli(["rework", key, "work", "--note", NOTE]);
    expect(out.code, `rework should succeed (stderr: ${out.stderr.trim()})`).toBe(0);
    expect(out.stdout).toContain("reworked to work");

    // The live step stopped and work re-opened on a fresh pass.
    expect(run().step, "the run is back on work").toBe("work");
    expect(run().phase).toBe("running");
    expect(w.db.step(id, "work")!.pass, "work re-entered on its next pass").toBe(2);
    expect(w.db.step(id, "evidence")!.done, "the stopped step is not done").toBe(0);

    // The timeline carries it, with who did it and where it went — and `timeline <KEY>` shows it,
    // which is what the issue's "Done when" names.
    const ev = w.db.event(key, "rework")!;
    expect(ev, "a rework event is recorded").toBeTruthy();
    expect(ev.data.by, "the event names the operator").toBe("operator");
    expect(ev.data.fromStep).toBe("evidence");
    expect(ev.data.toStep).toBe("work");
    expect(ev.data.pass).toBe(2);
    expect(w.factory.cli(["timeline", key]).stdout, "`timeline` prints it").toMatch(/rework/);

    // The note reaches the agent where a bounce's findings do: the feedback file, surfaced by the
    // rework banner at the very top of the re-rendered prompt.
    await w.waitFor(() => w.renderedPrompt("work", 2) !== null, { label: "the work agent is re-prompted on pass 2" });
    const prompt = w.renderedPrompt("work", 2)!;
    expect(prompt, "the rework banner leads the prompt").toContain("Rework requested — READ THIS FIRST");
    expect(prompt, "and the step-done command carries the new pass stamp").toContain("--pass 2");
    const feedback = `${run().worktree_path}/.memory/herdr-factory/feedback-work.md`;
    expect(read(feedback), "the operator's note is in the feedback file").toContain(NOTE);
    expect(read(feedback), "which says a person sent it back").toContain("operator");

    // Every handoff names the commit it covers (issue #66's third "Done when"). The requirement is
    // on the PROMPT — the harness's scripted agent is not the shipped one, and teaching it to read
    // HEAD costs a subprocess per turn that `fast-signal` cannot afford (see agent.cjs).
    expect(prompt, "the finish protocol asks for the sha the handoff covers").toContain("sha: <commit>");
    expect(prompt).toContain("git rev-parse HEAD");

    // A rewind, not an abort: the belt runs forward from work again and finishes.
    await w.waitForEnd(key, "completed", { label: "the reworked run runs forward and completes", timeoutMs: 180_000 });
    expect(w.db.step(id, "evidence")!.pass, "evidence re-ran on its own next pass").toBe(2);
  },
);
