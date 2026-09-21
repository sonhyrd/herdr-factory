// Raw GitHub REST client for the github_issues work source. Deliberately NOT the gh CLI: this
// rides the tested Effect http pipeline (token buckets, Retry-After, typed status codes) — and
// typed statuses are load-bearing here: a transferred issue answers 301 (which a CLI or a
// redirect-following fetch would silently chase INTO THE NEW REPO, auth and method preserved) and
// a deleted issue answers 410. All issue API calls therefore use redirect: "manual".
// The gh CLI remains the transport for the PR watcher and for agents inside prompts; only its
// auth is borrowed here (`gh auth token`) when no GITHUB_TOKEN is configured.
import type { Logger } from "../core/deps.ts";
import { SourceUnauthenticatedError } from "../auth/errors.ts";
import { SourceRateLimitedError } from "../core/rate-limit-gate.ts";
import { recordRateLimitRemaining, telemetryEvent } from "../telemetry/index.ts";
import { run } from "./exec.ts";
import { countGithubCall, GITHUB_MUTATION_BUCKETS, githubReadBucket } from "./github-budget.ts";
import { HttpStatusError, httpOk, httpOkBytes, type HttpError, type HttpPolicy, type HttpResponse, type TokenBucket } from "./http.ts";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const JSON_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 120_000;

/** A rate-limit wait worth sleeping through inline. Above this the 403/429 is PRIMARY-limit
 *  exhaustion (the reset can be tens of minutes out) — no retry budget can outlast it, and each
 *  capped sleep would stall a reconcile tick for minutes while spending more requests against an
 *  already-empty budget. Fail fast instead: the poll/outbox backoffs own recovery at that scale. */
const MAX_INLINE_RATE_WAIT_MS = 30_000;

/** GitHub's secondary rate limits answer 403 + Retry-After (not 429) — widen the retry predicate
 *  for THIS backend only. A huge (synthesized-from-reset) wait means primary exhaustion → NOT
 *  retryable. Everything else keeps the default transport/timeout/429/5xx set. */
function githubRetryable(e: HttpError): boolean {
  if (e instanceof HttpStatusError) {
    if (e.retryAfterMs != null && e.retryAfterMs > MAX_INLINE_RATE_WAIT_MS) return false; // primary exhaustion
    return e.status === 429 || e.status >= 500 || (e.status === 403 && e.retryAfterMs != null);
  }
  return true; // timeout / network
}

/** Why an issue is GONE (retrying cannot help), per documented status codes — or null for
 *  anything else. 301 = transferred to another repo; 410 = deleted (readable repo); 404 =
 *  deleted-or-inaccessible. The transition/ask paths map these to stale/StaleItemError. */
export function classifyGone(e: unknown): string | null {
  if (!(e instanceof HttpStatusError)) return null;
  if (e.status === 301) return "transferred to another repository";
  if (e.status === 410) return "deleted";
  if (e.status === 404) return "not found (deleted, or the token lost access)";
  return null;
}

/** Map a GitHub 401 to the typed auth error (bad/expired token). NOT 403 — GitHub's 403 is
 *  ambiguous (secondary rate limit, or a valid token that lacks a scope/permission), so it stays a
 *  generic HttpStatusError rather than being mis-reported as an auth failure. */
function asGithubAuthError(e: unknown): unknown {
  if (e instanceof HttpStatusError && e.status === 401) {
    return new SourceUnauthenticatedError({ reason: "rejected", hint: "GitHub rejected the token (401) — refresh GITHUB_TOKEN, or run `gh auth login`", cause: e });
  }
  return e;
}

/** Map a rate-limit 403/429 that SURVIVED the retry policy to the typed signal, so the reconciler
 *  holds the whole source until the reset instead of re-polling into an empty budget every tick.
 *  The limit is per ACCOUNT: with several hosts on one `gh` login (or one PAT), everyone's polls
 *  land on the same exhausted counter, and re-polling is what keeps it exhausted.
 *
 *  Two shapes qualify, per the documented headers: `x-ratelimit-remaining: 0` (the budget is gone
 *  — primary exhaustion) and a bare `Retry-After` (a secondary limit still asking us to wait after
 *  the retries gave up). A 403 with budget left and no Retry-After is the permission/scope case and
 *  stays an ordinary HttpStatusError. */
function asGithubRateLimitError(e: unknown, method: string, path: string): unknown {
  if (!(e instanceof HttpStatusError)) return e;
  if (e.status !== 403 && e.status !== 429) return e;
  const exhausted = e.rateLimitRemaining === 0;
  if (!exhausted && e.retryAfterMs == null) return e;
  // No reset stamp on a bare secondary 403 that also lacked Retry-After can't happen (one of the
  // two is set above), but clamp anyway so a zero/negative wait can't produce a no-op hold.
  const waitMs = Math.max(e.retryAfterMs ?? 0, 1_000);
  const reason = exhausted ? "rate limit exhausted (x-ratelimit-remaining: 0)" : "rate limited (Retry-After)";
  return new SourceRateLimitedError({
    resetAtMs: Date.now() + waitMs,
    exhausted,
    detail: `GitHub ${reason} on ${method} ${path} — HTTP ${e.status}; backing off for ${Math.ceil(waitMs / 1000)}s. The limit is per ACCOUNT: give each host its own GITHUB_TOKEN instead of a shared \`gh\` login.`,
    cause: e,
  });
}

// REST payload shapes (the fields we read; everything else rides along in `fields`).
export interface GhLabel {
  name: string;
}
export interface GhIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels?: (GhLabel | string)[];
  assignees?: { login: string }[];
  user?: { login: string } | null;
  body?: string | null;
  body_html?: string;
  pull_request?: unknown; // present ⇒ this "issue" is actually a PR
  html_url?: string;
  /** GitHub's native org-level issue type (GA 2025) — preferred over label mapping when present. */
  type?: { name?: string } | null;
  [key: string]: unknown;
}
/** The pull-request representation (GET /pulls/{n}) — only the fields materialize needs. The
 *  issues endpoints already serve a PR's title/body/labels/comments; this exists solely for the
 *  branch refs, which the issue view does not carry. */
export interface GhPull {
  head?: { ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
  draft?: boolean;
}
export interface GhComment {
  id: number;
  created_at: string;
  body?: string | null;
  body_html?: string;
  user?: { login: string } | null;
  html_url?: string;
}

export function labelNames(issue: GhIssue): string[] {
  return (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
}

/** Test seam: the process-wide budget buckets, overridable per client instance. */
export interface GithubBudget {
  read: readonly TokenBucket[];
  mutation: readonly TokenBucket[];
}

export class GithubIssuesClient {
  private readonly repo: string; // owner/name
  private readonly envToken: string | undefined;
  private readonly tokenCmd: () => Promise<string | null>;
  private readonly budget: GithubBudget;
  private readonly log: Logger;
  private token: string | undefined; // memoized SUCCESSFUL bootstrap only (never cache a failure)

  constructor(repo: string, envToken?: string, tokenCmd?: () => Promise<string | null>, budget?: GithubBudget, log: Logger = () => {}) {
    this.repo = repo;
    this.envToken = envToken?.trim() || undefined;
    this.budget = budget ?? { read: [githubReadBucket], mutation: GITHUB_MUTATION_BUCKETS };
    this.log = log;
    // Default bootstrap: the user's gh CLI session. Injectable for tests.
    this.tokenCmd =
      tokenCmd ??
      (async () => {
        const r = await run("gh", ["auth", "token"], { allowFail: true });
        return r.code === 0 ? r.stdout.trim() || null : null;
      });
  }

  private async authToken(): Promise<string> {
    if (this.envToken) return this.envToken;
    // Memoize only a SUCCESSFUL bootstrap: caching a failure (gh not yet logged in at factory
    // start) would keep the source dead for the process lifetime, since the 401-refresh path
    // only fires when a request was actually sent.
    if (this.token === undefined) this.token = (await this.tokenCmd()) ?? undefined;
    if (!this.token) {
      throw new SourceUnauthenticatedError({
        reason: "missing",
        hint: "GitHub auth missing — set GITHUB_TOKEN in the repo env, or authenticate the gh CLI (`gh auth login`)",
      });
    }
    return this.token;
  }

  /** Cheap, no-network auth probe for the source's authStatus(): resolves a token (env or the gh
   *  CLI) or throws SourceUnauthenticatedError. Reuses authToken so the memoization/rotation rules
   *  are identical to a real call's. */
  async probeAuth(): Promise<void> {
    await this.authToken();
  }

  /** One API round-trip: auth → manual-redirect fetch through the budget buckets → JSON. A 401
   *  invalidates the memoized gh-CLI token and retries ONCE (token rotation); the env token is
   *  authoritative and never refreshed. Non-2xx (incl. 301/410 — see classifyGone) throw
   *  HttpStatusError. */
  private async request(method: string, path: string, opts: { body?: unknown; accept?: string; mutation?: boolean } = {}): Promise<HttpResponse> {
    const attempt = async (): Promise<HttpResponse> => {
      const policy: HttpPolicy = {
        buckets: opts.mutation ? this.budget.mutation : this.budget.read,
        isRetryable: githubRetryable,
        onAttempt: () => countGithubCall("rest"),
        // Bounded inline waits on BOTH paths — a reconcile tick must never stall for minutes on
        // rate-limit sleeps. Mutations fail fast back to their durable retry loop (the transition
        // outbox) and retry only once (a timed-out write may have landed — comment duplication
        // over retry storms); reads keep two retries but cap each honored wait.
        ...(opts.mutation ? { retries: 1, maxRetryAfterMs: 15_000 } : { retries: 2, maxRetryAfterMs: 10_000 }),
      };
      const res = await httpOk(
        {
          url: `${API}${path}`,
          method,
          redirect: "manual",
          timeoutMs: JSON_TIMEOUT_MS,
          headers: {
            Authorization: `Bearer ${await this.authToken()}`,
            Accept: opts.accept ?? "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        },
        policy,
      );
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      if (Number.isFinite(remaining)) recordRateLimitRemaining(remaining, { backend: "github", resource: res.headers.get("x-ratelimit-resource") ?? "core" });
      return res;
    };
    // Both classifiers run on every escape: a 401 becomes the auth signal, a rate-limit 403/429
    // becomes the backoff signal, and anything else passes through untouched.
    const classify = (e: unknown): unknown => asGithubRateLimitError(asGithubAuthError(e), method, path);
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 401 && !this.envToken && this.token !== undefined) {
        this.log("warn", `github: 401 with a memoized gh-CLI token — refreshing it once (${method} ${path})`);
        telemetryEvent("github.token_refreshed", { "http.request.method": method });
        this.token = undefined; // gh CLI token rotated — refetch once
        try {
          return await attempt();
        } catch (e2) {
          throw classify(e2); // still 401 after a rotation ⇒ the credential itself is bad
        }
      }
      throw classify(e);
    }
  }

  private async json<T>(method: string, path: string, opts: { body?: unknown; accept?: string; mutation?: boolean } = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    return (res.text ? JSON.parse(res.text) : {}) as T;
  }

  /** Open issues carrying `label`, oldest first, one page of 100. The list endpoint interleaves
   *  PRs (they carry a `pull_request` key) — the CALLER filters, so the contamination rule stays
   *  visible at the eligibility policy layer. */
  async listOpenIssuesByLabel(label: string, page: number): Promise<GhIssue[]> {
    const q = `labels=${encodeURIComponent(label)}&state=open&sort=created&direction=asc&per_page=100&page=${page}`;
    return this.json<GhIssue[]>("GET", `/repos/${this.repo}/issues?${q}`);
  }

  /** `full: true` asks for application/vnd.github.full+json, whose body_html carries the
   *  JWT-signed attachment URLs that actually resolve on private repos (raw-body
   *  /user-attachments URLs 404 under PATs). */
  async getIssue(n: number, opts: { full?: boolean } = {}): Promise<GhIssue> {
    return this.json<GhIssue>("GET", `/repos/${this.repo}/issues/${n}`, {
      accept: opts.full ? "application/vnd.github.full+json" : undefined,
    });
  }

  /** The PR view of #n — for the head/base refs a `kind: pull_requests` work doc carries. */
  async getPull(n: number): Promise<GhPull> {
    return this.json<GhPull>("GET", `/repos/${this.repo}/pulls/${n}`);
  }

  /** All comments on an issue (paginated), optionally only those updated since `since` — note
   *  `since` filters on updated_at, so callers must still guard on created_at (the
   *  edited-old-comment trap). */
  async listComments(n: number, opts: { since?: string; full?: boolean } = {}): Promise<GhComment[]> {
    const out: GhComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const q = [`per_page=100`, `page=${page}`, opts.since ? `since=${encodeURIComponent(opts.since)}` : ""].filter(Boolean).join("&");
      const batch = await this.json<GhComment[]>("GET", `/repos/${this.repo}/issues/${n}/comments?${q}`, {
        accept: opts.full ? "application/vnd.github.full+json" : undefined,
      });
      out.push(...batch);
      if (batch.length < 100) return out;
    }
    // Page 10 came back full — more comments exist. Callers assume completeness (materialize's
    // "all comments"; askHuman's idempotency scan), so never truncate silently.
    this.log("warn", `github: issue #${n} has over ${out.length} comments — the rest were not fetched`);
    return out;
  }

  async createComment(n: number, body: string): Promise<GhComment> {
    return this.json<GhComment>("POST", `/repos/${this.repo}/issues/${n}/comments`, { body: { body }, mutation: true });
  }

  async addLabels(n: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.json("POST", `/repos/${this.repo}/issues/${n}/labels`, { body: { labels }, mutation: true });
  }

  /** Remove a label from an issue; false = it wasn't there (documented 404 — benign, idempotent). */
  async removeLabel(n: number, label: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/repos/${this.repo}/issues/${n}/labels/${encodeURIComponent(label)}`, { mutation: true });
      return true;
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 404) return false;
      throw e;
    }
  }

  async closeIssue(n: number, reason: "completed" | "not_planned"): Promise<void> {
    await this.json("PATCH", `/repos/${this.repo}/issues/${n}`, { body: { state: "closed", state_reason: reason }, mutation: true });
  }

  /** Does the repo define this label? (GET /labels/{name} → 404 = no.) */
  async labelExists(name: string): Promise<boolean> {
    try {
      await this.request("GET", `/repos/${this.repo}/labels/${encodeURIComponent(name)}`);
      return true;
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 404) return false;
      throw e;
    }
  }

  /** Create a repo label, tolerating 422 = already exists (a concurrent creator won the race). */
  async createLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.json("POST", `/repos/${this.repo}/labels`, { body: { name, color, description }, mutation: true });
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 422) return;
      throw e;
    }
  }

  async getRepo(): Promise<{ has_issues?: boolean; permissions?: { push?: boolean } }> {
    return this.json("GET", `/repos/${this.repo}`);
  }

  /** Download an attachment/image (redirect-FOLLOWING — media URLs legitimately redirect to
   *  storage backends; unlike API calls there is no cross-repo mutation hazard on a GET for
   *  bytes). Authorization is deliberately NOT attached: these are JWT-signed/camo URLs where the
   *  signature IS the auth, and leaking the API token to arbitrary redirect targets would be
   *  worse than a failed download. */
  async downloadBytes(url: string): Promise<Buffer> {
    const res = await httpOkBytes(
      { url, timeoutMs: MEDIA_TIMEOUT_MS, redirect: "follow" },
      { buckets: this.budget.read, isRetryable: githubRetryable, retries: 2, maxRetryAfterMs: 10_000 },
    );
    return res.bytes;
  }
}
