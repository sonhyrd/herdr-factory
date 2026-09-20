// Issue #44: a fresh worktree could stop `claude` at Claude Code's folder-trust prompt ("Is this a
// project you created or one you trust?"). herdr then never marked the agent ready, and the step
// targeting that layout pane burned its whole (1 + 3) x layout_wait_seconds budget waiting for an
// agent nobody was bringing up — the layout hook starts a pane's agent exactly once.
//
// Three behaviours, observed end to end on a real herdr:
//   1. the worktree is TRUSTED in Claude's own config before a claude agent is started in it, one key
//      at a time (everything else in that file is the user's);
//   2. a failed `agent start` reports herdr's OWN error code and message, in the log and in the
//      notification — the only thing that tells a harness stuck on a prompt apart from a missing
//      binary or a busy pane;
//   3. an expired layout-wait window RE-RUNS that `agent start` (kind and args off the layout pane)
//      when the pane is sitting at a shell prompt with no agent — and leaves a pane that already has
//      a live agent strictly alone.
//
// Two work items through one belt and one layout, told apart by the scripted agent's per-item startup
// knobs (they key on HERDR_FACTORY_TICKET, which the layout hook puts on the pane):
//   restart-item — the first two `claude` execs exit immediately (HF_AGENT_EXIT_FIRST): the layout
//                  BUILD's start fails, the pane falls back to its shell prompt, the wait's first
//                  re-adopt fails the same way (which is what makes the failure observable in the
//                  ENGINE's own log and notification — the build runs inside herdr's plugin hook,
//                  whose herdr calls bypass the world's logging wrapper), and the second re-adopt
//                  brings the agent up and the run finishes.
//   busy-item    — the agent reports `working` from the moment it is exec'd and holds it past the
//                  first window (HF_AGENT_BUSY_BOOT): the step cannot dispatch into an agent that is
//                  never ready for input, so the wait expires with a LIVE agent, which must not be
//                  touched. It idles afterwards and the run finishes normally.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { expectStepDone, scenario } from "../harness/index.ts";

/** A pre-existing Claude config: the trust edit must add one key to it and keep everything else. */
const SEEDED_CONFIG = {
  numStartups: 7,
  oauthAccount: { emailAddress: "someone@example.test" },
  projects: {
    "/somewhere/else": { hasTrustDialogAccepted: true, history: [{ display: "an earlier session" }] },
  },
};

const WAIT_SECONDS = 20;

scenario(
  {
    name: "layout-agent-restart",
    timeoutMs: 300_000,
    briefs: {
      "restart-item": "# Restart item\n\nThe layout's agent fails to start once.\n",
      "busy-item": "# Busy item\n\nThe layout's agent is alive but busy when the window expires.\n",
    },
    // Per-item startup behaviour for the scripted agent (see harness/agent/agent.cjs).
    processEnv: {
      HF_AGENT_EXIT_FIRST: "restart-item=2",
      // Comfortably past the first window (20s), so the expiry that matters cannot race it idling.
      HF_AGENT_BUSY_BOOT: "busy-item=40000",
    },
    beforeStart: (p) => {
      // CLAUDE_CONFIG_DIR is the world's HOME (harness/world.ts), so this is the file the engine edits.
      writeFileSync(join(p.home, ".claude.json"), `${JSON.stringify(SEEDED_CONFIG, null, 2)}\n`);
    },
    config: (p) => ({
      limits: { layout_wait_seconds: WAIT_SECONDS },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [
        {
          id: "one-agent",
          tabs: [
            {
              title: "work",
              panes: [
                {
                  title: "agent",
                  agent: "claude",
                  agent_args: ["--dangerously-skip-permissions"],
                  // A harness that exits on exec does NOT fail `agent start` fast: herdr waits out its
                  // whole readiness timeout, and while that call is in flight it keeps the agent's NAME
                  // reserved — a re-adopt inside that window is refused `agent_name_taken`. In
                  // production the default (60s) is far below `layout_wait_seconds` (600) so the build's
                  // start is long finished by the first expiry; here both are compressed, so the pane
                  // pins a timeout well under the 20s window to keep that ordering.
                  agent_timeout_ms: 8000,
                },
              ],
            },
          ],
        },
      ],
      belt: [
        {
          name: "restart-belt",
          source: "briefs",
          workspace_name: "agr/{{work_id}}",
          default_layout: "one-agent",
          steps: [{ type: "work", tab: "work", pane: "agent" }],
        },
      ],
    }),
  },
  async (w) => {
    const A = "restart-item"; // the agent that refuses its first start
    const B = "busy-item"; // the agent that is alive but busy

    for (const key of [A, B]) {
      await w.waitForEvent(key, "layout_applied", { label: `${key}: the layout is built`, timeoutMs: 120_000 });
    }
    const runA = w.db.run(A)!;
    const runB = w.db.run(B)!;
    // Both pane ids up front: a run that finishes takes its workspace with it, and 3b's assertions
    // outlive run B's teardown.
    const paneOf = (workspaceId: string) => w.herdr.panes(workspaceId).find((p) => p.label === "agent")!.pane_id;
    const paneA = paneOf(runA.workspace_id!);
    const paneB = paneOf(runB.workspace_id!);
    const startsFor = (paneId: string) =>
      w.herdr.calls().filter((c) => c.argv[0] === "agent" && c.argv[1] === "start" && c.argv.includes(paneId));

    // ── 1. the worktree is trusted in Claude's config, one key at a time ───────────────────────
    const claudeConfig = () => JSON.parse(readFileSync(join(w.paths.home, ".claude.json"), "utf8")) as {
      numStartups?: number;
      oauthAccount?: unknown;
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    await w.waitFor(() => claudeConfig().projects[runA.worktree_path!]?.hasTrustDialogAccepted === true, {
      label: "the worktree is trusted in claude's config before its agent starts",
      timeoutMs: 120_000,
    });
    const cfg = claudeConfig();
    expect(cfg.projects[runB.worktree_path!]?.hasTrustDialogAccepted, "the other run's worktree too").toBe(true);
    // The file is the user's whole Claude state: everything that was there is still there.
    expect(cfg.numStartups, "an unrelated top-level key survived").toBe(7);
    expect(cfg.oauthAccount, "…and an unrelated object").toEqual(SEEDED_CONFIG.oauthAccount);
    expect(cfg.projects["/somewhere/else"], "…and another project's own entry, whole").toEqual(SEEDED_CONFIG.projects["/somewhere/else"]);

    // ── 2. the failed start reports herdr's own error ──────────────────────────────────────────
    // Both the hook's build and the engine's re-adopt write to the repo log; only the ENGINE's calls
    // reach the world's herdr wrapper, so the notification is asserted off its re-adopt.
    const failedLine = () => w.factory.repoLog(600).split("\n").find((l) => /could not start claude in/.test(l));
    await w.waitFor(() => /could not start claude in \S+: \S/.test(failedLine() ?? ""), {
      label: "the failed adoption logs herdr's own error code",
      timeoutMs: 120_000,
    });
    const detail = /could not start claude in (\S+): (.+)$/.exec(failedLine()!)![2]!.trim();
    expect(detail.length, "herdr said WHY, not just that it failed").toBeGreaterThan(0);
    const failedNote = () => w.herdr.notifications().find((n) => n.title.includes("agent did not start"));
    // The notification is fired right after the log line — wait for it rather than racing it.
    await w.waitFor(() => failedNote() !== undefined, { label: "the operator is notified too", timeoutMs: 60_000 });
    expect(failedNote()!.body, "and the notification carries the same herdr error").toContain(detail);

    // ── 3a. a pane that already HAS an agent is left alone ────────────────────────────────────
    // First, because B's window expires before A is rescued and B tears its workspace down as soon as
    // it finishes. The foreground is sampled on every poll, so the reading is from the same moment.
    let foregroundB = "";
    await w.waitFor(
      () => {
        foregroundB = w.herdr.processInfo(paneB);
        return w.db.eventTypes(B).includes("layout_wait_retry");
      },
      { label: `${B}: the window expires against a live agent`, timeoutMs: 180_000 },
    );
    expect(w.db.event(B, "layout_wait_retry", "first")!.data.agentRestarted, "nothing was re-started").toBe(false);
    // The reason nothing was re-started: that pane's foreground is the agent, not a shell — exactly the
    // question `pane at-shell-prompt` asks before a re-adopt. (herdr does not LIST this agent: its own
    // `agent start` timed out on a harness that never idles, the faithful shape of one stuck
    // mid-startup, and that changes nothing here.)
    expect(foregroundB, "the pane's foreground is the agent, not a shell").toContain("claude");

    // ── 3b. …while an expired window DOES re-run `agent start` on a pane with no agent ─────────
    const restarts = () => w.db.events(A).filter((e) => e.type === "layout_wait_retry").map((e) => JSON.parse(e.detail ?? "{}").agentRestarted);
    await w.waitFor(() => restarts().includes(true), {
      label: `${A}: an expired window re-starts the pane's agent`,
      timeoutMs: 180_000,
    });
    // Every expiry tried: the first re-adopt hit the same refusing harness (false), the next brought it up.
    expect(restarts()[0], "the first expiry also re-ran the start").toBe(false);
    const retried = startsFor(paneA);
    expect(retried.length, "the engine's own re-adopts (the build's start is the hook's, unlogged)").toBeGreaterThanOrEqual(2);
    // Kind and args come from the LAYOUT pane, not from a guess.
    expect(retried.at(-1)!.argv).toEqual(expect.arrayContaining(["--kind", "claude", "--dangerously-skip-permissions"]));

    // ── both runs finish normally: no park, no human ───────────────────────────────────────────
    for (const key of [A, B]) {
      await w.waitForEnd(key, "completed", { label: `${key}: the work gets done`, timeoutMs: 240_000 });
      expectStepDone(w, key, ["work"]);
      expect(w.db.run(key)!.attention_reason_code, `${key} never parked`).toBeNull();
    }
    // Not one engine-issued adoption into B's pane, start to finish (the build's own start is the
    // hook's and never reaches this log) — the wait never touched a live agent.
    expect(startsFor(paneB), "B: the engine never re-adopted into a live agent's pane").toEqual([]);
  },
);
