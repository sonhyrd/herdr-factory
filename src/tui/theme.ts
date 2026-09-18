// Colors for the TUI, and the one place any of them are written down.
//
// The factory's TUI runs inside herdr, so it **follows herdr's theme**: the palette is picked at
// startup from `[theme] name` in herdr's own `config.toml`, and one setting themes both. The `light`
// palette below is the original default — lifted from `lighter`
// (https://github.com/razajamil/lighter), a calm, light, WCAG-AA colorscheme on a #f7f7f7 ground —
// and it is still what renders when herdr has no theme of its own.
//
// Every palette carries the same role names (fg/comment/faint for text levels, border vs emphasis
// for inactive/active, line for fills/selection, tint for the focus fill, and the diagnostic hues),
// so the `theme.*` tokens built from one are identical whichever palette won.
//
// opentui has no central theme system: colors are passed per-component. But most components expose
// built-in `focused*` / `selected*` variants (focusedBorderColor, focused/selected background+text),
// so the active↔inactive swap is handled natively wherever a component owns its focus. For the
// composite cases — a panel border that tracks a child widget's focus, or the active section — we
// swap the token by hand (see setActiveSection in config-editor.ts). The structured tokens below are
// the single source we feed into both paths.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The colors one palette has to name. Text roles hold WCAG-AA contrast against `bg` (`comment` is
 *  AA-large, `faint` is for hints and decorative only) — `test/tui-theme.test.ts` measures it. */
export interface Palette {
  /** canvas */
  bg: string;
  /** primary text */
  fg: string;
  /** subtle fill / selection / chrome bars */
  line: string;
  /** focus fill (a tint of `emphasis` over `bg`) */
  tint: string;
  /** inactive borders */
  border: string;
  /** secondary text */
  comment: string;
  /** tertiary text — hints, de-emphasized */
  faint: string;
  /** accent / active / titles */
  emphasis: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

/** The original TUI palette, and still the no-herdr-theme default. */
const light: Palette = {
  bg: "#f7f7f7",
  fg: "#000000",
  line: "#e2eeee",
  tint: "#dbe3f2",
  border: "#9e9e9e",
  comment: "#787878",
  faint: "#a9a9a9",
  emphasis: "#325cc0",
  success: "#3e8024",
  warning: "#a16400",
  danger: "#d13e23",
  info: "#0075c4",
};

/** A neutral dark, for every dark theme we don't ship a palette for. */
const dark: Palette = {
  bg: "#1c1c1c",
  fg: "#e8e8e8",
  line: "#2e2e2e",
  tint: "#2b3b57",
  border: "#6b6b6b",
  comment: "#a8a8a8",
  faint: "#808080",
  emphasis: "#79b8ff",
  success: "#8ecb84",
  warning: "#dfa94f",
  danger: "#f58a86",
  info: "#71c1e8",
};

/** A palette per herdr built-in theme, plus the two generic `dark`/`light` fallbacks every unknown
 *  name lands on. Keys are herdr's own theme names (`herdr`'s config template lists them), so
 *  `[theme] name = "<x>"` needs no translation table. */
const palettes: Record<string, Palette> = {
  light,
  dark,
  "tokyo-night": {
    bg: "#1a1b26",
    fg: "#c0caf5",
    line: "#24283b",
    tint: "#2e3c64",
    border: "#565f89",
    comment: "#9aa5ce",
    faint: "#737aa2",
    emphasis: "#7aa2f7",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    info: "#7dcfff",
  },
  "tokyo-night-day": {
    bg: "#e1e2e7",
    fg: "#343b58",
    line: "#d0d5e3",
    tint: "#ccd6f0",
    border: "#8990b3",
    comment: "#4c5a91",
    faint: "#8990b3",
    emphasis: "#2e5cb8",
    success: "#4c6a2f",
    warning: "#7a5c22",
    danger: "#c21048",
    info: "#00617f",
  },
  catppuccin: {
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    line: "#313244",
    tint: "#2f3b5c",
    border: "#6c7086",
    comment: "#a6adc8",
    faint: "#7f849c",
    emphasis: "#89b4fa",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
    info: "#89dceb",
  },
  "catppuccin-latte": {
    bg: "#eff1f5",
    fg: "#4c4f69",
    line: "#dce0e8",
    tint: "#d6def7",
    border: "#8c8fa1",
    comment: "#5c5f77",
    faint: "#9ca0b0",
    emphasis: "#1a5ce0",
    success: "#2f7a22",
    warning: "#8a5d00",
    danger: "#c40f34",
    info: "#106f70",
  },
  dracula: {
    bg: "#282a36",
    fg: "#f8f8f2",
    line: "#343746",
    tint: "#3b3f5c",
    border: "#6272a4",
    comment: "#a4b1d8",
    faint: "#7683b8",
    emphasis: "#bd93f9",
    success: "#50fa7b",
    warning: "#f1fa8c",
    danger: "#ff6e6e",
    info: "#8be9fd",
  },
  nord: {
    bg: "#2e3440",
    fg: "#eceff4",
    line: "#3b4252",
    tint: "#434c5e",
    border: "#6b7891",
    comment: "#c1cad8",
    faint: "#909cb2",
    emphasis: "#88c0d0",
    success: "#a3be8c",
    warning: "#ebcb8b",
    danger: "#e08c92",
    info: "#a3c3dc",
  },
  gruvbox: {
    bg: "#282828",
    fg: "#ebdbb2",
    line: "#3c3836",
    tint: "#45403d",
    border: "#8a7d70",
    comment: "#bdae93",
    faint: "#928374",
    emphasis: "#83a598",
    success: "#b8bb26",
    warning: "#fabd2f",
    danger: "#fc6a5a",
    info: "#8ec07c",
  },
  "gruvbox-light": {
    bg: "#fbf1c7",
    fg: "#3c3836",
    line: "#ebdbb2",
    tint: "#e0dcc0",
    border: "#a89984",
    comment: "#665c54",
    faint: "#928374",
    emphasis: "#076678",
    success: "#6b6700",
    warning: "#8f5902",
    danger: "#9d0006",
    info: "#38694a",
  },
  "one-dark": {
    bg: "#282c34",
    fg: "#abb2bf",
    line: "#31353f",
    tint: "#3b4451",
    border: "#6b7280",
    comment: "#a0a8b7",
    faint: "#838b99",
    emphasis: "#61afef",
    success: "#98c379",
    warning: "#e5c07b",
    danger: "#e8848c",
    info: "#56b6c2",
  },
  "one-light": {
    bg: "#fafafa",
    fg: "#383a42",
    line: "#e5e5e6",
    tint: "#dbe3f2",
    border: "#a0a1a7",
    comment: "#63666e",
    faint: "#9d9fa6",
    emphasis: "#366ad6",
    success: "#2f7a2e",
    warning: "#8a5c00",
    danger: "#c01038",
    info: "#0072a3",
  },
  solarized: {
    bg: "#002b36",
    fg: "#93a1a1",
    line: "#073642",
    tint: "#0f4a57",
    border: "#5f757c",
    comment: "#839496",
    faint: "#657b83",
    emphasis: "#4fa3d9",
    success: "#9aad2f",
    warning: "#cba000",
    danger: "#ef5f5c",
    info: "#3fb8a8",
  },
  "solarized-light": {
    bg: "#fdf6e3",
    fg: "#54696f",
    line: "#eee8d5",
    tint: "#dfe7ee",
    border: "#93a1a1",
    comment: "#5c7178",
    faint: "#93a1a1",
    emphasis: "#1f6f9f",
    success: "#5c6b00",
    warning: "#835f00",
    danger: "#b62622",
    info: "#1d7a70",
  },
  kanagawa: {
    bg: "#1f1f28",
    fg: "#dcd7ba",
    line: "#2a2a37",
    tint: "#363646",
    border: "#7f7d74",
    comment: "#a5a29a",
    faint: "#84817a",
    emphasis: "#7e9cd8",
    success: "#98bb6c",
    warning: "#e6c384",
    danger: "#e46876",
    info: "#7aa89f",
  },
  "kanagawa-lotus": {
    bg: "#f2ecbc",
    fg: "#545464",
    line: "#e7dba0",
    tint: "#dcd7bd",
    border: "#8a8980",
    comment: "#5a5a55",
    faint: "#8a8980",
    emphasis: "#405678",
    success: "#526637",
    warning: "#75603c",
    danger: "#a8303f",
    info: "#4a6660",
  },
  "rose-pine": {
    bg: "#191724",
    fg: "#e0def4",
    line: "#26233a",
    tint: "#2f2b45",
    border: "#7d7997",
    comment: "#a49fc0",
    faint: "#807b9c",
    emphasis: "#c4a7e7",
    success: "#6bd6a0",
    warning: "#f6c177",
    danger: "#eb6f92",
    info: "#9ccfd8",
  },
  "rose-pine-dawn": {
    bg: "#faf4ed",
    fg: "#575279",
    line: "#f2e9e1",
    tint: "#e4dced",
    border: "#9893a5",
    comment: "#635e7a",
    faint: "#9893a5",
    emphasis: "#7a5f96",
    success: "#2f6b52",
    warning: "#7a5c28",
    danger: "#9c4a60",
    info: "#265d75",
  },
  vesper: {
    bg: "#101010",
    fg: "#ffffff",
    line: "#1c1c1c",
    tint: "#2a2317",
    border: "#5e5e5e",
    comment: "#a0a0a0",
    faint: "#7e7e7e",
    emphasis: "#ffc799",
    success: "#99ffe4",
    warning: "#ffc799",
    danger: "#ff8080",
    info: "#8ab4f8",
  },
  // herdr's `terminal` theme defers to the host terminal's own colors, which we can't read — a
  // neutral dark is the safer read of a terminal an agent workspace runs in.
  terminal: dark,
};

/** The names we ship a palette for. */
export const THEME_NAMES = Object.keys(palettes);

/** Substrings that mark a theme name as light or dark. Light wins — herdr's light variants are
 *  suffixed onto dark names (`tokyo-night-day`, `rose-pine-dawn`), so a `night` inside one of those
 *  must not decide it. */
const LIGHT_HINTS = ["light", "day", "dawn", "latte", "lotus", "white", "paper"];
const DARK_HINTS = ["dark", "night", "black", "mocha", "frappe", "macchiato", "moon", "storm", "dim"];

/** Where the theme name came from. */
export type ThemeSource = "env" | "herdr" | "default";

/** The outcome of picking a theme — what we render, what was asked for, and a note when those
 *  differ. The TUI reports it (Doctor tab, startup log) rather than printing onto the screen. */
export interface ThemeChoice {
  /** The palette we render on — always a key of `palettes`. */
  name: string;
  source: ThemeSource;
  /** The name that was asked for, when it isn't the one we render. */
  requested?: string;
  /** One line, human-readable, set only on a fallback. */
  note?: string;
}

/** Pick a palette for a requested theme name. Never throws — a name from a newer herdr than this
 *  build knows still has to boot the TUI — and picks the nearest palette it can:
 *
 *  1. the palette of that exact name;
 *  2. `light`, if the name says so (a light variant of a dark theme is still light);
 *  3. the palette of the longest name it extends, so a new variant renders in its own family
 *     (`kanagawa-dragon` → kanagawa) rather than on a generic dark;
 *  4. `dark`, if the name says so;
 *  5. `light` — where the TUI started, and the one every no-theme install already sees. */
export function chooseTheme(requested: string | undefined, source: ThemeSource): ThemeChoice {
  const name = requested?.trim().toLowerCase();
  if (!name) return { name: "light", source: "default" };
  if (palettes[name]) return { name, source };
  const fell = (to: string): ThemeChoice => ({ name: to, source, requested, note: `unknown theme "${requested}" — rendering the ${to} palette` });
  if (LIGHT_HINTS.some((h) => name.includes(h))) return fell("light");
  const family = THEME_NAMES.filter((n) => name.startsWith(`${n}-`)).sort((a, b) => b.length - a.length)[0];
  if (family) return fell(family);
  return fell(DARK_HINTS.some((h) => name.includes(h)) ? "dark" : "light");
}

/** `[theme] name` out of a herdr `config.toml`.
 *
 *  A hand-rolled scan rather than a TOML parser: this reads exactly one scalar out of someone
 *  else's config, on the TUI's startup path, and `src/doctor.ts` already reads `herdr-plugin.toml`
 *  the same way. `[theme.custom]` (or any later table) ends the section, so a `name` under it can't
 *  be mistaken for the theme's. herdr's `auto_switch` / `dark_name` / `light_name` are not
 *  followed — the host terminal's appearance isn't ours to read. */
export function themeNameFromToml(toml: string): string | undefined {
  let inTheme = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      inTheme = line === "[theme]";
      continue;
    }
    if (!inTheme) continue;
    const m = /^name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (m) return (m[1] ?? m[2])!.trim() || undefined;
  }
  return undefined;
}

/** herdr's config file — `$XDG_CONFIG_HOME/herdr/config.toml`, else `~/.config/herdr/config.toml`.
 *  Read (not stat'd) so a symlinked config, which is how a machine shares one herdr config, works. */
export function herdrConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME.trim(), "herdr") : join(env.HOME ?? homedir(), ".config", "herdr");
  return join(dir, "config.toml");
}

/** The theme this TUI renders on: `HERDR_FACTORY_THEME` if set, else herdr's `[theme] name`, else
 *  `light` — exactly as the TUI looked before it followed herdr at all. Unreadable or unparseable
 *  herdr config is not an error: it just means no theme. */
export function resolveTheme(env: NodeJS.ProcessEnv = process.env): ThemeChoice {
  const override = env.HERDR_FACTORY_THEME?.trim();
  if (override) return chooseTheme(override, "env");
  let toml: string;
  try {
    toml = readFileSync(herdrConfigPath(env), "utf8");
  } catch {
    return { name: "light", source: "default" };
  }
  return chooseTheme(themeNameFromToml(toml), "herdr");
}

/** The `theme.*` tokens every view paints from, built from one palette. */
export function buildTheme(palette: Palette) {
  return {
    /** Canvas background (also set on the renderer so the whole TUI reads as one surface). */
    bg: palette.bg,
    /** Header / footer / statusline fill. */
    barBg: palette.line,
    /** Tab bar fill when it holds the top-level focus. */
    barFocusBg: palette.tint,
    /** Row / control fill on mouse hover — subtle, sits *under* the active-row highlight (which is a
     *  gutter marker + accent text, not a background), so the two layer instead of fighting. */
    hoverBg: palette.line,

    /** Panel / section borders — swap active⇄inactive on focus. */
    border: {
      active: palette.emphasis,
      inactive: palette.border,
    },

    /** Text hierarchy, three levels. */
    text: {
      primary: palette.fg, // content
      secondary: palette.comment, // labels
      tertiary: palette.faint, // hints / de-emphasized
    },

    /** Text that reflects focus state — titles, tab labels, a highlighted row/field. */
    focusText: {
      focused: palette.emphasis,
      unfocused: palette.comment,
    },

    /** Selected row in a list. */
    selection: {
      bg: palette.line,
      fg: palette.emphasis,
    },

    /** Text input field states. */
    input: {
      bg: palette.line, // resting field chip
      fg: palette.fg,
      placeholder: palette.faint,
      focusBg: palette.tint, // focused / highlighted field
      focusFg: palette.fg,
      error: palette.danger,
    },

    /** Semantic status — kept separate from the accent. */
    status: {
      good: palette.success,
      warn: palette.warning,
      bad: palette.danger,
      info: palette.info,
    },

    /** The one accent (emphasis). */
    accent: palette.emphasis,
  };
}

/** The palette behind a name we ship. Unknown names never reach here — `chooseTheme` has already
 *  mapped them onto `dark`/`light` — so this is the tests' way in, and the last guard. */
export function paletteFor(name: string): Palette {
  return palettes[name] ?? light;
}

/** Which theme won, for the TUI to report. Picked once, at import — i.e. at TUI start. */
export const activeTheme: ThemeChoice = resolveTheme();

export const theme = buildTheme(paletteFor(activeTheme.name));

/** Default border style for panels. */
export const BORDER = "rounded" as const;
