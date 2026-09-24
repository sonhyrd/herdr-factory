// Issue #112: the idle nudge reaches a pane whose `agent_status` herdr cannot read.
//
// cursor-agent has no herdr lifecycle hooks, so its pane reports `unknown` for the run's whole life —
// and the idle nudge used to skip `unknown` outright, so a Cursor step that finished without running
// step-done sat there until its budget parked it. Now an `unknown` pane is nudged, but ONLY once its
// screen (herdr's per-pane `revision`) has held still for the whole window: output that keeps moving
// is an agent at work and must never be interrupted. The nudge goes down the confirmed path and is
// followed by one `enter` (Cursor can leave the text typed but unsubmitted), and the second nudge, at
// 2× the window, carries the exact step-done command.
//
// Lane: FAKE, for the reason layout-unknown-agent gives — a real herdr reports a quiet adopted process
// as `idle`, and `HF_AGENT_SILENT` is how this lane produces a live agent herdr reads as `unknown`.
// The same trade follows: no layout hook, so the scenario builds the step's pane and starts the
// silent agent in it itself (an `unknown` agent can't pass `agent start`'s readiness handshake, which
// is exactly why production only ever meets one in a layout pane).
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const KEY = "cursor-item";
const IDLE_NUDGE_SECONDS = 8;
/** The first turn stays busy (printing) for well over two idle windows — counted from the dispatch,
 *  which itself waits out the confirmed prompt's 20s handshake (an `unknown` status never flips). */
const BUSY_MS = 60_000;

scenario(
  {
    name: "idle-nudge-unknown",
    lane: "fake",
    timeoutMs: 360_000,
    briefs: { [KEY]: "# Cursor item\n\nThe agent never reports a status.\n" },
    processEnv: { HF_AGENT_SILENT: KEY },
    config: (p) => ({
      // Generous watchdogs: nothing here may park — the nudges are the whole story.
      limits: { idle_nudge_seconds: IDLE_NUDGE_SECONDS, stall_seconds: 900, step_budget_seconds: 900, layout_wait_seconds: 120 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "cursor-belt",
          source: "briefs",
          workspace_name: "cur/{{work_id}}",
          steps: [{ type: "work", tab: "work", pane: "work", budget_seconds: 900 }, { type: "review" }],
        },
      ],
    }),
    // The dispatched turn is busy — output every 500ms, never a status — and then never signals.
    agent: { steps: { work: { signal: "none", commit: false, hangMs: BUSY_MS, chatterMs: 500 } } },
  },
  async (w) => {
    const nudges = () => w.db.events(KEY).filter((e) => e.type === "idle_nudge");
    const argvOn = (pane: string, verb: string) =>
      w.herdr.calls().filter((c) => c.argv[0] === "agent" && c.argv[1] === verb && c.argv[2] === pane);

    await w.waitFor(() => (w.db.run(KEY)?.workspace_id ?? null) !== null, { label: "the worktree is created", timeoutMs: 120_000 });
    const run = w.db.run(KEY)!;
    const created = w.herdr.cli(["tab", "create", "--workspace", run.workspace_id!, "--no-focus", "--label", "work", "--cwd", run.worktree_path!, "--env", `HERDR_FACTORY_TICKET=${KEY}`]);
    expect(created.code, `tab create: ${created.stderr}`).toBe(0);
    const pane = (JSON.parse(created.stdout) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id;
    w.herdr.cli(["agent", "start", "ag-work", "--kind", "cursor", "--pane", pane, "--timeout", "3000"], { timeoutMs: 30_000 });
    const agent = () => w.herdr.agents().find((a) => a.pane_id === pane);

    await w.waitFor(() => (w.db.step(run.id, "work")?.pane_id ?? null) === pane, { label: "the work step dispatches into the unknown pane", timeoutMs: 180_000 });
    const rev0 = agent()?.revision ?? 0;
    await w.waitFor(() => (agent()?.revision ?? 0) > rev0 + 3, { label: "the busy turn is printing", timeoutMs: 60_000 });
    // Later turns (the nudges) are quick and quiet; the busy turn already running keeps its own script.
    w.setAgentScript({ steps: { work: { signal: "none", commit: false } } });

    // ── busy: output keeps moving, status is `unknown` — never nudged ──────────────────────────
    const busyUntil = Date.now() + (IDLE_NUDGE_SECONDS * 2 + 4) * 1000; // past both windows
    let lastRev = agent()!.revision ?? 0;
    let moves = 0;
    while (Date.now() < busyUntil) {
      await new Promise((r) => setTimeout(r, 1000));
      const a = agent()!;
      expect(a.agent_status, "the pane's status is unreadable throughout").toBe("unknown");
      if ((a.revision ?? 0) > lastRev) moves++;
      lastRev = a.revision ?? 0;
      expect(nudges().length, "a pane whose output keeps changing is never nudged").toBe(0);
    }
    expect(moves, "…and its output really was changing the whole time").toBeGreaterThan(IDLE_NUDGE_SECONDS);

    // ── quiet: the turn ends, the screen holds still — nudged after the window, then again ───────
    await w.waitFor(() => nudges().length >= 1, { label: "the quiet unknown pane is nudged", timeoutMs: 120_000 });
    const first = JSON.parse(nudges()[0]!.detail ?? "{}") as { nth?: number; worker?: string };
    expect(first).toMatchObject({ nth: 1, worker: "unknown" });
    const prompts = () => argvOn(pane, "prompt").filter((c) => c.argv.some((a) => /has been idle for ~/.test(a)));
    expect(prompts()[0]!.argv, "the nudge is CONFIRMED (--wait), not fire-and-forget").toContain("--wait");
    await w.waitFor(() => argvOn(pane, "send-keys").length >= 1, { label: "…and followed by an Enter", timeoutMs: 60_000 });
    expect(argvOn(pane, "send-keys")[0]!.argv.slice(3)).toEqual(["enter"]);

    await w.waitFor(() => nudges().length >= 2, { label: "the second nudge at 2× the window", timeoutMs: 120_000 });
    const second = prompts()[1]!.argv.join(" ");
    expect(second, "the second nudge carries the exact step-done command").toMatch(
      new RegExp(`herdr-factory --repo \\S+ step-done ${KEY} work --source briefs --pass 1`),
    );

    // Two is the cap: more quiet ticks send nothing more, and nothing parked.
    const until = Date.now() + IDLE_NUDGE_SECONDS * 1000 * 2;
    while (Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    expect(nudges().length, "at most two nudges per idle episode").toBe(2);
    expect(w.db.run(KEY)!.phase, "the nudges never park anything").toBe("running");
  },
);
