// Claude Code's folder-trust prompt, pre-answered for a worktree.
//
// A fresh worktree can stop `claude` at "Is this a project you created or one you trust?". herdr then
// can't adopt the agent (`agent_not_ready: … blocked during startup`) and the step that targets that
// pane burns its whole layout wait for an agent that is sitting on a prompt nobody will answer.
//
// Claude records the answer per project folder in `projects[<path>].hasTrustDialogAccepted`. Accepting
// the PARENT (`~/.herdr/worktrees`) is not enough — observed honoured on one host and ignored on
// another — so the factory trusts the worktree path ITSELF before starting a claude agent in it.
//
// The file is Claude's own live config: read → set the ONE key → write a temp file → rename, keeping
// every other key. Running claude processes rewrite it too, so the read sits immediately before the
// write (last writer wins; a lost update costs one re-trust on the next start, which is why this is
// called on every start rather than once).
// ponytail: no lock — atomic-rename + one-key edit is the cheapest thing that can't truncate the file.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Is this agent kind/command Claude Code (the only harness with the folder-trust prompt)? */
export const isClaudeAgent = (kindOrCommand: string): boolean => basename(kindOrCommand.trim()) === "claude";

/** Claude Code's config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(dir || homedir(), ".claude.json");
}

export type TrustResult =
  /** The key was written (the folder was untrusted, or the file didn't exist yet). */
  | { status: "set"; path: string }
  /** Already trusted — nothing written. */
  | { status: "already"; path: string }
  /** Left alone: unreadable/unparseable config, or the write failed. Callers log and start anyway. */
  | { status: "failed"; path: string; detail: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Make `projects[worktreePath].hasTrustDialogAccepted` true in Claude's config. Never throws: a
 *  config we can't parse is NOT rewritten (it holds the user's whole Claude state) — the start is
 *  attempted anyway and the reason is logged. */
export function trustWorktreeInClaude(worktreePath: string, configPath: string = claudeConfigPath()): TrustResult {
  try {
    let cfg: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const text = readFileSync(configPath, "utf8").trim();
      if (text) {
        const parsed: unknown = JSON.parse(text);
        if (!isObject(parsed)) return { status: "failed", path: configPath, detail: "config is not a JSON object" };
        cfg = parsed;
      }
    }
    const projects = isObject(cfg.projects) ? cfg.projects : {};
    const entry = isObject(projects[worktreePath]) ? (projects[worktreePath] as Record<string, unknown>) : {};
    if (entry.hasTrustDialogAccepted === true) return { status: "already", path: configPath };
    const next = { ...cfg, projects: { ...projects, [worktreePath]: { ...entry, hasTrustDialogAccepted: true } } };
    mkdirSync(dirname(configPath), { recursive: true });
    const tmp = `${configPath}.hf-${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, configPath);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      throw e;
    }
    return { status: "set", path: configPath };
  } catch (e) {
    return { status: "failed", path: configPath, detail: e instanceof Error ? e.message : String(e) };
  }
}
