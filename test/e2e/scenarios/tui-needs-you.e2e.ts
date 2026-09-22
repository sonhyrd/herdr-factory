// The one section of the board an operator opens it to read: what is blocked on a PERSON. Four
// things qualify, they come from four different places in the engine, and none of them is visible
// from the step columns — which is why they are lifted above the machine headers:
//
//   * a PR that is GREEN and waiting to be merged (the `pr_green` watch already knows, and the
//     factory never merges);
//   * a run PARKED for attention (here: a step that burned its budget without signalling);
//   * a run that ASKED a human a question and is holding for the answer;
//   * a machine that has stopped answering (proved in `tui-board`, not repeated here).
//
// The section's other half is that it is ABSENT when none of those exist — a heading that usually
// reads "nothing" teaches an operator to skip the top of the screen, which is the one place this
// board cannot afford to lose. So the scenario asserts the empty board FIRST, with only a healthy
// run on it, and only then lets the three states arrive.
import { expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import { REPO_ROOT } from "../harness/world.ts";
import { delay } from "../harness/herdr.ts";
import type { World } from "../harness/index.ts";

const STARTUP_LOG = "/tmp/herdr-factory-tui-startup.log";
/** One brief per belt, each with its own step name so the scripted agent can behave differently. */
const SHIP = "ship-1";
const PARK = "park-1";
const ASK = "ask-1";
/** Folders created in `beforeStart` — the park and ask briefs are dropped into them LATER, after the
 *  empty board has been asserted. */
const folder = (home: string, name: string) => join(home, `work-${name}`);

async function screenWith(w: World, pane: string, match: RegExp, label: string): Promise<string> {
  let screen = "";
  await w.waitFor(
    () => {
      screen = w.herdr.readPane(pane, 80);
      return match.test(screen);
    },
    { label, timeoutMs: 90_000, pollMs: 1000 },
  );
  return screen;
}

// The LAST line carrying `token`. A pane read is recent scrollback, so a full-screen TUI's buffer
// holds several frames end to end — the last match is the newest one, and the first would be a
// screenshot from before whatever we just waited for.
const lineWith = (screen: string, token: string): string =>
  screen.split("\n").findLast((l) => l.includes(token)) ?? `(no line contains "${token}")`;

scenario(
  {
    name: "tui-needs-you",
    timeoutMs: 420_000,
    config: (p) => ({
      limits: {
        tick_interval_seconds: 2,
        max_active_workspaces: 4,
        // Generous: this scenario's park is a BUDGET park, set per-step below. A short stall window
        // would race it and park the wrong run for the wrong reason.
        stall_seconds: 600,
      },
      work_sources: [
        { type: "local_markdown", name: "ship", local_markdown: { folder: folder(p.home, "ship") } },
        { type: "local_markdown", name: "park", local_markdown: { folder: folder(p.home, "park") } },
        { type: "local_markdown", name: "ask", local_markdown: { folder: folder(p.home, "ask") } },
      ],
      belt: [
        // Steps are NAMED, because the scripted agent resolves its behaviour by step name and all
        // three belts would otherwise share one `work`.
        { name: "shipping", source: "ship", workspace_name: "s/{{work_id}}", steps: [{ type: "work", name: "shipwork" }, { type: "pr", name: "shippr" }] },
        { name: "parking", source: "park", workspace_name: "p/{{work_id}}", steps: [{ type: "work", name: "parkwork", budget_seconds: 10 }] },
        { name: "asking", source: "ask", workspace_name: "a/{{work_id}}", steps: [{ type: "work", name: "askwork" }] },
      ],
    }),
    // A second machine, so the machine headers exist and "above the headers" is a real position.
    fleetMachines: {
      "build-box": {
        config: (p) => ({
          limits: { tick_interval_seconds: 2 },
          work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
          belt: [{ name: "quiet", source: "briefs", workspace_name: "q/{{work_id}}", steps: [{ type: "work" }] }],
        }),
      },
    },
    agent: {
      steps: {
        // The PR agent opens the PR and signals done. The belt's PR is not a draft, so the run may
        // hand off to the review watch before that signal lands (step-done is accepted in `reviewing`
        // either way) — and the gh fake's PR has no checks and no threads, so it is green. The signal
        // is load-bearing: since #78 a PR is not "ready to merge" while its pr step is still running.
        shippr: {},
        // Commits (so the heartbeat is satisfied) and then goes idle without signalling: the budget
        // watchdog parks it — the commonest park in the wild.
        parkwork: { signal: "none" },
        askwork: { signal: "ask-human", text: "Should the banner be blue or green?" },
      },
    },
    beforeStart: (p) => {
      rmSync(STARTUP_LOG, { force: true });
      for (const name of ["ship", "park", "ask"]) mkdirSync(folder(p.home, name), { recursive: true });
      // Only the healthy belt has work at boot — the other two arrive after the empty board is proved.
      writeFileSync(join(folder(p.home, "ship"), `${SHIP}.md`), "# Ship me\n\nGoes to a PR and waits for a human to merge it.\n");
    },
  },
  async (w) => {
    await w.waitFor(() => w.db.run(SHIP) !== undefined, { label: "the healthy run is claimed", timeoutMs: 120_000 });

    // ── the TUI, launched the way an operator launches it ──────────────────────────────────────
    const ws = w.herdr.workspaces()[0]!;
    const created = w.herdr.json<{ result?: { root_pane?: { pane_id?: string }; pane_id?: string } }>([
      "tab", "create", "--workspace", ws.workspace_id, "--no-focus", "--label", "tui", "--cwd", w.paths.repo, "--env", "HERDR_FACTORY_TUI_TIMING=1",
    ]);
    const pane = created?.result?.root_pane?.pane_id ?? created?.result?.pane_id;
    expect(pane, `herdr created a pane for the TUI: ${JSON.stringify(created)?.slice(0, 200)}`).toBeTruthy();
    await delay(1500);
    w.herdr.cli(["pane", "run", pane!, join(REPO_ROOT, "bin", "herdr-factory-tui")]);
    await w.waitFor(() => existsSync(STARTUP_LOG) && /"app_ready"/.test(readFileSync(STARTUP_LOG, "utf8")), {
      label: "the TUI reached app_ready",
      timeoutMs: 120_000,
      pollMs: 500,
    });

    // ── empty: a board with only healthy work draws no section at all ──────────────────────────
    const healthy = await screenWith(w, pane!, /✓ build-box/, "the board has both machines and the healthy run");
    expect(w.db.run(SHIP)!.phase, "nothing is parked yet").not.toBe("attention");
    expect(healthy, "a board with nothing blocked on a human has no `needs you` section").not.toContain("needs you");

    // ── the three states arrive ────────────────────────────────────────────────────────────────
    writeFileSync(join(folder(w.paths.home, "park"), `${PARK}.md`), "# Park me\n\nThe agent commits and then goes quiet.\n");
    writeFileSync(join(folder(w.paths.home, "ask"), `${ASK}.md`), "# Ask about me\n\nAmbiguous requirement — the agent should ask.\n");

    await w.waitFor(() => w.db.run(PARK)?.phase === "attention", { label: "the budget watchdog parks a run", timeoutMs: 150_000 });
    await w.waitFor(() => w.db.run(ASK)?.phase === "waiting_for_human", { label: "the asking agent parks on its question", timeoutMs: 150_000 });
    await w.waitForEvent(SHIP, "pr_green", { label: "the PR goes green and the operator is notified", timeoutMs: 240_000 });
    const pr = w.db.run(SHIP)!.pr_number!;
    expect(w.gh.pr(pr)?.state, "the factory never merges — the section is why a human knows to").toBe("OPEN");

    // The fact the section leads with is a DB read, not a GitHub call on the 3s poll.
    const status = await w.factory.repoApi<{ active: { ticketKey: string; prGreen?: boolean }[] }>("GET", "status?quick=1");
    expect(status.active.find((r) => r.ticketKey === SHIP)?.prGreen, "`/status` carries the green-PR watch's own verdict").toBe(true);

    // ── and the board leads with them ──────────────────────────────────────────────────────────
    // Wait for a frame carrying all THREE: the park, the question and the green land at their own
    // paces, and a screen with only the heading on it may predate any of them.
    const board = await screenWith(w, pane!, /needs you · 3/, "the board leads with what needs a human");
    expect(board.lastIndexOf("needs you"), "the section sits ABOVE the machine headers").toBeLessThan(board.lastIndexOf("✓ local"));
    // Matched against the whole screen: each of these keys also has a CARD further down its belt, so
    // picking "the line with the key on it" would be picking between the two.
    expect(board, "a green PR, named as ready to merge").toMatch(new RegExp(`✓ ${SHIP}\\s+PR #${pr} is green`));
    expect(board, "a parked run, with its reason rather than a count").toMatch(new RegExp(`⚠ ${PARK}\\s+parked —`));
    expect(board, "a run holding for an answer").toMatch(new RegExp(`\\? ${ASK}\\s+waiting for a human`));
    // The repo row names its problem ONCE. The doubled glyph is the `▲▲ 1 problem — press d` the
    // issue opened on: the row supplied a ⚠ that the renderer was already adding.
    expect(lineWith(board, "app  @local"), "the repo row carries one ⚠, and a cause rather than a count").toMatch(
      /app\s+@local\s+active \d+\/\d+\s+⚠ \d+ runs? parked/,
    );
  },
);
