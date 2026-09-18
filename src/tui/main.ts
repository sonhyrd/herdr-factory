const enabled = process.env.HERDR_FACTORY_TUI_TIMING === "1";
const started = performance.now();
const timings: Record<string, number> = {
  node_startup: Math.round(process.uptime() * 1000),
};

const { main } = await import("./index.ts");
timings.modules_loaded = Math.round(performance.now() - started);
// Already in the graph above (the shell paints from it), so this costs nothing — and it carries the
// theme the TUI resolved, which the startup record reports alongside the timings.
const { activeTheme } = await import("./theme.ts");
await main((name) => {
  timings[name] = Math.round(performance.now() - started);
  if (enabled && name === "app_ready") {
    void import("node:fs").then(({ appendFileSync }) => {
      const record = { at: new Date().toISOString(), theme: activeTheme.name, theme_source: activeTheme.source, ...timings };
      appendFileSync("/tmp/herdr-factory-tui-startup.log", `${JSON.stringify(record)}\n`);
    });
  }
});

export {};
