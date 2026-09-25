import { describe, it, expect } from "vitest";
import { followEventExtra, formatFollowEvent } from "../src/cli/run.ts";
import type { RepoEvent } from "../src/types.ts";

const ev = (over: Partial<RepoEvent>): RepoEvent => ({ id: 1, ts: 1_700_000_000, type: "claimed", detail: null, ticketKey: "APP-1", ...over });

describe("followEventExtra — the per-type trailer pulled from event detail", () => {
  it("renders the meaningful field for the common event types", () => {
    expect(followEventExtra("claimed", JSON.stringify({ belt: "ship", source: "jira" }))).toBe("jira → ship");
    expect(followEventExtra("step_spawned", JSON.stringify({ step: "work" }))).toBe("work");
    expect(followEventExtra("step_done", JSON.stringify({ step: "review", pass: 2 }))).toBe("review");
    expect(followEventExtra("bounced", JSON.stringify({ toStep: "work" }))).toBe("→ work");
    expect(followEventExtra("bounced", JSON.stringify({ toStep: "work", reason: "\n tests fail \nmore" }))).toBe("→ work — tests fail");
    expect(followEventExtra("rework", JSON.stringify({ fromStep: "pr", toStep: "work", pass: 2, reason: "CI red" }))).toBe("pr → work (pass 2) — CI red");
    expect(followEventExtra("transition", JSON.stringify({ to: "in_review" }))).toBe("in_review");
    expect(followEventExtra("pr_opened", JSON.stringify({ number: 42 }))).toBe("#42");
    expect(followEventExtra("torn_down", JSON.stringify({ outcome: "merged" }))).toBe("merged");
    expect(followEventExtra("attention", JSON.stringify({ reason: "budget_exceeded" }))).toBe("budget_exceeded");
    expect(followEventExtra("resolver_woken", JSON.stringify({ unresolved: 2, failing: 1 }))).toBe("2 unresolved · 1 failing");
    expect(followEventExtra("evidence_uploaded", JSON.stringify({ files: 3 }))).toBe("3 file(s)");
    expect(followEventExtra("error", JSON.stringify({ message: "boom" }))).toBe("boom");
    expect(followEventExtra("belt_reassigned", JSON.stringify({ from: "a", to: "b" }))).toBe("a → b");
  });

  it("never throws on missing / malformed / partial detail — returns empty", () => {
    expect(followEventExtra("claimed", null)).toBe("");
    expect(followEventExtra("step_spawned", "not json{")).toBe("");
    expect(followEventExtra("pr_opened", JSON.stringify({}))).toBe(""); // field absent
    expect(followEventExtra("claimed", JSON.stringify("a bare string"))).toBe(""); // non-object detail
    expect(followEventExtra("some_unknown_type", JSON.stringify({ x: 1 }))).toBe("");
  });
});

describe("formatFollowEvent — the streamed line", () => {
  it("includes the ticket, a friendly label, and the trailer", () => {
    const line = formatFollowEvent(ev({ type: "step_done", detail: JSON.stringify({ step: "work" }), ticketKey: "APP-7" }));
    expect(line).toContain("APP-7");
    expect(line).toContain("✓ step done");
    expect(line).toContain("— work");
  });

  it("falls back to the raw type for an unknown event and shows — for a null ticket", () => {
    const line = formatFollowEvent(ev({ type: "mystery_event", ticketKey: null, detail: null }));
    expect(line).toContain("mystery_event");
    expect(line).toContain("—"); // placeholder for a run-id-less / keyless event
  });
});
