import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { applyPendingFocus, BOUNCE_REASON_MAX, bounceStep, claimTicket, teardownTicket, flushTransitionOutbox, reconcileRepo, reconcileRun, recordCaptureAttempt, requestHumanInput, resumeRun, withRunLock, withRunLockWaiting, withTickLock } from "../src/core/reconcile.ts";
import { applySignal } from "../src/core/signals.ts";
import { createApp, type RepoRuntime, type ServerContext } from "../src/server/app.ts";
import { materializeWork, MEMORY_DIR, renderStepPrompt } from "../src/core/step.ts";
import { HerdrUnreachableError, type BeltRuntime, type Deps, type GitApi, type GitHubApi, type HerdrApi, type SourceRuntime, type WorkSource } from "../src/core/deps.ts";
import { SourceUnauthenticatedError } from "../src/auth/errors.ts";
import { getAuthFailure, resetAuthGate } from "../src/auth/gate.ts";
import { getRateLimit, resetRateLimitGate, SourceRateLimitedError } from "../src/core/rate-limit-gate.ts";
import { resetMachineGateLog } from "../src/machine.ts";
import type { Config, StepConfig } from "../src/config.ts";
import { BUDGET_GUARD, HEARTBEAT_GUARD, LAYOUT_WAIT_GUARD, READ_ONLY_GUARD } from "../src/steps/guards.ts";
import { applyWatchRebase, registerWatchEvaluator } from "../src/core/watches.ts";
import { runObligations } from "../src/core/obligations.ts";
import type { FocusedPane, HumanAskInput, HumanPollInput, HumanReply, JiraMatchItem, LayoutNode, LocalMarkdownMatchItem, Phase, PrInfo, PrSnapshot, ReviewSig, Run, Ticket, WorkState } from "../src/types.ts";
import { DEFAULT_AGENT_CONFIG, StaleItemError } from "../src/types.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
  resetAuthGate(); // the gate Map is process-global (keyed by repo "demo") — don't leak across tests
  resetRateLimitGate(); // same for the rate-limit holds
  resetMachineGateLog(); // same for the machine gate's log-once state
});

/** What a source throws once the backend has said "stop until <reset>" (the github_issues client
 *  maps a 403/429 with an exhausted budget onto exactly this). */
const rateLimited = (untilMs: number) =>
  new SourceRateLimitedError({ resetAtMs: untilMs, exhausted: true, detail: "fake: rate limit exhausted (x-ratelimit-remaining: 0)" });

// PR template for the fakes: `isDraft` is optional here (most tests don't care) and normalized to
// false on return, so existing `{ number, state, url }` literals stay valid; draft tests set it.
type FakePr = (Omit<PrInfo, "isDraft"> & { isDraft?: boolean }) | null;
const asPrInfo = (pr: FakePr): PrInfo | null => (pr ? { isDraft: false, ...pr } : null);

interface FakeState {
  eligible: Ticket[]; // jira source's eligible items
  eligible2: Ticket[]; // the optional second (lm) source's eligible items
  pr: FakePr; // what prForBranch (branch discovery) returns (isDraft optional ⇒ defaults false)
  prByNumber?: FakePr; // what prByNumber returns; undefined ⇒ mirror `pr`
  sig: ReviewSig;
  paneState: string;
  deadPanes: Set<string>; // panes herdr no longer tracks (paneAlive → false)
  tabPane: string | null; // what tabPaneByLabel resolves for the CONFIGURED label ("agent") — null ⇒ no match
  /** Per-TAB override of `tabPane`, keyed by tab title — a layout that gives each step its own pane
   *  (which is what makes "whose pane did the tokens land on" answerable). */
  tabPanes: Record<string, string | null>;
  tabPaneByName: Record<string, string>; // what tabPaneByLabel resolves for a NON-configured label (the drain-window dispatch name `${step}:${key}`)
  headSha: string;
  /** What `git status --porcelain` + `git diff --stat` report for the run's worktree — null ⇒ the
   *  tree is CLEAN (the tree guard's input; see core/tree-guard.ts). */
  dirtyStat: string | null;
  /** What `git diff --name-only <from> <to>` reports — null ⇒ git could not diff the two commits. */
  changedFiles: string[] | null;
  /** What `git rev-parse --abbrev-ref HEAD` reports for the run's WORKTREE — the branch tracking
   *  reads it every pass. `undefined` ⇒ the worktree is on whatever the run's branch already says
   *  (no rename); a string simulates an agent renaming the branch; null ⇒ detached HEAD. */
  worktreeBranch?: string | null;
  /** Same, for the MAIN checkout (the protected-branch set). */
  mainBranch: string | null;
  /** Branch names `branchExists` should report as present (a rename collision). */
  existingBranches: Set<string>;
  /** Branches with a remote-tracking ref (the "you already pushed this" warning). */
  pushedBranches: Set<string>;
  /** Does `git branch -m` succeed? */
  renameOk: boolean;
  renamed: string[]; // every branchRename target, in order
  sessionId: string | null;
  workspaceExists: boolean; // does the workspace still exist after a worktree remove?
  focusedPane: FocusedPane | null; // the pane the user is currently looking at
  humanReply: HumanReply | null; // source-native reply to a pending human question
  herdrUnreachable: boolean; // liveness queries throw HerdrUnreachableError (herdr can't be asked)
  failTransitions: boolean; // the jira source's transition() throws (backend down / 429 / workflow)
  failTransitionStates: Set<string>; // …or throws only for these target states
  staleTransitionStates: Set<string>; // transition() reports the item GONE for these target states
  humanPollError: Error | null; // pollHumanReply throws this instead of returning
  humanAskError: Error | null; // askHuman throws this instead of posting
  failEligible: boolean; // the jira source's listEligible throws (backend outage)
  authFail: boolean; // the jira source's calls throw SourceUnauthenticatedError (not authenticated)
  /** Epoch MILLISECONDS the jira source's calls claim its rate limit resets — null ⇒ not limited. */
  rateLimitedUntilMs: number | null;
  itemLabels: Record<string, string[]>; // labels the jira fake attaches per key (default [])
  fetchOk: boolean; // does the pre-worktree fetch of the base ref succeed?
  promptStalls: boolean; // agentSend reports the submission never moved the agent (herdr's stalled verdict)
  /** Does `pane at-shell-prompt` say the layout pane is at an available prompt with NO agent in it?
   *  What the layout wait's agent-restart keys on (issue #44). */
  atShellPrompt: boolean;
  adoptFails: boolean; // `agent start` refuses (herdr's agent_not_ready / a pane it can't adopt)
  agentLabel: string | null; // the agent herdr DETECTED in the pane (`agent list`'s `agent`) — null ⇒ never detected (#99)
  adoptError?: string; // herdr's lastAgentError after a refused `agent start`
  revision?: number | null; // herdr's per-pane `revision` (bumped on every screen change); absent ⇒ null
}

/** A resolved belt step for the fakes. Budgets/heartbeat/opensPr mirror what config.ts derives for
 *  a work_to_pull_request belt; override via `opts` for custom-belt steps. Like config.ts's
 *  resolveStep, a step with a layout tab/pane carries the layout-wait guard (bounded respawn). */
const stepCfg = (name: string, opts: Partial<StepConfig> = {}): StepConfig => {
  const heartbeat = opts.heartbeat ?? (name === "fix" || name === "pr");
  const opensPr = opts.opensPr ?? name === "pr";
  const gathersEvidence = opts.gathersEvidence ?? name === "evidence";
  const produces: StepConfig["produces"] = ["handoff"];
  if (heartbeat) produces.push("commits");
  if (opensPr) produces.push("pull_request");
  if (gathersEvidence) produces.push("evidence");
  const tab = Object.hasOwn(opts, "tab") ? opts.tab : name;
  const pane = Object.hasOwn(opts, "pane") ? opts.pane : "agent";
  const readOnly = opts.readOnly ?? false;
  // Mirror config.ts's resolveStep: the watch harness evaluates ATTACHED guards, so the budget /
  // heartbeat / read-only watches exist here exactly as production resolution would attach them
  // (heartbeat before budget — the stall diagnosis wins a double-trip).
  const guards: StepConfig["guards"] = [
    ...(heartbeat ? [HEARTBEAT_GUARD] : []),
    BUDGET_GUARD,
    ...(readOnly ? [READ_ONLY_GUARD] : []),
    ...(tab && pane ? [LAYOUT_WAIT_GUARD] : []),
  ];
  return {
    name,
    type: name === "fix" ? "work" : name,
    tab,
    pane,
    enginePrompt: `${name.toUpperCase()} prompt`,
    budgetSeconds: name === "fix" ? 5400 : name === "review" ? 1800 : 3600,
    heartbeat,
    opensPr,
    gathersEvidence,
    canBounceTo: name === "evidence" || name === "review" ? ["fix"] : [],
    readOnly,
    requiresLayout: false,
    consumes: [],
    produces,
    guards,
    effects: [],
    posture: {},
    ...opts,
  };
};
const prSteps = (): StepConfig[] => [stepCfg("fix"), stepCfg("review"), stepCfg("pr")];

function build(opts: { multi?: boolean } = {}) {
  const worktree = mkdtempSync(join(tmpdir(), "cats-wt-"));
  tmps.push(worktree);
  let now = 1000;
  let uidN = 0; // deterministic per-claim branch suffix (u1, u2, …) so re-claims get distinct branches
  const store = new Store(openDb(":memory:"), () => now);
  const state: FakeState = { eligible: [], eligible2: [], pr: null, sig: { unresolved: 0, failing: 0, pending: 0, sig: "s0" }, paneState: "idle", deadPanes: new Set(), tabPane: "w1:p1", tabPaneByName: {}, headSha: "sha0", dirtyStat: null, changedFiles: [], mainBranch: "master", existingBranches: new Set(), pushedBranches: new Set(), renameOk: true, renamed: [], sessionId: "sess-1", workspaceExists: false, focusedPane: { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" }, humanReply: null, herdrUnreachable: false, failTransitions: false, failTransitionStates: new Set(), staleTransitionStates: new Set(), humanPollError: null, humanAskError: null, failEligible: false, authFail: false, rateLimitedUntilMs: null, itemLabels: {}, promptStalls: false, fetchOk: true, tabPanes: {}, atShellPrompt: true, adoptFails: false, agentLabel: "claude" };
  const calls = {
    transitions: [] as [string, WorkState][],
    // Belt-effect deliveries: records the source-native statusOverride whenever one is passed.
    transitionOverrides: [] as [string, WorkState, string][],
    agentSend: [] as [string, string][],
    confirmedSends: [] as string[], // panes an agentSend was CONFIRMED on (`--wait --until …`)
    sendKeys: [] as [string, string][], // `agent send-keys` — [paneId, keys]
    // Display-only pane state (herdr `pane report-metadata`) — [paneId, agentName, title ?? null].
    // This replaced the pane RENAMES the factory used to convey step/attention state with.
    paneDisplay: [] as [string, string | undefined, string | null, Record<string, string | null>][],
    agentFocus: [] as string[],
    // Layout agent adoptions the engine issued — [paneId, name, kind, args] (the layout wait's
    // restart). The NAME matters: herdr refuses one that a live agent already holds.
    agentAdopt: [] as [string, string, string, string][],
    paneRun: [] as [string, string][], // text typed into a pane's shell (`pane run`)
    worktreeRemove: [] as string[],
    workspaceClose: [] as string[],
    rmrf: [] as string[],
    killPort: [] as number[], // teardown's dev-server reap — ports, never a real signal
    branchDelete: [] as string[],
    fetchRef: [] as [string, string, string][],
    humanAsk: [] as HumanAskInput[],
    humanPoll: [] as HumanPollInput[],
    postNotes: [] as [string, string][],
    prSnapshots: [] as number[][],
    reviewSig: 0,
    agentStart: 0,
    notify: 0,
    notified: [] as [string, string][], // (title, body) of every notification — the ready-to-merge text is asserted
    eligibleQueries: 0, // jira listEligible calls that actually reached the backend
  };
    // Panes in a herdr layout tree — the fake answers layoutApply with that many ids.
  const countPanes = (n: LayoutNode): number => (n.type === "pane" ? 1 : countPanes(n.first) + countPanes(n.second));
  const wrapJira = (t: Ticket): JiraMatchItem => ({ sourceType: "jira", key: t.key, summary: t.summary, type: t.type, status: "To Do", labels: state.itemLabels[t.key] ?? [], fields: {} });
  const wrapLm = (t: Ticket): LocalMarkdownMatchItem => ({ sourceType: "local_markdown", key: t.key, summary: t.summary, type: t.type, labels: [], fields: {}, path: `/f/${t.key}.md`, filename: `${t.key}.md`, frontMatter: {}, body: "" });
  // Fake work sources; transitions record the CANONICAL WorkState (the canonical→backend mapping
  // lives inside the real JiraSource/LocalMarkdownSource, which these fakes stand in for).
  const jiraClient: WorkSource = {
    spec: { statusOfRecord: "external", mappedStates: ["todo", "in_development", "in_review"], replyChannel: "comments" },
    authStatus: async () => (state.authFail ? { state: "unauthenticated", detail: "fake: JIRA_API_TOKEN missing" } : { state: "ok" }),
    listEligible: async () => {
      if (state.authFail) throw new SourceUnauthenticatedError({ reason: "rejected", hint: "fake: not authenticated" });
      if (state.rateLimitedUntilMs != null) throw rateLimited(state.rateLimitedUntilMs);
      if (state.failEligible) throw new Error("jira is down (fake)");
      calls.eligibleQueries += 1;
      return state.eligible.map(wrapJira);
    },
    describe: async (key) => ({ key, summary: "Fix the thing", type: "Bug" }),
    transition: async (key, to, _pickup, _ctx, statusOverride) => {
      if (state.authFail) throw new SourceUnauthenticatedError({ reason: "rejected", hint: "fake: not authenticated" });
      if (state.rateLimitedUntilMs != null) throw rateLimited(state.rateLimitedUntilMs);
      if (state.failTransitions || state.failTransitionStates.has(to)) throw new Error(`transition to ${to} failed (fake)`);
      if (state.staleTransitionStates.has(to)) return { kind: "stale", detail: "issue deleted (fake)" };
      calls.transitions.push([key, to]);
      if (statusOverride !== undefined) calls.transitionOverrides.push([key, to, statusOverride]);
      return { kind: "applied" };
    },
    materialize: async (_key, memDir) => { mkdirSync(memDir, { recursive: true }); writeFileSync(join(memDir, "ticket.json"), "{}"); },
    workDoc: async () => ({ path: "ticket.json", kind: "Jira ticket (JSON)" }),
    postNote: async (key, note) => { calls.postNotes.push([key, note]); },
    askHuman: async (input) => {
      if (state.humanAskError) throw state.humanAskError;
      calls.humanAsk.push(input);
      return { externalId: `q-${input.questionId}`, externalCreatedAt: "2026-06-28T00:00:00.000+0000" };
    },
    pollHumanReply: async (input) => {
      if (state.humanPollError) throw state.humanPollError;
      calls.humanPoll.push(input);
      return state.humanReply;
    },
    health: async () => {},
  };
  // Per-source cap set high (effectively unlimited) so the DEFAULT-2 cap doesn't bite the existing
  // global-cap tests; the dedicated per-source-cap test overrides it explicitly.
  const sources: SourceRuntime[] = [{ name: "jira", type: "jira", client: jiraClient, pollIntervalSeconds: 60, maxActiveWorkspaces: 999, lastPolledAt: new Map(), lastEligible: new Map() }];
  // The default belt: a work_to_pull_request belt on the jira source (today's fix→review→pr flow).
  const shipBelt: BeltRuntime = { name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, steps: prSteps(), watchPr: true };
  const belts: BeltRuntime[] = [shipBelt];

  let lmBelt: BeltRuntime | undefined;
  if (opts.multi) {
    const lmClient: WorkSource = {
      spec: { statusOfRecord: "internal", mappedStates: ["todo", "in_development", "in_review", "merged", "aborted", "done"], replyChannel: "file" },
      authStatus: async () => ({ state: "not_applicable" }),
      listEligible: async () => state.eligible2.map(wrapLm),
      describe: async (key) => ({ key, summary: "md work", type: "task" }),
      transition: async (key, to) => { calls.transitions.push([key, to]); return { kind: "applied" }; },
      materialize: async (_key, memDir) => { mkdirSync(memDir, { recursive: true }); writeFileSync(join(memDir, "task.md"), "# md"); },
      workDoc: async () => ({ path: "task.md", kind: "markdown file" }),
      postNote: async (key, note) => { calls.postNotes.push([key, note]); },
      askHuman: async (input) => { calls.humanAsk.push(input); return { externalId: `q-${input.questionId}`, externalCreatedAt: "2026-06-28T00:00:00.000+0000" }; },
      pollHumanReply: async (input) => { calls.humanPoll.push(input); return state.humanReply; },
      health: async () => {},
    };
    sources.push({ name: "lm", type: "local_markdown", client: lmClient, pollIntervalSeconds: 60, maxActiveWorkspaces: 999, lastPolledAt: new Map(), lastEligible: new Map() });
    lmBelt = { name: "lmship", beltType: "work_to_pull_request", source: "lm", priority: 2, active: true, workspaceName: "feature/{{work_id}}", steps: prSteps(), watchPr: true };
    belts.push(lmBelt);
  }

  const herdr: HerdrApi = {
    worktreeCreate: async () => ({ workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1" }),
    worktreeOpen: async () => ({ workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1" }),
    worktreeRemove: async (id) => { calls.worktreeRemove.push(id); },
    workspaceClose: async (id) => { calls.workspaceClose.push(id); },
    workspaceExists: async () => state.workspaceExists,
    paneState: async () => {
      if (state.herdrUnreachable) throw new HerdrUnreachableError("agent list failed");
      return state.paneState;
    },
    paneAlive: async (id) => {
      if (state.herdrUnreachable) throw new HerdrUnreachableError("agent list failed");
      return !state.deadPanes.has(id);
    },
    agentSessionId: async () => state.sessionId,
    // Configured label ("agent") resolves to state.tabPane; a renamed dispatch name resolves from
    // state.tabPaneByName (empty ⇒ null), mirroring how the first dispatch renames a pane's label.
    tabPaneByLabel: async (_ws, tab, pane) =>
      pane === "agent" ? (Object.hasOwn(state.tabPanes, tab) ? state.tabPanes[tab]! : state.tabPane) : (state.tabPaneByName[pane] ?? null),
    agentStart: async () => { calls.agentStart += 1; return "w1:p2"; },
    paneRun: async (id, cmd) => { calls.paneRun.push([id, cmd]); },
    paneAgentLabel: async () => state.agentLabel,
    get lastAgentError() { return state.adoptError ?? null; },
    paneClose: async () => {},
    agentAdopt: async (paneId, o) => {
      calls.agentAdopt.push([paneId, o.name, o.kind, (o.args ?? []).join(" ")]);
      return !state.adoptFails;
    },
    tabCreate: async () => ({ tabId: "w1:t2", paneId: "w1:pN" }),
    tabRename: async () => {},
    layoutApply: async (o) => ({ tabId: "w1:t2", paneIds: ["w1:pN", "w1:pN2", "w1:pN3"].slice(0, countPanes(o.root)) }),
    tabArea: async () => ({ cols: 200, rows: 50 }),
    agentOpenPrompt: async () => true,
    paneAtShellPrompt: async () => state.atShellPrompt,
    firstTabId: async () => "w1:t1",
    workspaceInfo: async () => ({ checkoutPath: worktree, repoRoot: "/main-checkout", repoName: "n", isLinkedWorktree: true, tabCount: 1, paneCount: 1, activeTabId: "w1:t1" }),
    worktreeBranch: async () => "fix/K-1",
    firstPaneOfTab: async () => "w1:p1",
    listPanes: async () => [{ paneId: "w1:p1", tabId: "w1:t1", label: null }],
    agentSend: async (p, t, o) => {
      calls.agentSend.push([p, t]);
      if (o?.confirm) calls.confirmedSends.push(p);
      return !state.promptStalls;
    },
    paneRevision: async () => state.revision ?? null,
    agentSendKeys: async (p, keys) => { calls.sendKeys.push([p, keys.join(" ")]); },
    agentFocus: async (id) => { calls.agentFocus.push(id); },
    focusedPane: async () => state.focusedPane,
    reportPaneDisplay: async (p, d) => { calls.paneDisplay.push([p, d.agentName, d.title ?? null, d.tokens ?? {}]); },
    notify: async (title, body) => { calls.notify += 1; calls.notified.push([title, body]); },
  };
  const github: GitHubApi = {
    prForBranch: async () => asPrInfo(state.pr),
    prByNumber: async () => asPrInfo(state.prByNumber === undefined ? state.pr : state.prByNumber),
    reviewSignature: async () => {
      calls.reviewSig += 1;
      return state.sig;
    },
    // Loose fake (like prByNumber): every requested number resolves from the PR template.
    prSnapshots: async (_repo, numbers) => {
      calls.prSnapshots.push([...numbers]);
      const pr = asPrInfo(state.prByNumber === undefined ? state.pr : state.prByNumber);
      const map = new Map<number, PrSnapshot>();
      for (const n of numbers) if (pr) map.set(n, { ...pr, number: n, sig: state.sig });
      return map;
    },
    currentLogin: async () => "test-user",
  };
  const git: GitApi = {
    branchExists: async (_cwd, b) => state.existingBranches.has(b),
    fetchRef: async (cwd, remote, b) => {
      calls.fetchRef.push([cwd, remote, b]);
      return state.fetchOk;
    },
    refAge: async () => "9 days ago",
    // The worktree answers with the simulated rename (state.worktreeBranch), the main checkout with
    // its own branch — that split is what the protected-branch guard keys on.
    currentBranch: async (cwd) => (cwd === "/main-checkout" ? state.mainBranch : (state.worktreeBranch === undefined ? null : state.worktreeBranch)),
    remoteBranchExists: async (_cwd, b) => state.pushedBranches.has(b),
    branchRename: async (_cwd, to) => {
      state.renamed.push(to);
      if (state.renameOk) state.worktreeBranch = to;
      return state.renameOk;
    },
    branchDelete: async (_cwd, b) => { calls.branchDelete.push(b); return true; },
    worktreePrune: async () => {},
    originUrl: async () => "git@github.com:o/n.git",
    headSha: async () => state.headSha,
    dirtyStat: async () => state.dirtyStat,
    excludeMemoryDir: async () => {},
    changedFiles: async () => state.changedFiles,
  };
  const env = { JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" };
  const config: Config = {
    repoName: "demo",
    repo: { path: "/main-checkout", baseRef: "origin/master" },
    limits: { maxActiveWorkspaces: 3, attentionRenotifySeconds: 3600, stallSeconds: 2700, idleNudgeSeconds: 300, maxBounces: 3, maxCaptureAttempts: 5, stepBudgetSeconds: 3600, tickIntervalSeconds: 60, reconcileConcurrency: 8, maxClaimsPerTick: 10, layoutWaitSeconds: 600 },
    sources: sources.map((s) => ({ name: s.name, type: s.type, pollIntervalSeconds: s.pollIntervalSeconds, maxActiveWorkspaces: s.maxActiveWorkspaces, cfg: {} })),
    belts,
    layouts: [],
    sourceComments: { brand: "herdr-factory" },
    guidance: undefined,
    agent: DEFAULT_AGENT_CONFIG,
    paths: { configDir: "/c", repoDir: "/c/repos/demo", stateRoot: "/s", stateDir: "/s/demo", dbPath: "/s/db", logsDir: join(worktree, "logs") },
  };
  const deps: Deps = {
    config,
    env,
    store,
    ghRepo: "o/n",
    herdr,
    sources,
    resolveSource: (name) => sources.find((s) => s.name === name),
    belts,
    resolveBelt: (name) => belts.find((b) => b.name === name),
    github,
    git,
    log: () => {},
    now: () => now,
    uid: () => `u${++uidN}`,
    sleep: async () => {},
    rmrf: async (p) => { calls.rmrf.push(p); },
    killPortListeners: async (port, wt) => {
      calls.killPort.push(port);
      return { killed: [{ pid: 4242, rssKb: 2_400_000, cwd: wt }], skipped: [], lsof: `lsof -nP -ti tcp:${port} -sTCP:LISTEN` };
    },
  };
  return { deps, store, state, calls, config, setNow: (n: number) => { now = n; }, worktree, shipBelt, lmBelt, sources };
}

const ticket = (key: string, type = "Bug"): Ticket => ({ key, summary: "Fix the thing", type });

/** Queue an evidence media publish the way the CLI does — a ledger `evidence_publish` intent. */
function enqueueEvidencePublish(store: Store, runId: number, keyPrefix: string, evidenceDir: string) {
  return store.enqueueIntent({
    repo: "demo",
    kind: "evidence_publish",
    scope: `run:${runId}`,
    runId,
    ticketKey: store.getRun(runId)!.ticketKey,
    dedupKey: keyPrefix,
    payload: JSON.stringify({ keyPrefix, evidenceDir }),
    causeScope: "publisher:s3",
    supersedeScope: true,
  });
}

/** Seed an active run already parked at `phase`/`step`, with the active step's run_step spawned. */
function seed(
  store: Store,
  worktree: string,
  key: string,
  phase: Phase,
  step: string | null,
  extra: Record<string, unknown> = {},
  belt = "ship",
  workSource = "jira",
) {
  const run = store.createRun({ repo: "demo", workSource, belt, ticketKey: key, summary: "s", issueType: "Bug", branch: `fix/${key}-s` });
  store.updateRun(run.id, { phase, step, workspaceId: "w1", worktreePath: worktree, paneId: "w1:p1", ...extra });
  // dispatchedAt: a seeded active step is a DISPATCHED pass (its agent has the prompt) — the
  // reconciler's spawn branch keys on it, and an undispatched row would be re-prompted instead of
  // watched. Mirrors the row's insert-time started_at, like the migration backfill.
  if (step) {
    const row = store.upsertRunStep(run.id, step, { paneId: "w1:p1" });
    store.upsertRunStep(run.id, step, { dispatchedAt: row.startedAt });
    // ...and the budget clock a real dispatch arms alongside it (step.ts). Since v35 the watch_state
    // row is the ONLY budget clock — started_at is layout-wait/dispatch bookkeeping, not a fallback —
    // so a seeded step without this row is a step whose budget can never expire.
    store.upsertWatchState(run.id, step, "budget", { basedAt: row.startedAt });
  }
  return store.getRun(run.id)!;
}

// The shared run-scoped signal effect (core/signals.ts) that BOTH the HTTP handler and the CLI
// in-process fallback call. These lock the seam: run resolution, the fire-and-forget vs waiting lock
// choice, and the result shapes — the engine functions beneath (bounceStep, …) are covered above.
// ── Branch tracking ────────────────────────────────────────────────────────────────────────────
// A run's identity is its WORKTREE (`worktree_name` + workspace id + checkout path). The branch is
// tracked state: the factory can only name it from what the source knows at claim time, so an agent
// may move the worktree onto the name the repo's branching/CI convention requires, and the engine
// follows it for prompts, PR discovery, and branch cleanup.
describe("branch tracking — the branch follows the worktree; identity does not", () => {
  it("follows a rename made in the worktree and records it (identity keeps the worktree name)", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-BR1", "running", "review");
    state.worktreeBranch = "fix/RWR-18500-toast"; // the agent renamed the branch to the repo's shape
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.branch).toBe("fix/RWR-18500-toast");
    expect(got.worktreeName).toBe("fix/K-BR1-s"); // frozen — this is what the worktree is called
    const ev = store.timeline("demo", "K-BR1").find((e) => e.type === "branch_changed");
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev!.detail ?? "{}")).toMatchObject({ from: "fix/K-BR1-s", to: "fix/RWR-18500-toast", via: "observed" });
  });

  it("a DETACHED head changes nothing (mid-rebase is not a rename)", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-BR2", "running", "review");
    state.worktreeBranch = null;
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.branch).toBe("fix/K-BR2-s");
    expect(store.timeline("demo", "K-BR2").some((e) => e.type === "branch_changed")).toBe(false);
  });

  it("never tracks onto a PROTECTED branch (a worktree left on the base ref is a mistake)", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-BR3", "running", "review");
    state.worktreeBranch = "master"; // == the main checkout's branch / the base ref's tail
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.branch).toBe("fix/K-BR3-s");
    expect(store.timeline("demo", "K-BR3").some((e) => e.type === "branch_changed")).toBe(false);
  });

  it("PR discovery tries the renamed branch AND the name the worktree was created under", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-BR4", "running", "pr");
    state.worktreeBranch = "fix/RWR-1-x"; // renamed AFTER the push, so the PR head is the old name
    const asked: string[] = [];
    deps.github = {
      ...deps.github,
      prForBranch: async (_repo, branch) => {
        asked.push(branch);
        return branch === "fix/K-BR4-s" ? { number: 41, state: "OPEN", url: "u", isDraft: false } : null;
      },
    };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(asked).toEqual(["fix/RWR-1-x", "fix/K-BR4-s"]); // current branch first, then the worktree name
    expect(store.getRun(run.id)!.prNumber).toBe(41);
  });

  it("does NOT adopt a PR that predates the run (a previous attempt's PR on a reused branch name)", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-BR5", "running", "pr");
    // A convention-shaped rename drops the per-claim uid, so `--head` can resolve last month's PR.
    state.pr = { number: 7, state: "MERGED", url: "u", createdAt: store.getRun(run.id)!.createdAt - 86_400 };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.prNumber).toBeNull();
    expect(got.phase).toBe("running"); // NOT torn down on someone else's merge
  });

  it("teardown deletes every name the run may have left behind, and never a protected one", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-BR6", "reviewing", null, {});
    store.updateRun(run.id, { branch: "fix/RWR-2-y" }); // renamed mid-run
    state.worktreeBranch = "fix/RWR-2-y";
    state.pr = { number: 9, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.outcome).toBe("merged");
    expect(calls.branchDelete).toEqual(expect.arrayContaining(["fix/RWR-2-y", "fix/K-BR6-s"]));
    expect(calls.branchDelete).not.toContain("master");
  });
});

describe("set-branch — the agent's front door onto the repo's branch convention", () => {
  it("renames the worktree's branch, tracks it, and records the change", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-SB1", "running", "fix");
    state.worktreeBranch = "fix/K-SB1-s";
    const res = await applySignal(deps, "set-branch", { key: "K-SB1", branch: "fix/RWR-18500-toast" });
    expect(res.ok).toBe(true);
    expect(state.renamed).toEqual(["fix/RWR-18500-toast"]);
    expect(store.getRun(run.id)!.branch).toBe("fix/RWR-18500-toast");
    expect(store.timeline("demo", "K-SB1").some((e) => e.type === "branch_changed")).toBe(true);
  });

  it("warns when the OLD branch was already pushed (the remote head is now orphaned)", async () => {
    const { deps, store, state, worktree } = build();
    seed(store, worktree, "K-SB2", "running", "fix");
    state.worktreeBranch = "fix/K-SB2-s";
    state.pushedBranches.add("fix/K-SB2-s");
    const res = await applySignal(deps, "set-branch", { key: "K-SB2", branch: "fix/RWR-3-z" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("push origin --delete fix/K-SB2-s");
  });

  it("refuses once the PR is open — renaming then would strand it", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-SB3", "running", "pr");
    state.worktreeBranch = "fix/K-SB3-s";
    store.updateRun(run.id, { prNumber: 12 });
    const res = await applySignal(deps, "set-branch", { key: "K-SB3", branch: "fix/RWR-4-a" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("#12");
    expect(state.renamed).toEqual([]);
    expect(store.getRun(run.id)!.branch).toBe("fix/K-SB3-s");
  });

  it("refuses an invalid ref name, a protected branch, and a name that already exists", async () => {
    const { deps, store, state, worktree } = build();
    seed(store, worktree, "K-SB4", "running", "fix");
    state.worktreeBranch = "fix/K-SB4-s";
    state.existingBranches.add("fix/taken");
    expect((await applySignal(deps, "set-branch", { key: "K-SB4", branch: "fix/bad name" })).message).toContain("not a valid branch name");
    expect((await applySignal(deps, "set-branch", { key: "K-SB4", branch: "master" })).message).toContain("protected");
    expect((await applySignal(deps, "set-branch", { key: "K-SB4", branch: "fix/taken" })).message).toContain("already exists");
    expect(state.renamed).toEqual([]);
  });

  it("is idempotent when the worktree is already on the branch (a replayed command)", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-SB5", "running", "fix");
    state.worktreeBranch = "fix/RWR-5-b"; // renamed by hand; the run row hasn't caught up yet
    expect((await applySignal(deps, "set-branch", { key: "K-SB5", branch: "fix/RWR-5-b" })).ok).toBe(true);
    expect(store.getRun(run.id)!.branch).toBe("fix/RWR-5-b");
    const again = await applySignal(deps, "set-branch", { key: "K-SB5", branch: "fix/RWR-5-b" });
    expect(again.ok).toBe(true);
    expect(again.message).toContain("already on");
    expect(state.renamed).toEqual([]); // nothing to rename either time
  });

  it("refuses a rename while HEAD is detached", async () => {
    const { deps, store, state, worktree } = build();
    seed(store, worktree, "K-SB6", "running", "fix");
    state.worktreeBranch = null;
    const res = await applySignal(deps, "set-branch", { key: "K-SB6", branch: "fix/RWR-6-c" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("detached");
  });
});

describe("applySignal — shared run-scoped agent signal effect", () => {
  it("step-done: marks the step done, records the event, and advances the belt (fire-and-forget lock)", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-AS1", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    const res = await applySignal(deps, "step-done", { key: "K-AS1", step: "review" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("pr"); // advanced past review
    expect(store.getRunStep(run.id, "review")!.done).toBe(true);
    expect(store.timeline("demo", "K-AS1").some((e) => e.type === "step_done")).toBe(true);
  });

  // ISSUE #68 item 4: a silent exit 0 is indistinguishable from a dropped signal, so the NEXT
  // agents polled `status` and slept to find out whether the belt had moved. step-done now says it.
  it("step-done: reports the transition it caused (advanced <from> → <to>)", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-TR1", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    const res = await applySignal(deps, "step-done", { key: "K-TR1", step: "review" });
    expect(res.fromStep).toBe("review");
    expect(res.nextStep).toBe("pr");
    expect(res.message).toBe("advanced review → pr");
    expect(store.getRun(run.id)!.step).toBe("pr");
  });

  it("step-done: an idempotent replay of an already-done step still reports, and never claims an advance", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-TR2", "running", "pr");
    store.upsertRunStep(run.id, "review", { done: true });
    const replay = await applySignal(deps, "step-done", { key: "K-TR2", step: "review" });
    expect(replay.ok).toBe(true);
    expect(replay.message).toContain("already recorded done");
    expect(store.getRun(run.id)!.step).toBe("pr");
  });

  // ISSUE #68 item 5: the wall/shell/model split used to need decoding the agent harness's own chat
  // store by hand. The shell half is the time the factory itself measured — gate receipts.
  it("step-done: exports the pass's wall / shell / model split into the timeline", async () => {
    const { deps, store, worktree, setNow } = build();
    const run = seed(store, worktree, "K-TM1", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    store.recordGateReceipt({ runId: run.id, step: "review", pass: 1, gate: "test", command: "pnpm test", head: "sha0", exitCode: 0, durationMs: 30_000, tail: null });
    setNow(1000 + 600); // the step was seeded at t=1000; it finishes ten minutes later
    await applySignal(deps, "step-done", { key: "K-TM1", step: "review" });
    const ev = store.timeline("demo", "K-TM1").find((e) => e.type === "step_timing")!;
    expect(ev, "step-done recorded no step_timing event").toBeTruthy();
    expect(JSON.parse(ev.detail!)).toMatchObject({ step: "review", pass: 1, wallMs: 600_000, shellMs: 30_000, modelMs: 570_000, gates: 1 });
  });

  it("an in-flight run whose belt is inactive still advances (inactive only gates new claims)", async () => {
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.active = false; // the belt was paused after this run was already claimed
    const run = seed(store, worktree, "K-INACT", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    const res = await applySignal(deps, "step-done", { key: "K-INACT", step: "review" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("pr"); // progressed as usual despite the belt being inactive
  });

  it("step-done: rejects a step that isn't in the run's belt (no advance)", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-AS1b", "running", "review");
    const res = await applySignal(deps, "step-done", { key: "K-AS1b", step: "not_a_step" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("not in belt");
    expect(store.getRun(run.id)!.step).toBe("review"); // unchanged
  });

  it("no active run → ok:false with a bare message (no key prefix — the caller adds it)", async () => {
    const { deps } = build();
    expect(await applySignal(deps, "step-done", { key: "GHOST", step: "review" })).toEqual({ ok: false, message: "no active run" });
  });

  it("bounce: routes through the waiting run-lock, rewinds the step, clears the target's done", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-AS2", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    const res = await applySignal(deps, "bounce", { key: "K-AS2", toStep: "fix", reason: "the toast still 500s" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("fix");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    // The happy path consumes its own durable intent on the spot.
    expect(store.unconsumedPendingSignalForRun(run.id)).toBeUndefined();
  });

  it("bounce: a contended run lock queues a durable intent instead of dropping the signal; the tick applies it", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-QB1", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    // Someone else holds this run's lock for the whole bounded wait (a tick mid-pass on this run).
    expect(store.acquireLock(`run:${run.id}`, "tick", 600)).toBe(true);
    const res = await applySignal(deps, "bounce", { key: "K-QB1", toStep: "fix", reason: "regressed" });
    expect(res.ok).toBe(true);
    expect(res.queued).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("review"); // not applied yet — but not lost either
    const intent = store.unconsumedPendingSignalForRun(run.id)!;
    expect(intent.signal).toBe("bounce");
    expect(intent.step).toBe("review"); // attribution: the issuing step at enqueue time
    expect(intent.toStep).toBe("fix");
    expect(store.timeline("demo", "K-QB1").some((e) => e.type === "signal_queued")).toBe(true);
    // The tick comes around (lock free again), consumes the intent, and the bounce lands.
    store.releaseLock(`run:${run.id}`, "tick");
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("fix");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    expect(store.unconsumedPendingSignalForRun(run.id)).toBeUndefined();
    expect(store.getPendingSignal(intent.id)!.consumedResult).toBe("applied");
  });

  it("bounce: a queued intent whose issuing step has moved on is rejected, never applied to the wrong step", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-QB2", "running", "pr");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    // An old bounce recorded while `review` ran; by consume time the run has advanced to `pr`.
    const intent = store.enqueuePendingSignal({ runId: run.id, repo: "demo", ticketKey: "K-QB2", signal: "bounce", step: "review", toStep: "fix", payload: "stale findings" });
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("pr"); // unchanged
    expect(store.getRunStep(run.id, "fix")!.done).toBe(true); // rework pass NOT wrongly opened
    expect(store.getPendingSignal(intent.id)!.consumedResult).toMatch(/^rejected: issued by step "review"/);
    expect(store.timeline("demo", "K-QB2").some((e) => e.type === "signal_rejected")).toBe(true);
  });

  it("ask-human: a contended run lock queues the question durably; the tick posts it and parks the run", async () => {
    const { deps, store, calls, worktree } = build();
    const run = seed(store, worktree, "K-QH1", "running", "review");
    expect(store.acquireLock(`run:${run.id}`, "tick", 600)).toBe(true);
    const res = await applySignal(deps, "ask-human", { key: "K-QH1", step: "review", question: "which auth flow?" });
    expect(res.ok).toBe(true);
    expect(res.queued).toBe(true);
    expect(store.getRun(run.id)!.phase).toBe("running"); // not applied yet
    expect(calls.humanAsk.length).toBe(0);
    store.releaseLock(`run:${run.id}`, "tick");
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    expect(calls.humanAsk.length).toBe(1);
    expect(store.pendingHumanQuestionForRun(run.id)!.question).toBe("which auth flow?");
  });

  it("bounce: an unknown target step fails loudly at the agent and persists no intent", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-QB3", "running", "review");
    const res = await applySignal(deps, "bounce", { key: "K-QB3", toStep: "wrk", reason: "typo" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("not in belt");
    expect(store.unconsumedPendingSignalForRun(run.id)).toBeUndefined();
  });

  it("enqueuePendingSignal: a newer intent supersedes an unconsumed older one (newest decision wins)", async () => {
    const { store, worktree } = build();
    const run = seed(store, worktree, "K-QB4", "running", "review");
    const first = store.enqueuePendingSignal({ runId: run.id, repo: "demo", ticketKey: "K-QB4", signal: "ask_human", step: "review", payload: "q1" });
    const second = store.enqueuePendingSignal({ runId: run.id, repo: "demo", ticketKey: "K-QB4", signal: "bounce", step: "review", toStep: "fix", payload: "findings" });
    expect(store.getPendingSignal(first.id)!.consumedResult).toBe("superseded");
    expect(store.unconsumedPendingSignalForRun(run.id)!.id).toBe(second.id);
  });
});

// A step-execution watchdog park (budget / stall / capture cap) is a backstop against a STUCK
// agent, never a veto on its terminal decision. step-done from the parked step already un-parked
// the run (reconcileAttention's auto-rescue); bounce — the step's other legal terminal — must land
// symmetrically, instead of being rejected while the agent that issued it has already stopped.
describe("bounce from a watchdog-parked step", () => {
  it("a bounce from a step parked by its own watchdog un-parks the run and rewinds it", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-BP1", "attention", "review", { attentionReason: "review step over budget (worker: idle)" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "K-BP1", type: "attention", detail: { reason: "step_budget", step: "review" } });
    const res = await applySignal(deps, "bounce", { key: "K-BP1", toStep: "fix", reason: "the fix regressed the toast", step: "review", pass: 1 });
    expect(res.ok).toBe(true);
    const fresh = store.getRun(run.id)!;
    expect(fresh.phase).toBe("running");
    expect(fresh.step).toBe("fix");
    const resumed = store.timeline("demo", "K-BP1").filter((e) => e.type === "resumed").map((e) => JSON.parse(e.detail ?? "{}").reason);
    expect(resumed).toContain("bounce_after_watchdog_park");
  });

  it("resume after a bounce_limit park refunds the bounce budget (the human judged the loop worth continuing)", async () => {
    const { deps, store, worktree } = build(); // limits.maxBounces = 3 in the test config
    const run = seed(store, worktree, "K-RB1", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    // Burn the whole budget: 3 rework cycles (bounce → fix re-done → back at review) succeed…
    for (let cycle = 1; cycle <= 3; cycle++) {
      const b = await applySignal(deps, "bounce", { key: "K-RB1", toStep: "fix", reason: `round ${cycle}`, step: "review", pass: cycle });
      expect(b.ok).toBe(true);
      expect(b.escalated).toBeFalsy();
      const d = await applySignal(deps, "step-done", { key: "K-RB1", step: "fix", pass: cycle + 1 });
      expect(d.ok).toBe(true);
      expect(store.getRun(run.id)!.step).toBe("review");
    }
    // …and the 4th parks the run as bounce_limit (the oscillation backstop).
    const capped = await applySignal(deps, "bounce", { key: "K-RB1", toStep: "fix", reason: "round 4", step: "review", pass: 4 });
    expect(capped.escalated).toBe(true);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    // A human resume refunds the budget, so the loop can actually continue —
    // without the refund the very next bounce would land at cap+1 and re-park immediately.
    const resumed = await resumeRun(deps, store.getRun(run.id)!);
    expect(resumed.ok).toBe(true);
    const again = await applySignal(deps, "bounce", { key: "K-RB1", toStep: "fix", reason: "round 5", step: "review", pass: 4 });
    expect(again.ok).toBe(true);
    expect(again.escalated).toBeFalsy();
    expect(store.getRun(run.id)!.step).toBe("fix"); // the rework cycle reopened
  });

  it("a bounce from a human park (pr_closed, bounce_limit, …) stays rejected — those need a person", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-BP2", "attention", "review", { attentionReason: "PR #7 closed without merging" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "K-BP2", type: "attention", detail: { reason: "pr_closed" } });
    const res = await applySignal(deps, "bounce", { key: "K-BP2", toStep: "fix", reason: "redo", step: "review", pass: 1 });
    expect(res.ok).toBe(false);
    expect(store.getRun(run.id)!.phase).toBe("attention"); // untouched
    expect(store.getRun(run.id)!.step).toBe("review");
  });
});

// Pass stamping: bounce rewinds make per-step progress non-monotonic, so every entry into a step
// opens a new PASS (run_steps.pass), the pass is stamped into the rendered prompt's signal commands
// (--pass N), and a signal carrying a stale stamp is rejected instead of completing/rewinding a
// pass it doesn't belong to.
describe("pass stamping — signals are bound to the step pass that minted them", () => {
  it("a bounce opens the target's next pass, re-renders its prompt with the new stamp, and re-prompts its own pane", async () => {
    const { deps, store, calls, worktree } = build();
    const run = seed(store, worktree, "K-P1", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    expect(store.getRunStep(run.id, "fix")!.pass).toBe(1);
    const res = await applySignal(deps, "bounce", { key: "K-P1", toStep: "fix", reason: "regressed", step: "review", pass: 1 });
    expect(res.ok).toBe(true);
    expect(store.getRunStep(run.id, "fix")!.pass).toBe(2);
    // The re-dispatch goes through spawnStep: prompt re-rendered (rework banner + fresh stamp),
    // then the step's own live pane is re-prompted to read it.
    const prompt = readFileSync(join(worktree, ".memory/herdr-factory/prompt-fix.md"), "utf8");
    expect(prompt).toContain("--pass 2");
    expect(prompt).toContain("Rework requested — READ THIS FIRST");
    const sent = calls.agentSend.find(([pane]) => pane === "w1:pfix");
    expect(sent?.[1]).toContain("prompt-fix.md");
  });

  it("a stale step-done from the pre-bounce pass cannot complete the rework pass", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-P2", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    await applySignal(deps, "bounce", { key: "K-P2", toStep: "fix", reason: "regressed", step: "review", pass: 1 });
    // A duplicated/replayed `step-done fix --pass 1` (server+fallback double-apply, re-run command)
    // lands after the rewind cleared fix's done flag: it must NOT complete pass 2.
    const stale = await applySignal(deps, "step-done", { key: "K-P2", step: "fix", pass: 1 });
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain("stale step-done");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    expect(store.getRun(run.id)!.step).toBe("fix"); // rework still open
    // The rework pass's own command (pass 2) completes normally.
    const good = await applySignal(deps, "step-done", { key: "K-P2", step: "fix", pass: 2 });
    expect(good.ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("review"); // advanced forward again
    expect(store.getRunStep(run.id, "review")!.pass).toBe(2); // forward re-entry opened review's next pass
  });

  it("a step-done for a non-active step is rejected loudly (or acknowledged as a done replay), never silently wiped", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-P3", "running", "review");
    // Misaddressed: fix is not the active step and not done — rejected, not recorded-then-wiped.
    const misaddressed = await applySignal(deps, "step-done", { key: "K-P3", step: "fix" });
    expect(misaddressed.ok).toBe(false);
    expect(misaddressed.message).toContain("not the run's active step");
    expect(store.getRunStep(run.id, "fix")?.done ?? false).toBe(false);
    // Replay of an already-done earlier step: acknowledged as a noop (the agent's work IS done).
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    const replay = await applySignal(deps, "step-done", { key: "K-P3", step: "fix" });
    expect(replay.ok).toBe(true);
    expect(replay.message).toContain("already recorded done");
    expect(store.getRun(run.id)!.step).toBe("review"); // untouched
  });

  it("a queued bounce whose pass stamp went stale is rejected at consume time", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-P4", "running", "review");
    store.upsertRunStep(run.id, "review", { pass: 3 });
    // A bounce minted by review's pass 2 (an old prompt) surviving in the queue until pass 3.
    const intent = store.enqueuePendingSignal({ runId: run.id, repo: "demo", ticketKey: "K-P4", signal: "bounce", step: "review", toStep: "fix", payload: "old findings", pass: 2 });
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("review"); // no rewind
    expect(store.getPendingSignal(intent.id)!.consumedResult).toMatch(/^rejected: issued on pass 2/);
  });

  it("completing a rework pass archives its feedback note under a pass-stamped name", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-P5", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    await applySignal(deps, "bounce", { key: "K-P5", toStep: "fix", reason: "toast still 500s", step: "review", pass: 1 });
    expect(existsSync(join(worktree, ".memory/herdr-factory/feedback-fix.md"))).toBe(true);
    await applySignal(deps, "step-done", { key: "K-P5", step: "fix", pass: 2 });
    // Advanced out of fix: the addressed note is archived, so a later re-render can't resurrect it.
    expect(existsSync(join(worktree, ".memory/herdr-factory/feedback-fix.md"))).toBe(false);
    expect(existsSync(join(worktree, ".memory/herdr-factory/feedback-fix-addressed-pass2.md"))).toBe(true);
  });

  it("a bounce to a DEAD pane heals through the bounded layout wait, not a misleading step_budget park", async () => {
    const { deps, store, state, setNow, worktree } = build();
    const run = seed(store, worktree, "K-DP1", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    state.deadPanes.add("w1:pfix"); // the target's recorded pane died…
    state.tabPane = null; // …and its configured layout pane is not resolvable (nothing recreates it)
    const res = await applySignal(deps, "bounce", { key: "K-DP1", toStep: "fix", reason: "redo", step: "review", pass: 1 });
    expect(res.ok).toBe(true);
    const rs = store.getRunStep(run.id, "fix")!;
    expect(rs.dispatchedAt).toBeNull(); // the rework pass is opened UNDISPATCHED
    expect(rs.startedAt).toBe(1000); // …with a fresh wait clock (not pass 1's stale one)
    // Ticks: the spawn branch + layout wait own the retry — no step_budget park on a stale clock.
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    // Burn the wait window + its 3 bounded re-arms (each expiry re-bases the clock).
    for (const t of [1701, 2402, 3103, 3804]) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    const fresh = store.getRun(run.id)!;
    expect(fresh.phase).toBe("attention");
    const timeline = store.timeline("demo", "K-DP1");
    expect(timeline.filter((e) => e.type === "layout_wait_retry").length).toBe(3);
    const parks = timeline.filter((e) => e.type === "attention").map((e) => JSON.parse(e.detail ?? "{}").reason);
    expect(parks).toEqual(["layout_wait_timeout"]); // never step_budget
  });

  it("a confirmed-dead pane whose respawn can't land hands the retry to the layout wait", async () => {
    const { deps, store, state, setNow, worktree } = build();
    const run = seed(store, worktree, "K-DP2", "running", "fix");
    state.deadPanes.add("w1:p1"); // the active step's pane dies mid-pass
    state.tabPane = null; // and its layout pane is not resolvable
    await reconcileRun(deps, store.getRun(run.id)!); // first confirmed absence — marks absent_at
    expect(store.getRunStep(run.id, "fix")!.absentAt).toBe(1000);
    setNow(1050); // past the 45s confirmation window → respawn attempt, which returns waiting
    await reconcileRun(deps, store.getRun(run.id)!);
    const rs = store.getRunStep(run.id, "fix")!;
    expect(rs.dispatchedAt).toBeNull(); // pass marked undispatched…
    expect(rs.startedAt).toBe(1050); // …with a re-based wait clock
    expect(store.getRun(run.id)!.phase).toBe("running"); // not parked — the layout wait owns it now
  });

  it("a re-entry into a BUSY pane defers instead of queueing the prompt into a foreign turn", async () => {
    const { deps, store, state, calls, worktree } = build();
    const run = seed(store, worktree, "K-BZ1", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    state.paneState = "working"; // e.g. the fix agent is mid-answer to an on-demand agent-send question
    const res = await applySignal(deps, "bounce", { key: "K-BZ1", toStep: "fix", reason: "redo", step: "review", pass: 1 });
    expect(res.ok).toBe(true); // the bounce landed (rewind + feedback note)…
    expect(store.getRun(run.id)!.step).toBe("fix");
    expect(store.getRunStep(run.id, "fix")!.dispatchedAt).toBeNull(); // …but the dispatch is deferred
    expect(calls.agentSend.filter(([pane]) => pane === "w1:pfix").length).toBe(0);
    // The pane finishes its turn → the next pass dispatches the rework prompt.
    state.paneState = "idle";
    await reconcileRun(deps, store.getRun(run.id)!);
    const sent = calls.agentSend.filter(([pane]) => pane === "w1:pfix");
    expect(sent.length).toBe(1);
    expect(sent[0]![1]).toContain("prompt-fix.md");
    expect(store.getRunStep(run.id, "fix")!.dispatchedAt).not.toBeNull();
  });

  it("a bounce to a dedicated-pane step (no tab/pane) re-prompts its live pane instead of spawning a duplicate", async () => {
    const { deps, store, calls, worktree } = build();
    const src = deps.resolveSource("jira")!;
    const belt: BeltRuntime = {
      name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, watchPr: true,
      steps: [stepCfg("fix", { tab: undefined, pane: undefined }), stepCfg("review"), stepCfg("pr")],
    };
    const run = seed(store, worktree, "K-P6", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    const res = await bounceStep(deps, store.getRun(run.id)!, belt, src, "fix", "redo");
    expect(res.ok).toBe(true);
    expect(calls.agentStart).toBe(0); // no duplicate dedicated pane
    const sent = calls.agentSend.find(([pane]) => pane === "w1:pfix");
    expect(sent?.[1]).toContain("prompt-fix.md");
    expect(store.getRunStep(run.id, "fix")!.paneId).toBe("w1:pfix");
  });
});

describe("exclusive_resource guard (the capture mutex)", () => {
  const LOCK_GUARD = { kind: "exclusive_resource" as const, resourceName: "capture", escalationReason: "capture_lock", autoRescueOnDone: false };

  it("injects the capture-lock command tokens (resource + key from the guard) for a declaring step", async () => {
    const { deps, state, worktree, shipBelt } = build();
    shipBelt.steps[0]!.guards = [LOCK_GUARD];
    shipBelt.steps[0]!.enginePrompt = "acquire=@@CAPTURE_LOCK_ACQUIRE_CMD@@ release=@@CAPTURE_LOCK_RELEASE_CMD@@";
    state.eligible = [ticket("K-CL")];
    await reconcileRepo(deps);
    const body = readFileSync(join(worktree, ".memory/herdr-factory/prompt-fix.md"), "utf8");
    expect(body).toContain("capture-lock acquire capture K-CL");
    expect(body).toContain("capture-lock release capture K-CL");
    expect(body).not.toMatch(/@@CAPTURE_LOCK/); // no dangling tokens
  });

  it("backstop-releases the step's lock when the run bounces away from it", async () => {
    const { deps, store, worktree } = build();
    const src = deps.resolveSource("jira")!;
    const belt: BeltRuntime = {
      name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, watchPr: true,
      steps: [stepCfg("fix"), stepCfg("evidence", { guards: [LOCK_GUARD] }), stepCfg("review"), stepCfg("pr")],
    };
    const run = seed(store, worktree, "K-LOCK", "running", "evidence");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    expect(store.acquireLock("capture", "K-LOCK", 1200)).toBe(true); // the evidence agent holds it
    expect(store.acquireLock("capture", "other", 1200)).toBe(false); // contended while held
    const res = await bounceStep(deps, store.getRun(run.id)!, belt, src, "fix", "redo");
    expect(res.ok).toBe(true);
    expect(store.acquireLock("capture", "other", 1200)).toBe(true); // freed on bounce (backstop)
  });
});

describe("@@PR_TEMPLATE@@ + @@COMMIT_CONVENTIONS@@ (end-to-end render of the shipped prompts)", () => {
  const shippedPr = readFileSync(new URL("../src/prompts/pr.md", import.meta.url), "utf8");
  const shippedWork = readFileSync(new URL("../src/prompts/work.md", import.meta.url), "utf8");

  const renderStep = async (which: "pr" | "fix", o: { template?: string; commits?: string } = {}) => {
    const { deps, store, worktree, shipBelt } = build();
    // Render the ACTUAL shipped prompts (the harness otherwise stubs enginePrompt).
    shipBelt.steps[0]!.enginePrompt = shippedWork;
    shipBelt.steps[2]!.enginePrompt = shippedPr;
    if (o.commits) deps.config.conventions = { commits: o.commits };
    if (o.template) {
      mkdirSync(join(worktree, ".github"), { recursive: true });
      writeFileSync(join(worktree, ".github/PULL_REQUEST_TEMPLATE.md"), o.template);
    }
    const step = which === "pr" ? shipBelt.steps[2]! : shipBelt.steps[0]!;
    const run = seed(store, worktree, "K-PT", "running", step.name);
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, step, null);
    return readFileSync(join(worktree, MEMORY_DIR, `prompt-${step.name}.md`), "utf8");
  };

  it("the on-demand query routes name herdr commands that EXIST (0.7.5 removed `agent send`)", async () => {
    // This scaffold is baked into every step prompt, so a renamed herdr subcommand here hands every
    // agent an instruction that errors out — invisible until one of them tries to use it.
    const { deps, store, worktree, shipBelt } = build();
    const run = seed(store, worktree, "K-QP", "running", "review");
    const prior = store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", sessionId: "sess-9" });
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, shipBelt.steps[1]!, prior);
    const body = readFileSync(join(worktree, MEMORY_DIR, "prompt-review.md"), "utf8");
    expect(body).toContain("herdr agent read w1:pfix --source recent");
    expect(body).toContain('herdr agent prompt w1:pfix "<question>"');
    expect(body).toContain("herdr agent wait w1:pfix --until idle"); // the answer needs its turn to end
    expect(body).not.toMatch(/herdr agent send [^-]/); // `agent send` is gone; `send-keys` is what's left
  });

  it("no template ⇒ the pr prompt keeps today's summary+testing-notes wording and injects nothing", async () => {
    const body = await renderStep("pr");
    expect(body).toContain("a clear\n   summary + testing notes)."); // base wording intact
    expect(body).not.toContain("Fill the repo's own PR template");
    expect(body).not.toMatch(/@@[A-Z_]+@@/); // no dangling tokens whatsoever
  });

  it("a template present ⇒ the pr prompt reproduces it and tells the agent to fill it faithfully", async () => {
    const body = await renderStep("pr", { template: "## Summary\n\n## Testing\n- [ ] covered\n" });
    expect(body).toContain("Fill the repo's own PR template");
    expect(body).toContain("## Testing");
    expect(body).toContain("- [ ] covered");
    expect(body).not.toMatch(/@@[A-Z_]+@@/);
  });

  it("conventions.commits shows up in the work/pr prompts when set, and leaves no trace when unset", async () => {
    const CONV = "Conventional Commits — feat/fix(scope): summary";
    expect(await renderStep("fix")).not.toContain("Commit-message conventions");
    expect(await renderStep("pr")).not.toContain("Commit-message conventions");
    for (const which of ["fix", "pr"] as const) {
      const body = await renderStep(which, { commits: CONV });
      expect(body, which).toContain("Commit-message conventions");
      expect(body, which).toContain(CONV);
    }
  });

  it("a conventions.commits file pointer (relative to the config folder) is read for its contents", async () => {
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps[0]!.enginePrompt = shippedWork;
    const cfgDir = mkdtempSync(join(tmpdir(), "cfg-"));
    tmps.push(cfgDir);
    deps.config.paths.repoDir = cfgDir; // where a `config`-relative pointer resolves
    writeFileSync(join(cfgDir, "commit-guide.md"), "Prefix every commit with the ticket key.");
    deps.config.conventions = { commits: "commit-guide.md" };
    const run = seed(store, worktree, "K-CV", "running", "fix");
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, shipBelt.steps[0]!, null);
    const body = readFileSync(join(worktree, MEMORY_DIR, "prompt-fix.md"), "utf8");
    expect(body).toContain("Prefix every commit with the ticket key.");
    expect(body).not.toContain("commit-guide.md"); // the pointer resolved to contents, not echoed
  });
});

// ISSUE #68 items 1 + 3: the gate-receipt wrapper and the fixed handoff template are only worth
// anything if they reach the agent fully rendered — a dangling @@TOKEN@@ is an instruction the
// agent cannot follow, and a receipt no step records is a receipt no step can read.
describe("gate receipts + the handoff template reach the agent (end-to-end render)", () => {
  const shippedWork = readFileSync(new URL("../src/prompts/work.md", import.meta.url), "utf8");
  const shippedReview = readFileSync(new URL("../src/prompts/review.md", import.meta.url), "utf8");

  const render = async (idx: 0 | 1, body: string, pass = 1) => {
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps[idx]!.enginePrompt = body;
    const step = shipBelt.steps[idx]!;
    const run = seed(store, worktree, "K-GT", "running", step.name);
    if (pass !== 1) store.upsertRunStep(run.id, step.name, { pass });
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, step, null);
    return readFileSync(join(worktree, MEMORY_DIR, `prompt-${step.name}.md`), "utf8");
  };

  it("the work prompt renders a runnable gate wrapper, stamped with this step and pass", async () => {
    const body = await render(0, shippedWork, 3);
    expect(body).toContain("gate K-GT <gate-name> --source jira --step fix --pass 3 -- <command>");
    expect(body).toContain("sh -c");
    expect(body).not.toMatch(/@@[A-Z_]+@@/); // nothing dangling
  });

  it("the review prompt renders the receipts command and tells the agent to re-run only STALE gates", async () => {
    const body = await render(1, shippedReview);
    expect(body).toContain("gates K-GT --source jira");
    expect(body).toContain("CURRENT");
    expect(body).toContain("STALE");
    expect(body).toContain("DIRTY");
    expect(body).toContain("no receipt for a check the repo requires");
    expect(body).toContain("recorded command");
    expect(body).toMatch(/re-run it once through the\s+wrapper/);
    expect(body).not.toContain("A **failing** CURRENT receipt is a bounce, not a re-run");
    expect(body).not.toMatch(/@@[A-Z_]+@@/);
  });

  it("every step's scaffold carries the FIXED handoff template, not a free-form 'write a note'", async () => {
    const body = await render(0, shippedWork);
    for (const heading of ["sha: <commit>", "## Did", "## Decisions", "## Uncertain", "## Found", "## Next step should verify"]) {
      expect(body, heading).toContain(heading);
    }
    expect(body).toContain("Keep it under 40 lines total (`## Found` included)");
    expect(body).toContain("exempt from the cap");
    expect(body).not.toContain("EXACTLY this template");
    expect(body).toContain("The same brevity applies to a PR body");
    expect(body).not.toMatch(/brevity applies to a bounce note/);
    // And it tells the agent step-done reports the landing, so it has no reason to poll `status`.
    expect(body).toContain("advanced fix → <next step>");
  });
});

// ISSUE #106: practices for long unattended runs.
describe("long-run practices reach the agent (end-to-end render)", () => {
  const shipped = (p: string) => readFileSync(new URL(`../src/prompts/${p}`, import.meta.url), "utf8");
  const render = async (idx: 0 | 1, body: string) => {
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps[idx]!.enginePrompt = body;
    const step = shipBelt.steps[idx]!;
    const run = seed(store, worktree, "K-LR", "running", step.name);
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, step, null);
    return readFileSync(join(worktree, MEMORY_DIR, `prompt-${step.name}.md`), "utf8");
  };

  it.each(["work.md", "github_issues/work.md", "jira/work.md", "sentry/work.md"])(
    "%s renders the TASKS.md checklist step and the subagent paragraph",
    async (p) => {
      const body = await render(0, shipped(p));
      expect(body).toContain(`${MEMORY_DIR}/TASKS.md`);
      expect(body).toContain("never commit it");
      expect(body).toContain("give each part its own subagent");
      expect(body).toContain("Check each\nsubagent's evidence");
      expect(body).not.toMatch(/@@[A-Z_]+@@/);
    },
  );

  it("every step's scaffold says keep going, stop only via ask-human, and never destroy", async () => {
    const body = await render(1, shipped("review.md"));
    expect(body).toContain("## Keep going; never destroy");
    expect(body).toContain("Stop only through `ask-human`");
    expect(body).toContain("no force-push");
    expect(body).toContain("published releases or tags");
  });

  it("the review prompt asks every bouncing finding to show how it fails", async () => {
    expect(await render(1, shipped("review.md"))).toContain("**how to show it fails**");
  });

  it("no shipped prompt carries a thinking directive", () => {
    const dir = new URL("../src/prompts/", import.meta.url);
    for (const p of readdirSync(dir, { recursive: true }) as string[]) {
      if (!p.endsWith(".md")) continue;
      expect(readFileSync(new URL(p, dir), "utf8"), p).not.toMatch(/think (carefully|hard|step)|step[- ]by[- ]step/i);
    }
  });
});

describe("belt-level pr: behavior block (end-to-end render of the shipped pr prompt)", () => {
  const shippedPr = readFileSync(new URL("../src/prompts/pr.md", import.meta.url), "utf8");
  // pr.md written as it was BEFORE the pr: block existed (literal step 2, no @@PR_OPTIONS@@) — the
  // byte-identity ground truth; its prose tracks pr.md, only the pr: tokenization is held back.
  const legacyPr = readFileSync(new URL("./fixtures/pr-prompt.legacy.md", import.meta.url), "utf8");

  const renderPr = async (pr: BeltRuntime["pr"]) => {
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps[2]!.enginePrompt = shippedPr;
    shipBelt.pr = pr;
    const run = seed(store, worktree, "K-PR", "running", "pr");
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, shipBelt.steps[2]!, null);
    return readFileSync(join(worktree, MEMORY_DIR, "prompt-pr.md"), "utf8");
  };

  it("absent pr: block ⇒ the rendered pr prompt is byte-identical to the pre-block prompt", async () => {
    // Render the current (tokenized) and the legacy (literal step 2) pr base in the SAME worktree, so
    // only the prompt body differs — byte-equal ⇒ an absent pr: block changed nothing.
    const { deps, store, worktree, shipBelt } = build();
    const run = seed(store, worktree, "K-PR", "running", "pr");
    shipBelt.steps[2]!.enginePrompt = shippedPr;
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, shipBelt.steps[2]!, null);
    const current = readFileSync(join(worktree, MEMORY_DIR, "prompt-pr.md"), "utf8");
    shipBelt.steps[2]!.enginePrompt = legacyPr;
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, shipBelt.steps[2]!, null);
    const legacy = readFileSync(join(worktree, MEMORY_DIR, "prompt-pr.md"), "utf8");
    expect(current).toBe(legacy);
    expect(current).not.toMatch(/@@[A-Z_]+@@/); // and no dangling tokens
  });

  it("draft + title (templated) + labels + reviewers + assignees render as gh instructions", async () => {
    const body = await renderPr({ draft: true, title: "[{{semantic_work_prefix}}] {{work_id}}", labels: ["needs-review"], reviewers: ["octocat"], assignees: ["me"] });
    expect(body).toContain("--draft");
    expect(body).toContain("[fix] K-PR"); // {{semantic_work_prefix}} of a Bug = fix; {{work_id}} = key
    expect(body).toContain("`needs-review`");
    expect(body).toContain("--reviewer");
    expect(body).toContain("--assignee");
    expect(body).not.toMatch(/@@[A-Z_]+@@/); // fully substituted
  });

  it("automated_round_minutes: 30 sizes the window; 0 removes the CI-wait step entirely", async () => {
    expect(await renderPr({ automatedRoundMinutes: 30 })).toContain("(~30 min)");
    const skip = await renderPr({ automatedRoundMinutes: 0 });
    expect(skip).not.toContain("Wait for the automated round");
    expect(skip).toContain("No automated round");
    expect(skip).not.toMatch(/@@[A-Z_]+@@/);
  });
});

describe("custom gate scaffold (read-only + bounce declarations render per StepConfig)", () => {
  const renderGate = async (gate: StepConfig, key: string) => {
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps = [stepCfg("fix"), gate, stepCfg("pr")];
    const run = seed(store, worktree, key, "running", gate.name);
    await renderStepPrompt(deps, run, shipBelt, deps.resolveSource("jira")!, gate, null);
    return readFileSync(join(worktree, MEMORY_DIR, `prompt-${gate.name}.md`), "utf8");
  };
  // A custom gate has no engine base prompt, so the engine injects its read-only notice + bounce
  // section from the resolved StepConfig — the same fields config.ts derives from the ref opt-ins.
  const gateCfg = (opts: Partial<StepConfig>) =>
    stepCfg("gate", { type: "custom", enginePrompt: undefined, tab: undefined, pane: undefined, heartbeat: false, opensPr: false, ...opts });

  it("read_only + bounce ⇒ a read-only notice AND a rendered bounce command, with no dangling tokens", async () => {
    const body = await renderGate(gateCfg({ readOnly: true, canBounceTo: ["fix"] }), "K-GATE");
    expect(body).toMatch(/read-only step/i); // the injected read-only posture notice
    expect(body).toContain("Sending the work back for rework"); // the bounce scaffold section
    expect(body).toContain("bounce"); // the rendered bounce command targeting the earlier step
    expect(body).not.toMatch(/@@[A-Z_]+@@/); // every token substituted, nothing left dangling
  });

  it("read_only WITHOUT bounce ⇒ the read-only notice, no bounce section", async () => {
    const body = await renderGate(gateCfg({ readOnly: true, canBounceTo: [] }), "K-GATE2");
    expect(body).toMatch(/read-only step/i);
    expect(body).not.toContain("Sending the work back for rework");
    expect(body).toMatch(/record what's wrong in your handoff note/); // the no-bounce phrasing
  });

  it("a plain custom step (no read_only, no bounce) gets neither the read-only notice nor a bounce section", async () => {
    const body = await renderGate(gateCfg({ readOnly: false, canBounceTo: [] }), "K-GATE3");
    expect(body).not.toMatch(/read-only step/i);
    expect(body).not.toContain("Sending the work back for rework");
  });
});

describe("reconcile — Phase B source poll interval", () => {
  it("polls a source every tick when its interval equals the tick interval (the default)", async () => {
    const { deps, setNow } = build();
    const src = deps.resolveSource("jira")!;
    expect(src.pollIntervalSeconds).toBe(60); // harness default == tick ⇒ gate never engages
    let polls = 0;
    const orig = src.client.listEligible.bind(src.client);
    src.client.listEligible = async (l) => { polls += 1; return orig(l); };

    await reconcileRepo(deps); // t=1000
    setNow(1060); await reconcileRepo(deps);
    setNow(1120); await reconcileRepo(deps);
    expect(polls).toBe(3); // one poll per tick — unchanged behavior
  });

  it("skips a source's poll — and thus its claims — until a longer interval elapses (drain-per-window)", async () => {
    const { deps, store, state, setNow } = build();
    const src = deps.resolveSource("jira")!;
    src.pollIntervalSeconds = 300; // 5 min, well above the 60s tick
    let polls = 0;
    const orig = src.client.listEligible.bind(src.client);
    src.client.listEligible = async (l) => { polls += 1; return orig(l); };

    // t=1000: the first tick polls and claims P-1.
    state.eligible = [ticket("P-1")];
    await reconcileRepo(deps);
    expect(polls).toBe(1);
    expect(store.activeRunForTicket("demo", "jira", "P-1")).toBeTruthy();

    // A second item shows up, but we're inside the poll window: ticks neither poll nor claim it.
    state.eligible = [ticket("P-1"), ticket("P-2")];
    setNow(1060); await reconcileRepo(deps); // +60s
    setNow(1290); await reconcileRepo(deps); // +290s — still under 300 − tolerance
    expect(polls).toBe(1);
    expect(store.activeRunForTicket("demo", "jira", "P-2")).toBeFalsy();

    // Once the interval elapses, the source is polled again and the backlog item is claimed.
    setNow(1300); await reconcileRepo(deps);
    expect(polls).toBe(2);
    expect(store.activeRunForTicket("demo", "jira", "P-2")).toBeTruthy();
  });
});

describe("reconcile pipeline (work_to_pull_request belt)", () => {
  it("claims an eligible ticket → running fix (worktree + fix agent + ticket fetch + In-dev transition)", async () => {
    const { deps, store, state, calls, worktree } = build();
    state.eligible = [ticket("K-1")];
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "K-1")!;
    expect(run.phase).toBe("running");
    expect(run.step).toBe("fix");
    expect(run.belt).toBe("ship");
    expect(run.branch).toBe("fix/K-1-fix-the-thing-u1"); // workspace_name render + per-run uid suffix
    expect(run.workspaceId).toBe("w1");
    expect(run.paneId).toBe("w1:p1"); // latest active pane = the fix agent
    expect(store.getRunStep(run.id, "fix")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1); // fix prompt dispatched
    expect(calls.transitions).toContainEqual(["K-1", "in_development"]);
    // materializeWork wrote the work doc the fix agent reads
    expect(existsSync(join(worktree, ".memory/herdr-factory/ticket.json"))).toBe(true);
  });

  it("renders @@WORK_DOC@@/@@WORK_DOC_KIND@@ from the source's workDoc() — no engine type-switch", async () => {
    const { deps, state, worktree, shipBelt } = build();
    shipBelt.steps[0]!.enginePrompt = "Study @@WORK_DOC@@ (@@WORK_DOC_KIND@@).";
    state.eligible = [ticket("K-WD")];
    await reconcileRepo(deps);
    const prompt = readFileSync(join(worktree, ".memory/herdr-factory/prompt-fix.md"), "utf8");
    // The regression this pins: an unawaited/sync workDoc through the telemetry proxy would
    // render ".memory/herdr-factory/undefined (undefined)".
    expect(prompt).toContain("Study .memory/herdr-factory/ticket.json (Jira ticket (JSON)).");
  });

  it("prompt_mode: replace drops the shipped base — the user prompt_file owns the body (scaffold + tokens still wrap it)", async () => {
    const { deps, state, worktree, shipBelt } = build();
    shipBelt.steps[0]!.enginePrompt = "SHIPPED BASE PROSE";
    // The file lives in the run's worktree (repo-sourced), read at render time.
    writeFileSync(join(worktree, "own-work.md"), "MY OWN WORK BODY for @@KEY@@\n");
    shipBelt.steps[0]!.promptFile = "own-work.md";
    shipBelt.steps[0]!.promptFileSource = "repo";
    shipBelt.steps[0]!.promptMode = "replace";
    state.eligible = [ticket("K-REPL")];
    await reconcileRepo(deps);
    const prompt = readFileSync(join(worktree, ".memory/herdr-factory/prompt-fix.md"), "utf8");
    expect(prompt).toContain("MY OWN WORK BODY for K-REPL"); // the file body, tokens substituted
    expect(prompt).not.toContain("SHIPPED BASE PROSE"); // the shipped base is dropped
    expect(prompt).not.toContain("Additional repo-specific instructions"); // not the augment framing
    expect(prompt).toContain("Finishing this step (required)"); // the handover scaffold still wraps it
    // Every handoff names the commit it covers, so the next step can tell whether the note
    // describes the tree it is actually looking at (issue #66).
    expect(prompt).toContain("sha: <commit>");
  });

  it("a repo-checkout prompt pack (.herdr/prompts/<slug>.md) overrides the base at render time", async () => {
    const { deps, state, worktree, shipBelt } = build();
    // load-resolved base (config pack ?? shipped) that would apply with no repo pack…
    shipBelt.steps[0]!.enginePrompt = "SHIPPED fix base @@WORK_DOC@@";
    shipBelt.steps[0]!.basePromptSlug = "work";
    shipBelt.steps[0]!.basePromptPerSourceOverride = true;
    // …but a repo-checkout pack in the worktree wins (highest-precedence layer, reachable only here).
    mkdirSync(join(worktree, ".herdr/prompts"), { recursive: true });
    writeFileSync(join(worktree, ".herdr/prompts/work.md"), "REPO PACK fix base @@WORK_DOC@@");
    state.eligible = [ticket("K-PACK")];
    await reconcileRepo(deps);
    const prompt = readFileSync(join(worktree, ".memory/herdr-factory/prompt-fix.md"), "utf8");
    expect(prompt).toContain("REPO PACK fix base .memory/herdr-factory/ticket.json"); // pack body + token substitution
    expect(prompt).not.toContain("SHIPPED fix base");
  });

  it("a re-claimed ticket gets a fresh unique branch (so a prior merged PR isn't matched)", async () => {
    const { deps, store, state } = build();
    state.eligible = [ticket("K-RC")];
    await reconcileRepo(deps);
    const run1 = store.activeRunForTicket("demo", "jira", "K-RC")!;
    store.endRun(run1.id, "merged"); // prior attempt's PR merged + run ended
    state.eligible = [ticket("K-RC")]; // the ticket re-appears (re-labelled / moved back to To Do)
    await reconcileRepo(deps);
    const run2 = store.activeRunForTicket("demo", "jira", "K-RC")!;
    expect(run2.id).not.toBe(run1.id);
    // Same human-readable base, distinct per-run suffix — so prForBranch(run2.branch) can't match the
    // old merged PR that lives on run1.branch (the bug this fixes).
    expect(run1.branch).toBe("fix/K-RC-fix-the-thing-u1");
    expect(run2.branch).toBe("fix/K-RC-fix-the-thing-u2");
    expect(run2.branch).not.toBe(run1.branch);
  });

  it("claiming + configured pane not idle yet → waits (stays claiming, never spawns its own)", async () => {
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("W-1")];
    state.paneState = "working"; // the layout pane exists but its agent isn't idle yet
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-1")!;
    expect(run.phase).toBe("claiming"); // did NOT advance to running
    expect(calls.agentSend.length).toBe(0); // nothing dispatched yet
    expect(calls.agentStart).toBe(0); // and crucially did NOT spawn its own
    expect(store.getRunStep(run.id, "fix")?.paneId).toBeNull();
    expect(calls.transitions).not.toContainEqual(["W-1", "in_development"]);
  });

  it("dispatches into a layout pane whose agent herdr reports `unknown` (#80)", async () => {
    // A cursor-agent that has never been prompted never fires the lifecycle hook herdr derives
    // `agent_status` from, so it sits idle at its prompt reporting `unknown` indefinitely. Gating
    // the dispatch on idle/done alone burned every layout-wait window and parked
    // `layout_wait_timeout` against a pane that was ready the whole time.
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("W-80")];
    state.paneState = "unknown";
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-80")!;
    expect(calls.agentSend.length).toBe(1); // the prompt went in…
    expect(calls.agentStart).toBe(0); // …into the LAYOUT pane, not one we spawned
    const rs = store.getRunStep(run.id, "fix")!;
    expect(rs.paneId).toBe("w1:p1");
    expect(rs.dispatchedAt).toBe(1000);
    expect(run.phase).toBe("running"); // never waits, so it can never reach the park
  });

  it("a pane with NO agent (`gone`) still waits — `unknown` is the only state the gate opened to", async () => {
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("W-81")];
    state.paneState = "gone";
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-81")!;
    expect(calls.agentSend.length).toBe(0);
    expect(run.phase).toBe("claiming");
  });

  it("a step parked in its layout wait never retags the PREVIOUS step's pane as itself (#80)", async () => {
    // run.paneId is whichever step dispatched LAST. A step still waiting for its own pane has
    // dispatched nowhere, so publishing its name there put `hf_step: review` on the *evidence*
    // pane — while the pane the step was actually waiting for carried no tokens at all.
    const { deps, store, state, calls, setNow, worktree } = build();
    const run = seed(store, worktree, "K-80T", "running", "review", { paneId: "w1:pfix" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.upsertRunStep(run.id, "review", { paneId: null, dispatchedAt: null, startedAt: 1000 });
    state.tabPanes = { fix: "w1:pfix", review: null }; // review's layout pane never comes up
    for (const t of [1000, 1701, 2402, 3103, 3804]) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(store.getRun(run.id)!.phase).toBe("attention");
    const parked = store.timeline("demo", "K-80T").filter((e) => e.type === "attention");
    expect(parked.map((e) => JSON.parse(e.detail ?? "{}").reason)).toEqual(["layout_wait_timeout"]);
    // Every write to the fix pane names FIX — the step that owns it — never the parked review step.
    const onFixPane = calls.paneDisplay.filter(([pane]) => pane === "w1:pfix");
    expect(onFixPane.length).toBeGreaterThan(0);
    expect(onFixPane.map(([, name]) => name)).toEqual(onFixPane.map(() => "fix:K-80T"));
    expect(onFixPane.map(([, , , tokens]) => tokens.hf_step)).toEqual(onFixPane.map(() => "fix"));
  });

  it("resume of a layout_wait park dispatches the step on the next tick (#80)", async () => {
    const { deps, store, state, calls, setNow, worktree } = build();
    const run = seed(store, worktree, "K-80R", "running", "review", { paneId: "w1:pfix" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.upsertRunStep(run.id, "review", { paneId: null, dispatchedAt: null, startedAt: 1000 });
    state.tabPanes = { fix: "w1:pfix", review: null };
    for (const t of [1000, 1701, 2402, 3103, 3804]) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(store.getRun(run.id)!.phase).toBe("attention");
    // The operator resumes; the review pane is now up with an untouched cursor agent.
    state.tabPanes.review = "w1:prev";
    state.paneState = "unknown";
    calls.agentSend.length = 0;
    expect((await resumeRun(deps, store.getRun(run.id)!)).ok).toBe(true);
    setNow(3900);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend.filter(([pane]) => pane === "w1:prev").length).toBe(1);
    const rs = store.getRunStep(run.id, "review")!;
    expect(rs.paneId).toBe("w1:prev");
    expect(rs.dispatchedAt).toBe(3900);
    expect(store.getRun(run.id)!.phase).toBe("running");
  });

  it("a prompt herdr reports as STALLED is not a dispatch — the pass stays undispatched and retries", async () => {
    // The failure this guards: a submission whose keystrokes were dropped used to look like a
    // successful dispatch, so the step's budget clock started against an agent that never got the
    // work and the run parked at budget instead of simply being re-prompted. herdr 0.7.5's
    // `agent prompt --wait` reports the stall, so the dispatch is treated as not having happened.
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("ST-1")];
    state.promptStalls = true;
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "ST-1")!;
    expect(calls.agentSend.length).toBe(1); // it WAS attempted…
    expect(run.phase).toBe("claiming"); // …but the run never advanced
    const rs = store.getRunStep(run.id, "fix")!;
    expect(rs.dispatchedAt).toBeNull(); // the pass still needs its dispatch (bounded layout wait owns the retry)
    expect(rs.paneId).toBeNull();
    expect(calls.agentStart).toBe(0); // and it did not fall back to spawning its own pane

    // The identical dispatch lands once the agent is actually reachable.
    state.promptStalls = false;
    await reconcileRepo(deps);
    const rs2 = store.getRunStep(run.id, "fix")!;
    expect(rs2.dispatchedAt).not.toBeNull();
    expect(rs2.paneId).toBe("w1:p1");
    expect(calls.paneDisplay).toContainEqual(["w1:p1", "fix:ST-1", null, expect.anything()]);
  });

  it("a confirmed dispatch is submitted ONCE, however idle herdr keeps reporting the pane", async () => {
    // Issue #22: a cursor-agent pane takes the prompt and works while herdr still reports `idle`.
    // Its dispatch is confirmed by the pane-revision probe in the client, so the pass is dispatched
    // and every later tick must leave it alone — the re-send loop that buried the agent in dozens of
    // identical queued follow-ups was the pass never being marked dispatched, not the idle status.
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("ID-1")];
    state.paneState = "idle"; // ...and it STAYS idle: herdr never flips this harness
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "ID-1")!;
    expect(store.getRunStep(run.id, "fix")?.dispatchedAt).not.toBeNull();
    expect(calls.agentSend.length).toBe(1);

    await reconcileRepo(deps);
    await reconcileRepo(deps);
    expect(calls.agentSend.length).toBe(1); // no re-submission on any later tick
  });

  // ── the proactive idle nudge (issue #54) ──────────────────────────────────────────────────────
  // An agent that finished and forgot `step-done` used to be invisible for the whole stall/budget
  // window. Now a pane that sits continuously at its prompt past `idle_nudge_seconds` gets exactly
  // one re-prompt, well before any watch trips.
  const nudges = (calls: { agentSend: [string, string][] }) => calls.agentSend.filter(([, text]) => /idle for ~/.test(text));

  it("idle nudge: an idle pane is re-prompted ONCE per idle episode, not once per tick", async () => {
    const { deps, store, state, calls, worktree, setNow } = build();
    state.paneState = "idle";
    const run = seed(store, worktree, "IN-1", "running", "fix");
    calls.agentSend.length = 0;

    await reconcileRun(deps, store.getRun(run.id)!); // first sight of an idle pane: starts the clock
    expect(nudges(calls).length).toBe(0);
    expect(store.getWatchState(run.id, "fix", "idle_nudge")!.basedAt).toBe(1000);

    setNow(1000 + 299);
    await reconcileRun(deps, store.getRun(run.id)!); // still inside the 300s window
    expect(nudges(calls).length).toBe(0);

    setNow(1000 + 301);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(nudges(calls).length).toBe(1);
    expect(nudges(calls)[0]![0]).toBe("w1:p1");
    expect(nudges(calls)[0]![1]).toContain(".memory/herdr-factory/prompt-fix.md"); // the pass's own brief
    expect(nudges(calls)[0]![1]).toMatch(/step-done/);
    expect(store.timeline("demo", "IN-1").filter((e) => e.type === "idle_nudge").length).toBe(1);

    expect(nudges(calls)[0]![1]).not.toContain("--pass"); // the first nudge points at the prompt

    setNow(1000 + 599);
    await reconcileRun(deps, store.getRun(run.id)!); // the second nudge waits for 2× the window
    expect(nudges(calls).length).toBe(1);
    setNow(1000 + 601);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(nudges(calls).length).toBe(2);
    // …and carries the step's exact step-done command, pass stamp and all.
    expect(nudges(calls)[1]![1]).toMatch(/herdr-factory --repo demo step-done IN-1 fix --source jira --pass 1/);

    for (const t of [2000, 2500]) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(nudges(calls).length, "many more idle ticks are still exactly two nudges").toBe(2);
    expect(store.getRun(run.id)!.phase).toBe("running"); // the nudge never parks anything
  });

  it("idle nudge: an `unknown` pane is nudged only once its output has held still for the whole window", async () => {
    // cursor-agent reports `unknown` forever (no herdr lifecycle hooks), so its only sign of life is
    // the pane's screen revision.
    const { deps, store, state, calls, worktree, setNow } = build();
    state.paneState = "unknown";
    state.revision = 10;
    const quiet = seed(store, worktree, "IN-U1", "running", "fix");
    calls.agentSend.length = 0;
    await reconcileRun(deps, store.getRun(quiet.id)!); // first look: a baseline revision, no clock yet
    setNow(1060);
    await reconcileRun(deps, store.getRun(quiet.id)!); // unchanged — the quiet clock starts
    setNow(1060 + 301);
    await reconcileRun(deps, store.getRun(quiet.id)!);
    expect(nudges(calls).length).toBe(1);
    expect(calls.confirmedSends).toEqual(["w1:p1"]); // the confirmed path, not fire-and-forget
    expect(calls.sendKeys).toEqual([["w1:p1", "enter"]]); // …plus the Enter a stranded Cursor prompt needs

    // A pane whose output keeps moving is working — never interrupted, however long it runs.
    const busy = seed(store, worktree, "IN-U2", "running", "fix");
    calls.agentSend.length = 0;
    for (let t = 2000; t <= 4000; t += 60) {
      setNow(t);
      state.revision = t; // the screen changes between every two ticks
      await reconcileRun(deps, store.getRun(busy.id)!);
    }
    expect(nudges(calls).length).toBe(0);
  });

  it("idle nudge: an `unknown` pane is left alone when herdr reports no revision", async () => {
    const { deps, store, state, calls, worktree, setNow } = build();
    state.paneState = "unknown";
    state.revision = null;
    const run = seed(store, worktree, "IN-U3", "running", "fix");
    calls.agentSend.length = 0;
    for (const t of [1000, 1400, 1800, 2200]) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(nudges(calls).length).toBe(0);
  });

  it("idle nudge: a run that never signals gets exactly two nudges before its budget park", async () => {
    const { deps, store, state, calls, worktree, setNow, config } = build();
    config.limits.stallSeconds = 100_000; // isolate the budget watch
    state.paneState = "idle";
    const run = seed(store, worktree, "IN-B1", "running", "fix");
    calls.agentSend.length = 0;
    for (let t = 1000; store.getRun(run.id)!.phase === "running" && t < 10_000; t += 60) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(store.getRun(run.id)!.attentionReasonCode).toBe("step_budget");
    expect(nudges(calls).length).toBe(2);
  });

  it("idle nudge: a step that ran past budget WHILE working is nudged twice before it parks, not parked on its first idle tick", async () => {
    // Runs 159/65: the budget tripped while the agent worked (the veto extended it), and the first
    // tick that found it `done` parked it on the spot — the idle nudge never got a look.
    const { deps, store, state, calls, worktree, setNow, config } = build();
    config.limits.stallSeconds = 100_000;
    state.paneState = "working";
    const run = seed(store, worktree, "IN-B2", "running", "fix");
    calls.agentSend.length = 0;
    setNow(1000 + 5500); // the fix step's budget is 5400s
    await reconcileRun(deps, store.getRun(run.id)!); // past budget, still working: extended
    expect(store.getRun(run.id)!.phase).toBe("running");

    state.paneState = "done"; // the turn ends, step-done never ran
    const start = 1000 + 6300;
    for (let t = start; store.getRun(run.id)!.phase === "running" && t < start + 5000; t += 60) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(nudges(calls).length).toBe(2);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(store.getRun(run.id)!.attentionReasonCode).toBe("step_budget");
    expect(deps.now() - start, "the hold is bounded at 3× the window").toBeLessThanOrEqual(3 * 300 + 60);
  });

  it("idle nudge: a working pane is never nudged, however long the step runs", async () => {
    const { deps, store, state, calls, worktree, setNow } = build();
    state.paneState = "working";
    const run = seed(store, worktree, "IN-2", "running", "fix");
    calls.agentSend.length = 0;
    for (const t of [1000, 2000, 3000, 4000]) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(nudges(calls).length).toBe(0);
    expect(store.getWatchState(run.id, "fix", "idle_nudge")?.basedAt ?? null).toBe(null);
  });

  it("idle nudge: idle → nudge → working → idle is TWO nudges", async () => {
    const { deps, store, state, calls, worktree, setNow } = build();
    state.paneState = "idle";
    const run = seed(store, worktree, "IN-3", "running", "fix");
    calls.agentSend.length = 0;
    await reconcileRun(deps, store.getRun(run.id)!);
    setNow(1400);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(nudges(calls).length).toBe(1);

    state.paneState = "working"; // the nudge landed and the agent took a turn — the episode ends
    setNow(1500);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getWatchState(run.id, "fix", "idle_nudge")!.sig).toBe(null);

    state.paneState = "idle"; // ...and it idles again
    setNow(1600);
    await reconcileRun(deps, store.getRun(run.id)!);
    setNow(2000);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(nudges(calls).length).toBe(2);
  });

  it("idle nudge: a HEAD move re-opens the episode even when `working` was never observed", async () => {
    // The ~5s agent-list memo and a 60s tick between them can hide a whole turn. A commit is the
    // other proof that real work happened, so it ends the episode too.
    const { deps, store, state, calls, worktree, setNow } = build();
    state.paneState = "idle";
    state.headSha = "sha-a";
    const run = seed(store, worktree, "IN-4", "running", "fix");
    calls.agentSend.length = 0;
    await reconcileRun(deps, store.getRun(run.id)!);
    setNow(1400);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(nudges(calls).length).toBe(1);
    expect(store.getWatchState(run.id, "fix", "idle_nudge")!.sig).toBe("sha-a");

    state.headSha = "sha-b"; // the nudged agent committed between two ticks
    setNow(1500);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getWatchState(run.id, "fix", "idle_nudge")!.sig).toBe(null); // episode closed
    setNow(1600);
    await reconcileRun(deps, store.getRun(run.id)!); // …a new idle episode begins
    setNow(2000);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(nudges(calls).length).toBe(2);
  });

  it("idle nudge: limits.idle_nudge_seconds 0 disables it entirely", async () => {
    const { deps, store, state, calls, worktree, setNow, config } = build();
    config.limits.idleNudgeSeconds = 0;
    state.paneState = "idle";
    const run = seed(store, worktree, "IN-5", "running", "fix");
    calls.agentSend.length = 0;
    for (const t of [1000, 2000, 4000]) {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(nudges(calls).length).toBe(0);
    expect(store.getWatchState(run.id, "fix", "idle_nudge")).toBeUndefined();
  });

  it("read_only enforcement: a FROZEN read-only step that moves HEAD (commits) parks for attention", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    shipBelt.steps[1] = stepCfg("review", { readOnly: true }); // read-only review, guard attached like production
    state.headSha = "sha-baseline";
    const run = seed(store, worktree, "RO-1", "running", "review");
    // baselineFrozenAt set ⇒ the baseline is FROZEN: the step's own agent has been observed working,
    // so a later HEAD move is attributable to THIS step, not the prior step's trailing commits.
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-baseline", basedAt: 100 });
    state.headSha = "sha-moved"; // the read-only agent illicitly committed
    await reconcileRun(deps, store.getRun(run.id)!);
    const after = store.getRun(run.id)!;
    expect(after.phase).toBe("attention");
    expect(after.attentionReason).toMatch(/read-only/i);
    expect(after.step).toBe("review"); // did NOT advance to pr
  });

  it("read_only step whose HEAD is unchanged advances normally", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    shipBelt.steps[1] = stepCfg("review", { readOnly: true }); // read-only review, guard attached like production
    state.headSha = "sha-baseline";
    const run = seed(store, worktree, "RO-2", "running", "review");
    store.upsertRunStep(run.id, "review", { done: true }); // finished, no commit
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-baseline" });
    await reconcileRun(deps, store.getRun(run.id)!);
    const after = store.getRun(run.id)!;
    expect(after.phase).toBe("running");
    expect(after.step).toBe("pr"); // advanced past the read-only step
  });

  // RWR-18204: the PRIOR step's agent stays alive in its pane and can commit AFTER its own step-done
  // (a trailing lint/test fix). Until the read-only step's OWN agent is observed working, such a move
  // is absorbed into the baseline — never blamed on (nor wedging) the read-only step.
  it("read_only: a trailing commit while the step's agent is still starting up is ABSORBED, not parked", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    shipBelt.steps[1] = stepCfg("review", { readOnly: true }); // read-only review, guard attached like production
    state.headSha = "sha-baseline";
    const run = seed(store, worktree, "RO-3", "running", "review");
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-baseline" }); // NOT frozen (basedAt null)
    state.paneState = "idle"; // the read-only agent hasn't taken over yet (still spinning up)
    state.headSha = "sha-trailing"; // the PRIOR step's still-alive agent committed after handoff
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running"); // NOT parked
    const ws = store.getWatchState(run.id, "review", "read_only")!;
    expect(ws.sig).toBe("sha-trailing"); // baseline advanced to absorb it (watch_state since v34)
    expect(ws.basedAt).toBe(null); // still not frozen
  });

  it("read_only: the baseline FREEZES once the step's own agent is working (progressAt stamped)", async () => {
    const { deps, store, state, worktree, shipBelt, setNow } = build();
    shipBelt.steps[1] = stepCfg("review", { readOnly: true }); // read-only review, guard attached like production
    setNow(5000);
    state.headSha = "sha-baseline";
    const run = seed(store, worktree, "RO-4", "running", "review");
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-baseline" });
    state.paneState = "working"; // the read-only agent has taken over
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getWatchState(run.id, "review", "read_only")!.basedAt).toBe(5000); // frozen at now
    expect(store.getRun(run.id)!.phase).toBe("running"); // no park (no move since spawn)
  });

  it("read_only park HEALS: a step-done from the parked read-only step un-parks and advances (RWR-18204)", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    shipBelt.steps[1] = stepCfg("review", { readOnly: true }); // read-only review, guard attached like production
    state.headSha = "sha-moved";
    const run = seed(store, worktree, "RO-5", "attention", "review", { attentionReason: "review is read-only but committed (HEAD moved)" });
    // frozen baseline + HEAD moved is what parked it; the step then genuinely finished (done).
    store.upsertRunStep(run.id, "review", { paneId: "w1:p1", done: true });
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-baseline", basedAt: 100 });
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "RO-5", type: "attention", detail: { reason: "read_only_violation", step: "review" } });
    await reconcileRun(deps, store.getRun(run.id)!);
    const after = store.getRun(run.id)!;
    expect(after.phase).toBe("running"); // un-parked
    expect(after.step).toBe("pr"); // advanced past the read-only step
    const resumed = store.timeline("demo", "RO-5").filter((e) => e.type === "resumed").map((e) => JSON.parse(e.detail ?? "{}").reason);
    expect(resumed).toContain("step_done_after_watchdog_park");
  });

  it("claiming + configured pane never comes up: bounded window re-arms, THEN attention; resume refunds the budget", async () => {
    const { deps, store, state, calls, setNow } = build();
    state.eligible = [ticket("W-2")];
    state.paneState = "working"; // the layout pane exists but its agent never goes idle
    await reconcileRepo(deps); // first pass begins the wait (fix.started_at = 1000)
    const run = store.activeRunForTicket("demo", "jira", "W-2")!;
    expect(run.phase).toBe("claiming");

    // Each expired window consumes ONE respawn credit and re-arms in place — no park, no notify.
    let t = 1000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      t += 601; // past layout_wait_seconds (600), measured from the re-armed clock
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
      expect(store.getRun(run.id)!.phase).toBe("claiming"); // still waiting — not parked
      expect(store.guardCounter(run.id, "fix", "layout_wait")).toBe(attempt);
      expect(store.getRunStep(run.id, "fix")!.startedAt).toBe(t); // window re-armed
      expect(calls.notify).toBe(0); // the engine self-heals quietly
    }
    expect(store.timeline("demo", "W-2").filter((e) => e.type === "layout_wait_retry").length).toBe(3);

    // Budget exhausted → the next expiry is a genuine human park (a real outage still surfaces).
    t += 601;
    setNow(t);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
    expect(calls.agentStart).toBe(0); // never spawned its own

    // Exhausted park stays parked on later ticks — the rescue must not ping-pong forever.
    setNow(t + 60);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");

    // A human resume grants a fresh window + respawn budget: the next expiry re-arms again
    // instead of instantly re-parking off the ancient clock and spent budget.
    expect((await resumeRun(deps, store.getRun(run.id)!)).ok).toBe(true);
    expect(store.getRun(run.id)!.phase).toBe("claiming");
    expect(store.guardCounter(run.id, "fix", "layout_wait")).toBe(0);
    setNow(t + 60 + 601);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("claiming"); // re-armed, not re-parked
    expect(store.guardCounter(run.id, "fix", "layout_wait")).toBe(1);
  });

  it("an expired wait RE-STARTS the layout pane's agent when the pane sits at a shell prompt (#44)", async () => {
    // The layout hook starts a pane's agent ONCE. A claude stopped at Claude Code's folder-trust
    // prompt never becomes ready, so the pane stays at a bare shell prompt and every wait window
    // expires against an agent nothing is bringing up (issue #44: ~34–44min lost per run). Each
    // expiry now re-runs the SAME `agent start` — kind and args straight off the layout pane.
    const { deps, store, state, calls, setNow, shipBelt } = build();
    deps.config.layouts.push({
      id: "L",
      tabs: [{ title: "fix", panes: [{ title: "agent", persist: true, env: {}, setup: false, agent: { kind: "claude", args: ["--dangerously-skip-permissions"] } }] }],
    });
    shipBelt.defaultLayout = "L";
    state.eligible = [ticket("W-44")];
    state.paneState = "working"; // the pane is up, but herdr sees no agent ready for input in it…
    state.atShellPrompt = true; // …because it is sitting at a bare shell prompt (the trust prompt case)
    await reconcileRepo(deps); // begins the wait (fix.started_at = 1000)
    const run = store.activeRunForTicket("demo", "jira", "W-44")!;
    expect(calls.agentAdopt).toEqual([]); // nothing re-started while the window is still open

    setNow(1601); // past layout_wait_seconds (600)
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentAdopt).toEqual([["w1:p1", "claude-w1", "claude", "--dangerously-skip-permissions"]]);
    expect(store.getRun(run.id)!.phase).toBe("claiming"); // still waiting, re-armed as before
    const retry = store.timeline("demo", "W-44").find((e) => e.type === "layout_wait_retry")!;
    expect(JSON.parse(retry.detail ?? "{}").agentRestarted).toBe(true);
  });

  describe("a layout pane whose agent herdr never detected (#99)", () => {
    // cursor-agent after a self-update: the pane sits at Cursor's prompt, but `herdr agent list` shows
    // it `unknown` with NO agent label, so every dispatch goes unconfirmed. Only quitting it and typing
    // its command again at the shell gets herdr to detect it.
    const setup = (key: string) => {
      const b = build();
      b.deps.config.layouts.push({
        id: "L",
        tabs: [{ title: "fix", panes: [{ title: "agent", persist: true, env: {}, setup: false, agent: { kind: "cursor", args: ["--model", "m1"] } }] }],
      });
      b.shipBelt.defaultLayout = "L";
      b.state.eligible = [ticket(key)];
      b.state.paneState = "unknown";
      b.state.agentLabel = null;
      b.state.promptStalls = true; // no prompt lands in an undetected agent
      b.state.atShellPrompt = false; // Cursor's TUI holds the foreground
      return b;
    };

    it("relaunches it exactly once, and the next dispatch lands — no park", async () => {
      const { deps, store, state, calls, setNow } = setup("W-99");
      const realPaneRun = deps.herdr.paneRun;
      deps.herdr.paneRun = async (id, cmd) => {
        await realPaneRun(id, cmd);
        if (cmd === "/quit") state.atShellPrompt = true;
        else [state.agentLabel, state.paneState, state.promptStalls] = ["cursor", "idle", false]; // herdr detects the retyped agent
      };
      await reconcileRepo(deps); // waits: the prompt was not confirmed
      const run = store.activeRunForTicket("demo", "jira", "W-99")!;
      setNow(1100);
      await reconcileRun(deps, store.getRun(run.id)!);
      expect(calls.paneRun).toEqual([]); // not before ~2 min

      setNow(1121);
      await reconcileRun(deps, store.getRun(run.id)!);
      expect(calls.paneRun).toEqual([["w1:p1", "/quit"], ["w1:p1", "'cursor-agent' '--model' 'm1'"]]);
      expect(calls.agentAdopt).toEqual([]); // never `agent start` — herdr's stale registration refuses it
      const ev = store.timeline("demo", "W-99").filter((e) => e.type === "pane_relaunched");
      expect(ev.map((e) => JSON.parse(e.detail ?? "{}"))).toEqual([expect.objectContaining({ paneId: "w1:p1", command: "cursor-agent --model m1", detected: true })]);
      expect(store.guardCounter(run.id, "fix", "layout_wait")).toBe(0); // no respawn window spent

      setNow(1130);
      await reconcileRun(deps, store.getRun(run.id)!);
      expect(store.getRun(run.id)!.phase).toBe("running");
      expect(store.getRunStep(run.id, "fix")!.dispatchedAt).toBe(1130);
    });

    it("a relaunch that does not take is not repeated, and the park names the detection failure", async () => {
      const { deps, store, state, calls, setNow } = setup("W-98");
      state.atShellPrompt = true; // the agent already exited to the shell
      await reconcileRepo(deps);
      const run = store.activeRunForTicket("demo", "jira", "W-98")!;
      for (let t = 1121; store.getRun(run.id)!.phase === "claiming" && t < 20_000; t += 121) {
        setNow(t);
        await reconcileRun(deps, store.getRun(run.id)!);
      }
      expect(calls.paneRun).toEqual([["w1:p1", "'cursor-agent' '--model' 'm1'"]]); // once, straight to the retype
      expect(store.getRun(run.id)!.phase).toBe("attention");
      expect(store.getRun(run.id)!.attentionReason).toBe("fix: agent in pane w1:p1 was never detected by Herdr (status unknown)");
    });
  });

  it("a stale herdr registration refusing the re-adopt gets the layout's command typed instead (#99)", async () => {
    const { deps, store, state, calls, setNow, shipBelt } = build();
    deps.config.layouts.push({
      id: "L",
      tabs: [{ title: "fix", panes: [{ title: "agent", persist: true, env: {}, setup: false, agent: { kind: "cursor", args: [] } }] }],
    });
    shipBelt.defaultLayout = "L";
    state.eligible = [ticket("W-97")];
    state.paneState = "working";
    state.adoptFails = true;
    state.adoptError = "agent_name_taken: cursor-w1";
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-97")!;
    setNow(1601);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.paneRun).toEqual([["w1:p1", "'cursor-agent'"]]);
    const retry = store.timeline("demo", "W-97").find((e) => e.type === "layout_wait_retry")!;
    expect(JSON.parse(retry.detail ?? "{}").agentRestarted).toBe(true);
  });

  it("the wait's agent restart leaves a pane that ALREADY has an agent alone", async () => {
    const { deps, store, state, calls, setNow, shipBelt } = build();
    deps.config.layouts.push({
      id: "L",
      tabs: [{ title: "fix", panes: [{ title: "agent", persist: true, env: {}, setup: false, agent: { kind: "claude", args: [] } }] }],
    });
    shipBelt.defaultLayout = "L";
    state.eligible = [ticket("W-45")];
    state.paneState = "working"; // an agent IS there — just mid-turn, or still starting up
    state.atShellPrompt = false; // herdr refuses the pane: not an available shell prompt
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-45")!;
    setNow(1601);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentAdopt).toEqual([]); // never interrupts a live agent
    const retry = store.timeline("demo", "W-45").find((e) => e.type === "layout_wait_retry")!;
    expect(JSON.parse(retry.detail ?? "{}").agentRestarted).toBe(false);
  });

  it("the re-adopt reuses the name the layout BUILD gave that pane, not the base name", async () => {
    // The build numbers the agent panes it walks (herdr requires a name unique among LIVE agents), so
    // a retry that asked for `claude-w1` would be refused `agent_name_taken` for every pane but the
    // first whenever an earlier same-kind pane's agent is alive — and the run would burn its whole
    // wait budget, which is the park this retry exists to prevent.
    const { deps, store, state, calls, setNow, shipBelt } = build();
    deps.config.layouts.push({
      id: "L",
      tabs: [
        // `review` comes FIRST in the layout and is targeted by the belt, so pruning keeps it and its
        // agent takes the base name — the step under wait (`fix`) is the SECOND same-kind pane.
        { title: "review", panes: [{ title: "agent", persist: true, env: {}, setup: false, agent: { kind: "claude", args: [] } }] },
        { title: "fix", panes: [{ title: "agent", persist: true, env: {}, setup: false, agent: { kind: "claude", args: ["--flag"] } }] },
      ],
    });
    shipBelt.defaultLayout = "L";
    state.eligible = [ticket("W-47")];
    state.paneState = "working";
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-47")!;

    setNow(1601);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentAdopt).toEqual([["w1:p1", "claude-w1-2", "claude", "--flag"]]);
  });

  it("with no layout declaring the step's pane, the wait re-arms exactly as before", async () => {
    const { deps, store, state, calls, setNow } = build(); // config.layouts is empty
    state.eligible = [ticket("W-46")];
    state.paneState = "working";
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "W-46")!;
    setNow(1601);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentAdopt).toEqual([]); // nothing to re-start — the engine never builds a pane here
    expect(store.getRunStep(run.id, "fix")!.startedAt).toBe(1601); // window still re-armed
  });

  it("a run parked with layout_wait_timeout auto-recovers on a later tick — re-spawns with NO step_done and NO human resume", async () => {
    // The RWR-18147 stall: a forward re-advance into evidence (after a review→fix bounce) timed out
    // waiting for its layout pane — a transient race; the identical spawn succeeded the moment a
    // human resumed. The park could never heal on its own: the step's agent never existed, so the
    // step-done the old rescue model waited for could not arrive. The engine must re-attempt the
    // spawn itself. (Also the healing path for runs parked by pre-fix code.)
    const { deps, store, state, worktree, shipBelt, calls, setNow } = build();
    shipBelt.steps = [stepCfg("fix"), stepCfg("evidence"), stepCfg("review"), stepCfg("pr")];
    const run = seed(store, worktree, "K-LWP", "running", "evidence", { paneId: "w1:pfix" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    // Parked by the layout wait: evidence's spawn never landed (row exists, no pane).
    store.upsertRunStep(run.id, "evidence", { paneId: null, startedAt: 1000 });
    store.updateRun(run.id, { phase: "attention", attentionReason: "evidence: layout pane evidence/agent never became available", attentionNotifiedAt: 1000 });
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "K-LWP", type: "attention", detail: { reason: "layout_wait_timeout", step: "evidence" } });

    // Next tick: the pane resolves again (exactly what the production resume proved). The engine
    // un-parks, re-attempts the dispatch on the same pass, and the pipeline advances.
    setNow(1660);
    state.tabPane = "w1:pev";
    calls.agentSend.length = 0;
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("evidence");
    expect(got.attentionReason).toBeNull();
    expect(store.getRunStep(run.id, "evidence")!.paneId).toBe("w1:pev");
    expect(calls.agentSend.some(([p]) => p === "w1:pev")).toBe(true); // actually re-prompted
    // The rescue is on the timeline; the ⚠ label was restored to the pane's OWNING step (fix);
    // and the successful dispatch refunds the respawn budget for future waits.
    expect(store.timeline("demo", "K-LWP").some((e) => e.type === "resumed" && (e.detail ?? "").includes("layout_wait_respawn"))).toBe(true);
    expect(calls.paneDisplay).toContainEqual(["w1:pfix", "fix:K-LWP", null, expect.anything()]);
    expect(store.guardCounter(run.id, "evidence", "layout_wait")).toBe(0);
  });

  it("a parked layout wait whose pane is STILL down re-arms the wait (bounded) instead of staying parked", async () => {
    // Rescue when the pane is not yet back: the run un-parks into a fresh full wait window (rather
    // than burning one attempt per 60s tick), keeps retrying the spawn each tick, and heals the
    // moment the pane appears — here under its renamed dispatch label, the RWR-18147 shape.
    const { deps, store, state, worktree, shipBelt, calls, setNow } = build();
    shipBelt.steps = [stepCfg("fix"), stepCfg("evidence"), stepCfg("review"), stepCfg("pr")];
    const run = seed(store, worktree, "K-TRN", "running", "evidence");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.upsertRunStep(run.id, "evidence", { paneId: null, startedAt: 1000 });
    store.updateRun(run.id, { phase: "attention", attentionReason: "evidence: layout pane evidence/agent never became available", attentionNotifiedAt: 1000 });
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "K-TRN", type: "attention", detail: { reason: "layout_wait_timeout", step: "evidence" } });
    state.tabPane = null; // configured label was renamed away on first dispatch; recorded id lost

    setNow(1660);
    await reconcileRun(deps, store.getRun(run.id)!);
    let got = store.getRun(run.id)!;
    expect(got.phase).toBe("running"); // un-parked into a fresh wait — spawn re-attempted, still waiting
    expect(store.guardCounter(run.id, "evidence", "layout_wait")).toBe(1); // one credit consumed
    expect(store.getRunStep(run.id, "evidence")!.startedAt).toBe(1660); // wait window re-armed

    // The pane becomes resolvable again mid-window (under its renamed dispatch label) → dispatched.
    state.tabPaneByName = { "evidence:K-TRN": "w1:pev" };
    setNow(1720);
    calls.agentSend.length = 0;
    await reconcileRun(deps, store.getRun(run.id)!);
    got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("evidence");
    expect(store.getRunStep(run.id, "evidence")!.paneId).toBe("w1:pev");
    expect(calls.agentSend.some(([p]) => p === "w1:pev")).toBe(true);
    expect(store.guardCounter(run.id, "evidence", "layout_wait")).toBe(0); // refunded on success
  });

  it("step with no tab/pane configured → spawns its own dedicated pane", async () => {
    const { deps, store, state, calls, shipBelt } = build();
    shipBelt.steps[0] = { ...shipBelt.steps[0]!, tab: undefined, pane: undefined };
    state.eligible = [ticket("S-1")];
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "S-1")!;
    expect(run.phase).toBe("running");
    expect(calls.agentStart).toBe(1); // spawned its own (the only path that creates a pane)
    expect(store.getRunStep(run.id, "fix")?.paneId).toBe("w1:p2"); // agentStart's pane
    expect(calls.agentSend.length).toBe(0); // prompt was passed as argv, not sent to a layout pane
    expect(calls.transitions).toContainEqual(["S-1", "in_development"]);
  });

  it("withTickLock runs fn when the lock is free, skips it when a tick already holds it", async () => {
    const { deps } = build();
    let ran = 0;
    expect(await withTickLock(deps, async () => { ran += 1; })).toBe(true);
    expect(ran).toBe(1);
    deps.store.acquireLock("tick:demo", "other-pid", 300); // a tick is mid-flight
    expect(await withTickLock(deps, async () => { ran += 1; })).toBe(false);
    expect(ran).toBe(1); // fn not run while the lock is held
  });

  it("respects the concurrency cap", async () => {
    const { deps, store, state } = build();
    deps.config.limits.maxActiveWorkspaces = 1;
    state.eligible = [ticket("K-1"), ticket("K-2")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(1);
  });

  it("running fix + fix agent not done → stays running fix (awaits step-done)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-3", "running", "fix");
    await reconcileRun(deps, run);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix");
    expect(calls.agentSend.length).toBe(0); // alive + working, nothing to do
  });

  it("ask-human parks a step, polls the source, then automatically resumes with the reply", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-HITL", "running", "fix");

    const asked = await requestHumanInput(deps, run, "fix", "Which behavior should win when the flags conflict?");
    expect(asked.posted).toBe(true);
    expect(calls.humanAsk).toHaveLength(1);
    expect(calls.humanAsk[0]?.question).toContain("Which behavior");
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    expect(store.getRun(run.id)!.step).toBe("fix");

    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.humanPoll).toHaveLength(1);
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    expect(store.getRun(run.id)!.step).toBe("fix");

    // The miss backed the next poll off — a tick inside the window doesn't poll again.
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.humanPoll).toHaveLength(1);

    state.humanReply = { body: "Prefer the new flag and keep the legacy behavior as fallback.", externalId: "answer-1", author: "PM" };
    setNow(1000 + 61); // past the first backoff (60s)
    await reconcileRun(deps, store.getRun(run.id)!);

    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix");
    expect(store.getHumanQuestion(asked.questionId)!.status).toBe("answered");
    const replyFile = join(worktree, ".memory/herdr-factory/human-replies/question-1.md");
    expect(readFileSync(replyFile, "utf8")).toContain("Prefer the new flag");
    expect(calls.agentSend.at(-1)?.[1]).toContain("Human guidance has arrived");
  });

  it("ask-human notifies once, then renotifies once per attention_renotify_seconds window while pending", async () => {
    const { deps, store, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-ASKN", "running", "fix");
    await requestHumanInput(deps, run, "fix", "Which toast wins?\nlong context here");
    expect(calls.notify).toBe(1);
    expect(calls.notified[0]?.[0]).toContain("K-ASKN asks a human");
    expect(calls.notified[0]?.[1]).toContain("Which toast wins?");
    expect(calls.notified[0]?.[1]).not.toContain("long context");

    const tick = async (t: number) => {
      setNow(t);
      await reconcileRun(deps, store.getRun(run.id)!);
    };
    await tick(1000);
    await tick(1000 + 3599);
    expect(calls.notify).toBe(1); // inside the window: never more
    await tick(1000 + 3600);
    expect(calls.notify).toBe(2);
    expect(calls.notified[1]?.[0]).toContain("still waiting for a human");
    await tick(1000 + 3601);
    await tick(1000 + 7199);
    expect(calls.notify).toBe(2);
    await tick(1000 + 7200);
    expect(calls.notify).toBe(3);
  });

  it("ending a run leaves no pending question for it", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-ASKEND", "running", "fix");
    const asked = await requestHumanInput(deps, run, "fix", "which toast?");
    await teardownTicket(deps, "K-ASKEND");
    expect(store.getRun(run.id)!.endedAt).not.toBeNull();
    expect(store.pendingHumanQuestionForRun(run.id)).toBeUndefined();
    expect(store.getHumanQuestion(asked.questionId)!.status).toBe("abandoned");
    expect(store.listIntents("demo", { runId: run.id, kind: "human_reply_poll", status: "waiting" })).toHaveLength(0);
  });

  it("running fix + step-done fix → review (spawns review agent, no Jira move; wires the handoff)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-4", "running", "fix");
    store.markStepDone(run.id, "fix");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("review");
    expect(store.getRunStep(run.id, "review")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1); // review prompt dispatched
    // user is viewing this worktree on a belt pane (default focusedPane) → focus follows the
    // active step to the review pane, and the pending flag is cleared
    expect(calls.agentFocus).toContain("w1:p1");
    expect(got.focusPending).toBe(false);
    expect(calls.transitions).not.toContainEqual(["K-4", "in_review"]);
    // the rendered review prompt (written to the worktree) carries the step body, the prior
    // handoff pointer, and the engine-injected handover scaffold (belt + step-done footer).
    const body = readFileSync(join(worktree, ".memory/herdr-factory/prompt-review.md"), "utf8");
    expect(body).toContain("REVIEW prompt");
    expect(body).toContain("handoff-fix.md");
    expect(body).toContain("step-done K-4 review");
    expect(body).toContain("**ship** belt"); // scaffold names the belt
    // the prior step's pane + session id are captured at handoff and wired into the prompt
    expect(store.getRunStep(run.id, "fix")?.sessionId).toBe("sess-1");
    expect(body).toContain("w1:p1"); // prior pane
    expect(body).toContain("sess-1"); // prior session id
  });

  it("running review + step-done review → pr (spawns pr agent)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-5", "running", "review");
    store.markStepDone(run.id, "review");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("pr");
    expect(store.getRunStep(run.id, "pr")?.paneId).toBe("w1:p1");
    expect(calls.agentSend.length).toBe(1);
  });

  it("running review + bounce fix → back to running fix (clears fix's done, writes feedback, re-prompts fix's own pane)", async () => {
    const { deps, store, worktree, calls, shipBelt } = build();
    const run = seed(store, worktree, "K-B1", "running", "review");
    // fix already completed earlier, on its OWN pane (distinct from the review pane w1:p1).
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    const src = deps.resolveSource("jira")!;
    const res = await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", "The submit button still 500s — the evidence video shows the error toast.");
    expect(res.ok).toBe(true);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix");
    // MUST be cleared, else reconcileStep re-advances the just-bounced step instantly.
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    expect(store.guardCounter(run.id, "fix", "bounce_cap")).toBe(1);
    // targets fix's OWN pane (w1:pfix), NOT run.paneId (the review pane w1:p1).
    expect(got.paneId).toBe("w1:pfix");
    expect(calls.agentSend.some(([p]) => p === "w1:pfix")).toBe(true);
    // feedback note written where the fix agent's rework banner points.
    const fb = join(worktree, ".memory/herdr-factory/feedback-fix.md");
    expect(existsSync(fb)).toBe(true);
    expect(readFileSync(fb, "utf8")).toContain("still 500s");
    expect(store.timeline("demo", "K-B1").some((e) => e.type === "bounced")).toBe(true);
  });

  it("bounce event detail keeps the reason, capped at BOUNCE_REASON_MAX (the note dies at teardown)", async () => {
    const { deps, store, worktree, shipBelt } = build();
    const run = seed(store, worktree, "K-BR", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    const reason = "The submit button still 500s.\n" + "x".repeat(2000);
    await bounceStep(deps, store.getRun(run.id)!, shipBelt, deps.resolveSource("jira")!, "fix", reason);
    const ev = store.timeline("demo", "K-BR").find((e) => e.type === "bounced")!;
    const kept = (JSON.parse(ev.detail!) as { reason: string }).reason;
    expect(kept.startsWith("The submit button still 500s.")).toBe(true);
    expect(kept.length).toBe(BOUNCE_REASON_MAX);
  });

  it("bounce whose target pane is dead respawns it — the re-rendered prompt carries the rework banner + feedback pointer", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    const run = seed(store, worktree, "K-B1b", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    state.deadPanes.add("w1:pfix"); // fix's original pane is gone → respawn (which re-renders the prompt)
    const src = deps.resolveSource("jira")!;
    await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", "the modal never opens on click");
    const body = readFileSync(join(worktree, ".memory/herdr-factory/prompt-fix.md"), "utf8");
    expect(body).toContain("Rework requested"); // engine-injected banner, up top
    expect(body).toContain("feedback-fix.md"); // points the fix agent at the findings
  });

  it("bounce clears `done` on the target AND every completed step between it and the bouncer", async () => {
    const { deps, store, worktree } = build();
    // A 4-step belt (fix → evidence → review → pr) so there IS an intermediate step between the
    // bouncer (review) and the target (fix). Evidence is read-only, as in production — its watch
    // clock is the read-only BASELINE (the "entry" rebase clears exactly the clocks each step's
    // guards declare, not a fixed column set).
    const belt: BeltRuntime = { name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, watchPr: true, steps: [stepCfg("fix"), stepCfg("evidence", { readOnly: true }), stepCfg("review"), stepCfg("pr")] };
    const run = seed(store, worktree, "K-B6", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.upsertWatchState(run.id, "fix", "heartbeat", { sig: "sha-x", basedAt: 5 });
    store.upsertRunStep(run.id, "evidence", { paneId: "w1:pev", done: true });
    store.upsertWatchState(run.id, "evidence", "read_only", { sig: "sha-x", basedAt: 5 });
    const src = deps.resolveSource("jira")!;
    await bounceStep(deps, store.getRun(run.id)!, belt, src, "fix", "the fix isn't proven");
    expect(store.getRun(run.id)!.step).toBe("fix");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    expect(store.getWatchState(run.id, "fix", "heartbeat")!.sig).toBe(null); // the target's heartbeat clock reset
    // The intermediate evidence step MUST be cleared too, or the forward re-run skips its re-capture
    // and the PR embeds stale, pre-fix evidence — and its frozen baseline must not survive into the
    // re-entry (a stale frozen baseline would false-park the re-captured pass as a violation).
    expect(store.getRunStep(run.id, "evidence")!.done).toBe(false);
    const evBaseline = store.getWatchState(run.id, "evidence", "read_only")!;
    expect(evBaseline.sig).toBe(null);
    expect(evBaseline.basedAt).toBe(null);
  });

  it("after a bounce, fix re-completing runs the pipeline forward again (review re-runs, still not done)", async () => {
    const { deps, store, worktree, shipBelt } = build();
    const run = seed(store, worktree, "K-B2", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.markStepDone(run.id, "review"); // review had (hypothetically) also completed — bounce must not leave it done
    const src = deps.resolveSource("jira")!;
    await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", "needs rework");
    // the bouncer (review) did NOT step-done; only fix's done was cleared — but here review WAS marked
    // done above, so confirm the forward re-entry still lands on review by clearing it as a real
    // bounce-from-review would (review calls bounce, never step-done). Simulate that:
    store.upsertRunStep(run.id, "review", { done: false });
    store.markStepDone(run.id, "fix"); // fix reworks + signals done
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.step).toBe("review"); // forward flow resumes: fix → review
    expect(store.getRunStep(run.id, "review")!.done).toBe(false); // review re-runs fresh
  });

  it("RWR-18147: after a bounce, the forward re-advance re-runs the next step even when its layout pane was renamed", async () => {
    // The exact stuck run (belt fix→evidence→review→pr): review bounced to fix, fix reworked +
    // signalled step-done, and the pipeline advanced back into evidence — which had ALREADY run once.
    // Two things had to line up for it to re-run, and both had regressed:
    //   1. evidence's run_step still carried the started_at from its FIRST pass (ancient), so a naive
    //      re-advance parked it "over budget (idle)" without re-running it.
    //   2. evidence's layout pane was RENAMED on its first dispatch (agent → evidence:KEY), so
    //      re-resolving the configured label (evidence/agent) finds NOTHING (tabPane = null) — the run
    //      then wedged in a layout-wait timeout ("evidence/agent never became available").
    // The fix re-bases the clock on entry AND re-prompts the pane evidence already owns instead of
    // re-resolving the (renamed) label.
    const { deps, store, state, worktree, shipBelt, setNow, calls } = build();
    shipBelt.steps = [stepCfg("fix"), stepCfg("evidence"), stepCfg("review"), stepCfg("pr")]; // 4-step belt (adds evidence)
    const run = seed(store, worktree, "K-RWR", "running", "review");
    // fix + evidence completed on the first forward pass; evidence's budget clock (3600s) is ancient,
    // and its live layout pane is w1:pev (still tracked by herdr — the agent finished + is idle-at-prompt).
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.upsertRunStep(run.id, "evidence", { paneId: "w1:pev", done: true, startedAt: 1000 });
    store.upsertWatchState(run.id, "evidence", "heartbeat", { sig: "sha-x" });
    state.tabPane = null; // the configured label no longer resolves — the first dispatch renamed the pane
    const src = deps.resolveSource("jira")!;
    await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", "the evidence didn't prove the fix");
    expect(store.getRun(run.id)!.step).toBe("fix");
    expect(store.getRunStep(run.id, "evidence")!.startedAt).toBe(1000); // bounce leaves the stale clock in place

    // fix signals done far in the future (the rework took a while). The forward advance must re-enter
    // evidence and actually re-dispatch it — not park it for budget, and not wedge on the missing label.
    setNow(101_000); // 100_000s ≫ evidence's 3600s budget, measured from the stale started_at
    store.markStepDone(run.id, "fix");
    calls.agentSend.length = 0;
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running"); // regression guard: was "attention" (over budget, or layout-wait timeout)
    expect(got.step).toBe("evidence"); // advanced fix → evidence
    expect(got.attentionReason).toBe(null);
    const ev = store.getRunStep(run.id, "evidence")!;
    expect(ev.startedAt).toBe(101_000); // budget clock RE-BASED on entry (was 1000, hours over budget)
    expect(ev.done).toBe(false); // its stale done is cleared so it re-runs, not skipped
    expect(ev.paneId).toBe("w1:pev"); // REUSED the pane it already owned — not re-resolved by the renamed label
    expect(calls.agentSend.some(([p]) => p === "w1:pev")).toBe(true); // and was actually re-prompted

    // A later tick keeps it running (its live pane is watched) rather than re-parking it.
    setNow(101_010);
    state.paneState = "working"; // evidence is now doing the re-capture
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
  });

  it("re-entry re-finds a step's renamed pane by its dispatch name when the recorded id was lost", async () => {
    // A run parked by the pre-fix code (which cleared the re-entered step's pane_id) resumes into a
    // step whose LAYOUT pane still exists — but under its first-dispatch name (evidence:KEY), so the
    // configured label (evidence/agent) no longer resolves it. With no recorded id AND no label match,
    // dispatch must still recover the pane by its deterministic dispatch name, or the run re-wedges in
    // a layout-wait timeout the instant it's resumed.
    const { deps, store, state, worktree, shipBelt, calls } = build();
    shipBelt.steps = [stepCfg("fix"), stepCfg("evidence"), stepCfg("review"), stepCfg("pr")];
    const run = seed(store, worktree, "K-REN", "running", "evidence");
    store.upsertRunStep(run.id, "evidence", { paneId: null }); // recorded id lost by the old code path
    state.tabPane = null; // configured label "agent" no longer matches — the pane was renamed
    state.tabPaneByName = { "evidence:K-REN": "w1:pev" }; // but it's still there under its dispatch name
    calls.agentSend.length = 0;

    await reconcileRun(deps, store.getRun(run.id)!);

    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running"); // recovered — NOT parked in a layout-wait timeout
    expect(got.step).toBe("evidence");
    expect(store.getRunStep(run.id, "evidence")!.paneId).toBe("w1:pev"); // re-found by dispatch name + re-recorded
    expect(calls.agentSend.some(([p]) => p === "w1:pev")).toBe(true);
  });

  it("exceeding max_bounces escalates to attention instead of bouncing again", async () => {
    const { deps, store, worktree, calls, shipBelt } = build();
    const run = seed(store, worktree, "K-B3", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    const src = deps.resolveSource("jira")!;
    // max_bounces = 3 → the first 3 bounces proceed; the 4th escalates.
    for (let i = 0; i < 3; i++) {
      store.updateRun(run.id, { phase: "running", step: "review" });
      const r = await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", `round ${i}`);
      expect(r.ok).toBe(true);
      expect(store.getRun(run.id)!.phase).toBe("running");
    }
    store.updateRun(run.id, { phase: "running", step: "review" });
    await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", "round 4");
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention");
    expect(got.attentionReason).toContain("max");
    expect(calls.notify).toBeGreaterThan(0);
  });

  it("evidence parked by the flaky-capture cap is un-parked by a genuine step-done → advances to review", async () => {
    // The RWR-17832 regression: the evidence agent hit the capture cap (parked → attention), then
    // went on to actually finish and signalled step-done. Evidence is a non-gating backstop step, so a
    // real step-done must un-park the run and let the pipeline advance — not wedge it forever.
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps = [stepCfg("fix"), stepCfg("evidence"), stepCfg("review"), stepCfg("pr")]; // 4-step belt (adds evidence)
    const run = seed(store, worktree, "K-EV", "running", "evidence", { paneId: "w1:pev" });
    store.upsertRunStep(run.id, "evidence", { paneId: "w1:pev" });
    // maxCaptureAttempts = 5 → the 6th signalled attempt parks the run for attention (capture_limit).
    for (let i = 0; i < 6; i++) await recordCaptureAttempt(deps, store.getRun(run.id)!, shipBelt);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(store.getRun(run.id)!.attentionReason).toContain("capture attempt");

    // The agent finishes anyway and signals step-done; the next reconcile must rescue + advance.
    store.markStepDone(run.id, "evidence");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("review"); // evidence → review, the forward advance ran
    expect(got.attentionReason).toBeNull();
    expect(store.getRunStep(run.id, "review")?.paneId).toBeTruthy(); // review was spawned
  });

  it("a NON-watchdog attention park (e.g. PR closed) is NOT rescued by a stray step-done", async () => {
    // The rescue is scoped to step-execution watchdogs. A park a human must resolve (source item gone,
    // PR closed, bounce oscillation, …) must stay parked even if a run_step happens to be `done`.
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps = [stepCfg("fix"), stepCfg("evidence"), stepCfg("review"), stepCfg("pr")]; // 4-step belt (adds evidence)
    const run = seed(store, worktree, "K-EVN", "attention", "evidence", { paneId: "w1:pev" });
    store.upsertRunStep(run.id, "evidence", { paneId: "w1:pev", done: true });
    // Simulate a non-watchdog escalation reason on the record (what escalateAttention would log).
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "K-EVN", type: "attention", detail: { reason: "pr_closed" } });
    store.updateRun(run.id, { attentionReason: "PR #7 closed without merging" });

    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention"); // stays parked — a human must decide
    expect(got.step).toBe("evidence");
  });

  it("rejects a bounce that isn't strictly backward, isn't allowed, or isn't from a running step", async () => {
    const { deps, store, worktree, shipBelt } = build();
    const run = seed(store, worktree, "K-B4", "running", "review");
    const src = deps.resolveSource("jira")!;
    // pr is AFTER review → not backward.
    expect((await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "pr", "x")).ok).toBe(false);
    expect(store.getRun(run.id)!.step).toBe("review"); // unchanged
    // fix's canBounceTo is [] and it's the first step → nothing to bounce to.
    store.updateRun(run.id, { step: "fix" });
    expect((await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", "x")).ok).toBe(false);
    // not in a running step (reviewing PHASE) → rejected.
    store.updateRun(run.id, { phase: "reviewing", step: null });
    expect((await bounceStep(deps, store.getRun(run.id)!, shipBelt, src, "fix", "x")).ok).toBe(false);
  });

  it("running pr + PR open + step-done pr → reviewing (review transition; watch starts idle, no deadline)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-6", "running", "pr", { prNumber: 13 });
    store.markStepDone(run.id, "pr");
    state.pr = { number: 13, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing");
    expect(got.step).toBeNull(); // no belt step active during the PR watch
    expect(got.resolverActive).toBe(false); // starts idle — holds no slot until it's resolving
    expect(calls.transitions).toContainEqual(["K-6", "in_review"]);
  });

  it("running pr + PR merged out-of-band → reviewing", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-7", "running", "pr", { prNumber: 14 });
    state.pr = { number: 14, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
  });

  it("running pr + PR open (non-draft) + NOT step-done → reviewing (hands off on adoption; review transition fires)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-6d", "running", "pr", { prNumber: 16 });
    // The pr agent opened a real (non-draft) PR but hasn't signalled step-done — it may still be
    // working or about to block on a question. The run must stop waiting on the step and hand off to
    // the review watch, so a later merge still lands (RWR-18204).
    state.pr = { number: 16, state: "OPEN", url: "u", isDraft: false };
    state.paneState = "working"; // agent still busy — must NOT gate the handoff
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing");
    expect(got.step).toBeNull();
    expect(calls.transitions).toContainEqual(["K-6d", "in_review"]);
  });

  it("running pr + DRAFT PR open + NOT step-done → stays in the pr step (a draft isn't up for review)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-6e", "running", "pr", { prNumber: 17 });
    state.pr = { number: 17, state: "OPEN", url: "u", isDraft: true };
    state.paneState = "working"; // agent still finalizing the draft
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running"); // a draft keeps the step-done gate
    expect(got.step).toBe("pr");
    expect(calls.transitions).not.toContainEqual(["K-6e", "in_review"]);
  });

  it("running pr + our PR closed without merging → attention (not torn down)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-8", "running", "pr", { prNumber: 15 });
    state.pr = { number: 15, state: "CLOSED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention"); // a closed-without-merge PR is a human decision
    expect(got.outcome).toBeNull(); // run is NOT ended — worktree/branch left intact for reopen
    expect(got.attentionReason).toContain("closed without merging");
    expect(calls.transitions).not.toContainEqual(["K-8", "in_review"]);
    expect(calls.transitions).not.toContainEqual(["K-8", "aborted"]); // no terminal write-back
    expect(calls.worktreeRemove).not.toContain("w1"); // worktree preserved
    expect(calls.notify).toBe(1);
  });

  it("fix step past the stall window but still working → extended (a live agent is never parked by a timer)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-H1", "running", "fix");
    store.upsertWatchState(run.id, "fix", "heartbeat", { sig: "sha0", basedAt: 1000 });
    state.headSha = "sha0"; // HEAD frozen → no new commits...
    state.paneState = "working"; // ...but the agent is actively working (long stretch between commits)
    setNow(1000 + 2701); // past stall_seconds
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(calls.notify).toBe(0);
  });

  it("fix step stalled AND idle (no commits, worker not working) → attention", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-H1b", "running", "fix");
    store.upsertWatchState(run.id, "fix", "heartbeat", { sig: "sha0", basedAt: 1000 });
    state.headSha = "sha0"; // HEAD frozen → no new commits
    state.paneState = "idle"; // AND not working → genuinely stuck
    setNow(1000 + 2701); // past stall_seconds
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("fix step commits advancing → heartbeat resets, stays running fix", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-H2", "running", "fix");
    store.upsertWatchState(run.id, "fix", "heartbeat", { sig: "sha0", basedAt: 1000 });
    state.headSha = "sha1"; // HEAD moved → progress
    state.paneState = "working";
    setNow(1000 + 2701);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    const heartbeat = store.getWatchState(run.id, "fix", "heartbeat")!;
    expect(heartbeat.sig).toBe("sha1");
    expect(heartbeat.basedAt).toBe(1000 + 2701);
    expect(calls.notify).toBe(0);
  });

  it("review step over budget + idle → attention", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-B1", "running", "review");
    state.paneState = "idle";
    setNow(1000 + 1801); // past review budget (1800)
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
    // the active pane is relabelled to a glaring attention marker (the persistent herdr cue)
    expect(calls.paneDisplay).toContainEqual(["w1:p1", "review:K-B1", "⚠ ATTENTION K-B1", expect.anything()]);
  });

  it("review step over budget but still working → extended (stays running)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-B2", "running", "review");
    state.paneState = "working";
    setNow(1000 + 1801);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(calls.notify).toBe(0);
  });

  it("step pane dead before signalling → confirmed absence across two ticks, THEN re-spawns", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-D1", "running", "fix", { paneId: "w1:dead" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:dead" });
    state.deadPanes.add("w1:dead"); // the fix pane is gone; the layout pane (w1:p1) is alive

    // First confirmed absence: recorded, NOT respawned (guard against transient herdr blips).
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(calls.agentSend.length).toBe(0);
    expect(store.getRunStep(run.id, "fix")!.absentAt).toBe(1000);

    // Second confirmed absence past the confirmation window: re-dispatched.
    setNow(1000 + 46);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running"); // still gating
    expect(calls.agentSend.length).toBe(1); // re-dispatched into the live layout pane
    expect(store.getRunStep(run.id, "fix")!.absentAt).toBeNull(); // reset on dispatch
  });

  it("pane back in the list after a first absence mark → absence cleared, no re-spawn", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-D2", "running", "fix", { paneId: "w1:flap" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:flap" });
    state.deadPanes.add("w1:flap");
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRunStep(run.id, "fix")!.absentAt).toBe(1000);

    state.deadPanes.delete("w1:flap"); // herdr lists it again (daemon restart healed)
    setNow(1000 + 60);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRunStep(run.id, "fix")!.absentAt).toBeNull();
    expect(calls.agentSend.length).toBe(0); // never respawned
  });

  it("herdr unreachable → liveness deferred: no re-spawn, no attention, absence NOT recorded", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-D3", "running", "fix", { paneId: "w1:p1" });
    state.herdrUnreachable = true;
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(calls.agentSend.length).toBe(0);
    expect(calls.notify).toBe(0);
    expect(store.getRunStep(run.id, "fix")!.absentAt).toBeNull();
  });

  it("herdr unreachable while over budget → watchdog deferred (no false attention)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-D4", "running", "review");
    state.herdrUnreachable = true;
    setNow(1000 + 1801); // past review budget
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(calls.notify).toBe(0);
  });

  it("reviewing + merged PR → teardown (worktree remove + branch delete, ended merged)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-9", "reviewing", null, {});
    state.pr = { number: 9, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(store.countActive("demo")).toBe(0);
    expect(calls.transitions).toContainEqual(["K-9", "merged"]); // terminal state written back
    expect(calls.worktreeRemove).toContain("w1");
    expect(calls.branchDelete).toContain("fix/K-9-s");
  });

  // A terminal signal is applied IN-PROCESS by the CLI the agent runs, and that CLI's cwd is the
  // run's own worktree. `herdr worktree remove --force` HUPs every pane in the workspace — killing
  // that very process mid-call, so its run lock sits stale for the whole 300s TTL and the run never
  // reaches ended_at. Teardown must hand over to the tick loop, which runs outside every worktree.
  it("teardown DEFERS when this process is standing inside the worktree it would remove", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-CWD", "reviewing", null, {});
    state.pr = { number: 11, state: "MERGED", url: "u" };
    const cwd = process.cwd();
    try {
      process.chdir(worktree); // exactly where an agent's `step-done`/`teardown` CLI runs
      await reconcileRun(deps, store.getRun(run.id)!);
    } finally {
      process.chdir(cwd);
    }
    expect(store.getRun(run.id)!.phase, "the outcome is stamped and the hand-over is visible").toBe("tearing_down");
    expect(store.getRun(run.id)!.outcome).toBe("merged");
    expect(calls.worktreeRemove, "nothing was removed from under the running process").toEqual([]);
    expect(store.getRun(run.id)!.endedAt).toBeNull();

    // …and the next tick, running outside the worktree, finishes it.
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("done");
    expect(calls.worktreeRemove).toContain("w1");
  });

  // The hand-over assumes someone is outside. If the ENGINE itself were started inside a worktree
  // there is nobody to hand to, and the deferral would loop forever — so the second and later
  // deferrals are warn-level and name the fix. Silent is the only unacceptable outcome here.
  it("teardown's deferral is info once, then WARN — a loop with no escape is never silent", async () => {
    const { deps, store, state, worktree } = build();
    const logs: string[] = [];
    deps.log = (level, msg) => { logs.push(`${level}: ${msg}`); };
    const run = seed(store, worktree, "K-CWD2", "reviewing", null, {});
    state.pr = { number: 12, state: "MERGED", url: "u" };
    const cwd = process.cwd();
    try {
      process.chdir(worktree);
      await reconcileRun(deps, store.getRun(run.id)!); // first: reviewing -> tearing_down, handed over
      await reconcileRun(deps, store.getRun(run.id)!); // second: already tearing_down — nobody took it
    } finally {
      process.chdir(cwd);
    }
    const deferrals = logs.filter((l) => l.includes("inside the worktree it would remove"));
    expect(deferrals).toHaveLength(2);
    expect(deferrals[0], "the first is a routine hand-over").toMatch(/^info: .*the next tick, which runs outside it, will finish it/);
    expect(deferrals[1], "the second names the only cause and its fix").toMatch(/^warn: .*Restart it from outside/);
  });

  it("teardown kills the dev server on the port the run reserved (hf-port), before the dir goes", async () => {
    const { deps, store, state, worktree, calls } = build();
    // The handshake the target repo's setup/dev command writes: the chosen port in the WORKTREE's
    // git dir (a linked worktree's `.git` is a file pointing at it), not in the checkout.
    const gitDir = mkdtempSync(join(tmpdir(), "cats-gitdir-"));
    tmps.push(gitDir);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "hf-port"), "4100\n");
    const run = seed(store, worktree, "K-PORT", "reviewing", null, {});
    state.pr = { number: 40, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.killPort).toEqual([4100]);
    expect(store.getRun(run.id)!.phase).toBe("done");
  });

  it("teardown carries on when hf-port is absent or unreadable — a missing port is never a failure", async () => {
    for (const [key, port] of [["K-NOPORT", null], ["K-BADPORT", "not-a-port"]] as const) {
      const { deps, store, state, worktree, calls } = build();
      if (port !== null) {
        const gitDir = mkdtempSync(join(tmpdir(), "cats-gitdir-"));
        tmps.push(gitDir);
        writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
        writeFileSync(join(gitDir, "hf-port"), port);
      }
      const run = seed(store, worktree, key, "reviewing", null, {});
      state.pr = { number: 41, state: "MERGED", url: "u" };
      await reconcileRun(deps, store.getRun(run.id)!);
      expect(calls.killPort).toEqual([]); // nothing to reap
      expect(store.getRun(run.id)!.phase).toBe("done"); // teardown still completed
      expect(calls.worktreeRemove).toContain("w1");
    }
  });

  // ISSUE #98: a work step's dev server must not outlive the STEP — nor hold its port and RSS
  // through a park. The same hf-port reap as teardown, at every step change and every park.
  const reservePort = (worktree: string, port: string) => {
    const gitDir = mkdtempSync(join(tmpdir(), "cats-gitdir-"));
    tmps.push(gitDir);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "hf-port"), port);
  };
  const stopped = (store: Store, key: string) => store.timeline("demo", key).filter((e) => e.type === "dev_server_stopped").map((e) => JSON.parse(e.detail!));

  it("step-done kills the listener on the run's reserved port before the next step starts, and logs it", async () => {
    const { deps, store, worktree, calls } = build();
    reservePort(worktree, "4001\n");
    const run = seed(store, worktree, "K-DS1", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    await applySignal(deps, "step-done", { key: "K-DS1", step: "review" });
    expect(store.getRun(run.id)!.step).toBe("pr");
    expect(calls.killPort).toEqual([4001]);
    expect(stopped(store, "K-DS1")).toEqual([{ port: 4001, pids: [4242], rssKb: 2_400_000, why: "step-done", step: "review" }]);
  });

  it("a bounce and every park (attention, waiting_for_human) kill the reserved-port listener", async () => {
    const { deps, store, worktree, calls } = build();
    reservePort(worktree, "4001");
    const run = seed(store, worktree, "K-DS2", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    await applySignal(deps, "bounce", { key: "K-DS2", toStep: "fix", reason: "regressed", step: "review", pass: 1 });
    await requestHumanInput(deps, store.getRun(run.id)!, "fix", "which toast?");
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    await bounceStep(deps, store.getRun(run.id)!, deps.belts[0]!, deps.resolveSource("jira")!, "fix", "take it again", { operator: true });
    // A bounce over the cap parks for attention instead of rewinding.
    const capped = seed(store, worktree, "K-DS3", "running", "review");
    for (let i = 0; i < 3; i++) store.bumpGuardCounter(capped.id, "fix", "bounce_cap"); // limits.maxBounces is 3
    await applySignal(deps, "bounce", { key: "K-DS3", toStep: "fix", reason: "again", step: "review", pass: 1 });
    expect(store.getRun(capped.id)!.phase).toBe("attention");
    expect(stopped(store, "K-DS2").map((d) => d.why)).toEqual(["bounce", "waiting for a human", "rework"]);
    expect(stopped(store, "K-DS3").map((d) => d.why)).toEqual(["parked"]);
    expect(calls.killPort).toEqual([4001, 4001, 4001, 4001]);
  });

  // ISSUE #108: the port is not proof of ownership. What was reaped (pid, RSS, cwd), what was left
  // running and why, and the lsof behind a "nothing was listening" all land in the log.
  it("logs each killed pid's RSS and cwd, each sibling listener left running, and the lsof behind an empty port", async () => {
    const { deps, store, worktree } = build();
    reservePort(worktree, "4001");
    const logs: string[] = [];
    deps.log = (level, msg) => { logs.push(`${level}: ${msg}`); };
    const results = [
      { killed: [{ pid: 4242, rssKb: 2_400_000, cwd: worktree }], skipped: [{ pid: 7, cwd: "/wt/sibling" }, { pid: 8, cwd: null }], lsof: "lsof A" },
      { killed: [], skipped: [], lsof: "lsof -nP -ti tcp:4001 -sTCP:LISTEN" },
    ];
    deps.killPortListeners = async () => results.shift()!;
    const run = seed(store, worktree, "K-DS5", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    await applySignal(deps, "step-done", { key: "K-DS5", step: "review" });
    await requestHumanInput(deps, store.getRun(run.id)!, "pr", "which toast?");
    const dev = logs.filter((l) => l.includes("dev server port 4001"));
    expect(dev).toEqual([
      "warn: K-DS5: dev server port 4001 (step-done) — pid 7 belongs to /wt/sibling, not this run; left running",
      "warn: K-DS5: dev server port 4001 (step-done) — pid 8 belongs to an unreadable cwd, not this run; left running",
      `info: K-DS5: dev server port 4001 (step-done) — killed pid(s) 4242 (2344 MB RSS, cwd ${worktree})`,
      "info: K-DS5: dev server port 4001 (waiting for a human) — nothing was listening (lsof -nP -ti tcp:4001 -sTCP:LISTEN)",
    ]);
    expect(stopped(store, "K-DS5").map((d) => d.pids)).toEqual([[4242]]); // a skip-only / empty reap records no event
  });

  it("a run with no hf-port transitions exactly as before — no kill, no event", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-DS4", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    await applySignal(deps, "step-done", { key: "K-DS4", step: "review" });
    expect(store.getRun(run.id)!.step).toBe("pr");
    expect(calls.killPort).toEqual([]);
    expect(stopped(store, "K-DS4")).toEqual([]);
  });

  it("teardown drops a still-pending evidence upload (best-effort — worktree about to be removed)", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-EVD", "reviewing", null, {});
    // An evidence upload never landed (SSO down through merge) — still pending at teardown.
    enqueueEvidencePublish(store, run.id, "p/A", join(worktree, ".memory/herdr-factory/evidence"));
    const pending = () => store.listIntents("demo", { kind: "evidence_publish", status: "pending", runId: run.id });
    expect(pending()).toHaveLength(1);
    state.pr = { number: 42, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("done");
    expect(pending()).toHaveLength(0); // dropped at teardown
  });

  it("reviewing polls by PR number — a merge is still detected after the head branch is deleted", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-9b", "reviewing", null, { prNumber: 9 });
    state.pr = null; // head branch deleted on merge → branch discovery finds nothing
    state.prByNumber = { number: 9, state: "MERGED", url: "u" }; // …but the number still resolves
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(calls.branchDelete).toContain("fix/K-9b-s"); // local branch still cleaned up
  });

  it("reviewing + PR closed without merging → attention (worktree preserved, not torn down)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-9c", "reviewing", null, { prNumber: 9 });
    state.pr = { number: 9, state: "CLOSED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention");
    expect(got.outcome).toBeNull();
    expect(calls.worktreeRemove).not.toContain("w1");
    expect(calls.branchDelete).not.toContain("fix/K-9c-s");
    expect(calls.notify).toBe(1);
  });

  it("attention + our PR merges out-of-band → teardown (attention is not a dead end)", async () => {
    const { deps, store, state, worktree, calls } = build();
    // Parked in attention (e.g. a resolver stalled) but the PR then merged out-of-band.
    const run = seed(store, worktree, "K-A1", "attention", null, { prNumber: 21, attentionReason: "parked for attention" });
    state.pr = { number: 21, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(calls.worktreeRemove).toContain("w1");
    expect(calls.branchDelete).toContain("fix/K-A1-s");
    expect(store.countActive("demo")).toBe(0); // slot reclaimed
  });

  it("attention + PR still open → stays parked (no teardown)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-A2", "attention", null, { prNumber: 22, attentionReason: "step over budget" });
    state.pr = { number: 22, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention");
    expect(got.outcome).toBeNull();
    expect(calls.worktreeRemove).not.toContain("w1");
  });

  it("attention before a PR was opened (no prNumber) → not polled, stays parked", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-A3", "attention", null, { attentionReason: "fix step stalled" });
    state.prByNumber = { number: 23, state: "MERGED", url: "u" }; // would fire IF we polled — but we never adopted a PR
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention");
    expect(got.outcome).toBeNull();
  });

  it("waiting_for_human + adopted PR merges out-of-band → teardown (merged), even with a question outstanding", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-WH1", "waiting_for_human", "pr", { prNumber: 24 });
    // The pr step is parked on an unanswered question (RWR-18204's exact state) …
    store.createHumanQuestion({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-WH1", step: "pr", question: "restore the login route?" });
    // … and the human merges the PR anyway instead of answering. The merge must still be caught.
    state.pr = { number: 24, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(calls.transitions).toContainEqual(["K-WH1", "merged"]); // terminal write-back fires
    expect(calls.worktreeRemove).toContain("w1"); // slot reclaimed
  });

  it("teardown falls back to workspace close + dir removal when worktree remove leaves the workspace", async () => {
    const { deps, store, state, worktree, calls } = build();
    state.workspaceExists = true; // herdr deregistered the git worktree but left the workspace
    const run = seed(store, worktree, "K-12", "reviewing", null, {});
    state.pr = { number: 12, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(calls.worktreeRemove).toContain("w1"); // primary path attempted
    expect(calls.workspaceClose).toContain("w1"); // verified-still-present → closed directly
    expect(calls.rmrf).toContain(worktree); // orphaned checkout dir cleared
    expect(calls.branchDelete).toContain("fix/K-12-s"); // branch still deleted
  });

  it("reviewing + actionable new signature + idle → wakes resolver (claims a slot)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-10", "reviewing", null, { lastThreadSig: "old" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:p1" }); // the work step's pane — the resolver runs there
    state.pr = { number: 10, state: "OPEN", url: "u" };
    state.sig = { unresolved: 2, failing: 0, pending: 0, sig: "newsig" };
    state.paneState = "idle";
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend.length).toBe(1); // re-prompted the live work-step pane
    // The resolver prompt is now a rendered library file (prompts/resolver.md), dispatched via a
    // one-line "read it" pointer — not a hardcoded inline string.
    expect(calls.agentSend[0]![1]).toContain(".memory/herdr-factory/prompt-resolver.md");
    const resolverPrompt = readFileSync(join(worktree, ".memory/herdr-factory/prompt-resolver.md"), "utf8");
    expect(resolverPrompt).toContain("PR #10"); // @@PR_NUMBER@@ substituted
    expect(resolverPrompt).toContain("K-10"); // @@KEY@@ substituted
    expect(resolverPrompt).not.toMatch(/@@[A-Z_]+@@/); // no dangling tokens
    const got = store.getRun(run.id)!;
    expect(got.lastThreadSig).toBe("newsig");
    expect(got.resolverActive).toBe(true); // now actively resolving → holds a slot
    expect(store.countOccupying("demo")).toBe(1);
  });

  it("reviewing + resolver finished (went idle) → releases its slot, keeps watching (no time limit)", async () => {
    const { deps, store, state, worktree } = build();
    // Was actively resolving a prior round; now nothing actionable and the pane has gone idle.
    const run = seed(store, worktree, "K-10b", "reviewing", null, { prNumber: 10, resolverActive: true, lastThreadSig: "s0" });
    expect(store.countOccupying("demo")).toBe(1); // occupying while it was resolving
    state.pr = { number: 10, state: "OPEN", url: "u" };
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" }; // resolved — nothing to do
    state.paneState = "idle";
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing"); // still watching the PR — no teardown, no attention
    expect(got.resolverActive).toBe(false); // slot released
    expect(store.countOccupying("demo")).toBe(0);
  });

  it("an idle PR-watch holds no slot — new work is claimed at the cap while it rides indefinitely", async () => {
    const { deps, store, state, worktree } = build();
    deps.config.limits.maxActiveWorkspaces = 1;
    // A PR sitting in review with no active resolver: it keeps its worktree but occupies no slot.
    seed(store, worktree, "K-WATCH", "reviewing", null, { prNumber: 50 });
    state.pr = { number: 50, state: "OPEN", url: "u" }; // open, nothing actionable → stays idle
    state.eligible = [ticket("K-NEW")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-NEW")).toBeDefined(); // claimed despite the watch
    expect(store.countActive("demo")).toBe(2);
    expect(store.countOccupying("demo")).toBe(1); // only the newly-claimed run; the watch holds no slot
  });


  // --- "ready to merge" notification (issue #52) — the factory still never merges ---------------
  it("reviewing + PR green (no threads, no failing, nothing pending) → notifies the operator ONCE, with the URL", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-GREEN", "reviewing", null, { prNumber: 20, lastThreadSig: "s0" });
    state.pr = { number: 20, state: "OPEN", url: "https://gh/pr/20", title: "Fix the thing", headOid: "abc123" };
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
    expect(calls.notified[0]![0]).toContain("K-GREEN ready to merge");
    expect(calls.notified[0]![1]).toContain("https://gh/pr/20");
    expect(calls.notified[0]![1]).toContain("PR #20");
    expect(calls.notified[0]![1]).toContain("Fix the thing");
    expect(calls.notified[0]![1]).not.toContain("green for"); // no invented duration — see noteGreenPr
    // Idempotent: a second tick on the same green says nothing more.
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
    expect(store.getRun(run.id)!.phase).toBe("reviewing"); // nothing merged, nothing torn down
  });

  it("reviewing + a check still pending → no notification until it concludes", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-PEND", "reviewing", null, { prNumber: 21, lastThreadSig: "s0" });
    state.pr = { number: 21, state: "OPEN", url: "u" };
    state.sig = { unresolved: 0, failing: 0, pending: 1, sig: "s0" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(0);
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" }; // checks finished green
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
  });

  it("reviewing + an unresolved review thread → no notification until the thread is resolved", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-THRD", "reviewing", null, { prNumber: 22, lastThreadSig: "s1" });
    state.pr = { number: 22, state: "OPEN", url: "u" };
    state.sig = { unresolved: 1, failing: 0, pending: 0, sig: "s1" }; // already-handled signature → no resolver wake
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(0);
  });

  it("reviewing + draft PR → never notified (it isn't up for review)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-DRFT", "reviewing", null, { prNumber: 23, lastThreadSig: "s0" });
    state.pr = { number: 23, state: "OPEN", url: "u", isDraft: true };
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(0);
  });

  it("reviewing + red → green → red → green → exactly two notifications", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-FLAP", "reviewing", null, { prNumber: 24, lastThreadSig: "sig-red" });
    state.pr = { number: 24, state: "OPEN", url: "u" };
    const red = { unresolved: 0, failing: 1, pending: 0, sig: "sig-red" };
    const green = { unresolved: 0, failing: 0, pending: 0, sig: "sig-green" };
    for (const sig of [red, green, green, red, green]) {
      state.sig = sig;
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(calls.notify).toBe(2);
  });

  it("reviewing + a new commit on a repo with NO checks → a new green, notified again", async () => {
    // The no-CI path: pending and failing stay 0 across the push, so NOTHING in the review signature
    // moves — only the head commit does. Keying the episode on the head is what makes the issue's
    // "a new commit is a new green" rule hold on a repo (like this one) that runs no checks at all.
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-PUSH", "reviewing", null, { prNumber: 25, lastThreadSig: "s0" });
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    state.pr = { number: 25, state: "OPEN", url: "u", headOid: "sha-1" };
    await reconcileRun(deps, store.getRun(run.id)!);
    await reconcileRun(deps, store.getRun(run.id)!); // same head, more ticks → still one
    expect(calls.notify).toBe(1);
    state.pr = { number: 25, state: "OPEN", url: "u", headOid: "sha-2" }; // a push
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(2);
    await reconcileRun(deps, store.getRun(run.id)!); // and it settles again at one per head
    expect(calls.notify).toBe(2);
  });

  // --- issue #114: once per head, and a conflicted PR is not green -------------------------------
  it("reviewing + the same head never notifies twice, even after a red flicker; a new green head notifies once", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-FLKR", "reviewing", null, { prNumber: 27, lastThreadSig: "sig-red" });
    state.pr = { number: 27, state: "OPEN", url: "u", headOid: "sha-1" };
    const red = { unresolved: 0, failing: 1, pending: 0, sig: "sig-red" };
    const green = { unresolved: 0, failing: 0, pending: 0, sig: "sig-green" };
    for (const sig of [green, red, green, red, green]) {
      state.sig = sig;
      await reconcileRun(deps, store.getRun(run.id)!);
      // The dashboard's prGreen still tracks green-right-now, flicker included.
      expect(store.getWatchState(run.id, "pull_request", "pr_green")?.sig ?? null).toBe(sig === green ? "sha-1" : null);
    }
    expect(calls.notify).toBe(1);
    state.pr = { number: 27, state: "OPEN", url: "u", headOid: "sha-2" }; // a push, green
    await reconcileRun(deps, store.getRun(run.id)!);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(2);
  });

  it("reviewing + a CONFLICTING PR → no notification, wakes the resolver once for that head", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-CONF", "reviewing", null, { prNumber: 28, lastThreadSig: "s0" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:p1" });
    state.paneState = "idle";
    state.pr = { number: 28, state: "OPEN", url: "u", headOid: "sha-1", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(0);
    expect(calls.agentSend).toHaveLength(1); // resolver woken to merge the base
    expect(readFileSync(join(worktree, ".memory/herdr-factory/prompt-resolver.md"), "utf8")).toContain("CONFLICTING");
    const woken = store.timeline("demo", "K-CONF").find((e) => e.type === "resolver_woken");
    expect(JSON.parse(String(woken?.detail))).toMatchObject({ baseMerge: "conflicting" });
    // Same conflicted head, resolver back to idle: not a new round.
    store.updateRun(run.id, { resolverActive: false });
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend).toHaveLength(1);
    expect(calls.notify).toBe(0);
  });

  it("reviewing + a BEHIND PR notifies normally on a non-strict base, and wakes the resolver on a strict one", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-BHND", "reviewing", null, { prNumber: 29, lastThreadSig: "s0" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:p1" });
    state.paneState = "idle";
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    state.pr = { number: 29, state: "OPEN", url: "u", headOid: "sha-1", mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", strictBase: false };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
    expect(calls.agentSend).toHaveLength(0);

    const { deps: d2, store: s2, state: st2, worktree: w2, calls: c2 } = build();
    const strict = seed(s2, w2, "K-STRC", "reviewing", null, { prNumber: 30, lastThreadSig: "s0" });
    s2.upsertRunStep(strict.id, "fix", { paneId: "w1:p1" });
    st2.paneState = "idle";
    st2.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    st2.pr = { number: 30, state: "OPEN", url: "u", headOid: "sha-1", mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", strictBase: true };
    await reconcileRun(d2, s2.getRun(strict.id)!);
    expect(c2.notify).toBe(0);
    expect(c2.agentSend).toHaveLength(1);
  });

  it("reviewing + a pr_green row written before toldHead existed (mark only in sig) → the same head never re-notifies", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-LGCY", "reviewing", null, { prNumber: 32, lastThreadSig: "sig-red" });
    store.upsertWatchState(run.id, "pull_request", "pr_green", { sig: "sha-1" }); // the pre-#114 write: meta stays '{}'
    state.pr = { number: 32, state: "OPEN", url: "u", headOid: "sha-1" };
    const green = { unresolved: 0, failing: 0, pending: 0, sig: "sig-green" };
    state.sig = green;
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify, "already told about sha-1 before the upgrade").toBe(0);
    for (const sig of [{ unresolved: 0, failing: 1, pending: 0, sig: "sig-red" }, green]) {
      state.sig = sig;
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    expect(calls.notify, "…and a red flicker does not lose the mark").toBe(0);
    state.pr = { ...state.pr, headOid: "sha-2" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify, "a new green head is still news").toBe(1);
  });

  it("reviewing + mergeability still UNKNOWN → waits, then notifies once GitHub settles it", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-UNKN", "reviewing", null, { prNumber: 31, lastThreadSig: "s0" });
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    state.pr = { number: 31, state: "OPEN", url: "u", headOid: "sha-1", mergeable: "UNKNOWN" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(0);
    state.pr = { ...state.pr, mergeable: "MERGEABLE" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
  });

  // --- issue #78: the pr step is still running --------------------------------------------------
  it("reviewing + green PR but the pr step has no step_done → no notify, no pr_green, prGreen false", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-BUSY", "reviewing", null, { prNumber: 26, lastThreadSig: "s0" });
    // enterReviewing cleared run.step while the pr agent kept polling CI: its row is live, not done.
    store.upsertRunStep(run.id, "pr", { paneId: "w1:ppr" });
    state.pr = { number: 26, state: "OPEN", url: "u", headOid: "sha-1" };
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(0);
    expect(store.timeline("demo", "K-BUSY").some((e) => e.type === "pr_green")).toBe(false);
    expect(store.getWatchState(run.id, "pull_request", "pr_green")?.sig ?? null).toBeNull(); // app.ts prGreen

    // The pr agent finishes: step-done lands even though run.step is null in the PR watch...
    const res = await applySignal(deps, "step-done", { key: "K-BUSY", step: "pr", source: "jira" });
    expect(res.ok).toBe(true);
    expect(store.getRunStep(run.id, "pr")?.done).toBe(true);
    expect(calls.notify, "the signal itself does no unbatched GitHub work — the next pass does").toBe(0);
    // ...and on the next pass the same green head is news, once.
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
    expect(store.getWatchState(run.id, "pull_request", "pr_green")?.sig).toBe("sha-1");
  });

  it("reviewing + still working → does not pile on", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-11", "reviewing", null, { lastThreadSig: "old" });
    state.pr = { number: 11, state: "OPEN", url: "u" };
    state.sig = { unresolved: 1, failing: 0, pending: 0, sig: "newsig" };
    state.paneState = "working";
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.agentSend.length).toBe(0);
  });
});

describe("custom belt (agent-driven, no PR)", () => {
  // Swap the run onto a custom belt with steps research → propose, no PR watch.
  function customBelt(deps: Deps): BeltRuntime {
    const belt: BeltRuntime = {
      name: "gen",
      beltType: "custom",
      source: "jira",
      priority: 1,
      active: true,
      steps: [
        stepCfg("research", { budgetSeconds: 3600, heartbeat: false, opensPr: false }),
        stepCfg("propose", { budgetSeconds: 3600, heartbeat: false, opensPr: false }),
      ],
      watchPr: false,
    };
    deps.belts = [belt];
    deps.resolveBelt = (n) => (n === "gen" ? belt : undefined);
    return belt;
  }

  it("first step done → advances to the next custom step", async () => {
    const { deps, store, worktree, calls } = build();
    customBelt(deps);
    const run = seed(store, worktree, "G-1", "running", "research", {}, "gen");
    store.markStepDone(run.id, "research");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("propose");
    expect(calls.agentSend.length).toBe(1); // propose agent dispatched
  });

  it("last step done → teardown completed (no PR, no reviewing), writes terminal 'done'", async () => {
    const { deps, store, state, worktree, calls } = build();
    customBelt(deps);
    const run = seed(store, worktree, "G-2", "running", "propose", {}, "gen");
    store.markStepDone(run.id, "propose");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("completed");
    expect(state.pr).toBeNull(); // engine never queried GitHub for a custom belt
    expect(calls.transitions).toContainEqual(["G-2", "done"]); // custom-belt terminal write-back
    expect(calls.worktreeRemove).toContain("w1");
    expect(calls.branchDelete).toContain("fix/G-2-s");
  });

  // Issue #6: a dedicated-pane belt whose last step's spawn exceeded herdr's readiness wait. The
  // spawn threw, so pane_id/dispatched_at were never recorded — but the agent WAS up, did the work
  // and signalled step-done. The undispatched-pass spawn branch used to fire before the advance,
  // so every pass started another agent on the finished step and the run could never complete.
  it("a last step that signalled done after its spawn failed to record completes the run — with no second spawn", async () => {
    const { deps, store, worktree, calls } = build();
    customBelt(deps);
    const run = seed(store, worktree, "G-TIMEOUT", "running", "propose", {}, "gen");
    // The spawn threw: no pane recorded, the pass never marked dispatched.
    store.upsertRunStep(run.id, "propose", { paneId: null, dispatchedAt: null });
    store.markStepDone(run.id, "propose");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("completed"); // not "abandoned"
    expect(calls.agentStart).toBe(0); // no duplicate agent for a step that already finished
    // ...and the ENDED run is never dispatched again, however stale the caller's snapshot is.
    await reconcileRun(deps, run);
    expect(calls.agentStart).toBe(0);
    expect(store.getRun(run.id)!.outcome).toBe("completed");
  });

  it("an intermediate step in the same shape still advances (and dispatches the next step once)", async () => {
    const { deps, store, worktree, calls } = build();
    customBelt(deps);
    const run = seed(store, worktree, "G-TIMEOUT2", "running", "research", {}, "gen");
    store.upsertRunStep(run.id, "research", { paneId: null, dispatchedAt: null });
    store.markStepDone(run.id, "research");
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("propose");
    expect(calls.agentSend.length).toBe(1); // the NEXT step dispatched once, not a second `research` agent
  });

  it("attention on a custom belt is never PR-polled (watchPr gate)", async () => {
    const { deps, store, state, worktree, calls } = build();
    customBelt(deps);
    // Even with a prNumber + a merged PR, a non-PR belt stays parked — attention re-check is
    // work_to_pull_request only.
    const run = seed(store, worktree, "G-A", "attention", null, { prNumber: 24 }, "gen");
    state.pr = { number: 24, state: "MERGED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.worktreeRemove).not.toContain("w1");
  });
});

describe("belt routing (match predicates, first match wins)", () => {
  it("claims each item with the first belt (by priority) whose match accepts it", async () => {
    const { deps, store, state } = build();
    const bugs: BeltRuntime = { name: "bugs", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, steps: prSteps(), watchPr: true, match: (ctx) => ctx.item.type === "Bug" };
    const rest: BeltRuntime = { name: "rest", beltType: "work_to_pull_request", source: "jira", priority: 2, active: true, steps: prSteps(), watchPr: true };
    deps.belts = [bugs, rest];
    deps.resolveBelt = (n) => deps.belts.find((b) => b.name === n);
    state.eligible = [ticket("K-bug", "Bug"), ticket("K-task", "Task")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-bug")?.belt).toBe("bugs"); // matched the bug belt
    expect(store.activeRunForTicket("demo", "jira", "K-task")?.belt).toBe("rest"); // fell through to the catch-all
  });

  it("caches only match-accepted items in lastEligible — the board never shows the other repo's work", async () => {
    // Two repo configs poll one query and differ only in their belts' `match`; an unfiltered
    // snapshot made each repo's /eligible list the other's tickets (issue #81).
    const { deps, state, sources } = build();
    const appBelt: BeltRuntime = { name: "app", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, steps: prSteps(), watchPr: true, match: ({ item }) => item.summary.includes("[app]") };
    deps.belts = [appBelt];
    deps.resolveBelt = (n) => (n === "app" ? appBelt : undefined);
    state.eligible = [{ ...ticket("K-1", "Task"), summary: "[FE] - [app] hide text" }, { ...ticket("K-2", "Task"), summary: "[FE] - [widget] hide text" }];
    await reconcileRepo(deps);
    expect(sources[0]!.lastEligible.get("")!.items.map((i) => i.key)).toEqual(["K-1"]);
  });

  it("a throwing match drops the item from the cached snapshot too", async () => {
    const { deps, state, sources } = build();
    const boom: BeltRuntime = { name: "boom", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, steps: prSteps(), watchPr: true, match: ({ item }) => { if (item.key === "K-2") throw new Error("nope"); return true; } };
    deps.belts = [boom];
    deps.resolveBelt = (n) => (n === "boom" ? boom : undefined);
    state.eligible = [ticket("K-1", "Task"), ticket("K-2", "Task")];
    await reconcileRepo(deps);
    expect(sources[0]!.lastEligible.get("")!.items.map((i) => i.key)).toEqual(["K-1"]);
  });

  it("a belt without a match still caches everything the source returned", async () => {
    const { deps, state, sources } = build();
    state.eligible = [ticket("K-1", "Task"), ticket("K-2", "Task")];
    await reconcileRepo(deps);
    expect(sources[0]!.lastEligible.get("")!.items.map((i) => i.key)).toEqual(["K-1", "K-2"]);
  });

  it("an item no belt matches is left unclaimed", async () => {
    const { deps, store, state } = build();
    const onlyBugs: BeltRuntime = { name: "bugs", beltType: "work_to_pull_request", source: "jira", priority: 1, active: true, steps: prSteps(), watchPr: true, match: (ctx) => ctx.item.type === "Bug" };
    deps.belts = [onlyBugs];
    deps.resolveBelt = (n) => (n === "bugs" ? onlyBugs : undefined);
    state.eligible = [ticket("K-task", "Task")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-task")).toBeUndefined();
    expect(store.countActive("demo")).toBe(0);
  });

  it("an inactive belt claims no new work; the next active belt still does", async () => {
    const { deps, store, state } = build();
    const paused: BeltRuntime = { name: "paused", beltType: "work_to_pull_request", source: "jira", priority: 1, active: false, steps: prSteps(), watchPr: true };
    const live: BeltRuntime = { name: "live", beltType: "work_to_pull_request", source: "jira", priority: 2, active: true, steps: prSteps(), watchPr: true };
    deps.belts = [paused, live];
    deps.resolveBelt = (n) => deps.belts.find((b) => b.name === n);
    state.eligible = [ticket("K-1", "Task")];
    await reconcileRepo(deps);
    // The higher-priority belt is inactive so it takes nothing; the item falls through to the active one.
    expect(store.activeRunForTicket("demo", "jira", "K-1")?.belt).toBe("live");
  });

  it("all belts inactive ⇒ nothing is claimed", async () => {
    const { deps, store, state } = build();
    const paused: BeltRuntime = { name: "paused", beltType: "work_to_pull_request", source: "jira", priority: 1, active: false, steps: prSteps(), watchPr: true };
    deps.belts = [paused];
    deps.resolveBelt = (n) => (n === "paused" ? paused : undefined);
    state.eligible = [ticket("K-1", "Task")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-1")).toBeUndefined();
    expect(store.countActive("demo")).toBe(0);
  });
});

// machine.yml: a host-local cap across EVERY repo in the shared DB + a free-memory gate.
describe("machine gate (Phase B)", () => {
  /** Two repos ("demo" + "other") ticking against ONE store, as one serve does. */
  function twoRepos() {
    const a = build();
    const b = build();
    b.deps.store = a.store;
    b.deps.config = { ...b.deps.config, repoName: "other" };
    return { a, b, store: a.store };
  }
  const logsOf = (deps: Deps): string[] => {
    const lines: string[] = [];
    deps.log = (_lvl, m) => void lines.push(m);
    return lines;
  };

  it("absent machine.yml is the old path: no machine count, no memory read", async () => {
    const { deps, store, state } = build();
    let reads = 0;
    deps.availableMemoryMb = () => (reads++, 0);
    state.eligible = [ticket("K-1"), ticket("K-2")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(2);
    expect(reads).toBe(0);
    expect(store.acquireLock("machine:claim", "probe", 60)).toBe(true); // never taken/left behind
  });

  it("caps occupying runs across repos, logging the capacity state once", async () => {
    const { a, b, store } = twoRepos();
    a.deps.machine = b.deps.machine = { maxActiveWorkspaces: 2 };
    a.state.eligible = [ticket("A-1"), ticket("A-2"), ticket("A-3")];
    b.state.eligible = [ticket("B-1")];
    const logs = logsOf(b.deps);
    await reconcileRepo(a.deps);
    expect(store.countActive("demo")).toBe(2); // repo cap 3, machine headroom 2
    await reconcileRepo(b.deps);
    await reconcileRepo(b.deps);
    expect(store.countActive("other")).toBe(0);
    expect(logs.filter((l) => l === "machine at capacity (2/2)")).toHaveLength(1);
  });

  it("parked runs hold no machine slot", async () => {
    const { a, b, store } = twoRepos();
    a.deps.machine = b.deps.machine = { maxActiveWorkspaces: 1 };
    seed(store, a.worktree, "A-1", "attention", "fix");
    seed(store, a.worktree, "A-2", "waiting_for_human", "fix");
    b.state.eligible = [ticket("B-1")];
    await reconcileRepo(b.deps);
    expect(store.countActive("other")).toBe(1);
  });

  it("overlapping ticks of two repos never exceed the machine cap (the count+claim race)", async () => {
    const { a, b, store } = twoRepos();
    a.deps.machine = b.deps.machine = { maxActiveWorkspaces: 1 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Both repos stall INSIDE Phase B (between the machine count and createRun) — the window where,
    // unserialized, each would read 0/1 and claim.
    for (const { sources } of [a, b]) {
      const client = sources[0]!.client;
      const list = client.listEligible.bind(client);
      sources[0]!.client = { ...client, listEligible: async (l) => { await gate; return list(l); } };
    }
    a.state.eligible = [ticket("A-1")];
    b.state.eligible = [ticket("B-1")];
    const ticks = [reconcileRepo(a.deps), reconcileRepo(b.deps)];
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all(ticks);
    expect(store.countOccupyingAll()).toBe(1);
    await Promise.all([reconcileRepo(a.deps), reconcileRepo(b.deps)]); // and still 1 on the next ticks
    expect(store.countOccupyingAll()).toBe(1);
  });

  it("low memory skips claims but leaves running work alone; claims resume above the floor", async () => {
    const { deps, store, state, worktree } = build();
    let free = 100;
    deps.machine = { minFreeMemoryMb: 500 };
    deps.availableMemoryMb = () => free;
    const logs = logsOf(deps);
    const running = seed(store, worktree, "K-0", "running", "fix");
    state.eligible = [ticket("K-1")];
    await reconcileRepo(deps);
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-1")).toBeUndefined();
    expect(store.getRun(running.id)!.endedAt).toBeNull();
    expect(store.getRun(running.id)!.phase).toBe("running");
    expect(logs.filter((l) => l === "low memory: 100 MB < 500 MB — not claiming")).toHaveLength(1);
    free = 1000;
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-1")).toBeTruthy();
    expect(logs).toContain("machine admission resumed — claiming again");
  });

  it("N repos ticking in lockstep: every repo reaches claimNewWork in a single tick (#72)", async () => {
    // The serve loop's shape: every repo starts Phase B in the same instant, in the same order,
    // every tick. Under the old try-lock the losers skipped their whole claim section and hit the
    // same mid-hold instant again next tick — one repo starved for hours. The bounded wait makes
    // the order irrelevant: each waits out the holder and claims in the SAME pass.
    const first = build();
    const store = first.store;
    const repos = [first, ...[1, 2, 3, 4].map(() => build())].map((r, i) => {
      r.deps.store = store;
      r.deps.config = { ...r.deps.config, repoName: `repo${i}` };
      r.deps.machine = { maxActiveWorkspaces: 5 };
      // The wait is a REAL-time poll; the shared fake sleep is a no-op, which would spend all 20
      // tries inside one holder's claim. Shorten it instead of removing it.
      r.deps.sleep = (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 5)));
      r.state.eligible = [ticket(`K${i}-1`)];
      return r;
    });
    await Promise.all(repos.map((r) => reconcileRepo(r.deps)));
    for (let i = 0; i < repos.length; i++) {
      expect(store.countActive(`repo${i}`)).toBe(1);
      expect(store.claimDeferrals(`repo${i}`)).toBe(0);
    }
  });

  it("a holder that outlives the wait defers, and status/explain can see how many ticks", async () => {
    const { deps, store, state } = build();
    deps.machine = { maxActiveWorkspaces: 2 };
    state.eligible = [ticket("K-1")];
    const logs = logsOf(deps);
    store.acquireLock("machine:claim", "another-repo", 600); // never released within the wait
    await reconcileRepo(deps);
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(0);
    expect(store.claimDeferrals("demo")).toBe(2);
    expect(logs).toContain("machine claim lock held (another repo is claiming) — claims deferred 1 tick (machine claim lock)");
    expect(logs).toContain("machine claim lock held (another repo is claiming) — claims deferred 2 ticks (machine claim lock)");
    store.releaseLock("machine:claim", "another-repo");
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(1);
    expect(store.claimDeferrals("demo")).toBe(0); // reset the moment it claims again
  });

  // The count is CONSECUTIVE and present-tense: `status`/`explain` render it as "this repo is
  // losing the race right now", so a gate that returns before the lock is ever taken has to clear
  // it. Left standing, it contradicts the gate line printed beside it — and with the cap removed
  // from machine.yml there is no path left that could ever clear it again.
  const deferTwice = async (deps: Deps, store: Store) => {
    store.acquireLock("machine:claim", "another-repo", 600);
    await reconcileRepo(deps);
    await reconcileRepo(deps);
    expect(store.claimDeferrals("demo")).toBe(2);
    store.releaseLock("machine:claim", "another-repo");
  };

  it("the memory gate clears the deferral count — it is not the lock that is holding claims up", async () => {
    const { deps, store, state } = build();
    deps.machine = { maxActiveWorkspaces: 2, minFreeMemoryMb: 500 };
    deps.availableMemoryMb = () => 1000;
    state.eligible = [ticket("K-1")];
    await deferTwice(deps, store);
    deps.availableMemoryMb = () => 100; // now the pass returns at the memory gate, before the lock
    await reconcileRepo(deps);
    expect(store.claimDeferrals("demo")).toBe(0);
    expect(store.countActive("demo")).toBe(0); // and it really did stop at the gate
  });

  it("removing the machine cap clears the deferral count (nothing else ever could)", async () => {
    const { deps, store, state } = build();
    deps.machine = { maxActiveWorkspaces: 2 };
    state.eligible = [ticket("K-1")];
    await deferTwice(deps, store);
    deps.machine = {}; // machine.yml's cap removed: Phase B never takes the lock again
    await reconcileRepo(deps);
    expect(store.claimDeferrals("demo")).toBe(0);
    expect(store.countActive("demo")).toBe(1); // claiming is back to the lock-free path
  });

  it("a manual claim respects the machine cap", async () => {
    const { a, b, store } = twoRepos();
    a.deps.machine = b.deps.machine = { maxActiveWorkspaces: 1 };
    seed(store, a.worktree, "A-1", "running", "fix");
    await expect(claimTicket(b.deps, "ship", "B-1")).rejects.toThrow(/machine at capacity \(1\/1\)/);
    expect(store.countActive("other")).toBe(0);
    b.deps.machine = { maxActiveWorkspaces: 2 };
    await claimTicket(b.deps, "ship", "B-1");
    expect(store.countActive("other")).toBe(1);
  });
});

describe("multi-belt claim (Phase B)", () => {
  it("drains the higher-priority belt first under a shared cap", async () => {
    const { deps, store, state } = build({ multi: true });
    deps.config.limits.maxActiveWorkspaces = 1;
    state.eligible = [ticket("J-1")]; // ship belt (jira), priority 1
    state.eligible2 = [ticket("M-1")]; // lmship belt (lm), priority 2
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(1);
    expect(store.activeRunForTicket("demo", "jira", "J-1")).toBeTruthy(); // jira drained first
    expect(store.activeRunForTicket("demo", "lm", "M-1")).toBeUndefined(); // no slot left for lm
  });

  it("the cap is global across belts (not per belt)", async () => {
    const { deps, store, state } = build({ multi: true });
    deps.config.limits.maxActiveWorkspaces = 2;
    state.eligible = [ticket("J-1"), ticket("J-2")];
    state.eligible2 = [ticket("M-1")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(2); // both jira slots used; lm gets none
    expect(store.activeRunForTicket("demo", "lm", "M-1")).toBeUndefined();
  });

  it("caps claims per source at its max_active_workspaces, leaving global slots for others", async () => {
    const { deps, store, state, sources } = build({ multi: true });
    deps.config.limits.maxActiveWorkspaces = 5; // ample global headroom
    sources.find((s) => s.name === "jira")!.maxActiveWorkspaces = 2; // per-source cap bites first
    state.eligible = [ticket("J-1"), ticket("J-2"), ticket("J-3"), ticket("J-4")];
    state.eligible2 = [ticket("M-1")];
    await reconcileRepo(deps);
    // jira stops at 2 even though 3 global slots remain; lm still gets its claim.
    expect(store.countOccupyingBySource("demo").get("jira")).toBe(2);
    expect(store.activeRunForTicket("demo", "jira", "J-3")).toBeUndefined();
    expect(store.activeRunForTicket("demo", "lm", "M-1")).toBeTruthy();
    expect(store.countActive("demo")).toBe(3);
  });

  it("the per-source cap counts occupancy already in flight from a prior tick", async () => {
    const { deps, store, state, sources, worktree } = build();
    deps.config.limits.maxActiveWorkspaces = 5;
    sources.find((s) => s.name === "jira")!.maxActiveWorkspaces = 2;
    seed(store, worktree, "J-OLD", "running", "fix"); // one jira run already occupying
    state.eligible = [ticket("J-1"), ticket("J-2")];
    await reconcileRepo(deps);
    expect(store.countOccupyingBySource("demo").get("jira")).toBe(2); // 1 old + only 1 new
    expect(store.activeRunForTicket("demo", "jira", "J-2")).toBeUndefined();
  });

  it("the same key in two sources is claimed as two distinct runs", async () => {
    const { deps, store, state } = build({ multi: true });
    deps.config.limits.maxActiveWorkspaces = 5;
    state.eligible = [ticket("DUP")];
    state.eligible2 = [ticket("DUP")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(2);
    expect(store.activeRunForTicket("demo", "jira", "DUP")?.belt).toBe("ship");
    expect(store.activeRunForTicket("demo", "lm", "DUP")?.belt).toBe("lmship");
  });
});

describe("missing config resolution", () => {
  it("escalates an active run to attention when its source is gone from config", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "GONE-1", "running", "fix");
    deps.resolveSource = () => undefined; // simulate the source removed from config
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("escalates an active run to attention when its belt is gone from config", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "GONE-B", "running", "fix");
    deps.resolveBelt = () => undefined; // simulate the belt removed/renamed in config
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
  });

  it("a tearing_down run with a gone belt+source still completes local cleanup", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "GONE-2", "tearing_down", null);
    deps.resolveSource = () => undefined;
    deps.resolveBelt = () => undefined;
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(calls.worktreeRemove).toContain("w1"); // worktree still removed
    expect(calls.branchDelete).toContain("fix/GONE-2-s"); // branch still deleted
  });
});

describe("applyPendingFocus — focus follows the active step", () => {
  it("applies the focus shift when the user is viewing this worktree on a belt pane", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-1", "running", "review", { focusPending: true });
    state.focusedPane = { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual(["w1:p1"]); // active step (review) pane brought to front
    expect(store.getRun(run.id)!.focusPending).toBe(false); // and the flag is cleared
  });

  it("defers (keeps pending, no focus) when the user is viewing a different worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-2", "running", "review", { focusPending: true });
    state.focusedPane = { paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]); // never steal focus from another worktree
    expect(store.getRun(run.id)!.focusPending).toBe(true); // stored for later
  });

  it("defers when the user is on a non-belt pane in this worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-3", "running", "review", { focusPending: true });
    state.focusedPane = { paneId: "w1:p9", workspaceId: "w1", tabId: "w1:t9", label: "editor" };
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]); // don't yank the user off an editor/scratch pane
    expect(store.getRun(run.id)!.focusPending).toBe(true);
  });

  it("defers when herdr is not frontmost (no focused pane)", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-4", "running", "review", { focusPending: true });
    state.focusedPane = null;
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]);
    expect(store.getRun(run.id)!.focusPending).toBe(true);
  });

  it("applies a deferred focus on a later pass once the user navigates to the worktree", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "F-5", "running", "review", { focusPending: true });
    state.focusedPane = { paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", label: "agent" };
    await applyPendingFocus(deps, store.getRun(run.id)!); // user elsewhere → deferred
    expect(calls.agentFocus).toEqual([]);
    expect(store.getRun(run.id)!.focusPending).toBe(true);
    state.focusedPane = { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", label: "agent" }; // navigates back
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual(["w1:p1"]); // now applied
    expect(store.getRun(run.id)!.focusPending).toBe(false);
  });

  it("does nothing when no focus is pending (never re-yanks the user)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "F-6", "running", "review"); // focusPending defaults to false
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]);
  });

  it("clears a stale pending flag in a phase with no active step (reviewing)", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "F-7", "reviewing", null, { focusPending: true });
    await applyPendingFocus(deps, store.getRun(run.id)!);
    expect(calls.agentFocus).toEqual([]);
    expect(store.getRun(run.id)!.focusPending).toBe(false);
  });
});

describe("transition outbox — source write-backs retried until delivered", () => {
  it("claim survives a failed in-development write-back; the outbox delivers it on a later tick", async () => {
    const { deps, store, state, calls, setNow } = build();
    state.eligible = [ticket("K-T1")];
    state.failTransitions = true;
    await reconcileRepo(deps);
    const run = store.activeRunForTicket("demo", "jira", "K-T1")!;
    expect(run.phase).toBe("running"); // a flaky source never blocks the pipeline
    expect(calls.transitions).toEqual([]); // nothing delivered yet
    expect(store.pendingTransitionForKey("demo", "jira", "K-T1")).toBe(true);

    state.failTransitions = false;
    setNow(1000 + 61); // past the first backoff (60s)
    await reconcileRepo(deps);
    expect(calls.transitions).toContainEqual(["K-T1", "in_development"]);
    expect(store.pendingTransitionForKey("demo", "jira", "K-T1")).toBe(false);
  });

  it("failed attempts wait out the flat 30s interval (not due again immediately)", async () => {
    const { deps, store, state, calls, setNow } = build();
    state.eligible = [ticket("K-T2")];
    state.failTransitions = true;
    await reconcileRepo(deps); // attempt 1 fails → next due at +30s
    state.failTransitions = false;
    setNow(1000 + 15);
    await flushTransitionOutbox(deps); // not due yet
    expect(calls.transitions).toEqual([]);
    setNow(1000 + 31);
    await flushTransitionOutbox(deps); // due → delivered
    expect(calls.transitions).toContainEqual(["K-T2", "in_development"]);
  });

  it("an item whose write-back is still pending is NOT re-claimed (no duplicate work)", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-T3", "reviewing", null, { prNumber: 7 });
    state.pr = { number: 7, state: "MERGED", url: "u" };
    state.failTransitions = true;
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("done"); // teardown never blocks on the write-back
    expect(store.pendingTransitionForKey("demo", "jira", "K-T3")).toBe(true);

    // The source still lists it (our write-back never landed) — it must NOT be claimed again.
    state.eligible = [ticket("K-T3")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-T3")).toBeUndefined();

    // Once the write-back delivers, the guard lifts.
    state.failTransitions = false;
    state.eligible = [];
    setNow(1000 + 61);
    await reconcileRepo(deps);
    expect(calls.transitions).toContainEqual(["K-T3", "merged"]);
    expect(store.pendingTransitionForKey("demo", "jira", "K-T3")).toBe(false);
  });

  it("per-run delivery is strictly in-order: a later intent waits behind an undelivered earlier one", async () => {
    const { deps, store, state, calls } = build();
    const run = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-T4", branch: "b" });
    state.failTransitionStates.add("in_development");
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-T4", toState: "in_development" });
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-T4", toState: "in_review" });

    await flushTransitionOutbox(deps);
    // in_development failed → in_review must NOT have been attempted (it would walk Jira backward
    // when the retried in_development eventually lands).
    expect(calls.transitions).toEqual([]);

    state.failTransitionStates.clear();
    // in_development is now backed off; force both due by flushing at a later clock.
    const intents = store.dueTransitions("demo", 10);
    expect(intents.length).toBe(1); // only in_review is technically "due"; it stays blocked per-run
    await flushTransitionOutbox(deps);
    expect(calls.transitions).toEqual([]); // still blocked behind the backed-off in_development
  });

  it("delivers a run's intents in order once all are due", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-T5", branch: "b" });
    state.failTransitions = true;
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-T5", toState: "in_development" });
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-T5", toState: "in_review" });
    await flushTransitionOutbox(deps); // both attempted? no — first fails, second blocked
    state.failTransitions = false;
    setNow(1000 + 61);
    await flushTransitionOutbox(deps);
    expect(calls.transitions).toEqual([
      ["K-T5", "in_development"],
      ["K-T5", "in_review"],
    ]);
  });
});

describe("stale write-backs — two-phase policy (lock-free stamp, run-locked reaction)", () => {
  it("stale on the claim (in_development) aborts the run on the next pass — one notification total", async () => {
    const { deps, store, state, calls } = build();
    state.eligible = [ticket("K-S1")];
    // The item vanishes between listing and the claim write-back; teardown's own `aborted`
    // write-back will find it gone too — that second stale must NOT double-notify.
    state.staleTransitionStates = new Set(["in_development", "aborted"]);
    await reconcileRepo(deps); // claims; the immediate delivery stamps stale (run already running)
    const run = store.activeRunForTicket("demo", "jira", "K-S1")!;
    expect(run.phase).toBe("running"); // stamped, not yet consumed (the claim pass already advanced)
    expect(store.unhandledStaleIntentForRun(run.id)).toBeDefined();

    state.eligible = [];
    await reconcileRepo(deps); // Phase A consumes the flag under the run lock
    const ended = store.getRun(run.id)!;
    expect(ended.endedAt).not.toBeNull();
    expect(ended.outcome).toBe("abandoned");
    expect(calls.notify).toBe(1); // the abort notice; the aborted-intent stale lands in the ended-run path
    expect(store.unhandledStaleIntentForRun(run.id)).toBeUndefined(); // nothing left to double-fire
    expect(calls.worktreeRemove).toEqual(["w1"]); // real teardown, not a leak
  });

  it("stale mid-flight (in_review) parks for a human — work (a PR) may exist; never posts to the gone item", async () => {
    const { deps, store, state, calls, worktree } = build();
    const run = seed(store, worktree, "K-S2", "running", "pr");
    state.staleTransitionStates = new Set(["in_review"]);
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-S2", toState: "in_review" });
    await flushTransitionOutbox(deps); // lock-free: stamps stale, mutates nothing on the run
    expect(store.getRun(run.id)!.phase).toBe("running");

    await reconcileRun(deps, store.getRun(run.id)!); // run-locked reaction
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention");
    expect(got.attentionReason).toContain("gone");
    expect(calls.notify).toBe(1);
    expect(calls.postNotes).toEqual([]); // skipSourceNote: the item the note would go to is gone
  });

  it("a LATE-delivering claim intent going stale on a run that reached reviewing PARKS it — never tears down an open PR", async () => {
    const { deps, store, state, calls, worktree } = build();
    // The in_development write-back threw at claim time and backed off; meanwhile the run
    // advanced all the way to reviewing with an open PR. Then the issue was deleted.
    const run = seed(store, worktree, "K-S4", "reviewing", null, { prNumber: 42 });
    state.staleTransitionStates = new Set(["in_development"]);
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-S4", toState: "in_development" });
    await flushTransitionOutbox(deps);
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention"); // parked — the abort branch keys on run PROGRESS, not the intent
    expect(got.endedAt).toBeNull();
    expect(calls.worktreeRemove).toEqual([]); // the worktree (and its PR's branch) survives
  });

  it("stale for an already-ended run is consumed silently at delivery time", async () => {
    const { deps, store, state, calls, worktree } = build();
    const run = seed(store, worktree, "K-S3", "running", "pr");
    store.endRun(run.id, "merged");
    state.staleTransitionStates = new Set(["merged"]);
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-S3", toState: "merged" });
    await flushTransitionOutbox(deps);
    expect(store.unhandledStaleIntentForRun(run.id)).toBeUndefined(); // handled at delivery
    expect(store.pendingTransitionForKey("demo", "jira", "K-S3")).toBe(false); // outbox stops retrying
    expect(calls.notify).toBe(0);
    expect(store.getRun(run.id)!.phase).toBe("done"); // never flip an ended run's phase
  });
});

describe("human-loop resilience — poll errors back off; a gone item escalates", () => {
  it("a comment from a non-reply author is recorded as human_reply_ignored exactly once across polls (issue #123)", async () => {
    const { deps, store, worktree, setNow, sources } = build();
    const run = seed(store, worktree, "K-H0", "running", "fix");
    const asked = await requestHumanInput(deps, run, "fix", "Which flag wins?");
    // The source reports the same skipped QA comment on EVERY poll (it re-reads the thread).
    sources[0]!.client.pollHumanReply = async (input: HumanPollInput) => {
      input.onIgnored?.({ externalId: "qa-1", author: "QA Bot" });
      return null;
    };
    for (let i = 0; i < 3; i++) {
      await reconcileRun(deps, store.getRun(run.id)!);
      setNow(store.getHumanQuestion(asked.questionId)!.nextPollAt + 1);
    }
    expect(store.getHumanQuestion(asked.questionId)!.pollAttempts).toBeGreaterThanOrEqual(3);
    const ignored = store.timeline("demo", "K-H0").filter((e) => e.type === "human_reply_ignored");
    expect(ignored).toHaveLength(1);
    expect(JSON.parse(ignored[0]!.detail!)).toMatchObject({ questionId: asked.questionId, externalId: "qa-1", author: "QA Bot" });
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    expect(runObligations(deps, store.getRun(run.id)!).intents.humanQuestion?.ignoredComments).toBe(1);
  });

  it("a generic pollHumanReply throw is a backoff'd poll error, not a run error (and recovery works)", async () => {
    const { deps, store, state, worktree, setNow } = build();
    const run = seed(store, worktree, "K-H1", "running", "fix");
    const asked = await requestHumanInput(deps, run, "fix", "Which flag wins?");

    state.humanPollError = new Error("HTTP 429: rate limited");
    await reconcileRun(deps, store.getRun(run.id)!); // must not bubble to the error path
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    expect(store.getHumanQuestion(asked.questionId)!.pollErrors).toBe(1);
    const backedOffTo = store.getHumanQuestion(asked.questionId)!.nextPollAt;
    expect(backedOffTo).toBeGreaterThan(1000); // backed off like a miss

    // Recovery: the source heals and a real reply lands.
    state.humanPollError = null;
    state.humanReply = { body: "Use the new flag.", externalId: "a-1", author: "PM" };
    setNow(backedOffTo + 1);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getHumanQuestion(asked.questionId)!.pollErrors).toBe(0); // reset by the successful poll
  });

  it("a StaleItemError from pollHumanReply escalates immediately — the reply can never arrive", async () => {
    const { deps, store, state, calls, worktree } = build();
    const run = seed(store, worktree, "K-H2", "running", "fix");
    await requestHumanInput(deps, run, "fix", "Which flag wins?");
    state.humanPollError = new StaleItemError("issue deleted");
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention");
    expect(got.attentionReason).toContain("gone");
    expect(calls.postNotes).toEqual([]); // no note to a deleted item
  });

  it("a StaleItemError from the askHuman RE-POST path escalates too (the question can never be posted)", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-H5", "running", "fix");
    state.humanAskError = new Error("jira 502 (fake)"); // initial post fails transiently → question recorded, unposted
    const asked = await requestHumanInput(deps, run, "fix", "Which flag wins?");
    expect(asked.posted).toBe(false);
    state.humanAskError = new StaleItemError("issue deleted"); // by the re-post tick, the item is gone
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
  });

  it("10 consecutive poll ERRORS escalate (a failing source must not poll invisibly forever)", async () => {
    const { deps, store, state, worktree, setNow } = build();
    const run = seed(store, worktree, "K-H3", "running", "fix");
    const asked = await requestHumanInput(deps, run, "fix", "Which flag wins?");
    state.humanPollError = new Error("HTTP 429: rate limited");
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      now += 31; // always past the flat 30s interval
      setNow(now);
      await reconcileRun(deps, store.getRun(run.id)!);
    }
    const got = store.getRun(run.id)!;
    expect(store.getHumanQuestion(asked.questionId)!.pollErrors).toBe(10);
    expect(got.phase).toBe("attention");
    expect(got.attentionReason).toContain("failed 10 times");
  });

  it("resume of a run parked out of the human loop returns it to waiting_for_human with a fresh poll window", async () => {
    const { deps, store, state, worktree, setNow } = build();
    const run = seed(store, worktree, "K-H4", "running", "fix");
    const asked = await requestHumanInput(deps, run, "fix", "Which flag wins?");
    state.humanPollError = new StaleItemError("transient-looking outage"); // parks it
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");

    const res = await resumeRun(deps, store.getRun(run.id)!);
    // The question is still pending — resuming to `running` would orphan it (only
    // waiting_for_human polls for replies) and silently drop whatever the human answered.
    expect(res).toMatchObject({ ok: true, phase: "waiting_for_human" });
    expect(store.getHumanQuestion(asked.questionId)!.pollErrors).toBe(0); // fresh escalation window
    // Due immediately: the ledger-backed clock writes "now" rather than the legacy literal 0 —
    // the contract is that the next pass polls without waiting out the accrued backoff.
    expect(store.getHumanQuestion(asked.questionId)!.nextPollAt).toBeLessThanOrEqual(deps.now());

    // The source healed and the human answered — the resumed run picks the reply up.
    state.humanPollError = null;
    state.humanReply = { body: "Use the new flag.", externalId: "a-9", author: "PM" };
    setNow(2000);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getHumanQuestion(asked.questionId)!.status).toBe("answered");
  });

  it("a NEW ask-human supersedes a stale pending question instead of silently binding to it", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-H6", "running", "fix");
    const first = await requestHumanInput(deps, run, "fix", "Original question?");
    expect(calls.humanAsk).toHaveLength(1);
    // Simulate the post-resume state: the run is running again, the old question still pending.
    deps.store.updateRun(run.id, { phase: "running" });
    const second = await requestHumanInput(deps, store.getRun(run.id)!, "fix", "A different question?");
    expect(second.questionId).not.toBe(first.questionId);
    expect(calls.humanAsk).toHaveLength(2); // the new question was actually POSTED to the source
    expect(store.getHumanQuestion(first.questionId)!.status).toBe("answered"); // superseded, not pending
    expect(store.getHumanQuestion(first.questionId)!.answer).toContain("superseded");
    expect(store.pendingHumanQuestionForRun(run.id)!.id).toBe(second.questionId);
    // The idempotent RE-ASK of the same question still reuses (no duplicate post).
    const again = await requestHumanInput(deps, store.getRun(run.id)!, "fix", "A different question?");
    expect(again.questionId).toBe(second.questionId);
    expect(calls.humanAsk).toHaveLength(2);
  });
});

describe("multi-source resilience + label routing", () => {
  it("one source's listEligible outage does not starve the other source's claims", async () => {
    const { deps, store, state } = build({ multi: true });
    state.failEligible = true; // jira is down
    state.eligible = [ticket("K-J1")];
    state.eligible2 = [ticket("K-L1", "task")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-J1")).toBeUndefined();
    expect(store.activeRunForTicket("demo", "lm", "K-L1")).toBeDefined(); // lm claimed regardless
  });

  it("belts route on the uniform MatchItem labels field (first matching belt wins)", async () => {
    const { deps, store, state, shipBelt } = build();
    const bugsBelt: BeltRuntime = { ...shipBelt, name: "bugs", priority: 1, match: async ({ item }) => item.labels.includes("bug") };
    const restBelt: BeltRuntime = { ...shipBelt, name: "rest", priority: 2 };
    deps.belts.splice(0, deps.belts.length, bugsBelt, restBelt);
    state.itemLabels["K-B"] = ["bug", "agent"];
    state.eligible = [ticket("K-B"), ticket("K-F")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-B")!.belt).toBe("bugs");
    expect(store.activeRunForTicket("demo", "jira", "K-F")!.belt).toBe("rest");
  });
});

describe("manual claim — INV-11 canonical-key echo", () => {
  it("re-checks dedup against describe()'s returned key, not the operator's spelling", async () => {
    const { deps, store, worktree } = build();
    seed(store, worktree, "K-CANON", "running", "fix"); // active run under the canonical key
    // The source normalizes any identifier to the canonical key (e.g. display id → immutable id).
    Object.assign(deps.sources[0]!.client, {
      describe: async () => ({ key: "K-CANON", summary: "Fix the thing", type: "Bug" }),
    });
    await claimTicket(deps, "ship", "K-ALIAS"); // no active run under THIS spelling…
    // …but the canonical key is already active — claiming again would double-run the item.
    expect(store.countActive("demo")).toBe(1);
  });
});

describe("attention workflow — resume, parked slots, re-notification", () => {
  it("resume returns a step-parked run to running with fresh clocks and re-dispatches", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-A1", "attention", "fix", { attentionReason: "fix step over budget (worker: idle)" });
    store.upsertRunStep(run.id, "fix", { startedAt: 1 });
    store.upsertWatchState(run.id, "fix", "heartbeat", { sig: "old", basedAt: 1 });

    const res = await resumeRun(deps, store.getRun(run.id)!);
    expect(res).toMatchObject({ ok: true, phase: "running" });
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.attentionReason).toBeNull();
    expect(store.getRunStep(run.id, "fix")!.startedAt).toBe(1000); // wait/attempt clock restarted
    expect(store.getWatchState(run.id, "fix", "budget")!.basedAt).toBe(1000); // budget clock restarted
    expect(store.getWatchState(run.id, "fix", "heartbeat")!.sig).toBeNull(); // heartbeat restarted

    await reconcileRun(deps, store.getRun(run.id)!); // pane w1:p1 is alive → keeps gating, no attention
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(calls.notify).toBe(0);
  });

  it("resume returns a PR-watch-parked run to reviewing, idle (no slot until it resolves again)", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-A2", "attention", null, { prNumber: 12, resolverActive: true, attentionReason: "parked" });
    const res = await resumeRun(deps, store.getRun(run.id)!);
    expect(res).toMatchObject({ ok: true, phase: "reviewing" });
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("reviewing");
    expect(got.resolverActive).toBe(false); // idle watch — holds no slot until an actionable state re-wakes it
    expect(got.lastThreadSig).toBeNull(); // next actionable review state re-wakes the resolver
  });

  it("resume refuses a run that isn't parked", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-A3", "running", "fix");
    const res = await resumeRun(deps, store.getRun(run.id)!);
    expect(res.ok).toBe(false);
  });

  it("parked runs do not hold claim slots — new work is still claimed at the cap", async () => {
    const { deps, store, state, worktree } = build();
    // Three parked runs (the whole max_active_workspaces=3 cap under the old accounting).
    seed(store, worktree, "K-P1", "attention", "fix");
    seed(store, worktree, "K-P2", "attention", "fix");
    seed(store, worktree, "K-P3", "waiting_for_human", "fix", {});
    store.createHumanQuestion({ runId: store.activeRunsForKey("demo", "K-P3")[0]!.id, repo: "demo", workSource: "jira", ticketKey: "K-P3", question: "q?" });
    state.eligible = [ticket("K-NEW")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-NEW")).toBeDefined(); // claimed despite 3 parked
    expect(store.countActive("demo")).toBe(4);
    expect(store.countOccupying("demo")).toBe(1);
  });

  it("a MECHANICAL escalation reports into the run's pane, never onto the work item; parked runs re-notify periodically", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-A4", "running", "review");
    setNow(1000 + 1801); // review over budget, worker idle → attention (a factory watchdog = mechanical)
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.notify).toBe(1);
    expect(calls.postNotes).toEqual([]); // factory plumbing is noise on the ticket
    const report = calls.agentSend.find(([, text]) => text.includes("parked for attention"));
    expect(report).toBeDefined(); // …the pane where the work happened gets the report instead
    expect(report![0]).toBe("w1:p1");
    expect(report![1]).toContain("herdr-factory report");
    expect(report![1]).toContain("resume K-A4");

    // Within the renotify window: silent. Past it: notified again (but no second pane report).
    const reports = () => calls.agentSend.filter(([, text]) => text.includes("parked for attention")).length;
    const before = reports();
    setNow(1000 + 1801 + 3599);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(1);
    setNow(1000 + 1801 + 3601);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.notify).toBe(2);
    expect(reports()).toBe(before);
  });

  it("a WORK-ERROR escalation (pr_closed) is posted on the work item; on a file-channel source it goes to the pane", async () => {
    const { deps, store, state, worktree, calls } = build({ multi: true });
    // A comments-channel source (jira): the closed PR is about the designated work — ticket note.
    const run = seed(store, worktree, "K-A5", "reviewing", null, { prNumber: 7 });
    state.pr = { number: 7, state: "CLOSED", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(calls.postNotes.length).toBe(1);
    expect(calls.postNotes[0]![0]).toBe("K-A5");
    expect(calls.postNotes[0]![1]).toContain("resume K-A5");
    // The note's BODY carries the configured brand too (issue #70) — the default is today's text,
    // while the `resume`/`triage` lines keep naming the real binary an operator has to type.
    expect(calls.postNotes[0]![1]).toContain("⚠ herdr-factory parked this run for attention");
    expect(calls.postNotes[0]![1]).toContain("herdr-factory --repo demo resume K-A5");

    // A file-channel source (local_markdown): its "notes" are hidden files nobody watches — the
    // same work error reports into the pane instead.
    const lmRun = seed(store, worktree, "M-A5", "reviewing", null, { prNumber: 7 }, "lmship", "lm");
    await reconcileRun(deps, store.getRun(lmRun.id)!);
    expect(store.getRun(lmRun.id)!.phase).toBe("attention");
    expect(calls.postNotes.length).toBe(1); // unchanged — nothing new posted
    const report = calls.agentSend.find(([, text]) => text.includes("resume M-A5"));
    expect(report).toBeDefined();
    expect(report![1]).toContain("herdr-factory report");
  });
});

describe("per-run locks — nudges land while a tick is mid-pass", () => {
  it("withRunLock runs even while the repo tick lock is held (only its own run contends)", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-L1", "running", "fix");
    deps.store.acquireLock("tick:demo", "other-owner", 300); // a long tick is mid-flight
    let ran = 0;
    expect(await withRunLock(deps, run.id, async () => { ran += 1; })).toBe(true);
    expect(ran).toBe(1);
  });

  it("withRunLock skips when the same run is already being reconciled", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-L2", "running", "fix");
    deps.store.acquireLock(`run:${run.id}`, "other-owner", 300);
    let ran = 0;
    expect(await withRunLock(deps, run.id, async () => { ran += 1; })).toBe(false);
    expect(ran).toBe(0);
  });

  it("withRunLockWaiting retries until the lock frees, then returns fn's result", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-L3", "running", "fix");
    deps.store.acquireLock(`run:${run.id}`, "other-owner", 300);
    let tries = 0;
    const origSleep = deps.sleep;
    deps.sleep = async (ms) => {
      tries += 1;
      if (tries === 2) deps.store.releaseLock(`run:${run.id}`, "other-owner"); // holder finishes
      return origSleep(0);
    };
    const { ran, result } = await withRunLockWaiting(deps, run.id, async () => "advanced");
    expect(ran).toBe(true);
    expect(result).toBe("advanced");
  });

  it("extendLock is owner-checked (a lost lock is not re-asserted)", () => {
    const { deps } = build();
    expect(deps.store.acquireLock("run:99", "me", 60)).toBe(true);
    expect(deps.store.extendLock("run:99", "me", 60)).toBe(true);
    expect(deps.store.extendLock("run:99", "not-me", 60)).toBe(false);
  });

  it("phase A reconciles all runs in parallel and still claims new work", async () => {
    const { deps, store, state, worktree } = build();
    deps.config.limits.maxActiveWorkspaces = 5;
    seed(store, worktree, "K-M1", "running", "fix");
    seed(store, worktree, "K-M2", "running", "fix");
    seed(store, worktree, "K-M3", "running", "fix");
    state.eligible = [ticket("K-M4")];
    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "K-M4")).toBeDefined();
    expect(store.countActive("demo")).toBe(4);
  });
});

describe("rate limiting — batched PR polling, claim admission, poll backoff", () => {
  it("a tick batches PR state for all reviewing runs and acts on it (no per-run gh calls)", async () => {
    const { deps, store, state, worktree, calls } = build();
    seed(store, worktree, "K-R1", "reviewing", null, { prNumber: 41 });
    seed(store, worktree, "K-R2", "reviewing", null, { prNumber: 42 });
    state.prByNumber = { number: 41, state: "OPEN", url: "u" }; // fake snapshot source
    await reconcileRepo(deps);
    expect(calls.prSnapshots).toHaveLength(1); // ONE batched fetch for the whole pass
    expect(calls.prSnapshots[0]!.sort()).toEqual([41, 42]);
    expect(calls.reviewSig).toBe(0); // signature came from the batch, not per-run calls
  });

  it("a merged PR detected via the batch tears the run down", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-R3", "reviewing", null, { prNumber: 55 });
    state.prByNumber = { number: 55, state: "MERGED", url: "u" };
    await reconcileRepo(deps);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
  });

  it("claims per tick are capped (max_claims_per_tick), remaining backlog fills next passes", async () => {
    const { deps, store, state } = build();
    deps.config.limits.maxActiveWorkspaces = 20;
    deps.config.limits.maxClaimsPerTick = 2;
    state.eligible = [ticket("K-C1"), ticket("K-C2"), ticket("K-C3"), ticket("K-C4"), ticket("K-C5")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(2); // capped
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(4); // next pass continues
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(5); // backlog drained
  });

  it("human-reply poll misses reschedule on the flat 30s cadence", () => {
    const { store } = build();
    const run = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-B1", branch: "b" });
    const q = store.createHumanQuestion({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-B1", question: "?" });
    expect(store.recordHumanPollMiss(q.id).nextPollAt).toBe(1000 + 30);
    expect(store.recordHumanPollMiss(q.id).nextPollAt).toBe(1000 + 30); // flat — no doubling
    expect(store.recordHumanPollMiss(q.id).pollAttempts).toBe(3); // misses still counted
  });
});

describe("work-source auth gate (unauthenticated → pause + auto-resume, never haywire)", () => {
  it("claiming: an unauthenticated source is paused (no claim) + notified once, OTHER sources keep claiming, and it auto-resumes on recovery", async () => {
    const { deps, store, state, calls } = build({ multi: true });
    state.authFail = true; // jira can't authenticate
    state.eligible = [ticket("A-1")]; // a jira item is waiting
    state.eligible2 = [ticket("M-1")]; // and a local_markdown item

    await reconcileRepo(deps);
    // jira is gated: its item is NOT claimed. The label-less local_markdown belt is unaffected.
    expect(store.activeRunForTicket("demo", "jira", "A-1")).toBeUndefined();
    expect(store.activeRunForTicket("demo", "lm", "M-1")).toBeDefined();
    expect(getAuthFailure("demo", "jira")).toBeDefined();
    expect(getAuthFailure("demo", "lm")).toBeUndefined(); // no-auth source never gates
    expect(calls.notify).toBe(1); // the operator is told exactly once (throttled)

    // A second gated tick must NOT re-notify (throttle) and must NOT claim.
    await reconcileRepo(deps);
    expect(calls.notify).toBe(1);
    expect(store.activeRunForTicket("demo", "jira", "A-1")).toBeUndefined();

    // Re-authenticated: the gate clears and the held jira item is claimed on the next tick.
    state.authFail = false;
    await reconcileRepo(deps);
    expect(getAuthFailure("demo", "jira")).toBeUndefined();
    expect(store.activeRunForTicket("demo", "jira", "A-1")).toBeDefined();
  });

  it("write-back: an auth failure DEFERS the transition + notifies (intent stays queued, never lost or escalated)", async () => {
    const { deps, store, state, calls, setNow } = build();
    const run = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-1", branch: "b" });
    const intent = store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-1", toState: "in_review" });
    state.authFail = true;
    await flushTransitionOutbox(deps);
    expect(calls.transitions).not.toContainEqual(["K-1", "in_review"]); // never delivered
    expect(store.getTransitionIntent(intent.id)?.deliveredAt).toBeNull(); // still queued for retry
    expect(getAuthFailure("demo", "jira")).toBeDefined();
    expect(calls.notify).toBe(1);
    // The gate RECORDED the problem on the ledger (the dashboard reads it — never re-checks)…
    expect(store.listProblems("demo")).toEqual([expect.objectContaining({ key: "source:jira", kind: "auth" })]);
    // …and the first successful call clears it again (past the 30s retry interval).
    state.authFail = false;
    setNow(1000 + 31);
    await flushTransitionOutbox(deps);
    expect(store.listProblems("demo")).toEqual([]);
  });

  it("a persisted problem row outlives the in-memory gate: recovery clears it even after a restart", async () => {
    const { deps, store, state, setNow } = build();
    const run = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-2", branch: "b" });
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-2", toState: "in_review" });
    state.authFail = true;
    await flushTransitionOutbox(deps);
    expect(store.listProblems("demo").length).toBe(1);
    resetAuthGate(); // "restart": the in-memory gate forgets, the DB row survives
    state.authFail = false;
    setNow(1000 + 31); // past the retry interval, so the held write-back is due
    await flushTransitionOutbox(deps);
    expect(store.listProblems("demo")).toEqual([]); // the unconditional clear, not the gate, removed it
  });
});

describe("work-source rate-limit gate (back off until the backend's own reset)", () => {
  it("claiming: a rate-limited source is NOT re-polled until its reset, other sources keep claiming, then it resumes", async () => {
    const { deps, store, state, calls, setNow } = build({ multi: true });
    state.rateLimitedUntilMs = (1000 + 300) * 1000; // the backend named a reset 300s out
    state.eligible = [ticket("A-1")];
    state.eligible2 = [ticket("M-1")];

    await reconcileRepo(deps);
    expect(store.activeRunForTicket("demo", "jira", "A-1")).toBeUndefined();
    expect(store.activeRunForTicket("demo", "lm", "M-1")).toBeDefined(); // a different source is untouched
    expect(getRateLimit("demo", "jira", 1000)?.until).toBe(1300);
    expect(getRateLimit("demo", "lm", 1000)).toBeUndefined();
    expect(calls.notify).toBe(1);

    // THE POINT: the next tick doesn't call the backend at all — re-polling an exhausted
    // account-wide budget is what keeps it exhausted.
    calls.eligibleQueries = 0;
    state.rateLimitedUntilMs = null; // even though the backend would answer now
    setNow(1000 + 299);
    await reconcileRepo(deps);
    expect(calls.eligibleQueries).toBe(0);
    expect(store.activeRunForTicket("demo", "jira", "A-1")).toBeUndefined();

    // Past the reset the hold drops itself and the held item is claimed.
    setNow(1000 + 301);
    await reconcileRepo(deps);
    expect(calls.eligibleQueries).toBe(1);
    expect(store.activeRunForTicket("demo", "jira", "A-1")).toBeDefined();
    expect(getRateLimit("demo", "jira", 1000 + 301)).toBeUndefined();
  });

  it("the hold is recorded on the problem ledger (what `status`/`explain` read) and cleared on recovery", async () => {
    const { deps, store, state, setNow } = build();
    const run = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-R1", branch: "b" });
    const intent = store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-R1", toState: "in_review" });
    state.rateLimitedUntilMs = (1000 + 60) * 1000;

    await flushTransitionOutbox(deps);
    expect(store.getTransitionIntent(intent.id)?.deliveredAt).toBeNull(); // queued, never lost
    expect(store.listProblems("demo")).toEqual([expect.objectContaining({ key: "source:jira:rate-limit", kind: "rate_limit" })]);

    state.rateLimitedUntilMs = null;
    setNow(1000 + 61);
    await flushTransitionOutbox(deps);
    expect(store.listProblems("demo")).toEqual([]);
  });

  it("a hold is EXTENDED, never shortened, by a later observation that names a nearer reset", async () => {
    const { deps, store, state, setNow } = build();
    const run = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-R2", branch: "b" });
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-R2", toState: "in_review" });
    state.rateLimitedUntilMs = (1000 + 600) * 1000;
    await flushTransitionOutbox(deps);
    expect(getRateLimit("demo", "jira", 1000)?.until).toBe(1600);

    state.rateLimitedUntilMs = (1000 + 30) * 1000; // a racing call reports a much nearer reset
    setNow(1000 + 31);
    await flushTransitionOutbox(deps);
    expect(getRateLimit("demo", "jira", 1000 + 31)?.until).toBe(1600); // the far reset still governs
  });
});

describe("claim-race hardening — the v25 one-active-run index is the arbiter", () => {
  it("a manual claim that loses the createRun race is a friendly skip, not an error (one run survives)", async () => {
    const { deps, store } = build();
    // Simulate Phase B winning INSIDE the manual claim's race window: between claimTicket's dedup
    // check and its createRun sits a network call (describe) — the fake's describe() claims first.
    const client = deps.sources[0]!.client;
    const origDescribe = client.describe;
    client.describe = async (key) => {
      store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: key, summary: "s", issueType: "Bug", branch: `fix/${key}-race` });
      return origDescribe(key);
    };
    await expect(claimTicket(deps, "ship", "K-RACE")).resolves.toBeUndefined();
    expect(store.activeRunsForKey("demo", "K-RACE")).toHaveLength(1);
  });
});

describe("heartbeat lock loss is loud, never silent", () => {
  it("a beat that finds its lock stolen logs an error, stops beating, and leaves the thief's hold alone", async () => {
    vi.useFakeTimers();
    try {
      const { deps, store, setNow } = build();
      const logs: string[] = [];
      deps.log = (level, msg) => { logs.push(`${level}: ${msg}`); };
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const p = withRunLock(deps, 42, () => gate);
      await vi.advanceTimersByTimeAsync(0); // let the acquisition land before stealing
      // Lapse the TTL (300s) and steal the lock — what a holder stalled past its heartbeat suffers.
      setNow(1000 + 301);
      expect(store.acquireLock("run:42", "thief", 300)).toBe(true);
      // The next beat (ttl/3 = 100s): extendLock is owner-checked and reports the loss.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(logs.some((l) => l.startsWith("error:") && l.includes("lock run:42 lost mid-hold"))).toBe(true);
      // The thief's hold is untouched — neither re-extended by us nor stolen back.
      expect(store.acquireLock("run:42", "other", 300)).toBe(false);
      // And the loss is reported exactly once — the beat stops instead of re-logging forever.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(logs.filter((l) => l.includes("lost mid-hold"))).toHaveLength(1);
      release();
      await expect(p).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("human-reply resume — a reply never auto-advances an unfinished step", () => {
  it("re-bases the budget clock and re-prompts; the belt advances only on the agent's own fresh signal", async () => {
    const { deps, store, state, worktree, calls, setNow } = build();
    const run = seed(store, worktree, "K-HD", "running", "fix");
    await requestHumanInput(deps, run, "fix", "Which flag wins?");
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");

    state.humanReply = { body: "Do B.", externalId: "a-1", author: "PM" };
    setNow(1000 + 61);
    await reconcileRun(deps, store.getRun(run.id)!);

    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix"); // the reply resumes the SAME step — it never advances the belt itself
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    expect(store.getWatchState(run.id, "fix", "budget")!.basedAt).toBe(1061); // budget clock re-based to the resume, not the pre-ask dispatch
    expect(calls.agentSend.at(-1)?.[1]).toContain("Human guidance has arrived");

    // Later passes keep waiting for the agent's own decision…
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("fix");
    // …and a fresh step-done (the agent finished acting on the reply) advances normally.
    const res = await applySignal(deps, "step-done", { key: "K-HD", step: "fix" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("review");
  });
});

// RWR-18609: an evidence step blocked on a local login asked a human, unblocked itself an hour
// later, and signalled step-done — which recorded rs.done and then sat in waiting_for_human forever,
// because the only exits were a reply, a merge, a stale item, or a failing poll. A terminal from the
// parked step is not something the human wait may veto.
describe("ask-human park — a terminal from the parked step rescues the run", () => {
  it("step-done un-parks and advances the belt, closing the moot question unanswered", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-HR1", "running", "fix");
    await requestHumanInput(deps, run, "fix", "Which flag wins?");
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    const q = store.pendingHumanQuestionForRun(run.id)!;
    calls.humanPoll.length = 0;

    // The agent got past the blocker on its own and signalled its terminal.
    const res = await applySignal(deps, "step-done", { key: "K-HR1", step: "fix" });
    expect(res.ok).toBe(true);

    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("review"); // advanced, not wedged
    // The question can never be usefully answered — closed, so the poller stops chasing it and a
    // later resume can't be sent back into waiting_for_human on it.
    const closed = store.getHumanQuestion(q.id)!;
    expect(closed.status).toBe("answered");
    expect(closed.answer).toContain("no human reply needed");
    expect(store.pendingHumanQuestionForRun(run.id)).toBeUndefined();
    expect(calls.humanPoll).toHaveLength(0); // never polled for a reply to a finished step
    // The question's poll clock lives on the intent ledger — closing the question must close the
    // ledger row too, or a waiting intent outlives the question and can hit its deadline.
    const clocks = store.listIntents("demo", { runId: run.id, kind: "human_reply_poll" });
    expect(clocks.some((i) => i.status === "waiting" || i.status === "pending")).toBe(false);
    // Audited both ways: the closure and the un-park.
    const timeline = store.timeline("demo", "K-HR1");
    expect(timeline.some((e) => e.type === "human_question_moot")).toBe(true);
    expect(timeline.filter((e) => e.type === "resumed").map((e) => e.detail)).toContainEqual(
      expect.stringContaining("step_done_after_human_park"),
    );
    // And the human staring at the posted thread is told it needs no answer.
    expect(calls.postNotes.at(-1)?.[1]).toContain("no answer needed");
    // A later tick is a plain no-op pass on the advanced run, not a re-park.
    state.humanReply = { body: "too late", externalId: "a-9", author: "PM" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("review");
  });

  it("a bounce from the parked step un-parks and rewinds, closing the moot question", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-HR2", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    await requestHumanInput(deps, run, "review", "Is the flag rename in scope?");
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    const q = store.pendingHumanQuestionForRun(run.id)!;

    // The reviewer decided it doesn't need the answer to send the work back.
    const res = await applySignal(deps, "bounce", { key: "K-HR2", step: "review", toStep: "fix", reason: "flag rename is wrong" });
    expect(res.ok).toBe(true);

    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("fix"); // rewound to the bounce target
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    expect(store.getHumanQuestion(q.id)!.status).toBe("answered");
    expect(store.pendingHumanQuestionForRun(run.id)).toBeUndefined();
    expect(store.timeline("demo", "K-HR2").filter((e) => e.type === "resumed").map((e) => e.detail)).toContainEqual(
      expect.stringContaining("bounce_after_human_park"),
    );
    expect(calls.postNotes.at(-1)?.[1]).toContain("no answer needed");
  });

  it("a park that needs a human is NOT rescued by a step-done (the reply poll continues)", async () => {
    const { deps, store, state, worktree, calls } = build();
    // A pr_closed park: a hard gate that only a human resolves — its step's done flag must not
    // un-park it, unlike the watchdog/ask-human parks.
    const run = seed(store, worktree, "K-HR3", "attention", "fix", { attentionReason: "PR closed without merging" });
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "K-HR3", type: "attention", detail: { reason: "pr_closed" } });
    store.markStepDone(run.id, "fix");
    state.humanReply = null;
    calls.notify = 0;
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention"); // still parked for the human
    expect(store.getRun(run.id)!.step).toBe("fix");
  });
});

describe("resume nudges the resumed step's idle agent", () => {
  it("an idle pane is re-prompted — the finished-but-never-signalled park is no longer a dead end", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-NU1", "attention", "fix", { attentionReason: "fix step over budget (worker: idle)" });
    const res = await resumeRun(deps, store.getRun(run.id)!);
    expect(res).toMatchObject({ ok: true, phase: "running" });
    const [pane, msg] = calls.agentSend.at(-1)!;
    expect(pane).toBe("w1:p1"); // the step's OWN recorded pane
    expect(msg).toContain("A human resumed K-NU1");
    expect(msg).toContain("fix step over budget"); // the park reason, so the agent knows why
    expect(msg).toContain("prompt-fix.md"); // points at the pass's rendered prompt (valid --pass stamp)
    expect(msg).toContain("TASKS.md"); // the checklist that survives compaction
    expect(msg).toContain("step-done");
  });

  it("a working pane is left mid-turn — no foreign message is injected", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-NU2", "attention", "fix");
    state.paneState = "working";
    const res = await resumeRun(deps, store.getRun(run.id)!);
    expect(res).toMatchObject({ ok: true, phase: "running" });
    expect(calls.agentSend).toHaveLength(0);
  });

  it("herdr unreachable → the nudge is skipped but the resume itself still lands", async () => {
    const { deps, store, state, worktree, calls } = build();
    const run = seed(store, worktree, "K-NU3", "attention", "fix");
    state.herdrUnreachable = true;
    const res = await resumeRun(deps, store.getRun(run.id)!);
    expect(res).toMatchObject({ ok: true, phase: "running" });
    expect(calls.agentSend).toHaveLength(0);
    expect(store.getRun(run.id)!.phase).toBe("running");
  });

  it("a resume that returns to the PR watch (no active step) never nudges a step pane", async () => {
    const { deps, store, worktree, calls } = build();
    const run = seed(store, worktree, "K-NU4", "attention", null, { prNumber: 7 });
    const res = await resumeRun(deps, store.getRun(run.id)!);
    expect(res).toMatchObject({ ok: true, phase: "reviewing" });
    expect(calls.agentSend).toHaveLength(0);
  });
});

describe("fresh-worktree memory scrub — a committed .memory can't supplant the work doc", () => {
  it("removes a committed .memory/herdr-factory from a freshly CREATED worktree, then materializes", async () => {
    const { deps, state, worktree } = build();
    // Simulate a repo that accidentally committed factory memory: the brand-new checkout already
    // carries a stale task doc. Every source's materialize is skip-if-exists, so without the scrub
    // this file would be handed to the work agent as its spec.
    const mem = join(worktree, MEMORY_DIR);
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "task.md"), "# stale committed task");
    state.eligible = [ticket("CATS-1")];
    await reconcileRepo(deps);
    expect(existsSync(join(mem, "task.md"))).toBe(false); // the committed stale doc is gone
    expect(existsSync(join(mem, "ticket.json"))).toBe(true); // the source materialized the real work doc
  });

  it("never scrubs on the worktree-REOPEN path — a re-attached worktree holds the run's live state", async () => {
    const { deps, state, worktree } = build();
    deps.git = { ...deps.git, branchExists: async () => true }; // branch exists ⇒ worktreeOpen, not create
    const mem = join(worktree, MEMORY_DIR);
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "handoff-fix.md"), "live handoff");
    state.eligible = [ticket("CATS-1")];
    await reconcileRepo(deps);
    expect(readFileSync(join(mem, "handoff-fix.md"), "utf8")).toBe("live handoff");
  });
});

// Nothing else in the factory fetches the target checkout, so a clone that is only read keeps the
// origin/main it was cloned with and every run is cut from a base that is merges old.
describe("base-ref fetch — a worktree is cut from the remote's tip, not a stale clone", () => {
  it("fetches the base ref's remote branch before creating the worktree", async () => {
    const { deps, state, calls } = build();
    state.eligible = [ticket("CATS-1")];
    await reconcileRepo(deps);
    expect(calls.fetchRef).toEqual([["/main-checkout", "origin", "master"]]); // base_ref = origin/master
  });

  it("logs the base's age and still creates the worktree when the fetch fails", async () => {
    const { deps, state, store } = build();
    state.fetchOk = false;
    const warnings: string[] = [];
    deps.log = (level, msg) => { if (level === "warn") warnings.push(msg); };
    state.eligible = [ticket("CATS-1")];
    await reconcileRepo(deps);
    expect(warnings.some((w) => w.includes("could not fetch origin/master") && w.includes("9 days ago"))).toBe(true);
    expect(store.getRun(store.activeRuns("demo")[0]!.id)!.workspaceId).toBe("w1"); // the claim went through
  });

  it("never fetches on the worktree-REOPEN path — that checkout already exists", async () => {
    const { deps, state, calls } = build();
    deps.git = { ...deps.git, branchExists: async () => true };
    state.eligible = [ticket("CATS-1")];
    await reconcileRepo(deps);
    expect(calls.fetchRef).toEqual([]);
  });

  it("skips a LOCAL base ref — no fetch moves a branch the checkout holds itself", async () => {
    const { deps, state, calls } = build();
    deps.config.repo.baseRef = "master";
    state.eligible = [ticket("CATS-1")];
    await reconcileRepo(deps);
    expect(calls.fetchRef).toEqual([]);
  });
});

describe("belt effects — configurable task progression", () => {
  // Build a work→evidence→review→pr belt with a configured effect, and seed a run parked at a step.
  function withEffects(effects: BeltRuntime["effects"]) {
    const h = build();
    h.shipBelt.steps = [stepCfg("fix"), stepCfg("evidence"), stepCfg("review"), stepCfg("pr")];
    h.shipBelt.effects = effects;
    return h;
  }

  it("on evidence produce → QA: fires a source transition through the outbox (anchor in_review, status qa)", async () => {
    const { deps, store, worktree, calls } = withEffects([{ trigger: { on: "produce", product: "evidence" }, to: "in_review", status: "qa" }]);
    const run = seed(store, worktree, "K-QA1", "running", "evidence");
    store.upsertRunStep(run.id, "evidence", { done: true }); // the evidence agent signalled done (passed)
    await reconcileRun(deps, store.getRun(run.id)!);
    // The QA move rode the outbox: to_state is the canonical anchor (in_review), to_status the
    // source-native key (qa) — a DISTINCT intent, delivered with the statusOverride.
    expect(store.transitionTargetsForRun(run.id)).toContainEqual({ toState: "in_review", toStatus: "qa" });
    expect(calls.transitionOverrides).toContainEqual(["K-QA1", "in_review", "qa"]);
    expect(store.getRun(run.id)!.step).toBe("review"); // and it advanced forward
  });

  it("is idempotent / retry-safe: re-reconciling the same completed step re-opens the SAME intent, never a second", async () => {
    const { deps, store, worktree } = withEffects([{ trigger: { on: "produce", product: "evidence" }, to: "in_review", status: "qa" }]);
    const run = seed(store, worktree, "K-QA2", "running", "evidence");
    store.upsertRunStep(run.id, "evidence", { done: true });
    await reconcileRun(deps, store.getRun(run.id)!);
    // Re-drive the same advance (simulate a duplicate tick before the advance persisted downstream).
    store.updateRun(run.id, { step: "evidence" });
    store.upsertRunStep(run.id, "evidence", { done: true });
    await reconcileRun(deps, store.getRun(run.id)!);
    const qaIntents = store.transitionTargetsForRun(run.id).filter((t) => t.toStatus === "qa");
    expect(qaIntents.length).toBe(1); // one row, re-opened on conflict — never duplicated
  });

  it("forward-only: an effect that would move the source BACKWARD is a noop", async () => {
    const { deps, store, worktree, calls } = withEffects([{ trigger: { on: "produce", product: "evidence" }, to: "in_review", status: "qa" }]);
    const run = seed(store, worktree, "K-QA3", "running", "evidence");
    store.upsertRunStep(run.id, "evidence", { done: true });
    // The source has already progressed to in_review (rank 2). QA anchors at in_review but ranks 1.5
    // (a custom status sits just before its anchor), so firing it now would walk backward → skip.
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-QA3", toState: "in_review" });
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.transitionTargetsForRun(run.id)).not.toContainEqual({ toState: "in_review", toStatus: "qa" });
    expect(calls.transitionOverrides).toEqual([]); // qa never delivered
  });

  it("a belt with NO effects behaves exactly as the engine defaults (in_review on PR open)", async () => {
    const { deps, store, state, worktree, calls } = build(); // shipBelt has no effects
    const run = seed(store, worktree, "K-D1", "running", "pr", { prNumber: 21 });
    store.markStepDone(run.id, "pr");
    state.pr = { number: 21, state: "OPEN", url: "u" };
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(calls.transitions).toContainEqual(["K-D1", "in_review"]); // default fired
    expect(calls.transitionOverrides).toEqual([]); // no source-native override
  });

  it("teardown(outcome) effect overrides the terminal status", async () => {
    const { deps, store, state, worktree, calls } = withEffects([{ trigger: { on: "teardown", outcome: "merged" }, to: "done", status: "shipped" }]);
    const run = seed(store, worktree, "K-T1", "reviewing", null, {});
    state.pr = { number: 30, state: "MERGED", url: "u" }; // merged PR → teardown(merged)
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.outcome).toBe("merged");
    expect(calls.transitionOverrides).toContainEqual(["K-T1", "done", "shipped"]);
  });
});

// The obligations view (core/obligations.ts) — the read-only "why is this run waiting and what
// would move it" answer the server exposes at GET /repos/:repo/obligations. Pure reads over the
// store + registries; these lock the shape and the registry derivation, not the mechanisms
// themselves (each watch/outbox has its own suite above).
describe("runObligations — pending intents + armed watches, registry-derived", () => {
  it("surfaces undelivered transitions, pending uploads, armed guards with clocks, and engine watches", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-OB1", "running", "fix");
    // An undelivered write-back + a pending evidence upload + a bounce already counted against review.
    store.enqueueTransition({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-OB1", toState: "in_development" });
    enqueueEvidencePublish(store, run.id, "p1", join(worktree, "ev"));
    store.bumpGuardCounter(run.id, "fix", "bounce_cap");

    const ob = runObligations(deps, store.getRun(run.id)!);
    expect(ob.run).toMatchObject({ key: "K-OB1", phase: "running", step: "fix" });
    expect(ob.intents.transitions).toMatchObject([{ toState: "in_development", staleUnhandled: false }]);
    expect(ob.intents.evidenceUploads).toMatchObject([{ keyPrefix: "p1" }]);
    expect(ob.intents.pendingSignal).toBeNull();
    expect(ob.intents.humanQuestion).toBeNull();
    // The watched step is the active one; its armed guards carry live facts + a derived rescue class.
    expect(ob.watches.step).toBe("fix");
    const layout = ob.watches.guards.find((g) => g.kind === "layout_wait")!;
    expect(layout.rescue).toBe("respawn");
    expect(layout.facts).toMatchObject({ respawnsUsed: 0, respawnLimit: 3, waitingSince: null }); // dispatched → not waiting
    // Engine-universal watches ride along with their live facts.
    expect(ob.watches.engine.map((w) => w.kind).sort()).toEqual(["pane_liveness", "pass_staleness"]);
    expect(ob.watches.engine.find((w) => w.kind === "pane_liveness")!.facts).toMatchObject({ paneId: "w1:p1", absentAt: null });
    expect(ob.watches.bounceCaps).toEqual([{ step: "fix", count: 1, max: 3 }]); // the harness's limits.maxBounces
  });

  it("a waiting_for_human run reports its pending question; a read-only step reports its baseline", async () => {
    const { deps, store, worktree, shipBelt } = build();
    shipBelt.steps[1] = stepCfg("review", { readOnly: true }); // read-only review, guard attached like production
    const run = seed(store, worktree, "K-OB2", "waiting_for_human", "review");
    store.createHumanQuestion({ runId: run.id, repo: "demo", workSource: "jira", ticketKey: "K-OB2", step: "review", question: "q?" });
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-b", basedAt: 77 });

    const ob = runObligations(deps, store.getRun(run.id)!);
    expect(ob.intents.humanQuestion).toMatchObject({ step: "review", posted: false });
    const ro = ob.watches.guards.find((g) => g.kind === "read_only")!;
    expect(ro.rescue).toBe("terminal-signal");
    expect(ro.facts).toMatchObject({ baselineSig: "sha-b", frozenAt: 77 });
  });
});

// The intent ledger's run-facing half through the REAL reconcile machinery: a fulfilled wait is
// consumed on the run's next pass; an expired one parks the run via the kind's escalation verdict.
describe("external_wait intents — fulfil and deadline through reconcileRun", () => {
  it("a fulfilled wait is consumed exactly once and recorded on the timeline", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-EW1", "running", "fix");
    const wait = store.enqueueIntent({ repo: "demo", kind: "external_wait", scope: `run:${run.id}`, runId: run.id, ticketKey: "K-EW1", dedupKey: "ci-gate", payload: JSON.stringify({ note: "release CI" }), status: "waiting" });
    store.fulfilIntent(wait.id, '{"conclusion":"success"}');
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getIntent(wait.id)!.consumedResult).toBe("applied");
    expect(store.getRun(run.id)!.phase).toBe("running"); // no park; the run just carries on
    const events = store.timeline("demo", "K-EW1").filter((e) => e.type === "intent_fulfilled");
    expect(events.length).toBe(1);
  });

  it("an expired wait parks the run for attention with reason external_wait_deadline", async () => {
    const { deps, store, worktree, setNow } = build();
    const run = seed(store, worktree, "K-EW2", "running", "fix");
    store.enqueueIntent({ repo: "demo", kind: "external_wait", scope: `run:${run.id}`, runId: run.id, ticketKey: "K-EW2", dedupKey: "approval", payload: JSON.stringify({ note: "security approval" }), status: "waiting", deadlineAt: 1500 });
    setNow(1501);
    await reconcileRepo(deps); // Phase 0 sweeps the deadline; Phase A consumes the handoff → park
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("attention");
    expect(got.attentionReasonCode).toBe("external_wait_deadline");
    expect(got.attentionReason).toContain("security approval");
  });
});

// The plugin surface (W4): a NEW watch = one GuardSpec + one registerWatchEvaluator call — the
// park, the reason code, the veto, the entry re-base and the obligations facts all derive from the
// declaration, with state in watch_state (no migration). This drives a synthetic watch through the
// REAL reconciler end to end.
describe("plugin watches — registerWatchEvaluator", () => {
  const SENTINEL_GUARD = {
    kind: "sentinel",
    escalationReason: "sentinel_tripped",
    autoRescueOnDone: true,
    vetoWhenWorking: true,
    rebaseOn: ["entry", "resume"],
  } as const;

  it("a registered watch parks through the harness with its declared reason, vetoes on working, and re-bases on entry", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    let armed = true; // the synthetic condition: trips while armed
    const unregister = registerWatchEvaluator("sentinel", async ({ deps: d, run, step }) => {
      d.store.upsertWatchState(run.id, step.name, "sentinel", { sig: "observed" }); // watch-owned state
      return armed
        ? { kind: "trip", trippedWhat: "sentinel", attentionReason: `${step.name} sentinel tripped (worker: @@WORKER@@)`, body: "the sentinel condition failed", detail: { step: step.name } }
        : { kind: "ok" };
    });
    try {
      shipBelt.steps[0]!.guards = [...shipBelt.steps[0]!.guards, SENTINEL_GUARD];
      const run = seed(store, worktree, "K-PW1", "running", "fix");

      // The declared veto holds the trip while the agent is actively working…
      state.paneState = "working";
      await reconcileRun(deps, store.getRun(run.id)!);
      expect(store.getRun(run.id)!.phase).toBe("running");

      // …and an idle agent parks with the DECLARED reason code (rescue routing + /obligations key).
      state.paneState = "idle";
      await reconcileRun(deps, store.getRun(run.id)!);
      const parked = store.getRun(run.id)!;
      expect(parked.phase).toBe("attention");
      expect(parked.attentionReasonCode).toBe("sentinel_tripped");
      expect(parked.attentionReason).toContain("sentinel tripped (worker: idle)");
      expect(store.getWatchState(run.id, "fix", "sentinel")!.sig).toBe("observed");

      // The default rebase (a generic null-row clear) fires from the declaration at the seams.
      armed = false;
      applyWatchRebase(deps, run.id, shipBelt.steps[0]!, "entry");
      const ws = store.getWatchState(run.id, "fix", "sentinel")!;
      expect(ws.sig).toBeNull();
      expect(ws.basedAt).toBeNull();
    } finally {
      unregister();
    }
  });

  it("shipped kinds cannot be overridden; duplicate registrations are rejected", async () => {
    expect(() => registerWatchEvaluator("budget", async () => ({ kind: "ok" }))).toThrow(/shipped/);
    const un = registerWatchEvaluator("once", async () => ({ kind: "ok" }));
    try {
      expect(() => registerWatchEvaluator("once", async () => ({ kind: "ok" }))).toThrow(/already registered/);
    } finally {
      un();
    }
  });
});

// The claim ledger's teardown half (core/claim-guard.ts has the protocol tests): a guarded source's
// run posts its release when torn down, so another factory can claim the item later.
describe("claim ledger — release at teardown", () => {
  it("an aborted run posts its release marker; an unguarded source posts nothing", async () => {
    const { deps, store, worktree, sources } = build();
    const posted: [string, string][] = [];
    sources[0]!.client.postClaimComment = async (key, body) => { posted.push([key, body]); };
    sources[0]!.client.listClaimComments = async () => [];
    const plain = seed(store, worktree, "K-CG0", "running", "fix");
    await teardownTicket(deps, "K-CG0");
    expect(posted).toEqual([]);

    sources[0]!.claimGuard = { host: "mac", settleMs: 0 };
    const run = seed(store, worktree, "K-CG1", "running", "fix");
    await teardownTicket(deps, "K-CG1");
    expect(store.getRun(run.id)!.phase).toBe("done");
    expect(store.getRun(plain.id)!.phase).toBe("done");
    expect(posted).toEqual([["K-CG1", `[herdr-factory release id=${run.id} host=mac]`]]);
  });
});

// One open TUI refreshes /eligible every few seconds, on every machine, for every repo. When that
// endpoint queried the sources live it spent the whole (GitHub-account-wide) budget and delayed the
// factory's own claims — so the tick's poll is now the only reader, and the endpoint serves its
// snapshot.
describe("/eligible serves the tick's last poll — the API never queries a source", () => {
  it("empty before the first tick, the tick's items after it, and 0 source calls throughout", async () => {
    const { deps, state, calls, config } = build();
    // Two eligible items, one claim allowed per tick: A-1 is claimed (and so drops out of the
    // payload as a running row), A-2 stays in the snapshot — which is what we're after here.
    // The belt has no `match`, so both are cached; a rejected item is no longer cached at all.
    config.limits.maxClaimsPerTick = 1;
    state.eligible = [ticket("A-1"), ticket("A-2")];
    const app = createApp({
      getRepo: (name: string) => (name === "demo" ? ({ ticking: false, deps } as unknown as RepoRuntime) : undefined),
    } as unknown as ServerContext);
    const eligible = async () => (await (await app.request("/repos/demo/eligible")).json()) as unknown;
    const listed = {
      eligible: [{ source: "jira", belt: "ship", key: "A-2", summary: "Fix the thing", type: "Bug", polledAt: 1000 }],
    };

    // Nothing polled yet (a fresh process) ⇒ nothing listed, and nothing asked of the backend.
    expect(await eligible()).toEqual({ eligible: [] });
    expect(calls.eligibleQueries).toBe(0);

    await reconcileRepo(deps);
    expect(calls.eligibleQueries).toBe(1);

    // THE POINT: repeated requests are served from that one poll — the counter never moves.
    for (let i = 0; i < 3; i++) expect(await eligible()).toEqual(listed);
    expect(calls.eligibleQueries).toBe(1);

    // A failed poll must not blank the board: the last good list stands.
    state.failEligible = true;
    await reconcileRepo(deps);
    expect(calls.eligibleQueries).toBe(1); // the failing poll never reached the counter
    expect(await eligible()).toEqual(listed);
  });
});

// ── Operator rework + the tree guard (issue #66) ────────────────────────────────────────────────
// Two halves of the same incident: an operator prompted a work pane AFTER its step-done, the agent
// edited a file and left it UNCOMMITTED, and evidence filmed code that was already gone. `rework`
// is the front door the operator lacked (bounce is an AGENT's control, stamped with its own
// step/pass); the tree guard is what refuses to trust a step that never commits on a tree that
// moved under it.
describe("operator rework — the operator's counterpart to an agent bounce", () => {
  it("from a RUNNING step: stops it, opens the target's next pass, and records a `rework` event", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-RW1", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    const res = await applySignal(deps, "rework", { key: "K-RW1", toStep: "fix", reason: "the narrow viewport still clips the toast" });
    expect(res.ok).toBe(true);
    const fresh = store.getRun(run.id)!;
    expect(fresh.phase).toBe("running");
    expect(fresh.step).toBe("fix");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    expect(store.getRunStep(run.id, "fix")!.pass).toBe(2);
    const ev = store.timeline("demo", "K-RW1").find((e) => e.type === "rework");
    expect(ev, "a rework event is on the timeline").toBeTruthy();
    const detail = JSON.parse(ev!.detail ?? "{}");
    expect(detail).toMatchObject({ by: "operator", fromStep: "review", toStep: "fix", pass: 2, reason: "the narrow viewport still clips the toast" });
    // The note reaches the agent the same way a bounce's findings do: the rework banner + feedback file.
    expect(readFileSync(join(worktree, ".memory/herdr-factory/feedback-fix.md"), "utf8")).toContain("narrow viewport");
    expect(readFileSync(join(worktree, ".memory/herdr-factory/prompt-fix.md"), "utf8")).toContain("Rework requested — READ THIS FIRST");
  });

  it("from WAITING FOR HUMAN: lands anyway and closes the now-moot question", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-RW2", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    await requestHumanInput(deps, store.getRun(run.id)!, "review", "should the toast wrap?");
    expect(store.getRun(run.id)!.phase).toBe("waiting_for_human");
    const res = await applySignal(deps, "rework", { key: "K-RW2", toStep: "fix", reason: "don't wait — just make it wrap" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getRun(run.id)!.step).toBe("fix");
    expect(store.pendingHumanQuestionForRun(run.id)).toBeUndefined(); // the question can never be usefully answered now
  });

  it("from a PARKED run: lands even on a human-only park, which an agent bounce is refused from", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-RW3", "attention", "review", { attentionReason: "PR #7 closed without merging" });
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    store.recordEvent({ runId: run.id, repo: "demo", ticketKey: "K-RW3", type: "attention", detail: { reason: "pr_closed" } });
    // The agent's own bounce stays refused here (a human park needs a human decision)…
    expect((await applySignal(deps, "bounce", { key: "K-RW3", toStep: "fix", reason: "redo", step: "review", pass: 1 })).ok).toBe(false);
    // …and the human IS that decision.
    const res = await applySignal(deps, "rework", { key: "K-RW3", toStep: "fix", reason: "redo it against the new design" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getRun(run.id)!.step).toBe("fix");
    const resumed = store.timeline("demo", "K-RW3").filter((e) => e.type === "resumed").map((e) => JSON.parse(e.detail ?? "{}").reason);
    expect(resumed).toContain("rework_from_park");
  });

  it("may re-run the step that is RUNNING (a person is not bound by canBounceTo), but never a later one", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-RW4", "running", "review");
    const again = await applySignal(deps, "rework", { key: "K-RW4", toStep: "review", reason: "check the error state too" });
    expect(again.ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("review");
    expect(store.getRunStep(run.id, "review")!.pass).toBe(2);
    const forward = await applySignal(deps, "rework", { key: "K-RW4", toStep: "pr", reason: "skip ahead" });
    expect(forward.ok).toBe(false);
    expect(forward.message).toContain("goes backward");
    expect(store.getRun(run.id)!.step).toBe("review"); // untouched
  });

  it("counts toward max_bounces — an operator loop parks like an agent one", async () => {
    const { deps, store, worktree } = build(); // limits.maxBounces = 3
    const run = seed(store, worktree, "K-RW5", "running", "review");
    store.upsertRunStep(run.id, "fix", { paneId: "w1:pfix", done: true });
    for (let i = 1; i <= 3; i++) {
      expect((await applySignal(deps, "rework", { key: "K-RW5", toStep: "fix", reason: `round ${i}` })).escalated).toBeFalsy();
      await applySignal(deps, "step-done", { key: "K-RW5", step: "fix", pass: i + 1 });
    }
    const capped = await applySignal(deps, "rework", { key: "K-RW5", toStep: "fix", reason: "round 4" });
    expect(capped.escalated).toBe(true);
    expect(store.getRun(run.id)!.phase).toBe("attention");
  });

  it("is refused once the belt is over (the PR watch) and for a step that isn't in the belt", async () => {
    const { deps, store, worktree } = build();
    seed(store, worktree, "K-RW6", "reviewing", "pr", { prNumber: 7 });
    const late = await applySignal(deps, "rework", { key: "K-RW6", toStep: "fix", reason: "one more thing" });
    expect(late.ok).toBe(false);
    expect(late.message).toContain("reviewing");
    seed(store, worktree, "K-RW7", "running", "review");
    const typo = await applySignal(deps, "rework", { key: "K-RW7", toStep: "fx", reason: "typo" });
    expect(typo.ok).toBe(false);
    expect(typo.message).toContain("not in belt");
  });
});

describe("tree guard — a step that never commits must find the worktree clean", () => {
  /** A belt whose `review` step declares the read-only posture (as evidence/review do in production). */
  const readOnlyReview = (b: BeltRuntime) => { b.steps[1] = stepCfg("review", { readOnly: true }); };

  it("refuses step-done on a DIRTY tree, with the diff stat, and does not advance", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    readOnlyReview(shipBelt);
    const run = seed(store, worktree, "K-TG1", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    state.dirtyStat = " src/App.vue | 2 +-\n M src/App.vue"; // the work agent's uncommitted edit
    const res = await applySignal(deps, "step-done", { key: "K-TG1", step: "review" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("uncommitted changes");
    expect(res.message).toContain("src/App.vue"); // the stat, so the agent can see WHAT it is
    expect(store.getRunStep(run.id, "review")!.done).toBe(false);
    expect(store.getRun(run.id)!.step).toBe("review"); // no advance to pr on a stale assessment
    expect(store.timeline("demo", "K-TG1").some((e) => e.type === "step_done_refused")).toBe(true);
    // …and the operator can see why the step won't finish, without reading the agent's stderr.
    const ro = runObligations(deps, store.getRun(run.id)!).watches.guards.find((g) => g.kind === "read_only");
    expect(String(ro!.facts.treeRefusedWhy)).toContain("uncommitted changes");
  });

  // A COMMIT from a read-only step is the `read_only` WATCH's business, not this guard's: it parks
  // `read_only_violation` and is deliberately rescued by the step's own step-done (RWR-18204 — a
  // completed verdict is never thrown away over misbehaviour on the way to it). Refusing here too
  // would WEDGE that run: an agent cannot un-commit, so no action of its own could ever clear the
  // refusal. Pinned because the obvious reading of "dirty or HEAD moved" breaks the rescue — the
  // e2e `read-only-violation` scenario caught exactly that.
  it("does NOT refuse a step-done for a HEAD that moved — that park belongs to the read_only watch, which the step-done rescues", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    readOnlyReview(shipBelt);
    const run = seed(store, worktree, "K-TG2", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-baseline", basedAt: 1000 }); // frozen: this agent has taken over
    state.headSha = "sha-moved"; // the gate committed
    const res = await applySignal(deps, "step-done", { key: "K-TG2", step: "review" });
    expect(res.ok).toBe(true);
    expect(store.getRunStep(run.id, "review")!.done).toBe(true); // the verdict is recorded, not thrown away
    expect(store.timeline("demo", "K-TG2").some((e) => e.type === "step_done_refused")).toBe(false);
    // What DOES happen is the watch's own pre-advance park, whose terminal-signal rescue then
    // advances the run on a later pass (its contract, pinned by the read-only-violation e2e).
    expect(store.getRun(run.id)!.attentionReasonCode ?? null).toBe("read_only_violation");
  });

  it("never applies to a step that DOES commit — a dirty tree is that step's job", async () => {
    const { deps, store, state, worktree } = build();
    const run = seed(store, worktree, "K-TG4", "running", "fix");
    state.dirtyStat = " src/App.vue | 2 +-";
    const res = await applySignal(deps, "step-done", { key: "K-TG4", step: "fix" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("review");
  });

  it("parks instead of ADVANCING into a read-only step on a dirty tree (the incident: evidence filmed code that was about to change)", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    readOnlyReview(shipBelt);
    const run = seed(store, worktree, "K-TG5", "running", "fix");
    state.dirtyStat = " src/App.vue | 2 +-";
    const res = await applySignal(deps, "step-done", { key: "K-TG5", step: "fix" });
    expect(res.ok).toBe(true); // the work step legitimately finished…
    const fresh = store.getRun(run.id)!;
    expect(fresh.phase).toBe("attention"); // …but the next step never started
    expect(fresh.attentionReasonCode).toBe("dirty_tree");
    expect(fresh.step).toBe("fix"); // still on the completed step: the resume re-runs this advance
    const ev = store.timeline("demo", "K-TG5").find((e) => e.type === "attention" && JSON.parse(e.detail ?? "{}").reason === "dirty_tree");
    expect(JSON.parse(ev!.detail ?? "{}").stat).toContain("src/App.vue");
  });

  it("parks instead of SPAWNING a read-only step whose pass is still undispatched", async () => {
    const { deps, store, state, worktree, shipBelt } = build();
    readOnlyReview(shipBelt);
    const run = seed(store, worktree, "K-TG6", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    store.upsertRunStep(run.id, "review", { dispatchedAt: null }); // the pass never reached an agent
    state.dirtyStat = " src/App.vue | 2 +-";
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
    expect(store.getRun(run.id)!.attentionReasonCode).toBe("dirty_tree");
  });
});

describe("work item edited after the claim (issue #97)", () => {
  // The fake source's content is mutable: `content.fields` is what workContent() answers NOW, and
  // materialize writes it into ticket.json, so a refresh is observable.
  function edited(key: string) {
    const b = build();
    const content = { updated: "t0", fields: { Description: "Build the list.", "Acceptance criteria": "Shows 10 rows." } as Record<string, string> };
    const client = b.sources[0]!.client;
    client.workContent = async () => ({ updated: content.updated, fields: { ...content.fields } });
    client.materialize = async (_k, memDir) => {
      mkdirSync(memDir, { recursive: true });
      if (!existsSync(join(memDir, "ticket.json"))) writeFileSync(join(memDir, "ticket.json"), JSON.stringify(content.fields));
    };
    b.shipBelt.steps[1] = stepCfg("review", { readOnly: true });
    const run = seed(b.store, b.worktree, key, "running", "fix");
    return { ...b, content, run, mem: join(b.worktree, MEMORY_DIR) };
  }
  const claim = (deps: Deps, run: Run, src: SourceRuntime) => materializeWork(deps, run, src);

  it("a description edit between claim and review parks the run with the edited fields; resume ships as is", async () => {
    const { deps, store, content, run, mem, sources, calls } = edited("K-ED1");
    await claim(deps, run, sources[0]!);
    expect(JSON.parse(readFileSync(join(mem, "work-content.json"), "utf8")).fields.Description).toBe("Build the list.");

    content.updated = "t1";
    content.fields["Acceptance criteria"] = "Shows 10 rows. Also the messenger list.";
    const res = await applySignal(deps, "step-done", { key: "K-ED1", step: "fix" });
    expect(res.ok).toBe(true);
    const parked = store.getRun(run.id)!;
    expect(parked.phase).toBe("attention");
    expect(parked.attentionReasonCode).toBe("work_item_edited");
    expect(parked.attentionReason).toBe("ticket edited after claim: Acceptance criteria");
    expect(parked.step).toBe("fix"); // review never started: resume re-runs this advance
    // the work doc is refreshed, the claim-time copy kept, the before/after written
    expect(readFileSync(join(mem, "ticket.json"), "utf8")).toContain("messenger");
    expect(readFileSync(join(mem, "ticket.claimed.json"), "utf8")).not.toContain("messenger");
    const edits = readFileSync(join(mem, "work-item-edits.md"), "utf8");
    expect(edits).toContain("## Acceptance criteria");
    expect(edits).toContain("t0 → t1");
    expect(edits).not.toContain("## Description");
    // the operator (and whoever edited the ticket) is told the two choices on the item itself
    expect(calls.postNotes.at(-1)![1]).toContain("rework K-ED1 fix");

    expect((await resumeRun(deps, parked)).ok).toBe(true);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getRun(run.id)!.step).toBe("review"); // the acknowledged edit does not park again
  });

  it("rework from the park re-runs the work step against the new text", async () => {
    const { deps, store, content, run, sources } = edited("K-ED2");
    await claim(deps, run, sources[0]!);
    content.fields.Description = "Build the list and the applications list.";
    await applySignal(deps, "step-done", { key: "K-ED2", step: "fix" });
    expect(store.getRun(run.id)!.attentionReasonCode).toBe("work_item_edited");

    const res = await applySignal(deps, "rework", { key: "K-ED2", toStep: "fix", reason: "work item edited — see work-item-edits.md" });
    expect(res.ok).toBe(true);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getRun(run.id)!.step).toBe("fix");
    expect(store.getRunStep(run.id, "fix")!.done).toBe(false);
    await applySignal(deps, "step-done", { key: "K-ED2", step: "fix", pass: store.getRunStep(run.id, "fix")!.pass });
    expect(store.getRun(run.id)!.step).toBe("review");
  });

  it("a label/status-only change (the updated time moves, the content doesn't) does not park", async () => {
    const { deps, store, content, run, sources, mem } = edited("K-ED3");
    await claim(deps, run, sources[0]!);
    content.updated = "t9";
    await applySignal(deps, "step-done", { key: "K-ED3", step: "fix" });
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getRun(run.id)!.step).toBe("review");
    expect(existsSync(join(mem, "work-item-edits.md"))).toBe(false);
  });

  it("a failed re-read never blocks the advance", async () => {
    const { deps, store, run, sources } = edited("K-ED4");
    await claim(deps, run, sources[0]!);
    sources[0]!.client.workContent = async () => { throw new Error("jira is down (fake)"); };
    await applySignal(deps, "step-done", { key: "K-ED4", step: "fix" });
    expect(store.getRun(run.id)!.step).toBe("review");
  });
});

describe("watch-phase rework — evidence belongs to a head (issue #84)", () => {
  // A reviewing run on fix → evidence → review → pr whose gates judged `sha-ev`, then something (the
  // resolver) pushed `sha-new` to the PR. The PR is green on CI throughout.
  function reviewingRun(key: string, files: string[] | null, extra: Record<string, unknown> = {}) {
    const b = build();
    const { store, state, worktree, shipBelt } = b;
    shipBelt.steps = [stepCfg("fix"), stepCfg("evidence", { readOnly: true }), stepCfg("review", { readOnly: true }), stepCfg("pr")];
    const run = seed(store, worktree, key, "reviewing", null, { prNumber: 40, lastThreadSig: "s0", ...extra });
    for (const s of ["fix", "evidence", "review", "pr"]) store.upsertRunStep(run.id, s, { paneId: `w1:p-${s}`, done: true, dispatchedAt: 1 });
    store.upsertWatchState(run.id, "evidence", "read_only", { sig: "sha-ev", basedAt: 5 });
    store.upsertWatchState(run.id, "review", "read_only", { sig: "sha-ev", basedAt: 6 });
    state.pr = { number: 40, state: "OPEN", url: "https://gh/pr/40", headOid: "sha-new" };
    state.sig = { unresolved: 0, failing: 0, pending: 0, sig: "s0" };
    state.changedFiles = files;
    state.headSha = "sha-new"; // the worktree the resolver pushed from
    return { ...b, run };
  }

  it("a push touching src/** sends the run back through evidence → review → pr on the new head, and never says ready", async () => {
    const { deps, store, calls, run, worktree } = reviewingRun("K-84A", ["src/feature.ts", "README.md"]);
    await reconcileRun(deps, store.getRun(run.id)!);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("running");
    expect(got.step).toBe("evidence");
    expect(calls.notify, "CI green is not ready to merge while the evidence is stale").toBe(0);
    expect(store.getWatchState(run.id, "pull_request", "pr_green")?.sig ?? null).toBeNull();
    for (const s of ["evidence", "review"]) expect(store.getRunStep(run.id, s)!.done).toBe(false);
    expect(store.getRunStep(run.id, "evidence")!.pass).toBe(2);
    const note = readFileSync(join(worktree, MEMORY_DIR, "feedback-evidence.md"), "utf8");
    expect(note).toContain("sha-ev");
    expect(note).toContain("sha-new");
    expect(note).toContain("src/feature.ts");
    expect(note).toContain("superseded by sha-new");
    const ev = store.timeline("demo", "K-84A").find((e) => e.type === "rework");
    expect(JSON.parse(String(ev?.detail))).toMatchObject({ by: "pr_watch", fromStep: "pr", toStep: "evidence" });
    expect(runObligations(deps, got).evidence).toMatchObject({ evidenceHead: "sha-ev", prHead: "sha-new", stale: true });

    // The gates re-run at the new head (the spawn pinned evidence to sha-new), pr relinks and signals:
    // back in the watch, the same green head is ready to merge — once.
    expect(store.getWatchState(run.id, "evidence", "read_only")!.sig).toBe("sha-new");
    for (const s of ["evidence", "review", "pr"]) store.markStepDone(run.id, s);
    store.updateRun(run.id, { phase: "reviewing", step: null });
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
    expect(calls.notify).toBe(1);
    expect(runObligations(deps, store.getRun(run.id)!).evidence).toMatchObject({ evidenceHead: "sha-new", prHead: "sha-new", stale: false });
  });

  it("a push touching only *.md or locales/** stays in the watch and is ready to merge", async () => {
    const { deps, store, calls, run } = reviewingRun("K-84B", ["README.md", "docs/x.md", "locales/en.json", "app/locales/vi.json"]);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
    expect(calls.notify).toBe(1);
    expect(store.timeline("demo", "K-84B").some((e) => e.type === "rework")).toBe(false);
    expect(runObligations(deps, store.getRun(run.id)!).evidence).toMatchObject({ evidenceHead: "sha-ev", prHead: "sha-new", stale: false });
  });

  it("a diff git cannot compute counts as code", async () => {
    const { deps, store, run } = reviewingRun("K-84C", null);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("evidence");
  });

  it("waits for the pushing agent: an active resolver or an unfinished pr step defers the rework (and the green)", async () => {
    const { deps, store, state, calls, run } = reviewingRun("K-84D", ["src/a.ts"], { resolverActive: true });
    state.paneState = "working";
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("reviewing");
    expect(calls.notify).toBe(0);
    state.paneState = "idle"; // the resolver finished → the flag drops this pass, the rework runs next pass
    await reconcileRun(deps, store.getRun(run.id)!);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("evidence");

    const d = reviewingRun("K-84E", ["src/a.ts"]);
    d.store.upsertRunStep(d.run.id, "pr", { done: false });
    await reconcileRun(d.deps, d.store.getRun(d.run.id)!);
    expect(d.store.getRun(d.run.id)!.phase).toBe("reviewing");
    expect(d.calls.notify).toBe(0);
  });

  it("the watch rework counts toward max_bounces", async () => {
    const { deps, store, run } = reviewingRun("K-84F", ["src/a.ts"]);
    store.bumpGuardCounter(run.id, "evidence", "bounce_cap");
    store.bumpGuardCounter(run.id, "evidence", "bounce_cap");
    store.bumpGuardCounter(run.id, "evidence", "bounce_cap"); // limits.maxBounces is 3
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("attention");
  });
});

// ── The evidence gate (issue #90) ──────────────────────────────────────────────────────────────
// A PR-opening step embeds the evidence URLs, and with background uploads those URLs are printed
// before the bytes land — so the advance INTO that step waits for the run's latest publish.
describe("evidence gate — the PR-opening step waits for evidence_uploaded", () => {
  const publish = (store: Store, runId: number, key: string, prefix = "p1") =>
    store.enqueueIntent({ repo: "demo", kind: "evidence_publish", scope: `run:${runId}`, runId, ticketKey: key, dedupKey: prefix, payload: "{}", causeScope: "publisher:command", supersedeScope: true });

  it("holds the advance while the upload is pending, then advances once it is delivered", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-EG1", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    const job = publish(store, run.id, "K-EG1");
    expect((await applySignal(deps, "step-done", { key: "K-EG1", step: "review" })).ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("review"); // pr never started on bytes that haven't landed
    expect(store.getRun(run.id)!.phase).toBe("running");
    store.markIntentDelivered(job.id);
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.step).toBe("pr");
  });

  it("passes straight through when the run published nothing, and gates on the LATEST publish only", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-EG2", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    publish(store, run.id, "K-EG2", "old"); // superseded by the re-capture below
    store.markIntentDelivered(publish(store, run.id, "K-EG2", "new").id);
    expect((await applySignal(deps, "step-done", { key: "K-EG2", step: "review" })).ok).toBe(true);
    expect(store.getRun(run.id)!.step).toBe("pr");
  });

  it("parks a FAILED upload with a clear reason instead of shipping dead links", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-EG3", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    store.markIntentFailed(publish(store, run.id, "K-EG3").id, "evidence dir gone (torn down before publish)");
    await applySignal(deps, "step-done", { key: "K-EG3", step: "review" });
    const fresh = store.getRun(run.id)!;
    expect(fresh.phase).toBe("attention");
    expect(fresh.attentionReasonCode).toBe("evidence_upload_failed");
    expect(fresh.attentionReason).toContain("evidence dir gone");
    expect(fresh.step).toBe("review"); // the resume re-runs this same advance
  });

  it("parks a SUSPENDED (failing command) upload; resume retries it at once and the gate then holds for it", async () => {
    const { deps, store, worktree } = build();
    const run = seed(store, worktree, "K-EG4", "running", "review");
    store.upsertRunStep(run.id, "fix", { done: true });
    const job = publish(store, run.id, "K-EG4");
    for (let i = 0; i < 10; i++) store.recordIntentAttempt(job.id, "publish command exited 1: boom", "transient", 30);
    expect(store.getIntent(job.id)!.suspendedAt).not.toBeNull();
    await applySignal(deps, "step-done", { key: "K-EG4", step: "review" });
    expect(store.getRun(run.id)!.attentionReasonCode).toBe("evidence_upload_failed");
    expect(store.getRun(run.id)!.attentionReason).toContain("exited 1: boom");
    expect((await resumeRun(deps, store.getRun(run.id)!)).ok).toBe(true);
    expect(store.getIntent(job.id)!.suspendedAt).toBeNull(); // refundOnResume: a fresh attempt window, due now
    await reconcileRun(deps, store.getRun(run.id)!);
    expect(store.getRun(run.id)!.phase).toBe("running");
    expect(store.getRun(run.id)!.step).toBe("review"); // held again — pending, not stuck
  });
});

describe("an invalid config on disk (issue #95)", () => {
  it("pauses claims and reports the error while the file doesn't load; a fixed file resumes them", async () => {
    const { deps, store, state } = build();
    let invalid: string | null = "evidence: Unrecognized key: \"key_root\"";
    deps.configCheck = () => invalid;
    state.eligible = [ticket("C-1")];
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(0);
    expect(store.listProblems("demo")).toEqual([
      expect.objectContaining({ kind: "config", detail: expect.stringMatching(/^config invalid: evidence: Unrecognized key/) }),
    ]);

    invalid = null; // the file was fixed — no restart
    await reconcileRepo(deps);
    expect(store.countActive("demo")).toBe(1);
    expect(store.listProblems("demo")).toEqual([]);
  });

  describe("a run whose layout was never built", () => {
    let stateDir = "";
    afterEach(() => {
      delete process.env.HERDR_FACTORY_LAYOUT_STATE_DIR;
      rmSync(stateDir, { recursive: true, force: true });
    });
    function waiting() {
      stateDir = mkdtempSync(join(tmpdir(), "lh-95-"));
      process.env.HERDR_FACTORY_LAYOUT_STATE_DIR = stateDir;
      const b = build();
      b.deps.config.layouts.push({ id: "L", tabs: [{ title: "fix", panes: [{ title: "agent", persist: true, env: {}, setup: false }] }] });
      b.shipBelt.defaultLayout = "L";
      b.state.paneState = "working";
      return b;
    }

    it("an expired window builds the layout when none of its tabs exist", async () => {
      const { deps, store, state, setNow } = waiting();
      deps.herdr.tabLabels = async () => ["shell"]; // the hook built nothing
      state.eligible = [ticket("L-1")];
      await reconcileRepo(deps);
      const run = store.activeRunForTicket("demo", "jira", "L-1")!;
      setNow(1601);
      await reconcileRun(deps, store.getRun(run.id)!);
      const timeline = store.timeline("demo", "L-1");
      expect(timeline.some((e) => e.type === "layout_applied")).toBe(true);
      expect(JSON.parse(timeline.find((e) => e.type === "layout_wait_retry")!.detail ?? "{}").layoutRebuilt).toMatch(/built "L"/);
    });

    it("a workspace that has the layout's tabs is not rebuilt", async () => {
      const { deps, store, state, setNow } = waiting();
      deps.herdr.tabLabels = async () => ["fix"];
      state.eligible = [ticket("L-2")];
      await reconcileRepo(deps);
      setNow(1601);
      await reconcileRun(deps, store.getRun(store.activeRunForTicket("demo", "jira", "L-2")!.id)!);
      expect(store.timeline("demo", "L-2").some((e) => e.type === "layout_applied")).toBe(false);
    });

    it("the park names the layout hook's last line for the workspace", async () => {
      const { deps, store, state, setNow } = waiting();
      state.eligible = [ticket("L-3")];
      await reconcileRepo(deps);
      const run = store.activeRunForTicket("demo", "jira", "L-3")!;
      const { noteHookFailure } = await import("../src/core/layout-hook.ts");
      noteHookFailure("w1", "no factory repo config for /main-checkout");
      for (let t = 1601; store.getRun(run.id)!.phase !== "attention"; t += 601) {
        setNow(t);
        await reconcileRun(deps, store.getRun(run.id)!);
      }
      expect(store.getRun(run.id)!.attentionReason).toBe("fix: layout pane fix/agent never became available — layout hook: no factory repo config for /main-checkout");
    });

    it("a hook that BUILT the layout leaves the park reason as before", async () => {
      const { deps, store, state, setNow } = waiting();
      state.eligible = [ticket("L-4")];
      await reconcileRepo(deps);
      const run = store.activeRunForTicket("demo", "jira", "L-4")!;
      const { noteHookFailure } = await import("../src/core/layout-hook.ts");
      noteHookFailure("w1", "no factory repo config for /main-checkout");
      noteHookFailure("w1", null); // …then the next focus built it
      for (let t = 1601; store.getRun(run.id)!.phase !== "attention"; t += 601) {
        setNow(t);
        await reconcileRun(deps, store.getRun(run.id)!);
      }
      expect(store.getRun(run.id)!.attentionReason).toBe("fix: layout pane fix/agent never became available");
    });

    it("a successful engine rebuild clears the hook's failure line", async () => {
      const { deps, store, state, setNow } = waiting();
      deps.herdr.tabLabels = async () => ["shell"];
      state.eligible = [ticket("L-5")];
      await reconcileRepo(deps);
      const { lastHookFailure, noteHookFailure } = await import("../src/core/layout-hook.ts");
      noteHookFailure("w1", "no factory repo config for /main-checkout");
      setNow(1601);
      await reconcileRun(deps, store.getRun(store.activeRunForTicket("demo", "jira", "L-5")!.id)!);
      expect(lastHookFailure("w1")).toBeNull();
    });
  });
});
