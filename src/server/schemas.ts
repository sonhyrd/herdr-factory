// Zod request/response schemas + OpenAPI route definitions for the server. These drive BOTH the
// runtime request validation (params/query/body, via @hono/zod-openapi) AND the generated OpenAPI
// document served at /doc (rendered by Swagger UI at /ui). Handlers live in app.ts.
import { createRoute, z } from "@hono/zod-openapi";

// ---- shared ---------------------------------------------------------------
export const RepoParam = z.object({
  repo: z.string().openapi({ param: { name: "repo", in: "path" }, example: "reckon-frontend" }),
});

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");
const OkResponse = z.object({ ok: z.boolean() }).openapi("Ok");

/** Shared error response entry (400/404/500 all return `{ error }`). */
const errResp = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
/** The three error responses every repo-scoped route can produce. */
const repoErrors = {
  400: errResp("Invalid request"),
  404: errResp("Repo not configured"),
  500: errResp("Server error"),
};

// ---- response bodies ------------------------------------------------------
const HealthResponse = z
  .object({
    ok: z.boolean(),
    version: z.string(),
    pid: z.number(),
    startedAt: z.number(),
    uptimeSec: z.number(),
    repos: z.array(
      z.object({
        name: z.string(),
        active: z.number(),
        lastTickAt: z.number().nullable(),
        tickStale: z.boolean(),
      }),
    ),
  })
  .openapi("Health");

const ReloadResponse = z
  .object({
    ok: z.boolean(), // false ⇒ at least one configured repo failed to load (see failures)
    repos: z.array(z.string()),
    failures: z.array(z.object({ name: z.string(), error: z.string() })),
  })
  .openapi("Reload");
const TickResponse = z.object({ ran: z.boolean() }).openapi("Tick");
const StepDoneResponse = z
  .object({ ok: z.boolean(), advanced: z.boolean().optional(), message: z.string().optional() })
  .openapi("StepDone");
const AskHumanResponse = z
  .object({ ok: z.boolean(), questionId: z.number().optional(), posted: z.boolean().optional(), queued: z.boolean().optional(), message: z.string().optional() })
  .openapi("AskHuman");
const BounceResponse = z
  .object({ ok: z.boolean(), escalated: z.boolean().optional(), queued: z.boolean().optional(), message: z.string().optional() })
  .openapi("Bounce");
// set-branch: the branch the run's worktree ended up on, plus a message the agent surfaces (an
// idempotent no-op, a refusal, or a warning that the OLD branch was already pushed).
const SetBranchResponse = z
  .object({ ok: z.boolean(), branch: z.string().optional(), message: z.string().optional() })
  .openapi("SetBranch");
const CaptureAttemptResponse = z
  .object({ ok: z.boolean(), attempts: z.number().optional(), escalated: z.boolean().optional(), message: z.string().optional() })
  .openapi("CaptureAttempt");
const ResumeResponse = z.object({ ok: z.boolean(), phase: z.string().optional(), message: z.string().optional() }).openapi("Resume");
// `requeued` counts the rows that were actually waiting (0 = nothing was stuck); `unsuspended` is
// the subset that had SUSPENDED (failed MAX_RETRY_ATTEMPTS times) and got a fresh retry window.
// `flushed` is false when a tick already held the repo lock — the rows are due, that pass delivers them.
const RetryNowResponse = z
  .object({ ok: z.boolean(), requeued: z.number(), unsuspended: z.number(), flushed: z.boolean(), message: z.string().optional() })
  .openapi("RetryNow");
// Belt rename/delete cleanup. `ok` is false when a delete was blocked by in-flight work (`blocked`)
// or the repo failed to reload (`failures`); the caller (TUI) then reverts the config file. Counts
// report what was applied when it succeeded.
const BeltApplyResponse = z
  .object({
    ok: z.boolean(),
    runsMoved: z.number(),
    runsPurged: z.number(),
    worktreesCleaned: z.number(),
    blocked: z.array(z.object({ belt: z.string(), activeRuns: z.number() })),
    failures: z.array(z.object({ name: z.string(), error: z.string() })),
  })
  .openapi("BeltApply");

const RunSchema = z
  .object({
    id: z.number(),
    repo: z.string(),
    workSource: z.string().nullable(),
    belt: z.string().nullable(),
    ticketKey: z.string(),
    summary: z.string().nullable(),
    issueType: z.string().nullable(),
    // The name the worktree was created under (identity) vs the branch it is on NOW — the two
    // differ once an agent renames the branch to the repo's convention.
    worktreeName: z.string().nullable(),
    branch: z.string().nullable(),
    phase: z.string(),
    step: z.string().nullable(),
    prNumber: z.number().nullable(),
    outcome: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    endedAt: z.number().nullable(),
  })
  .openapi("Run");
const RunsResponse = z.object({ runs: z.array(RunSchema) }).openapi("Runs");

const StatusResponse = z
  .object({
    repo: z.string(),
    limits: z.object({ maxActiveWorkspaces: z.number() }),
    // `auth` is the per-source authentication light (same vocab as evidenceSso). "down" = the source
    // can't authenticate (its claims + write-backs are paused, auto-resuming on re-auth); "na" = no auth.
    sources: z.array(z.object({ name: z.string(), type: z.string(), auth: z.object({ state: z.enum(["ok", "down", "na"]), detail: z.string().optional(), account: z.string().optional() }).optional() })),
    belts: z.array(z.object({
      name: z.string(),
      beltType: z.string(),
      source: z.string(),
      priority: z.number(),
      active: z.boolean().optional(),
      label: z.string().optional(),
      steps: z.array(z.string()),
      diagnostic: z.object({ state: z.enum(["ok", "down"]), detail: z.string().optional() }).optional(),
    })),
    active: z.array(
      z.object({
        id: z.number(),
        ticketKey: z.string(),
        workSource: z.string().nullable(),
        belt: z.string().nullable(),
        issueType: z.string().nullable(),
        worktreeName: z.string().nullable(),
        branch: z.string().nullable(),
        phase: z.string(),
        step: z.string().nullable(),
        prNumber: z.number().nullable(),
        summary: z.string().nullable(),
        outcome: z.string().nullable(),
        attentionReason: z.string().nullable(),
        createdAt: z.number(),
        worker: z.string().nullable(),
        steps: z.array(z.object({ step: z.string(), done: z.boolean(), startedAt: z.number().nullable(), doneAt: z.number().nullable(), pass: z.number() })),
        problem: z.object({ kind: z.literal("evidence-upload"), detail: z.string() }).optional(),
      }),
    ),
    // Repo-level problems for the dashboard's red per-repo light: runs parked for attention,
    // suspended jobs (retries stopped after MAX_RETRY_ATTEMPTS failures), live auth failures, and
    // cached session-probe verdicts (expired AWS SSO / source creds; refreshed in the background,
    // never awaited). Quick mode carries them too.
    problems: z.array(z.object({ kind: z.string(), detail: z.string() })),
    finished: z.array(
      z.object({
        id: z.number(),
        ticketKey: z.string(),
        phase: z.string(),
        outcome: z.string().nullable(),
        prNumber: z.number().nullable(),
      }),
    ),
    // Evidence-upload credential (AWS SSO) health. Omitted in quick mode; "na" = no evidence config.
    evidenceSso: z.object({ state: z.enum(["ok", "down", "na"]), detail: z.string().optional() }).optional(),
  })
  .openapi("Status");

const EligibleResponse = z
  .object({
    eligible: z.array(
      z.object({ source: z.string(), belt: z.string(), key: z.string(), summary: z.string(), type: z.string() }),
    ),
  })
  .openapi("Eligible");

const TimelineResponse = z
  .object({
    timeline: z.array(z.object({ ts: z.number(), type: z.string(), detail: z.string().nullable() })),
  })
  .openapi("Timeline");

// ---- request bodies -------------------------------------------------------
// `step` is any string — it's validated against the run's resolved belt in the handler, since the
// valid step set is belt-specific (and the belt isn't known until the run is resolved from `key`).
// `pass` (step-done / bounce) is the pass stamp the issuing prompt rendered — optional (older
// prompts carry none), coerced because the CLI forwards it as a string.
export const StepDoneBody = z
  .object({ key: z.string(), step: z.string(), source: z.string().optional(), pass: z.coerce.number().int().positive().optional() })
  .openapi("StepDoneBody");
export const AskHumanBody = z
  .object({ key: z.string(), step: z.string(), source: z.string().optional(), question: z.string().min(1) })
  .openapi("AskHumanBody");
// `toStep` is validated against the run's resolved belt in the handler (must be an earlier step the
// current step is allowed to bounce to) — like `step` on step-done, the valid set is belt-specific.
// `step` names the ISSUING step (attribution — the engine no longer assumes run.step at processing
// time is the bouncer); optional for prompts rendered before it existed.
export const BounceBody = z
  .object({
    key: z.string(),
    toStep: z.string(),
    source: z.string().optional(),
    reason: z.string().min(1),
    step: z.string().optional(),
    pass: z.coerce.number().int().positive().optional(),
  })
  .openapi("BounceBody");
// No step field: the attempt always applies to the run's current running step (the engine validates
// it is a gathersEvidence step), so the agent can't misattribute it.
export const CaptureAttemptBody = z.object({ key: z.string(), step: z.string(), source: z.string().optional() }).openapi("CaptureAttemptBody");
// `branch` is validated in the engine (core/run-branch.ts) against git's ref rules, the repo's
// protected branches, and the run's own state — the shapes a message must explain, not a 422.
export const SetBranchBody = z.object({ key: z.string(), branch: z.string().min(1), source: z.string().optional() }).openapi("SetBranchBody");
export const ClaimBody = z.object({ key: z.string(), belt: z.string().optional() }).openapi("ClaimBody");
export const TeardownBody = z.object({ key: z.string(), source: z.string().optional() }).openapi("TeardownBody");
export const ResumeBody = z.object({ key: z.string(), source: z.string().optional() }).openapi("ResumeBody");
// Operator due-now in bulk. Everything is optional: no `key` (or no body at all) means the whole
// repo — the shape of the cause being fixed (an expired `aws sso login`, a source that was down) is
// usually repo-wide, not one run's.
export const RetryNowBody = z.object({ key: z.string().optional(), source: z.string().optional() }).openapi("RetryNowBody");
// Belt-set change to apply against a config whose file the caller has ALREADY written: migrate the
// renamed belts' runs, purge the deleted belts (guarded). Computed by the caller's old→new belt diff.
export const BeltApplyBody = z
  .object({
    renames: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
    deletes: z.array(z.string()).default([]),
  })
  .openapi("BeltApplyBody");

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

// ---- routes ---------------------------------------------------------------
export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["server"],
  summary: "Liveness probe + running version",
  responses: { 200: { description: "Healthy", content: { "application/json": { schema: HealthResponse } } } },
});

export const reloadRoute = createRoute({
  method: "post",
  path: "/reload",
  tags: ["server"],
  summary: "Re-read every repo's config + re-discover repos (no restart)",
  responses: { 200: { description: "Reloaded", content: { "application/json": { schema: ReloadResponse } } } },
});

export const shutdownRoute = createRoute({
  method: "post",
  path: "/shutdown",
  tags: ["server"],
  summary: "Graceful drain + exit",
  responses: { 200: { description: "Shutting down", content: { "application/json": { schema: OkResponse } } } },
});

export const tickRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/tick",
  tags: ["repo"],
  summary: "Run one reconcile pass for the repo",
  request: { params: RepoParam },
  responses: {
    200: { description: "Tick result", content: { "application/json": { schema: TickResponse } } },
    ...repoErrors,
  },
});

export const stepDoneRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/step-done",
  tags: ["repo"],
  summary: "A belt agent signals it finished a step — event-nudges the dispatcher",
  request: { params: RepoParam, ...jsonBody(StepDoneBody) },
  responses: {
    200: { description: "Step recorded", content: { "application/json": { schema: StepDoneResponse } } },
    ...repoErrors,
  },
});

export const askHumanRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/ask-human",
  tags: ["repo"],
  summary: "A belt agent asks a human through its work source and pauses the run",
  request: { params: RepoParam, ...jsonBody(AskHumanBody) },
  responses: {
    200: { description: "Question recorded", content: { "application/json": { schema: AskHumanResponse } } },
    ...repoErrors,
  },
});

export const bounceRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/bounce",
  tags: ["repo"],
  summary: "A belt agent sends the run back to an earlier step for rework",
  request: { params: RepoParam, ...jsonBody(BounceBody) },
  responses: {
    200: { description: "Bounce recorded", content: { "application/json": { schema: BounceResponse } } },
    ...repoErrors,
  },
});

export const captureAttemptRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/capture-attempt",
  tags: ["repo"],
  summary: "An evidence agent signals a capture attempt — the engine caps flaky-capture loops",
  request: { params: RepoParam, ...jsonBody(CaptureAttemptBody) },
  responses: {
    200: { description: "Attempt recorded", content: { "application/json": { schema: CaptureAttemptResponse } } },
    ...repoErrors,
  },
});

export const setBranchRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/set-branch",
  tags: ["repo"],
  summary: "A belt agent puts its run's worktree on another branch (the repo's branch convention)",
  request: { params: RepoParam, ...jsonBody(SetBranchBody) },
  responses: {
    200: { description: "Branch set (or refused, with the reason)", content: { "application/json": { schema: SetBranchResponse } } },
    ...repoErrors,
  },
});

export const claimRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/claim",
  tags: ["repo"],
  summary: "Manually claim + start one work item",
  request: { params: RepoParam, ...jsonBody(ClaimBody) },
  responses: {
    200: { description: "Claimed", content: { "application/json": { schema: OkResponse } } },
    ...repoErrors,
  },
});

export const resumeRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/resume",
  tags: ["repo"],
  summary: "Un-park a run from `attention` back to where it was (running/reviewing/claiming)",
  request: { params: RepoParam, ...jsonBody(ResumeBody) },
  responses: {
    200: { description: "Resume result", content: { "application/json": { schema: ResumeResponse } } },
    ...repoErrors,
  },
});

export const retryNowRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/retry-now",
  tags: ["repo"],
  summary: "Operator due-now in bulk: drop the backoff on the repo's (or one run's) pending intents and flush them",
  request: { params: RepoParam, body: { content: { "application/json": { schema: RetryNowBody } }, required: false } },
  responses: {
    200: { description: "Requeue + flush result", content: { "application/json": { schema: RetryNowResponse } } },
    ...repoErrors,
  },
});

export const teardownRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/teardown",
  tags: ["repo"],
  summary: "Tear down one work item's worktree",
  request: { params: RepoParam, ...jsonBody(TeardownBody) },
  responses: {
    200: { description: "Torn down", content: { "application/json": { schema: OkResponse } } },
    ...repoErrors,
  },
});

export const beltApplyRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/belt-apply",
  tags: ["repo"],
  summary: "Apply belt renames/deletes: migrate renamed belts' runs, purge deleted belts (guarded)",
  request: { params: RepoParam, ...jsonBody(BeltApplyBody) },
  responses: {
    200: { description: "Applied (or blocked/failed — see the body)", content: { "application/json": { schema: BeltApplyResponse } } },
    ...repoErrors,
  },
});

export const statusRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/status",
  tags: ["repo"],
  summary: "Dashboard status: active + finished runs, sources, limits",
  request: { params: RepoParam, query: z.object({ quick: z.enum(["1"]).optional(), refresh: z.enum(["1"]).optional() }) },
  responses: {
    200: { description: "Status", content: { "application/json": { schema: StatusResponse } } },
    ...repoErrors,
  },
});

export const runsRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/runs",
  tags: ["repo"],
  summary: "List runs (active only, or all with ?all)",
  request: { params: RepoParam, query: z.object({ all: z.string().optional() }) },
  responses: {
    200: { description: "Runs", content: { "application/json": { schema: RunsResponse } } },
    ...repoErrors,
  },
});

export const eligibleRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/eligible",
  tags: ["repo"],
  summary: "List eligible (todo) work items across all sources",
  request: { params: RepoParam },
  responses: {
    200: { description: "Eligible items", content: { "application/json": { schema: EligibleResponse } } },
    ...repoErrors,
  },
});

export const timelineRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/timeline",
  tags: ["repo"],
  summary: "Event timeline for a ticket (?key=)",
  request: { params: RepoParam, query: z.object({ key: z.string() }) },
  responses: {
    200: { description: "Timeline", content: { "application/json": { schema: TimelineResponse } } },
    ...repoErrors,
  },
});

// "Why is this run waiting and what would move it": the run's outstanding deliver-lane intents
// (undelivered write-backs, pending evidence uploads, an unconsumed agent signal, a pending human
// question) + its armed observe-lane watches (the active step's guards with live clocks/counters
// and rescue class, the engine-universal watches, any counted bounce caps). Read-only, lock-free,
// registry-derived — see src/core/obligations.ts.
const GuardFacts = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const ObligationsResponse = z
  .object({
    run: z.object({
      id: z.number(),
      key: z.string(),
      phase: z.string(),
      step: z.string().nullable(),
      belt: z.string().nullable(),
      workSource: z.string().nullable(),
      prNumber: z.number().nullable(),
      resolverActive: z.boolean(),
      attentionReason: z.string().nullable(),
      attentionReasonCode: z.string().nullable(),
    }),
    intents: z.object({
      transitions: z.array(
        z.object({
          toState: z.string(),
          toStatus: z.string(),
          attempts: z.number(),
          nextAttemptAt: z.number(),
          lastError: z.string().nullable(),
          staleUnhandled: z.boolean(),
        }),
      ),
      evidenceUploads: z.array(
        z.object({
          keyPrefix: z.string(),
          attempts: z.number(),
          nextAttemptAt: z.number(),
          errorKind: z.string().nullable(),
          lastError: z.string().nullable(),
        }),
      ),
      pendingSignal: z
        .object({ signal: z.string(), step: z.string().nullable(), toStep: z.string().nullable(), createdAt: z.number() })
        .nullable(),
      humanQuestion: z
        .object({ id: z.number(), step: z.string().nullable(), posted: z.boolean(), pollAttempts: z.number(), pollErrors: z.number(), nextPollAt: z.number() })
        .nullable(),
      ledger: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          status: z.string(),
          nextAttemptAt: z.number(),
          deadlineAt: z.number().nullable(),
          handoffOwed: z.boolean(),
          lastError: z.string().nullable(),
        }),
      ),
    }),
    watches: z.object({
      step: z.string().nullable(),
      guards: z.array(z.object({ kind: z.string(), escalationReason: z.string(), rescue: z.string(), facts: GuardFacts })),
      engine: z.array(z.object({ kind: z.string(), watches: z.string(), rescue: z.string(), facts: GuardFacts })),
      bounceCaps: z.array(z.object({ step: z.string(), count: z.number(), max: z.number() })),
    }),
  })
  .openapi("Obligations");

export const obligationsRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/obligations",
  tags: ["repo"],
  summary: "Why is this run waiting and what would move it (?key=, &source= to disambiguate)",
  request: { params: RepoParam, query: z.object({ key: z.string(), source: z.string().optional() }) },
  responses: {
    200: { description: "The run's pending intents + armed watches", content: { "application/json": { schema: ObligationsResponse } } },
    ...repoErrors,
  },
});

// ---- the intent ledger --------------------------------------------------------
// Row lifecycle ONLY: enqueue an external wait, inspect, operator retry, fulfil, cause recovery.
// Run transitions stay the run-locked reconciler's — a fulfil/deadline crosses into the run as a
// HANDOFF the next run-locked pass consumes (see src/core/ledger.ts).

const IntentSchema = z
  .object({
    id: z.number(),
    kind: z.string(),
    scope: z.string(),
    key: z.string().nullable(),
    status: z.string(),
    attempts: z.number(),
    nextAttemptAt: z.number(),
    deadlineAt: z.number().nullable(),
    lastError: z.string().nullable(),
    errorClass: z.string().nullable(),
    causeScope: z.string().nullable(),
    handoffMarker: z.string().nullable(),
    consumedResult: z.string().nullable(),
    payload: z.string(),
    state: z.string(),
    createdAt: z.number(),
    resolvedAt: z.number().nullable(),
  })
  .openapi("Intent");
const IntentsResponse = z.object({ intents: z.array(IntentSchema) }).openapi("Intents");
const IntentIdParam = RepoParam.extend({ id: z.string().regex(/^\d+$/).openapi({ param: { name: "id", in: "path" }, example: "42" }) });

export const intentsListRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/intents",
  tags: ["intents"],
  summary: "List ledger intents (?kind=&status=&key=)",
  request: { params: RepoParam, query: z.object({ kind: z.string().optional(), status: z.string().optional(), key: z.string().optional() }) },
  responses: {
    200: { description: "Intents", content: { "application/json": { schema: IntentsResponse } } },
    ...repoErrors,
  },
});

export const intentEnqueueRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/intents",
  tags: ["intents"],
  summary: "Create an external-trigger wait (externally-enqueuable kinds only, e.g. external_wait)",
  request: {
    params: RepoParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            kind: z.string(),
            key: z.string().optional(), // scope the wait to a run (resolved like every run command)
            source: z.string().optional(),
            dedupKey: z.string().optional(), // idempotence handle; omitted ⇒ a fresh unique wait
            payload: z.record(z.string(), z.unknown()).optional(), // kind-owned (external_wait: {note, on_deadline})
            deadlineAt: z.number().optional(), // epoch seconds; omitted ⇒ waits indefinitely
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "The created (waiting) intent", content: { "application/json": { schema: z.object({ intent: IntentSchema }).openapi("IntentCreated") } } },
    ...repoErrors,
  },
});

export const intentRetryRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/intents/{id}/retry",
  tags: ["intents"],
  summary: "Operator due-now for a pending intent (skips its backoff)",
  request: { params: IntentIdParam },
  responses: {
    200: { description: "Retry scheduled", content: { "application/json": { schema: OkResponse } } },
    ...repoErrors,
  },
});

export const intentFulfilRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/intents/{id}/fulfil",
  tags: ["intents"],
  summary: "Resolve a waiting external-trigger intent (a webhook/CI callback landing)",
  request: {
    params: IntentIdParam,
    body: { content: { "application/json": { schema: z.object({ result: z.record(z.string(), z.unknown()).optional() }) } }, required: false },
  },
  responses: {
    200: {
      description: "Fulfilled (the run reacts on its next run-locked pass, nudged immediately when possible)",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), message: z.string().optional() }).openapi("IntentFulfil") } },
    },
    ...repoErrors,
  },
});

export const intentRecoverRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/intents/recover",
  tags: ["intents"],
  summary: "Cause-scoped recovery: make every pending intent under a cause due now (auth restored)",
  request: { params: RepoParam, body: { content: { "application/json": { schema: z.object({ causeScope: z.string() }) } } } },
  responses: {
    200: { description: "Requeued count", content: { "application/json": { schema: z.object({ requeued: z.number() }).openapi("IntentRecover") } } },
    ...repoErrors,
  },
});
