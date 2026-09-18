// Doctor tab — machine-wide health (the same `baseGroups()` the `doctor` CLI command prints),
// rendered as green ✓ / red ✗ rows grouped by ownership (managed by herdr-factory vs you provide).
// The checks run LAZILY: only when the tab receives focus (activate), and again on `r`. On focus it
// runs the SHALLOW checks (local, side-effect-free); `d` runs the deep ones (gh auth, herdr daemon —
// network) on demand. A generation counter drops the render if you leave the tab mid-run, so a slow
// check never paints onto another tab.
import { BoxRenderable, ScrollBoxRenderable, type CliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { text } from "./render.ts";
import { baseGroups } from "../doctor.ts";
import { BORDER, activeTheme, theme, type ThemeSource } from "./theme.ts";
import type { TabView } from "./types.ts";

/** How the theme was chosen, in words, for the report row below. */
const THEME_SOURCE: Record<ThemeSource, string> = {
  herdr: "following herdr's config",
  env: "from HERDR_FACTORY_THEME",
  default: "default — herdr names no theme",
};

export function createDoctor(renderer: CliRenderer): TabView {
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.bg, paddingLeft: 1, paddingRight: 1 });
  const banner = text(renderer, { content: "", fg: theme.text.secondary, height: 1, wrapMode: "none" });
  const list = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0, // clip + scroll instead of growing over the footer (yoga's default flexShrink is 0)
    width: "100%",
    scrollY: true,
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    focusedBorderColor: theme.border.active,
    title: " Doctor ",
    titleColor: theme.text.secondary,
    paddingLeft: 1,
    paddingRight: 1,
  });
  root.add(banner);
  root.add(list);

  // Bumped on every activate/deactivate/re-run: an async run whose token is stale won't paint.
  let gen = 0;

  function clearList(): void {
    for (const c of [...list.getChildren()]) {
      list.remove(c.id);
      c.destroy(); // cascades to a row box's children
    }
  }
  function addText(content: string, fg: string): void {
    list.add(text(renderer, { content, fg, width: "100%", height: 1, wrapMode: "none" }));
  }
  /** A check row: the ✓/✗ mark colored by status, then the name + detail. */
  function addCheck(mark: string, markFg: string, label: string, textFg: string): void {
    const row = new BoxRenderable(renderer, { flexDirection: "row", height: 1, width: "100%", backgroundColor: theme.bg });
    row.add(text(renderer, { content: `${mark} `, fg: markFg, height: 1, wrapMode: "none" }));
    row.add(text(renderer, { content: label, fg: textFg, height: 1, wrapMode: "none", flexGrow: 1 }));
    list.add(row);
  }

  async function run(deep = false): Promise<void> {
    const token = ++gen;
    banner.content = deep ? "running deep checks (gh auth, herdr daemon)…" : "running checks…";
    banner.fg = theme.text.secondary;
    let groups;
    try {
      groups = await baseGroups(deep);
    } catch (e) {
      if (token !== gen) return;
      clearList();
      addText(`could not run checks: ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
      banner.content = "⚠ checks errored";
      banner.fg = theme.status.bad;
      return;
    }
    if (token !== gen) return; // left the tab (or re-triggered) mid-run — discard this result

    clearList();
    let failures = 0;
    let warnings = 0;
    groups.forEach((g, gi) => {
      if (gi > 0) addText("", theme.text.tertiary); // blank line between groups
      addText(`${g.title}:`, theme.text.secondary);
      for (const c of g.checks) {
        const warn = !!c.warn && c.ok; // amber: a healthy-but-wants-attention check (e.g. a skipped/failed update)
        if (!c.ok) failures++;
        else if (warn) warnings++;
        const line = c.detail ? `${c.name} — ${c.detail}` : c.name;
        const mark = warn ? "⚠" : c.ok ? "✓" : "✗";
        const fg = warn ? theme.status.warn : c.ok ? theme.status.good : theme.status.bad;
        addCheck(mark, fg, `  ${line}`, c.ok && !warn ? theme.text.primary : fg);
      }
    });
    // The TUI's own row. The theme resolver can't print — stdout belongs to the renderer — so this is
    // where it reports which palette won, and the one place a fallback is visible.
    addText("", theme.text.tertiary);
    addText("This TUI:", theme.text.secondary);
    if (activeTheme.note) warnings++;
    addCheck(
      activeTheme.note ? "⚠" : "✓",
      activeTheme.note ? theme.status.warn : theme.status.good,
      `  theme — ${activeTheme.name} (${THEME_SOURCE[activeTheme.source]})${activeTheme.note ? ` · ${activeTheme.note}` : ""}`,
      activeTheme.note ? theme.status.warn : theme.text.primary,
    );
    list.scrollTop = 0;
    const mode = deep ? "deep" : "shallow";
    const hint = "r: re-run · d: deep";
    const warnNote = warnings > 0 ? ` · ${warnings} warning(s)` : "";
    banner.content = failures === 0 ? `● all checks passed (${mode})${warnNote} · ${hint}` : `⚠ ${failures} check(s) failing (${mode})${warnNote} · ${hint}`;
    banner.fg = failures === 0 ? (warnings > 0 ? theme.status.warn : theme.status.good) : theme.status.warn;
  }

  list.onKeyDown = (key: KeyEvent) => {
    switch (key.name) {
      case "up":
        list.scrollTop = Math.max(0, list.scrollTop - 1);
        key.preventDefault();
        break;
      case "down":
        list.scrollTop = list.scrollTop + 1;
        key.preventDefault();
        break;
      case "r":
        void run(false);
        key.preventDefault();
        break;
      case "d":
        void run(true); // deep: interacts with gh/herdr (network) — on demand only
        key.preventDefault();
        break;
    }
  };

  return {
    root,
    sectionCount: 1,
    focusSection(n: number) {
      if (n === 1) list.focus();
    },
    restoreFocus() {
      list.focus();
    },
    activate() {
      void run(); // run ONLY when the tab receives focus
    },
    deactivate() {
      gen++; // invalidate any in-flight run so it won't paint after we're gone
    },
  };
}
