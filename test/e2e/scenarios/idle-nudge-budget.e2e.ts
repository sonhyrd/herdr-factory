// Issue #112: a run that never signals gets exactly two nudges before its budget park — including
// the shape that used to get NONE (runs whose worker was `done` at the park with no `idle_nudge`
// event at all).
//
// The idle nudge only runs when the watches say "nothing to do". A step whose budget expires while
// its agent is `working` is extended (a live agent is never parked by a timer), and the first tick
// that then found the agent at its prompt parked it on the spot — the nudge never got a look. Now
// that park is held for the nudges: the first at the window, the second at 2× carrying the exact
// step-done command, and only then the budget park.
import { expect } from "vitest";
import { expectParked, scenario } from "../harness/index.ts";

const KEY = "overrun";
const IDLE_NUDGE_SECONDS = 8;
const BUDGET_SECONDS = 10;
/** Working well past the budget, so the watchdog extends it at least once. */
const WORK_MS = (BUDGET_SECONDS + 12) * 1000;

scenario(
  {
    name: "idle-nudge-budget",
    timeoutMs: 300_000,
    briefs: { [KEY]: "# Overrun\n\nWorks past its budget, then forgets to signal.\n" },
    config: (p) => ({
      limits: { idle_nudge_seconds: IDLE_NUDGE_SECONDS, stall_seconds: 900 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "overrun", source: "briefs", workspace_name: "o/{{work_id}}", steps: [{ type: "work", budget_seconds: BUDGET_SECONDS }, { type: "review" }] }],
    }),
    // `working` past the budget, then idle — and never a signal.
    agent: { steps: { work: { signal: "none", commit: false, hangMs: WORK_MS } } },
  },
  async (w) => {
    const nudges = () => w.db.events(KEY).filter((e) => e.type === "idle_nudge");

    await w.waitFor(() => w.factory.repoLog(400).includes(`${KEY}: work past budget but still working — extending`), {
      label: "the budget expires while the agent works, and is extended",
      timeoutMs: 120_000,
    });
    // The nudges' own turns must not start another long `working` stretch: quiet, idle, no signal.
    w.setAgentScript({ steps: { work: { signal: "none", commit: false, status: "idle", workMs: 0 } } });

    await w.waitFor(() => w.db.run(KEY)?.phase === "attention", { label: "the run finally parks on its budget", timeoutMs: 180_000 });
    expectParked(w, KEY, "step_budget");
    expect(nudges().length, "exactly two nudges before the budget park").toBe(2);
    expect(w.factory.repoLog(400), "the park was held for them").toContain("holding the park for the idle nudge");

    const sent = w.herdr
      .calls()
      .filter((c) => c.argv[0] === "agent" && c.argv[1] === "prompt")
      .filter((c) => c.argv.some((a) => /has been idle for ~/.test(a)));
    expect(sent.length).toBe(2);
    expect(sent[0]!.argv.join(" "), "the first points at the step's prompt").not.toMatch(/step-done \S+ work --source/);
    expect(sent[1]!.argv.join(" "), "the second carries the exact step-done command").toMatch(
      new RegExp(`herdr-factory --repo \\S+ step-done ${KEY} work --source briefs --pass 1`),
    );
    // The event order is the contract: nudge, nudge, park.
    const order = w.db.events(KEY).map((e) => e.type).filter((t) => t === "idle_nudge" || t === "attention");
    expect(order).toEqual(["idle_nudge", "idle_nudge", "attention"]);
  },
);
