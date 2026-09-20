import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPath, isClaudeAgent, trustWorktreeInClaude } from "../src/core/claude-trust.ts";

const tmps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hf-claude-"));
  tmps.push(d);
  return d;
};

// The suite-wide throwaway config dir (test/helpers/setup-env.ts) — restored, never unset.
const SUITE_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = SUITE_CLAUDE_CONFIG_DIR;
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
});

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

describe("claudeConfigPath", () => {
  it("prefers $CLAUDE_CONFIG_DIR over $HOME", () => {
    process.env.CLAUDE_CONFIG_DIR = "/cfg";
    expect(claudeConfigPath()).toBe("/cfg/.claude.json");
    delete process.env.CLAUDE_CONFIG_DIR; // restored by afterEach
    expect(claudeConfigPath()).toBe(join(homedir(), ".claude.json"));
  });
});

describe("isClaudeAgent", () => {
  it("is true for the claude kind/command and false for other harnesses", () => {
    expect(isClaudeAgent("claude")).toBe(true);
    expect(isClaudeAgent("/opt/homebrew/bin/claude")).toBe(true);
    expect(isClaudeAgent("opencode")).toBe(false);
    expect(isClaudeAgent("cursor-agent")).toBe(false);
  });
});

describe("trustWorktreeInClaude", () => {
  it("sets the worktree's trust key and KEEPS every other key", () => {
    const dir = tmp();
    const cfgPath = join(dir, ".claude.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        numStartups: 7,
        oauthAccount: { emailAddress: "someone@example.com" },
        projects: {
          "/home/u/.herdr/worktrees": { hasTrustDialogAccepted: true },
          "/home/u/other": { hasTrustDialogAccepted: true, history: [{ display: "hi" }] },
        },
      }),
    );
    expect(trustWorktreeInClaude("/home/u/.herdr/worktrees/demo/feat-1", cfgPath)).toEqual({ status: "set", path: cfgPath });
    const cfg = read(cfgPath);
    expect(cfg.projects["/home/u/.herdr/worktrees/demo/feat-1"]).toEqual({ hasTrustDialogAccepted: true });
    // Nothing else moved: unrelated top-level keys and the other projects' own state survive.
    expect(cfg.numStartups).toBe(7);
    expect(cfg.oauthAccount).toEqual({ emailAddress: "someone@example.com" });
    expect(cfg.projects["/home/u/other"]).toEqual({ hasTrustDialogAccepted: true, history: [{ display: "hi" }] });
  });

  it("keeps the project's OTHER keys when it already has an entry", () => {
    const cfgPath = join(tmp(), ".claude.json");
    writeFileSync(cfgPath, JSON.stringify({ projects: { "/wt": { allowedTools: ["Bash"], hasTrustDialogAccepted: false } } }));
    expect(trustWorktreeInClaude("/wt", cfgPath).status).toBe("set");
    expect(read(cfgPath).projects["/wt"]).toEqual({ allowedTools: ["Bash"], hasTrustDialogAccepted: true });
  });

  it("creates a missing config file (and its directory)", () => {
    const cfgPath = join(tmp(), "nested", ".claude.json");
    expect(trustWorktreeInClaude("/wt", cfgPath)).toEqual({ status: "set", path: cfgPath });
    expect(read(cfgPath)).toEqual({ projects: { "/wt": { hasTrustDialogAccepted: true } } });
  });

  it("an already-trusted worktree is a no-op", () => {
    const cfgPath = join(tmp(), ".claude.json");
    writeFileSync(cfgPath, JSON.stringify({ projects: { "/wt": { hasTrustDialogAccepted: true } } }));
    const before = readFileSync(cfgPath, "utf8");
    expect(trustWorktreeInClaude("/wt", cfgPath)).toEqual({ status: "already", path: cfgPath });
    expect(readFileSync(cfgPath, "utf8")).toBe(before); // not rewritten
  });

  it("a config we cannot parse is reported, NOT rewritten (it is the user's whole claude state)", () => {
    const dir = tmp();
    const cfgPath = join(dir, ".claude.json");
    writeFileSync(cfgPath, "{ this is not json");
    const res = trustWorktreeInClaude("/wt", cfgPath);
    expect(res.status).toBe("failed");
    expect(readFileSync(cfgPath, "utf8")).toBe("{ this is not json");
    expect(readdirSync(dir)).toEqual([".claude.json"]); // no temp file left behind
  });
});
