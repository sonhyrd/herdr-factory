// Global unit-test environment guard. Vitest runs these tests IN the developer's own environment, so
// anything that edits a real user-level config file has to be pointed somewhere harmless first.
//
// `CLAUDE_CONFIG_DIR`: the factory pre-answers Claude Code's folder-trust prompt for a worktree by
// editing `$CLAUDE_CONFIG_DIR/.claude.json` (else `~/.claude.json`) before starting a claude agent —
// see src/core/claude-trust.ts. Every test that exercises a spawn or a layout build would otherwise
// rewrite the developer's live Claude config.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "hf-test-claude-"));
