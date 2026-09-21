import type { BeltConfig, Config } from "../config.ts";
import type { Store } from "../db/store.ts";
import type { MachineConfig } from "../machine.ts";
import type {
  Agent,
  BeltMatch,
  FocusedPane,
  HumanAskInput,
  HumanAskResult,
  HumanPollInput,
  HumanReply,
  LayoutNode,
  MatchItem,
  PaneBox,
  PaneDisplay,
  PaneSummary,
  PrInfo,
  PrSnapshot,
  ReviewSig,
  SourceType,
  Ticket,
  TransitionContext,
  TransitionResult,
  WorkDocInfo,
  WorkspaceInfo,
  WorkState,
  WorktreeResult,
} from "../types.ts";

// Interfaces the core depends on (concrete clients satisfy them structurally;
// tests provide fakes). Keeping these here is what makes the reconciler testable.

/**
 * herdr could not be queried (CLI failure, timeout, daemon restart). Deliberately DISTINCT from
 * "herdr answered and the pane is absent": conflating the two is what used to make one herdr
 * hiccup look like every pane dying at once — and the recovery action (respawn) would put a
 * duplicate agent into a worktree whose original agent was still working. Liveness callers must
 * treat this as "unknown — defer", never as "dead".
 */
export class HerdrUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`herdr unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HerdrUnreachableError";
  }
}

/** Liveness lookups accept `fresh: true` to bypass the client's short memo — used to CONFIRM an
 *  absence before acting on it (a stale cached list must never trigger a respawn). */
export interface LivenessOpts {
  fresh?: boolean;
}

export interface HerdrApi {
  worktreeCreate(repoCwd: string, branch: string, baseRef: string): Promise<WorktreeResult>;
  worktreeOpen(repoCwd: string, branch: string): Promise<WorktreeResult>;
  worktreeRemove(workspaceId: string): Promise<void>;
  workspaceClose(workspaceId: string): Promise<void>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  /** THROWS HerdrUnreachableError when herdr can't be queried; "gone" means confirmed absent. */
  paneState(paneId: string, opts?: LivenessOpts): Promise<string>;
  /** THROWS HerdrUnreachableError when herdr can't be queried; false means confirmed absent. */
  paneAlive(paneId: string, opts?: LivenessOpts): Promise<boolean>;
  agentSessionId(paneId: string): Promise<string | null>;
  tabPaneByLabel(workspaceId: string, tabLabel: string, paneLabel: string): Promise<string | null>;
  /** Create a pane and bring the harness up in it (herdr 0.7.5: WE create the pane, herdr adopts the
   *  agent into it — see the client's doc). null ⇒ it couldn't be brought up; nothing was left behind. */
  agentStart(opts: {
    workspaceId: string;
    cwd: string;
    argv: string[];
    env?: Record<string, string>;
    /** herdr AGENT name — `[a-z][a-z0-9_-]{0,31}`, unique among live agents (herdr's rule). */
    name?: string;
    kind?: string;
    /** Hook to wait for the new pane's shell prompt before the agent is started into it. */
    awaitShell?: (paneId: string) => Promise<void>;
  }): Promise<string | null>;
  /** Start `kind` in an EXISTING pane (a layout's agent pane). true ⇒ herdr says it's ready for input. */
  agentAdopt(paneId: string, opts: { name: string; kind: string; args?: readonly string[]; timeoutMs?: number }): Promise<boolean>;
  /** The last `agent start` failure text (herdr's machine-readable code + message, e.g.
   *  `agent_not_ready: … blocked during startup`) — logged verbatim when a start fails, because it is
   *  what tells a trust prompt apart from a missing binary or a busy pane. Optional: a fake that
   *  doesn't track it just reports no detail. */
  readonly lastAgentError?: string | null;
  /** A layout pane's opening `prompt:` — waits for the agent to settle only when a timeout is given. */
  agentOpenPrompt(target: string, text: string, opts?: { settleTimeoutMs?: number }): Promise<boolean>;
  /** Is the pane at an available shell prompt (what `agent start` requires)? One sample; callers poll. */
  paneAtShellPrompt(paneId: string): Promise<boolean>;
  paneRun(paneId: string, command: string): Promise<void>;
  paneClose(paneId: string): Promise<void>;
  // Layout building (absorbed from workspace-manager); driven by src/core/layout.ts.
  tabCreate(workspaceId: string, opts: { label?: string; cwd?: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }>;
  tabRename(tabId: string, label: string): Promise<void>;
  /** Build a whole tab's pane tree in ONE call; returns the tab id + its panes IN TREE ORDER. */
  layoutApply(opts: { workspaceId?: string; tabId?: string; tabLabel?: string; root: LayoutNode }): Promise<{ tabId: string; paneIds: string[] }>;
  /** The cell area of a pane's TAB (null if unknown) — measured once before a build to size `cells`. */
  tabArea(paneId: string): Promise<PaneBox | null>;
  /** The workspace's first (root) tab id — the tab a fresh worktree comes up with. */
  firstTabId(workspaceId: string): Promise<string | null>;
  // Introspection for the layout event hook (src/core/layout-hook.ts).
  workspaceInfo(workspaceId: string): Promise<WorkspaceInfo | null>;
  worktreeBranch(workspaceId: string, checkoutPath?: string | null): Promise<string | null>;
  firstPaneOfTab(workspaceId: string, tabId: string): Promise<string | null>;
  /** Every pane in a workspace with its label — the hook's freshness re-check ignores plugin panes. */
  listPanes(workspaceId: string): Promise<PaneSummary[]>;
  /** Submit a prompt to a pane's agent (atomic: types + Enter). `confirm` waits for herdr to observe
   *  the agent react, falling back to the pane's `revision` when herdr's own state detection never
   *  flips (cursor-agent reports `idle` while it works), and returns false only when the pane showed
   *  no sign of the submission at all — the prompt never landed. */
  agentSend(paneId: string, text: string, opts?: { confirm?: boolean }): Promise<boolean>;
  agentFocus(paneId: string): Promise<void>;
  focusedPane(): Promise<FocusedPane | null>;
  /** Publish display-only run state on a pane (never renames it) — see core/pane-display.ts. */
  reportPaneDisplay(paneId: string, d: PaneDisplay): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}

/** Declarative ownership/capability record for a work source. Consumed by doctor, the TUI, and
 *  the shared contract test suite — the reconciler never branches on it for LIFECYCLE (so it
 *  cannot drift into a second state machine); its one engine read is report ROUTING:
 *  `replyChannel === "file"` sends work-error attention notes to the run's pane instead of
 *  `postNote` (a note file in a hidden folder is where nobody looks). Must be constant for the
 *  instance's lifetime. */
export interface WorkSourceSpec {
  /** "external": the backend owns lifecycle (Jira statuses, GitHub labels/open-closed) and the
   *  source MUST NEVER touch the work_items table (db/migrate.ts v6 comment).
   *  "internal": herdr-factory's work_items table owns it (local_markdown). */
  statusOfRecord: "external" | "internal";
  /** The WorkStates transition() actually writes. Everything else must be a network-free noop —
   *  the contract suite asserts it. */
  mappedStates: readonly WorkState[];
  /** How human replies arrive — scopes the contract suite's marker tests (comment-stream sources
   *  must filter their own artifacts; file-channel sources read a dedicated answer section). */
  replyChannel: "comments" | "file";
  /** Note when terminal convergence is (partly) owned by backend automation — display only. */
  terminalAutomation?: string;
}

/** A source's LOCAL credential readiness — the proactive, no-network view answered by
 *  `WorkSource.authStatus()`. "not_applicable" is a source with no auth at all (local_markdown).
 *  It does NOT prove the credentials WORK against the backend; a present-but-rejected credential is
 *  reported reactively as a SourceUnauthenticatedError from the first real call that 401/403s. */
export interface SourceAuthStatus {
  state: "ok" | "unauthenticated" | "not_applicable";
  /** Actionable remediation when unauthenticated (which env key to set / which command to run). */
  detail?: string;
}

/** Every artifact a source writes to its reply channel carries this visible prefix, and reply
 *  polling skips artifacts bearing it (INV-6). Shared so all sources mark and filter uniformly. */
export const HERDR_MARKER = "[herdr-factory";

/** INV-6's filter primitive: does this comment body carry the herdr marker OUTSIDE blockquotes?
 *  Quote-reply UIs (GitHub's "Quote reply") prepend the question — marker included — as `> ` lines
 *  into a genuine human reply; a marker appearing only inside quotes must NOT disqualify it. */
export function bearsHerdrMarker(body: string): boolean {
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .some((line) => line.includes(HERDR_MARKER));
}

/**
 * A polymorphic source of work (Jira board, folder of markdown, GitHub issues, …). The reconciler
 * speaks ONLY this interface + the canonical WorkState lifecycle (types.ts) — each implementation
 * maps them onto its own backend. Construction (backend config / Store handle / secrets) lives in
 * the concrete clients.
 *
 * THE CHARTER — numbered invariants every implementation must uphold, enforced by
 * test/work-source-contract.test.ts:
 *
 * INV-1  RE-CLAIM CONVERGENCE: whatever listEligible filters on MUST be moved by a delivered
 *        transition(in_development | terminal). The engine's only other guards — an active run
 *        for (source, key) and a pending write-back — eventually clear, after which a still-listed
 *        item is claimed again and the work re-done. When the filter is the per-belt `pickupLabel`
 *        (passed to listEligible), the SAME label is passed to transition so in_development can
 *        clear it (github_issues consumes the trigger label; jira moves status instead).
 * INV-2  transition is IDEMPOTENT and retry-safe: the outbox re-calls it after partial failures,
 *        strictly in-order per run. applied/noop/stale = delivered; throw = retry with 60s→1h
 *        backoff, never abandoned.
 * INV-3  UNMAPPED states cost ZERO network (see TransitionResultKind "noop"). Reads to establish
 *        "already converged" for a MAPPED state are allowed.
 * INV-4  materialize is IDEMPOTENT (no-op once the primary doc exists) and BEST-EFFORT (log,
 *        never throw) — it re-runs on EVERY claiming tick. Sanitize untrusted text for prompt use
 *        (strip HTML comments + invisible chars; keep the raw payload in a sidecar). Never promise
 *        complete media capture.
 * INV-5  askHuman returns a DURABLE externalId (+ createdAt when available); it is re-invoked
 *        every tick until an externalId is persisted, so it SHOULD be idempotent per questionId
 *        (search for the question marker before posting). Throw StaleItemError when the item is
 *        gone.
 * INV-6  SELF-AUTHORSHIP: every artifact the source writes to the reply channel (questions, notes)
 *        MUST carry the visible HERDR_MARKER prefix, and pollHumanReply MUST skip marker-bearing
 *        artifacts (via bearsHerdrMarker — blockquote-aware, so a quote-reply that embeds the
 *        question still counts as a reply). Author-identity filtering is NEVER load-bearing: with
 *        shared credentials (gh CLI) the bot login IS the operator's login, and author filtering
 *        would silently swallow the operator's genuine replies.
 * INV-7  KEYS are opaque, stable for the item's life, unique within the source, and safe as: a
 *        single unquoted shell token (step-done ${key}), a git ref segment (branch.ts does NOT
 *        strip '#'/'/'), and a URL path segment (evidence S3 key). Sources enforce this at
 *        listEligible (skip + warn on unsafe keys). Prefer the backend's immutable id over mutable
 *        display identifiers (put those in Ticket.displayKey). summary/type must be non-empty.
 * INV-8  BRING YOUR OWN rate limiting + hard timeouts (token bucket, Retry-After). The engine only
 *        shapes volume (once-per-tick listEligible, claim admission, poll/outbox backoffs). A hung
 *        call wedges the whole reconcile tick.
 * INV-9  The configured source NAME (name ?? type, unique per repo) is the durable FK on
 *        runs/intents/questions. Renames strand in-flight runs — treat names as append-only. The
 *        default jira source keeps the name "jira" (db/migrate.ts v6 backfill invariant).
 * INV-10 SINGLE FACTORY PER SOURCE BACKEND unless the source's claim guard is enabled: claiming is
 *        arbitrated by the local store under the tick lock; source-side markers (labels, statuses)
 *        are PROJECTIONS of the claim, not locks. Two factories with separate DBs on one backend
 *        double-claim — UNLESS the source implements postClaimComment/listClaimComments and the
 *        config enables `claim_guard`, in which case core/claim-guard.ts arbitrates on the item's
 *        comment ledger (lowest open claim comment id wins; a dead winner is fenced, never reaped).
 * INV-11 describe MAY accept alternate identifiers but MUST return the canonical key — the engine
 *        re-checks active-run dedup against the RETURNED key before claiming.
 * INV-13 CUSTOM STATUSES map at the SOURCE LAYER. A belt effect may target a source-native status
 *        (`transition`'s `statusOverride`) beyond the canonical WorkState set — the engine's
 *        vocabulary stays the six canonical states; the source maps the extra NAME to its backend
 *        status. A source declares which extra keys it supports via SourceDescriptor.customStatusKeys
 *        (empty ⇒ internal-ledger sources reject custom effects at config-load); every override
 *        reaching transition() was validated against that set at load, so it costs no network to reject.
 */
export interface WorkSource {
  /** Declarative capabilities/ownership. Cheap, constant, side-effect free. */
  readonly spec: WorkSourceSpec;
  /** INV-12  AUTH IS OBSERVABLE: report LOCAL credential readiness cheaply and with ZERO network
   *  (creds present / bootstrappable), so the engine can pause + surface an unauthenticated source
   *  BEFORE a call fails. A present-but-rejected credential need not be caught here — it surfaces
   *  when a real call throws SourceUnauthenticatedError (which every network method MUST throw for a
   *  missing credential or a 401/403, never a generic Error). A source with no auth returns
   *  not_applicable. The reconciler pauses claims + write-backs for an unauthenticated source and
   *  auto-resumes them once a call succeeds again — so this must be truthful and stable. */
  authStatus(): Promise<SourceAuthStatus>;
  /** A BOUNDED batch of eligible (todo) items in claim order — need not be exhaustive (claims are
   *  admission-capped per tick anyway); [] when there's none. MAY throw on hard backend failure:
   *  every caller try/catches per source and degrades to [], so one source's outage never starves
   *  the others. MUST exclude items the factory already moved (INV-1), items that are not
   *  claimable work, and items whose keys violate INV-7 (skip + warn). `pickupLabel` is the calling
   *  belt's `label` (see config's descriptor.pickupLabel): a label-driven source filters on it
   *  server-side and MUST honour it (a distinct belt polls the same source with a distinct label);
   *  a source with no label concept ignores it. */
  listEligible(pickupLabel?: string): Promise<MatchItem[]>;
  /** Metadata for one item by key (the manual `claim` path). THROWS for unknown keys, including
   *  "exists but is not claimable work". INV-11. */
  describe(key: string): Promise<Ticket>;
  /** Move an item to a canonical lifecycle state. See TransitionResult + INV-1..3. Never reverse
   *  the backend's own automation (never reopen a closed issue). `pickupLabel` is the run's belt's
   *  `label`, threaded so a label-driven source can clear what listEligible filtered on (INV-1;
   *  github_issues consumes the trigger label on in_development). Undefined when the belt is gone
   *  or the source has no label concept. `ctx` carries optional run-scoped facts for a terminal
   *  write-back (the merged PR number/URL — see TransitionContext); a source that doesn't need it
   *  ignores the parameter, and every impl MUST behave correctly when it is absent.
   *  `statusOverride` (INV-13) is a belt effect's SOURCE-NATIVE status key — a widened jira
   *  `status.<key>` / github_issues `state_labels.<key>` entry — to move to INSTEAD of the canonical
   *  mapping for `to` (`to` stays the anchor the engine ranks/records; only the delivered backend
   *  status differs). It is always one this source declared (validated at config-load), so it never
   *  needs a network read to reject; a source with no custom-status support (internal-ledger) never
   *  receives one (rejected at load) and MUST behave identically to the no-override path if it ever does. */
  transition(key: string, to: WorkState, pickupLabel?: string, ctx?: TransitionContext, statusOverride?: string): Promise<TransitionResult>;
  /** Write the item's work doc (+ any media) into `memDir` for the fix agent. INV-4. */
  materialize(key: string, memDir: string, log: Logger): Promise<void>;
  /** Describe what materialize wrote (drives @@WORK_DOC@@/@@WORK_DOC_KIND@@). Local-fs-only (may
   *  stat memDirAbs to disambiguate layouts, e.g. task/ vs task.md), never throws, NO network;
   *  must return a sensible default before materialize has run. Async ONLY because every client
   *  is wrapped by instrumentObject's async telemetry proxy — a sync method through the Proxy
   *  would return a Promise typed as its value. */
  workDoc(memDirAbs: string): Promise<WorkDocInfo>;
  /** Post a source-native informational note on the item (Jira comment, local marker file, …).
   *  Operator-facing events only — best-effort, no reply expected, and MARKER-TAGGED (INV-6). */
  postNote(key: string, note: string): Promise<void>;
  /** Post a source-native question for a human. INV-5. MAY throw — posting is retried every tick
   *  until an externalId is stored; StaleItemError when the item is gone. */
  askHuman(input: HumanAskInput): Promise<HumanAskResult>;
  /** Poll the source for a human reply to a previously-posted question. null = none yet (drives
   *  the 60s→5min poll backoff). Anchor on externalId with externalCreatedAt as the deleted-anchor
   *  fallback; assume only append + created-after scan — never thread structure. Drop
   *  marker-bearing artifacts per INV-6 and anything created at/before the question (also guards
   *  the edited-old-comment trap — hence "reply in a NEW comment"). Throws are tolerated (counted
   *  as a poll error with backoff) but must not be routine; StaleItemError escalates. */
  pollHumanReply(input: HumanPollInput): Promise<HumanReply | null>;
  /** Throw with an ACTIONABLE message when misconfigured/unreachable (the `doctor` per-source
   *  check): bad auth vs missing repo vs missing label — say which. `pickupLabels` are the labels
   *  of every belt feeding this source (deduped by the caller); a label-driven source checks each
   *  one is usable, a source with no label concept ignores them. */
  health(pickupLabels?: string[]): Promise<void>;
  /** OPTIONAL claim-ledger hooks (INV-10), implemented only by comment-bearing sources. Post a raw
   *  marker comment (the body already carries HERDR_MARKER, so reply polling ignores it — INV-6). */
  postClaimComment?(key: string, body: string): Promise<void>;
  /** The item's recent comments with their SERVER-ASSIGNED numeric ids (the ledger's tie-break).
   *  Must include the newest comments; ordering is irrelevant. */
  listClaimComments?(key: string): Promise<{ id: string; body: string }[]>;
}

/** A configured source's identity + its live client. Resolved from `run.workSource` (or a belt's
 *  `source`) and threaded through the reconciler for materialize / lifecycle transitions. */
export interface SourceRuntime {
  name: string;
  type: SourceType;
  client: WorkSource;
  /** How often to poll this source for new work (Phase B `listEligible`), in seconds. */
  pollIntervalSeconds: number;
  /** Per-source concurrency cap: the most WORKED workspaces this source may hold in flight at once,
   *  summed across every belt that pulls from it (Phase B stops claiming from it once reached). */
  maxActiveWorkspaces: number;
  /** Last poll time per pickup label (key = `label ?? ""`), epoch SECONDS (matches `deps.now()`).
   *  Mutable, in-memory only —
   *  it lives on the long-lived per-repo runtime, so serve/watch honor the interval across ticks;
   *  a fresh process (one-shot `tick`) starts empty and polls immediately (harmless). Read/written
   *  by the reconciler's Phase B poll gate. */
  lastPolledAt: Map<string, number>;
  /** The last SUCCESSFUL poll's items per pickup label (same key as `lastPolledAt`), with the epoch
   *  SECONDS it was taken. Written by the reconciler's Phase B poll, read by the server's `/eligible`
   *  — which must never query a source itself: one open TUI polling every 3s would spend the whole
   *  (account-wide) GitHub budget and starve the tick's own claims. In-memory, so a fresh process
   *  serves nothing until its first tick. A failed, gated or held poll leaves the last good list. */
  lastEligible: Map<string, { items: MatchItem[]; at: number }>;
  /** The resolved claim guard (INV-10); undefined ⇒ disabled, claiming is local-store only. */
  claimGuard?: { host: string; settleMs: number };
}

/** A configured belt's resolved config + its loaded `match` predicate (undefined = accept all from
 *  its source). This is the unit the reconciler drives: its ordered `steps`, and `watchPr` (true ⇒
 *  run the token-free PR-watch after the last step). Resolved per run from `run.belt`. */
export interface BeltRuntime extends BeltConfig {
  match?: BeltMatch;
}

export interface GitHubApi {
  prForBranch(repo: string, branch: string): Promise<PrInfo | null>;
  prByNumber(repo: string, prNumber: number): Promise<PrInfo | null>;
  reviewSignature(repo: string, prNumber: number): Promise<ReviewSig>;
  /** Batched state + review signature for many PRs (one GraphQL request per ~25) — the per-tick
   *  bulk fetch for every reviewing/attention run. Unresolvable PRs are absent from the map. */
  prSnapshots(repo: string, prNumbers: number[]): Promise<Map<number, PrSnapshot>>;
  /** The authenticated gh user's login (memoized); null if it can't be determined. */
  currentLogin(): Promise<string | null>;
}

export interface GitApi {
  branchExists(repoCwd: string, branch: string): Promise<boolean>;
  /** Fetch one remote branch into the checkout a worktree is about to be cut from. Bounded and
   *  prompt-free; false ⇒ the fetch failed (offline, no credentials, timeout) and the local ref
   *  stands. Never throws — a claim must not depend on the network. */
  fetchRef(repoCwd: string, remote: string, branch: string): Promise<boolean>;
  /** Human-readable age of `ref`'s tip commit ("4 days ago"), null when unresolvable. */
  refAge(repoCwd: string, ref: string): Promise<string | null>;
  /** The branch a checkout is currently ON (null ⇒ detached/unresolvable) — the run's branch is
   *  tracked from this, never assumed to still be the name minted at claim time. */
  currentBranch(repoCwd: string): Promise<string | null>;
  /** Is there a remote-tracking ref for `branch` (was it pushed)? Local-only, no network. */
  remoteBranchExists(repoCwd: string, branch: string): Promise<boolean>;
  /** `git branch -m` the checkout's current branch to `to`; false ⇒ git refused. */
  branchRename(repoCwd: string, to: string): Promise<boolean>;
  /** Delete a local branch; resolves to whether it's gone afterward (false ⇒ still present even
   *  after force-removing any worktree still on it — the caller should surface that). */
  branchDelete(repoCwd: string, branch: string): Promise<boolean>;
  worktreePrune(repoCwd: string): Promise<void>;
  originUrl(repoCwd: string): Promise<string>;
  headSha(repoCwd: string): Promise<string | null>;
  /** The worktree's uncommitted work as a diff stat (+ the porcelain listing, which is the only
   *  one that shows untracked files), or null when the tree is clean — the tree guard's input. */
  dirtyStat(repoCwd: string): Promise<string | null>;
  /** `git diff --stat <range>` — what moved between two commits ("" when unresolvable). */
  diffStat(repoCwd: string, range: string): Promise<string>;
}

export type Logger = (level: "info" | "warn" | "error", msg: string) => void;

export interface Deps {
  config: Config;
  /** The per-repo env file (auth secrets etc.) as a raw map; which keys matter is declared by
   *  each source descriptor's secrets manifest. */
  env: Readonly<Record<string, string>>;
  store: Store;
  ghRepo: string; // resolved owner/name
  herdr: HerdrApi;
  sources: SourceRuntime[]; // configured work sources
  resolveSource(name: string | null): SourceRuntime | undefined; // by run.workSource; total
  belts: BeltRuntime[]; // configured belts, ordered by priority (asc)
  resolveBelt(name: string | null): BeltRuntime | undefined; // by run.belt; total
  github: GitHubApi;
  git: GitApi;
  log: Logger;
  now: () => number; // epoch seconds
  uid: () => string; // short unique suffix for a run's branch (distinct per claim; see branchName)
  sleep: (ms: number) => Promise<void>;
  rmrf: (path: string) => Promise<void>; // recursive force delete (teardown's defensive dir cleanup)
  /** Host-local machine.yml limits (absent ⇒ no machine gate). Re-read by every buildDeps, so `reload` picks up edits. */
  machine?: MachineConfig;
  /** Available-memory reader (MB) for the machine memory gate; tests inject it. Absent ⇒ availableMemoryMb(). */
  availableMemoryMb?: () => number;
  /** Kill whatever LISTENs on a TCP port and return the pids that held it — teardown's dev-server
   *  reap (hf-port handshake). Tests inject it so no test ever signals a real process.
   *  Absent ⇒ killPortListeners() from core/dev-server.ts. */
  killPortListeners?: (port: number) => Promise<number[]>;
}

export type { Agent };
