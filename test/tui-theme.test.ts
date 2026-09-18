// The TUI follows herdr's theme, which puts two things under test here.
//
// The resolver: `HERDR_FACTORY_THEME` beats herdr's `[theme] name`, which beats the light palette
// the TUI shipped with — and nothing in that chain may throw. A herdr config can be absent,
// unreadable, half-written, or name a theme from a newer herdr than this build knows, and the TUI
// still has to boot; the acceptance for the feature is explicitly "falls back without crashing".
//
// The palettes: every one of them is text on a background, so each ships measured contrast rather
// than hand-waved "looks fine in my terminal". The floors below are WCAG's, per role tier.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { THEME_NAMES, buildTheme, chooseTheme, herdrConfigPath, paletteFor, resolveTheme, themeNameFromToml, type Palette } from "../src/tui/theme.ts";

/** A herdr config directory under a fresh XDG root, with `config.toml` holding `toml` (or no file at
 *  all when `toml` is undefined). Returns the env a resolver call should see. */
function world(toml?: string): NodeJS.ProcessEnv {
  const xdg = mkdtempSync(join(tmpdir(), "hf-theme-"));
  if (toml !== undefined) {
    writeFileSync(join(xdg, "config.toml.real"), toml);
    // Via a symlink on purpose: sharing one herdr config across machines is a symlinked file, and
    // that must resolve rather than read as "no config".
    mkdirSync(join(xdg, "herdr"), { recursive: true });
    symlinkSync(join(xdg, "config.toml.real"), join(xdg, "herdr", "config.toml"));
  }
  return { XDG_CONFIG_HOME: xdg };
}

describe("themeNameFromToml", () => {
  it("reads [theme] name", () => {
    expect(themeNameFromToml('[theme]\nname = "tokyo-night"\n')).toBe("tokyo-night");
  });

  it("ignores a commented-out name, and a name in another table", () => {
    expect(themeNameFromToml('[theme]\n# name = "dracula"\n')).toBeUndefined();
    expect(themeNameFromToml('[ui]\nname = "dracula"\n')).toBeUndefined();
  });

  it("stops at the next table, so [theme.custom] cannot supply the name", () => {
    expect(themeNameFromToml('[theme]\n[theme.custom]\nname = "nord"\n')).toBeUndefined();
    expect(themeNameFromToml('[theme]\nname = "nord"\n[theme.custom]\nname = "gruvbox"\n')).toBe("nord");
  });

  it("takes single quotes, surrounding blank lines and an empty value", () => {
    expect(themeNameFromToml("\n[theme]\n\nauto_switch = false\nname = 'vesper'\n")).toBe("vesper");
    expect(themeNameFromToml('[theme]\nname = ""\n')).toBeUndefined();
  });

  it("returns nothing for config that names no theme at all", () => {
    expect(themeNameFromToml("onboarding = false\n[keys]\nnew_tab = [\"prefix+c\"]\n")).toBeUndefined();
  });
});

describe("chooseTheme", () => {
  it("uses a name we ship a palette for", () => {
    expect(chooseTheme("tokyo-night", "herdr")).toEqual({ name: "tokyo-night", source: "herdr" });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(chooseTheme("  Tokyo-Night ", "env").name).toBe("tokyo-night");
  });

  it("falls back to light with no name at all", () => {
    expect(chooseTheme(undefined, "herdr")).toEqual({ name: "light", source: "default" });
    expect(chooseTheme("   ", "herdr")).toEqual({ name: "light", source: "default" });
  });

  it.each([
    ["everforest-dark", "dark"],
    ["some-midnight", "dark"],
    ["catppuccin-macchiato", "catppuccin"], // a variant of a theme we ship renders in its own family
    ["kanagawa-dragon", "kanagawa"],
    ["ayu-light", "light"],
    ["zenbones-dawn", "light"],
    ["gruvbox-material-light", "light"], // light wins over the family it extends
    ["quartz", "light"], // no hint either way — light, which is where the TUI started
  ])("maps the unknown %s onto the %s palette, with a note", (requested, expected) => {
    const choice = chooseTheme(requested, "herdr");
    expect(choice.name).toBe(expected);
    expect(choice.requested).toBe(requested);
    expect(choice.note).toContain(requested);
  });

  it("reads a light variant as light even when its dark parent's name is in it", () => {
    expect(chooseTheme("tokyo-night-moon-day", "herdr").name).toBe("light");
  });
});

describe("resolveTheme", () => {
  it("follows herdr's theme", () => {
    expect(resolveTheme(world('[theme]\nname = "catppuccin"\n'))).toEqual({ name: "catppuccin", source: "herdr" });
  });

  it("is light — the palette the TUI shipped with — when there is no herdr config", () => {
    expect(resolveTheme(world())).toEqual({ name: "light", source: "default" });
  });

  it("is light when herdr's config names no theme", () => {
    expect(resolveTheme(world("onboarding = false\n"))).toEqual({ name: "light", source: "default" });
  });

  it("lets HERDR_FACTORY_THEME win over herdr", () => {
    const env = { ...world('[theme]\nname = "tokyo-night"\n'), HERDR_FACTORY_THEME: "light" };
    expect(resolveTheme(env)).toEqual({ name: "light", source: "env" });
  });

  it("falls back, without throwing, on a theme neither herdr nor the override knows", () => {
    expect(resolveTheme({ ...world(), HERDR_FACTORY_THEME: "no-such-theme" }).name).toBe("light");
    expect(resolveTheme(world('[theme]\nname = "everforest-dark"\n'))).toMatchObject({ name: "dark", requested: "everforest-dark" });
  });

  it("falls back on config it cannot parse as TOML at all", () => {
    expect(resolveTheme(world("\u0000not toml [[[\n")).name).toBe("light");
  });

  it("looks under $HOME when XDG_CONFIG_HOME is unset", () => {
    expect(herdrConfigPath({ HOME: "/home/someone" })).toBe("/home/someone/.config/herdr/config.toml");
    expect(herdrConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/herdr/config.toml");
  });
});

// ── palettes ──────────────────────────────────────────────────────────────────────────────────

const srgb = (channel: number): number => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
}

/** WCAG contrast ratio between two colors, 1 (identical) … 21 (black on white). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The floor each role has to clear against its palette's `bg`, by what the role is used for:
 *  AA (4.5) for anything that carries readable text, AA-large (3.0) for the secondary label level,
 *  and a visibility floor for the two roles that are never text (`faint` hints and `border`). */
const FLOORS: Partial<Record<keyof Palette, number>> = {
  fg: 4.5,
  emphasis: 4.5,
  success: 4.5,
  warning: 4.5,
  danger: 4.5,
  info: 4.5,
  comment: 3,
  faint: 2,
  border: 1.5,
};

describe("palettes", () => {
  // `light` is exempt from the AA floor: it is the palette the TUI has shipped since day one, pinned
  // byte-for-byte by the test below because "no herdr theme renders exactly as before" is part of
  // the feature. Its `danger` measures 4.43 — a rounding away, and not ours to change here.
  const measured = THEME_NAMES.filter((n) => n !== "light");

  it.each(measured)("%s holds its contrast floors", (name) => {
    const palette = paletteFor(name);
    const failures = Object.entries(FLOORS)
      .filter(([role, floor]) => contrast(palette[role as keyof Palette], palette.bg) < floor!)
      .map(([role, floor]) => `${role} ${palette[role as keyof Palette]} on ${palette.bg} = ${contrast(palette[role as keyof Palette], palette.bg).toFixed(2)} (needs ${floor})`);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it.each(THEME_NAMES)("%s names every role, as a #rrggbb hex", (name) => {
    const palette = paletteFor(name);
    const roles: (keyof Palette)[] = ["bg", "fg", "line", "tint", "border", "comment", "faint", "emphasis", "success", "warning", "danger", "info"];
    for (const role of roles) expect(palette[role], `${name}.${role}`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("ships a palette for every herdr built-in theme name", () => {
    // herdr's own config template lists these; a new herdr theme should land here rather than in the
    // dark/light fallback.
    for (const name of ["catppuccin", "terminal", "tokyo-night", "dracula", "nord", "gruvbox", "one-dark", "solarized", "kanagawa", "rose-pine", "vesper"]) {
      expect(THEME_NAMES, `herdr built-in ${name}`).toContain(name);
    }
    // …and for the light counterparts herdr's `light_name` points at.
    for (const name of ["catppuccin-latte", "tokyo-night-day", "gruvbox-light", "one-light", "solarized-light", "kanagawa-lotus", "rose-pine-dawn"]) {
      expect(THEME_NAMES, `herdr light variant ${name}`).toContain(name);
    }
  });

  it("renders the light palette exactly as it did before the TUI followed herdr", () => {
    expect(paletteFor("light")).toEqual({
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
    });
    expect(buildTheme(paletteFor("light"))).toMatchObject({
      bg: "#f7f7f7",
      barBg: "#e2eeee",
      barFocusBg: "#dbe3f2",
      hoverBg: "#e2eeee",
      border: { active: "#325cc0", inactive: "#9e9e9e" },
      text: { primary: "#000000", secondary: "#787878", tertiary: "#a9a9a9" },
      focusText: { focused: "#325cc0", unfocused: "#787878" },
      selection: { bg: "#e2eeee", fg: "#325cc0" },
      input: { bg: "#e2eeee", fg: "#000000", placeholder: "#a9a9a9", focusBg: "#dbe3f2", focusFg: "#000000", error: "#d13e23" },
      status: { good: "#3e8024", warn: "#a16400", bad: "#d13e23", info: "#0075c4" },
      accent: "#325cc0",
    });
  });

  it("builds the same token set from every palette", () => {
    const shape = (name: string) => JSON.stringify(buildTheme(paletteFor(name)), (_k, v) => (typeof v === "string" ? 0 : v));
    for (const name of THEME_NAMES) expect(shape(name), name).toBe(shape("light"));
  });
});
