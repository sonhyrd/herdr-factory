import { describe, expect, it } from "vitest";
import { LEGEND, MIN_COLUMN_WIDTH, buildLanes, cardState, compactBoard, layoutKanban, looseLane, stateIcon, type BoardRun, type CardState, type KanbanCell, type Tone } from "../src/tui/kanban.ts";

const NOW = 1000; // epoch seconds — every duration below is derived from this

const run = (over: Partial<BoardRun> & { key: string }): BoardRun => ({
  summary: null,
  phase: "running",
  step: null,
  outcome: null,
  prNumber: null,
  problem: false,
  createdAt: NOW,
  steps: [],
  ...over,
});

const STEPS = ["work", "review", "pr"];
const cellText = (cell: KanbanCell) => cell.segments.map((s) => s.text).join("");
const lineText = (cells: KanbanCell[]) => cells.map(cellText);
const STATUS_TONES: Tone[] = ["good", "warn", "bad", "info"];

describe("kanban board model", () => {
  it("puts eligible work in the ready column and each run under the step it is on", () => {
    const lanes = buildLanes(
      STEPS,
      [
        run({ key: "HF-12", step: "work", steps: [{ step: "work", done: false, startedAt: 700 }] }),
        run({ key: "HF-9", phase: "reviewing", step: "pr", prNumber: 41, createdAt: 100, steps: STEPS.map((step) => ({ step, done: true, startedAt: 100 })) }),
      ],
      [{ key: "HF-31", summary: "Fix login redirect" }],
      NOW,
    );

    expect(lanes.map((l) => l.title)).toEqual(["ready", "work", "review", "pr"]);
    expect(lanes.map((l) => l.cards.map((c) => c.key))).toEqual([["HF-31"], ["HF-12"], [], ["HF-9"]]);
    expect(lanes[0]!.cards[0]).toMatchObject({ kind: "ready", state: "ready", meta: null });
    // Time in the CURRENT step (300s), or the run's age once that step row is done (900s).
    expect(lanes[1]!.cards[0]).toMatchObject({ kind: "run", state: "working", meta: "5m" });
    expect(lanes[3]!.cards[0]).toMatchObject({ state: "review", meta: "#41 15m" });
  });

  it("parks a run with no step on its first unfinished step, and one past its last step under it", () => {
    const lanes = buildLanes(
      STEPS,
      [
        run({ key: "HF-1", phase: "claiming" }),
        run({ key: "HF-2", steps: [{ step: "work", done: true, startedAt: 100 }] }),
        run({ key: "HF-3", steps: STEPS.map((step) => ({ step, done: true, startedAt: 100 })) }),
      ],
      [],
      NOW,
    );

    expect(lanes.map((l) => l.cards.map((c) => c.key))).toEqual([[], ["HF-1"], ["HF-2"], ["HF-3"]]);
    expect(lanes[1]!.cards[0]!.state).toBe("starting");
  });

  it("ranks a failure outcome and the needs-a-human parks over the phase", () => {
    expect(cardState({ phase: "running", outcome: null })).toBe("working");
    expect(cardState({ phase: "running", outcome: "abandoned" })).toBe("failed");
    expect(cardState({ phase: "reviewing", outcome: "timeout" })).toBe("failed");
    expect(cardState({ phase: "attention", outcome: null })).toBe("attention");
    expect(cardState({ phase: "waiting_for_human", outcome: null })).toBe("waiting");
    expect(cardState({ phase: "reviewing", outcome: null })).toBe("review");
    expect(cardState({ phase: "tearing_down", outcome: "merged" })).toBe("done");
  });
});

describe("kanban layout", () => {
  const lanes = () =>
    buildLanes(
      STEPS,
      [
        run({ key: "HF-12", summary: "Improve the dashboard", step: "work", steps: [{ step: "work", done: false, startedAt: 700 }] }),
        run({ key: "HF-9", summary: "Cache the query", phase: "reviewing", step: "pr", prNumber: 41, problem: true, createdAt: 100, steps: STEPS.map((step) => ({ step, done: true, startedAt: 100 })) }),
      ],
      [{ key: "HF-31", summary: "Fix login redirect" }],
      NOW,
    );

  it("lays the columns side by side with a header, a rule, and one line per card row", () => {
    const lines = layoutKanban(lanes(), 100); // 4 columns of 23, gap 2 ⇒ x = 0/25/50/75
    expect(lines).toHaveLength(3);

    expect(lines[0]!.map((c) => c.x)).toEqual([0, 25, 50, 75]);
    expect(lines[0]!.every((c) => c.width === 23)).toBe(true);
    // Column titles sit flush with the rule beneath them; the cards are inset by the selection gutter.
    expect(lineText(lines[0]!)).toEqual([
      "ready · 1              ",
      "work · 1               ",
      "review · 0             ",
      "pr · 1                 ",
    ]);
    expect(lineText(lines[1]!)).toEqual(Array(4).fill("─".repeat(23)));

    // Only lanes holding a card at this row emit a cell — "review" is empty, so it contributes nothing
    // and the renderer pads to each cell's own x.
    expect(lines[2]!.map((c) => [c.lane, c.card, c.x])).toEqual([[0, 0, 0], [1, 0, 25], [3, 0, 75]]);
    expect(lineText(lines[2]!)).toEqual([
      "  ○ HF-31 Fix login re…",
      "  ● HF-12 Improve t… 5m",
      "  ◆ HF-9 Cac… #41 15m ⚠",
    ]);
  });

  it("wraps onto stacked lanes when the panel is too narrow for side-by-side columns", () => {
    const lines = layoutKanban(lanes(), 40);
    // One column ⇒ one shelf per lane, blank-separated: [header rule card] [·· header rule card] …
    expect(lines.map((cells) => cells.length)).toEqual([1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1]);
    expect(lines[0]!.every((c) => c.width === 40)).toBe(true);
    expect(cellText(lines[0]!.at(0)!)).toBe("ready · 1".padEnd(40));
    expect(cellText(lines[4]!.at(0)!)).toBe("work · 1".padEnd(40));
    expect(cellText(lines[6]!.at(0)!)).toBe("  ● HF-12 Improve the dashboard       5m");
  });

  it("sheds a card's meta before it truncates the work key", () => {
    const long = () => looseLane("keys", [run({ key: "PLATFORM-1024", summary: "A long summary", prNumber: 7 })], NOW);
    const card = (width: number) => layoutKanban([long()], width).at(2)!.at(0)!;

    expect(cellText(card(28))).toBe("  ● PLATFORM-1024 A l… #7 0s");
    // At the minimum width the key alone leaves no room for the meta, so the meta goes — the key is
    // what identifies the work, so it is the last thing to give.
    expect(cellText(card(MIN_COLUMN_WIDTH))).toBe("  ● PLATFORM-1024   ");
  });

  it("names the loose lane with a warning tone and keeps its runs as cards", () => {
    const lane = looseLane("unassigned (no belt)", [run({ key: "HF-5", phase: "attention" })], NOW);
    expect(lane.tone).toBe("warn");
    expect(lane.cards[0]!.state).toBe("attention");
    expect(layoutKanban([lane], 60)[0]![0]!.segments[0]!.tone).toBe("warn"); // the header title
  });

  it("pads every cell to exactly its column width, at any width", () => {
    for (const width of [MIN_COLUMN_WIDTH, 21, 37, 64, 80, 100, 137, 240]) {
      for (const cells of layoutKanban(lanes(), width)) {
        for (const cell of cells) {
          expect([...cellText(cell)]).toHaveLength(cell.width);
          expect(cell.x + cell.width).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("carries state in the icon only — never by tinting the whole card", () => {
    for (const cells of layoutKanban(lanes(), 100)) {
      for (const cell of cells.filter((c) => c.card !== null)) {
        // Segment 0 is the selection gutter, segment 1 the state icon, and a trailing ⚠ the problem
        // flag: those are the ONLY places a status color may appear. The key and summary stay in the
        // plain text hierarchy, whatever state the card is in.
        expect(cell.segments[1]!.text.trim()).toHaveLength(1);
        const flag = cell.segments.at(-1)!.text.trim() === "⚠" ? cell.segments.length - 1 : -1;
        cell.segments.forEach((segment, i) => {
          if (STATUS_TONES.includes(segment.tone)) expect([1, flag]).toContain(i);
        });
        expect(cell.segments[2]!.tone).toBe("primary"); // the work key
        expect(cell.segments[3]?.tone ?? "secondary").toBe("secondary"); // its summary
      }
    }
  });

  it("gives every state a distinct single-cell icon, and the legend explains the common ones", () => {
    const states: CardState[] = ["ready", "starting", "working", "waiting", "review", "attention", "failed", "done"];
    const icons = states.map((state) => stateIcon(state).icon);
    expect(new Set(icons).size).toBe(states.length);
    for (const icon of icons) expect([...icon]).toHaveLength(1); // one code point ⇒ one terminal cell
    expect(LEGEND.map((l) => l.state)).toEqual(["ready", "working", "review", "waiting", "attention", "done"]);
  });

  it("returns nothing to render for no lanes or no width", () => {
    expect(layoutKanban([], 80)).toEqual([]);
    expect(layoutKanban(lanes(), 0)).toEqual([]);
  });
});

describe("the compact board — one line per run, for a belt that has one or two", () => {
  it("puts the step, the age and the summary on the run's own line instead of spending five columns", () => {
    const lanes = buildLanes(
      ["work", "evidence", "review", "pr"],
      [run({ key: "54", summary: "nudge an idle agent", step: "work", createdAt: NOW - 2880 })],
      [],
      NOW,
    );
    const lines = compactBoard(lanes, 60);
    expect(lines, "one run ⇒ one line, no headers and no rule").toHaveLength(1);
    const text = cellText(lines[0]![0]!);
    expect(text).toContain("● 54");
    expect(text).toContain("work");
    expect(text).toContain("48m");
    expect(text).toContain("nudge an idle agent");
    expect(text.length, "cells pad to their full width, as the grid's do").toBe(60);
  });

  it("keeps each cell's lane/card indices, so a click resolves exactly as it does on the grid", () => {
    const lanes = buildLanes(["work", "review"], [run({ key: "HF-9", step: "review" })], [{ key: "HF-10", summary: "unclaimed" }], NOW);
    const cells = compactBoard(lanes, 50).map((line) => line[0]!);
    expect(cells.map((c) => [c.lane, c.card])).toEqual([[0, 0], [2, 0]]);
    expect(lanes[cells[0]!.lane]!.cards[cells[0]!.card!]!.key).toBe("HF-10");
    expect(lanes[cells[1]!.lane]!.cards[cells[1]!.card!]!.key).toBe("HF-9");
  });

  it("sheds the summary rather than the key when the terminal is narrow", () => {
    const lanes = buildLanes(["work"], [run({ key: "HF-1234", summary: "a long summary nobody has room for", step: "work" })], [], NOW);
    const text = cellText(compactBoard(lanes, MIN_COLUMN_WIDTH)[0]![0]!);
    expect(text).toContain("HF-1234");
    expect(text.length).toBe(MIN_COLUMN_WIDTH);
  });
});
