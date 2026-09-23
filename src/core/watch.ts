import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./deps.ts";
import type { Run, SourceType } from "../types.ts";
import { agentNameFor, MEMORY_DIR } from "./step.ts";
import { awaitShellPrompt } from "./layout.ts";
import { showRunPane } from "./pane-display.ts";
import { productCapabilityFor } from "../products/registry.ts";
import { SHIPPED_PROMPTS_DIR, packLayers, resolvePromptFile } from "../prompt-packs.ts";

/** Render the resolver prompt through the prompt-pack chain (repo-checkout ▸ config-folder ▸ shipped
 *  — src/prompt-packs.ts, mirroring the belt-step base prompts, so a user pack can override the
 *  resolver too) — substituting only the tokens the pull_request watch capability declares. */
function renderResolverPrompt(dirs: string[], slug: string, sourceType: SourceType | undefined, tokens: readonly string[], values: Record<string, string>): string {
  let body = resolvePromptFile(dirs, sourceType ?? "", slug, sourceType !== undefined)!.body;
  for (const t of tokens) body = body.replaceAll(t, () => values[t] ?? "");
  return body;
}

/**
 * Wake the PR-review resolver: render its (tokenized, source-overridable) library prompt into the
 * worktree, then point the agent at it — reusing the run's latest agent pane (the pr step) if alive,
 * else spawning a fresh one. The slug, its overridability, and the token set all come from the
 * pull_request watch capability's `WatchResolverSpec` (`src/products/registry.ts`), so the resolver
 * is a first-class library prompt (`prompts/resolver.md`) rather than a hardcoded string — dispatched
 * via a one-line "read it" pointer exactly like a belt step. Returns true if a resolver was
 * dispatched, false if the spawn failed (so the caller retries rather than marking the round handled).
 * `brief` is appended to the rendered prompt — a review verdict's findings (core/review-verdict.ts).
 */
export async function wakeResolver(deps: Deps, run: Run, prNumber: number, brief = ""): Promise<boolean> {
  const worktree = run.worktreePath;
  if (!run.workspaceId || !worktree) throw new Error(`${run.ticketKey}: cannot spawn resolver (no workspace)`);

  const { wakePrompt } = productCapabilityFor("pull_request").watch!.resolver;
  const sourceType = wakePrompt.perSourceOverride ? deps.resolveSource(run.workSource)?.type : undefined;
  const dirs = [...packLayers(worktree, deps.config.paths.repoDir), SHIPPED_PROMPTS_DIR];
  const body = renderResolverPrompt(dirs, wakePrompt.slug, sourceType, wakePrompt.tokens, {
    "@@KEY@@": run.ticketKey,
    "@@PR_NUMBER@@": String(prNumber),
  }) + brief; // a review verdict's findings (issue #86) ride after the user-overridable prompt
  const mem = join(worktree, MEMORY_DIR);
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, `prompt-${wakePrompt.slug}.md`), body);
  const instruction = `Read ${MEMORY_DIR}/prompt-${wakePrompt.slug}.md in this worktree and follow it exactly. This is an autonomous task — do not pause to ask for confirmation.`;

  if (run.paneId && (await deps.herdr.paneAlive(run.paneId))) {
    // Confirmed submission: an unconfirmed re-prompt means the resolver never woke, and the caller's
    // contract ("false ⇒ retry rather than marking the round handled") is exactly the right response.
    if (!(await deps.herdr.agentSend(run.paneId, instruction, { confirm: true }))) {
      deps.log("warn", `${run.ticketKey}: resolver prompt to ${run.paneId} was not confirmed for PR #${prNumber}`);
      return false;
    }
    await showRunPane(deps, run.paneId, { key: run.ticketKey, step: run.step, state: "watching" });
    deps.log("info", `${run.ticketKey}: re-prompted agent (${run.paneId}) to resolve PR #${prNumber}`);
    return true;
  }

  // The resolver runs in the SAME worktree as the pr step; give it the pr step's configured harness
  // (else the repo-level default) so a factory that spawns opencode/codex workers resolves review
  // rounds with the same agent. Byte-identical to before when no `agent:` block is set.
  const agent = deps.resolveBelt(run.belt)?.steps.find((s) => s.opensPr)?.agent ?? deps.config.agent;
  const pane = await deps.herdr.agentStart({
    workspaceId: run.workspaceId,
    cwd: worktree,
    argv: [agent.command, ...agent.flags, instruction],
    env: { HERDR_FACTORY_TICKET: run.ticketKey },
    // herdr's agent NAME (its charset rule bans the run's `<slug>:<KEY>` form); the readable identity
    // is published as pane display metadata just below.
    name: agentNameFor(wakePrompt.slug, run.ticketKey),
    kind: agent.kind,
    awaitShell: async (paneId) => void (await awaitShellPrompt(deps, paneId)),
  });
  if (!pane) {
    deps.log("warn", `${run.ticketKey}: resolver agentStart returned no pane for PR #${prNumber}`);
    return false;
  }
  await showRunPane(deps, pane, { key: run.ticketKey, step: wakePrompt.slug, state: "watching" });
  deps.store.updateRun(run.id, { paneId: pane });
  deps.log("info", `${run.ticketKey}: spawned fresh resolver for PR #${prNumber}`);
  return true;
}
