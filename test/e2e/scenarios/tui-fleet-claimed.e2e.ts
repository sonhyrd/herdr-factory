// A ticket is claimed ONCE for the whole fleet — and the board has to say so.
//
// Each factory server only knows its own runs, so `GET /repos/<r>/eligible` on machine A keeps
// listing an item that machine B has already claimed and is working. The board read that answer
// literally and drew a READY card for it, next to B's running card for the same key: two cards, one
// ticket, and an operator with no way to tell which is true. On a three-host fleet every idle host
// advertised every other host's work.
//
// The TUI is the only place this can be shown, because the defect is in what is RENDERED — both
// servers' JSON is individually correct. So: two machines over one source name, B claims the shared
// item, and the pane must not draw it as ready on A. `y-open` is the control: an item nobody has
// claimed, which must still be a ready card in the same frame — otherwise "no ready card" would
// prove nothing but an empty lane.
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
/** Claimed on THIS machine: sorts first, so the single slot is spent on it. */
const LOCAL = "a-local";
/** Claimed by NOBODY — the control that proves the ready lane is drawn at all in this frame. */
const OPEN = "y-open";
/** In this machine's eligible answer, and an active run on the OTHER machine. */
const SHARED = "z-shared";
/** How a ready card starts (`kanban.ts` STATE_ICONS) — `●` is a run, `○` is the ready lane. */
const READY = (key: string) => `○ ${key}`;

interface Status {
  active: { ticketKey: string; phase: string }[];
}
interface EligibleBody {
  eligible: { source: string; key: string }[];
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
    name: "tui-fleet-claimed",
    timeoutMs: 300_000,
    briefs: { [LOCAL]: "# Worked here\n", [OPEN]: "# Nobody has this\n", [SHARED]: "# Worked on the other machine\n" },
    config: (p) => ({
      // ONE slot: `a-local` sorts first and takes it, so the other two stay eligible here — which is
      // what puts a fleet-claimed item in this machine's own eligible answer.
      limits: { tick_interval_seconds: 2, max_active_workspaces: 1 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "here", source: "briefs", workspace_name: "h/{{work_id}}", steps: [WORK] }],
    }),
    // The other machine, with the shared item and nothing else — the SAME source name, because a
    // work item's fleet-wide identity is (source, key) and that is what has to collide.
    fleetMachines: {
      "build-box": {
        briefs: { [SHARED]: "# Worked on the other machine\n" },
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

    await w.waitFor(
      async () => (await here()).active.some((r) => r.ticketKey === LOCAL) && (await there()).active.some((r) => r.ticketKey === SHARED),
      { label: "this machine works a-local; the other works z-shared" },
    );

    // ── the disagreement the board has to resolve ─────────────────────────────────────────────
    // This machine's server cannot know about the other's run, so it still offers the shared item.
    // That answer is not wrong — it is just incomplete, and the board is where the fleet is known.
    const offered = (await w.factory.repoApi<EligibleBody>("GET", "eligible")).eligible;
    expect(offered.map((i) => i.key).sort(), "this server still offers both unclaimed-here items").toEqual([OPEN, SHARED]);
    expect(offered.every((i) => i.source === "briefs"), "…under the same source name the other machine claimed it under").toBe(true);

    // ── the TUI, launched the way an operator launches it ─────────────────────────────────────
    const ws = w.herdr.workspaces()[0]!;
    const created = w.herdr.json<{ result?: { root_pane?: { pane_id?: string }; pane_id?: string } }>([
      "tab", "create", "--workspace", ws.workspace_id, "--no-focus", "--label", "tui", "--cwd", w.paths.repo, "--env", "HERDR_FACTORY_TUI_TIMING=1",
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

    // Wait for the SECOND paint: eligible work folds in after the quick status-only paint, so a board
    // asserted too early would be missing the ready lane entirely and pass for the wrong reason.
    const board = await screenWith(w, pane!, new RegExp(`○ ${OPEN}`), "the board has folded in this machine's eligible work");
    for (const bad of ["requires Node >= 26", "Cannot find", "ERR_DLOPEN", "Error:", "at Module"]) {
      expect(board, `the TUI screen shows no "${bad}"`).not.toContain(bad);
    }

    // ── the control: an item nobody has claimed IS a ready card, in this very frame ────────────
    expect(board, `an unclaimed item is ready — so "no ready card" below is a real absence:\n${board}`).toContain(READY(OPEN));

    // ── AC3: an item claimed on ANOTHER machine is not a ready card here ───────────────────────
    expect(board, `${SHARED} is an active run on build-box — it must not be advertised as ready anywhere:\n${board}`).not.toContain(READY(SHARED));
    // …and it is on the screen, as what it actually is: the other machine's run.
    expect(board, `${SHARED} is still shown — as build-box's running card:\n${board}`).toContain(`● ${SHARED}`);
    expect(board.split("\n").filter((l) => l.includes(SHARED)).length, `one ticket, one card:\n${board}`).toBe(1);

    // ── the machine filter cannot resurrect it ────────────────────────────────────────────────
    // The claimed set is built from every machine in the READ, not the ones on screen: narrowing the
    // board to this host hides build-box's run, and the ready lane must still not take the item back.
    w.herdr.sendKeys(pane!, "m");
    await delay(600);
    w.herdr.sendKeys(pane!, "down"); // past "all machines", onto this host
    await delay(200);
    w.herdr.sendKeys(pane!, "return");
    const narrowed = await screenWith(w, pane!, /showing .* only/, "the board is narrowed to one machine");
    expect(narrowed, "the control is still ready under the filter").toContain(READY(OPEN));
    expect(narrowed, "and the fleet-claimed item is still not").not.toContain(READY(SHARED));
  },
);
