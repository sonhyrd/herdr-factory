// The Dashboard's status board. Work items are CARDS, a belt's steps are COLUMNS, and a card sits in
// the column of the step it is currently in — so "what is where" reads at a glance instead of scanning
// a status word per row (the old aligned status table). Pure: no renderer and no colors, just text
// SEGMENTS tagged with a semantic tone that dashboard.ts maps onto theme tokens. Column fitting,
// truncation and padding therefore unit-test as plain data.
//
// Two rules the board obeys, both deliberate:
//  • State is carried by an ICON, never by tinting a whole card or row — a fully red/green/grey row is
//    harder to read than it is informative. The only tinted glyphs are the state icon and the trailing
//    ⚠ problem flag; the rest stays in the normal text hierarchy (key primary, summary secondary, meta
//    tertiary). Every icon is single-width under opentui's "unicode" width method.
//  • The board is responsive. It fits as many columns side by side as MIN_COLUMN_WIDTH allows and wraps
//    the remainder onto further "shelves"; at one column it degrades into stacked lanes, so a narrow
//    terminal still reads. Cells carry their own x/width so the caller can hit-test a click.

/** Semantic color roles, resolved against the theme by the renderer (see toneColor in dashboard.ts). */
export type Tone = "primary" | "secondary" | "tertiary" | "accent" | "good" | "warn" | "bad" | "info";

/** Where a card is in its life — independent of WHICH step it sits in (that's its column). */
export type CardState = "ready" | "starting" | "working" | "waiting" | "review" | "attention" | "failed" | "done";

// Blue = moving on its own (● an agent is live, ◆ a PR watch), amber = parked on a human, red = needs
// action, green = finished, grey = not started. Shape distinguishes the two blues so the board still
// reads without color.
const STATE_ICONS: Record<CardState, { icon: string; tone: Tone }> = {
  ready: { icon: "○", tone: "tertiary" },
  starting: { icon: "◐", tone: "secondary" },
  working: { icon: "●", tone: "info" },
  waiting: { icon: "?", tone: "warn" },
  review: { icon: "◆", tone: "info" },
  attention: { icon: "⚠", tone: "bad" },
  failed: { icon: "✗", tone: "bad" },
  done: { icon: "✓", tone: "good" },
};

export function stateIcon(state: CardState): { icon: string; tone: Tone } {
  return STATE_ICONS[state];
}

/** The states worth spelling out in the panel's legend; the transient ones (starting/failed) are left
 *  out to keep it to one line. */
export const LEGEND: { state: CardState; label: string }[] = [
  { state: "ready", label: "ready" },
  { state: "working", label: "working" },
  { state: "review", label: "in review" },
  { state: "waiting", label: "waiting on you" },
  { state: "attention", label: "attention" },
  { state: "done", label: "done" },
];

/** The column unclaimed (eligible) work sits in — the board's backlog. */
export const READY_LANE = "ready";

export interface KanbanCard {
  /** "run" = claimed and on the belt, "ready" = eligible but unclaimed. With `key`, this is how the
   *  caller maps a card back to the run / eligible item it was built from. */
  kind: "run" | "ready";
  key: string;
  summary: string | null;
  state: CardState;
  /** Compact right-aligned meta (PR number · time in this state). Dropped when the column is narrow. */
  meta: string | null;
  /** A background problem the state icon can't show (e.g. a stuck evidence upload) — trailing ⚠. */
  flag: boolean;
}

export interface KanbanLane {
  title: string;
  cards: KanbanCard[];
  /** Tone for the lane's title; defaults to "secondary" (warn is used for the unassigned lane). */
  tone?: Tone;
}

export interface Segment {
  text: string;
  tone: Tone;
}

export interface KanbanCell {
  /** Index of the lane this cell belongs to, within the lanes passed to layoutKanban. */
  lane: number;
  /** Index into that lane's `cards`; null for a header, rule, or filler cell (⇒ not focusable). */
  card: number | null;
  /** Character offset of the cell within its line, and the cell's full width. */
  x: number;
  width: number;
  /** Segments whose texts sum to exactly `width`. For a CARD cell the first segment is always the
   *  2-char selection gutter, which the renderer swaps for "▶ " on the highlighted card. */
  segments: Segment[];
}

/** One rendered line of the board. Empty ⇒ a blank spacer line between shelves. */
export type KanbanLine = KanbanCell[];

/** Below this a column can't hold a work key plus a scrap of summary, so the board sheds columns. */
export const MIN_COLUMN_WIDTH = 20;
/** Past this a column is just stretched whitespace — a wide terminal gets air to the right instead. */
const MAX_COLUMN_WIDTH = 48;
const COLUMN_GAP = 2;
/** Cards are inset by the selection gutter, so they sit visibly *inside* their column. */
const GUTTER = "  ";

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

/** Largest single unit, so a card's meta never costs more than 4 columns ("45s", "12m", "3h", "2d"). */
export function shortDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A run as the board needs it — decoupled from api.ts's wire type so this module stays pure. */
export interface BoardRun {
  key: string;
  summary: string | null;
  phase: string;
  /** The belt step the run is on; picks its column. */
  step: string | null;
  outcome: string | null;
  prNumber: number | null;
  /** A background problem (the dashboard's amber ⚠ flag). */
  problem: boolean;
  createdAt: number | null; // epoch seconds
  steps: { step: string; done: boolean; startedAt: number | null }[];
}

/** An eligible, not-yet-claimed work item. */
export interface BoardItem {
  key: string;
  summary: string | null;
}

/** Map a run's phase/outcome onto a card state. Failure outcomes and the engine's needs-a-human park
 *  win over the phase, mirroring how the engine itself ranks them. */
export function cardState(run: { phase: string; outcome: string | null }): CardState {
  const outcome = (run.outcome ?? "").toLowerCase();
  if (/abandon|timeout|closed/.test(outcome)) return "failed";
  switch (run.phase) {
    case "attention":
      return "attention";
    case "waiting_for_human":
      return "waiting";
    case "reviewing":
      return "review";
    case "claiming":
      return "starting";
    case "tearing_down":
    case "done":
      return "done";
    default:
      return "working";
  }
}

/** The lane (column) index a run belongs in: its current step, else the first step it hasn't finished,
 *  else the last step — a run past its final step (a PR watch) stays under that step. */
function laneOf(run: BoardRun, steps: string[]): number {
  const current = run.step ? steps.indexOf(run.step) : -1;
  if (current >= 0) return current + 1;
  const pending = steps.findIndex((step) => !run.steps.some((s) => s.step === step && s.done));
  return (pending >= 0 ? pending : Math.max(0, steps.length - 1)) + 1;
}

/** Compact meta for a run card: its PR when it has one, plus how long it has been in its current step
 *  (falling back to the run's age before any step row exists). */
function runMeta(run: BoardRun, nowSec: number): string | null {
  const parts: string[] = [];
  if (run.prNumber != null) parts.push(`#${run.prNumber}`);
  const current = run.steps.find((s) => s.step === run.step && !s.done);
  const since = current?.startedAt ?? run.createdAt;
  if (since != null && since <= nowSec) parts.push(shortDuration(nowSec - since));
  return parts.length ? parts.join(" ") : null;
}

/** Build a belt's lanes: a `ready` backlog column followed by one column per belt step. Empty columns
 *  are kept — an empty step column is itself information (nothing is in review). */
export function buildLanes(steps: string[], runs: BoardRun[], ready: BoardItem[], nowSec: number): KanbanLane[] {
  const lanes: KanbanLane[] = [
    { title: READY_LANE, cards: ready.map((item) => ({ kind: "ready" as const, key: item.key, summary: item.summary, state: "ready" as const, meta: null, flag: false })) },
    ...steps.map((step) => ({ title: step, cards: [] as KanbanCard[] })),
  ];
  for (const run of runs) {
    const lane = lanes[laneOf(run, steps)] ?? lanes[lanes.length - 1]!;
    lane.cards.push({ kind: "run", key: run.key, summary: run.summary, state: cardState(run), meta: runMeta(run, nowSec), flag: run.problem });
  }
  return lanes;
}

/** A single lane laid out full-width — used for runs whose belt no longer exists, which have no steps
 *  to form columns from. */
export function looseLane(title: string, runs: BoardRun[], nowSec: number, tone: Tone = "warn"): KanbanLane {
  return {
    title,
    tone,
    cards: runs.map((run) => ({ kind: "run" as const, key: run.key, summary: run.summary, state: cardState(run), meta: runMeta(run, nowSec), flag: run.problem })),
  };
}

/**
 * The same lanes, one line per card instead of a grid — for a belt carrying a run or two, where the
 * column view spends five headers, a rule and two lines to say "one run, in work, 48m". The step is
 * on the card's own line (its lane's title), so nothing is lost by dropping the columns.
 *
 * Cells keep their lane/card indices, so a caller resolves and hit-tests a compact line exactly as it
 * does a grid one.
 */
export function compactBoard(lanes: KanbanLane[], width: number): KanbanLine[] {
  if (width <= 0) return [];
  const lines: KanbanLine[] = [];
  lanes.forEach((lane, laneIndex) => {
    lane.cards.forEach((card, cardIndex) => {
      lines.push([{ lane: laneIndex, card: cardIndex, x: 0, width, segments: compactSegments(card, lane.title, width) }]);
    });
  });
  return lines;
}

/** One compact card line: `● HF-54  work  48m  nudge an idle agent…`. Budget order mirrors
 *  `cardSegments` — gutter, icon and key are fixed, then the step, then the meta, and the summary
 *  takes whatever is left. */
function compactSegments(card: KanbanCard, step: string, width: number): Segment[] {
  const { icon, tone } = stateIcon(card.state);
  const head = `${icon} `;
  const inner = Math.max(0, width - GUTTER.length - head.length);
  const key = truncate(card.key, inner);
  const flag = card.flag ? " ⚠" : "";
  const meta = card.meta ? `  ${card.meta}` : "";
  const tail = inner - key.length - flag.length;
  const summaryRoom = tail - step.length - meta.length - 4;
  const summary = card.summary && summaryRoom >= 3 ? `  ${truncate(card.summary, summaryRoom)}` : "";
  const rest = truncate(`  ${step}${meta}${summary}`, Math.max(0, tail));
  const segments: Segment[] = [
    { text: GUTTER, tone: "tertiary" },
    { text: head, tone },
    { text: key, tone: "primary" },
    { text: rest, tone: "secondary" },
  ];
  if (flag) segments.push({ text: flag, tone: "warn" });
  const filler = Math.max(0, width - segments.reduce((n, seg) => n + seg.text.length, 0));
  if (filler) segments.push({ text: " ".repeat(filler), tone: "tertiary" });
  return segments;
}

/** Segments for one card, summing to exactly `width`. Budget order: the gutter and icon are fixed, the
 *  key is never dropped (only truncated), the meta is shed before the summary is squeezed away. */
function cardSegments(card: KanbanCard, width: number): Segment[] {
  const { icon, tone } = stateIcon(card.state);
  const head = `${icon} `;
  const inner = Math.max(0, width - GUTTER.length - head.length);
  const flag = card.flag ? " ⚠" : "";
  let meta = card.meta ? ` ${card.meta}` : "";
  // Shed the meta, then the flag, rather than let either eat the work key.
  if (meta.length + flag.length + card.key.length > inner) meta = "";
  const tailWidth = meta.length + flag.length;
  const textWidth = Math.max(0, inner - tailWidth);
  const key = truncate(card.key, textWidth);
  const summaryRoom = textWidth - key.length - 1;
  const summary = card.summary && summaryRoom >= 3 ? ` ${truncate(card.summary, summaryRoom)}` : "";
  const filler = Math.max(0, textWidth - key.length - summary.length);

  const segments: Segment[] = [{ text: GUTTER, tone: "tertiary" }, { text: head, tone }, { text: key, tone: "primary" }];
  if (summary) segments.push({ text: summary, tone: "secondary" });
  if (filler) segments.push({ text: " ".repeat(filler), tone: "tertiary" });
  if (meta) segments.push({ text: meta, tone: "tertiary" });
  if (flag) segments.push({ text: flag, tone: "warn" });
  return segments;
}

/** A column header: its name and how many cards are in it, flush with the rule beneath (the cards
 *  themselves are inset by the gutter). */
function headerSegments(lane: KanbanLane, width: number): Segment[] {
  const count = ` · ${lane.cards.length}`;
  const title = truncate(lane.title, Math.max(0, width - count.length));
  return [
    { text: title, tone: lane.tone ?? "secondary" },
    { text: pad(count, Math.max(0, width - title.length)), tone: "tertiary" },
  ];
}

/**
 * Lay `lanes` out as a board `width` characters wide. Columns are equal width and side by side; when
 * they don't all fit, the lanes wrap onto further shelves (each shelf its own header + rule), and at
 * one column per shelf the board reads as stacked lanes.
 */
export function layoutKanban(lanes: KanbanLane[], width: number): KanbanLine[] {
  if (lanes.length === 0 || width <= 0) return [];
  const columns = Math.max(1, Math.min(lanes.length, Math.floor((width + COLUMN_GAP) / (MIN_COLUMN_WIDTH + COLUMN_GAP))));
  const fair = Math.floor((width - COLUMN_GAP * (columns - 1)) / columns);
  const columnWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, fair));
  const lines: KanbanLine[] = [];

  for (let shelfStart = 0; shelfStart < lanes.length; shelfStart += columns) {
    const shelf = lanes.slice(shelfStart, shelfStart + columns);
    if (shelfStart > 0) lines.push([]); // blank spacer between shelves
    const cellAt = (offset: number, lane: KanbanLane, card: number | null, segments: Segment[]): KanbanCell => ({
      lane: shelfStart + offset,
      card,
      x: offset * (columnWidth + COLUMN_GAP),
      width: columnWidth,
      segments,
    });
    lines.push(shelf.map((lane, i) => cellAt(i, lane, null, headerSegments(lane, columnWidth))));
    lines.push(shelf.map((lane, i) => cellAt(i, lane, null, [{ text: "─".repeat(columnWidth), tone: "tertiary" }])));
    const rows = Math.max(...shelf.map((lane) => lane.cards.length));
    for (let row = 0; row < rows; row++) {
      // Only lanes that actually have a card at this row emit a cell; the renderer pads to each cell's
      // x, so gaps cost nothing.
      const cells = shelf.flatMap((lane, i) => {
        const card = lane.cards[row];
        return card ? [cellAt(i, lane, row, cardSegments(card, columnWidth))] : [];
      });
      lines.push(cells);
    }
  }
  return lines;
}
