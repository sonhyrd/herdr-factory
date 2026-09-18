import { describe, expect, it } from "vitest";
import type { ActiveRun, EligibleItem } from "../src/tui/api.ts";
import { withoutClaimed } from "../src/tui/eligible-cache.ts";

const item = (over: Partial<EligibleItem> & { key: string }): EligibleItem => ({
  source: "markdown",
  belt: "work_to_main",
  summary: over.key,
  type: "task",
  ...over,
});

const run = (over: Partial<ActiveRun> & { ticketKey: string }): ActiveRun => ({
  id: 1,
  workSource: "markdown",
  belt: "work_to_main",
  issueType: null,
  worktreeName: null,
  branch: null,
  phase: "running",
  step: "work",
  prNumber: null,
  summary: null,
  outcome: null,
  attentionReason: null,
  worker: null,
  createdAt: null,
  steps: [],
  ...over,
});

describe("withoutClaimed — drop eligible items already running", () => {
  it("drops an eligible item that now has an active run (same source+key)", () => {
    const eligible = [item({ key: "a" }), item({ key: "b" })];
    const active = [run({ ticketKey: "a", workSource: "markdown" })];
    expect(withoutClaimed(eligible, active).map((i) => i.key)).toEqual(["b"]);
  });

  it("is source-scoped — same key under a different source is NOT dropped", () => {
    const eligible = [item({ key: "a", source: "jira" })];
    const active = [run({ ticketKey: "a", workSource: "markdown" })];
    expect(withoutClaimed(eligible, active).map((i) => i.key)).toEqual(["a"]);
  });

  it("returns everything when there are no active runs", () => {
    const eligible = [item({ key: "a" }), item({ key: "b" })];
    expect(withoutClaimed(eligible, [])).toHaveLength(2);
  });
});
