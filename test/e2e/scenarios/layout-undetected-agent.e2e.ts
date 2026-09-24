// Issue #99, end to end: a step's layout pane holds a LIVE agent that herdr never DETECTED —
// `herdr agent list` shows the pane `agent_status: unknown` with NO `agent` field, and `agent prompt`
// cannot reach it. Seen on grok-bot after cursor-agent auto-updated: every dispatch went unconfirmed
// for 3 × 600s and the run parked `layout pane … never became available`, which `explain` blamed on
// plugin linking or tab names. Not issue #80's pane (`unknown` WITH `agent: cursor`, which takes a
// dispatch — `layout-unknown-agent` pins that one).
//
// Two items through one belt and one layout, told apart by the fake's HF_HERDR_UNDETECTED knob:
//   relaunch-item — undetected until its agent is relaunched by typing its command: the wait must
//                   `/quit` it and retype the layout's `cursor-agent` command exactly ONCE (never
//                   `agent start`, which herdr's stale registration refuses), and the next dispatch
//                   lands with no park.
//   stuck-item    — never detected: after its one relaunch the wait runs out and parks, and the park
//                   reason and `explain` name the detection failure.
//
// Lane: FAKE, and it has to be — a real herdr cannot be asked to list a live agent without its label.
// This lane has no layout hook, so the scenario builds each step's tab and starts its agent itself (as
// `layout-unknown-agent` does); the layout is still configured, because the relaunch types the
// command the LAYOUT declares for that pane.
import { expect } from "vitest";
import { expectParked, expectStepDone, scenario } from "../harness/index.ts";

const RELAUNCH = "relaunch-item";
const STUCK = "stuck-item";
/** Compressed: the relaunch fires at min(120s, layout_wait_seconds). */
const WAIT_SECONDS = 20;

scenario(
  {
    name: "layout-undetected-agent",
    lane: "fake",
    timeoutMs: 420_000,
    briefs: {
      [RELAUNCH]: "# Relaunch item\n\nherdr never detects the layout pane's agent until it is relaunched.\n",
      [STUCK]: "# Stuck item\n\nherdr never detects the layout pane's agent at all.\n",
    },
    fakeLaneLayouts: true, // the scenario builds the panes; the engine only reads the layout's command
    processEnv: { HF_HERDR_UNDETECTED: `${RELAUNCH},${STUCK}=sticky` },
    config: (p) => ({
      limits: { layout_wait_seconds: WAIT_SECONDS },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [{ id: "cursor-work", tabs: [{ title: "work", panes: [{ title: "work", agent: "cursor", agent_args: ["--model", "m1"] }] }] }],
      belt: [
        {
          name: "undetected-belt",
          source: "briefs",
          workspace_name: "und/{{work_id}}",
          default_layout: "cursor-work",
          steps: [{ type: "work", tab: "work", pane: "work" }],
        },
      ],
    }),
  },
  async (w) => {
    /** Build the step's pane with its first (undetected) cursor agent — the layout build's `agent start`. */
    const buildPane = (key: string): string => {
      const run = w.db.run(key)!;
      const created = w.herdr.cli(["tab", "create", "--workspace", run.workspace_id!, "--no-focus", "--label", "work", "--cwd", run.worktree_path!, "--env", `HERDR_FACTORY_TICKET=${key}`]);
      expect(created.code, `tab create for ${key}: ${created.stderr}`).toBe(0);
      const paneId = (JSON.parse(created.stdout) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id;
      const started = w.herdr.cli(["agent", "start", `ag-${key}`, "--kind", "cursor", "--pane", paneId, "--timeout", "30000"], { timeoutMs: 60_000 });
      expect(started.code, `agent start for ${key}: ${started.stderr}`).toBe(0);
      return paneId;
    };
    const agentOn = (paneId: string) => w.herdr.agents().find((a) => a.pane_id === paneId) as { agent_status: string; agent?: string } | undefined;
    const paneRuns = (paneId: string) => w.herdr.calls().filter((c) => c.argv[0] === "pane" && c.argv[1] === "run" && c.argv[2] === paneId).map((c) => c.argv[3]);
    /** `agent start`s on the pane other than the scenario's own build (`ag-<key>`, which also goes
     *  through the world's logging wrapper). */
    const engineAgentStarts = (paneId: string) =>
      w.herdr.calls().filter((c) => c.argv[0] === "agent" && c.argv[1] === "start" && c.argv.includes(paneId) && !c.argv[2]?.startsWith("ag-"));
    const relaunches = (key: string) => w.db.events(key).filter((e) => e.type === "pane_relaunched").map((e) => JSON.parse(e.detail ?? "{}") as { paneId: string; detected: boolean });

    await w.waitFor(() => w.db.run(RELAUNCH)?.workspace_id != null && w.db.run(STUCK)?.workspace_id != null, { label: "both worktrees are created", timeoutMs: 120_000 });
    const relaunchPane = buildPane(RELAUNCH);
    const stuckPane = buildPane(STUCK);
    // Pin the production shape before asserting what the engine did with it.
    for (const pane of [relaunchPane, stuckPane]) {
      expect(agentOn(pane)?.agent_status, "herdr lists the agent as unknown…").toBe("unknown");
      expect(agentOn(pane)?.agent, "…with no agent label").toBeUndefined();
    }

    // ── 1. relaunched once, then dispatched — no park ─────────────────────────────────────────
    const relaunchRun = w.db.run(RELAUNCH)!;
    await w.waitFor(() => (w.db.step(relaunchRun.id, "work")?.pane_id ?? null) === relaunchPane, {
      label: "the work step dispatches into the relaunched pane",
      timeoutMs: 180_000,
    });
    expect(relaunches(RELAUNCH), "exactly one relaunch, and herdr detected it").toEqual([expect.objectContaining({ paneId: relaunchPane, detected: true })]);
    expect(paneRuns(relaunchPane), "`/quit`, then the layout's own command").toEqual(["/quit", "'cursor-agent' '--model' 'm1'"]);
    expect(engineAgentStarts(relaunchPane), "never `agent start` — the stale registration refuses it").toEqual([]);
    expect(agentOn(relaunchPane)?.agent, "herdr now labels the pane's agent").toBe("cursor");
    expect(w.db.run(RELAUNCH)!.attention_reason_code, "no park on the way").toBeNull();
    await w.waitForEnd(RELAUNCH, "completed", { label: "the relaunched agent finishes the step", timeoutMs: 180_000 });
    expectStepDone(w, RELAUNCH, ["work"]);
    expect(relaunches(RELAUNCH), "…and still only the one relaunch").toHaveLength(1);

    // ── 2. never detected: one relaunch, then a park that names the real cause ─────────────────
    await w.waitFor(() => w.db.run(STUCK)?.attention_reason_code === "layout_wait_timeout", {
      label: "the stuck item parks after its wait runs out",
      timeoutMs: 300_000,
    });
    expectParked(w, STUCK, "layout_wait_timeout");
    const stuck = w.db.run(STUCK)!;
    expect(stuck.attention_reason).toBe(`work: agent in pane ${stuckPane} was never detected by Herdr (status unknown)`);
    expect(relaunches(STUCK), "one relaunch, and it did not take").toEqual([expect.objectContaining({ paneId: stuckPane, detected: false })]);
    expect(paneRuns(stuckPane).filter((c) => c === "/quit"), "quit once, never again across the retry windows").toHaveLength(1);
    expect(engineAgentStarts(stuckPane), "never `agent start`").toEqual([]);

    const explain = w.factory.cli(["explain", STUCK, "--source", "briefs"]).stdout;
    expect(explain).toContain("Herdr never detected the work step's agent");
    expect(explain).not.toMatch(/plugin|tab\/pane names/);
  },
);
