// The doctor's agent-tooling checks (issue #49): the harnesses + skills a belt actually shells out
// to — cursor-agent, the `--model` ids in the config, the skills the prompts name, and `ocr`. The
// point is that none of these fail loudly on their own, so each must be a ✗ with a fix hint — and
// each must report "not configured" (never ✗) on a host whose config doesn't ask for it.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTooling, agentToolingChecks, skillNamesIn, type AgentTooling, type DoctorCheck } from "../src/doctor.ts";
import type { Config } from "../src/config.ts";

const tmps: string[] = [];
const origHome = process.env.HOME;
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

/** A fake $HOME holding the named skills under each engine's root. */
function withSkills(skills: Record<string, string[]>): void {
  const home = mkdtempSync(join(tmpdir(), "doc-skills-"));
  tmps.push(home);
  for (const [root, names] of Object.entries(skills)) {
    for (const n of names) {
      mkdirSync(join(home, root, n), { recursive: true });
      writeFileSync(join(home, root, n, "SKILL.md"), "# skill\n");
    }
  }
  process.env.HOME = home;
}

function tooling(over: Partial<AgentTooling> = {}): AgentTooling {
  return { engines: new Set(["cursor"]), cursorModels: new Set<string>(), skills: new Map(), ...over };
}
const byName = (checks: DoctorCheck[], name: string) => checks.find((c) => c.name.startsWith(name))!;

describe("skillNamesIn — tight enough that prose can't invent a skill", () => {
  it("reads a skills-root path and a bolded name before the word skill", () => {
    expect(skillNamesIn("Follow `~/.claude/skills/to-spec/SKILL.md`, with these overrides")).toEqual(["to-spec"]);
    expect(skillNamesIn("Use the **pr-review** skill on that PR.")).toEqual(["pr-review"]);
    expect(skillNamesIn("~/.cursor/skills/pw-prove/SKILL.md")).toEqual(["pw-prove"]);
  });

  it("ignores prose that merely mentions skills", () => {
    // The real false positive this pattern was tightened for (src/prompts/pr.md).
    expect(skillNamesIn("release skills/commands under `.claude/`, and any PR runbook")).toEqual([]);
    expect(skillNamesIn("the repo's own review skills or commands (e.g. a `code-review` skill)")).toEqual([]);
    expect(skillNamesIn("list the repo's own skill directories yourself (`.claude/skills/`)")).toEqual([]);
  });
});

describe("agentTooling — what a loaded config asks of this host", () => {
  const config = {
    agent: { command: "cursor-agent", kind: "cursor", flags: ["--force", "--model", "claude-opus-5-thinking-medium"] },
    paths: { repoDir: "/nope" },
    layouts: [
      {
        id: "fork",
        tabs: [
          { title: "work", panes: [{ title: "agent", agent: { kind: "claude", args: ["--model", "opus"] } }] },
          { title: "review", panes: [{ title: "agent", agent: { kind: "cursor", args: ["--model=cursor-grok-4.6-high"] } }] },
        ],
      },
    ],
    belts: [
      {
        name: "ship",
        defaultLayout: "fork",
        steps: [
          { name: "work", tab: "work", pane: "agent", enginePrompt: "Use the **to-spec** skill." },
          { name: "review", tab: "review", pane: "agent", enginePrompt: "Use the **pr-review** skill." },
        ],
      },
    ],
  } as unknown as Config;

  it("collects Cursor model ids from panes and harnesses, and skips Claude's namespace", () => {
    const t = agentTooling(config);
    expect([...t.cursorModels].sort()).toEqual(["claude-opus-5-thinking-medium", "cursor-grok-4.6-high"]);
    expect(t.cursorModels.has("opus")).toBe(false); // `--model opus` is Claude Code's, not Cursor's
    expect([...t.engines].sort()).toEqual(["claude", "cursor"]);
  });

  it("files each prompt's skills under the engine of the pane that runs the step", () => {
    const t = agentTooling(config);
    expect([...(t.skills.get("claude") ?? [])]).toEqual(["to-spec"]);
    expect([...(t.skills.get("cursor") ?? [])]).toEqual(["pr-review"]);
  });
});

describe("agentToolingChecks — gates and failures", () => {
  it("a host whose belts never run Cursor is not failed", async () => {
    const checks = await agentToolingChecks(tooling({ engines: new Set(["claude"]) }), true);
    const cursor = byName(checks, "cursor-agent");
    expect(cursor.ok).toBe(true);
    expect(cursor.detail).toContain("not configured");
    expect(byName(checks, "ocr").detail).toContain("not configured");
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("deep: a renamed skill directory is a ✗ naming the path and the engine root", async () => {
    withSkills({ ".cursor/skills": ["pr-review"] });
    const skills = new Map([["cursor", new Set(["pr-review", "pw-prove"])]]);
    const checks = await agentToolingChecks(tooling({ skills }), true);
    const c = byName(checks, "agent skills");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("pw-prove missing at ~/.cursor/skills/pw-prove/SKILL.md");
    expect(c.detail).not.toContain("pr-review missing");
  });

  it("deep: every named skill present → ✓ listing them", async () => {
    withSkills({ ".cursor/skills": ["pr-review"], ".claude/skills": ["to-spec"] });
    const skills = new Map([
      ["cursor", new Set(["pr-review"])],
      ["claude", new Set(["to-spec"])],
    ]);
    const checks = await agentToolingChecks(tooling({ skills }), true);
    const c = byName(checks, "agent skills");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("pr-review");
    expect(c.detail).toContain("to-spec");
  });

  it("plain doctor invokes nothing: models are reported, not verified", async () => {
    const checks = await agentToolingChecks(tooling({ cursorModels: new Set(["cursor-grok-4.6-high"]) }), false);
    const c = byName(checks, "cursor models");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("--deep to verify");
    expect(byName(checks, "agent skills").detail).toContain("none named");
  });

  it("ocr is only required once a prompt names pr-review", async () => {
    const withPrReview = await agentToolingChecks(tooling({ skills: new Map([["cursor", new Set(["pr-review"])]]) }), false);
    expect(byName(withPrReview, "ocr").detail ?? "").not.toContain("not configured"); // checked for real (✓/✗ depends on the host)
    const without = await agentToolingChecks(tooling({ skills: new Map([["cursor", new Set(["pw-prove"])]]) }), false);
    expect(byName(without, "ocr").detail).toContain("not configured");
  });
});
