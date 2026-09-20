// The TUI is the other half of the product, and the only half with a native dependency: opentui
// renders through a compiled core that needs Node ≥ 26 with `--experimental-ffi` and the right libc
// build of its native library. None of that is exercised by a unit test — a broken FFI resolve, a musl
// mismatch or a missing pinned Node all fail identically, at launch, on a real terminal.
//
// So this launches the real launcher in a real PTY (a herdr pane, which is where operators actually run
// it) and asserts what only a live boot can show: that startup reached `app_ready`, how long each stage
// took, and that nothing wrote a stack trace onto the screen.
//
// The timing budget is deliberately loose. It is a tripwire for a startup regression of the kind that
// already happened once (an eager import pulling the Effect/OTel graph into the boot path), not a
// benchmark — `test/tui-startup-graph.test.ts` owns the tight version of that check.
import { expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import { REPO_ROOT } from "../harness/world.ts";
import { delay } from "../harness/herdr.ts";

// Hardcoded in src/tui/main.ts — the TUI has no writable state of its own at that point in boot.
const STARTUP_LOG = "/tmp/herdr-factory-tui-startup.log";
const APP_READY_BUDGET_MS = 8_000;
/** The host-local gate this world sets, so the board has one to print (or to lose). */
const MACHINE_CAP = 4;

interface Timing {
  at: string;
  node_startup: number;
  modules_loaded: number;
  app_ready?: number;
}

scenario(
  {
    name: "tui-boot",
    timeoutMs: 240_000,
    briefs: { "tui-item": "# A brief\n\nSo the dashboard has something to render.\n" },
    config: (p) => ({
      // No belt work is driven here; the config only has to be one the TUI can load and render.
      limits: { tick_interval_seconds: 3600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "tui", source: "briefs", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    beforeStart: async (p) => {
      // Shared /tmp across scenarios, so start from nothing rather than reading someone else's boot.
      rmSync(STARTUP_LOG, { force: true });
      // A host-local gate, so this scenario can hold the line the fleet board carries on its machine
      // header: on an install of ONE there is no header, and the cap/memory figures have to be
      // printed somewhere or the "why has nothing been claimed?" question is answered nowhere.
      mkdirSync(p.configDir, { recursive: true });
      writeFileSync(join(p.configDir, "machine.yml"), `max_active_workspaces: ${MACHINE_CAP}\nmin_free_memory_mb: 1\n`);
    },
  },
  async (w) => {
    // A pane of its own, in the main checkout, with the world's environment — i.e. exactly how an
    // operator's TUI is launched, including HERDR_FACTORY_CONFIG_DIR/_STATE_ROOT pointing at this world.
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

    // Give the pane's shell a moment to reach its prompt, then launch the real launcher — not `node
    // src/tui/main.ts`, because the launcher's own Node resolution is part of what ships.
    await delay(1500);
    w.herdr.cli(["pane", "run", pane!, `${join(REPO_ROOT, "bin", "herdr-factory-tui")}`]);

    await w.waitFor(() => existsSync(STARTUP_LOG) && /"app_ready"/.test(readFileSync(STARTUP_LOG, "utf8")), {
      label: "the TUI reached app_ready and emitted its startup timing",
      timeoutMs: 120_000,
      pollMs: 500,
    });

    const lines = readFileSync(STARTUP_LOG, "utf8").trim().split("\n").filter(Boolean);
    const timing = JSON.parse(lines[lines.length - 1]!) as Timing;
    // `app_ready` is the shell; the Dashboard's first poll lands a moment later. Wait for the status
    // line it writes, so what follows is read off a PAINTED screen rather than the "loading…" frame.
    let screen = "";
    await w.waitFor(
      () => {
        screen = w.herdr.readPane(pane!, 60);
        return /server up|server not running/.test(screen);
      },
      { label: "the Dashboard painted its first poll", timeoutMs: 60_000, pollMs: 500 },
    );

    w.recordMetrics({
      nodeStartupMs: timing.node_startup,
      modulesLoadedMs: timing.modules_loaded,
      appReadyMs: timing.app_ready ?? -1,
    });

    expect(timing.app_ready, "app_ready is reported").toBeGreaterThan(0);
    expect(timing.app_ready!, `the TUI reached app_ready in ${timing.app_ready}ms`).toBeLessThan(APP_READY_BUDGET_MS);
    // `modules_loaded` is the import graph; app_ready is everything. If loading modules is most of the
    // boot, something eager crept back into the graph.
    expect(timing.modules_loaded).toBeLessThanOrEqual(timing.app_ready!);

    // A booted TUI, not a crashed one: the launcher's own refusals and node's FFI failures all land on
    // this screen, and each is a distinct way the shipped TUI can be broken on a clean machine.
    for (const bad of ["requires Node >= 26", "Cannot find", "ERR_DLOPEN", "experimental-ffi", "Error:", "at Module"]) {
      expect(screen, `the TUI screen shows no "${bad}"`).not.toContain(bad);
    }

    // There are no herdr machines in this world, so there is no fleet — and a machine of one must
    // render exactly as it did before the fleet existed: no machine header, no `@machine` badge on
    // a repo row, and the single-server status line rather than a fleet count. (`tui-fleet` covers
    // the other side: what appears once there IS another machine.)
    for (const chrome of ["(this machine)", "@local", "fleet ", "unverifiable"]) {
      expect(screen, `a one-machine TUI shows no "${chrome}"`).not.toContain(chrome);
    }

    // …but the HOST-WIDE facts are not fleet chrome, and a board of one still has to carry them.
    // They belong to the machine, so they are printed once, above the repo rows — never appended to
    // every row, which is what the fleet board used to do.
    const gate = screen.split("\n").filter((l) => l.includes("working across all repos"));
    expect(gate.length, `the host gate is on exactly one line:\n${screen}`).toBe(1);
    // (The memory half runs off the right edge of a ~50-column pane; `test/tui-fleet-view.test.ts`
    // pins the whole string. What must be on SCREEN is the live occupancy against the host's cap.)
    expect(gate[0]!, "with this host's live occupancy against its cap").toMatch(
      new RegExp(`cap \\d+/${MACHINE_CAP} working across all repos · memory`),
    );
    expect(screen, "and the raw `machine: …` form never reaches a repo row").not.toContain("machine: cap");
  },
);
