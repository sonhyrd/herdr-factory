// The fleet as an OPERATOR meets it: the real TUI, in a real herdr pane, reading two real factory
// servers — and a keypress on the second machine's run landing on that machine's server and no
// other.
//
// `fleet-cli` already proves the merged read at the CLI. What only this can show is the half that
// lives in the terminal: that both machines' headers and runs are on the screen, that a key-driven
// action is ROUTED (the run disappears from the machine it was on, and the identically-named run on
// this machine is untouched), and that a machine which goes away turns its rows `unverifiable`
// instead of quietly blanking them — the reading an operator would act on.
//
// Both keys are the same on purpose: it is the case where guessing the target would be invisible in
// a screenshot and wrong in production.
import { expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import { REPO_ROOT } from "../harness/world.ts";
import { delay } from "../harness/herdr.ts";
import type { World } from "../harness/index.ts";

// Hardcoded in src/tui/main.ts — the TUI has no writable state of its own at that point in boot.
const STARTUP_LOG = "/tmp/herdr-factory-tui-startup.log";
const WORK = { type: "work" } as const;
/** The key both machines are working, so routing cannot be faked by matching on the key alone. */
const KEY = "shared-1";
/** A second item on the other machine, so it still has a run to show as last-known once it stops. */
const OTHER = "there-2";

interface Status {
  active: { ticketKey: string; phase: string }[];
}

/** The runs a machine's own server reports — the API trace that says where an action landed. */
async function activeKeys(api: () => Promise<Status>): Promise<string[]> {
  return (await api()).active.map((r) => r.ticketKey);
}

/** Read the pane until `match` shows up, so an assertion waits for the 3s poll instead of racing it. */
async function screenWith(w: World, pane: string, match: RegExp, label: string): Promise<string> {
  let screen = "";
  await w.waitFor(
    () => {
      screen = w.herdr.readPane(pane, 80);
      return match.test(screen);
    },
    { label, timeoutMs: 60_000, pollMs: 1000 },
  );
  return screen;
}

scenario(
  {
    name: "tui-fleet",
    timeoutMs: 300_000,
    briefs: { [KEY]: "# Worked here\n" },
    config: (p) => ({
      limits: { tick_interval_seconds: 2 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "here", source: "briefs", workspace_name: "h/{{work_id}}", steps: [WORK] }],
    }),
    // The second machine: its own factory, its own state, working an item with the SAME key.
    fleetMachines: {
      "build-box": {
        briefs: { [KEY]: "# Worked there\n", [OTHER]: "# Also worked there\n" },
        config: (p) => ({
          limits: { tick_interval_seconds: 2 },
          work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
          belt: [{ name: "there", source: "briefs", workspace_name: "t/{{work_id}}", steps: [WORK] }],
        }),
      },
    },
    // Both agents sit in `work` rather than finishing: the board is about runs IN FLIGHT.
    agent: { default: { hangMs: "forever" } },
    beforeStart: async () => {
      // Shared /tmp across scenarios, so start from nothing rather than reading someone else's boot.
      rmSync(STARTUP_LOG, { force: true });
    },
  },
  async (w) => {
    const here = () => w.factory.repoApi<Status>("GET", "status?quick=1");
    const there = () => w.machine("build-box").api<Status>("GET", "/repos/build-box/status?quick=1");

    await w.waitFor(async () => (await activeKeys(here)).length === 1 && (await activeKeys(there)).length === 2, {
      label: "a run in flight on this machine, two on the other",
    });

    // ── the TUI, launched the way an operator launches it ──────────────────────────────────────
    const ws = w.herdr.workspaces()[0]!;
    const created = w.herdr.json<{ result?: { root_pane?: { pane_id?: string }; pane_id?: string } }>([
      "tab",
      "create",
      "--workspace",
      ws.workspace_id,
      "--no-focus",
      "--label",
      "tui",
      "--cwd",
      w.paths.repo,
      "--env",
      "HERDR_FACTORY_TUI_TIMING=1",
    ]);
    const pane = created?.result?.root_pane?.pane_id ?? created?.result?.pane_id;
    expect(pane, `herdr created a pane for the TUI: ${JSON.stringify(created)?.slice(0, 200)}`).toBeTruthy();

    await delay(1500); // the pane's shell needs to reach its prompt before `pane run` lands
    w.herdr.cli(["pane", "run", pane!, join(REPO_ROOT, "bin", "herdr-factory-tui")]);
    await w.waitFor(() => existsSync(STARTUP_LOG) && /"app_ready"/.test(readFileSync(STARTUP_LOG, "utf8")), {
      label: "the TUI reached app_ready",
      timeoutMs: 120_000,
      pollMs: 500,
    });

    // ── both machines are on the screen ────────────────────────────────────────────────────────
    const board = await screenWith(w, pane!, /build-box/, "the board shows the other machine");
    for (const bad of ["requires Node >= 26", "Cannot find", "ERR_DLOPEN", "experimental-ffi", "Error:", "at Module"]) {
      expect(board, `the TUI screen shows no "${bad}"`).not.toContain(bad);
    }
    // A header per machine, each answering the questions the fleet view exists to answer: is it
    // reachable, what is it running, and how loaded is it.
    expect(board, "this machine has a header").toMatch(/✓ local \(this machine\)/);
    expect(board, "and so does the other one").toMatch(/✓ build-box/);
    expect(board, "carrying its server version").toMatch(/✓ build-box[^\n]*v\d/);
    expect(board, "and the repos it serves").toMatch(/✓ build-box[^\n]*repo/);
    // The work itself: both machines' repos, each badged with the machine that owns it.
    expect(board, "this machine's repo row").toContain(`${w.repoName}  @local`);
    expect(board, "the other machine's repo row").toContain("build-box  @build-box");
    // The status line counts the fleet rather than one server.
    expect(board).toMatch(/fleet 2\/2 machines/);

    // ── a key-driven action goes to the owning machine, and only there ─────────────────────────
    // Walk to the other machine's run card and tear it down: ↓ to the first focusable, then on
    // through this machine's rows until the highlight is on a build-box card. The highlight follows
    // reading order, so "press ↓ until the action line names the build-box run" is the operator's
    // own gesture, not a harness shortcut.
    w.herdr.sendKeys(pane!, "down");
    await delay(500);
    let onRemote = false;
    for (let i = 0; i < 12 && !onRemote; i++) {
      w.herdr.sendKeys(pane!, "down");
      await delay(400);
      // `x` asks for confirmation naming the machine — that modal IS the assertion that the
      // highlighted card belongs to build-box, and it is what an operator reads before saying yes.
      w.herdr.sendKeys(pane!, "x");
      await delay(700);
      const screen = w.herdr.readPane(pane!, 80);
      onRemote = new RegExp(`Tear down "${KEY}" on build-box`).test(screen);
      if (!onRemote && /\[y\] yes/.test(screen)) {
        w.herdr.sendKeys(pane!, "n"); // a card on this machine — back out and keep walking
        await delay(400);
      }
    }
    expect(onRemote, "the teardown confirmation names the machine the card belongs to").toBe(true);
    w.herdr.sendKeys(pane!, "y");

    // The run is gone from the machine that owned it…
    await w.waitFor(async () => !(await activeKeys(there)).includes(KEY), {
      label: `${KEY} on build-box was torn down`,
      timeoutMs: 60_000,
    });
    // …and the identically-keyed run on this machine was never touched. This is the whole point:
    // the key alone does not identify a run in a fleet.
    expect(await activeKeys(here), "the same key on this machine is untouched").toEqual([KEY]);
    expect(await activeKeys(there), "and the other run on that machine is untouched too").toEqual([OTHER]);
    expect(w.machine("build-box").serveLog(200), "the action reached that machine's server").toContain("teardown");

    // ── a machine that goes away is unverifiable, not empty ───────────────────────────────────
    await w.machine("build-box").stop();
    const blind = await screenWith(w, pane!, /unverifiable/, "the board reports the machine it can no longer reach");
    expect(blind, "it says how long it has been silent").toMatch(/build-box[^\n]*last seen/);
    expect(blind, "and that its runs are not known to be gone").toContain("NOT known to be gone");
    expect(blind, "its last known run is still on the board").toContain(OTHER);
    expect(blind, "marked for what it is").toContain("last known");
    // This machine's own work is untouched by the other's silence.
    expect(await activeKeys(here)).toEqual([KEY]);
    expect(blind, "and its board is still live").toContain(`${w.repoName}  @local`);
  },
);
