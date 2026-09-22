// Dashboard tab — per-machine, per-repo view of the factory that also drives it. Live status +
// eligible items come from the FLEET (fleet-view.ts): this machine's resident server plus every
// enabled machine herdr knows about, each read under its own budget.
//
// A one-machine install renders exactly as it always has — no machine headers, no badges, repos from
// disk when the server is down. The fleet's chrome appears only when there IS a fleet:
//   * a header per machine (reachable?, version, occupancy, when it last answered);
//   * a `@machine` badge on every repo row, and `m` to filter the board to one machine;
//   * an unverifiable machine keeps the rows of its last successful read, marked as such — blanking
//     them would say the runs are gone when they are merely unobservable;
//   * every action is sent through that run's OWN machine client, and names the machine when it asks
//     for confirmation.
//
// Work is shown as a KANBAN BOARD per belt (kanban.ts): the belt's steps are columns, each work item is
// a card in the column of the step it is currently in, and its state is carried by a colored ICON
// rather than by tinting the whole card — see kanban.ts for the two rules the board keeps. Cards are
// navigable (↑↓ within a column, ←→ across columns) and contextual keys act on the highlighted card,
// each behind the shell's confirmation modal:  t = tick a repo,  c = claim a ready item,  x = teardown
// an active run,  s = resume a parked run / clear its (or the repo's) suspended + waiting background
// jobs and retry them now,
// d = open repo/work detail,  ↵ = timeline,  r = refresh. Auto-refreshes every 3s while active; when
// the server is down it lists the repos with a hint and actions no-op.
//
// Refresh is flicker-free: quick status paints first, eligible source queries fold in afterward, and
// both passes reconcile in place — reusing existing text renderables and only rewriting content or
// adding/removing rows at the tail. The quick paint carries the last good eligible items forward
// (fleet-view.ts's cache) instead of blanking them, so the rows survive the phase-1 gap and a
// lagging or failed fold-in rather than blinking out for a frame.
import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, bg, fg, type CliRenderer, type TextChunk } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { text } from "./render.ts";
import { listConfiguredRepos } from "../config-paths.ts";
import type { ActiveRun } from "./api.ts";
import { fleetClaimed, withoutClaimed } from "./eligible-cache.ts";
import {
  createFleetSource,
  filterMachines,
  fleetStatusLine,
  hostLines,
  idleLine,
  isIdleRepo,
  machineHeader,
  needsYou,
  sharedProblems,
  shortProblem,
  staleRunLine,
  type FleetView,
  type MachineView,
} from "./fleet-view.ts";
import type { MachineClient } from "../fleet/index.ts";
import { updateWarning } from "../watchers/update-status.ts";
import { BORDER, theme } from "./theme.ts";
import type { ChooseFn, ConfirmFn, PromptFn, ShowInfoFn, TabView } from "./types.ts";
import { MIN_COLUMN_WIDTH, buildLanes, compactBoard, layoutKanban, looseLane, type BoardRun, type KanbanCell, type Tone } from "./kanban.ts";
import { formatWorkItemDetail } from "./work-detail.ts";
// A LEAF module (type-only imports) — safe in the TUI's eager startup graph.
import { explainRun } from "../core/explain.ts";
import { linkRefs, openUrl, rowUrl } from "./open-url.ts";

function fmtTime(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts; // tolerate seconds or milliseconds
  return new Date(ms).toLocaleString();
}

const REFRESH_MS = 3000;
/** Boards are indented under their belt so the repo → belt → board hierarchy still reads. */
const BOARD_INDENT = 2;
/** Floor for the measured board width, so a cold start or a silly-narrow terminal still lays out. */
const MIN_WIDTH = MIN_COLUMN_WIDTH;

/** kanban.ts's semantic tones → theme colors (the board itself never names a color); exported for
 *  the shell's footer icon legend (index.ts), which shares this mapping. */
export function toneColor(tone: Tone): string {
  switch (tone) {
    case "primary":
      return theme.text.primary;
    case "secondary":
      return theme.text.secondary;
    case "tertiary":
      return theme.text.tertiary;
    case "accent":
      return theme.accent;
    case "good":
      return theme.status.good;
    case "warn":
      return theme.status.warn;
    case "bad":
      return theme.status.bad;
    case "info":
      return theme.status.info;
  }
}

/** Map an api.ts ActiveRun onto the board's own run shape. */
function toBoardRun(run: ActiveRun): BoardRun {
  return {
    key: run.ticketKey,
    summary: run.summary,
    phase: run.phase,
    step: run.step,
    outcome: run.outcome,
    prNumber: run.prNumber,
    problem: run.problem != null,
    createdAt: run.createdAt,
    steps: run.steps.map((s) => ({ step: s.step, done: s.done, startedAt: s.startedAt })),
  };
}

/** The ⚠ detail a card has no room for — shown on the action line while that card is highlighted. */
function runNote(run: ActiveRun): { text: string; tone: Tone } | undefined {
  if (run.phase === "attention") return { text: `⚠ ${run.ticketKey}: ${run.attentionReason ?? "needs attention"}`, tone: "bad" };
  if (run.problem) return { text: `⚠ ${run.ticketKey}: ${run.problem.detail}`, tone: "warn" };
  if (run.phase === "waiting_for_human") return { text: `? ${run.ticketKey}: waiting for a human reply`, tone: "warn" };
  return undefined;
}

type RowKind = "repo" | "run" | "eligible" | "source" | "machine";
/** Below this many cards a belt renders as one line per run instead of a column grid — the grid earns
 *  its five headers only once work is actually spread across steps. */
const COMPACT_MAX_CARDS = 2;
interface Target {
  /** The machine that owns this row — the ONLY machine an action on it may be sent to. */
  machine: string;
  repo: string;
  kind: RowKind;
  key?: string;
  source?: string | null;
  belt?: string;
  /** The run's phase (run cards only) — `s` routes on it: an `attention` run is resumed, anything
   *  else gets its backed-off retries made due now. */
  phase?: string;
  /** A detail too long for a card; surfaced on the action line when the card is highlighted. */
  note?: { text: string; tone: Tone };
  /** Which part of the board this row sits in. The "needs you" section REPEATS rows that also appear
   *  under their machine (that is the point of it), so without this the two focusables would share a
   *  row key — and the highlight, which is restored by key across refreshes, would snap back to the
   *  section's copy every poll, dragging the scroll with it. */
  section?: "needs";
  /** Where this row lives on the web (run rows only), resolved by the machine that OWNS the run and
   *  carried with it — so a remote run's PR opens in THIS machine's browser. `o` opens `prUrl`
   *  (falling back to the work item while there is no PR), `O` always opens `itemUrl`. */
  prUrl?: string | null;
  itemUrl?: string | null;
  /** Set on a row carried forward from an unverifiable machine: it is last-known state, so nothing
   *  may be acted on through it (the machine is not answering — the action would fail anyway, but
   *  saying so up front is the difference between "refused" and "maybe it worked"). */
  stale?: boolean;
}

/** Desired state of one line (built in memory, then reconciled onto the rendered nodes): either a plain
 *  full-width line, or a board line of kanban cells with a target per focusable cell. `problem` is a
 *  red suffix appended after the content (the repo row's suspended-jobs/auth warnings). */
type LineSpec =
  | { kind: "text"; content: string; fg: string; target?: Target; problem?: string }
  | { kind: "board"; cells: KanbanCell[]; targets: (Target | undefined)[] };

/** A rendered line: its persistent text renderable + current spec. */
interface LineNode {
  text: TextRenderable;
  spec: LineSpec;
  /** Cell index under the mouse (board lines only); -1 when the pointer is elsewhere. */
  hoverCell: number;
}

/** One focusable thing: a whole line, or a single card cell within a board line. */
interface Focus {
  node: LineNode;
  line: number; // index into `lines`
  cell: number; // index into a board line's cells; -1 for a whole-line target
  lane: number; // the card's column, for ←→ and same-column ↑↓; -1 for a whole-line target
  x: number;
  target: Target;
}

export function createDashboard(
  renderer: CliRenderer,
  actions: { confirm: ConfirmFn; choose: ChooseFn; showInfo: ShowInfoFn; prompt: PromptFn; setStatus: (content: string, fg: string) => void },
): TabView {
  const { confirm, choose, showInfo, prompt, setStatus } = actions;

  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.bg, paddingLeft: 1, paddingRight: 1 });
  const list = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0, // clip + scroll instead of growing over the action line (yoga's default flexShrink is 0)
    width: "100%",
    scrollY: true,
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    focusedBorderColor: theme.border.active,
    title: " Board ",
    titleColor: theme.text.secondary,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const actionLine = text(renderer, { content: "", height: 1, wrapMode: "none", fg: theme.text.tertiary, paddingLeft: 1 });
  root.add(list);
  root.add(actionLine);

  const source = createFleetSource();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let lines: LineNode[] = [];
  let rows: Focus[] = []; // focusable cells/lines, in reading order
  let byLine = new Map<number, Focus[]>(); // line index -> its focusables, ordered by x
  let hi = 0; // index into rows
  // True while the action line is holding a highlighted card's ⚠ note, so moving off it clears the note
  // without wiping a real action result.
  let showingNote = false;
  // Belts per `<machine>|<repo>` — a claim has to pick a belt from the OWNING machine's config.
  const statusBelts = new Map<string, { name: string; beltType: string; source: string }[]>();
  // The last rendered view, so a terminal resize can re-lay the board (its column count is a
  // function of width) without waiting for the next poll.
  let lastView: FleetView | null = null;
  let lastWidth = 0;
  // Which machine the board is narrowed to; null = the whole fleet. Driven by `m`.
  let machineFilter: string | null = null;
  // False = idle repos are collapsed into one line per machine (the default); `i` expands them for
  // someone confirming a particular repo is being served at all.
  let showIdle = false;
  let warnedAboutFleet = false;

  const rowKey = (t: Target) => `${t.section ?? "board"}|${t.machine}|${t.repo}|${t.kind}|${t.belt ?? ""}|${t.key ?? ""}`;
  const beltsKey = (machine: string, repo: string) => `${machine}|${repo}`;
  /** The machine as this view last saw it — how an action learns whether its target is answering. */
  const machineOf = (name: string): MachineView | undefined => lastView?.machines.find((m) => m.name === name);
  /** True once this install has a fleet: more than one machine. Everything machine-shaped in the
   *  render is gated on it, so a single-machine dashboard looks exactly as it always has. */
  const fleetMode = () => (lastView?.machines.length ?? 0) > 1;
  const setAction = (msg: string, fg: string) => {
    actionLine.content = msg;
    actionLine.fg = fg;
    showingNote = false;
  };

  /** Usable width inside the bordered list. Measured off a rendered line once one exists (authoritative,
   *  since lines are width:100%). Before the first layout pass, derive it: the terminal less the root's
   *  1-col padding, the list's border and its own 1-col padding — floored by the viewport, which is
   *  already inset by whichever of those yoga has applied. */
  function contentWidth(): number {
    const measured = lines.find((l) => l.text.width > 0)?.text.width ?? 0;
    if (measured > 0) return measured;
    const derived = renderer.terminalWidth - 6;
    const viewport = list.viewport.width;
    return Math.max(MIN_WIDTH, viewport > 0 ? Math.min(viewport, derived) : derived);
  }
  const boardWidth = () => Math.max(MIN_WIDTH, contentWidth() - BOARD_INDENT);

  /** OSC 8 hyperlinks on the `#NN` refs in a line, so Cmd/Ctrl-click opens the PR — including over
   *  SSH, where there is no local browser for `o` to spawn. opentui carries a chunk's `link` through
   *  to the escape sequence; a terminal that does not advertise `hyperlinks` gets the same plain
   *  text, so this is additive everywhere. Returns a single chunk when there is nothing to link. */
  function linked(content: string, color: string, url: string | null | undefined): TextChunk[] {
    if (!url || !renderer.capabilities?.hyperlinks) return [fg(color)(content)];
    return linkRefs(content).map((seg) => {
      const chunk = fg(color)(seg.text);
      if (seg.ref) chunk.link = { url };
      return chunk;
    });
  }

  /** Build a board line's styled content: pad to each cell's x, then emit its segments. The highlighted
   *  card swaps its 2-char gutter for "▶ " and lifts its primary text to the accent — status color stays
   *  on the icon either way. A hovered cell gets the subtle background tint, per cell rather than per row. */
  function boardContent(node: LineNode, cells: KanbanCell[], selectedCell: number): StyledText {
    const chunks: TextChunk[] = [];
    let cursor = 0;
    const targets = node.spec.kind === "board" ? node.spec.targets : [];
    const push = (value: string, color: string, hovered: boolean, url?: string | null) => {
      const chunk = fg(color)(value);
      if (url && renderer.capabilities?.hyperlinks) chunk.link = { url };
      chunks.push(hovered ? bg(theme.hoverBg)(chunk) : chunk);
      cursor += value.length;
    };
    push(" ".repeat(BOARD_INDENT), theme.text.tertiary, false);
    cells.forEach((cell, index) => {
      const start = BOARD_INDENT + cell.x;
      if (start > cursor) push(" ".repeat(start - cursor), theme.text.tertiary, false);
      const selected = index === selectedCell;
      const hovered = index === node.hoverCell && cell.card !== null;
      // A card's work key IS its `#NN`/`KEY-12` ref, so that segment carries the link (there is no
      // literal `#NN` on a card for the text-line matcher to find).
      const target = targets[index];
      const keyText = cell.card !== null ? cell.segments.find((sg) => sg.tone === "primary")?.text : undefined;
      cell.segments.forEach((segment, i) => {
        const isGutter = i === 0 && cell.card !== null;
        const value = isGutter && selected ? "▶ " : segment.text;
        const tone = selected && (segment.tone === "primary" || isGutter) ? "accent" : segment.tone;
        push(value, toneColor(tone), hovered, keyText !== undefined && segment.text === keyText && target ? rowUrl(target, "pr") : null);
      });
    });
    return new StyledText(chunks);
  }

  function applyLine(node: LineNode, current: Focus | undefined): void {
    const spec = node.spec;
    if (spec.kind === "board") {
      node.text.content = boardContent(node, spec.cells, current?.node === node ? current.cell : -1);
      return;
    }
    const isHi = current?.node === node;
    const gutter = spec.target ? (isHi ? "▶ " : "  ") : "";
    const base = isHi ? theme.accent : spec.fg;
    const chunks = linked(gutter + spec.content, base, spec.target ? rowUrl(spec.target, "pr") : null);
    if (spec.problem) {
      // The red problem suffix keeps its own color regardless of highlight — a warning must not
      // blend into the accent when the row is selected.
      node.text.content = new StyledText([...chunks, fg(theme.status.bad)(`   ⚠ ${spec.problem}`)]);
      return;
    }
    if (chunks.length > 1) {
      node.text.content = new StyledText(chunks);
      return;
    }
    node.text.content = gutter + spec.content;
    node.text.fg = base;
  }
  function paint(): void {
    const cur = rows[hi];
    for (const l of lines) applyLine(l, cur);
    if (cur) list.scrollChildIntoView(cur.node.text.id);
  }
  /** Move the highlight and, when the newly highlighted card carries a ⚠ note, surface it on the action
   *  line (clearing a note left by the previous card). Only navigation does this — a refresh must not
   *  stomp the result of an action. */
  function setHighlight(i: number): void {
    if (rows.length === 0) return;
    hi = Math.max(0, Math.min(i, rows.length - 1));
    paint();
    const note = rows[hi]?.target.note;
    if (note) {
      actionLine.content = note.text;
      actionLine.fg = toneColor(note.tone);
      showingNote = true;
    } else if (showingNote) {
      setAction("", theme.text.tertiary);
    }
  }

  /** Index the focusables: reading order for a flat walk, plus per-line for geometric moves. */
  function indexRows(): void {
    rows = [];
    byLine = new Map();
    lines.forEach((node, line) => {
      const found: Focus[] = [];
      const spec = node.spec;
      if (spec.kind === "text") {
        if (spec.target) found.push({ node, line, cell: -1, lane: -1, x: 0, target: spec.target });
      } else {
        spec.cells.forEach((cell, index) => {
          const target = spec.targets[index];
          if (target) found.push({ node, line, cell: index, lane: cell.lane, x: cell.x, target });
        });
      }
      if (found.length) {
        byLine.set(line, found);
        rows.push(...found);
      }
    });
  }

  /** ↑/↓ — the nearest focusable on a line above/below, preferring the same column so moving down a
   *  kanban column stays in that column; otherwise the closest cell by x. */
  function moveVertical(dir: -1 | 1): void {
    const cur = rows[hi];
    if (!cur) return;
    for (let line = cur.line + dir; line >= 0 && line < lines.length; line += dir) {
      const candidates = byLine.get(line);
      if (!candidates?.length) continue;
      const sameLane = cur.lane >= 0 ? candidates.find((c) => c.lane === cur.lane) : undefined;
      const pick = sameLane ?? candidates.reduce((best, c) => (Math.abs(c.x - cur.x) < Math.abs(best.x - cur.x) ? c : best));
      setHighlight(rows.indexOf(pick));
      return;
    }
  }

  /** ←/→ — the adjacent card on the same line (i.e. the neighbouring kanban column). */
  function moveHorizontal(dir: -1 | 1): void {
    const cur = rows[hi];
    if (!cur) return;
    const candidates = byLine.get(cur.line) ?? [];
    const at = candidates.indexOf(cur);
    const next = candidates[at + dir];
    if (next) setHighlight(rows.indexOf(next));
  }

  /** Reconcile the rendered lines to `specs` by REUSING existing nodes (update content in place),
   *  adding/removing only the tail difference. No full teardown ⇒ no flicker. */
  function reconcile(specs: LineSpec[]): void {
    const prevKey = rows[hi] ? rowKey(rows[hi]!.target) : null;
    const prevLane = rows[hi]?.lane ?? -1;
    const shared = Math.min(specs.length, lines.length);
    for (let i = 0; i < shared; i++) lines[i]!.spec = specs[i]!;
    if (specs.length > lines.length) {
      for (let i = lines.length; i < specs.length; i++) {
        const t = text(renderer, { content: "", fg: theme.text.primary, width: "100%", height: 1, wrapMode: "none" });
        list.add(t);
        const node: LineNode = { text: t, spec: specs[i]!, hoverCell: -1 };
        // Click a card to highlight it; click the highlighted run card again to open its timeline. Nodes
        // are reused across reconciles (spec reassigned), so resolve what was clicked at click time.
        t.onMouseDown = (e) => {
          const target = hit(node, e.x);
          if (!target) return; // a header/rule/gap — nothing to select
          const wasCurrent = list.focused && rows[hi] === target;
          list.focus();
          setHighlight(rows.indexOf(target));
          if (wasCurrent && target.target.kind === "run") void openTimeline(target.target);
          e.stopPropagation();
        };
        // Hover tint. On a board line it follows the cell under the pointer (a whole-line tint would
        // read as "all these cards"); on a plain line it's the row.
        const trackHover = (e: { x: number }) => {
          if (node.spec.kind !== "board") return;
          const cell = hitCell(node, e.x);
          if (cell === node.hoverCell) return;
          node.hoverCell = cell;
          applyLine(node, rows[hi]);
        };
        t.onMouseOver = (e) => {
          trackHover(e);
          if (node.spec.kind === "text" && hit(node, e.x)) t.bg = theme.hoverBg;
        };
        t.onMouseMove = trackHover;
        t.onMouseOut = () => {
          t.bg = theme.bg;
          if (node.hoverCell !== -1) {
            node.hoverCell = -1;
            applyLine(node, rows[hi]);
          }
        };
        lines.push(node);
      }
    } else if (specs.length < lines.length) {
      for (let i = lines.length - 1; i >= specs.length; i--) {
        const l = lines[i]!;
        list.remove(l.text.id);
        l.text.destroy();
      }
      lines.length = specs.length;
    }
    indexRows();
    // Keep the highlight on the same work item across refreshes; a card that moved to another column
    // keeps its identity, and if it's gone, fall back to the same column, then the same position.
    const idx = prevKey ? rows.findIndex((r) => rowKey(r.target) === prevKey) : -1;
    const laneIdx = idx >= 0 || prevLane < 0 ? -1 : rows.findIndex((r) => r.lane === prevLane);
    hi = idx >= 0 ? idx : laneIdx >= 0 ? laneIdx : Math.max(0, Math.min(hi, rows.length - 1));
    paint();
  }

  /** The cell index under screen column `screenX` on a board line, or -1. */
  function hitCell(node: LineNode, screenX: number): number {
    if (node.spec.kind !== "board") return -1;
    const col = screenX - node.text.x - BOARD_INDENT;
    return node.spec.cells.findIndex((cell) => cell.card !== null && col >= cell.x && col < cell.x + cell.width);
  }
  /** The focusable under screen column `screenX`, or undefined (a header, rule, or inter-column gap). */
  function hit(node: LineNode, screenX: number): Focus | undefined {
    const candidates = byLine.get(lines.indexOf(node));
    if (!candidates?.length) return undefined;
    if (node.spec.kind === "text") return candidates[0];
    const cell = hitCell(node, screenX);
    return cell < 0 ? undefined : candidates.find((c) => c.cell === cell);
  }

  /** One machine's repos, belts and boards. Emits into `specs`; returns nothing. */
  function pushMachine(m: MachineView, specs: LineSpec[], nowSec: number, badge: boolean, claimed: ReadonlySet<string>): void {
    const blank = () => specs.push({ kind: "text", content: "", fg: theme.text.tertiary });
    /** Lay a set of lanes out and emit one board line per rendered row, carrying each card's target. */
    const pushBoard = (lanes: ReturnType<typeof buildLanes>, resolve: (card: { kind: string; key: string }) => Target | undefined) => {
      // One or two cards don't need a grid: the column view would spend five headers, a rule and a
      // blank line to say "one run, in work, 48m".
      const cards = lanes.reduce((n, lane) => n + lane.cards.length, 0);
      const layout = cards <= COMPACT_MAX_CARDS ? compactBoard(lanes, lastWidth) : layoutKanban(lanes, lastWidth);
      for (const cells of layout) {
        specs.push({
          kind: "board",
          cells,
          targets: cells.map((cell) => (cell.card === null ? undefined : resolve(lanes[cell.lane]!.cards[cell.card]!))),
        });
      }
    };
    const suffix = badge ? `  @${m.name}` : "";
    const shared = sharedProblems(m);
    // A one-machine install draws no machine header (`badge` is the fleet flag — the same condition),
    // so the host-wide facts have nowhere to hang: emit them here, above this machine's repo rows.
    // Deliberately NOT a header — the status line already says the server is up, and the point of
    // this change is to say each thing once.
    if (!badge) for (const line of hostLines(m)) specs.push({ kind: "text", content: line.text, fg: toneColor(line.tone) });
    // Idle repos (no run, no eligible work, no problem) collapse to one line — 17 of 19 rows on a
    // real three-host fleet say nothing but "this repo is being served", which one line says for all
    // of them. `i` brings the full list back for someone confirming a specific repo is there.
    const idle = showIdle ? [] : m.repos.filter(isIdleRepo);
    const idleNames = new Set(idle.map((r) => r.repo));
    for (const { repo: name, status: st, eligible: cached } of m.repos) {
      if (idleNames.has(name)) continue;
      if (st) statusBelts.set(beltsKey(m.name, name), st.belts);
      const active = st?.active ?? [];
      // Repo-level problems (parked runs, suspended jobs, AWS creds, source auth) light the repo
      // row with a compact red ⚠ icon + count; the full detail is one keypress away — on the
      // action line while the row is highlighted (the note), and in red under `d` (the detail
      // modal). `s` on the row clears the suspensions and retries.
      const problems = st?.problems ?? [];
      // A host-wide cause (one `gh auth`, one expired AWS session) is named ONCE on the machine
      // header; the row carries only what is this repo's own, and names it rather than counting it.
      const own = problems.filter((p) => !shared.has(p.detail));
      const more = own.length > 1 ? ` (+${own.length - 1} more)` : "";
      // The machine line is deliberately NOT here: cap occupancy and the memory floor are host-wide
      // by definition, and the header above already prints them once.
      specs.push({
        kind: "text",
        content: `${name}${suffix}   active ${active.length}/${st?.limits.maxActiveWorkspaces ?? "?"}`,
        fg: theme.accent,
        target: {
          machine: m.name,
          repo: name,
          kind: "repo",
          stale: m.stale,
          note: problems.length ? { text: `⚠ ${name}: ${problems.map((p) => p.detail).join(" · ")}`, tone: "bad" } : undefined,
        },
        // No ⚠ of its own: `applyLine` renders the suffix as `   ⚠ <problem>`. The old string carried
        // one too, which is where the issue's `▲▲ 1 problem — press d` came from.
        problem: own.length ? `${shortProblem(own[0]!.detail)}${more}` : undefined,
      });
      if (!st) {
        specs.push({ kind: "text", content: "  (status unavailable)", fg: theme.text.tertiary });
        continue;
      }
      // An unverifiable machine's runs are LAST KNOWN, so they get plain rows rather than cards: a
      // card carries a live state icon and a ticking age, and both would be a claim this read
      // cannot make. The rows stay — that is the whole point — but they say what they are.
      if (m.stale) {
        for (const run of active) {
          specs.push({
            kind: "text",
            content: `  ${staleRunLine(run)}`,
            fg: theme.text.tertiary,
            target: { machine: m.name, repo: name, kind: "run", key: run.ticketKey, source: run.workSource, phase: run.phase, prUrl: run.prUrl, itemUrl: run.itemUrl, stale: true },
          });
        }
        if (active.length === 0) specs.push({ kind: "text", content: "  (no runs when it last answered)", fg: theme.text.tertiary });
        continue;
      }
      // Filter carried-forward eligible items against the FLEET's current runs: one may have been
      // claimed since the last successful fold-in — by this repo, by the other repo config on the
      // same source, or by another host — and would otherwise show as a ready card next to the run
      // that already owns it.
      const eligible = withoutClaimed(cached, claimed);
      let boards = 0;
      for (const belt of st.belts) {
        const beltRuns = active.filter((r) => r.belt === belt.name);
        const beltEligible = eligible.filter((i) => i.belt === belt.name);
        if (beltRuns.length === 0 && beltEligible.length === 0) continue;
        if (boards++) blank(); // one board per belt, separated so the columns don't run together
        specs.push({ kind: "text", content: `  ${belt.name}  [${belt.beltType}]`, fg: theme.text.secondary });
        const lanes = buildLanes(belt.steps, beltRuns.map(toBoardRun), beltEligible, nowSec);
        pushBoard(lanes, (card) => {
          if (card.kind === "ready") {
            const item = beltEligible.find((i) => i.key === card.key);
            return item && { machine: m.name, repo: name, kind: "eligible", key: item.key, source: item.source, belt: item.belt };
          }
          const run = beltRuns.find((r) => r.ticketKey === card.key);
          return run && { machine: m.name, repo: name, kind: "run", key: run.ticketKey, source: run.workSource, phase: run.phase, prUrl: run.prUrl, itemUrl: run.itemUrl, note: runNote(run) };
        });
      }
      // Runs whose belt is no longer configured have no steps to make columns from — one full-width lane.
      const unassigned = active.filter((r) => !st.belts.some((b) => b.name === r.belt));
      if (unassigned.length > 0) {
        if (boards++) blank();
        pushBoard([looseLane("unassigned (no belt)", unassigned.map(toBoardRun), nowSec)], (card) => {
          const run = unassigned.find((r) => r.ticketKey === card.key);
          return run && { machine: m.name, repo: name, kind: "run", key: run.ticketKey, source: run.workSource, phase: run.phase, prUrl: run.prUrl, itemUrl: run.itemUrl, note: runNote(run) };
        });
      }
    }
    // The collapsed repos, last: they are the footnote of the host, not its content. On an
    // unverifiable machine the line says `unverified`, never `idle` — these rows are a remembered
    // read, and "idle" would be a claim about now.
    if (idle.length > 0) specs.push({ kind: "text", content: idleLine(idle.map((r) => r.repo), m.stale), fg: theme.text.tertiary });
  }

  /** The board's first section: everything across the fleet that is blocked on a person. Absent when
   *  there is nothing — a heading that usually reads "nothing" teaches an operator to skip the top
   *  of the screen, which is the one place this board cannot afford to lose. */
  function pushNeedsYou(machines: MachineView[], specs: LineSpec[]): void {
    const items = needsYou(machines);
    if (items.length === 0) return;
    specs.push({ kind: "text", content: `needs you · ${items.length}`, fg: theme.status.warn });
    for (const item of items) {
      specs.push({
        kind: "text",
        content: item.text,
        fg: toneColor(item.tone),
        // A run entry is the run: s/x/d/↵ act on it from here, so the operator never has to find it
        // again further down the board. A machine entry is not actionable (nothing to send it to).
        target: item.key
          ? { section: "needs", machine: item.machine, repo: item.repo, kind: "run", key: item.key, source: item.source, phase: item.phase, prUrl: item.prUrl, itemUrl: item.itemUrl, stale: item.stale }
          : { section: "needs", machine: item.machine, repo: "", kind: "machine", stale: true },
      });
    }
    specs.push({ kind: "text", content: "", fg: theme.text.tertiary });
  }

  function renderView(view: FleetView): void {
    lastView = view;
    lastWidth = boardWidth();
    statusBelts.clear();
    // A warn-worthy last auto-update (failed / dirty-skip / behind its channel target) rides on the
    // shell's status text in amber — the same signal the Doctor tab paints, surfaced up top too.
    // With a fleet, each remote's own `/health` summary rides there with it (fleetStatusLine).
    const status = fleetStatusLine(view, updateWarning() ?? null);
    setStatus(status.text, status.tone === "warn" ? theme.status.warn : theme.status.good);

    const fleet = view.machines.length > 1;
    const shown = filterMachines(view, machineFilter);
    const nowSec = Date.now() / 1000;
    const specs: LineSpec[] = [];
    // Built from EVERY machine, not just the shown ones: a run hidden by the machine filter still
    // holds the claim, so its ticket must not come back as ready on the host that is shown.
    const claimed = fleetClaimed(view.machines);
    // What needs a human, across the WHOLE fleet — above the hosts, and never narrowed by the
    // machine filter: a PR waiting to merge on another box is still waiting.
    pushNeedsYou(view.machines, specs);
    for (const m of shown) {
      if (fleet) {
        if (specs.length && specs[specs.length - 1]!.kind === "text" && (specs[specs.length - 1] as { content: string }).content !== "") {
          specs.push({ kind: "text", content: "", fg: theme.text.tertiary });
        }
        // Only the head line is focusable: the rest is that line's continuation, not another row.
        machineHeader(m, view.readAt).forEach((line, i) => {
          specs.push({
            kind: "text",
            content: line.text,
            fg: toneColor(line.tone),
            target: i === 0 ? { machine: m.name, repo: "", kind: "machine", stale: m.stale } : undefined,
          });
        });
      }
      // The local machine with no server and nothing remembered: list what IS configured here, as
      // the single-machine dashboard always has — a repo list with a hint beats an empty screen.
      if (m.local && m.state === "unverifiable" && m.repos.length === 0) {
        for (const name of listConfiguredRepos()) {
          specs.push({ kind: "text", content: `${name}   (server down)`, fg: theme.text.tertiary, target: { machine: m.name, repo: name, kind: "repo", stale: true } });
        }
        continue;
      }
      pushMachine(m, specs, nowSec, fleet, claimed);
    }
    if (specs.length === 0) {
      specs.push({ kind: "text", content: "  no repos configured under ~/.config/herdr-factory/repos", fg: theme.text.tertiary });
    }
    if (machineFilter) specs.push({ kind: "text", content: `  (showing ${machineFilter} only — press m for all machines)`, fg: theme.text.tertiary });
    if (showIdle) specs.push({ kind: "text", content: "  (showing idle repos — press i to collapse them)", fg: theme.text.tertiary });
    reconcile(specs);
  }

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      // The source paints twice: the quick status view, then the same view with eligible work folded
      // in. `timer === null` means the tab was left mid-flight — drop the paint rather than writing
      // onto another tab.
      await source.poll(renderView, () => timer === null);
      // A herdr that could not be asked silently shrinks the fleet to this machine — said once, so
      // an operator who expected to see another box knows why they don't.
      const warning = source.warnings()[0];
      if (warning && !warnedAboutFleet) {
        warnedAboutFleet = true;
        setAction(`⚠ ${warning}`, theme.status.warn);
      }
    } catch (e) {
      if (timer !== null) setAction(`✗ could not read the fleet: ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
    } finally {
      inFlight = false;
    }
  }

  // The fleet holds an SSH forward per remote machine for the life of the session — released when
  // the TUI itself goes, not on a tab switch (which would re-handshake every time you came back).
  renderer.on("destroy", () => source.close());

  // A resize changes how many columns fit, so re-lay the last view instead of waiting out the poll.
  renderer.on("resize", () => {
    if (timer === null || !lastView || boardWidth() === lastWidth) return;
    renderView(lastView);
  });

  // ── actions (each confirmed; result shown on actionLine; then refresh) ────────────────────────

  /**
   * The ONE client an action on `t` may use: the machine that owns the run. Everything mutating
   * goes through here, so acting on the wrong machine — tearing down a stranger's worktree because
   * two boxes carry the same key — is not something this file can express.
   *
   * Null means refused, with the reason already on the action line: a machine that is not answering
   * cannot be acted on, and a row carried forward from one is last-known state, not a live run.
   */
  function route(t: Target): MachineClient | null {
    if (t.kind === "machine") {
      setAction("a machine header is not actionable — pick one of its repos or cards", theme.text.secondary);
      return null;
    }
    const m = machineOf(t.machine);
    if (!m || m.state === "unverifiable" || t.stale) {
      setAction(
        fleetMode() ? `✗ ${t.machine} is unverifiable — it cannot be acted on until it answers again` : "server not running",
        theme.status.warn,
      );
      return null;
    }
    const client = source.clientFor(t.machine);
    if (!client) {
      setAction(`✗ ${t.machine} is no longer in the fleet`, theme.status.warn);
      return null;
    }
    return client;
  }

  /** " on <machine>" — appended to a confirmation so a destructive key names where it lands. Empty
   *  on a one-machine install, where there is nowhere else it could go. */
  const on = (t: Target) => (fleetMode() ? ` on ${t.machine}` : "");

  async function doTick(t: Target): Promise<void> {
    const client = route(t);
    if (!client) return;
    if (!(await confirm(`Run a reconcile tick on "${t.repo}"${on(t)}?`))) return;
    setAction(`ticking ${t.repo}…`, theme.text.secondary);
    const r = await client.tick(t.repo);
    setAction(r.ok ? `✓ tick ran on "${t.repo}"${on(t)}` : `✗ tick failed: ${r.error}`, r.ok ? theme.status.good : theme.status.bad);
    void refresh();
  }

  async function doTeardown(t: Target): Promise<void> {
    if (!t.key) return;
    const client = route(t);
    if (!client) return;
    if (!(await confirm(`Tear down "${t.key}"${on(t)} (removes its worktree)?`))) return;
    setAction(`tearing down ${t.key}…`, theme.text.secondary);
    const r = await client.teardown(t.repo, t.key, t.source);
    setAction(r.ok ? `✓ torn down "${t.key}"${on(t)}` : `✗ teardown failed: ${r.error}`, r.ok ? theme.status.good : theme.status.bad);
    void refresh();
  }

  async function doClaim(t: Target): Promise<void> {
    if (!t.key) return;
    const client = route(t);
    if (!client) return;
    const belts = (statusBelts.get(beltsKey(t.machine, t.repo)) ?? []).filter((b) => b.source === t.source);
    let belt: string;
    if (t.belt) {
      belt = t.belt;
    } else if (belts.length === 0) {
      return setAction(`no belt configured for source "${t.source}"`, theme.status.warn);
    } else if (belts.length === 1) {
      belt = belts[0]!.name;
    } else {
      const pick = await choose(`Claim ${t.key} onto which belt?`, belts.map((b) => ({ label: `${b.name} [${b.beltType}]`, value: b.name })));
      if (!pick) return;
      belt = pick;
    }
    if (!(await confirm(`Claim "${t.key}" onto belt "${belt}"${on(t)}?`))) return;
    setAction(`claiming ${t.key}…`, theme.text.secondary);
    const r = await client.claim(t.repo, t.key, belt);
    setAction(r.ok ? `✓ claimed "${t.key}" onto "${belt}"${on(t)}` : `✗ claim failed: ${r.error}`, r.ok ? theme.status.good : theme.status.bad);
    void refresh();
  }

  /**
   * `s` — the operator's "I fixed it, go now" key. It routes on what the highlighted thing needs:
   *
   *  - a run parked for `attention` → **resume**: un-park it back to where it was and re-dispatch
   *    (the CLI's `resume`), re-basing the step's clocks and refunding its guard budgets;
   *  - any other run → **retry now** for that run's stuck deliver-lane rows: suspended jobs (10
   *    failed attempts — retries stopped) are cleared with a fresh attempt window, mid-interval
   *    rows become due immediately. A run can be perfectly healthy with a background job stuck
   *    (the amber ⚠ card: evidence URLs published, bytes still retrying) — resume refuses such a
   *    run (phase, not deliver lane), so this is what it needs instead;
   *  - a repo row (or a ready card) → **retry now** repo-wide, clearing ALL the repo's suspensions —
   *    the shape of the usual cause: one expired `aws sso login` blocks every run's evidence
   *    upload at once, and the red ⚠ problems on the repo row point here.
   *
   * The engine auto-clears only the causes it can probe (AWS creds classified `auth`); everything
   * else suspends after 10 flat 30s retries and waits for this key (or `retry-now` on the CLI).
   */
  async function doResumeOrRetry(t: Target): Promise<void> {
    const client = route(t);
    if (!client) return;
    if (t.kind === "run" && t.key && t.phase === "attention") {
      if (!(await confirm(`Resume "${t.key}"${on(t)} (un-park it and pick up where it left off)?`))) return;
      setAction(`resuming ${t.key}…`, theme.text.secondary);
      const r = await client.resume(t.repo, t.key, t.source);
      if (!r.ok) setAction(`✗ resume failed: ${r.error}`, theme.status.bad);
      else if (!r.body.ok) setAction(`✗ ${t.key}: ${r.body.message ?? "could not be resumed"}`, theme.status.warn);
      else setAction(`✓ resumed "${t.key}"${on(t)} → ${r.body.phase ?? "running"}`, theme.status.good);
      void refresh();
      return;
    }
    const perRun = t.kind === "run" && t.key != null;
    const scope = perRun ? `"${t.key}"` : `"${t.repo}"`;
    if (!(await confirm(`Clear ${scope}'s suspended background jobs${on(t)} and retry them now (uploads, source write-backs)?`))) return;
    setAction(`retrying ${perRun ? t.key : t.repo}…`, theme.text.secondary);
    const r = await client.retryNow(t.repo, perRun ? t.key : undefined, t.source);
    if (!r.ok) setAction(`✗ retry failed: ${r.error}`, theme.status.bad);
    else if (!r.body.ok) setAction(`✗ ${r.body.message ?? "nothing to retry"}`, theme.status.warn);
    else if ((r.body.requeued ?? 0) === 0) setAction(`${scope}: no suspended or waiting jobs`, theme.text.secondary);
    else {
      const n = r.body.requeued!;
      const cleared = r.body.unsuspended ?? 0;
      const clearedNote = cleared > 0 ? ` (${cleared} suspension${cleared === 1 ? "" : "s"} cleared)` : "";
      setAction(`✓ ${scope}: ${n} job${n === 1 ? "" : "s"} due now${clearedNote}${r.body.flushed ? " — flushed" : " — a tick is mid-pass"}`, theme.status.good);
    }
    void refresh();
  }

  /** Repo detail (`d` on a repo row). Everything unhealthy renders RED (an InfoLine with tone
   *  "bad") so what needs attention is legible at a glance: the Problems section first (the same
   *  entries that light the repo row's ⚠), then every failing diagnostic — a healthy line stays
   *  green/plain. */
  async function openDetail(t: Target): Promise<void> {
    const client = route(t);
    if (!client) return;
    const title = `${t.repo}${on(t)} — Detail`;
    const modal = showInfo(title, ["Loading repository detail and running diagnostics…"]);
    const [st, eligibleResult] = await Promise.all([client.status(t.repo, true), client.eligible(t.repo)]);
    if (!st) {
      modal.update(title, [{ text: "✗ Could not load repository detail. The server did not return repo status.", tone: "bad" }]);
      return;
    }
    type Line = Parameters<typeof modal.update>[1][number];
    const output: Line[] = [];
    const bad = (text: string): Line => ({ text, tone: "bad" });
    const good = (text: string): Line => ({ text, tone: "good" });
    const dim = (text: string): Line => ({ text, tone: "tertiary" });
    const problems = st.problems ?? [];
    if (problems.length > 0) {
      output.push(bad(`⚠ Problems (${problems.length})`));
      for (const p of problems) output.push(bad(`  ✗ ${p.detail}`));
      output.push("");
    }
    output.push("General diagnostics");
    const sso = st.evidenceSso;
    if (!sso || sso.state === "na") output.push(dim("  – AWS SSO: not configured"));
    else if (sso.state === "ok") output.push(good("  ✓ AWS SSO: ok"));
    else output.push(bad(`  ✗ AWS SSO: ${sso.detail ?? "credentials unavailable"}`));
    for (const src of st.sources) {
      const auth = src.auth;
      const label = `${src.name} (${src.type})`;
      if (!auth || auth.state === "na") output.push(dim(`  – ${label}: no authentication required`));
      else if (auth.state === "ok") output.push(good(`  ✓ ${label}: authenticated${auth.account ? ` as ${auth.account}` : ""}`));
      else output.push(bad(`  ✗ ${label}: ${auth.detail ?? "not authenticated"}${auth.account ? ` (${auth.account})` : ""}`));
    }
    output.push("", "Belt diagnostics");
    const eligible = eligibleResult?.eligible ?? [];
    for (const belt of st.belts) {
      const activeCount = st.active.filter((run) => run.belt === belt.name).length;
      const attentionCount = st.active.filter((run) => run.belt === belt.name && run.phase === "attention").length;
      const eligibleCount = eligible.filter((item) => item.belt === belt.name).length;
      output.push(`${belt.name} [${belt.beltType}]${belt.active === false ? " — INACTIVE" : ""}`);
      output.push(`  source: ${belt.source} · priority: ${belt.priority}${belt.label ? ` · label: ${belt.label}` : ""}`);
      output.push(`  steps: ${belt.steps?.length ? belt.steps.join(" → ") : "none"}`);
      output.push(`  work: ${activeCount} active · ${eligibleCount} eligible`);
      if (attentionCount > 0) output.push(bad(`  ✗ ${attentionCount} run${attentionCount === 1 ? "" : "s"} parked for attention`));
      if (!belt.diagnostic) output.push(dim("  – health: diagnostic unavailable"));
      else if (belt.diagnostic.state === "ok") output.push(good("  ✓ health: source and pickup configuration reachable"));
      else output.push(bad(`  ✗ health: ${belt.diagnostic.detail ?? "check failed"}`));
      output.push("");
    }
    if (st.belts.length === 0) output.push(dim("  (none configured)"));
    modal.update(title, output);
  }

  const timelineLine = (e: { ts: number; type: string; detail: string | null }) =>
    `${fmtTime(e.ts)}  ${e.type}${e.detail ? "  " + e.detail : ""}`;

  async function openTimeline(t: Target): Promise<void> {
    if (!t.key) return;
    const client = route(t);
    if (!client) return;
    setAction(`loading timeline for ${t.key}…`, theme.text.secondary);
    const res = await client.timeline(t.repo, t.key);
    if (!res) return setAction(`✗ could not load timeline for ${t.key}`, theme.status.bad);
    setAction("", theme.text.tertiary);
    showInfo(`${t.key}${on(t)} — timeline`, res.timeline.map(timelineLine));
  }

  /** Full read-only detail for one active work item: overview + belt step progress + timeline. Pulls a
   *  fresh detailed status (so the live worker/pane state is populated, unlike the quick refresh loop)
   *  alongside the timeline; degrades to just the timeline if the run has ended in the meantime. */
  async function openWorkItemDetail(t: Target): Promise<void> {
    if (!t.key) return;
    const client = route(t);
    if (!client) return;
    const title = `${t.key}${on(t)} — detail`;
    const modal = showInfo(title, ["Loading work item detail…"]);
    const [st, tl, ob] = await Promise.all([
      client.status(t.repo, true),
      client.timeline(t.repo, t.key),
      client.obligations(t.repo, t.key, t.source ?? undefined),
    ]);
    const timelineLines = (tl?.timeline ?? []).map(timelineLine);
    const run = st?.active.find((r) => r.ticketKey === t.key && (!t.source || r.workSource === t.source));
    if (!run) {
      modal.update(title, [
        "(run is no longer active — showing its timeline)",
        "",
        "Timeline",
        ...(timelineLines.length ? timelineLines.map((l) => `  ${l}`) : ["  (no events)"]),
      ]);
      return;
    }
    const belt = st!.belts.find((b) => b.name === run.belt);
    modal.update(title, formatWorkItemDetail(
      {
        key: run.ticketKey,
        summary: run.summary,
        issueType: run.issueType,
        workSource: run.workSource,
        belt: run.belt,
        worktreeName: run.worktreeName,
        branch: run.branch,
        phase: run.phase,
        step: run.step,
        prNumber: run.prNumber,
        outcome: run.outcome,
        worker: run.worker,
        attentionReason: run.attentionReason,
        problem: run.problem ? { detail: run.problem.detail } : null,
        createdAt: run.createdAt,
        beltSteps: belt?.steps ?? [],
        steps: run.steps.map((s) => ({ step: s.step, done: s.done, startedAt: s.startedAt ?? null, doneAt: s.doneAt ?? null, pass: s.pass ?? 1 })),
        // The narrative shares core/explain.ts with the CLI's `explain <KEY>`; obligations timestamps
        // are epoch seconds, so `now` converts from the ms wall clock the TUI otherwise uses.
        explain: ob ? explainRun({ ob, repoName: t.repo, now: Math.floor(Date.now() / 1000), heading: false }) : undefined,
      },
      timelineLines,
      Date.now(),
    ));
  }

  /** `o` / `O` — the row's PR (falling back to its work item while there is no PR) / its work item,
   *  in a browser. An unverifiable machine's row still opens: the URL is last-known state, but
   *  reading a web page is not an action sent to that machine. With no display to open into, the URL
   *  lands on the action line instead of failing where nobody can see it. */
  function doOpen(t: Target, which: "pr" | "item"): void {
    const url = rowUrl(t, which);
    if (!url) {
      setAction(`${t.key ?? t.repo}: no ${which === "item" ? "work item" : "PR or work item"} URL — this source has no web page for it`, theme.text.secondary);
      return;
    }
    const res = openUrl(url, (m) => setAction(m, theme.status.bad));
    setAction(res.message, res.opened ? theme.text.secondary : theme.text.primary);
  }

  /** `m` — narrow the board to one machine, or widen it back to the whole fleet. A one-machine
   *  install says so rather than opening a picker with a single entry. */
  async function pickMachine(): Promise<void> {
    const view = lastView;
    if (!view || view.machines.length <= 1) return setAction("this is the only machine in the fleet", theme.text.secondary);
    const pick = await choose("Show which machine?", [
      { label: "all machines", value: "" },
      ...view.machines.map((m) => ({ label: `${m.name}${m.state === "unverifiable" ? " (unverifiable)" : ""}`, value: m.name })),
    ]);
    if (pick === null) return;
    machineFilter = pick || null;
    setAction(machineFilter ? `showing ${machineFilter} only` : "showing every machine", theme.text.secondary);
    renderView(view);
  }

  list.onKeyDown = (key: KeyEvent) => {
    if (rows.length === 0) return;
    const t = rows[hi]?.target;
    switch (key.name) {
      case "up":
        moveVertical(-1);
        key.preventDefault();
        break;
      case "down":
        moveVertical(1);
        key.preventDefault();
        break;
      case "left":
        moveHorizontal(-1);
        key.preventDefault();
        break;
      case "right":
        moveHorizontal(1);
        key.preventDefault();
        break;
      case "return":
      case "enter":
        if (t?.kind === "run") void openTimeline(t);
        key.preventDefault();
        break;
      case "t":
        if (t) void doTick(t);
        key.preventDefault();
        break;
      case "m":
        void pickMachine();
        key.preventDefault();
        break;
      case "i":
        showIdle = !showIdle;
        setAction(showIdle ? "showing every repo" : "idle repos collapsed", theme.text.secondary);
        if (lastView) renderView(lastView);
        key.preventDefault();
        break;
      case "x":
        if (t?.kind === "run") void doTeardown(t);
        key.preventDefault();
        break;
      case "c":
        if (t?.kind === "eligible") void doClaim(t);
        key.preventDefault();
        break;
      case "s":
        if (t) void doResumeOrRetry(t);
        key.preventDefault();
        break;
      case "d":
        if (t?.kind === "repo") void openDetail(t);
        else if (t?.kind === "run") void openWorkItemDetail(t);
        key.preventDefault();
        break;
      case "o":
      case "O":
        if (t?.kind === "run") doOpen(t, key.shift || key.name === "O" ? "item" : "pr");
        key.preventDefault();
        break;
      case "r":
        void refresh();
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
      timer = setInterval(() => void refresh(), REFRESH_MS);
      void refresh();
    },
    deactivate() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

