import { describe, expect, it } from "vitest";
import { formatWorkItemDetail, type WorkItemDetail } from "../src/tui/work-detail.ts";

const find = (lines: string[], needle: string | RegExp) =>
  lines.find((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));

describe("work item detail panel", () => {
  it("renders overview, belt step progress with timing, and the timeline", () => {
    const detail: WorkItemDetail = {
      key: "HF-42",
      summary: "Add a widget",
      issueType: "Task",
      workSource: "jira",
      belt: "ship",
      branch: "feature/hf-42",
      phase: "running",
      step: "review",
      prNumber: 7,
      outcome: null,
      worker: "working",
      attentionReason: null,
      problem: null,
      createdAt: 1000, // epoch seconds
      beltSteps: ["work", "review", "pr"],
      steps: [
        { step: "work", done: true, startedAt: 1000, doneAt: 1120, pass: 1 }, // 120s == 2m
        { step: "review", done: false, startedAt: 1200, doneAt: null, pass: 2 },
      ],
    };
    // now = 1300s in ms → age 300s (5m); review running for 100s → "1m" (largest-two-units).
    const lines = formatWorkItemDetail(detail, ["2026  claimed", "2026  step_done  work"], 1300 * 1000);

    expect(lines[0]).toBe("Overview");
    expect(find(lines, /summary: +Add a widget$/)).toBeTruthy();
    expect(find(lines, /type: +Task$/)).toBeTruthy();
    expect(find(lines, /source: +jira · belt ship$/)).toBeTruthy();
    expect(find(lines, /branch: +feature\/hf-42$/)).toBeTruthy();
    expect(find(lines, /status: +running · step review$/)).toBeTruthy();
    expect(find(lines, /worker: +working$/)).toBeTruthy();
    expect(find(lines, /PR: +#7$/)).toBeTruthy();
    expect(find(lines, /age: +5m$/)).toBeTruthy();

    // Belt order drives the step list; a not-yet-started step still shows as pending.
    expect(find(lines, /^ {2}✓ work +done {2}\(2m\)$/)).toBeTruthy();
    expect(find(lines, /^ {2}● review +running {2}\(1m\) {2}· pass 2$/)).toBeTruthy();
    expect(find(lines, /^ {2}○ pr +pending$/)).toBeTruthy();

    expect(lines).toContain("Timeline");
    expect(lines).toContain("  2026  claimed");
    expect(lines).toContain("  2026  step_done  work");
  });

  it("omits absent fields, surfaces attention + problem, and falls back to run steps when the belt is unknown", () => {
    const detail: WorkItemDetail = {
      key: "HF-1",
      summary: null,
      issueType: null,
      workSource: null,
      belt: null,
      branch: null,
      phase: "waiting_for_human",
      step: "work",
      prNumber: null,
      outcome: null,
      worker: null,
      attentionReason: "asked a human: which API?",
      problem: { detail: "evidence not uploaded — AWS creds" },
      createdAt: null,
      beltSteps: [], // belt renamed out from under the run → fall back to its own step rows
      steps: [{ step: "work", done: false, startedAt: null, doneAt: null, pass: 1 }],
    };
    const lines = formatWorkItemDetail(detail, [], 0);

    expect(find(lines, /summary: +\(no summary\)$/)).toBeTruthy();
    expect(find(lines, /^ {2}type:/)).toBeFalsy(); // no type when unknown
    expect(find(lines, /^ {2}worker:/)).toBeFalsy();
    expect(find(lines, /^ {2}PR:/)).toBeFalsy();
    expect(find(lines, /^ {2}age:/)).toBeFalsy();
    expect(find(lines, /source: +\?$/)).toBeTruthy();
    expect(find(lines, /status: +waiting for human · step work$/)).toBeTruthy();
    expect(lines).toContain("  ⚠ attention: asked a human: which API?");
    expect(lines).toContain("  ⚠ problem: evidence not uploaded — AWS creds");
    expect(find(lines, /^ {2}● work +waiting for human$/)).toBeTruthy();
    expect(lines).toContain("  (no events)");
  });

  it("renders the explain narrative between the overview and the steps, indenting non-blank lines", () => {
    const detail: WorkItemDetail = {
      key: "HF-9",
      summary: "A thing",
      issueType: null,
      workSource: "jira",
      belt: "ship",
      branch: null,
      phase: "attention",
      step: "work",
      prNumber: null,
      outcome: null,
      worker: null,
      attentionReason: "work step over budget",
      problem: null,
      createdAt: null,
      beltSteps: ["work"],
      steps: [{ step: "work", done: false, startedAt: null, doneAt: null, pass: 1 }],
      explain: ["The run is parked: the work step ran past its time budget.", "", "Next:", "  herdr-factory --repo proj resume HF-9"],
    };
    const lines = formatWorkItemDetail(detail, [], 0);
    const heading = lines.indexOf("What's happening");
    expect(heading).toBeGreaterThan(0);
    expect(heading).toBeLessThan(lines.indexOf("Steps"));
    expect(lines).toContain("  The run is parked: the work step ran past its time budget.");
    expect(lines[heading + 2]).toBe(""); // blank narrative lines stay blank, not indented
    expect(lines).toContain("    herdr-factory --repo proj resume HF-9");
  });

  it("omits the section when the narrative is absent", () => {
    const detail: WorkItemDetail = {
      key: "HF-9",
      summary: null,
      issueType: null,
      workSource: null,
      belt: null,
      branch: null,
      phase: "running",
      step: null,
      prNumber: null,
      outcome: null,
      worker: null,
      attentionReason: null,
      problem: null,
      createdAt: null,
      beltSteps: [],
      steps: [],
    };
    expect(formatWorkItemDetail(detail, [], 0)).not.toContain("What's happening");
  });
});
