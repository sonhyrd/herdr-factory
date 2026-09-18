// Config tab — five numbered sections. [1] a repo list on the left; on the right, four bordered
// panels stacked in rows, each an editor over one slice of the selected repo's config.yml: [2] the
// singleton blocks (repo · limits · secrets · evidence), [3] work_sources, [4] layouts, [5] belts.
// The four right-hand panels are an ACCORDION — collapsed by default, and moving to one (number keys
// 2/3/4/5, a click, or ↵ from the repo list) expands it and collapses the others, so only one is
// open at a time and a long config stays scannable. Each panel renders a flat, browsable list of rows
// built from a live `yaml` Document (config-fields.ts): array-of-object items (work_sources, layouts,
// belts, tabs, panes, steps)
// are collapsible `group` rows, and text fields / cyclable enums / bool toggles / source refs /
// add-remove actions fill in when a group is expanded. Navigation follows the shell's lazygit model
// (↑↓ move within the focused panel, Esc → top). Structural edits mutate the Document surgically so
// comments + the schema modeline are preserved; save validates the whole config against
// RepoConfigSchema before writing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable, StyledText, TextRenderable, bold, fg, type CliRenderer } from "@opentui/core";
import type { KeyEvent, Renderable } from "@opentui/core";
import { hoverable, input as makeInput, text } from "./render.ts";
import { parseDocument, type Document } from "yaml";
import { RepoConfigSchema, listConfiguredRepos, loadEnvMap, repoConfigDir, saveEnvValues } from "../config.ts";
import { SOURCE_DESCRIPTORS } from "../sources/registry.ts";
import { initRepo } from "../init.ts";
import type { SourceType } from "../types.ts";
import { postReload } from "./api.ts";
import { applyBeltChangesForRepo } from "../belt-apply.ts";
import { diffBelts } from "../core/belt-admin.ts";
import { buildDescriptors, type FieldCtx, type FieldDesc } from "./config-fields.ts";
import { BORDER, theme } from "./theme.ts";
import type { EditorModals, TabView } from "./types.ts";

const LABEL_WIDTH = 28;
const IND = (n?: number) => "  ".repeat(n ?? 0);
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// A section heading for a bordered panel: bracketed jump number + the label, sentence-cased.
const sectionTitle = (n: number, label: string) => ` [${n}] ${sentenceCase(label)} `;
const gut = (on: boolean) => (on ? "▶ " : "  ");
const COLLAPSED_HEIGHT = 3; // border top + one summary line + border bottom

interface RowRef {
  desc: FieldDesc;
  container: Renderable;
  input?: InputRenderable;
  setHighlighted: (on: boolean) => void;
}

/** A rename a flush turned up (a layout id / tab / pane title whose typed value differs from the
 *  draft's): run it to repoint every belt/step reference and get back a status line (null = nothing
 *  referenced the old name). Flushes COLLECT these and the editor runs them once every panel has
 *  committed its text — running one mid-flush would let a not-yet-flushed row holding the OLD name
 *  write it straight back over the propagation. */
type PendingRename = () => string | null;

/** Shared state + callbacks the editor hands to each accordion panel. The panels own their own row
 *  list and highlight; everything below is common (one draft, one env map, one collapse WeakSet). */
interface PanelCtx {
  renderer: CliRenderer;
  getDraft: () => Document | null;
  expandedNodes: WeakSet<object>;
  secretGet: (envKey: string) => string;
  secretSet: (envKey: string, v: string) => void;
  /** Commit every panel's typed edits into the draft/env before a structural rebuild. */
  flushAll: () => void;
  /** Run the renames a panel-local flush collected (repoint references + rebuild + report). */
  propagateRenames: (pending: PendingRename[]) => void;
  markUnsaved: () => void;
  setStatus: (content: string, fg: string) => void;
  /** Make section `n` the active + sole-expanded panel (used by mouse clicks). */
  focusSection: (n: number) => void;
}

interface FieldPanel {
  section: number;
  outer: BoxRenderable;
  /** Rebuild rows from the current draft, preserving the highlighted index. */
  render: () => void;
  /** Commit this panel's typed edits; returns the renames they imply for the caller to propagate. */
  flushInputs: () => PendingRename[];
  /** Focus this panel's scroll and re-apply its highlight. */
  focusInto: () => void;
  setExpanded: (on: boolean) => void;
  setActive: (on: boolean) => void;
  /** Move the highlight while editing a text field (↑/↓ from the shell). */
  editMove: (dir: -1 | 1) => void;
  showMessage: (text: string, fg: string) => void;
  clearErrors: () => void;
  addError: (text: string) => void;
  hasRows: () => boolean;
}

/** One accordion panel: a bordered box holding a scrollable field list plus a one-line summary
 *  shown when it's collapsed. All navigation/editing state (focusRows, browseIndex) is local; the
 *  draft it reads and the flush/rebuild it triggers are shared through `ctx`. */
function createFieldPanel(
  section: number,
  title: string,
  buildDescs: () => FieldDesc[],
  summaryFn: () => string,
  ctx: PanelCtx,
): FieldPanel {
  const { renderer } = ctx;
  const outer = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    flexGrow: 0,
    flexShrink: 0,
    height: COLLAPSED_HEIGHT,
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    title,
    titleColor: theme.focusText.unfocused,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0, // allow the scroll to be smaller than its content (clip + scroll, don't grow the box)
    width: "100%",
    scrollY: true,
    backgroundColor: theme.bg,
    visible: false, // collapsed by default
  });
  const summary = text(renderer, { content: "", height: 1, wrapMode: "none", fg: theme.text.tertiary });
  outer.add(scroll);
  outer.add(summary);

  let focusRows: RowRef[] = [];
  let browseIndex = 0;
  let errorNodes: Renderable[] = [];
  let currentDraft: Document | null = null;

  function clearScroll(): void {
    for (const c of [...scroll.getChildren()]) {
      scroll.remove(c.id);
      c.destroy();
    }
  }

  function textLine(content: string, fg: string): TextRenderable {
    return text(renderer, { content, fg, width: "100%", height: 1, wrapMode: "none" });
  }

  // Render one descriptor into the scroll; returns a RowRef for focusable ones, null for headers.
  function renderDescriptor(d: FieldDesc): RowRef | null {
    if (d.kind === "header") {
      // Level-1 headers are section headings: bold + sentence-cased. Level-2 stay muted secondary text.
      const content = d.level === 1
        ? new StyledText([fg(theme.accent)(bold(IND(d.indent) + sentenceCase(d.label)))])
        : IND(d.indent) + d.label;
      scroll.add(text(renderer, { content, fg: theme.text.secondary, width: "100%", height: 1, wrapMode: "none" }));
      return null;
    }
    if (d.kind === "group") {
      const body = () => `${IND(d.indent)}${d.expanded ? "▾" : "▸"} ${d.label}`;
      const t = text(renderer, { content: gut(false) + body(), fg: theme.text.primary, width: "100%", height: 1, wrapMode: "none" });
      scroll.add(t);
      return { desc: d, container: t, setHighlighted: (on) => { t.content = gut(on) + body(); t.fg = on ? theme.focusText.focused : theme.text.primary; } };
    }
    if (d.kind === "action") {
      const t = text(renderer, { content: gut(false) + IND(d.indent) + d.label, fg: theme.accent, width: "100%", height: 1, wrapMode: "none" });
      scroll.add(t);
      return { desc: d, container: t, setHighlighted: (on) => { t.content = gut(on) + IND(d.indent) + d.label; t.fg = on ? theme.focusText.focused : theme.accent; } };
    }

    const container = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", height: 1, backgroundColor: theme.bg });
    const labelText = IND(d.indent) + d.label.padEnd(LABEL_WIDTH);
    const labelW = 2 + (d.indent ?? 0) * 2 + LABEL_WIDTH + 1;
    const label = text(renderer, { content: gut(false) + labelText, fg: theme.text.secondary, width: labelW, height: 1, wrapMode: "none" });
    container.add(label);

    if (d.kind === "text") {
      let initial = "";
      let placeholder = d.placeholder ?? "";
      if (d.env) {
        // env-backed credential: token is replace-only (never render the stored value).
        if (d.masked) placeholder = ctx.secretGet(d.env) ? "•••••••• (set — type to replace)" : "not set";
        else initial = ctx.secretGet(d.env);
      } else {
        const v = currentDraft?.getIn(d.path!);
        initial = v == null ? "" : String(v);
      }
      const input = makeInput(renderer, {
        value: initial,
        placeholder,
        flexGrow: 1,
        backgroundColor: theme.input.bg,
        focusedBackgroundColor: theme.input.focusBg,
        textColor: theme.input.fg,
        focusedTextColor: theme.input.focusFg,
        placeholderColor: theme.input.placeholder,
      });
      input.on("input", ctx.markUnsaved);
      input.on("enter", () => moveHighlight(browseIndex + 1, true));
      container.add(input);
      scroll.add(container);
      return {
        desc: d,
        container,
        input,
        setHighlighted: (on) => {
          label.content = gut(on) + labelText;
          label.fg = on ? theme.focusText.focused : theme.text.secondary;
          input.backgroundColor = on ? theme.input.focusBg : theme.input.bg;
        },
      };
    }

    // enum | ref | bool → a value chip
    const display = d.kind === "bool" ? (d.value ? "[x] on" : "[ ] off") : `‹ ${d.value} ›`;
    const val = text(renderer, { content: display, fg: theme.text.primary, flexGrow: 1, height: 1, wrapMode: "none" });
    container.add(val);
    scroll.add(container);
    return {
      desc: d,
      container,
      setHighlighted: (on) => {
        label.content = gut(on) + labelText;
        label.fg = on ? theme.focusText.focused : theme.text.secondary;
        val.fg = on ? theme.accent : theme.text.primary;
      },
    };
  }

  function render(): void {
    const keep = browseIndex;
    currentDraft = ctx.getDraft();
    clearScroll();
    focusRows = [];
    errorNodes = [];
    summary.content = summaryFn();
    if (!currentDraft) {
      browseIndex = 0;
      return;
    }
    for (const d of buildDescs()) {
      const rr = renderDescriptor(d);
      if (!rr) continue;
      focusRows.push(rr);
      const idx = focusRows.length - 1;
      // Mouse: a click focuses this panel + highlights the row. Cheap/reversible rows also act on that
      // first click (a group toggles expand/collapse; a text field enters edit). Mutating value rows
      // (enum/ref/bool/action) act only on a second click of the already-focused row, so a navigational
      // click can't accidentally cycle a value or run an action. `stopPropagation` keeps the panel's own
      // onMouseDown from re-focusing the scroll and stealing focus from an input we just entered.
      rr.container.onMouseDown = (e) => {
        const wasActive = scroll.focused;
        const wasHighlighted = idx === browseIndex;
        ctx.focusSection(section);
        setHighlight(idx);
        if (d.kind === "group") toggleGroup(d.node);
        else if (d.kind === "text") enterEdit(idx);
        else if (wasActive && wasHighlighted) activate(rr);
        e.stopPropagation();
      };
      hoverable(rr.container); // subtle tint on hover; layers under the active-row highlight
    }
    // Re-apply the highlight visually (no scroll/focus change — focusInto does that for the active panel).
    if (focusRows.length > 0) {
      browseIndex = Math.max(0, Math.min(keep, focusRows.length - 1));
      focusRows.forEach((r, i) => r.setHighlighted(i === browseIndex));
    } else {
      browseIndex = 0;
    }
  }

  function setHighlight(i: number): void {
    if (focusRows.length === 0) return;
    browseIndex = Math.max(0, Math.min(i, focusRows.length - 1));
    focusRows.forEach((r, idx) => r.setHighlighted(idx === browseIndex));
    scroll.scrollChildIntoView(focusRows[browseIndex]!.container.id);
  }

  /** Commit this panel's visible text fields into the draft (so nothing is lost on rebuild/save),
   *  returning the reference-repointing renames the new values imply (see PendingRename). */
  function flushInputs(): PendingRename[] {
    const draft = ctx.getDraft();
    if (!draft) return [];
    const renames: PendingRename[] = [];
    for (const r of focusRows) {
      if (r.desc.kind !== "text" || !r.input) continue;
      const d = r.desc;
      const raw = r.input.value;
      if (d.env) {
        // token (masked) is replace-only: blank keeps the existing one; email always applies.
        if (d.masked) { if (raw.trim() !== "") ctx.secretSet(d.env, raw.trim()); } else ctx.secretSet(d.env, raw.trim());
        continue;
      }
      const t = raw.trim();
      if (t === "") {
        // A `clearable` field blanked out ⇒ DELETE its key (the only in-place way to unset an
        // optional scalar). Others skip empties so a value can't be lost by tabbing through blank.
        if (d.clearable) draft.deleteIn(d.path!);
        continue;
      }
      const value = d.numeric && Number.isFinite(Number(t)) ? Number(t) : t;
      // A referenced NAME that actually changed (a layout id / tab / pane title): queue the
      // propagation. Deferred, not run here — see PendingRename.
      const from = String(draft.getIn(d.path!) ?? "");
      if (d.renameRefs && from !== "" && from !== String(value)) {
        const propagate = d.renameRefs;
        renames.push(() => propagate(from, String(value)));
      }
      draft.setIn(d.path!, value);
    }
    return renames;
  }

  // Expand/collapse a group. View-only (doesn't touch the config), so it flushes this panel's edits
  // and re-renders it without marking unsaved. Group nodes live in exactly one panel.
  function toggleGroup(node: object): void {
    ctx.propagateRenames(flushInputs());
    if (ctx.expandedNodes.has(node)) ctx.expandedNodes.delete(node);
    else ctx.expandedNodes.add(node);
    render();
    focusInto();
  }

  function enterEdit(i: number): void {
    setHighlight(i);
    const row = focusRows[browseIndex];
    if (row?.input) {
      row.input.focus();
      ctx.setStatus("editing — ↵ next · Esc: top · ^S save", theme.text.secondary);
    }
  }

  function moveHighlight(target: number, edit: boolean): void {
    // A rename here rebuilds every panel (focusRows is replaced), so re-read it below — never cache.
    ctx.propagateRenames(flushInputs());
    if (focusRows.length === 0) return;
    setHighlight(target);
    const row = focusRows[browseIndex];
    if (edit && row?.input) row.input.focus();
    else scroll.focus();
  }

  function cycle(desc: Extract<FieldDesc, { kind: "enum" | "ref" }>, dir: 1 | -1): void {
    ctx.flushAll(); // capture typed edits everywhere before the mutation shifts draft paths
    const cs = desc.choices;
    if (cs.length === 0) return;
    const i = cs.indexOf(desc.value);
    const next = i < 0 ? cs[0]! : cs[(i + dir + cs.length) % cs.length]!;
    desc.apply(next); // mutates draft → rebuildAll()
  }

  function activate(row: RowRef | undefined): void {
    if (!row) return;
    const d = row.desc;
    if (d.kind === "text") {
      enterEdit(browseIndex);
    } else if (d.kind === "enum" || d.kind === "ref") {
      cycle(d, 1);
    } else if (d.kind === "bool") {
      ctx.flushAll();
      d.apply(!d.value);
    } else if (d.kind === "action") {
      ctx.flushAll();
      d.run();
    } else if (d.kind === "group") {
      toggleGroup(d.node);
    }
  }

  // Browse-mode keys — only fire while this panel's scroll is focused.
  scroll.onKeyDown = (key: KeyEvent) => {
    if (focusRows.length === 0) return;
    const row = focusRows[browseIndex];
    const cyclable = !!row && (row.desc.kind === "enum" || row.desc.kind === "ref");
    const group = row && row.desc.kind === "group" ? row.desc : null;
    // Reorder a group within its array: Shift+↑/↓ or [ / ].
    if (group) {
      const up = (key.name === "up" && key.shift) || key.name === "[";
      const down = (key.name === "down" && key.shift) || key.name === "]";
      if (up || down) {
        ctx.flushAll();
        if (up) group.moveUp?.();
        else group.moveDown?.();
        key.preventDefault();
        return;
      }
    }
    switch (key.name) {
      case "up":
        moveHighlight(browseIndex - 1, false);
        key.preventDefault();
        break;
      case "down":
        moveHighlight(browseIndex + 1, false);
        key.preventDefault();
        break;
      case "return":
      case "enter":
        activate(row);
        key.preventDefault();
        break;
      case "space":
        if (row && (cyclable || row.desc.kind === "bool" || row.desc.kind === "group")) {
          activate(row);
          key.preventDefault();
        }
        break;
      case "left":
        if (cyclable) cycle(row!.desc as Extract<FieldDesc, { kind: "enum" | "ref" }>, -1);
        else if (group && ctx.expandedNodes.has(group.node)) toggleGroup(group.node);
        else break;
        key.preventDefault();
        break;
      case "right":
        if (cyclable) cycle(row!.desc as Extract<FieldDesc, { kind: "enum" | "ref" }>, 1);
        else if (group && !ctx.expandedNodes.has(group.node)) toggleGroup(group.node);
        else break;
        key.preventDefault();
        break;
    }
  };

  function focusInto(): void {
    scroll.focus();
    if (focusRows.length > 0) setHighlight(Math.min(browseIndex, focusRows.length - 1));
  }

  function setExpanded(on: boolean): void {
    scroll.visible = on;
    summary.visible = !on;
    if (on) {
      // Fill the space the collapsed panels + status line leave — NOT the content's height. A plain
      // Box sizes to its content, so with `flexBasis: 0` + `minHeight: 0` it grows from zero to the
      // available space instead of overflowing the viewport; the inner scroll clips the overflow.
      outer.flexGrow = 1;
      outer.flexShrink = 1;
      outer.flexBasis = 0;
      outer.minHeight = 0;
      outer.height = "auto";
    } else {
      // Fixed, non-shrinking title bar so every collapsed panel stays visible.
      outer.flexGrow = 0;
      outer.flexShrink = 0;
      outer.flexBasis = COLLAPSED_HEIGHT;
      outer.minHeight = COLLAPSED_HEIGHT;
      outer.height = COLLAPSED_HEIGHT;
    }
  }

  function setActive(on: boolean): void {
    outer.borderColor = on ? theme.border.active : theme.border.inactive;
    outer.titleColor = on ? theme.focusText.focused : theme.focusText.unfocused;
  }

  function showMessage(text: string, fg: string): void {
    currentDraft = null;
    clearScroll();
    focusRows = [];
    errorNodes = [];
    browseIndex = 0;
    scroll.add(textLine(text, fg));
  }

  function clearErrors(): void {
    for (const n of errorNodes) {
      scroll.remove(n.id);
      n.destroy();
    }
    errorNodes = [];
  }

  function addError(text: string): void {
    const node = textLine(text, theme.status.bad);
    scroll.add(node, errorNodes.length); // stack errors at the very top, in order
    errorNodes.push(node);
    scroll.scrollTop = 0;
  }

  outer.onMouseDown = () => ctx.focusSection(section);

  return {
    section,
    outer,
    render,
    flushInputs,
    focusInto,
    setExpanded,
    setActive,
    editMove: (dir) => moveHighlight(browseIndex + dir, true),
    showMessage,
    clearErrors,
    addError,
    hasRows: () => focusRows.length > 0,
  };
}

export function createConfigEditor(renderer: CliRenderer, modals: EditorModals): TabView {
  // The repo list is mutable — the "+ new repo" wizard scaffolds a repo and refreshes it in place.
  let repos = listConfiguredRepos();
  // A sentinel row that always heads the repo list (even with zero repos) so a fresh install has an
  // obvious way in; selecting it opens the add-repo wizard rather than loading a repo.
  const NEW_REPO = "+ new repo…";
  const repoOptions = () => [{ name: NEW_REPO, description: "" }, ...repos.map((r) => ({ name: r, description: "" }))];

  const root = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", height: "100%", backgroundColor: theme.bg });

  // ── section 1: repo list ────────────────────────────────────────────────────────────────────
  const repoPanel = new BoxRenderable(renderer, {
    width: 30,
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    // Named for the machine it edits: the dashboard spans the fleet, this tab does not. Config
    // lives on each host (`~/.config/herdr-factory/repos`), and editing another machine's from here
    // would be a write across a link the factory deliberately does not have.
    title: `${sectionTitle(1, "repos")}(this machine) `,
    titleColor: theme.focusText.unfocused,
  });
  const repoSelect = new SelectRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    options: repoOptions(),
    showDescription: false,
    itemSpacing: 0, // one screen row per option, so a click's row = (y − list top)
    backgroundColor: theme.bg,
    focusedBackgroundColor: theme.bg,
    textColor: theme.text.secondary,
    focusedTextColor: theme.text.primary,
    selectedBackgroundColor: theme.selection.bg,
    selectedTextColor: theme.selection.fg,
  });
  repoPanel.add(repoSelect);

  // ── sections 2/3/4/5: the accordion + status line ─────────────────────────────────────────────
  const rightCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, height: "100%", backgroundColor: theme.bg });
  const status = text(renderer, { content: "", height: 1, flexShrink: 0, wrapMode: "none", fg: theme.text.tertiary, paddingLeft: 1 });

  root.add(repoPanel);
  root.add(rightCol);

  // ── state ───────────────────────────────────────────────────────────────────────────────────
  let loadedRepo: string | null = null;
  let loadedText = "";
  let draft: Document | null = null;
  // Group-collapse view state, keyed by yaml node identity. Kept across repo loads: a re-parsed
  // document has fresh nodes, so nothing carries over (everything starts collapsed) and stale
  // entries are GC'd — no reset needed.
  const expandedNodes = new WeakSet<object>();
  // Per-repo credentials (separate `env` file). `envValues` is live (updated by flush);
  // `loadedEnv` is the on-disk snapshot, so save only writes when they differ. Which keys are
  // shown comes from the source descriptors' secrets manifests — not hardcoded per backend.
  let envValues: Record<string, string> = {};
  let loadedEnv: Record<string, string> = {};
  const secretGet = (envKey: string) => envValues[envKey] ?? "";
  const secretSet = (envKey: string, v: string) => { envValues[envKey] = v; };

  // Accordion + focus state. `expandedSection` is the sole open right-hand panel (null = all
  // collapsed, the default); `activeSection` is where focus is (1 = repo list).
  let expandedSection: number | null = null;
  let activeSection = 1;
  let lastSection = 1;

  function setStatus(content: string, fg: string): void {
    status.content = content;
    status.fg = fg;
  }
  const markUnsaved = () => setStatus("● unsaved changes — ^S to save", theme.status.warn);

  // The env-backed credential fields, shown at the top of panel [2]: every source type's manifest,
  // deduped by env key (a key two types share renders once).
  const secretDescriptors = (): FieldDesc[] => {
    const rows: FieldDesc[] = [{ kind: "header", label: "secrets (env)", level: 1 }];
    const seen = new Set<string>();
    for (const d of SOURCE_DESCRIPTORS) {
      for (const s of d.secrets) {
        if (seen.has(s.envKey)) continue;
        seen.add(s.envKey);
        rows.push({ kind: "text", label: s.envKey, env: s.envKey, masked: s.masked, placeholder: s.placeholder ?? (s.required ? undefined : "(optional)"), indent: 1 });
      }
    }
    return rows;
  };

  let panels: FieldPanel[] = [];
  const activePanel = () => panels.find((p) => p.section === activeSection);

  function flushAll(): void {
    const pending: PendingRename[] = [];
    for (const p of panels) pending.push(...p.flushInputs());
    propagateRenames(pending);
  }

  /** Repoint the references a rename left behind (a layout id / tab / pane title the belts point at),
   *  then re-render so the belts panel shows the new names, and say what moved. Runs only after every
   *  panel has flushed, so no stale row can write the old name back over the propagation. */
  function propagateRenames(pending: PendingRename[]): void {
    if (pending.length === 0) return;
    const moved = pending.map((r) => r()).filter((m): m is string => m != null);
    if (moved.length === 0) return; // renamed, but nothing referenced the old name
    rebuildAll();
    setStatus(`● ${moved.join(" · ")} — ^S to save`, theme.status.warn);
  }

  // Regenerate rows across ALL panels after a STRUCTURAL change (add/remove/type-switch/reorder) —
  // a work_source edit can change a belt's source-ref choices, so panels can't rebuild in isolation.
  // Callers flush BEFORE mutating the draft (see cycle/activate), so this must NOT flush again.
  function rebuildAll(): void {
    for (const p of panels) p.render();
    activePanel()?.focusInto();
    markUnsaved();
  }

  function summaryGeneral(): string {
    const p = (draft?.toJS() as any)?.repo?.path;
    return p ? `repo: ${p}` : "repo · limits · secrets · evidence";
  }
  function summarySources(): string {
    const arr = ((draft?.toJS() as any)?.work_sources ?? []) as any[];
    if (!Array.isArray(arr) || arr.length === 0) return "no work sources — ↵ to add";
    const names = arr.map((s, i) => String(s?.name ?? s?.type ?? `source${i}`));
    return `${arr.length} source${arr.length === 1 ? "" : "s"}: ${names.join(", ")}`;
  }
  function summaryLayouts(): string {
    const arr = ((draft?.toJS() as any)?.layouts ?? []) as any[];
    if (!Array.isArray(arr) || arr.length === 0) return "no layouts — ↵ to add (belts spawn their own panes)";
    const ids = arr.map((l, i) => String(l?.id ?? `layout${i}`));
    return `${arr.length} layout${arr.length === 1 ? "" : "s"}: ${ids.join(", ")}`;
  }
  function summaryBelts(): string {
    const arr = ((draft?.toJS() as any)?.belt ?? []) as any[];
    if (!Array.isArray(arr) || arr.length === 0) return "no belts — ↵ to add";
    const names = arr.map((b, i) => String(b?.name ?? `belt${i}`));
    return `${arr.length} belt${arr.length === 1 ? "" : "s"}: ${names.join(", ")}`;
  }

  const ctx: PanelCtx = {
    renderer,
    getDraft: () => draft,
    expandedNodes,
    secretGet,
    secretSet,
    flushAll,
    propagateRenames: (pending) => propagateRenames(pending),
    markUnsaved,
    setStatus,
    focusSection: (n) => focusSection(n),
  };

  // What the field builder needs beyond the draft: the modal helpers, the loaded repo's config dir
  // (so the referenced-file assist can resolve + check `config`-sourced prompt_file/match), and the
  // IO callbacks the editor owns (write a stub, open the guidelines buffer). Rebuilt per render so
  // `repoDir` always tracks the currently loaded repo.
  const fieldCtx = (): FieldCtx => ({
    confirm: modals.confirm,
    choose: modals.choose,
    repoDir: loadedRepo ? repoConfigDir(loadedRepo) : null,
    writeStub,
    editGuidelines,
  });

  panels = [
    createFieldPanel(2, sectionTitle(2, "config"), () => [...secretDescriptors(), ...buildDescriptors(draft!, rebuildAll, fieldCtx(), expandedNodes, "general")], summaryGeneral, ctx),
    createFieldPanel(3, sectionTitle(3, "work sources"), () => buildDescriptors(draft!, rebuildAll, fieldCtx(), expandedNodes, "work_sources"), summarySources, ctx),
    createFieldPanel(4, sectionTitle(4, "layouts"), () => buildDescriptors(draft!, rebuildAll, fieldCtx(), expandedNodes, "layouts"), summaryLayouts, ctx),
    createFieldPanel(5, sectionTitle(5, "belts"), () => buildDescriptors(draft!, rebuildAll, fieldCtx(), expandedNodes, "belt"), summaryBelts, ctx),
  ];
  for (const p of panels) rightCol.add(p.outer);
  rightCol.add(status);

  const configPanel = () => panels[0]!; // panel [2] owns the repo-level title + load messages

  function setExpandedSection(n: number | null): void {
    expandedSection = n;
    for (const p of panels) p.setExpanded(p.section === n);
  }

  function setActiveBorders(n: number): void {
    repoPanel.borderColor = n === 1 ? theme.border.active : theme.border.inactive;
    repoPanel.titleColor = n === 1 ? theme.focusText.focused : theme.focusText.unfocused;
    for (const p of panels) p.setActive(p.section === n);
  }

  function focusSection(n: number): void {
    if (n === 1) {
      // Back to the repo list — leaves whatever accordion panel was open expanded (still ≤ 1 open),
      // just de-focuses it.
      lastSection = 1;
      activeSection = 1;
      setActiveBorders(1);
      repoSelect.focus();
      return;
    }
    const panel = panels.find((p) => p.section === n);
    if (!panel) return;
    lastSection = n;
    activeSection = n;
    setExpandedSection(n); // expand this one, collapse the others
    setActiveBorders(n);
    panel.focusInto();
  }

  function loadRepo(name: string): void {
    loadedRepo = null;
    draft = null;
    // Fresh document → all panels collapsed (the default) + cleared.
    setExpandedSection(null);
    activeSection = 1;
    for (const p of panels) p.render();

    const path = join(repoConfigDir(name), "config.yml");
    if (!existsSync(path)) {
      configPanel().outer.title = ` [2] Config · ${name} `;
      configPanel().showMessage(`no config.yml at ${path}`, theme.status.bad);
      setExpandedSection(2); // surface the message
      setStatus("", theme.text.tertiary);
      return;
    }
    loadedText = readFileSync(path, "utf8");
    const doc = parseDocument(loadedText);
    configPanel().outer.title = ` [2] Config · ${name}/config.yml `;
    if (doc.errors.length > 0) {
      configPanel().showMessage(`✗ cannot parse YAML: ${doc.errors[0]?.message ?? "parse error"}`, theme.status.bad);
      setExpandedSection(2);
      setStatus("fix the YAML before editing", theme.status.bad);
      return;
    }
    loadedRepo = name;
    draft = doc;
    loadedEnv = loadEnvMap(repoConfigDir(name));
    envValues = { ...loadedEnv };
    for (const p of panels) p.render();
    setStatus("↑↓ move · ↵ open/edit/cycle · ^S save · [2] [3] [4] [5] sections", theme.text.secondary);
  }

  function save(): void {
    if (!loadedRepo || !draft) {
      setStatus("select a repo first", theme.text.tertiary);
      return;
    }
    flushAll();
    // Credentials live in a separate `env` file (no schema validation) — save them independently
    // of config validity when they've changed.
    const changed = Object.entries(envValues).filter(([k, v]) => v !== (loadedEnv[k] ?? ""));
    if (changed.length > 0) {
      saveEnvValues(repoConfigDir(loadedRepo), Object.fromEntries(changed));
      loadedEnv = { ...loadedEnv, ...Object.fromEntries(changed) };
    }
    for (const p of panels) p.clearErrors();
    const parsed = RepoConfigSchema.safeParse(draft.toJS());
    if (!parsed.success) {
      // Surface the (whole-config) errors in the focused panel — expanding one if we're at the repo
      // list — so they're visible where the user is working.
      const target = activePanel() ?? configPanel();
      if (activeSection === 1) focusSection(target.section);
      parsed.error.issues.slice(0, 6).forEach((iss) => {
        target.addError(`  ✗ ${iss.path.join(".") || "(root)"}: ${iss.message}`);
      });
      setStatus(`✗ ${parsed.error.issues.length} validation error(s) — not saved`, theme.status.bad);
      return;
    }
    // Belt rename/delete cleanup: diff the on-disk config (as loaded) against the draft. A rename
    // migrates its runs to the new name; a delete purges the belt's data (guarded — blocked if it
    // still has work). Both need the DB/worktree side handled atomically with the reload, so they
    // route through applyBeltChangesForRepo instead of the plain reload nudge.
    const beltsOf = (yamlText: string): Record<string, unknown>[] => {
      const b = (parseDocument(yamlText).toJS() as { belt?: unknown } | null)?.belt;
      return Array.isArray(b) ? (b as Record<string, unknown>[]) : [];
    };
    const { renames, deletes } = diffBelts(beltsOf(loadedText), beltsOf(draft.toString()));

    const prevText = loadedText;
    const cfgPath = join(repoConfigDir(loadedRepo), "config.yml");
    const text = draft.toString();
    writeFileSync(cfgPath, text);
    loadedText = text;
    setStatus("✓ saved", theme.status.good);

    if (renames.length === 0 && deletes.length === 0) {
      void postReload().then((outcome) => {
        if (!loadedRepo || !outcome.reached) return;
        const failed = outcome.failures.find((f) => f.name === loadedRepo) ?? outcome.failures[0];
        if (failed) {
          // The save was schema-valid but the server could NOT load the repo (e.g. a source whose
          // client can't be constructed) — the repo is NOT ticking; "reloaded" would be a lie.
          setStatus(`✗ saved, but repo "${failed.name}" failed to load: ${failed.error}`, theme.status.bad);
        } else {
          setStatus("✓ saved · server reloaded", theme.status.good);
        }
      });
      return;
    }

    const repoName = loadedRepo;
    void applyBeltChangesForRepo(repoName, { renames, deletes })
      .then((res) => {
        if (loadedRepo !== repoName) return; // the user navigated away while it ran
        if (res.blocked.length > 0) {
          // The delete guard refused: REVERT the file so on-disk config matches the belts still
          // running, but KEEP the draft (the user's edits survive in memory) so they can tear the
          // work down and re-save.
          writeFileSync(cfgPath, prevText);
          loadedText = prevText;
          const detail = res.blocked.map((b) => `"${b.belt}" (${b.activeRuns} in progress)`).join(", ");
          setStatus(`✗ not saved — belt ${detail} still has work; tear it down or let it finish first`, theme.status.bad);
          return;
        }
        if (res.failures.length > 0) {
          setStatus(`✗ saved, but reload failed: ${res.failures[0]!.error}`, theme.status.bad);
          return;
        }
        const parts: string[] = [];
        if (res.runsMoved) parts.push(`${res.runsMoved} run(s) migrated`);
        if (res.runsPurged) parts.push(`${res.runsPurged} run(s) purged`);
        if (res.worktreesCleaned) parts.push(`${res.worktreesCleaned} worktree(s) cleaned`);
        setStatus(`✓ saved${parts.length ? ` · ${parts.join(" · ")}` : " · belts updated"} · server reloaded`, theme.status.good);
      })
      .catch((e: unknown) => {
        setStatus(`✗ belt cleanup failed: ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
      });
  }

  // ── referenced-file assist + guidelines buffer (IO the field builder delegates back here) ──────
  /** Write a prompt_file / match stub the field builder offered, then rebuild so the "+ create" row
   *  clears. The referenced value is already in the draft, so the config still needs a ^S save. */
  function writeStub(absPath: string, content: string): void {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
    rebuildAll(); // markUnsaved (the config referencing the file is still unsaved)
    setStatus(`✓ created ${basename(absPath)} — ^S to save the config`, theme.status.good);
  }
  /** Open guidelines-prompt.md (the optional per-repo file appended to every step prompt) in the
   *  shell's multiline text modal; write it back on save. It's a sibling file, not config.yml, so
   *  it saves immediately (independent of ^S) and needs no schema validation. */
  function editGuidelines(): void {
    if (!loadedRepo) return;
    const repoName = loadedRepo;
    const path = join(repoConfigDir(repoName), "guidelines-prompt.md");
    const initial = existsSync(path) ? readFileSync(path, "utf8") : "";
    void modals.editText("guidelines-prompt.md — appended to every step prompt of every belt", initial, "^S save · Esc cancel").then((next) => {
      if (next == null || loadedRepo !== repoName) return; // cancelled, or navigated away
      writeFileSync(path, next);
      configPanel().render(); // flip the create→edit label
      setStatus("✓ guidelines-prompt.md saved", theme.status.good);
    });
  }

  // ── the "+ new repo" wizard ────────────────────────────────────────────────────────────────────
  // Sources the wizard can scaffold — registry-driven so a new source type appears automatically.
  const sourceChoices = SOURCE_DESCRIPTORS.map((sd) => ({ label: sd.type, value: sd.type }));
  /** Reload the repo list from disk and, when given a name, select + open it. */
  function refreshRepos(select?: string): void {
    repos = listConfiguredRepos();
    repoSelect.options = repoOptions();
    if (!select) return;
    const idx = repoOptions().findIndex((o) => o.name === select);
    if (idx >= 0) repoSelect.setSelectedIndex(idx);
    loadRepo(select);
    if (draft) focusSection(2);
  }
  /** Minimal name → path → source wizard, then share the `init` scaffold to write config.yml (+ an
   *  env scaffold for credentialed sources) and open it in the editor for the details. */
  async function newRepoWizard(): Promise<void> {
    const name = (await modals.prompt("New repo — config name (the folder you pass to --repo)", "my-app"))?.trim();
    if (!name) return; // cancelled / empty
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      setStatus(`✗ invalid repo name "${name}" — use letters, digits, dot, dash, underscore`, theme.status.bad);
      return;
    }
    if (listConfiguredRepos().includes(name)) {
      setStatus(`✗ a repo named "${name}" already exists`, theme.status.bad);
      return;
    }
    const path = (await modals.prompt(`New repo "${name}" — path to the repo's MAIN checkout`, `~/dev/${name}`))?.trim();
    if (!path) return;
    const source = await modals.choose("New repo — work source", sourceChoices);
    if (!source) return;
    try {
      const res = await initRepo({ repoName: name, path, source: source as SourceType });
      refreshRepos(res.repoName);
      const cred = res.secretKeys.length ? ` · add ${res.secretKeys.join(" + ")} in secrets` : "";
      setStatus(`✓ created "${res.repoName}" (${res.source}) — edit the placeholders${cred}, then ^S to save`, theme.status.good);
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
    }
  }

  function openRepo(): void {
    const opt = repoSelect.getSelectedOption();
    if (!opt) return;
    if (opt.name === NEW_REPO) {
      void newRepoWizard();
      return;
    }
    loadRepo(opt.name);
    if (draft) focusSection(2); // jump straight into the fields after opening a valid repo
  }
  repoSelect.on("itemSelected", openRepo);
  // Click a row to select + open it (Select has no native mouse handling): map the click row to an
  // option index off the list's top. `itemSpacing: 0` keeps that one row per option. The list always
  // has ≥1 row (the "+ new repo" sentinel), so no empty-list guard is needed.
  const repoRowAt = (y: number) => Math.max(0, Math.min(repoOptions().length - 1, Math.floor(y - repoSelect.y)));
  repoSelect.onMouseDown = (e) => {
    focusSection(1);
    repoSelect.setSelectedIndex(repoRowAt(e.y));
    openRepo();
  };
  // Hover: a Select is one composite widget (no per-item renderables to tint), so the mouse-following
  // equivalent is to move its own selection highlight to the row under the cursor. Doesn't load a repo
  // (that's still a click) and doesn't steal focus — just tracks the pointer.
  repoSelect.onMouseMove = (e) => {
    repoSelect.setSelectedIndex(repoRowAt(e.y));
  };

  return {
    root,
    sectionCount: 5,
    focusSection,
    restoreFocus() {
      focusSection(lastSection);
    },
    activate() {
      const first = repos[0];
      // Open the first configured repo (index 1 — index 0 is the "+ new repo" sentinel) so the
      // highlighted row matches what the editor is showing.
      if (!loadedRepo && first) {
        repoSelect.setSelectedIndex(1);
        loadRepo(first);
      }
    },
    deactivate() {
      /* no timers to stop */
    },
    save,
    editMove(dir: -1 | 1) {
      activePanel()?.editMove(dir);
    },
  };
}
