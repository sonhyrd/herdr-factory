import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StepConfig } from "../config.ts";
import type { BeltRuntime, Deps, SourceRuntime } from "./deps.ts";
import type { AgentConfig, Run, RunStep, SourceType } from "../types.ts";
import { DEFAULT_AGENT_CONFIG, isReadyForInput } from "../types.ts";
import { renderWorkVars } from "./branch.ts";
import { productActiveFor, type PromptStepContext, stripInactiveProductBlocks, validatePromptBody } from "../prompts/contract.ts";
import { guardsResetOn } from "../steps/guards.ts";
import { awaitShellPrompt } from "./layout.ts";
import { isClaudeAgent, trustWorktreeInClaude } from "./claude-trust.ts";
import { showRunPane } from "./pane-display.ts";
import { signalCommand } from "../signals/registry.ts";
import { REPO_PACK_SUBDIR, resolvePromptFile } from "../prompt-packs.ts";
import { telemetrySpan } from "../telemetry/index.ts";

// The prompt contract (token catalog, dataflow gating, user-prompt validation) lives in one leaf
// module so the config loader and the renderer share it without a cycle. Re-exported here because
// these two were historically step.ts's surface (and tests import them from it).
export { productActiveFor, stripInactiveProductBlocks } from "../prompts/contract.ts";

export const CLI_PATH = fileURLToPath(new URL("../../bin/herdr-factory", import.meta.url));
export const MEMORY_DIR = ".memory/herdr-factory";

// --- @@PR_TEMPLATE@@: the target repo's own pull-request template -----------
// Standard single-file locations GitHub honours, in priority order. Both the canonical uppercase
// name and the common lowercase spelling (GitHub matches case-insensitively) are tried at each base.
const PR_TEMPLATE_FILES = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];
// The multi-template directory (v1: pick the default/first `*.md`, alphabetically — no selection UI).
const PR_TEMPLATE_DIRS = [".github/PULL_REQUEST_TEMPLATE", "PULL_REQUEST_TEMPLATE", "docs/PULL_REQUEST_TEMPLATE"];

/** Best-effort read of the target repo's own PR template from the run's worktree. Returns the
 *  template text, or null when the repo ships none (or it can't be read). Never throws — a missing
 *  or unreadable template just drops the @@PR_TEMPLATE@@ clause, it is never an error. */
export function findPrTemplate(worktree: string): string | null {
  for (const rel of PR_TEMPLATE_FILES) {
    try {
      const p = join(worktree, rel);
      if (statSync(p).isFile()) {
        const t = readFileSync(p, "utf8");
        if (t.trim()) return t;
      }
    } catch {
      /* missing/unreadable → try the next candidate */
    }
  }
  for (const dir of PR_TEMPLATE_DIRS) {
    try {
      const abs = join(worktree, dir);
      if (!statSync(abs).isDirectory()) continue;
      for (const name of readdirSync(abs).filter((f) => f.toLowerCase().endsWith(".md")).sort()) {
        const t = readFileSync(join(abs, name), "utf8");
        if (t.trim()) return t; // v1: the default/first
      }
    } catch {
      /* missing/unreadable → try the next base */
    }
  }
  return null;
}

/** Fence `content` in a backtick block long enough to survive any backtick run inside it. */
function fenced(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${content}\n${fence}`;
}

/** The @@PR_TEMPLATE@@ value when a template was found: a sub-bullet under the PR step's "open the
 *  PR" item that tells the agent to fill the repo's own template faithfully, with the template
 *  reproduced verbatim. Empty string ⇒ the base summary+testing-notes wording applies unchanged. */
function prTemplateBlock(template: string): string {
  return (
    `\n   - **Fill the repo's own PR template.** This repository ships its own pull-request template ` +
    `(reproduced below). Fill it out faithfully — keep every section and heading, and replace the ` +
    `template's guidance/comments with real content for this change — instead of the generic ` +
    `summary+testing-notes shape above. Still include the evidence URLs and any \`Closing reference:\` ` +
    `line where the instructions here call for them. The template:\n\n${fenced(template.replace(/\s+$/, ""))}\n`
  );
}

/** Resolve @@COMMIT_CONVENTIONS@@: the repo's `conventions.commits` — short free text, or a file
 *  pointer (absolute, or relative to the repo's config folder) whose contents are used. Returns a
 *  formatted block when set, or "" (leaving no trace) when the key is unset or resolves to nothing.
 *  Best-effort: a value that looks like a path but isn't a readable file is used as literal text. */
function commitConventionsBlock(deps: Deps): string {
  const raw = deps.config.conventions?.commits?.trim();
  if (!raw) return "";
  let text = raw;
  try {
    const candidate = isAbsolute(raw) ? raw : join(deps.config.paths.repoDir, raw);
    if (statSync(candidate).isFile()) text = readFileSync(candidate, "utf8");
  } catch {
    /* not a readable file → treat the value as literal free text */
  }
  text = text.trim();
  if (!text) return "";
  return (
    `\n\n**Commit-message conventions** (configured for this repo — apply them to every commit message; ` +
    `where they disagree with a convention the repo's own docs suggest, these win):\n\n${text}`
  );
}

// --- @@PR_OPTIONS@@ / @@PR_AUTOMATED_ROUND@@: the belt-level `pr:` behavior block ----------------
// The belt's `pr:` policy is delivered as PROMPT instructions (not applied engine-side): the pr
// agent already runs `gh pr create` and can pass `--draft`/`--title`/`--label`/`--reviewer`/
// `--assignee` in one invocation, so the agent stays the single actor and everything it does is
// visible in its pane — no second, invisible engine-side adoption step racing the agent's own create
// (which would need its own gh calls, failure handling for missing labels/invalid reviewers, and
// reconciliation with what the agent already did). Labels/reviewers/assignees ride the same path as
// draft/title/automated_round for that reason. Both blocks are empty when the belt sets no `pr:`
// block, so an absent block leaves the pr prompt byte-identical to before.

/** A backtick-quoted, comma-joined list for prose: `["a","b"]` → `` `a`, `b` ``. */
function quotedList(xs: readonly string[]): string {
  return xs.map((x) => `\`${x}\``).join(", ");
}

/** Resolve @@PR_OPTIONS@@: the belt's PR opening policy (draft / title template / labels / reviewers
 *  / assignees) as sub-bullets under the pr step's "open the PR" item, naming the `gh pr create`
 *  flags to pass. The title reuses the `workspace_name` var renderer (branch.ts) so `{{work_id}}` &c.
 *  interpolate. Empty string (leaving no trace) when the belt sets no `pr:` block or none of these
 *  fields are set — that is what keeps an absent block byte-identical to before. */
export function prOptionsBlock(belt: BeltRuntime, run: Run): string {
  const pr = belt.pr;
  if (!pr) return "";
  const bullets: string[] = [];
  if (pr.draft) bullets.push("**Open it as a draft PR** — pass `--draft` to `gh pr create`.");
  if (pr.title) {
    const title = renderWorkVars(pr.title, { key: run.ticketKey, type: run.issueType ?? "", summary: run.summary ?? "" }, belt.branch);
    bullets.push(`**Use this exact PR title** (do not paraphrase it): \`${title}\``);
  }
  if (pr.labels?.length) bullets.push(`**Apply these labels** (\`--label\`, creating any that don't exist yet): ${quotedList(pr.labels)}`);
  if (pr.reviewers?.length) bullets.push(`**Request these reviewers** (\`--reviewer\`): ${quotedList(pr.reviewers)}`);
  if (pr.assignees?.length) bullets.push(`**Assign the PR** (\`--assignee\`): ${quotedList(pr.assignees)}`);
  if (!bullets.length) return "";
  return "\n" + bullets.map((b) => `   - ${b}`).join("\n");
}

/** Resolve @@PR_AUTOMATED_ROUND@@: the pr prompt's "automated round" step (CI/bot polling), sized by
 *  the belt's `pr.automated_round_minutes`. Unset ⇒ the ~10 min window baked before this block existed
 *  (byte-identical); a positive N ⇒ a ~N min window; 0 ⇒ SKIP the round entirely — open the PR and
 *  finish, letting the dispatcher's review watch take over. */
export function prAutomatedRoundBlock(belt: BeltRuntime): string {
  const mins = belt.pr?.automatedRoundMinutes;
  if (mins === 0) {
    return (
      "2. **No automated round for this belt.** Don't run a CI/bot polling round here — as soon as the PR is\n" +
      "   open, finish this step. The dispatcher watches the PR for CI and human review from here on."
    );
  }
  const window = mins != null ? `~${mins} min` : "~10 min";
  return (
    `2. **Wait for the automated round (${window}):** poll CI (\`gh pr checks <num>\`) and bot review\n` +
    "   comments; for each failure or bot thread, fix → commit → push → resolve, until everything is\n" +
    "   green or the time elapses. Only automated checks/bots in this window — human reviewers are\n" +
    "   watched by the dispatcher afterwards."
  );
}

// --- belt step sequencing (belt.steps is the ordered source of truth) -------

export const stepByName = (belt: BeltRuntime, name: string | null): StepConfig | undefined =>
  name == null ? undefined : belt.steps.find((s) => s.name === name);

/** The belt's first step (every belt has ≥1 — enforced by config). */
export const firstStep = (belt: BeltRuntime): StepConfig => belt.steps[0]!;

export const indexOfStep = (belt: BeltRuntime, name: string): number => belt.steps.findIndex((s) => s.name === name);

/** The step before `name` in this belt, or undefined if it's the first. */
export const priorStep = (belt: BeltRuntime, name: string): StepConfig | undefined => {
  const i = indexOfStep(belt, name);
  return i > 0 ? belt.steps[i - 1] : undefined;
};

/** The step after `name`, or undefined if it's the belt's last step (→ reviewing/teardown). */
export const nextStep = (belt: BeltRuntime, name: string): StepConfig | undefined => {
  const i = indexOfStep(belt, name);
  return i >= 0 && i < belt.steps.length - 1 ? belt.steps[i + 1] : undefined;
};

/** A herdr-legal agent name for a factory-spawned pane: `[a-z][a-z0-9_-]{0,31}`, unique among LIVE
 *  agents (herdr's rule — it rejects anything else with `invalid_agent_name`). Derived from the step +
 *  work key so it stays recognizable in `herdr agent list`; the display identity (`<step>:<KEY>`, with
 *  its real casing) is published separately as pane metadata. */
export function agentNameFor(step: string, key: string): string {
  const clean = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  return `${clean(step)}-${clean(key)}`.replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32).replace(/-+$/, "") || "agent";
}

const dispatchPrompt = (step: string): string =>
  `Read ${MEMORY_DIR}/prompt-${step}.md in this worktree and follow it exactly. This is an autonomous task — do not pause to ask for confirmation.`;

/** Result of one dispatch attempt: the agent got the prompt (`ready` + its pane), or the
 *  configured layout pane isn't up yet (`waiting`) so the caller should retry on a later tick. */
export type DispatchResult = { status: "ready"; paneId: string } | { status: "waiting" };

/**
 * Deliver `prompt` to a step's agent. Two modes, chosen by whether a `tab`/`pane` is configured:
 *
 *  - **Configured** (the user's layout owns this pane): find that pane and require an agent
 *    that is present AND idle, then `agent prompt` it (agent-agnostic — claude, opencode, …). If the
 *    pane isn't up yet, or its agent is still busy starting up, return
 *    `waiting` — we NEVER spawn our own when a tab/pane is configured; the caller waits (and
 *    eventually escalates to attention). This is what lets the user's auto-spawned layout
 *    (setup commands, dev servers, agent startup) settle before work begins.
 *    RE-ENTRY (bounce rework / forward re-advance after a bounce / crash respawn) passes the
 *    pane this step was ALREADY dispatched to as `knownPaneId` — the durable handle, which is
 *    preferred because it survives the pane being re-labelled by anything else. The configured
 *    label now stays valid across dispatches too (run state is published as display METADATA, not by
 *    renaming the pane — see core/pane-display.ts), so resolution is: a live `knownPaneId` → the
 *    configured label. A re-entry pane normally finished its prior pass and sits idle-at-prompt, so
 *    it skips the idle gate — but a pane that is actively `working` (mid-answer to an on-demand
 *    agent-send question, or human-driven) defers the dispatch to a later tick rather than queueing
 *    the prompt into a foreign turn.
 *  - **Not configured** (no tab/pane): spawn a dedicated pane ourselves (a new tab + the configured
 *    harness adopted into it). This is the only path that creates a pane.
 *
 * A delivered prompt is CONFIRMED (herdr reports whether the submission actually moved the agent);
 * an unconfirmed one is reported as `waiting` so the caller retries instead of starting the step's
 * budget clock against an agent that never got the work. Publishes `<step>:<key>` as the pane's
 * display name. Shared by all step agents.
 */
export async function dispatchToLayout(
  deps: Deps,
  opts: { workspaceId: string; worktree: string; tab?: string; pane?: string; prompt: string; step: string; ticketKey: string; knownPaneId?: string; agent: AgentConfig },
): Promise<DispatchResult> {
  return telemetrySpan(
    "step.dispatch",
    {
      repo: deps.config.repoName,
      "work.key": opts.ticketKey,
      "herdr.workspace_id": opts.workspaceId,
      "step.layout.configured": opts.tab != null && opts.pane != null,
      "step.layout.tab": opts.tab,
      "step.layout.pane": opts.pane,
    },
    () => dispatchToLayoutImpl(deps, opts),
  );
}

async function dispatchToLayoutImpl(
  deps: Deps,
  opts: { workspaceId: string; worktree: string; tab?: string; pane?: string; prompt: string; step: string; ticketKey: string; knownPaneId?: string; agent: AgentConfig },
): Promise<DispatchResult> {
  const paneName = `${opts.step}:${opts.ticketKey}`;
  if (opts.tab && opts.pane) {
    // Resolve this step's pane, in order (see the dispatchToLayout doc):
    //   1. the recorded pane id, if it's still a live agent — a re-entry's durable handle;
    //   2. the configured label — which now stays valid for the pane's whole life, because run state
    //      is published as display metadata instead of renaming the pane.
    //   3. DRAIN-WINDOW SHIM: the dispatch name `${step}:${key}`. Panes that the pre-metadata code
    //      RENAMED are still live in long-running worktrees across an upgrade; without this they'd be
    //      unresolvable and their runs would wedge in a layout wait. Delete once no pane can predate
    //      the switch (one release).
    // (1) and (3) are RE-ENTRIES: the pane already ran a pass, so it's idle-at-prompt — re-prompt it
    // directly, skipping the idle gate (mirrors bounceStep). Only a FRESH (2) pane must be present
    // AND idle before we send (its agent may still be starting up).
    let target: string | null = null;
    let reused = false;
    if (opts.knownPaneId != null && (await deps.herdr.paneAlive(opts.knownPaneId))) {
      target = opts.knownPaneId;
      reused = true;
    } else {
      target = await deps.herdr.tabPaneByLabel(opts.workspaceId, opts.tab, opts.pane);
      if (!target) {
        target = await deps.herdr.tabPaneByLabel(opts.workspaceId, opts.tab, paneName);
        reused = target != null;
      }
    }
    if (!target) return { status: "waiting" }; // the layout hasn't created this tab/pane yet
    const state = await deps.herdr.paneState(target);
    // Ready = sitting at its prompt (`idle`, or `done` having finished a turn — see isReadyForInput).
    // Anything else is no agent yet, one still starting up, one mid-turn, or one blocked on a prompt.
    if (!reused && !isReadyForInput(state)) return { status: "waiting" };
    // A re-entry pane is NORMALLY idle-at-prompt (it finished its prior pass) — but not always: a
    // later agent may have `agent send`-ed it an on-demand question (§7's handoff+query protocol)
    // and it's mid-answer, or a human is driving it. Queueing the re-dispatch into a busy turn
    // interleaves two conversations and starts the step budget while the pane works on something
    // else — defer instead. The pass stays undispatched, so the caller retries on later ticks
    // under the bounded layout wait until the pane comes back to idle.
    if (reused && state === "working") return { status: "waiting" };
    // No settle sleep and no separate Enter: `agent prompt` is atomic, and `confirm` makes herdr
    // report whether the submission actually moved the agent — backed by a pane-revision probe for
    // the harnesses whose state herdr never flips (see agentSend). An unconfirmed prompt (a
    // just-started agent that dropped the keystrokes, with a pane that did not react either) is
    // reported as `waiting` — the pass stays undispatched and retries under the bounded layout wait,
    // instead of starting the step's budget clock against an agent that never received the work.
    if (!(await deps.herdr.agentSend(target, opts.prompt, { confirm: true }))) {
      deps.log("warn", `${opts.ticketKey}: prompt to layout pane ${target} was not confirmed; will retry`);
      return { status: "waiting" };
    }
    await showRunPane(deps, target, { key: opts.ticketKey, step: opts.step, state: "running" });
    deps.log("info", `${opts.ticketKey}: ${reused ? "re-dispatched to reused" : "dispatched to layout"} pane ${target} (${opts.tab}/${opts.pane})`);
    return { status: "ready", paneId: target };
  }

  // No tab/pane configured for this step → a dedicated pane. A RE-ENTRY (bounce rework, forward
  // re-advance after a bounce) re-prompts the step's own live pane — its agent holds the step's
  // context, and starting a second dedicated agent for the same step would pile up a duplicate
  // pane per rework cycle. Only with no live known pane (first entry, or the pane died) does this
  // path START one — still the only path that creates a pane. Unlike the configured branch above,
  // a busy dedicated pane is NOT deferred: dedicated steps carry no layout-wait guard to bound the
  // deferral, and the factory-owned agent queues the message for after its current turn — the
  // lesser evil vs. a human park.
  if (opts.knownPaneId != null && (await deps.herdr.paneAlive(opts.knownPaneId))) {
    // A dedicated pane is factory-owned, so an unconfirmed submission here is NOT deferred the way a
    // layout pane's is: this pane carries no layout-wait guard to bound the retry, and the agent
    // queues a message sent mid-turn. Log it and treat the dispatch as made (the budget watchdog is
    // the backstop) — the confirmation is a signal, not a gate, on this path.
    if (!(await deps.herdr.agentSend(opts.knownPaneId, opts.prompt, { confirm: true }))) {
      deps.log("warn", `${opts.ticketKey}: prompt to dedicated pane ${opts.knownPaneId} was not confirmed`);
    }
    await showRunPane(deps, opts.knownPaneId, { key: opts.ticketKey, step: opts.step, state: "running" });
    deps.log("info", `${opts.ticketKey}: re-dispatched to reused dedicated pane ${opts.knownPaneId}`);
    return { status: "ready", paneId: opts.knownPaneId };
  }
  // The configured harness for this spawned pane: [command, ...flags, prompt]. argv[0] is the
  // executable (agentStart's documented invariant; herdr's agent kind is derived from it, or named
  // outright by `agent.kind`). Defaults to claude --dangerously-skip-permissions when no `agent:`
  // block is set. agentStart creates the pane AND waits for the harness to be ready for input, so
  // there is nothing to settle afterwards — the prompt already rode in on the argv.
  //
  // `name` is herdr's AGENT name, not a label: herdr enforces `[a-z][a-z0-9_-]{0,31}` and rejects
  // anything else outright (`invalid_agent_name`), so the run's own `<step>:<KEY>` can't be used — a
  // ticket key alone is usually uppercase. The readable identity is published as pane metadata below.
  // Same folder-trust pre-answer the layout path does (see core/claude-trust.ts): a claude stopped at
  // "Is this a project you trust?" never reaches readiness, and agentStart then closes the pane and
  // reports a spawn failure for what is really an unanswered prompt.
  if (isClaudeAgent(opts.agent.kind ?? opts.agent.command)) {
    const trust = trustWorktreeInClaude(opts.worktree);
    if (trust.status === "set") deps.log("info", `${opts.ticketKey}: trusted ${opts.worktree} in ${trust.path} for claude`);
    if (trust.status === "failed") deps.log("warn", `${opts.ticketKey}: could not trust ${opts.worktree} in ${trust.path}: ${trust.detail}`);
  }
  const target = await deps.herdr.agentStart({
    workspaceId: opts.workspaceId,
    cwd: opts.worktree,
    argv: [opts.agent.command, ...opts.agent.flags, opts.prompt],
    env: { HERDR_FACTORY_TICKET: opts.ticketKey },
    name: agentNameFor(opts.step, opts.ticketKey),
    kind: opts.agent.kind,
    awaitShell: async (paneId) => void (await awaitShellPrompt(deps, paneId)),
  });
  // The spawn itself failed — the pane could not be created, or the harness never reached readiness
  // and herdr saw no agent in it either (agentStart closes such a pane). Say THAT: the step having
  // no tab/pane configured is why we are on this path, not why it failed, and reporting it as the
  // cause sent operators of deliberately dedicated-pane belts hunting a config error that isn't there.
  if (!target)
    throw new Error(`${opts.ticketKey}: failed to spawn dedicated agent for step "${opts.step}" — the pane could not be created, or its agent never became ready (spawn timed out)`);
  await showRunPane(deps, target, { key: opts.ticketKey, step: opts.step, state: "running" });
  deps.log("info", `${opts.ticketKey}: no tab/pane configured — spawned dedicated pane ${target}`);
  return { status: "ready", paneId: target };
}

/** Materialize the work item (its work doc + any media) into the worktree's .memory for the
 *  agents to read. Delegates to the source: Jira writes ticket.json + image/video attachments;
 *  local_markdown snapshots a file to task.md or copies a directory item whole to task/. Idempotent (the source guards against
 *  re-materializing) and best-effort (it logs rather than throwing), so it's safe to call on
 *  every claiming tick while we wait for the step's layout pane to come up. */
/** Remove a `.memory/herdr-factory/` that came with a freshly CREATED worktree's checkout. The
 *  memory dir is factory-owned, per run: content already present in a brand-new checkout can only
 *  be stale artifacts committed to the repo (e.g. a prior run's task doc swept into a commit) —
 *  and because every source's materialize is skip-if-exists ("idempotent across claiming ticks"),
 *  a committed task doc would silently supplant the real work item for every future run. Callers
 *  must only use this on the worktree-CREATE path: a re-opened worktree's memory dir holds the
 *  run's own live state (handoffs, feedback, prompts) and must never be scrubbed. Returns whether
 *  anything was removed. */
export function scrubCommittedMemoryDir(worktreePath: string): boolean {
  const mem = join(worktreePath, MEMORY_DIR);
  if (!existsSync(mem)) return false;
  rmSync(mem, { recursive: true, force: true });
  return true;
}

export async function materializeWork(deps: Deps, run: Run, src: SourceRuntime): Promise<void> {
  return telemetrySpan(
    "step.materialize_work",
    { repo: deps.config.repoName, "run.id": run.id, "work.key": run.ticketKey, "work.source": src.name, "source.type": src.type },
    async () => {
      const worktree = run.worktreePath;
      if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
      const mem = join(worktree, MEMORY_DIR);
      mkdirSync(mem, { recursive: true });
      try {
        await src.client.materialize(run.ticketKey, mem, deps.log);
      } catch {
        deps.log("warn", `${run.ticketKey}: materialize had issues`);
      }
    },
  );
}

/** The handover scaffold appended to EVERY step prompt (work_to_pull_request + custom alike): which
 *  belt/step this is and the full step sequence, how to read the prior step's handoff + query its
 *  agent, and the mandatory finish protocol (write a handoff note, then signal step-done). This is
 *  the "you're working in herdr, here are the other agents in this belt" wiring — the only thing the
 *  engine injects on top of the step's own prompt body. */
function scaffold(
  belt: BeltRuntime,
  step: StepConfig,
  prior: RunStep | null,
  stepDoneCmd: string,
  askHumanCmd: string,
  bounceCmd: string,
  bounceTarget: string | undefined,
): string {
  const seq = belt.steps.map((s) => (s.name === step.name ? `**${s.name}** (you)` : s.name)).join(" → ");
  const inputs = prior
    ? `\n\n## Input from the previous step (${prior.step})\n` +
      `- Read its handoff note first: \`${MEMORY_DIR}/handoff-${prior.step}.md\`.\n` +
      `- That agent ran in herdr pane \`${prior.paneId}\` (claude session \`${prior.sessionId ?? "?"}\`). ` +
      `If the handoff note isn't enough, query it on demand: \`herdr agent read ${prior.paneId} --source recent\`, ` +
      `read its session transcript, or ask it directly — ` +
      // `agent prompt`, NOT the `agent send` this used to name: herdr 0.7.5 split that into `send-keys`
      // (key presses) and `prompt` (atomic submission), so the old command errors out. Asking is a
      // three-step round trip because the answer only exists once that agent's turn ends.
      `\`herdr agent prompt ${prior.paneId} "<question>"\`, then \`herdr agent wait ${prior.paneId} --until idle\` ` +
      `and \`herdr agent read ${prior.paneId} --source recent\` to collect the answer.\n`
    : "\n\n## Input\nThis is the first step of the belt — start from the work item.\n";
  // A read-only gate whose posture isn't described by an engine base prompt (a `custom` step —
  // enginePrompt is undefined) is told, by the engine, that it must not commit. The engine ENFORCES
  // this (HEAD movement during the step parks the run), so the agent needs to know up front. A
  // base-prompted read-only step (evidence/review) describes its own posture, so this is skipped.
  const readOnlyNote =
    step.readOnly && step.enginePrompt === undefined
      ? `\n## This is a read-only step (no commits)\n` +
        `This step is a **gate/check, not a workstation**: do NOT edit files or create commits. ` +
        `The engine enforces this — if the branch HEAD moves while you run, the run is parked for a human as a read-only violation, ` +
        `and your step-done is REFUSED (with the diff stat) while the worktree is dirty or HEAD has moved under you. ` +
        `If the work needs changes, ${bounceCmd && bounceTarget ? "send it back for rework (see below)" : "record what's wrong in your handoff note and finish"} — do not fix it here.\n`
      : "";
  return (
    `\n\n## You are an agent in a herdr-factory belt\n` +
    `You are the **${step.name}** step of the **${belt.name}** belt. The belt runs these steps in order: ${seq}. ` +
    `Each step is a separate agent in its own herdr pane; you hand work forward via a handoff note (and can query earlier agents directly).\n` +
    // Precedence, stated once for EVERY step (custom steps included, whose prompt is entirely the
    // user's): the target repo's own docs/skills own the craft, this prompt owns the belt protocol.
    `The target repo's own instructions — its \`CLAUDE.md\` / \`AGENTS.md\`, agent skills, \`CONTRIBUTING.md\`, runbooks — govern **how** you do the work: ` +
    `prefer them over generic advice, and fall back to this prompt where they are silent. They never override the factory protocol described here ` +
    `(the posture this prompt gives you, the handoff note, \`step-done\`, asking a human, sending work back for rework, and the work item's status — which the dispatcher owns). ` +
    `If the two genuinely conflict, follow this prompt and note the conflict in your handoff.\n` +
    inputs +
    readOnlyNote +
    `\n## Asking a human for guidance\n` +
    `If you are blocked by ambiguous requirements, missing source material, impossible verification, or conflicting evidence, do NOT guess and do NOT run step-done. ` +
    `Write a concise question to \`${MEMORY_DIR}/human-question-${step.name}.md\`, then run \`${askHumanCmd}\` and stop. ` +
    `The dispatcher will post the question through the work source, wait for a human reply, write the answer under \`${MEMORY_DIR}/human-replies/\`, and resume this same step automatically. ` +
    `If \`${MEMORY_DIR}/human-replies/\` already exists when you start or resume, read its files before continuing.\n` +
    (bounceCmd && bounceTarget
      ? `\n## Sending the work back for rework\n` +
        `If your work on this step shows the previous work is NOT acceptable — e.g. evidence proves the issue isn't actually fixed, ` +
        `the change is wrong, or a required behaviour is missing — do NOT run step-done and do NOT try to fix it here. Instead: ` +
        `write concrete, actionable findings (what's wrong and what must change) to \`${MEMORY_DIR}/bounce-${step.name}.md\`, ` +
        `then run \`${bounceCmd}\` and stop. This sends the run back to the **${bounceTarget}** step to do the work. ` +
        `Write specific, reproducible findings so the loop converges quickly. ` +
        `(A per-run bounce cap is only a safety backstop against endless oscillation — once exceeded the run parks for a human.)\n`
      : "") +
    `\n## Finishing this step (required)\n` +
    `1. Write your handoff note to \`${MEMORY_DIR}/handoff-${step.name}.md\` — what you did, key decisions and why, ` +
    `anything uncertain, and what the next step should verify. ` +
    // Every handoff names the commit it covers, so the next step (and a human reading the trail)
    // can tell whether the note describes the tree it is actually looking at.
    `Start it with a line \`sha: <commit>\` (\`git rev-parse HEAD\` in this worktree) — the commit your note covers.\n` +
    `2. Then run \`${stepDoneCmd}\` and stop. Do NOT change the work item's status — the dispatcher owns all status transitions.\n` +
    // The signal is the only thing that advances the belt, and a REJECTED one exits non-zero with the
    // reason (it used to exit 0, so an agent could stop believing a dropped signal had landed).
    // Telling the agent to react is what makes that exit code worth anything — but only for the
    // reasons it CAN act on: "no active run" / "not in belt" are terminal, and looping on them would
    // be worse than stopping.
    `   If that command fails (non-zero exit) it prints the reason on stderr. A stale pass, or a run that is busy, is retryable: ` +
    `re-read this file for the current command and run that, or try again in a moment. If it says there is no active run, ` +
    `or that this step is not in the belt, the run is gone — leave your handoff note and stop.\n`
  );
}

/** Assemble a step's prompt body at render time (before tokens/scaffold): the engine base
 *  (work_to_pull_request steps) plus, if the step configures a `promptFile`, the user prompt read
 *  from `config` (the repo's config folder) or `repo` (the run's worktree). For an engine-prompted
 *  step the user prompt AUGMENTS the base by default, or REPLACES it (`promptMode: "replace"` — the
 *  file owns the body); for a custom step (no base) it IS the whole body.
 *
 *  The user prompt is validated against the prompt contract for THIS step (`ctx`) — a `config`-sourced
 *  prompt was already checked at config-load, so this is the load-time check's mirror plus the only
 *  check a `repo`-sourced prompt (read from the worktree here) gets.
 *
 *  The engine base itself runs through the prompt-pack chain (src/prompt-packs.ts): a repo-checkout
 *  pack (`<worktree>/.herdr/prompts/`) — reachable only here, at render — OVERRIDES `enginePrompt`
 *  (which config-load already resolved as the config-folder pack ?? shipped). So a base is resolved
 *  repo-checkout ▸ config-folder ▸ shipped, and the per-step `promptFile` augments whichever wins. */
function stepBody(deps: Deps, run: Run, step: StepConfig, ctx: PromptStepContext, sourceType: SourceType): string {
  let userPrompt = "";
  if (step.promptFile) {
    if (step.promptFileSource === "repo" && !run.worktreePath) {
      throw new Error(`${run.ticketKey}: ${step.name} has a repo-sourced prompt_file but no worktree yet`);
    }
    const root = step.promptFileSource === "repo" ? run.worktreePath! : deps.config.paths.repoDir;
    const path = isAbsolute(step.promptFile) ? step.promptFile : join(root, step.promptFile);
    try {
      userPrompt = readFileSync(path, "utf8");
    } catch {
      throw new Error(`${run.ticketKey}: ${step.name} prompt_file not found (${step.promptFileSource}): ${path}`);
    }
    const problems = validatePromptBody(userPrompt, ctx);
    if (problems.length) {
      throw new Error(
        `${run.ticketKey}: ${step.name} prompt_file (${step.promptFileSource}: ${path}) violates the prompt contract:\n  - ${problems.join("\n  - ")}\n(see docs/PROMPTS.md for the token reference)`,
      );
    }
  }
  if (step.enginePrompt === undefined) return userPrompt; // custom: the user prompt is the body
  // `replace`: the user prompt OWNS the body — the shipped base is dropped (config-load guarantees a
  // prompt_file is set, so this is a deliberate takeover, not an accidental empty body). In replace
  // mode the base is discarded, so the pack chain below is deliberately skipped.
  if (step.promptMode === "replace" && userPrompt.trim()) return userPrompt;
  // augment (default): a repo-checkout prompt pack (highest-precedence layer, worktree-only) overrides
  // the base; else the load-resolved `enginePrompt` (config-folder pack ?? shipped) stands — then the
  // optional user prompt augments whichever base wins.
  let base = step.enginePrompt;
  if (step.basePromptSlug && run.worktreePath) {
    const override = resolvePromptFile([join(run.worktreePath, REPO_PACK_SUBDIR)], sourceType, step.basePromptSlug, step.basePromptPerSourceOverride ?? true);
    if (override) base = override.body;
  }
  return userPrompt.trim()
    ? `${base.trimEnd()}\n\n## Additional repo-specific instructions for this step\n\n${userPrompt.trim()}\n`
    : base;
}

/** Render a step's prompt (its assembled body + tokens + guidance + handover scaffold) and write it
 *  into the worktree's .memory for the agent to read. Function replacers avoid `$`-pattern
 *  interpretation. */
export async function renderStepPrompt(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  step: StepConfig,
  prior: RunStep | null,
): Promise<void> {
  return telemetrySpan(
    "step.render_prompt",
    { repo: deps.config.repoName, "run.id": run.id, "work.key": run.ticketKey, "work.source": src.name, belt: belt.name, step: step.name },
    () => renderStepPromptImpl(deps, run, belt, src, step, prior),
  );
}

async function renderStepPromptImpl(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  step: StepConfig,
  prior: RunStep | null,
): Promise<void> {
  const worktree = run.worktreePath;
  if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
  // Every agent-facing command token is RENDERED from the signal registry (signalCommand), so a
  // token an agent runs can't drift from the mounted CLI/HTTP command. --source is always bound so
  // the signal resolves to the right run even when two sources share a key (the worker only knows
  // its key, via HERDR_FACTORY_TICKET).
  const repo = deps.config.repoName;
  // The step's CURRENT pass stamps every terminal-signal command this prompt renders: bounce
  // rewinds make per-step progress non-monotonic, so a step-done/bounce minted for pass N must be
  // rejectable when it (or a duplicate of it) lands during pass N+1. Absent row ⇒ first entry ⇒ 1.
  const pass = String(deps.store.getRunStep(run.id, step.name)?.pass ?? 1);
  const stepDoneCmd = signalCommand(CLI_PATH, repo, "step-done", { key: run.ticketKey, step: step.name, source: src.name, pass });
  const askHumanCmd = signalCommand(CLI_PATH, repo, "ask-human", { key: run.ticketKey, step: step.name, source: src.name, "question-file": `${MEMORY_DIR}/human-question-${step.name}.md` });
  // evidence-upload publishes @@EVIDENCE_DIR@@ to S3/CloudFront (no-op if `evidence:` is unconfigured);
  // capture-attempt signals the start of a capture so the engine caps flaky-capture loops. Both are
  // capability-gated below (injected only when `evidence` is ACTIVE for this step — see isActive).
  // The branch an agent may rename to (`<new-branch-name>` is a placeholder it substitutes) — the
  // repo's own branching/CI convention is never knowable at claim time.
  const setBranchCmd = signalCommand(CLI_PATH, repo, "set-branch", { key: run.ticketKey, branch: "<new-branch-name>", source: src.name });
  const evidenceUploadCmd = signalCommand(CLI_PATH, repo, "evidence-upload", { key: run.ticketKey, source: src.name });
  const captureAttemptCmd = signalCommand(CLI_PATH, repo, "capture-attempt", { key: run.ticketKey, step: step.name, source: src.name });
  // For a step that may bounce (evidence/review), a ready-made command that returns the run to its
  // first `canBounceTo` target with a findings file. Empty for steps that can't bounce.
  const bounceTarget = step.canBounceTo[0];
  const bounceCmd = bounceTarget
    ? signalCommand(CLI_PATH, repo, "bounce", { key: run.ticketKey, toStep: bounceTarget, source: src.name, "reason-file": `${MEMORY_DIR}/bounce-${step.name}.md`, step: step.name, pass })
    : "";
  // Where the work item's spec lives + how to describe it — the SOURCE owns this (workDoc pairs
  // with its materialize; the engine never branches on source type). It may stat the worktree's
  // .memory to disambiguate layouts (e.g. local_markdown's task/ vs task.md).
  const wd = await src.client.workDoc(join(worktree, MEMORY_DIR));
  const workDoc = `${MEMORY_DIR}/${wd.path}`;
  const workDocKind = wd.kind;
  const sub: Record<string, string> = {
    "@@KEY@@": run.ticketKey,
    "@@REPO@@": deps.config.repoName,
    "@@BELT@@": belt.name,
    "@@STEPS@@": belt.steps.map((s) => s.name).join(" → "),
    "@@TYPE@@": run.issueType ?? "",
    "@@SUMMARY@@": run.summary ?? "",
    "@@BRANCH@@": run.branch ?? "",
    "@@WORKTREE@@": worktree,
    "@@STEP@@": step.name,
    "@@MEMORY_DIR@@": MEMORY_DIR,
    "@@WORK_DOC@@": workDoc,
    "@@WORK_DOC_KIND@@": workDocKind,
    "@@BOUNCE_CMD@@": bounceCmd,
    "@@BOUNCE_TARGET@@": bounceTarget ?? "",
    "@@BOUNCE_REASON_FILE@@": bounceTarget ? `${MEMORY_DIR}/bounce-${step.name}.md` : "",
    "@@ASK_HUMAN_CMD@@": askHumanCmd,
    "@@SET_BRANCH_CMD@@": setBranchCmd,
    "@@CLI@@": CLI_PATH,
    "@@HANDOFF_IN@@": prior ? `${MEMORY_DIR}/handoff-${prior.step}.md` : "(none — first step)",
    "@@HANDOFF_OUT@@": `${MEMORY_DIR}/handoff-${step.name}.md`,
    "@@PRIOR_PANE@@": prior?.paneId ?? "(none)",
    "@@PRIOR_SESSION@@": prior?.sessionId ?? "(none)",
    "@@STEP_DONE_CMD@@": stepDoneCmd,
    // Universal but config-driven: renders the repo's commit-message conventions (from
    // `conventions.commits`) when set, else "" — so an unset key leaves the work/pr prompts unchanged.
    "@@COMMIT_CONVENTIONS@@": commitConventionsBlock(deps),
  };
  // Capability-scoped tokens + @@WHEN@@ clauses gate on ACTUAL belt dataflow, not just this step's
  // declaration: an OPTIONAL consume (evidence for review/pr) is ACTIVE only when an upstream step
  // (or the source) actually produces it. So a work→review→pr belt injects no @@EVIDENCE_*@@ and
  // strips the "read the evidence" clause instead of pointing the reviewer at evidence never taken.
  const isActive = productActiveFor(belt.steps, step, src.type);
  if (isActive("evidence")) {
    sub["@@EVIDENCE_DIR@@"] = `${MEMORY_DIR}/evidence`;
    sub["@@EVIDENCE_UPLOAD_CMD@@"] = evidenceUploadCmd;
    sub["@@CAPTURE_ATTEMPT_CMD@@"] = captureAttemptCmd;
  }
  // @@PR_TEMPLATE@@ is active only for a step that produces the pull request (the pr step). Read the
  // target repo's own PR template from the worktree (best-effort — missing ⇒ ""), so the PR follows
  // the team's template rather than the factory's baked default. An absent template collapses the
  // @@WHEN:pull_request@@ clause to nothing, leaving today's summary+testing-notes wording unchanged.
  if (isActive("pull_request")) {
    const template = findPrTemplate(worktree);
    sub["@@PR_TEMPLATE@@"] = template ? prTemplateBlock(template) : "";
    // The belt-level `pr:` behavior block (draft/title/labels/reviewers/assignees + the automated-
    // round window). Both render empty / the ~10-min default when the belt sets no `pr:` block, so an
    // absent block leaves this prompt byte-identical to before.
    sub["@@PR_OPTIONS@@"] = prOptionsBlock(belt, run);
    sub["@@PR_AUTOMATED_ROUND@@"] = prAutomatedRoundBlock(belt);
  }
  // exclusive_resource guard → the machine-global lock commands, injected only for a step that
  // declares one (evidence's capture mutex). The resource name comes from the guard, so it lives in
  // exactly one place (the descriptor) rather than being hardcoded in the CLI and the prompt prose.
  const lockRes = step.guards.find((g) => g.kind === "exclusive_resource")?.resourceName;
  if (lockRes) {
    sub["@@CAPTURE_LOCK_ACQUIRE_CMD@@"] = `${CLI_PATH} capture-lock acquire ${lockRes} ${run.ticketKey}`;
    sub["@@CAPTURE_LOCK_RELEASE_CMD@@"] = `${CLI_PATH} capture-lock release ${lockRes} ${run.ticketKey}`;
  }
  // Strip product-gated clauses BEFORE substitution so a dropped block's tokens never dangle.
  // The ctx here is exactly what stepBody validates the user prompt against and what
  // availablePromptTokens keys on, so validation matches this render 1:1.
  const ctx: PromptStepContext = { isActive, guardKinds: new Set(step.guards.map((g) => g.kind)) };
  let out = stripInactiveProductBlocks(stepBody(deps, run, step, ctx, src.type), isActive);
  for (const [token, value] of Object.entries(sub)) out = out.replaceAll(token, () => value);
  if (deps.config.guidance) out += `\n\n## Repo-specific guidance\n\n${deps.config.guidance}\n`;
  out += scaffold(belt, step, prior, stepDoneCmd, askHumanCmd, bounceCmd, bounceTarget);
  // If a later step bounced the run back to this step, a feedback note is waiting — surface it up
  // top so the (re-dispatched) agent reads it before anything else.
  if (existsSync(join(worktree, MEMORY_DIR, `feedback-${step.name}.md`))) {
    out =
      `## ⚠ Rework requested — READ THIS FIRST\n\n` +
      `A later step — or the operator — sent this work back to you. Read \`${MEMORY_DIR}/feedback-${step.name}.md\` in this worktree ` +
      `and address its findings before doing anything else, then finish this step as normal.\n\n---\n\n` +
      out;
  }
  const mem = join(worktree, MEMORY_DIR);
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, `prompt-${step.name}.md`), out);
}

/**
 * Spawn (or hand off to) the agent for `stepName`. Renders + writes its prompt (wiring in the
 * prior step's handoff + pane/session for on-demand query), then dispatches:
 *   - `ready`  → records the pane on the run_step and as the run's latest pane, flags focus.
 *   - `waiting`→ the configured layout pane isn't up yet; nothing is recorded. The run_step's
 *     `started_at` (stamped on first touch below) times the bounded wait; the caller decides
 *     whether to retry next tick or escalate to attention.
 */
export async function spawnStep(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  stepName: string,
): Promise<DispatchResult> {
  return telemetrySpan(
    "step.spawn",
    { repo: deps.config.repoName, "run.id": run.id, "work.key": run.ticketKey, "work.source": src.name, belt: belt.name, step: stepName },
    () => spawnStepImpl(deps, run, belt, src, stepName),
  );
}

async function spawnStepImpl(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  stepName: string,
): Promise<DispatchResult> {
  const workspaceId = run.workspaceId;
  const worktree = run.worktreePath;
  if (!workspaceId || !worktree) throw new Error(`${run.ticketKey}: missing workspace/worktree`);
  const step = stepByName(belt, stepName);
  if (!step) throw new Error(`${run.ticketKey}: belt "${belt.name}" has no step "${stepName}"`);

  // Capture the prior step's session id at handoff time (herdr only knows it once the
  // prior agent has reported in) so this step's prompt can point at it. Best-effort
  // enrichment — herdr being briefly unreachable must not abort the dispatch itself.
  const prev = priorStep(belt, stepName);
  let prior = prev ? (deps.store.getRunStep(run.id, prev.name) ?? null) : null;
  if (prior && !prior.sessionId && prior.paneId) {
    const sid = await deps.herdr.agentSessionId(prior.paneId).catch(() => null);
    if (sid) prior = deps.store.upsertRunStep(run.id, prev!.name, { sessionId: sid });
  }

  await renderStepPrompt(deps, run, belt, src, step, prior);

  // Ensure the step row exists so its started_at clock runs from the first attempt — this is
  // what bounds the layout wait across ticks. (started_at is set to now() on first insert and
  // only reset below once we actually dispatch.)
  deps.store.upsertRunStep(run.id, stepName);

  // Any pane this step was ALREADY dispatched to (a re-entry: bounce rework, forward re-advance,
  // crash respawn). dispatchToLayout re-prompts a live one instead of re-resolving the configured
  // label — which the first dispatch renamed out from under a fresh lookup. Undefined on first entry.
  const knownPaneId = deps.store.getRunStep(run.id, stepName)?.paneId ?? undefined;

  const result = await dispatchToLayout(deps, {
    workspaceId,
    worktree,
    tab: step.tab,
    pane: step.pane,
    prompt: dispatchPrompt(stepName),
    step: stepName,
    ticketKey: run.ticketKey,
    knownPaneId,
    // Resolved step over belt over repo over the default (config.ts); the ?? guards terse test
    // literals that build a StepConfig without an `agent`. Only used on the dedicated-spawn path.
    agent: step.agent ?? DEFAULT_AGENT_CONFIG,
  });
  if (result.status === "waiting") return result; // still waiting on the user's layout pane

  // Dispatched. Reset started_at so the per-step budget is measured from now (per attempt,
  // not cumulatively across crash-recovery re-spawns or the preceding layout wait), stamp
  // dispatched_at (this pass's prompt has reached an agent — the reconciler's spawn branch keys on
  // it), and clear any pending absence confirmation — this pane is definitionally alive right now.
  deps.store.upsertRunStep(run.id, stepName, { paneId: result.paneId, startedAt: deps.now(), absentAt: null, dispatchedAt: deps.now() });
  // The budget window is measured PER ATTEMPT (not cumulatively across crash-recovery re-spawns or
  // the preceding layout wait) — re-base its watch clock alongside the dispatch bookkeeping above.
  deps.store.upsertWatchState(run.id, stepName, "budget", { basedAt: deps.now() });
  // The pane came up — refund every counter guard that declares a dispatch-success reset (the
  // layout-wait respawn budget), so a FUTURE wait by this step (a re-entry after a bounce, a crash
  // respawn) starts with its full bounded-retry allowance. Derived from GuardSpec.resetOn.
  for (const g of guardsResetOn(step.guards, "dispatch")) deps.store.resetGuardCounter(run.id, stepName, g.kind);
  // read_only enforcement baseline: capture HEAD before the agent runs, so a later commit (a
  // read-only-contract violation) is detectable as HEAD movement in the watch harness. Starts
  // UNFROZEN (basedAt null): it tracks live HEAD — absorbing the prior step's trailing handoff
  // commits — until this step's agent is first observed working (RWR-18204). watch_state since v34.
  const spawnHead = await deps.git.headSha(worktree).catch(() => null);
  if (step.readOnly && spawnHead) deps.store.upsertWatchState(run.id, stepName, "read_only", { sig: spawnHead, basedAt: null });
  deps.store.updateRun(run.id, { paneId: result.paneId }); // latest active pane (reviewing/resolver reuse it)
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "step_spawned",
    // The HEAD this pass is PINNED to: what the step's handoff should name, and what the tree
    // guard compares against for a step that never commits (core/tree-guard.ts).
    detail: { step: stepName, paneId: result.paneId, head: spawnHead },
  });
  // Mark that the active step changed. The actual focus shift is deferred to
  // applyPendingFocus, which brings this pane to the front only when the user is already
  // viewing THIS worktree on one of its pipeline panes — never stealing focus from another
  // worktree, and never yanking the user off an unrelated pane.
  deps.store.updateRun(run.id, { focusPending: true });
  return result;
}
