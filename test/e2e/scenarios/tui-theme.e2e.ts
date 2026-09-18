// The TUI follows herdr's theme, and the palette is chosen from a file on disk at launch — which is
// exactly the kind of wiring a unit test can prove and still get wrong in the shipped product. The
// resolver's own logic is pinned by `test/tui-theme.test.ts`; what only a live boot can show is that
// the real launcher, in a real herdr pane, reads the real `$XDG_CONFIG_HOME/herdr/config.toml` and
// comes up on that palette — and that a TUI which has just repainted itself in someone else's colors
// is still a TUI, not a crash or an unreadable screen.
//
// Three boots, one world: herdr's theme is followed; `HERDR_FACTORY_THEME` overrides it; no herdr
// theme is the light palette the TUI shipped with.
import { expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scenario } from "../harness/index.ts";
import { REPO_ROOT } from "../harness/world.ts";
import { delay } from "../harness/herdr.ts";
import type { World } from "../harness/index.ts";

// Hardcoded in src/tui/main.ts — the TUI has no writable state of its own at that point in boot.
const STARTUP_LOG = "/tmp/herdr-factory-tui-startup.log";

interface Startup {
  at: string;
  theme: string;
  theme_source: "herdr" | "env" | "default";
  app_ready?: number;
}

/** The startup records written so far, oldest first — one per TUI boot. */
function records(): Startup[] {
  if (!existsSync(STARTUP_LOG)) return [];
  return readFileSync(STARTUP_LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Startup);
}

/** What herdr's own config says, as the TUI will read it: `$XDG_CONFIG_HOME/herdr/config.toml` in
 *  this world. `undefined` removes the file, which is the no-herdr-theme case. */
function herdrTheme(w: World, name: string | undefined): void {
  const path = join(w.paths.home, ".config", "herdr", "config.toml");
  if (name === undefined) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `[theme]\nname = "${name}"\nauto_switch = false\n`);
}

/** Launch the shipped launcher in a herdr pane of its own — how an operator starts the TUI — and
 *  return the startup record it wrote plus the screen it left behind. */
async function bootTui(w: World, label: string, env: string[]): Promise<{ startup: Startup; screen: string }> {
  const before = records().length;
  const ws = w.herdr.workspaces()[0]!;
  const envFlags = ["--env", "HERDR_FACTORY_TUI_TIMING=1", ...env.flatMap((e) => ["--env", e])];
  const created = w.herdr.json<{ result?: { root_pane?: { pane_id?: string }; pane_id?: string } }>([
    "tab",
    "create",
    "--workspace",
    ws.workspace_id,
    "--no-focus",
    "--label",
    label,
    "--cwd",
    w.paths.repo,
    ...envFlags,
  ]);
  const pane = created?.result?.root_pane?.pane_id ?? created?.result?.pane_id;
  expect(pane, `herdr created a pane for ${label}: ${JSON.stringify(created)?.slice(0, 200)}`).toBeTruthy();

  await delay(1500); // the pane's shell needs to reach its prompt before `pane run` lands
  w.herdr.cli(["pane", "run", pane!, `${join(REPO_ROOT, "bin", "herdr-factory-tui")}`]);
  await w.waitFor(() => records().length > before, {
    label: `${label} reached app_ready and reported its theme`,
    timeoutMs: 120_000,
    pollMs: 500,
  });

  const screen = w.herdr.readPane(pane!, 60);
  // A booted TUI, not a crashed one — a theme that broke the renderer would otherwise still write a
  // startup record and pass the assertions below.
  for (const bad of ["requires Node >= 26", "Cannot find", "ERR_DLOPEN", "experimental-ffi", "Error:", "at Module"]) {
    expect(screen, `the ${label} screen shows no "${bad}"`).not.toContain(bad);
  }
  // Legible: the shell's own chrome and all three tab labels are on the screen. On an unreadable
  // palette (text painted in the background color) opentui writes the cells but the pane read still
  // returns the characters — so this is a "the TUI rendered its UI" check, and the contrast floors
  // every palette has to clear are measured in `test/tui-theme.test.ts`.
  expect(screen, `the ${label} screen shows the TUI shell`).toContain("herdr-factory");
  for (const tab of ["Dashboard", "Config", "Doctor"]) {
    expect(screen, `the ${label} screen shows the ${tab} tab`).toContain(tab);
  }

  const startup = records().at(-1)!;
  expect(startup.app_ready, `${label} reported app_ready`).toBeGreaterThan(0);
  return { startup, screen };
}

scenario(
  {
    name: "tui-theme",
    timeoutMs: 300_000,
    briefs: { "tui-item": "# A brief\n\nSo the dashboard has something to render.\n" },
    config: (p) => ({
      // No belt work is driven here; the config only has to be one the TUI can load and render.
      limits: { tick_interval_seconds: 3600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "tui", source: "briefs", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    beforeStart: async () => {
      // Shared /tmp across scenarios, so start from nothing rather than reading someone else's boot.
      rmSync(STARTUP_LOG, { force: true });
    },
  },
  async (w) => {
    herdrTheme(w, "tokyo-night");
    const followed = await bootTui(w, "tui-tokyo", []);
    expect(followed.startup, "the TUI boots on the theme herdr names").toMatchObject({
      theme: "tokyo-night",
      theme_source: "herdr",
    });

    // The override wins over the very same herdr config the boot above followed.
    const overridden = await bootTui(w, "tui-override", ["HERDR_FACTORY_THEME=light"]);
    expect(overridden.startup, "HERDR_FACTORY_THEME overrides herdr's theme").toMatchObject({
      theme: "light",
      theme_source: "env",
    });

    // A name from a herdr newer than this build: the nearest palette, and still a booting TUI.
    herdrTheme(w, "not-a-real-theme-dark");
    const unknown = await bootTui(w, "tui-unknown", []);
    expect(unknown.startup, "an unknown theme name falls back instead of crashing").toMatchObject({
      theme: "dark",
      theme_source: "herdr",
    });

    // And with no herdr theme at all, the palette the TUI has always had.
    herdrTheme(w, undefined);
    const bare = await bootTui(w, "tui-default", []);
    expect(bare.startup, "no herdr theme renders light, as before").toMatchObject({
      theme: "light",
      theme_source: "default",
    });

    w.recordMetrics({ themedBootMs: followed.startup.app_ready ?? -1, defaultBootMs: bare.startup.app_ready ?? -1 });
  },
);
