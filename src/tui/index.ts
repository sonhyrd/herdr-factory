// herdr-factory TUI — entry point. Boots the opentui renderer and lays out a top-level tabbed
// shell (lazygit-style navigation): Tab/Shift+Tab switch top tabs; number keys jump to a numbered
// section within the active tab; arrows navigate inside the focused section; Esc pops to the top
// level (the tab bar). Runs on Node >= 26 with --experimental-ffi (see bin/herdr-factory-tui).
// Imperative opentui core API — no JSX.
import { BoxRenderable, InputRenderable, ScrollBoxRenderable, StyledText, TextareaRenderable, bold, createCliRenderer, fg, type CliRenderer, type Renderable, type TextChunk } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { BORDER, theme } from "./theme.ts";
import { SELECTION, hoverable, input as makeInput, text } from "./render.ts";
import type { TabView } from "./types.ts";
import { createDashboard } from "./dashboard.ts";

const TAB_WIDTH = 13;

function createLazyView(renderer: CliRenderer, sectionCount: number, load: () => Promise<TabView>): TabView {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", backgroundColor: theme.bg });
  const loading = text(renderer, { content: " loading...", fg: theme.text.secondary, height: 1, wrapMode: "none" });
  root.add(loading);
  let view: TabView | null = null;
  let loadingView: Promise<void> | null = null;
  let active = false;

  function ensureLoaded(): void {
    if (view || loadingView) return;
    loadingView = load().then((loaded) => {
      view = loaded;
      root.remove(loading.id);
      loading.destroy();
      root.add(loaded.root);
      if (active) {
        loaded.activate();
        loaded.restoreFocus();
      }
    }).catch((error) => {
      loading.content = ` failed to load: ${error instanceof Error ? error.message : String(error)}`;
      loading.fg = theme.status.bad;
    });
  }

  return {
    root,
    sectionCount,
    focusSection(n) {
      if (view) view.focusSection(n);
    },
    restoreFocus() {
      if (view) view.restoreFocus();
      else loading.focus();
    },
    activate() {
      active = true;
      if (view) view.activate();
      else ensureLoaded();
    },
    deactivate() {
      active = false;
      view?.deactivate();
    },
    save() {
      view?.save?.();
    },
    editMove(dir) {
      view?.editMove?.(dir);
    },
  };
}

/** Build the tabbed shell on an existing renderer (split out from bootstrap so it can be driven in
 *  tests). Returns a few inspection getters. */
export function createApp(renderer: CliRenderer): { currentTab: () => number; atTop: () => boolean; views: TabView[] } {
  const root = renderer.root;

  // ── chrome ────────────────────────────────────────────────────────────────────────────────
  const header = text(renderer, {
    content: " herdr-factory · factory control",
    fg: theme.accent,
    bg: theme.barBg,
    height: 1,
    wrapMode: "none",
  });
  // The tab bar doubles as the "top level" focus target (reached with Esc). It's a plain focusable
  // row of tab cells (rather than a TabSelect) so each tab can carry its own click + hover handlers:
  // hovering a tab tints it, clicking switches to it. Selection- and focus-state colors are painted
  // by paintTabs(); the shell keys off `focused === tabBar` for the top level, which still holds since
  // the box is focusable.
  const TAB_NAMES = ["Dashboard", "Config", "Doctor"];
  const tabLabel = (name: string) => {
    const pad = Math.max(0, TAB_WIDTH - name.length);
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + name + " ".repeat(pad - left);
  };
  const tabBar = new BoxRenderable(renderer, { height: 1, flexDirection: "row", flexShrink: 0, backgroundColor: theme.barBg, focusable: true });
  let hoveredTab = -1;
  const tabCells = TAB_NAMES.map((name, i) => {
    const cell = text(renderer, { content: tabLabel(name), width: TAB_WIDTH, height: 1, wrapMode: "none", bg: theme.barBg, fg: theme.focusText.unfocused });
    cell.onMouseDown = (e) => { showTab(i); e.stopPropagation(); };
    cell.onMouseOver = () => { hoveredTab = i; paintTabs(); };
    cell.onMouseOut = () => { if (hoveredTab === i) { hoveredTab = -1; paintTabs(); } };
    tabBar.add(cell);
    return cell;
  });
  /** Color each tab from its state: the current tab is accent (or barFocusBg when the bar itself holds
   *  the top-level focus); a hovered non-current tab gets the subtle hover tint; the rest are muted. */
  function paintTabs(): void {
    const focused = renderer.currentFocusedRenderable === tabBar;
    tabCells.forEach((cell, i) => {
      if (i === current) {
        cell.bg = focused ? theme.barFocusBg : theme.accent;
        cell.fg = focused ? theme.text.primary : theme.bg;
      } else if (i === hoveredTab) {
        cell.bg = theme.hoverBg;
        cell.fg = theme.text.primary;
      } else {
        cell.bg = theme.barBg;
        cell.fg = theme.focusText.unfocused;
      }
    });
  }
  const content = new BoxRenderable(renderer, { flexGrow: 1, width: "100%", backgroundColor: theme.bg });
  const footer = text(renderer, { content: "", fg: theme.text.tertiary, bg: theme.barBg, height: 1, wrapMode: "none" });

  root.add(header);
  root.add(tabBar);
  root.add(content);
  root.add(footer);

  // ── modal ─────────────────────────────────────────────────────────────────────────────────
  // A full-screen overlay (absolute, high zIndex) for confirmations and choice pickers. While it's
  // open the keypress handler routes only its keys, so nothing else in the shell fires.
  const overlay = new BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    visible: false,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: theme.bg,
  });
  const card = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.active,
    backgroundColor: theme.bg,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
  });
  const modalTitle = text(renderer, { content: "", fg: theme.text.primary, height: 1, wrapMode: "none" });
  const modalBody = new BoxRenderable(renderer, { flexDirection: "column", backgroundColor: theme.bg });
  card.add(modalTitle);
  card.add(text(renderer, { content: "", height: 1 }));
  card.add(modalBody);
  overlay.add(card);

  // Large scrollable panel for read-only info (e.g. a ticket timeline).
  const infoCard = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "80%",
    height: "70%",
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.active,
    backgroundColor: theme.bg,
    paddingLeft: 1,
    paddingRight: 1,
    visible: false,
  });
  const infoTitle = text(renderer, { content: "", fg: theme.accent, height: 1, wrapMode: "none" });
  const infoScroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, width: "100%", scrollY: true, backgroundColor: theme.bg });
  const infoHint = text(renderer, { content: "↑↓ / wheel scroll · Esc close", fg: theme.text.tertiary, height: 1, wrapMode: "none" });
  infoCard.add(infoTitle);
  infoCard.add(infoScroll);
  infoCard.add(infoHint);
  overlay.add(infoCard);
  root.add(overlay);

  type ModalState =
    | { kind: "confirm"; resolve: (v: boolean) => void }
    | { kind: "choose"; options: { label: string; value: string }[]; index: number; resolve: (v: string | null) => void }
    | { kind: "prompt"; input: InputRenderable; prev: Renderable | null; resolve: (v: string | null) => void }
    | { kind: "edit"; area: TextareaRenderable; prev: Renderable | null; resolve: (v: string | null) => void }
    | { kind: "info"; id: number };
  let modal: ModalState | null = null;
  let nextInfoId = 1;

  function renderModalBody(): void {
    // A prompt / edit modal owns its own body (a live Input / Textarea) — don't tear it down on re-render.
    if (modal?.kind === "prompt" || modal?.kind === "edit") return;
    for (const c of [...modalBody.getChildren()]) {
      modalBody.remove(c.id);
      c.destroy();
    }
    if (!modal || modal.kind === "info") return; // info renders into infoScroll, not modalBody
    if (modal.kind === "confirm") {
      // "yes" is red to underscore that it's the destructive choice. Both are clickable.
      const row = new BoxRenderable(renderer, { flexDirection: "row", height: 1, backgroundColor: theme.bg });
      const yes = text(renderer, { content: "[y] yes", fg: theme.status.bad, height: 1, wrapMode: "none" });
      yes.onMouseDown = (e) => { const m = modal; if (m?.kind === "confirm") { closeModal(); m.resolve(true); } e.stopPropagation(); };
      hoverable(yes);
      const no = text(renderer, { content: "      [n / Esc] no", fg: theme.text.tertiary, height: 1, wrapMode: "none" });
      no.onMouseDown = (e) => { const m = modal; if (m?.kind === "confirm") { closeModal(); m.resolve(false); } e.stopPropagation(); };
      hoverable(no);
      row.add(yes);
      row.add(no);
      modalBody.add(row);
      return;
    }
    modal.options.forEach((o, i) => {
      const on = i === (modal as { index: number }).index;
      const opt = text(renderer, { content: (on ? "▶ " : "  ") + o.label, fg: on ? theme.accent : theme.text.primary, height: 1, wrapMode: "none" });
      // Click an option to pick it outright (no separate confirm step — clicking is the confirm).
      opt.onMouseDown = (e) => { const m = modal; if (m?.kind === "choose") { closeModal(); m.resolve(o.value); } e.stopPropagation(); };
      hoverable(opt);
      modalBody.add(opt);
    });
    modalBody.add(text(renderer, { content: "", height: 1 }));
    modalBody.add(text(renderer, { content: "↑↓ choose · ↵ / click select · Esc cancel", fg: theme.text.tertiary, height: 1, wrapMode: "none" }));
  }

  function confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      modalTitle.content = message;
      modal = { kind: "confirm", resolve };
      renderModalBody();
      card.visible = true;
      infoCard.visible = false;
      overlay.visible = true;
    });
  }
  function choose(title: string, options: { label: string; value: string }[]): Promise<string | null> {
    return new Promise((resolve) => {
      modalTitle.content = title;
      modal = { kind: "choose", options, index: 0, resolve };
      renderModalBody();
      card.visible = true;
      infoCard.visible = false;
      overlay.visible = true;
    });
  }
  function renderInfo(title: string, lines: string[]): void {
    infoTitle.content = title;
    for (const c of [...infoScroll.getChildren()]) {
      infoScroll.remove(c.id);
      c.destroy();
    }
    const rendered = lines.length ? lines : ["(no events)"];
    // Info content is read-only reference (a timeline, diagnostics) — keep it selectable so it can be
    // copied, but with readable selection colors (opentui's default highlight is near-black).
    for (const l of rendered) infoScroll.add(text(renderer, { content: l, fg: theme.text.primary, width: "100%", height: 1, wrapMode: "none", selectable: true, ...SELECTION }));
    infoScroll.scrollTop = 0;
  }
  function showInfo(title: string, lines: string[]) {
    const id = nextInfoId++;
    renderInfo(title, lines);
    modal = { kind: "info", id };
    card.visible = false;
    infoCard.visible = true;
    overlay.visible = true;
    return {
      update(nextTitle: string, nextLines: string[]) {
        if (modal?.kind === "info" && modal.id === id) renderInfo(nextTitle, nextLines);
      },
    };
  }
  /** A single-line text prompt. Focuses a live input; typed keys
   *  fall through to it (the keypress handler only intercepts Enter/Esc for a prompt modal). */
  function prompt(title: string, placeholder = ""): Promise<string | null> {
    return new Promise((resolve) => {
      for (const c of [...modalBody.getChildren()]) {
        modalBody.remove(c.id);
        c.destroy();
      }
      modalTitle.content = title;
      const input = makeInput(renderer, {
        value: "",
        placeholder,
        width: 72,
        backgroundColor: theme.input.bg,
        focusedBackgroundColor: theme.input.focusBg,
        textColor: theme.input.fg,
        focusedTextColor: theme.input.focusFg,
        placeholderColor: theme.input.placeholder,
      });
      modalBody.add(input);
      modalBody.add(text(renderer, { content: "↵ submit · Esc cancel", fg: theme.text.tertiary, height: 1, wrapMode: "none" }));
      const prev = renderer.currentFocusedRenderable ?? null;
      modal = { kind: "prompt", input, prev, resolve };
      card.visible = true;
      infoCard.visible = false;
      overlay.visible = true;
      input.focus();
    });
  }
  /** A multiline text editor over a whole file's contents (e.g. guidelines-prompt.md). ^S resolves
   *  the edited text; Esc cancels (null). Like `prompt`, it focuses a live editor and lets typed keys
   *  fall through — the keypress handler only intercepts ^S/Esc for an edit modal. */
  function editText(title: string, initial: string, hint = "^S save · Esc cancel"): Promise<string | null> {
    return new Promise((resolve) => {
      for (const c of [...modalBody.getChildren()]) {
        modalBody.remove(c.id);
        c.destroy();
      }
      modalTitle.content = title;
      const area = new TextareaRenderable(renderer, {
        initialValue: initial,
        width: 76,
        height: 16,
        wrapMode: "word",
        backgroundColor: theme.input.bg,
        focusedBackgroundColor: theme.input.focusBg,
        textColor: theme.input.fg,
        focusedTextColor: theme.input.focusFg,
        ...SELECTION,
      });
      modalBody.add(area);
      modalBody.add(text(renderer, { content: hint, fg: theme.text.tertiary, height: 1, wrapMode: "none" }));
      const prev = renderer.currentFocusedRenderable ?? null;
      modal = { kind: "edit", area, prev, resolve };
      card.visible = true;
      infoCard.visible = false;
      overlay.visible = true;
      area.focus();
    });
  }
  function closeModal(): void {
    // A prompt / edit modal focused a live editor; restore focus to wherever it was so shell
    // navigation keeps working.
    if (modal?.kind === "prompt" || modal?.kind === "edit") modal.prev?.focus?.();
    overlay.visible = false;
    modal = null;
  }
  /** Dismiss the open modal as if Esc were pressed (used by a backdrop click). */
  function cancelModal(): void {
    const m = modal;
    if (!m) return;
    if (m.kind === "confirm") { closeModal(); m.resolve(false); }
    else if (m.kind === "choose") { closeModal(); m.resolve(null); }
    else if (m.kind === "prompt" || m.kind === "edit") { closeModal(); m.resolve(null); }
    else closeModal();
  }
  // Click the dimmed backdrop (not the card) to dismiss — a familiar modal gesture.
  overlay.onMouseDown = (e) => { if (e.target === overlay) cancelModal(); };

  // ── views ─────────────────────────────────────────────────────────────────────────────────
  const views: TabView[] = [
    createDashboard(renderer, { confirm, choose, showInfo, prompt }),
    createLazyView(renderer, 5, async () => {
      const { createConfigEditor } = await import("./config-editor.ts");
      return createConfigEditor(renderer, { confirm, choose, prompt, editText });
    }),
    createLazyView(renderer, 1, async () => {
      const { createDoctor } = await import("./doctor.ts");
      return createDoctor(renderer);
    }),
  ];
  let current = -1;
  // Per-tab focus memory (session): whether each tab was last left at the top level (tab bar). The
  // within-tab section + field is remembered by each view (restoreFocus). Together these restore
  // your place when switching tabs.
  const leftAtTop: boolean[] = views.map(() => false);

  // Footer keymap, lazygit-style: muted action labels with the emphasized key that triggers them
  // (`Label: key`), pairs divided by a dim bar. Section jumps read as bracketed, accented numbers
  // (`[1] repos`) so it's clear which digit hops where. Everything is one styled line.
  const sep = () => fg(theme.text.tertiary)("  |  ");
  const groupSep = () => fg(theme.text.tertiary)("   ·   ");
  const nav = (n: number, label: string): TextChunk[] => [fg(theme.accent)(bold(`[${n}]`)), fg(theme.text.secondary)(` ${label}`)];
  const keys = (pairs: [label: string, key: string][]): TextChunk[] =>
    pairs.flatMap(([label, key], i) => [...(i ? [sep()] : []), fg(theme.text.secondary)(`${label}: `), fg(theme.accent)(bold(key))]);

  function footerHints(idx: number): StyledText {
    const tail = [groupSep(), ...keys([["switch view", "Tab"], ["top level", "Esc"], ["quit", "q"]])];
    if (idx === 1) {
      const sections = [nav(1, "repos"), nav(2, "config"), nav(3, "sources"), nav(4, "layouts"), nav(5, "belts")]
        .flatMap((chunks, i) => (i ? [fg(theme.text.tertiary)("  "), ...chunks] : chunks));
      return new StyledText([fg(theme.text.tertiary)(" "), ...sections, groupSep(), ...keys([["move", "↑↓"], ["open/edit", "↵"], ["reorder", "[ ]"]]), ...tail]);
    }
    if (idx === 2) {
      return new StyledText([fg(theme.text.tertiary)(" "), ...keys([["scroll", "↑↓"], ["re-run", "r"], ["deep check", "d"]]), ...tail]);
    }
    return new StyledText([
      fg(theme.text.tertiary)(" "),
      ...keys([["move", "↑↓"], ["column", "←→"], ["timeline", "↵"], ["tick", "t"], ["claim", "c"], ["resume/retry", "s"], ["teardown", "x"], ["detail", "d"], ["refresh", "r"]]),
      ...tail,
    ]);
  }

  /** Top of the hierarchy: focus the tab bar. From here numbers enter a section, ←→/Tab switch. */
  function focusTop(): void {
    tabBar.focus();
  }

  function showTab(idx: number): void {
    if (idx === current) return;
    const view = views[idx];
    if (!view) return;
    if (current >= 0) {
      leftAtTop[current] = renderer.currentFocusedRenderable === tabBar;
      views[current]!.deactivate();
      content.remove(views[current]!.root.id);
    }
    current = idx;
    paintTabs();
    content.add(view.root);
    view.activate();
    footer.content = footerHints(idx);
    // Restore where this tab was left: the top level, or its remembered section.
    if (leftAtTop[idx]) focusTop();
    else view.restoreFocus();
  }

  function switchTab(dir: -1 | 1): void {
    showTab((current + dir + views.length) % views.length);
  }

  let exiting = false;
  function shutdown(): void {
    if (exiting) return;
    exiting = true;
    for (const v of views) v.deactivate();
    try {
      renderer.destroy();
    } catch {
      /* already tearing down */
    }
    process.exit(0);
  }
  // Covers Ctrl-C (exitOnCtrlC destroys the renderer) so our poll timers don't keep Node alive.
  renderer.on("destroy", shutdown);
  // Repaint the tab bar whenever focus moves, so the current tab reflects whether the bar itself holds
  // the top-level focus (barFocusBg) or a view does (accent).
  renderer.on("focused_renderable", () => paintTabs());

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // A modal is open: capture only its keys; everything else is swallowed.
    if (modal) {
      if (modal.kind === "confirm") {
        if (key.name === "y" || key.name === "return" || key.name === "enter") { const m = modal; closeModal(); m.resolve(true); }
        else if (key.name === "n" || key.name === "escape") { const m = modal; closeModal(); m.resolve(false); }
      } else if (modal.kind === "choose") {
        const n = modal.options.length;
        if (key.name === "up") { modal.index = (modal.index - 1 + n) % n; renderModalBody(); }
        else if (key.name === "down") { modal.index = (modal.index + 1) % n; renderModalBody(); }
        else if (key.name === "return" || key.name === "enter") { const m = modal; const v = m.options[m.index]?.value ?? null; closeModal(); m.resolve(v); }
        else if (key.name === "escape") { const m = modal; closeModal(); m.resolve(null); }
      } else if (modal.kind === "prompt") {
        if (key.name === "return" || key.name === "enter") { const m = modal; const v = m.input.value.trim(); closeModal(); m.resolve(v || null); }
        else if (key.name === "escape") { const m = modal; closeModal(); m.resolve(null); }
        else return; // typing → don't preventDefault, so the focused input captures the key
      } else if (modal.kind === "edit") {
        // ^S saves the buffer, Esc cancels; everything else (incl. Enter=newline) is the textarea's.
        if (key.ctrl && key.name === "s") { const m = modal; const v = m.area.plainText; closeModal(); m.resolve(v); }
        else if (key.name === "escape") { const m = modal; closeModal(); m.resolve(null); }
        else return; // fall through to the focused textarea
      } else {
        // info (scrollable, read-only)
        if (key.name === "up") infoScroll.scrollTop = Math.max(0, infoScroll.scrollTop - 1);
        else if (key.name === "down") infoScroll.scrollTop = infoScroll.scrollTop + 1;
        else if (key.name === "escape" || key.name === "q") closeModal();
      }
      key.preventDefault();
      return;
    }

    const view = views[current];
    const focused = renderer.currentFocusedRenderable;
    const editing = focused instanceof InputRenderable;
    const atTop = focused === tabBar;

    // Global handlers run before the focused widget and can preventDefault to consume a key.
    if (key.ctrl && key.name === "s") {
      view?.save?.();
      key.preventDefault();
      return;
    }
    // Esc pops to the top level from any depth (editing a field, or in a section).
    if (key.name === "escape") {
      focusTop();
      key.preventDefault();
      return;
    }
    if (key.name === "tab" || key.name === "backtab") {
      switchTab(key.shift ? -1 : 1);
      key.preventDefault();
      return;
    }

    // Editing a text field: keys belong to the input, except ↑/↓ (hop between fields). Digits,
    // letters, ←/→ cursor, backspace, Enter (→ next field) all fall through to it.
    if (editing) {
      if (key.name === "up") {
        view?.editMove?.(-1);
        key.preventDefault();
      } else if (key.name === "down") {
        view?.editMove?.(1);
        key.preventDefault();
      }
      return;
    }

    // Top level or a section: quit / number-jump work at both.
    if (key.name === "q") {
      shutdown();
      key.preventDefault();
      return;
    }
    if (key.name && /^[1-9]$/.test(key.name)) {
      view?.focusSection(Number(key.name));
      key.preventDefault();
      return;
    }

    // At the top level, ←→ switch tabs and Enter dives into the first section.
    if (atTop) {
      if (key.name === "left") switchTab(-1);
      else if (key.name === "right") switchTab(1);
      else if (key.name === "return" || key.name === "enter") view?.focusSection(1);
      else return;
      key.preventDefault();
      return;
    }
    // In a section: arrows / Enter fall through to the focused section widget.
  });

  showTab(0);

  return {
    currentTab: () => current,
    atTop: () => renderer.currentFocusedRenderable === tabBar,
    views,
  };
}

export async function main(mark: (name: string) => void = () => {}): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: true,
    enableMouseMovement: true, // needed for hover (onMouseOver/onMouseOut) — see hoverable()
    backgroundColor: theme.bg, // light canvas (lighter palette)
  });
  // Mouse pointer shape: a hand pointer everywhere (the whole UI is click-to-navigate), swapping to
  // the text I-beam only while a text input holds focus. opentui never changes the pointer on its
  // own, so we drive it off the focused-editor event (InputRenderable is an editor).
  renderer.setMousePointer("pointer");
  renderer.on("focused_editor", (current) => renderer.setMousePointer(current ? "text" : "pointer"));
  mark("renderer_ready");
  createApp(renderer);
  mark("app_ready");
}

// Only auto-run as the entry point (not when imported by a test harness).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
