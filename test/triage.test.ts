// The triage briefing composer (cli/triage.ts) — pure over its input, so the interactive launch
// needs no test double: everything the agent reads is asserted here.
import { describe, expect, it } from "vitest";
import { composeTriageBriefing, triagePrompt, type TriageBriefingInput } from "../src/cli/triage.ts";

const input = (over: Partial<TriageBriefingInput> = {}): TriageBriefingInput => ({
  repoName: "proj",
  run: {
    ticketKey: "HF-7",
    id: 42,
    phase: "attention",
    step: "work",
    belt: "ship",
    workSource: "jira",
    branch: "fix/HF-7-thing-ab12",
    worktreePath: "/tmp/wt/HF-7",
  },
  explainLines: ["HF-7 — run #42 on belt ship (attention)", "", "The run is parked: the work step ran past its time budget."],
  timelineLines: ["t1  claimed", "t2  step_spawned", "t3  attention"],
  configRepoDir: "/home/u/.config/herdr-factory/repos/proj",
  skillDir: "/app/skills/herdr-factory",
  ...over,
});

describe("composeTriageBriefing", () => {
  it("embeds the explain narrative, events, locations, playbooks, and ground rules", () => {
    const b = composeTriageBriefing(input());
    expect(b).toContain("# herdr-factory triage — HF-7");
    expect(b).toContain("The run is parked: the work step ran past its time budget.");
    expect(b).toContain("t3  attention");
    expect(b).toContain("obligations?key=HF-7");
    expect(b).toContain("- worktree: /tmp/wt/HF-7");
    expect(b).toContain("/tmp/wt/HF-7/.memory/herdr-factory");
    expect(b).toContain("- repo config: /home/u/.config/herdr-factory/repos/proj");
    expect(b).toContain("/app/skills/herdr-factory/references/troubleshooting.md");
    expect(b).toContain("herdr-factory --repo proj resume HF-7");
    expect(b).toContain("NEVER run `teardown`");
  });

  it("keeps only the last 15 event lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `t${i}  event`);
    const b = composeTriageBriefing(input({ timelineLines: lines }));
    expect(b).not.toContain("t24  event");
    expect(b).toContain("t25  event");
    expect(b).toContain("t39  event");
  });

  it("handles a run with no worktree and no events", () => {
    const b = composeTriageBriefing(input({ run: { ...input().run, worktreePath: null }, timelineLines: [] }));
    expect(b).toContain("- worktree: (none — not created yet, or already torn down)");
    expect(b).not.toContain(".memory/herdr-factory (rendered prompts");
    expect(b).toContain("(no events recorded)");
  });
});

describe("triagePrompt", () => {
  it("points at the briefing and forbids unconfirmed mutations", () => {
    const p = triagePrompt("/tmp/briefing.md", "HF-7");
    expect(p).toContain("Read /tmp/briefing.md");
    expect(p).toContain("HF-7");
    expect(p).toContain("without my explicit OK");
  });
});
