// Shared domain types.

/**
 * A run's lifecycle position — belt-agnostic now. `running` means a belt step's agent is active
 * (which step is on `run.step`); the old per-step phases (fixing/auto_review/pr_round) collapsed
 * into it once steps became belt-defined. `reviewing` (the token-free PR watch + resolver) is
 * entered only by `work_to_pull_request` belts after their PR step; `custom` belts never reach it.
 */
export type Phase =
  | "claiming"
  | "running" // a belt step's agent is active (run.step says which)
  | "waiting_for_human" // a belt step is parked until its source returns human guidance
  | "reviewing" // work_to_pull_request only: human-review watch + resolver
  | "tearing_down"
  | "done"
  | "attention";

/** A belt step's name. Fixed (fix|review|pr) for work_to_pull_request, user-defined for custom —
 *  so it's just a string; the configured belt is the source of truth for which names are valid. */
export type StepName = string;

// merged|closed come from a PR; completed is a non-PR belt's success (last step signalled done);
// abandoned|timeout are failures.
export type Outcome = "merged" | "closed" | "abandoned" | "timeout" | "completed";

/**
 * The canonical work lifecycle, source-agnostic. Each work source maps these onto its own
 * backend: Jira maps todo/in_development/in_review onto configured Jira statuses and maps the
 * success terminals (merged/done) onto an OPTIONAL configured `done` status — unset ⇒ they stay
 * UNMAPPED (a no-op with no network call, leaving terminal closure to Jira's GitHub integration);
 * `aborted` is always unmapped for Jira. local_markdown maps all of them onto rows in the
 * `work_items` table. `done` is the terminal state for a custom (non-PR) belt's success.
 */
export type WorkState = "todo" | "in_development" | "in_review" | "merged" | "aborted" | "done";

/** Map a run Outcome to the terminal WorkState written back at teardown. */
export function outcomeToWorkState(outcome: Outcome): "merged" | "aborted" | "done" {
  switch (outcome) {
    case "merged":
      return "merged"; // PR merged
    case "completed":
      return "done"; // custom belt finished its last step
    case "closed":
    case "abandoned":
    case "timeout":
      return "aborted";
  }
}

/** Rank of a canonical WorkState in the forward lifecycle order — the basis for effect MONOTONICITY
 *  (an effect never walks the source backward). The three terminals share the top rank (a run has at
 *  most one). A belt effect targeting a custom SOURCE-NATIVE status sits just BEFORE its declared
 *  anchor stage: `workStateRank(anchor) - 0.5` (see `effectRank`) — so a QA column anchored at
 *  `in_review` ranks between `in_development` (1) and `in_review` (2). */
export function workStateRank(s: WorkState): number {
  switch (s) {
    case "todo":
      return 0;
    case "in_development":
      return 1;
    case "in_review":
      return 2;
    case "merged":
    case "done":
    case "aborted":
      return 3;
  }
}

/** The monotonicity rank of a transition target: its canonical anchor's rank, minus 0.5 when it
 *  carries a custom source-native status (that status precedes the anchor stage). Computed both for
 *  a belt effect and for an already-enqueued outbox row (`{ to: toState, status: toStatus||undefined }`). */
export function effectRank(target: { to: WorkState; status?: string }): number {
  return workStateRank(target.to) - (target.status ? 0.5 : 0);
}

export type EventType =
  | "claimed"
  | "claimed_elsewhere" // the claim guard found another factory's open claim first (no run row kept)
  | "transition"
  | "worktree_created"
  | "layout_applied" // the factory built a belt's herdr layout into a fresh worktree
  | "layout_apply_failed" // building a belt's layout failed (best-effort; the claim proceeds)
  | "worker_spawned"
  | "pr_opened"
  | "resolver_woken"
  | "worker_done"
  | "review_spawned"
  | "review_done"
  | "step_spawned"
  | "step_done"
  | "layout_wait_retry" // a layout-pane wait window expired; the engine re-armed it (bounded respawn budget)
  | "bounced"
  | "signal_queued" // a durable bounce/ask-human intent couldn't apply immediately (run lock busy) — the tick consumes it
  | "signal_rejected" // a consumed bounce/ask-human intent was invalid by the time it applied (stale/misaddressed)
  | "capture_attempt" // an evidence agent signalled a capture attempt (flaky-capture cap)
  | "evidence_uploaded" // the evidence-upload outbox delivered a capture's media to S3
  | "evidence_upload_failed" // the evidence-upload outbox hit a permanent (non-retryable) failure
  | "stale" // a write-back found the item gone at the source (deleted/transferred)
  | "intent_suspended" // a durable intent failed MAX_RETRY_ATTEMPTS times — retries stop until an operator (or a creds probe) clears it
  | "intent_fulfilled" // a waiting external-trigger intent was fulfilled (POST /intents/:id/fulfil)
  | "intent_deadline" // a waiting intent's deadline expired (kernel sweep; run-scoped ⇒ may park)
  | "human_question"
  | "human_question_moot" // the asking step reached a terminal itself; its pending question was closed unanswered
  | "human_reply"
  | "focus_applied"
  | "merged"
  | "closed"
  | "torn_down"
  | "branch_changed" // the run's worktree moved to another branch (agent rename via set-branch, or observed)
  | "belt_reassigned" // a belt was renamed; the run's belt name was migrated old → new
  | "belt_deleted" // a belt with no in-flight work was deleted; its run rows were purged (events kept)
  | "attention"
  | "resumed"
  | "error";

/** One timeline event, repo-scoped (spans every run + run-id-less admin events). The shape the
 *  foreground `run` command tails via `Store.eventsSince`. `detail` is the raw JSON string. */
export interface RepoEvent {
  id: number;
  ts: number;
  type: string;
  detail: string | null;
  ticketKey: string | null;
}

/** A single attempt at running one work item through a belt. */
export interface Run {
  id: number;
  repo: string;
  workSource: string | null; // which configured work source this run was claimed from
  belt: string | null; // which belt is processing it (its step sequence + lifecycle)
  ticketKey: string;
  summary: string | null;
  issueType: string | null;
  /** The name the run's worktree + workspace were CREATED under (the rendered `workspace_name`) —
   *  the run's stable identity on the filesystem/in herdr. Frozen at claim: it is what the layout
   *  hook matches a worktree by, and what teardown must still clean up after a rename. */
  worktreeName: string | null;
  /** The branch the run's worktree is currently on — TRACKED state, not identity. It starts as
   *  {@link Run.worktreeName} and an agent may rename it to the repo's own branch convention
   *  (`set-branch`, or a bare `git branch -m` the engine follows). Prompts, PR discovery, and
   *  branch cleanup all read THIS. */
  branch: string | null;
  phase: Phase;
  step: string | null; // the active belt step when phase === "running"
  workspaceId: string | null;
  paneId: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  /** True while this reviewing run's resolver agent is actively addressing review comments — the
   *  ONLY time a reviewing run holds a max_active_workspaces slot (idle-watching holds none). Set
   *  when a resolver is woken, cleared when its pane goes idle / the PR resolves. */
  resolverActive: boolean;
  lastThreadSig: string | null;
  attentionReason: string | null;
  /** The MACHINE reason code of the run's most recent attention escalation (step_budget /
   *  layout_wait_timeout / bounce_limit / …) — the routing key that selects a park's rescue class.
   *  First-class since v28 (it used to be JSON-parsed back out of the events log); written by
   *  escalateAttention, never cleared (reads are always guarded by phase === "attention"). */
  attentionReasonCode: string | null;
  attentionNotifiedAt: number | null; // when the operator was last notified about a parked run
  outcome: Outcome | null;
  focusPending: boolean; // active step changed; focus shift deferred until the user views this worktree
  createdAt: number; // epoch seconds
  updatedAt: number;
  endedAt: number | null;
}

/** Fields the reconciler may patch on a run. */
export type RunPatch = Partial<
  Pick<
    Run,
    | "phase"
    | "step"
    | "branch"
    | "summary"
    | "issueType"
    | "workspaceId"
    | "paneId"
    | "worktreePath"
    | "prNumber"
    | "resolverActive"
    | "lastThreadSig"
    | "attentionReason"
    | "attentionReasonCode"
    | "attentionNotifiedAt"
    | "outcome"
    | "focusPending"
  >
>;

/** One agent step of a run's pipeline (fix/evidence/review/pr for work_to_pull_request), each in its
 *  own herdr pane. Its capped-guard counters (the bounce cap, the evidence capture cap) live in the
 *  generalized `guard_counters` table keyed (run, step, guard), NOT on this row — see Store's
 *  bumpGuardCounter/guardCounter/resetGuardCounter. Likewise its watch CLOCKS (the heartbeat's
 *  progress signature, the read-only baseline) live in `watch_state` keyed (run, step, watch)
 *  since v34 — every watch owns its clock; the frozen columns here dropped in v35. */
export interface RunStep {
  id: number;
  runId: number;
  step: StepName;
  paneId: string | null;
  sessionId: string | null; // the agent's claude session id (on-demand query handle)
  done: boolean;
  startedAt: number | null;
  doneAt: number | null;
  /** When this step's pane was first CONFIRMED absent (herdr answered without it); null = believed
   *  alive. Respawn requires a second confirmed absence past the confirmation window. */
  absentAt: number | null;
  /** Which entry into this step the row's state belongs to: 1 on first entry, bumped on every
   *  RE-entry (bounce rewind, forward re-advance through a cleared intermediate). Rendered into the
   *  pass's prompt commands (--pass N) so a stale signal from a prior pass is rejectable. Crash
   *  respawns and human resumes continue the pass — no bump. */
  pass: number;
  /** When the CURRENT pass's prompt reached an agent; null = this pass still needs its dispatch.
   *  paneId can't carry this meaning — it is kept across re-entries as the pane-reuse handle — so
   *  the reconciler's spawn branch keys on this instead, routing an undispatched pass through the
   *  bounded layout-wait machinery rather than the budget watchdog. */
  dispatchedAt: number | null;
}

/** Fields the reconciler may patch on a run step. */
export type RunStepPatch = Partial<
  Pick<RunStep, "paneId" | "sessionId" | "done" | "startedAt" | "absentAt" | "pass" | "dispatchedAt">
>;

/** A durable agent-signal intent (ledger kind `agent_signal`): bounce / ask-human persisted BEFORE the run
 *  lock is attempted, so a contended or crashed apply converges on a later tick instead of being
 *  dropped (the transition-outbox pattern applied to the non-monotonic signals). At most one
 *  unconsumed intent per run — enqueue supersedes. */
export interface PendingSignal {
  id: number;
  runId: number;
  repo: string;
  ticketKey: string;
  signal: "bounce" | "ask_human";
  step: string | null; // the issuing step (bounce: the bouncer; ask_human: the asking step)
  toStep: string | null; // bounce only: the rework target
  payload: string; // bounce reason / human question
  /** The issuing step's pass stamp carried by the signal (bounce), so consume-time validation
   *  survives the queue delay; null when the signal carried none (pre-pass prompts). */
  pass: number | null;
  createdAt: number;
  consumedAt: number | null;
  consumedResult: string | null; // applied | escalated | superseded | rejected: <why>
}

/** A local_markdown work item's internally-tracked lifecycle row (the `work_items` table).
 *  This is herdr-factory's own status ledger for sources that have no external status of record. */
export interface WorkItem {
  id: number;
  repo: string;
  source: string;
  key: string;
  title: string | null;
  itemType: string | null;
  path: string | null;
  status: WorkState;
  /** The release this item was last seen/fixed on (sentry source only; null elsewhere). Drives
   *  reopening a terminal item when the same issue recurs on a different release. */
  lastRelease: string | null;
  createdAt: number;
  updatedAt: number;
}

// --- the problem ledger (the `problems` table, v37) ---------------------------
// One row per currently-OPEN mechanical problem, recorded by whatever machinery observed it and
// cleared by the same machinery on recovery. The generic structure every reporter shares: the
// dashboard reads rows, it never re-checks causes. A row's absence means "no known problem".

export interface RepoProblem {
  repo: string;
  /** Stable identity + upsert target — the CAUSE, not the observation ('source:<name>',
   *  'publisher:<type>'); a re-report refreshes detail, a clear deletes. */
  key: string;
  /** Coarse class for grouping/lights ('auth', …) — reporters choose, readers only display. */
  kind: string;
  /** Human text with the fix hint. */
  detail: string;
  createdAt: number; // first observed (preserved across re-reports)
  updatedAt: number;
}

// --- the intent ledger (the `intents` table, v29) ----------------------------
// One durable-intent substrate for the deliver lane: a row is an obligation the engine owes the
// world, retried/watched until it resolves. Behavior lives in the INTENT_KINDS registry
// (src/intents/registry.ts) — the row carries only the shared scheduling facts; everything
// kind-specific (ordering, backoff curve, delivery, run reactions) is code the kernel dispatches to.

export type IntentStatus =
  | "pending" // due-scheduled; the kernel retries it
  | "waiting" // an external-trigger row: not retried — resolved by /fulfil or its deadline
  | "delivered"
  | "superseded" // a latest-wins sibling replaced it
  | "failed" // terminal: permanent error / expired deadline
  | "abandoned"; // dropped at teardown / by an operator

/** One ledger row. `payload` is kind-owned and immutable after enqueue (re-enqueue replaces it);
 *  `state` is kind-owned MUTABLE bookkeeping (poll counters, fulfil results). The two-phase handoff
 *  columns generalize the transition outbox's stale pattern: the LOCK-FREE kernel only stamps
 *  `handoffAt`/`handoffMarker`; the run-locked Phase A consumes it exactly once (`consumedAt`). */
export interface Intent {
  id: number;
  repo: string;
  kind: string;
  /** The dedup + ordering domain: `run:<id>` | `repo` | a kind-chosen scope string. */
  scope: string;
  runId: number | null; // denormalized from a run scope (teardown/consume joins)
  ticketKey: string | null; // denormalized for logs/UI
  dedupKey: string; // idempotence within (kind, scope); "" = the kind's singleton
  /** FIFO position within the scope (= id at first enqueue; kept across re-opens so a re-opened
   *  row holds its original slot). */
  seq: number;
  payload: string; // kind-owned JSON
  state: string; // kind-owned mutable JSON
  status: IntentStatus;
  attempts: number;
  nextAttemptAt: number;
  /** Set when the row failed MAX_RETRY_ATTEMPTS times: still `pending` (the obligation stands, it
   *  keeps blocking claims and FIFO order) but the engine stops retrying it until an operator
   *  (`retry-now` / `s` on the TUI) or a cause-recovery probe clears it — which also resets
   *  `attempts` so the row gets a fresh window. */
  suspendedAt: number | null;
  leaseUntil: number | null; // in-flight lease (an inline CLI attempt vs the Phase-0 flush)
  deadlineAt: number | null; // waiting rows: escalate via handoff when it passes
  lastError: string | null;
  errorClass: "auth" | "transient" | "permanent" | "stale" | null;
  /** Recovery key for cause-scoped due-now requeues (`source:<name>`, `publisher:s3`). */
  causeScope: string | null;
  notifiedAt: number | null; // per-row operator-notify throttle
  handoffAt: number | null;
  handoffMarker: string | null;
  consumedAt: number | null;
  consumedResult: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

/** One intended source status write-back, persisted until confirmed delivered (the transition
 *  outbox). `attempts`/`nextAttemptAt` drive the reconciler's flat 30s retry; `deliveredAt`
 *  set = the source accepted it (or reported it a no-op — already there / unmapped state). */
export interface TransitionIntent {
  id: number;
  runId: number;
  repo: string;
  workSource: string;
  ticketKey: string;
  toState: WorkState;
  /** The source-native status key delivered for this intent (a belt-effect custom status); `""`
   *  for a plain canonical transition (deliver the source's mapping for `toState`). Part of the
   *  outbox uniqueness key `(run, toState, toStatus)` so a custom status and a canonical transition
   *  at the same anchor coexist. */
  toStatus: string;
  attempts: number;
  nextAttemptAt: number;
  /** Mirrors Intent.suspendedAt: the write-back failed MAX_RETRY_ATTEMPTS times and stopped
   *  retrying (it still blocks re-claiming) until an operator or cause recovery clears it. */
  suspendedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  /** Set when delivery reported the item stale (deleted/transferred). The lock-free outbox only
   *  stamps this; the run-locked Phase A reconcile consumes it (abort/park) and stamps
   *  staleHandledAt so one gone item never double-fires. */
  staleAt: number | null;
  staleHandledAt: number | null;
}

/** Stored OAuth credentials for a work source configured with auth.method: oauth (migration v19).
 *  Persisted locally per (repo, source). `expiresAt` is the access token's expiry (epoch seconds);
 *  `refreshToken` ROTATES on every refresh; `cloudId` keys the Atlassian API base
 *  (https://api.atlassian.com/ex/jira/<cloudId>). The api_token method never uses this. */
export interface SourceAuthToken {
  repo: string;
  source: string;
  method: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  cloudId: string | null;
  cloudUrl: string | null;
  scopes: string | null;
  /** The authenticated account (whoami displayName + email), captured best-effort at login; null when
   *  the read:jira-user whoami didn't run/succeed. Shown in the dashboard/CLI to identify the session. */
  accountLabel: string | null;
  createdAt: number;
  updatedAt: number;
}

export type HumanQuestionStatus = "pending" | "answered";

/** A source-agnostic human-in-the-loop question parked by an agent and resumed by the reconciler. */
export interface HumanQuestion {
  id: number;
  runId: number;
  repo: string;
  workSource: string;
  ticketKey: string;
  step: string | null;
  question: string;
  status: HumanQuestionStatus;
  externalId: string | null;
  externalCreatedAt: string | null;
  answer: string | null;
  answerExternalId: string | null;
  answerAuthor: string | null;
  pollAttempts: number; // polls that found no reply yet (drives the backoff)
  pollErrors: number; // CONSECUTIVE poll throws (reset on any successful poll); escalates past a cap
  nextPollAt: number; // don't poll the source again before this (epoch seconds; 0 = due now)
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
}

export type HumanQuestionPatch = Partial<
  Pick<HumanQuestion, "status" | "externalId" | "externalCreatedAt" | "answer" | "answerExternalId" | "answerAuthor" | "answeredAt">
>;

export interface HumanAskInput {
  repo: string;
  runId: number;
  questionId: number;
  key: string;
  step: string | null;
  question: string;
}

export interface HumanAskResult {
  externalId: string;
  externalCreatedAt?: string | null;
}

export interface HumanPollInput {
  key: string;
  questionId: number;
  externalId: string;
  externalCreatedAt?: string | null;
}

export interface HumanReply {
  body: string;
  externalId: string;
  externalCreatedAt?: string | null;
  author?: string | null;
}

/** The kind of backend a work source polls. Closed on purpose (zod config discrimination + TUI
 *  exhaustiveness); extended in exactly one place per new source. */
export type SourceType = "jira" | "local_markdown" | "github_issues" | "sentry";

/** Outcome of one transition delivery attempt. Replaces the old boolean: `applied`/`noop` were
 *  its true/false, `stale` is the state a boolean could not express — "retrying cannot help". */
export type TransitionResultKind =
  /** Backend state actually moved. Outbox: mark delivered + record a `transition` event. */
  | "applied"
  /** Nothing to do: already at the target, OR the state is UNMAPPED for this source
   *  (spec.mappedStates — unmapped MUST be decided with ZERO network), OR a write raced the
   *  backend's own automation (e.g. GitHub's Fixes-#n auto-close beat us to `merged`).
   *  Outbox: delivered, silent. */
  | "noop"
  /** The item is no longer ours: transferred, deleted, inaccessible, or preconditions destroyed.
   *  Retrying cannot help — the outbox marks the intent delivered and flags the run for the
   *  run-locked stale policy (abort/park; see reconcile). NEVER return stale for a plausibly
   *  transient failure — throw instead (throw = retry me). */
  | "stale";

export interface TransitionResult {
  kind: TransitionResultKind;
  /** Human-readable context; surfaces in the stale attention/abort messaging. */
  detail?: string;
}

/** Optional run-scoped context threaded into transition() so a source can enrich a TERMINAL
 *  write-back with facts only the engine knows. Today it carries the merged PR's number + public
 *  URL, so an internal-ledger source with an external reply channel (Sentry) can drop a "fixed by
 *  PR" note on the item at teardown. Built by the reconciler's outbox delivery from the run +
 *  resolved GitHub repo; a source that doesn't want it simply omits the parameter (every source but
 *  Sentry does). Never load-bearing — a source must behave correctly when it's absent (a retried
 *  intent for an ended run may deliver with no run to read). */
export interface TransitionContext {
  prNumber?: number | null;
  prUrl?: string | null;
}

/** Typed escape for the human-question loop: the item backing a question is gone (deleted /
 *  transferred / inaccessible). askHuman/pollHumanReply throw this instead of a generic error so
 *  the engine escalates attention instead of backing off against a nonexistent item forever. */
export class StaleItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleItemError";
  }
}

/** How the materialized work doc is described to agent prompts. `path` is RELATIVE to the run's
 *  memDir (e.g. "ticket.json", "task.md", "task/"); step.ts renders
 *  @@WORK_DOC@@ = `${MEMORY_DIR}/${path}` and @@WORK_DOC_KIND@@ = kind. */
export interface WorkDocInfo {
  path: string;
  kind: string; // e.g. "Jira ticket (JSON)", "markdown file"
}

/** One harness-evaluated watch's persisted state (`watch_state`, v34): its signature + clock, per
 *  (run, step, watch). budget: basedAt = the budget window's base; heartbeat: sig/basedAt =
 *  last-seen HEAD + when; read_only: sig = the enforcement baseline, basedAt = the freeze marker
 *  (null while tracking). `meta` is watch-owned JSON — a plugin watch stores whatever it needs
 *  without a migration. */
export interface WatchState {
  runId: number;
  step: string;
  watch: string;
  sig: string | null;
  basedAt: number | null;
  meta: string;
  updatedAt: number;
}

/** epoch-seconds clock, injected for testability. */
export type Clock = () => number;
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);

// --- step primitives: the declarative capability vocabulary ------------------
// Steps, products, guards, effects and signals are DECLARED (not hardcoded per belt_type). The
// reconciler branches on these declarations, never on a step name — mirroring how WorkSourceSpec
// keeps the source lifecycle from drifting into a second state machine. The descriptors themselves
// live in src/steps/registry.ts, src/products/registry.ts, src/signals/registry.ts.

/** The closed vocabulary of typed artifacts a step consumes/produces. A product is the hook that
 *  attaches engine machinery via the PRODUCT_CAPABILITIES registry: pull_request → PR adoption +
 *  terminal watch; evidence → the S3 upload outbox + capture-cap guard; commits → the heartbeat is
 *  meaningful; handoff → the forward handoff channel. Load-time dataflow validation checks a step's
 *  consumes are satisfied by the source or an earlier step's produces. */
export type ProductType =
  | "work_spec" // the materialized work item (source-produced at belt_start)
  | "work_raw" // the raw source payload sidecar (ticket.json / issue.json / front-matter)
  | "commits" // code committed to the branch
  | "handoff" // the cross-step handoff note — MANDATORY on every step (may be empty)
  | "evidence" // captured + published visual proof
  | "pull_request" // an opened PR (adoption identity + in_review effect + terminal watch)
  | "bounce_feedback" // rework findings sent back to an earlier step
  | "human_reply" // a human's answer to an ask-human question
  | "close_reference"; // a "Fixes #n" line for PR-body auto-close (github_issues)

/** A declared input: a product a step reads, tagged required|optional. A REQUIRED consume with no
 *  upstream producer REJECTS the belt at load; an unsatisfied OPTIONAL consume drops its prompt
 *  clause/token instead of rejecting. */
export interface InputSpec {
  type: ProductType;
  required: boolean;
}

/** The watchdog kinds a step can attach. Each GuardSpec carries its own lifecycle so a flat set
 *  can't lose the load-bearing per-guard semantics. OPEN since the plugin surface landed: a plugin
 *  watch declares its own kind (paired with registerWatchEvaluator — see core/watches.ts); the
 *  `string & {}` keeps the shipped kinds autocompleting without closing the union. */
export type GuardKind = "budget" | "heartbeat" | "read_only" | "capture_cap" | "layout_wait" | "exclusive_resource" | (string & {});

/** The engine seams at which a guard's `guard_counters` row is cleared. Every trigger is an
 *  affirmative signal the counted failure mode is over: a fresh FORWARD pass into the step (never a
 *  crash-recovery respawn — a self-crash must not refill its own cap), a successful DISPATCH (the
 *  awaited pane came up), or a human RESUME (the human judged the loop worth continuing). */
export type GuardCounterReset = "forward_entry" | "dispatch" | "resume";

/** The engine seams at which a watch's CLOCKS re-base (distinct from the counter resets above):
 *  "entry" — a (re-)entry opened for the step: the forward advance into it, or a bounce that
 *  rewinds to it / invalidates it as an intermediate (RWR-18147: a stale clock surviving a
 *  re-entry parks the run before the step ever re-runs);
 *  "resume" — a human resume of the step's park (the stale clocks are usually why it parked);
 *  "reply_resume" — a human reply resuming the SAME pass: deliberately narrower — the budget
 *  clock re-bases (the run may have waited far past it) but the read-only baseline stays frozen
 *  and the stall clock keeps its history (the agent continues, it doesn't re-enter). */
export type WatchRebaseTrigger = "entry" | "resume" | "reply_resume";

/** A watchdog attached to a step. `budget`/`heartbeat`/`layout_wait` are clock/liveness guards;
 *  `read_only` is the HEAD-move contract check on a read-only posture; `capture_cap` is the only
 *  counter guard among the shipped set (`resetOn`/`cumulative` apply to counters). The bounce cap
 *  is NOT modelled here — it is a cross-step control keyed on the bounce TARGET (see BOUNCE_CAP in
 *  steps/guards.ts); engine-universal watches with no per-step declaration (pane liveness, pass
 *  staleness) are declared in steps/engine-watches.ts. */
export interface GuardSpec {
  kind: GuardKind;
  /** Reason code recorded when this guard trips. The union of guards with autoRescueOnDone===true
   *  IS the STEP_WATCHDOG_ATTENTION set (a genuine step-done un-parks a run parked by such a guard). */
  escalationReason: string;
  /** A genuine step-done from the parked step un-parks the run. Only meaningful for guards that trip
   *  while the step's AGENT IS RUNNING (budget/heartbeat/read_only/capture_cap) — layout_wait trips
   *  before the agent exists (no pane ⇒ no agent ⇒ no step-done), so it declares false and recovers
   *  via `autoRespawnLimit` instead. */
  autoRescueOnDone: boolean;
  /** When the watch harness evaluates this guard (guards with a registered evaluator only):
   *  "watchdog" (default) — only while the step is NOT done; "pre_advance" — before the
   *  done-advance, so a violation parks even on a completed step and heals through its declared
   *  rescue with a visible trail (the read-only contract) instead of slipping through silently. */
  stage?: "pre_advance" | "watchdog";
  /** The harness holds this guard's trip while the step's agent is actively `working` — a LIVE
   *  agent is never parked by a timer (the long-horizon policy); herdr-unreachable defers the
   *  whole pass rather than judging on stale data. */
  vetoWhenWorking?: boolean;
  /** Bounded spawn-retry budget for a guard that trips BEFORE the step's agent exists (layout_wait).
   *  Each expired wait window re-arms the wait in place — and a run already parked by this guard is
   *  auto-un-parked and re-dispatched — up to this many times (counted in `guard_counters`, guard =
   *  the kind), before the park becomes a genuine human-attention park. Reset on successful dispatch
   *  and on a human `resume`. */
  autoRespawnLimit?: number;
  /** Counter guards only: the engine seams that clear this guard's counter. The engine DERIVES its
   *  reset calls from this (spawnStep's dispatch, reconcileStep's forward advance, resumeRun) —
   *  a plugin guard's counter participates in the right refunds by declaring, not by editing core. */
  resetOn?: readonly GuardCounterReset[];
  /** Clock watches only: the engine seams at which this watch's clocks re-base, applied by
   *  applyWatchRebase (core/watches.ts) at each seam — RWR-18147's hand-maintained re-base sites
   *  as data. (The dispatch-time re-base of the budget/wait clock stays in spawnStep's bookkeeping
   *  upsert — startedAt is also the layout-wait window and the per-attempt dispatch stamp.) */
  rebaseOn?: readonly WatchRebaseTrigger[];
  cumulative?: boolean;
  /** Counter guards only: the storage key for the guard's counter — always the generalized
   *  (run, step, guard) row in `guard_counters`, so two capped guards on one step never collide. */
  counterScope?: "run+step+guard";
  /** Guard attaches only when the step declares this product (heartbeat→commits, capture_cap→evidence). */
  requiresProduct?: ProductType;
  /** Guard attaches only when the step ref supplies a layout tab/pane (layout_wait). */
  attachWhen?: "layoutTarget";
  /** exclusive_resource: the machine-global lock name (capture-lock). */
  resourceName?: string;
}

/** A source-lifecycle transition, fired FORWARD-ONLY + idempotently through the transition outbox:
 *  a target <= the current source state is a noop (WorkState monotonicity). belt_start→in_development
 *  is an engine default for every belt; produce→in_review lives on the pull_request product. */
export type EffectTrigger = "belt_start" | { produce: ProductType } | { teardown: Outcome };
export interface EffectSpec {
  trigger: EffectTrigger;
  to: WorkState;
}

/** A BELT-CONFIGURED effect (the optional per-belt `effects:` block). It exposes the same three
 *  declared trigger families as the engine defaults — entering a step, producing a product, tearing
 *  down with an outcome — to config, so task progression onto source statuses becomes the user's.
 *  A belt with no effects behaves exactly as the engine defaults. Fired FORWARD-ONLY through the
 *  transition outbox (never fire-and-forget), like every other transition. */
export type BeltEffectTrigger =
  | { on: "enter"; step: string } // entering a named belt step (the first step's is belt_start)
  | { on: "produce"; product: ProductType } // a step produces a durable product (evidence | pull_request)
  | { on: "teardown"; outcome: Outcome }; // teardown reaches an outcome

/** A resolved belt effect. `to` is the canonical ANCHOR: the outbox `to_state` (CHECK-safe) and the
 *  monotonicity rank base. `status` is an OPTIONAL source-native status key — a widened jira
 *  `status.<key>` / github_issues `state_labels.<key>` entry — delivered instead of the canonical
 *  mapping for `to`. undefined `status` ⇒ a plain canonical transition to `to` (works on every
 *  source); a custom `status` is rejected at config-load for internal-ledger sources
 *  (local_markdown / sentry — those would need a work_items CHECK migration, out of scope for v1). */
export interface BeltEffect {
  trigger: BeltEffectTrigger;
  to: WorkState;
  status?: string;
}

/** The products a belt effect may fire on producing — the durable ones with a single, well-defined
 *  produce point in the pipeline. (handoff/commits are produced continuously/by every step, so they
 *  are not effect triggers.) */
export const EFFECT_PRODUCE_PRODUCTS = ["evidence", "pull_request"] as const;

/** Posture flags a step declares (and the engine enforces). */
export interface StepPosture {
  readOnly?: boolean; // declared AND enforced — HEAD movement during the step is a violation
  requiresLayout?: boolean; // materialize only when a layout tab/pane targets it (evidence opt-in)
}

/** The agent harness a factory-SPAWNED pane launches (the `agent:` config block, resolved
 *  step ?? belt ?? repo ?? {@link DEFAULT_AGENT_CONFIG} in src/config.ts). `command` is the
 *  executable and `flags` its flags; the spawned argv is `[command, ...flags, prompt]` — so
 *  `command` is argv[0], the documented `agentStart` invariant (see clients/herdr.ts). Only panes
 *  the factory spawns itself use this; a step targeting a layout pane drives whatever that pane
 *  already runs. */
/** A pane's size in terminal cells. Measured on a fresh tab's single pane (so: the tab's own box) to
 *  turn a layout's fixed `cells` sizes into exact split ratios. */
export interface PaneBox {
  cols: number;
  rows: number;
}

/** herdr's declarative pane tree (`layout.apply`'s `root`). A leaf is a pane — `label` is its herdr
 *  label (what a step's `pane:` targets), `cwd`/`env` are its shell's; a branch is a split whose
 *  `ratio` is the fraction the FIRST child keeps. Serialized straight to herdr, hence snake_case. */
export type LayoutNode =
  | {
      type: "pane";
      label?: string;
      cwd?: string;
      env?: Record<string, string>;
      /** ARGV herdr launches as the pane's process (not typed into its shell). Omit for a plain shell. */
      command?: string[];
    }
  | { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };

/** What `layout.apply`/`layout.export` echo back: the same tree, with every pane's real id. */
export type LayoutDescriptionNode =
  | { type: "pane"; pane_id?: string; label?: string | null }
  | { type: "split"; direction: string; ratio: number; first: LayoutDescriptionNode; second: LayoutDescriptionNode };
export interface LayoutDescription {
  workspace_id?: string;
  tab_id?: string;
  root: LayoutDescriptionNode;
}

/** Display-only pane state the factory publishes to herdr (`pane report-metadata`) instead of
 *  renaming panes. Every field is a decoration herdr shows next to the pane's own (untouched) label:
 *  `agentName` overrides the agent column, `title` the pane title, `tokens` are machine-readable
 *  key/values a user's `[ui.sidebar]` rows can render and an agent-view query can filter on. */
export interface PaneDisplay {
  /** The agent-name column — the factory writes `<step>:<KEY>` (what `agent rename` used to set). */
  agentName?: string;
  /** A title override. Reserved for the alarm state; cleared otherwise so the agent's own terminal
   *  title (what herdr's sidebar shows as `terminal_title_stripped`) comes back through. */
  title?: string;
  /** Clear the title override (ignored when `title` is set). */
  clearTitle?: boolean;
  /** Tokens to set; a null value CLEARS that token. */
  tokens?: Record<string, string | null>;
  /** Expire this report after N ms — for state a crashed writer must not leave behind (e.g. "setup
   *  running"). Omit for state the factory clears explicitly. */
  ttlMs?: number;
}

/** The agent kinds herdr 0.7.5 can ADOPT into a pane (`agent start --kind`, whose value set is
 *  closed — an unknown kind is rejected before anything is typed into the pane). Kept as data
 *  because the spawn strategy must be chosen BEFORE the pane is touched: a rejected adoption is
 *  recoverable, but falling back after herdr has already typed the launch command would run the
 *  harness twice. An `agent.kind` config key overrides the derivation from `command`, which is how a
 *  WRAPPED harness (`bin/my-claude`) still gets adopted. Lives here (an import-free leaf) so both
 *  the zod schema and the herdr client can name it without a cycle. */
/** Is a pane's agent sitting at its prompt, ready to receive one?
 *
 *  herdr's `agent_status` vocabulary is `idle | working | done | blocked | unknown` (plus our own
 *  "gone" when the pane holds no agent). `idle` is an agent that has not worked yet; **`done` is one
 *  that FINISHED ITS TURN** — both are waiting for input, which is why herdr's own settle wait is
 *  `--until idle --until done`. `working` is mid-turn, `blocked` is sitting on a permission prompt,
 *  and `unknown`/`gone` mean we cannot tell — none of those may be prompted into.
 *
 *  Treating only `idle` as ready is what the e2e `budget-park` scenario caught: the commonest
 *  watchdog park is an agent that finished its work without running `step-done`, which herdr reports
 *  as `done`, so `resume` silently declined to re-prompt the very agent it exists to nudge — leaving
 *  the run to burn a fresh budget and re-park. */
export function isReadyForInput(agentStatus: string): boolean {
  return agentStatus === "idle" || agentStatus === "done";
}

export const HERDR_AGENT_KINDS: readonly string[] = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode",
  "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "maki",
];

export interface AgentConfig {
  command: string;
  flags: string[];
  /** Optional herdr agent KIND (`agent start --kind`) for this harness. Only needed when `command`
   *  doesn't name one itself — a wrapper script (`bin/my-claude`) or an absolute path. Without it a
   *  non-kind `command` is typed into the pane instead of adopted, losing herdr's
   *  readiness handshake (see spawnStrategyForArgv in clients/herdr.ts). */
  kind?: string;
}

/** The historical hardcoded harness: `claude --dangerously-skip-permissions`. Used when NO
 *  `agent:` block is set at any level, so a spawned pane's argv stays byte-identical to before. */
export const DEFAULT_AGENT_CONFIG: AgentConfig = { command: "claude", flags: ["--dangerously-skip-permissions"] };

/** Where an agent→dispatcher signal is scoped — drives its route mounting, lock discipline, and
 *  which outbox (if any) it feeds. */
export type SignalScope = "run" | "machine" | "product-outbox";

// --- client domain types ----------------------------------------------------

/** Lean identity for claim + branch naming. `displayKey` is the pretty, possibly-mutable form
 *  ("#123", "ENG-123") for logs/notes ONLY — never persisted, never fed to branches or dedup
 *  (display identifiers can mutate; the canonical `key` must not — see INV-7 in deps.ts). */
export interface Ticket {
  key: string;
  summary: string;
  type: string;
  displayKey?: string; // defaults to key
  url?: string; // browser link for operator notes/logs
}

export interface JiraAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: string;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
    issuetype?: { name: string };
    labels?: string[];
    attachment?: JiraAttachment[];
    description?: unknown;
    comment?: unknown; // { comments: [{ author, created, body (ADF), … }], … }
  };
}

export interface WorktreeResult {
  workspaceId: string;
  worktreePath: string;
  paneId: string | null;
}

/** A workspace's worktree facts + freshness — the source of truth the layout event hook matches a
 *  newly-created worktree on (src/core/layout-hook.ts). */
export interface WorkspaceInfo {
  checkoutPath: string | null;
  repoRoot: string | null;
  repoName: string | null;
  isLinkedWorktree: boolean;
  tabCount: number | null;
  paneCount: number | null;
  activeTabId: string | null;
}

/** One pane as herdr lists it. The `label` is what a plugin stamps on a pane it added (a sidebar),
 *  which is how the layout hook tells plugin furniture from a pane the user opened. */
export interface PaneSummary {
  paneId: string;
  tabId: string;
  label: string | null;
}

/** The single globally-focused pane (what the user is looking at right now). */
export interface FocusedPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  label: string | null;
}

export interface Agent {
  paneId: string;
  workspaceId: string;
  tabId: string;
  agent: string;
  agentStatus: string; // idle | working | done | blocked | unknown
  cwd: string;
  sessionId: string | null; // herdr agent_session.value (the claude session id)
  /** herdr's monotonic per-pane terminal-content counter (`agent list`'s `revision`), or null when
   *  this herdr doesn't report one. Bumped whenever the pane's screen changes, which makes it the
   *  cheapest evidence that a submitted prompt actually reached the agent — see agentSend. */
  revision: number | null;
}

export type PrState = "OPEN" | "MERGED" | "CLOSED";
export interface PrInfo {
  number: number;
  state: PrState;
  url: string;
  /** When the PR was opened (epoch seconds), when the lookup carries it (`prForBranch`). A head
   *  BRANCH is not unique over time — a re-claim, or a branch renamed to the repo's convention,
   *  can resolve to a previous attempt's merged PR — so first-sighting adoption compares this
   *  against the run's own start. Absent ⇒ unknown (never treated as old). */
  createdAt?: number;
  /** A draft PR is not yet up for review. The reconciler adopts it (records the number) but does NOT
   *  hand off to the `reviewing` watch until it's marked ready-for-review — a draft keeps the
   *  step-done gate. A MERGED PR always hands off regardless. */
  isDraft: boolean;
}

export interface ReviewSig {
  unresolved: number;
  failing: number;
  sig: string;
}

/** One PR's state + review signature, as fetched by the per-tick BATCHED GraphQL query (state,
 *  threads and check rollup for every watched PR in one request instead of 3 gh calls per run). */
export interface PrSnapshot extends PrInfo {
  sig: ReviewSig;
}

// --- belt routing (the `match` predicate) -----------------------------------
// A belt may carry a `match` predicate (a `.ts` module's default export). At claim time the
// reconciler walks belts in priority order and the FIRST belt whose predicate returns true claims
// the item (a belt with no predicate accepts anything from its source). The predicate receives the
// item's metadata + its source — enough to route on without claiming first. These types are
// exported so a user's `match.ts` can import them: `import type { BeltMatch } from ".../types.ts"`.

/** The source a candidate item came from. */
export interface MatchSource {
  name: string;
  type: SourceType;
}

/**
 * A candidate work item: the rich, source-tagged metadata a source surfaces from `listEligible`.
 * Belts route on it (as `ctx.item`), and the lean Ticket used for claim + branch naming is derived
 * from it via `ticketOf` — so key/summary/type live in exactly one place.
 *
 * A GENERIC BASE, not a closed union: nothing in core switches on `sourceType` (only user
 * `match.ts` predicates do), so adding a source requires ZERO edits here. The per-source
 * interfaces below are typing conveniences for match predicates — narrow with the type guards.
 */
export interface MatchItem extends Ticket {
  sourceType: SourceType;
  /** Backend labels/tags; [] when the concept doesn't exist — uniform so belt predicates can
   *  route on labels without knowing the source type. */
  labels: string[];
  /** Raw source-native payload (Jira issue.fields, the REST issue object, front-matter, …). */
  fields: Record<string, unknown>;
}

/** A Jira candidate. `fields` is the raw Jira issue.fields object (summary/status/issuetype/…). */
export interface JiraMatchItem extends MatchItem {
  sourceType: "jira";
  status: string; // current Jira status name
}

/** A local_markdown candidate. `labels` come from a front-matter `labels:` array (else []);
 *  `fields` is the parsed front-matter object. */
export interface LocalMarkdownMatchItem extends MatchItem {
  sourceType: "local_markdown";
  path: string; // the .md file or directory backing this item
  filename: string; // basename of `path`
  frontMatter: Record<string, unknown>; // parsed YAML front-matter ({} when none)
  body: string; // the markdown body (front-matter stripped)
}

/** A github_issues candidate. `fields` is the raw REST issue object. */
export interface GithubIssuesMatchItem extends MatchItem {
  sourceType: "github_issues";
  number: number; // === Number(key)
  repo: string; // "owner/name" the issue lives in (may differ from the PR repo)
  state: "open"; // listEligible only surfaces open issues
  assignees: string[];
  author: string | null;
  body: string; // raw markdown body, for match predicates
}

/** A Sentry candidate. `key` is the Sentry issue's numeric id (stable/immutable — INV-7 safe);
 *  `displayKey` is the shortId (e.g. "BACKEND-1AB"). `fields` is the raw Sentry issue object.
 *  Environment is NOT a Sentry issue field (an issue aggregates events across environments — it's
 *  filtered at poll time via the source's `environment` config), so it's absent here. */
export interface SentryMatchItem extends MatchItem {
  sourceType: "sentry";
  shortId: string | null; // human id, project-prefixed (also MatchItem.displayKey)
  project: string; // the issue's project slug
  status: string; // Sentry issue status: unresolved | resolved | ignored
  level: string | null; // error | warning | fatal | info | debug
  culprit: string | null; // Sentry's picked code location
  count: number | null; // total event count for the issue
  userCount: number | null; // distinct users affected
  permalink: string | null; // issue URL in the Sentry UI (also MatchItem.url)
}

export const isJiraItem = (i: MatchItem): i is JiraMatchItem => i.sourceType === "jira";
export const isLocalMarkdownItem = (i: MatchItem): i is LocalMarkdownMatchItem => i.sourceType === "local_markdown";
export const isGithubIssuesItem = (i: MatchItem): i is GithubIssuesMatchItem => i.sourceType === "github_issues";
export const isSentryItem = (i: MatchItem): i is SentryMatchItem => i.sourceType === "sentry";

export interface MatchContext {
  item: MatchItem;
  source: MatchSource;
}

/** The shape of a belt's `match.ts` default export. May be sync or async. */
export type BeltMatch = (ctx: MatchContext) => boolean | Promise<boolean>;

/** The lean Ticket every candidate carries — for claim + branch naming (MatchItem IS a Ticket). */
export function ticketOf(item: MatchItem): Ticket {
  return { key: item.key, summary: item.summary, type: item.type, displayKey: item.displayKey, url: item.url };
}
