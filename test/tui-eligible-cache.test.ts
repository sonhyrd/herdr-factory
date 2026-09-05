import { describe, expect, it } from "vitest";
import type { ActiveRun, EligibleItem } from "../src/tui/api.ts";
import { foldEligible, withoutClaimed, type EligibleResult } from "../src/tui/eligible-cache.ts";

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

const cacheOf = (m: Record<string, EligibleItem[]>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, { eligible: v }]));
const keysIn = (c: Map<string, { eligible: EligibleItem[] }>, repo: string) =>
  (c.get(repo)?.eligible ?? []).map((i) => i.key);

describe("foldEligible — carry-forward cache", () => {
  it("replaces the cached value on a successful (non-null) result", () => {
    const cache = cacheOf({ r: [item({ key: "a" })] });
    foldEligible(cache, ["r"], [{ eligible: [item({ key: "b" }), item({ key: "c" })] }]);
    expect(keysIn(cache, "r")).toEqual(["b", "c"]);
  });

  it("clears rows on a successful EMPTY result (genuinely-claimed items go away)", () => {
    const cache = cacheOf({ r: [item({ key: "a" })] });
    foldEligible(cache, ["r"], [{ eligible: [] }]);
    expect(keysIn(cache, "r")).toEqual([]);
  });

  it("keeps the last good value when the query FAILED (null) — the anti-flicker behavior", () => {
    const cache = cacheOf({ r: [item({ key: "a" }), item({ key: "b" })] });
    foldEligible(cache, ["r"], [null]);
    expect(keysIn(cache, "r")).toEqual(["a", "b"]);
  });

  it("leaves a never-seen repo absent when its first query fails (nothing to carry)", () => {
    const cache = cacheOf({});
    foldEligible(cache, ["r"], [null]);
    expect(cache.has("r")).toBe(false);
  });

  it("handles a mixed round — success replaces, failure holds, independently per repo", () => {
    const cache = cacheOf({ a: [item({ key: "old-a" })], b: [item({ key: "old-b" })] });
    const fresh: EligibleResult[] = [{ eligible: [item({ key: "new-a" })] }, null];
    foldEligible(cache, ["a", "b"], fresh);
    expect(keysIn(cache, "a")).toEqual(["new-a"]);
    expect(keysIn(cache, "b")).toEqual(["old-b"]);
  });

  it("prunes repos that are no longer configured", () => {
    const cache = cacheOf({ gone: [item({ key: "x" })], kept: [item({ key: "y" })] });
    foldEligible(cache, ["kept"], [{ eligible: [item({ key: "y" })] }]);
    expect(cache.has("gone")).toBe(false);
    expect(cache.has("kept")).toBe(true);
  });

  it("mutates and returns the same map instance", () => {
    const cache = cacheOf({});
    expect(foldEligible(cache, [], [])).toBe(cache);
  });
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
