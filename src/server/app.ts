// The Hono OpenAPI app: route definitions (schemas.ts) wired to handlers, plus the OpenAPI JSON
// document (/doc) and Swagger UI (/ui). All resident state + lifecycle lives in serve.ts and is
// injected here via `ServerContext`; this module is pure request → response wiring. Request bodies,
// params and query strings are validated by the route schemas before a handler runs; validation
// failures and thrown errors are normalised to `{ error }` (the shape server/client.ts expects).
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { lookup as mimeLookup } from "mime-types";
import * as Effect from "effect/Effect";
import { VERSION } from "../version.ts";
import { withExtractedTelemetryContext } from "../telemetry/index.ts";
import { annotateCurrentSpan, recordHttpServerDurationEffect, withHttpServerSpan } from "../telemetry/effect.ts";
import { runEffect } from "../runtime/effect.ts";
import { availableMemoryMb, describeMachine } from "../machine.ts";
import { claimTicket, flushDurableIntents, reconcileRepo, reconcileRun, resumeRun, teardownTicket, withRunLock, withRunLockWaiting, withTickLock } from "../core/reconcile.ts";
import { runObligations } from "../core/obligations.ts";
import { intentKindFor } from "../intents/registry.ts";
import { applySignal } from "../core/signals.ts";
import { createEvidencePublisher, credsRefreshHint } from "../clients/evidence.ts";
import { evidenceServeDir } from "../config-paths.ts";
import { getAuthFailure } from "../auth/gate.ts";
import { MAX_RETRY_ATTEMPTS } from "../schedule.ts";
import { resolveActiveRun, resolveBeltName } from "../resolve.ts";
import type { Deps } from "../core/deps.ts";
import {
  beltApplyRoute,
  bounceRoute,
  captureAttemptRoute,
  claimRoute,
  askHumanRoute,
  eligibleRoute,
  healthRoute,
  intentEnqueueRoute,
  intentFulfilRoute,
  intentRecoverRoute,
  intentRetryRoute,
  intentsListRoute,
  obligationsRoute,
  reloadRoute,
  resumeRoute,
  retryNowRoute,
  runsRoute,
  setBranchRoute,
  shutdownRoute,
  statusRoute,
  stepDoneRoute,
  teardownRoute,
  tickRoute,
  timelineRoute,
} from "./schemas.ts";
import type { BeltChanges, BeltChangesResult } from "../core/belt-admin.ts";
import { runHandler } from "./effect.ts";

/** A repo the resident server is currently serving: its injected Deps + tick-loop bookkeeping. */
export interface RepoRuntime {
  deps: Deps;
  timer?: NodeJS.Timeout;
  ticking: boolean;
}

/** The /health payload (also what `ensure-up`/readHealth read back). `tickStale` per repo is the
 *  wedged-tick signal the supervisor restarts on. */
export interface HealthInfo {
  ok: boolean;
  version: string;
  pid: number;
  startedAt: number;
  uptimeSec: number;
  repos: { name: string; active: number; lastTickAt: number | null; tickStale: boolean }[];
}

/** Everything the HTTP layer needs from the resident lifecycle (implemented in serve.ts). */
export interface ServerContext {
  health(): HealthInfo;
  reload(): Promise<{ repos: string[]; failures: { name: string; error: string }[] }>;
  /** Apply a belt-set change (rename/delete cleanup) for one repo whose config file the caller has
   *  already written — atomically under the repo tick lock, then reload that repo's Deps. */
  applyBeltChanges(repo: string, changes: BeltChanges): Promise<BeltChangesResult & { ok: boolean; failures: { name: string; error: string }[] }>;
  requestShutdown(why: string): void;
  getRepo(name: string): RepoRuntime | undefined;
  knownRepos(): string[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Cached AWS creds probe per repo. General API consumers may poll /status, so a HeadBucket must not
 *  run per request; the TUI's explicit diagnostics action can force a fresh result. */
const SSO_PROBE_TTL_SECONDS = 90;
const ssoProbeCache = new Map<string, { at: number; auth: boolean; reason: string }>();

/** Evidence-upload credential (SSO) health for the dashboard light. `down` when a cached read-only
 *  HeadBucket probe reports a creds/token failure, OR when the outbox already has an auth-stuck upload
 *  (immediate, even between probes). A transient/timeout probe or a permanent bucket/perms error is NOT
 *  "SSO down" (creds are fine — surfaced by doctor). `na` when the repo has no evidence config. A
 *  FRESH probe verdict is also written to the problem ledger (the same `publisher:<type>` key the
 *  engine's own detectors use), so opening the detail view syncs the repo row's red light at once. */
async function evidenceSsoStatus(rt: RepoRuntime, refresh = false): Promise<{ state: "ok" | "down" | "na"; detail?: string }> {
  const cfg = rt.deps.config;
  const ev = cfg.evidence;
  if (!ev) return { state: "na" };
  // Only S3 carries a creds/SSO light — `local`/`command` have no auth, so no upload is ever
  // auth-stuck and the probe is absent. Report `ok` (nothing to be "down" about).
  const publisher = createEvidencePublisher(ev, { currentLogin: () => rt.deps.github.currentLogin() });
  if (!publisher.probeLiveness) return { state: "ok" };
  const profile = ev.publisher === "s3" ? ev.profile : undefined;
  if (rt.deps.store.authStuckIntents(cfg.repoName, "evidence_publish")) {
    return { state: "down", detail: `an evidence upload is stuck on AWS creds — ${credsRefreshHint(profile)}` };
  }
  const now = rt.deps.now();
  let cached = ssoProbeCache.get(cfg.repoName);
  if (refresh || !cached || now - cached.at >= SSO_PROBE_TTL_SECONDS) {
    const probe = await publisher.probeLiveness().catch(() => ({ auth: false, reason: "probe failed" }));
    cached = { at: now, auth: probe.auth, reason: probe.reason };
    ssoProbeCache.set(cfg.repoName, cached);
    const cause = `publisher:${ev.publisher}`;
    if (probe.auth) rt.deps.store.reportProblem(cfg.repoName, cause, "auth", `evidence uploads blocked on AWS creds (${probe.reason}) — ${credsRefreshHint(profile)}`);
    else rt.deps.store.clearProblem(cfg.repoName, cause);
  }
  return cached.auth ? { state: "down", detail: cached.reason } : { state: "ok" };
}

/** Cached per-source authStatus() probe. A github source shells out to `gh auth token`, which mustn't
 *  run for every general /status poll. Mirrors ssoProbeCache. */
const AUTH_PROBE_TTL_SECONDS = 90;
const authProbeCache = new Map<string, { at: number; state: "ok" | "unauthenticated" | "not_applicable"; detail?: string }>();

/** Per-source auth light for the dashboard, mirroring evidenceSso's vocabulary: "down" when the
 *  reconcile gate has recorded a live failure (reactive — catches a present-but-rejected credential)
 *  OR the source's own cheap authStatus() probe reports missing credentials (proactive); "na" for a
 *  source with no auth; else "ok". A FRESH probe verdict is also written to the problem ledger
 *  (same `source:<name>` key the auth gate uses), so the detail view syncs the repo row's light.
 *  The gate's own failure short-circuits first, so a probe's "ok" (creds merely present) can never
 *  clear a live rejected-credential problem. */
async function sourceAuthStatus(rt: RepoRuntime, sourceName: string, refresh = false): Promise<{ state: "ok" | "down" | "na"; detail?: string; account?: string }> {
  const repo = rt.deps.config.repoName;
  // The account we authenticated as (whoami, persisted at login) — shown regardless of ok/down so a
  // rejected-but-present session still reads "signed in as X". No network call (reads the local db).
  const account = rt.deps.store.getSourceAuth(repo, sourceName)?.accountLabel ?? undefined;
  const failure = getAuthFailure(repo, sourceName);
  if (failure) return { state: "down", detail: failure.detail, account };
  const src = rt.deps.resolveSource(sourceName);
  if (!src) return { state: "na" };
  const now = rt.deps.now();
  const cacheKey = `${repo} ${sourceName}`;
  let cached = authProbeCache.get(cacheKey);
  if (refresh || !cached || now - cached.at >= AUTH_PROBE_TTL_SECONDS) {
    const probe = await src.client.authStatus().catch((): { state: "ok" | "unauthenticated" | "not_applicable"; detail?: string } => ({ state: "ok" }));
    cached = { at: now, state: probe.state, detail: probe.detail };
    authProbeCache.set(cacheKey, cached);
    if (probe.state === "unauthenticated") {
      rt.deps.store.reportProblem(repo, `source:${sourceName}`, "auth", `${sourceName}: ${probe.detail ?? "not authenticated"}`);
    } else {
      rt.deps.store.clearProblem(repo, `source:${sourceName}`);
    }
  }
  if (cached.state === "unauthenticated") return { state: "down", detail: cached.detail, account };
  return { state: cached.state === "not_applicable" ? "na" : "ok", account };
}

/** Serve a file the `local` evidence publisher copied under `evidenceServeDir()`. `reqPath` is the raw
 *  (still URL-encoded) request path `/evidence/<encoded segments>`. Each segment is decoded and rejected
 *  if it is empty, `.`/`..`, or contains a path separator or null byte after decoding — so no request can
 *  escape the serve root (evidence prefixes never contain those). Read-only; 404 for anything missing. */
function serveEvidenceFile(reqPath: string): Response {
  const notFound = () => new Response("not found", { status: 404 });
  let segments: string[];
  try {
    segments = reqPath.slice("/evidence/".length).split("/").map(decodeURIComponent);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (segments.length === 0 || segments.some((s) => s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("\0"))) {
    return notFound();
  }
  const abs = join(evidenceServeDir(), ...segments);
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return notFound();
    size = st.size;
  } catch {
    return notFound();
  }
  // Immutable per prefix (run id + timestamp), so cache aggressively. ContentType is load-bearing:
  // without it a browser/reviewer downloads screenshots/video instead of viewing them inline.
  const web = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
  return new Response(web, {
    headers: {
      "Content-Type": mimeLookup(abs) || "application/octet-stream",
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/** Repo-level problems for the dashboard's red per-repo light — PURE READS of already-recorded
 *  state, nothing is checked or probed on load:
 *   - runs parked for attention and suspended jobs, derived from their own tables;
 *   - the PROBLEM LEDGER (v37): every open mechanical problem the machinery itself recorded when
 *     it observed it (the auth gate, an auth-classified delivery failure, the evidence creds
 *     probe on its tick cadence) and clears when it sees the cause resolved.
 *  So the quick status path carries the full picture at DB-read cost. */
function repoProblems(rt: RepoRuntime, active: readonly { phase: string; ticketKey: string }[]): { kind: string; detail: string }[] {
  const cfg = rt.deps.config;
  const problems: { kind: string; detail: string }[] = [];
  const parked = active.filter((r) => r.phase === "attention").map((r) => r.ticketKey);
  if (parked.length > 0) {
    problems.push({
      kind: "attention",
      detail: `${parked.length} run${parked.length === 1 ? "" : "s"} parked for attention (${parked.join(", ")}) — press s on the card to resume`,
    });
  }
  const suspended = rt.deps.store.suspendedIntents(cfg.repoName);
  if (suspended.length > 0) {
    const kinds = [...new Set(suspended.map((i) => i.kind.replaceAll("_", " ")))].join(", ");
    problems.push({
      kind: "suspended",
      detail: `${suspended.length} job${suspended.length === 1 ? "" : "s"} suspended after ${MAX_RETRY_ATTEMPTS} failed retries (${kinds}) — press s to retry`,
    });
  }
  for (const p of rt.deps.store.listProblems(cfg.repoName)) problems.push({ kind: p.kind, detail: p.detail });
  return problems;
}

/** The structured status payload exposed for API clients. Quick mode omits auth/AWS probes and live
 *  pane inspection for latency-sensitive dashboard refreshes — `problems` is recorded state, read,
 *  never re-checked. */
function machineLine(rt: RepoRuntime): string | undefined {
  if (!rt.deps.machine) return undefined; // absent machine.yml: no extra query on the 3 s poll
  return describeMachine(rt.deps.machine, rt.deps.store.countOccupyingAll(), rt.deps.availableMemoryMb ?? availableMemoryMb)?.line;
}

async function statusPayload(rt: RepoRuntime, quick = false, refreshDiagnostics = false) {
  const cfg = rt.deps.config;
  const active = rt.deps.store.activeRuns(cfg.repoName);
  const finished = rt.deps.store.listRuns(cfg.repoName, true).filter((r) => r.endedAt !== null);
  const runView = async (r: (typeof active)[number]) => {
    // Surface a stuck async upload hiding behind a "done" evidence step. An error class ⇒ at least
    // one attempt has failed (a freshly-enqueued, not-yet-attempted row is pending, not a problem).
    const stuckUploads = rt.deps.store
      .listIntents(cfg.repoName, { kind: "evidence_publish", status: "pending", runId: r.id })
      .filter((i) => i.errorClass != null);
    const problem = stuckUploads.length === 0
      ? undefined
      : {
          kind: "evidence-upload" as const,
          detail: stuckUploads.some((u) => u.suspendedAt != null)
            ? "evidence upload suspended — press s to retry"
            : stuckUploads.some((u) => u.errorClass === "auth")
              ? "evidence not uploaded — AWS creds"
              : "evidence upload retrying",
        };
    return {
      id: r.id,
      ticketKey: r.ticketKey,
      workSource: r.workSource,
      belt: r.belt,
      issueType: r.issueType,
      worktreeName: r.worktreeName,
      branch: r.branch,
      phase: r.phase as string,
      step: r.step,
      prNumber: r.prNumber,
      summary: r.summary,
      outcome: r.outcome as string | null,
      attentionReason: r.attentionReason,
      createdAt: r.createdAt,
      worker: !quick && r.paneId ? await rt.deps.herdr.paneState(r.paneId).catch(() => "unknown") : null,
      // Per-step timing (started/done/pass) powers the detail view's step progress; the dashboard's
      // step columns only read `step`/`done`, so the extra fields are inert there.
      steps: rt.deps.store.runStepsFor(r.id).map((s) => ({ step: s.step as string, done: s.done, startedAt: s.startedAt, doneAt: s.doneAt, pass: s.pass })),
      ...(problem ? { problem } : {}),
    };
  };
  const sources = quick
    ? Promise.resolve(cfg.sources.map((s) => ({ name: s.name, type: s.type as string })))
    : Promise.all(cfg.sources.map(async (s) => ({ name: s.name, type: s.type as string, auth: await sourceAuthStatus(rt, s.name, refreshDiagnostics) })));
  const belts = Promise.all(cfg.belts.map(async (belt) => {
    const base = {
      name: belt.name,
      beltType: belt.beltType as string,
      source: belt.source,
      priority: belt.priority,
      active: belt.active,
      label: belt.label,
      steps: belt.steps.map((step) => step.name),
    };
    if (!refreshDiagnostics) return base;
    const source = rt.deps.resolveSource(belt.source);
    if (!source) return { ...base, diagnostic: { state: "down" as const, detail: `source "${belt.source}" is unavailable` } };
    try {
      await source.client.health(belt.label ? [belt.label] : []);
      return { ...base, diagnostic: { state: "ok" as const } };
    } catch (e) {
      return { ...base, diagnostic: { state: "down" as const, detail: msg(e) } };
    }
  }));
  const activeRuns = Promise.all(active.map(runView));
  const evidenceSso = quick ? undefined : evidenceSsoStatus(rt, refreshDiagnostics);
  return {
    repo: cfg.repoName,
    limits: { maxActiveWorkspaces: cfg.limits.maxActiveWorkspaces },
    sources: await sources,
    belts: await belts,
    active: await activeRuns,
    problems: repoProblems(rt, active),
    // The host-local machine.yml summary (absent when unset) — the dashboard appends it to the repo row.
    machine: machineLine(rt),
    finished: finished.map((r) => ({
      id: r.id,
      ticketKey: r.ticketKey,
      phase: r.phase as string,
      outcome: r.outcome as string | null,
      prNumber: r.prNumber,
    })),
    ...(evidenceSso && { evidenceSso: await evidenceSso }),
  };
}

async function eligiblePayload(rt: RepoRuntime): Promise<{ source: string; belt: string; key: string; summary: string; type: string }[]> {
  const out: { source: string; belt: string; key: string; summary: string; type: string }[] = [];
  // Eligibility is per BELT now — each belt polls its source with its own pickup label. Walk belts
  // (not sources) so a label-driven source's items are surfaced under the belt(s) that claim them;
  // dedup by (source, key) since two belts could name the same source (with distinct labels).
  const seen = new Set<string>();
  for (const belt of rt.deps.belts) {
    // An inactive belt takes on no new work — mirror Phase B and don't poll its source or surface
    // its items. Otherwise the dashboard shows never-claimable eligible rows for the belt, and since
    // the quick (eligible-less) paint skips an empty belt while the folded-in paint shows it, the
    // belt block flickers in/out every refresh cycle.
    if (!belt.active) continue;
    const src = rt.deps.resolveSource(belt.source);
    if (!src) continue;
    try {
      for (const t of await src.client.listEligible(belt.label)) {
        if (seen.has(`${src.name} ${t.key}`)) continue;
        seen.add(`${src.name} ${t.key}`);
        out.push({ source: src.name, belt: belt.name, key: t.key, summary: t.summary, type: t.type });
      }
    } catch (e) {
      rt.deps.log("warn", `${src.name}: eligible query failed: ${msg(e)}`);
    }
  }
  return out;
}

/** Build the OpenAPIHono app, wiring each route to a handler that uses the injected `ctx`. */
export function createApp(ctx: ServerContext): OpenAPIHono {
  // defaultHook normalises validation failures to `{ error }` (server/client.ts parses json.error).
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
        return c.json({ error: detail || "invalid request" }, 400);
      }
    },
  });

  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    const repo = c.req.path.match(/^\/repos\/([^/]+)/)?.[1];
    const decodedRepo = repo ? decodeURIComponent(repo) : undefined;
    return withExtractedTelemetryContext(c.req.raw.headers, () =>
      runEffect(
        withHttpServerSpan(
          {
            "http.request.method": c.req.method,
            "url.path": c.req.path,
            repo: decodedRepo,
          },
          Effect.tryPromise({ try: () => next(), catch: (cause) => cause }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                Effect.all([
                  annotateCurrentSpan({ "http.response.status_code": c.res.status }),
                  recordHttpServerDurationEffect(Date.now() - startedAt, {
                    "http.request.method": c.req.method,
                    "http.response.status_code": c.res.status,
                    repo: decodedRepo,
                  }),
                ], { discard: true }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  const notConfigured = (repo: string): string =>
    `repo "${repo}" not configured (server knows: ${ctx.knownRepos().join(", ") || "none"})`;

  // --- server-wide ---------------------------------------------------------
  app.openapi(healthRoute, (c) => runHandler(c, Effect.sync(() => ctx.health()), (health) => c.json(health, 200)));
  app.openapi(reloadRoute, (c) =>
    runHandler(
      c,
      Effect.tryPromise({ try: () => ctx.reload(), catch: (cause) => cause }),
      // ok reflects "every configured repo is actually running" — a repo whose sources failed to
      // construct must not be reported as a clean reload.
      (r) => c.json({ ok: r.failures.length === 0, repos: r.repos, failures: r.failures }, 200),
    ),
  );
  app.openapi(shutdownRoute, (c) =>
    runHandler(
      c,
      Effect.sync(() => {
        // Fire-and-forget: shutdown drains in-flight ticks (up to 15s) before process.exit, leaving
        // ample time for this response to flush first.
        ctx.requestShutdown("http /shutdown");
      }),
      () => c.json({ ok: true }, 200),
    ),
  );

  // --- repo-scoped ---------------------------------------------------------
  app.openapi(tickRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const ran = await withTickLock(rt.deps, () => reconcileRepo(rt.deps));
    return c.json({ ran }, 200);
  });

  // The four run-scoped agent signals are thin HTTP shells over the shared engine effect
  // (core/signals.ts applySignal) — the SAME implementation the CLI's in-process fallback runs, so
  // the two can't drift and each signal's lock discipline lives in one place. Adding one is a
  // SIGNAL_DESCRIPTORS entry + an applySignal case + this mount.
  app.openapi(stepDoneRoute, async (c) => {
    const rt = ctx.getRepo(c.req.valid("param").repo);
    if (!rt) return c.json({ error: notConfigured(c.req.valid("param").repo) }, 404);
    return c.json(await applySignal(rt.deps, "step-done", c.req.valid("json")), 200);
  });

  app.openapi(askHumanRoute, async (c) => {
    const rt = ctx.getRepo(c.req.valid("param").repo);
    if (!rt) return c.json({ error: notConfigured(c.req.valid("param").repo) }, 404);
    return c.json(await applySignal(rt.deps, "ask-human", c.req.valid("json")), 200);
  });

  app.openapi(bounceRoute, async (c) => {
    const rt = ctx.getRepo(c.req.valid("param").repo);
    if (!rt) return c.json({ error: notConfigured(c.req.valid("param").repo) }, 404);
    return c.json(await applySignal(rt.deps, "bounce", c.req.valid("json")), 200);
  });

  app.openapi(captureAttemptRoute, async (c) => {
    const rt = ctx.getRepo(c.req.valid("param").repo);
    if (!rt) return c.json({ error: notConfigured(c.req.valid("param").repo) }, 404);
    return c.json(await applySignal(rt.deps, "capture-attempt", c.req.valid("json")), 200);
  });

  app.openapi(setBranchRoute, async (c) => {
    const rt = ctx.getRepo(c.req.valid("param").repo);
    if (!rt) return c.json({ error: notConfigured(c.req.valid("param").repo) }, 404);
    return c.json(await applySignal(rt.deps, "set-branch", c.req.valid("json")), 200);
  });

  app.openapi(claimRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, belt } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    await claimTicket(rt.deps, resolveBeltName(rt.deps, belt), key);
    return c.json({ ok: true }, 200);
  });

  app.openapi(resumeRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, source } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const run = resolveActiveRun(rt.deps, key, source);
    if (!run) return c.json({ ok: false, message: `${key}: no active run` }, 200);
    // Like bounce: resume mutates the phase and leads straight into a re-dispatch, so it must be
    // serialized against anything else touching this run (a stale snapshot would fight the un-park).
    const { ran, result } = await withRunLockWaiting(rt.deps, run.id, async () => {
      const res = await resumeRun(rt.deps, rt.deps.store.getRun(run.id)!);
      if (res.ok) await reconcileRun(rt.deps, rt.deps.store.getRun(run.id)!);
      return res;
    });
    if (!ran) return c.json({ ok: false, message: `${key}: run busy — retry the resume` }, 200);
    return c.json(result!, 200);
  });

  // The operator's "I fixed the cause, go now": drop the backoff on the pending intents and flush
  // them on this request. Repo-wide by default (an expired `aws sso login` blocks every run's
  // uploads at once, not one); `key` narrows it to a single run. Unlike resume this needs no run
  // lock and no phase — it only touches the deliver lane's own rows, which is why it works for a
  // perfectly healthy run whose background upload is the only thing stuck.
  app.openapi(retryNowRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const body = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    let runId: number | undefined;
    if (body?.key) {
      const run = resolveActiveRun(rt.deps, body.key, body.source);
      if (!run) return c.json({ ok: false, requeued: 0, unsuspended: 0, flushed: false, message: `${body.key}: no active run` }, 200);
      runId = run.id;
    }
    const { requeued, unsuspended } = rt.deps.store.retryIntentsNow(repo, { runId });
    // Deliver on the spot — waiting for the next tick is the very latency this route exists to skip.
    // The flush is lock-free by the OutboxFlow contract but must not walk the same rows as a tick's
    // own Phase 0, so it takes the repo tick lock; when a tick already holds it the rows are due
    // anyway and that pass picks them up (`flushed: false` says so).
    const flushed = await withTickLock(rt.deps, () => flushDurableIntents(rt.deps));
    rt.deps.log(
      "info",
      `retry-now${runId != null ? ` (${body!.key})` : ""}: ${requeued} stuck intent(s) made due (${unsuspended} suspension(s) cleared)${flushed ? " and flushed" : " — a tick is mid-pass"}`,
    );
    return c.json({ ok: true, requeued, unsuspended, flushed }, 200);
  });

  app.openapi(teardownRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, source } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    await teardownTicket(rt.deps, key, source);
    return c.json({ ok: true }, 200);
  });

  app.openapi(beltApplyRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const changes = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json(await ctx.applyBeltChanges(repo, changes), 200);
  });

  app.openapi(statusRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { quick, refresh } = c.req.valid("query");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json(await statusPayload(rt, quick === "1", refresh === "1"), 200);
  });

  app.openapi(runsRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { all } = c.req.valid("query");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json({ runs: rt.deps.store.listRuns(repo, all !== undefined) }, 200);
  });

  app.openapi(eligibleRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json({ eligible: await eligiblePayload(rt) }, 200);
  });

  app.openapi(timelineRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key } = c.req.valid("query");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json({ timeline: rt.deps.store.timeline(repo, key) }, 200);
  });

  app.openapi(obligationsRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, source } = c.req.valid("query");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const run = resolveActiveRun(rt.deps, key, source); // throws (→ {error}) on cross-source ambiguity
    if (!run) return c.json({ error: `${key}: no active run` }, 404);
    return c.json(runObligations(rt.deps, run), 200);
  });

  // --- the intent ledger: row lifecycle only (run transitions stay the reconciler's) ------------
  const intentJson = (i: import("../types.ts").Intent) => ({
    id: i.id,
    kind: i.kind,
    scope: i.scope,
    key: i.ticketKey,
    status: i.status,
    attempts: i.attempts,
    nextAttemptAt: i.nextAttemptAt,
    deadlineAt: i.deadlineAt,
    lastError: i.lastError,
    errorClass: i.errorClass,
    causeScope: i.causeScope,
    handoffMarker: i.handoffMarker,
    consumedResult: i.consumedResult,
    payload: i.payload,
    state: i.state,
    createdAt: i.createdAt,
    resolvedAt: i.resolvedAt,
  });

  app.openapi(intentsListRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { kind, status, key } = c.req.valid("query");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const intents = rt.deps.store.listIntents(repo, { kind, status: status as never, key });
    return c.json({ intents: intents.map(intentJson) }, 200);
  });

  app.openapi(intentEnqueueRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const body = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const kind = intentKindFor(body.kind);
    // Only externally-enqueuable kinds may be created over HTTP — a hand-made engine-owned intent
    // (a source_transition row) would bypass the reconciler's monotonicity/ordering rules.
    if (!kind?.externallyEnqueuable) return c.json({ error: `intent kind "${body.kind}" cannot be enqueued externally` }, 400);
    let runId: number | null = null;
    let ticketKey: string | null = null;
    if (body.key) {
      const run = resolveActiveRun(rt.deps, body.key, body.source);
      if (!run) return c.json({ error: `${body.key}: no active run` }, 404);
      runId = run.id;
      ticketKey = run.ticketKey;
    }
    // Externally-created rows are external TRIGGER waits: born `waiting` (never retried by the
    // kernel), resolved by /fulfil or their deadline. A fresh uid dedup key per call unless the
    // caller supplies an idempotence handle.
    const intent = rt.deps.store.enqueueIntent({
      repo,
      kind: kind.kind,
      scope: runId != null ? `run:${runId}` : "repo",
      runId,
      ticketKey,
      dedupKey: body.dedupKey ?? `wait-${rt.deps.uid()}`,
      payload: JSON.stringify(body.payload ?? {}),
      status: "waiting",
      deadlineAt: body.deadlineAt ?? null,
    });
    return c.json({ intent: intentJson(intent) }, 200);
  });

  app.openapi(intentRetryRoute, async (c) => {
    const { repo, id } = c.req.valid("param");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const intent = rt.deps.store.getIntent(Number(id));
    if (!intent || intent.repo !== repo) return c.json({ error: `no intent #${id} in ${repo}` }, 404);
    return c.json({ ok: rt.deps.store.retryIntentNow(intent.id) }, 200);
  });

  app.openapi(intentFulfilRoute, async (c) => {
    const { repo, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const intent = rt.deps.store.getIntent(Number(id));
    if (!intent || intent.repo !== repo) return c.json({ error: `no intent #${id} in ${repo}` }, 404);
    const fulfilled = rt.deps.store.fulfilIntent(intent.id, JSON.stringify(body?.result ?? {}));
    if (!fulfilled) return c.json({ ok: false, message: `intent #${id} is ${intent.status}, not waiting — nothing to fulfil` }, 200);
    rt.deps.store.recordEvent({ runId: fulfilled.runId, repo, ticketKey: fulfilled.ticketKey, type: "intent_fulfilled", detail: { intentId: fulfilled.id, kind: fulfilled.kind } });
    // Latency nudge (fire-and-forget, like step-done): the handoff is durable, so a contended lock
    // just defers the run reaction to the next tick's pass.
    if (fulfilled.runId != null) {
      const run = rt.deps.store.getRun(fulfilled.runId);
      if (run && run.endedAt === null) await withRunLock(rt.deps, run.id, () => reconcileRun(rt.deps, rt.deps.store.getRun(run.id)!));
    }
    return c.json({ ok: true }, 200);
  });

  app.openapi(intentRecoverRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { causeScope } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json({ requeued: rt.deps.store.requeueIntentsByCause(repo, causeScope) }, 200);
  });

  // --- `local` evidence publisher static serve ----------------------------
  // Serve the captures the `local` publisher copied under evidenceServeDir() at `/evidence/<prefix>/<file>`
  // (the "prefix + filename" URL shape). Global across repos (keys carry a unique run id). Read-only;
  // path-traversal-guarded per segment (no `.`/`..`/separator/null after decode — evidence prefixes
  // never contain those). 404 for anything missing, so the route is harmless when no local publisher runs.
  app.get("/evidence/*", (c) => serveEvidenceFile(c.req.path));

  // --- OpenAPI document + Swagger UI --------------------------------------
  app.doc("/doc", { openapi: "3.0.0", info: { title: "herdr-factory", version: VERSION } });
  app.get("/ui", swaggerUI({ url: "/doc" }));

  app.notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));
  app.onError((err, c) => c.json({ error: msg(err) }, 500));

  return app;
}
