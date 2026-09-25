// A step that opts into `requires_changes` cannot finish until the branch touches a required path
// (issue #125). The incident: ship belts told the work step, in a prompt line, to add an e2e
// scenario; it kept finishing without one, and the whole e2e step ran only to bounce it back. The
// cheap place to catch that is the work step's own `step-done`.
//
// Against real git, a real worktree and the real CLI:
//   1. the work agent commits, but nothing under the required path — its step-done exits 1 naming
//      the glob, a `step_done_refused` event is recorded, and the next step is never started;
//   2. the (idle-nudged) agent adds a scenario and commits it — the same step-done is accepted and
//      only THEN does the belt move on.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const GLOB = "test/e2e/scenarios/**";
const ADD_SCENARIO = [
  "mkdir -p test/e2e/scenarios && printf 'scenario\\n' > test/e2e/scenarios/proof.e2e.ts && git add -A && git commit -qm 'test(e2e): add the proof scenario'",
];

scenario(
  {
    name: "requires-changes",
    timeoutMs: 300_000,
    briefs: { "no-scenario": "# No scenario\n\nThe work agent forgets the e2e scenario.\n" },
    config: (p) => ({
      // The idle nudge is what re-prompts the refused agent; the watchdogs stay out of its way.
      limits: { idle_nudge_seconds: 8, stall_seconds: 900, step_budget_seconds: 900 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "gated", source: "briefs", workspace_name: "r/{{work_id}}", steps: [{ type: "work", requires_changes: [GLOB] }, { type: "review" }] }],
    }),
    // First turn: the scripted commit lands under work/, never under the required path.
    agent: { steps: { review: { commit: false } } },
  },
  async (w) => {
    const key = "no-scenario";
    const run = () => w.db.run(key)!;

    // ── 1. refused: the branch changes nothing under the glob ───────────────────────────────────
    await w.waitForEvent(key, "step_done_refused", { label: "the work step-done is refused", timeoutMs: 120_000 });
    const refused = w.db.event(key, "step_done_refused")!;
    expect(refused.data.step).toBe("work");
    expect(String(refused.data.why), "the refusal names the missing glob").toContain(GLOB);
    await w.waitFor(() => w.agentLog().includes("cannot finish yet"), { label: "the agent logs the refusal it read on stderr" });
    expect(w.agentLog(), "with a non-zero exit, the agent's only channel").toMatch(/rc=1 .*ERR:.*cannot finish yet.*test\/e2e\/scenarios/s);
    const id = run().id;
    expect(w.db.step(id, "work")!.done, "the work step is not done").toBe(0);
    expect(run().step).toBe("work");
    expect(w.db.step(id, "review")?.dispatched_at ?? null, "the next step never started").toBeNull();

    // ── 2. accepted once a scenario is committed ────────────────────────────────────────────────
    w.setAgentScript({ steps: { work: { commit: false, run: ADD_SCENARIO }, review: { commit: false } } });
    await w.waitFor(() => w.db.step(id, "work")?.done === 1, { label: "the step-done is accepted after the scenario lands", timeoutMs: 120_000 });
    expect(w.db.events(key).filter((e) => e.type === "step_done_refused").length, "refused exactly once").toBe(1);
    // Nothing downstream ran between the refusal and the accept: the only step spawned before the
    // work step's step_done is the work step itself.
    const events = w.db.events(key);
    const doneAt = events.findIndex((e) => e.type === "step_done");
    const spawnedBefore = events.slice(0, doneAt).filter((e) => e.type === "step_spawned").map((e) => String(JSON.parse(e.detail ?? "{}").step));
    expect(spawnedBefore).toEqual(["work"]);
    await w.waitFor(() => w.db.step(id, "review")?.dispatched_at != null, { label: "the belt advances to review", timeoutMs: 120_000 });
  },
);
