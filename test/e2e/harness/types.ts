// Shared vocabulary for the end-to-end harness. See test/e2e/README.md for the model:
// LANE = whose herdr (real headless server vs a scripted shim), TIER = whose agent (a deterministic
// script vs a real local model), DRIVER = who advances the engine (the resident server's own tick
// loop vs discrete `tick` calls).

/** `real` = a headless `herdr server` in the container (proves the herdr contract + layouts).
 *  `fake` = a shim on HERDR_BIN_PATH (failure injection + scale without PTYs). */
export type Lane = "real" | "fake";

/** `scripted` = the harness's deterministic agent; `ds4` = a real local model via opencode. */
export type Tier = "scripted" | "ds4";

/** `serve` = the resident server ticks itself (the production shape); `tick` = one pass per call. */
export type Driver = "serve" | "tick";

/** What the scripted agent does for one (step, pass). Everything is optional: the defaults make a
 *  step implement-and-finish, which is the happy path. */
export interface AgentBehaviour {
  /** Commit n files into the worktree (true = 1). Defaults to true for `commit`-producing step
   *  names (work/pr/fix), false elsewhere — so a `review` behaviour with `commit: true` is how the
   *  read-only violation is provoked. */
  commit?: boolean | number;
  /** Sit doing nothing instead of signalling: a number of ms, or "forever" (until the pane dies).
   *  This is how budget/stall parks are provoked. */
  hangMs?: number | "forever";
  /** Hold `working` for this long BEFORE doing anything else (committing, capturing, signalling).
   *  Some watches only arm once the engine has OBSERVED the agent working — the read-only baseline
   *  tracks HEAD until then, so a gate that commits within milliseconds of starting is indistinguish-
   *  able from the previous step's trailing commit. A real agent takes minutes; this is the dwell that
   *  makes a scripted one behave like one. */
  preWorkMs?: number;
  /** How long to hold the herdr-observed `working` state before signalling (default 1200ms).
   *  Load-bearing: herdr needs to observe the transition for `agent prompt --wait --until working`
   *  to confirm, and `working` vetoes the budget/stall watchdogs. */
  workMs?: number;
  /** Force the reported status for the whole turn (default: working → idle around the work). */
  status?: "working" | "idle";
  /** Run the `capture-attempt` signal this many times (evidence steps; provokes the capture cap). */
  captureAttempts?: number;
  /** Write fake capture files into @@EVIDENCE_DIR@@ and run the `evidence-upload` signal. */
  evidence?: boolean;
  /** The terminal signal for the turn. Default `step-done`. `none` = never signal (the run must be
   *  rescued by a watchdog, a resume, or a human). */
  signal?: "step-done" | "bounce" | "ask-human" | "none";
  /** Body text for a bounce reason / ask-human question (written to the file the prompt names). */
  text?: string;
  /** After signalling, re-run the same signal stamped `--pass 1` (stale-replay rejection). */
  replayStalePass?: boolean;
  /** Skip writing @@HANDOFF_OUT@@ (the next step then sees no handoff). */
  noHandoff?: boolean;
  /** Rename the run onto this branch with the prompt's rendered `set-branch` command (substituting
   *  its `<new-branch-name>` placeholder) — the repo-branch-convention path. Runs after the commits
   *  and before `run`, so a later push/PR uses the new name. */
  setBranch?: string;
  /** Extra shell commands run in the worktree before signalling (escape hatch). */
  run?: string[];
  /** Run the `gh pr create` the pr step's prompt asks for (default: true on a step that produces a
   *  pull request, detected by the prompt carrying @@PR_OPTIONS@@'s rendered output). */
  openPr?: boolean;
}

/** Per-scenario agent behaviour. Resolution: `passes["<step>:<pass>"]` ▸ `steps["<step>"]` ▸
 *  `default` ▸ the built-in happy path. Merged shallowly, most specific wins per key. */
export interface AgentScript {
  default?: AgentBehaviour;
  steps?: Record<string, AgentBehaviour>;
  passes?: Record<string, AgentBehaviour>;
}

/** The world's on-disk geography, handed to a scenario's `config` builder so it can reference real
 *  paths (the work folder, the target checkout, a publisher command, …). */
export interface WorldPaths {
  /** World root == HOME for every process the harness starts. */
  home: string;
  /** The target repo the factory works ON (a main checkout). */
  repo: string;
  /** Bare repo that is the target's `origin`. */
  origin: string;
  /** local_markdown work folder. */
  briefs: string;
  /** HERDR_FACTORY_CONFIG_DIR. */
  configDir: string;
  /** This repo's config folder (`<configDir>/repos/<repoName>`). */
  repoConfigDir: string;
  /** HERDR_FACTORY_STATE_ROOT. */
  stateRoot: string;
  /** World bin dir — FIRST on PATH (fake gh, the scripted agent, the herdr wrapper). */
  bin: string;
  /** Artifact dir for this scenario (logs, argv traces, transcripts). */
  art: string;
}

export interface ScenarioSpec {
  /** Unique, kebab-case; names the artifact dir and the vitest test. */
  name: string;
  lane?: Lane;
  tier?: Tier;
  driver?: Driver;
  /** Vitest timeout for the whole scenario (default 180_000). */
  timeoutMs?: number;
  /** Marked slow scenarios are skipped unless HF_E2E_SLOW=1 (they wait out an un-compressible
   *  engine clock, e.g. the 60s first outbox retry). */
  slow?: boolean;
  /** The repo config. Returned object is merged over the harness defaults (repo/limits/agent). */
  config: (p: WorldPaths) => Record<string, unknown>;
  /** `<key>.md` files dropped into the briefs folder (key → markdown body). */
  briefs?: Record<string, string>;
  /** Extra files written under the repo's config folder (prompts/, match.ts, …). */
  configFiles?: Record<string, string>;
  /** Extra files written into the target checkout (committed before the first tick). */
  repoFiles?: Record<string, string>;
  /** `<configDir>/repos/<name>/env` contents (chmod 600). */
  env?: Record<string, string>;
  agent?: AgentScript;
  /** Extra environment for every process the world starts — the factory, herdr, and (because panes
   *  inherit the herdr server's env) the agents. E.g. `HF_AGENT_STARTUP_MS: "0"` for an agent that
   *  starts work the instant it is exec'd. */
  processEnv?: Record<string, string>;
  /** Runs after the world's directories exist but BEFORE its `config.yml` is written and anything is
   *  started — where a scenario brings up a stub backend whose URL the config then references. */
  beforeStart?: (p: WorldPaths) => Promise<void> | void;
  /** Runs after everything is stopped (tear down what `beforeStart` brought up). */
  afterStop?: () => Promise<void> | void;
  /** Factory repo config name (what `--repo` takes). Default "app". */
  repoName?: string;
  /** Extra `serve` processes in the world, each standing in for ANOTHER MACHINE in the fleet: its own
   *  config dir, state root, port and work folder, over the same target checkout, with its repo named
   *  after the machine. The world points the fleet's transport seam
   *  (`HERDR_FACTORY_FLEET_ENDPOINTS`) at them and answers `herdr machine list` from a file of its
   *  own, so the fleet reaches them without any SSH — the only part of the transport a container
   *  cannot have — and without touching a real herdr's saved machines, which are the operator's.
   *  Reached from a scenario with `w.machine(name)`. */
  fleetMachines?: Record<
    string,
    {
      briefs?: Record<string, string>;
      config?: (p: WorldPaths) => Record<string, unknown>;
      /** More repos on THAT machine's own server, so a fleet read of it really fans out per repo
       *  (`Promise.all` over its repos, in both the status and the eligible phase) — which is the
       *  shape the transport's one-open-per-machine rule is about. */
      extraRepos?: Record<string, { briefs?: Record<string, string>; config?: (p: WorldPaths) => Record<string, unknown> }>;
      /** Reach this machine through the REAL `SshForwardTransport` instead of naming its API in
       *  `HERDR_FACTORY_FLEET_ENDPOINTS`: no override is written for it, and the world installs the
       *  harness's fake `ssh` (test/e2e/harness/ssh-fake) so the forward, its `/health` re-probe and
       *  its `ssh -O cancel` tear-down are the shipped code over a loopback proxy. Drive it from a
       *  scenario with `w.sshForward(name)`. */
      ssh?: boolean;
    }
  >;
  /** Extra repos served by THIS machine's own server, beside the scenario's main one. Same config
   *  dir, same state root, same target checkout — one more `repos/<name>/config.yml` over the same
   *  defaults, with a briefs folder of its own. This is how a scenario gets a MULTI-REPO host, which
   *  is the shape the board's idle collapse and its per-host problem hoist are about; a fleet
   *  machine is a whole second server and cannot stand in for it. Reached from a scenario with
   *  `w.repoPaths(name)`. */
  extraRepos?: Record<string, { briefs?: Record<string, string>; config?: (p: WorldPaths) => Record<string, unknown> }>;
}
