// The `triage` command: open the operator's OWN agent CLI on a stuck run, pre-briefed with the
// engine's own diagnosis — the push-based face of the skill's symptom→fix playbooks. The factory's
// deterministic layer already detects and parks; what an operator lacks at that moment is a
// conversation. `triage <KEY>` composes a briefing (the `explain` narrative, the recent events, the
// file locations, ground rules), writes it next to the run, and launches the configured agent
// harness INTERACTIVELY with a prompt pointing at it.
//
// Deliberately foreground-in-your-terminal, NOT a herdr pane: triage must work precisely when herdr
// (or the server) is the thing that's broken, and the session belongs to the operator, not to the
// factory's pane lifecycle. This does not touch the herdr ownership boundary — no pane, tab,
// worktree, or agent lifecycle is managed here; it is the same category of program as the TUI.
//
// The launch drops the configured agent FLAGS on purpose: flags configure the UNATTENDED worker
// posture (`--dangerously-skip-permissions` et al.), and a triage session has a human present who
// can approve actions. Only the harness `command` is reused, so an opencode shop triages in
// opencode. `--print` skips the launch and prints the briefing — for a harness that takes no
// positional prompt, a tmux workflow, or piping.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps } from "../core/deps.ts";
import type { Run } from "../types.ts";
import { runObligations } from "../core/obligations.ts";
import { explainRun } from "../core/explain.ts";
import { MEMORY_DIR } from "../core/step.ts";

/** The shipped skill folder inside this checkout — referenced in the briefing so a harness with no
 *  skill mechanism (or no installed skill) can still read the playbooks as plain markdown. */
function shippedSkillDir(): string {
  return fileURLToPath(new URL("../../skills/herdr-factory", import.meta.url));
}

const safeFileKey = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_");

export interface TriageBriefingInput {
  repoName: string;
  run: Pick<Run, "ticketKey" | "id" | "phase" | "step" | "belt" | "workSource" | "branch" | "worktreePath">;
  /** The `explainRun` narrative, heading included. */
  explainLines: string[];
  /** Already-formatted recent event lines, oldest first (the composer takes the tail). */
  timelineLines: string[];
  configRepoDir: string;
  skillDir: string;
}

/** Pure: the briefing markdown the triage agent starts from. */
export function composeTriageBriefing(input: TriageBriefingInput): string {
  const { repoName, run } = input;
  const cli = `herdr-factory --repo ${repoName}`;
  const tail = input.timelineLines.slice(-15);
  return [
    `# herdr-factory triage — ${run.ticketKey}`,
    "",
    "You are helping the operator unblock a herdr-factory run. Diagnose before acting; read-only",
    `commands are always safe (\`${cli} status | explain | timeline | logs | doctor\`).`,
    "",
    "## Why the run is where it is (the engine's own answer)",
    "",
    "```",
    ...input.explainLines,
    "```",
    "",
    `Raw facts behind it: \`curl -s '127.0.0.1:8765/repos/${repoName}/obligations?key=${run.ticketKey}'\``,
    "(needs the server up; the narrative above was read straight from the DB).",
    "",
    "## Recent events (oldest first)",
    "",
    "```",
    ...(tail.length ? tail : ["(no events recorded)"]),
    "```",
    "",
    "## Where things live",
    "",
    `- run: #${run.id} · belt ${run.belt ?? "?"} · source ${run.workSource ?? "?"} · branch ${run.branch ?? "?"}`,
    `- worktree: ${run.worktreePath ?? "(none — not created yet, or already torn down)"}`,
    ...(run.worktreePath
      ? [`- run memory: ${join(run.worktreePath, MEMORY_DIR)} (rendered prompts, handoff notes, the work doc, evidence)`]
      : []),
    `- repo config: ${input.configRepoDir} (config.yml, env)`,
    `- engine log: \`${cli} logs 300\``,
    "",
    "## Playbooks",
    "",
    "The herdr-factory skill carries the symptom → diagnosis → fix playbooks. If it isn't installed",
    "in this harness, read it as plain markdown:",
    `- ${join(input.skillDir, "references", "troubleshooting.md")} (triage order, the park-reason table)`,
    `- ${join(input.skillDir, "references", "cli.md")} (every command, output anatomy)`,
    "",
    "## Ground rules",
    "",
    `- \`${cli} resume ${run.ticketKey}\` un-parks the run with fresh clocks — safe once you and the operator agree on the cause.`,
    `- NEVER run \`teardown\` (destroys the worktree and branch), \`bounce\`, or a \`step-done\` on the run's behalf without the operator's explicit OK in this conversation.`,
    "- Prefer the smallest nudge that moves the run: reload → tick → step-done → resume → intent retry → restart. Teardown is last.",
    "- If the cause is outside the factory (expired credentials, a dead dev server, a closed PR), name the exact external step the operator must take.",
    "",
  ].join("\n");
}

/** The opening prompt the harness is launched with — short; the briefing carries the substance. */
export function triagePrompt(briefingPath: string, key: string): string {
  return (
    `Read ${briefingPath} and help me unblock the herdr-factory run ${key}. ` +
    `Start by summarizing why it is stuck in two sentences, then propose the single next command. ` +
    `Do not run resume/teardown/bounce/step-done without my explicit OK.`
  );
}

/** Compose + write the briefing, then either print it or hand the terminal to the agent. */
export async function triageRun(deps: Deps, run: Run, opts: { print?: boolean }): Promise<void> {
  const repo = deps.config.repoName;
  const explainLines = explainRun({ ob: runObligations(deps, run), repoName: repo, now: deps.now() });
  const timelineLines = deps.store
    .timeline(repo, run.ticketKey)
    .map((ev) => `${new Date(ev.ts * 1000).toISOString()}  ${ev.type}${ev.detail ? `  ${ev.detail}` : ""}`);

  const briefing = composeTriageBriefing({
    repoName: repo,
    run,
    explainLines,
    timelineLines,
    configRepoDir: deps.config.paths.repoDir,
    skillDir: shippedSkillDir(),
  });

  // Next to the run when it has a worktree (the agent will cwd there anyway); else the repo's
  // state dir, so a pre-worktree or torn-down run still gets a briefing file.
  const dir =
    run.worktreePath && existsSync(run.worktreePath) ? join(run.worktreePath, MEMORY_DIR) : deps.config.paths.stateDir;
  mkdirSync(dir, { recursive: true });
  const briefingPath = join(dir, `triage-${safeFileKey(run.ticketKey)}.md`);
  writeFileSync(briefingPath, briefing);

  if (opts.print) {
    console.log(briefing);
    console.log(`(also written to ${briefingPath})`);
    return;
  }

  const command = deps.config.agent.command;
  const cwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : deps.config.repo.path;
  console.log(`opening ${command} for triage — briefing at ${briefingPath}`);
  const res = spawnSync(command, [triagePrompt(briefingPath, run.ticketKey)], { cwd, stdio: "inherit" });
  if (res.error) {
    throw new Error(
      `could not launch "${command}" (${(res.error as NodeJS.ErrnoException).code ?? res.error.message}) — ` +
        `configure the harness via the repo's \`agent:\` block, or use \`triage ${run.ticketKey} --print\` and paste the briefing yourself`,
    );
  }
}
