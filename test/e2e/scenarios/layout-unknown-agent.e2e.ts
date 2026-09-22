// Issue #80, end to end: a step's layout pane holds a LIVE agent whose `agent_status` herdr cannot
// read, and the run's `hf_*` tokens while a later step is still waiting for a pane of its own.
//
// herdr derives `agent_status` from the harness's own lifecycle signals. A harness that has never
// been prompted may never emit one: on grok-bot a freshly started `cursor-agent` sat idle at its
// prompt reporting `agent_status: unknown` for the run's whole life. Two failures followed.
//
//   1. The dispatch gate required `isReadyForInput` (idle/done), so the step targeting that pane
//      burned every layout-wait window and parked `layout_wait_timeout` against a pane that was
//      ready all along. `resume` did not help — the next tick made the same judgement.
//   2. While a step waits, the run's `hf_*` tokens are published on `run.paneId` — the pane of
//      whichever step DISPATCHED last. The waiting step's name therefore landed on the PREVIOUS
//      step's (finished) pane, and the pane it was actually waiting for carried nothing at all.
//
// Lane: FAKE, and it has to be. The unknown status is the point, and a real herdr 0.7.5 reports a
// quiet adopted process as `idle` — there is no way to ask it for `unknown`. This lane reads
// `agent_status` from a file the agent writes itself (harness/herdr-fake/README.md), so an agent
// that writes nothing is `unknown` with a live process, which is exactly the production shape. The
// cost is that this lane has no layout hook, so the scenario builds the step's tab and starts its
// agent itself — `tab create --label X` gives a tab labelled X whose root pane is labelled X too,
// which is what a step declaring `tab: X, pane: X` resolves by. Everything the assertions are about
// — the dispatch gate, the wait, the park, the metadata — is the engine's, not the hook's.
import { expect } from "vitest";
import { expectParked, expectStepDone, expectTimeline, scenario } from "../harness/index.ts";

const KEY = "unknown-item";
/** Compressed, and comfortably longer than one tick: the scenario has to build each pane INSIDE a
 *  wait window for the first half, and let the review step's window expire through its three bounded
 *  re-arms into a park for the second. */
const WAIT_SECONDS = 20;

scenario(
  {
    name: "layout-unknown-agent",
    lane: "fake",
    timeoutMs: 420_000,
    briefs: { [KEY]: "# Unknown item\n\nThe layout pane's agent never reports a status.\n" },
    // The agent in this item's panes never reports a state: no OSC title, no status file. herdr can
    // see the process and its kind but cannot say what it is doing — `agent_status: unknown`.
    processEnv: { HF_AGENT_SILENT: KEY },
    config: (p) => ({
      limits: { layout_wait_seconds: WAIT_SECONDS },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "unknown-belt",
          source: "briefs",
          workspace_name: "unk/{{work_id}}",
          steps: [
            { type: "work", tab: "work", pane: "work" },
            { type: "review", tab: "review", pane: "review" },
          ],
        },
      ],
    }),
    agent: { steps: { review: { commit: false } } },
  },
  async (w) => {
    /** Build the pane a step is waiting for, with a SILENT agent in it. `agent start` here never sees
     *  a status, so it answers `agent_start_timeout` after its (short) timeout — while leaving the
     *  process running and the pane recorded as that agent's, which is the state under test. */
    const buildPane = (label: string, run: { workspace_id: string | null; worktree_path: string | null }): string => {
      const created = w.herdr.cli(["tab", "create", "--workspace", run.workspace_id!, "--no-focus", "--label", label, "--cwd", run.worktree_path!, "--env", `HERDR_FACTORY_TICKET=${KEY}`]);
      expect(created.code, `tab create ${label}: ${created.stderr}`).toBe(0);
      const paneId = (JSON.parse(created.stdout) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id;
      w.herdr.cli(["agent", "start", `ag-${label}`, "--kind", "cursor", "--pane", paneId, "--timeout", "3000"], { timeoutMs: 30_000 });
      return paneId;
    };
    const agentOn = (paneId: string) => w.herdr.agents().find((a) => a.pane_id === paneId);
    /** Every `hf_step` value the engine has ever published on this pane, in order. */
    const stepTokensOn = (paneId: string): string[] =>
      w.herdr
        .paneMetadata()
        .filter((m) => m.paneId === paneId)
        .map((m) => /(?:^|\s)hf_step=(\S+)/.exec(m.argv.join(" "))?.[1])
        .filter((v): v is string => v !== undefined);

    // ── 1. an unknown-status pane is judged available and dispatched into ──────────────────────
    await w.waitFor(() => (w.db.run(KEY)?.workspace_id ?? null) !== null, { label: "the worktree is created", timeoutMs: 120_000 });
    const run = w.db.run(KEY)!;
    const workPane = buildPane("work", run);

    // The pane really is a LIVE agent herdr cannot read a status for. `gone` (no agent at all) would
    // still have to wait; `unknown` is the one state the gate opened to, so pin it before asserting
    // what the engine did with it.
    await w.waitFor(() => agentOn(workPane) !== undefined, { label: "herdr lists an agent in the work pane", timeoutMs: 60_000 });
    expect(agentOn(workPane)!.agent_status, "…whose status herdr cannot read").toBe("unknown");

    await w.waitFor(() => (w.db.step(run.id, "work")?.pane_id ?? null) === workPane, {
      label: "the work step dispatches into the unknown-status pane",
      timeoutMs: 180_000,
    });
    expect(w.factory.repoLog(400), "the engine says it dispatched to a layout pane").toContain("dispatched to layout pane");
    // The whole point: it never had to wait the pane out.
    expect(w.db.run(KEY)!.attention_reason_code, "no park on the way in").toBeNull();

    // ── 2. the NEXT step waits — and never retags the pane it does not own ─────────────────────
    // `review` targets a tab nothing has built, so its wait runs out its windows and parks while
    // `run.paneId` is still the work pane.
    await w.waitFor(() => w.db.run(KEY)?.attention_reason_code === "layout_wait_timeout", {
      label: "the review step parks waiting for a pane that does not exist",
      timeoutMs: 300_000,
    });
    expectParked(w, KEY, "layout_wait_timeout");
    expectStepDone(w, KEY, ["work"]);
    const parked = w.db.run(KEY)!;
    expect(parked.step, "the run's current step is review").toBe("review");
    expect(w.db.step(parked.id, "review")?.pane_id ?? null, "…which never dispatched anywhere").toBeNull();
    expect(parked.pane_id, "…so the run's pane is still the WORK step's").toBe(workPane);

    // The park's own cue DOES still land on the work pane: the posture is the RUN's, and that is the
    // pane the operator is looking at. Only the step NAME was ever wrong. Waited for rather than read
    // straight off the park — `escalateAttention` writes the DB row before it publishes, so the
    // metadata call is still in flight when the phase flip is observed.
    const wroteAttention = () =>
      w.herdr.paneMetadata().some((m) => m.paneId === workPane && m.argv.join(" ").includes("hf_state=attention"));
    await w.waitFor(wroteAttention, { label: "the park's attention cue reaches the work pane", timeoutMs: 60_000 });

    // And every metadata write on that pane — including that `⚠ ATTENTION` one — names WORK, the step
    // that owns it. Never `review`, which has no pane of its own.
    const owned = stepTokensOn(workPane);
    expect(owned.length, "the engine published hf_step on the work pane").toBeGreaterThan(0);
    expect([...new Set(owned)], "hf_step on the work pane names only the step that owns it").toEqual(["work"]);

    // ── 3. resume of exactly this park dispatches on the next tick ─────────────────────────────
    const reviewPane = buildPane("review", parked);
    expect(agentOn(reviewPane)?.agent_status, "the review pane is unknown-status too").toBe("unknown");
    const r = w.resume(KEY);
    expect(r.code, `resume ${KEY}: ${r.stderr}`).toBe(0);
    await w.waitFor(() => (w.db.step(parked.id, "review")?.pane_id ?? null) === reviewPane, {
      label: "the resumed review step dispatches into the now-up unknown pane",
      timeoutMs: 180_000,
    });
    // The park is HEALED by the dispatch, in this order. (Deliberately not pinning a `step_done`
    // before the park: this lane's `agent prompt --wait` runs its full timeout against an agent whose
    // status never changes, so a fast agent's `step_done` can be recorded before the dispatch it
    // answers — the fast-signal race, which `fast-signal` owns.)
    expectTimeline(w, KEY, ["attention", "resumed", "step_spawned"]);
    // And the review pane carries its OWN step's tokens — the other half of the same rule.
    expect([...new Set(stepTokensOn(reviewPane))], "the review pane is tagged review").toEqual(["review"]);
    expect([...new Set(stepTokensOn(workPane))], "…and the work pane is still only work").toEqual(["work"]);

    await w.waitForEnd(KEY, "completed", { label: "both steps finish in unknown-status panes", timeoutMs: 240_000 });
    expectStepDone(w, KEY, ["work", "review"]);
  },
);
