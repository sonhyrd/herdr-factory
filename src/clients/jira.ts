import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraIssue } from "../types.ts";
import type { SourceAuthStatus } from "../core/deps.ts";
import { SourceUnauthenticatedError } from "../auth/errors.ts";
import type { JiraAuth } from "../auth/jira-provider.ts";
import { HttpStatusError, httpOk, httpOkBytes, TokenBucket, type HttpPolicy, type HttpResponse } from "./http.ts";

/** Map a Jira 401/403 to the typed auth error (else pass the error through unchanged). Jira uses
 *  Basic auth, so a 401/403 is unambiguously bad/expired credentials — not a scope/permission
 *  nuance like GitHub's 403. */
function asJiraAuthError(e: unknown): unknown {
  if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
    return new SourceUnauthenticatedError({
      reason: "rejected",
      hint: "Jira rejected the credentials (HTTP " + e.status + ") — re-authenticate (api_token: check JIRA_EMAIL + JIRA_API_TOKEN in the repo env; oauth: run `auth login`)",
      cause: e,
    });
  }
  return e;
}

/** Time budget for a JSON API round-trip; media downloads get a larger one. Both are HARD
 *  bounds — a black-holed Jira connection must never wedge a reconcile tick. */
const JIRA_TIMEOUT_MS = 30_000;
const JIRA_MEDIA_TIMEOUT_MS = 120_000;

// Client-side ceiling on our Jira load: 5 req/s sustained with a burst of 10, shared by every
// call this client makes (a claim burst is ~5 calls per ticket; parked runs poll comments). Jira
// Cloud's per-user budget is comfortably above this — the point is to smooth OUR spikes so we
// never trip 429s in the first place; the retry policy (Retry-After-aware) handles the rest.
const JIRA_RATE_PER_SEC = 5;
const JIRA_BURST = 10;

/** An eligible-issue search result with the fields a belt's match predicate routes on. `fields` is
 *  the raw Jira issue.fields object (summary/issuetype/status/labels) fetched by the pickup query. */
export interface JiraEligible {
  key: string;
  summary: string;
  type: string;
  status: string;
  labels: string[];
  fields: Record<string, unknown>;
}

export interface JiraComment {
  id: string;
  created?: string;
  updated?: string;
  author?: { displayName?: string; accountId?: string };
  body?: unknown;
}

function adfDoc(text: string): unknown {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

/** Jira Cloud REST via fetch. Auth (api_token Basic, or OAuth Bearer + the api.atlassian.com base)
 *  is owned by the injected JiraAuth — the client just asks it for the per-request base + headers,
 *  and on a 401/403 gives it one chance to recover (OAuth token refresh) before surfacing a typed
 *  auth error. All calls share one token bucket and a Retry-After-honoring retry policy (http.ts). */
export class JiraClient {
  private readonly auth: JiraAuth;
  private readonly bucket = new TokenBucket(JIRA_RATE_PER_SEC, JIRA_BURST);
  constructor(auth: JiraAuth) {
    this.auth = auth;
  }

  /** The provider's cheap, no-network auth readiness (drives the source's authStatus / INV-12). */
  authStatus(): SourceAuthStatus {
    return this.auth.status();
  }

  /** One authorized request: resolve base + headers, send, and on a 401/403 let the provider try to
   *  recover once (OAuth refresh) before mapping to a typed SourceUnauthenticatedError. `path` is
   *  joined onto the provider's base (which differs between api_token and OAuth). */
  private async send(path: string, init: { method?: string; body?: unknown }, policy: HttpPolicy): Promise<HttpResponse> {
    const attempt = async (): Promise<HttpResponse> => {
      const { baseUrl, headers } = await this.auth.authorize();
      return httpOk(
        {
          url: baseUrl + path,
          method: init.method,
          headers: { ...headers, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          timeoutMs: JIRA_TIMEOUT_MS,
        },
        policy,
      );
    };
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403) && (await this.auth.reauthorize())) {
        try {
          return await attempt();
        } catch (e2) {
          throw asJiraAuthError(e2);
        }
      }
      throw asJiraAuthError(e);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.send(path, {}, { bucket: this.bucket });
    return JSON.parse(res.text) as T;
  }

  // POST retries are bounded to 1: a 429 was definitively not processed (safe), but a timed-out
  // or 5xx write may have landed — a rare duplicate comment is acceptable noise, a retry storm
  // of writes is not.
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.send(path, { method: "POST", body }, { bucket: this.bucket, retries: 1 });
    return JSON.parse(res.text) as T;
  }

  /** Eligible pickups on Agile `board` at status `todoStatus` and (when given) label `label` — the
   *  belt's pickup label. Pulls via the Agile board issue endpoint (`/rest/agile/1.0/board/<id>/issue`),
   *  so the board's own saved filter scopes the query and the project + status + label JQL narrows
   *  within it. Returns each issue's routing fields (status/labels + the raw fields object) so a belt's
   *  match predicate can route at claim time. `label` is omitted only by the doctor's connectivity
   *  probe; the real belt flow always passes one. NB: the Agile API needs Basic (api_token) auth — it
   *  is not reachable with an OAuth token, which is why the Jira source is api_token only. */
  async listEligible(board: string, project: string, label: string | undefined, todoStatus: string): Promise<JiraEligible[]> {
    const labelClause = label ? ` AND labels = "${label}"` : "";
    const jql = `project = "${project}" AND status = "${todoStatus}"${labelClause} ORDER BY created ASC`;
    const data = await this.getJson<{
      issues?: {
        key: string;
        fields: { summary: string; issuetype: { name: string }; status?: { name: string }; labels?: string[] };
      }[];
    }>(`/rest/agile/1.0/board/${encodeURIComponent(board)}/issue?jql=${encodeURIComponent(jql)}&fields=summary,issuetype,status,labels&maxResults=50`);
    return (data.issues ?? []).map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      type: i.fields.issuetype.name,
      status: i.fields.status?.name ?? todoStatus,
      labels: i.fields.labels ?? [],
      fields: i.fields as Record<string, unknown>,
    }));
  }

  async getIssue(key: string): Promise<JiraIssue> {
    return this.getJson<JiraIssue>(
      `/rest/api/3/issue/${key}?fields=summary,description,issuetype,status,labels,attachment,comment`,
    );
  }

  /** Every field plus the id → display-name map — edit detection's read (the rich-text custom
   *  fields, e.g. acceptance criteria, have per-site ids, so they can't be named in `fields=`). */
  async getIssueAllFields(key: string): Promise<{ fields?: Record<string, unknown>; names?: Record<string, string> }> {
    return this.getJson(`/rest/api/3/issue/${key}?fields=*all&expand=names`);
  }

  async currentStatus(key: string): Promise<string> {
    return (await this.getIssue(key)).fields.status?.name ?? "";
  }

  async addComment(key: string, text: string): Promise<JiraComment> {
    return this.postJson<JiraComment>(`/rest/api/3/issue/${key}/comment`, { body: adfDoc(text) });
  }

  /** EVERY comment, oldest first — or newest first with `newestFirst` (the claim ledger). Paged in
   *  100s until the server's own `total` is reached: callers assume completeness (the claim ledger
   *  must see an old claim comment; askHuman's idempotency scan must see its own question), so this
   *  never truncates. */
  async listComments(key: string, newestFirst = false): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    for (;;) {
      const data = await this.getJson<{ comments?: JiraComment[]; total?: number }>(
        `/rest/api/3/issue/${key}/comment?orderBy=${newestFirst ? "-created" : "created"}&startAt=${out.length}&maxResults=100`,
      );
      const page = data.comments ?? [];
      out.push(...page);
      // Stop on a short/empty page (also the guard against a server whose `total` never settles).
      if (page.length < 100 || out.length >= (data.total ?? 0)) return out;
    }
  }

  /** Idempotent, case-insensitive transition. Returns false if already in target. */
  async transition(key: string, targetName: string): Promise<boolean> {
    const current = await this.currentStatus(key);
    if (current.toLowerCase() === targetName.toLowerCase()) return false;
    const tr = await this.getJson<{ transitions?: { id: string; to?: { name?: string } }[] }>(
      `/rest/api/3/issue/${key}/transitions`,
    );
    const match = (tr.transitions ?? []).find((t) => t.to?.name?.toLowerCase() === targetName.toLowerCase());
    if (!match) throw new Error(`${key}: no transition from "${current}" to "${targetName}"`);
    // The transition POST returns 204 with an empty body — send() (not postJson, which parses).
    await this.send(`/rest/api/3/issue/${key}/transitions`, { method: "POST", body: { transition: { id: match.id } } }, { bucket: this.bucket, retries: 1 });
    return true;
  }

  /**
   * Download image + video attachments (image/* and video/*, count + per-type size
   * capped). Returns saved filenames. Other mime types (PDFs, logs, …) are skipped.
   */
  async downloadAttachments(
    key: string,
    outDir: string,
    max: number,
    maxImageBytes: number,
    maxVideoBytes: number,
  ): Promise<string[]> {
    const issue = await this.getIssue(key);
    mkdirSync(outDir, { recursive: true });
    // Attachment `content` URLs are absolute, so they're fetched directly (not via send()'s base
    // join) — but they still need the source's auth headers, resolved once here.
    const { headers } = await this.auth.authorize();
    const media = (issue.fields.attachment ?? [])
      .filter((a) => {
        const mime = a.mimeType ?? "";
        const size = a.size ?? 0;
        return (
          (mime.startsWith("image/") && size <= maxImageBytes) ||
          (mime.startsWith("video/") && size <= maxVideoBytes)
        );
      })
      .slice(0, max);
    const saved: string[] = [];
    for (const a of media) {
      let buf: Buffer;
      try {
        buf = (
          await httpOkBytes(
            { url: a.content, headers: { ...headers, Accept: "application/json" }, timeoutMs: JIRA_MEDIA_TIMEOUT_MS },
            { bucket: this.bucket, retries: 1 },
          )
        ).bytes;
      } catch {
        continue; // one bad attachment (4xx/timeout) shouldn't sink the rest
      }
      const safe = a.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      writeFileSync(join(outDir, safe), buf);
      saved.push(safe);
    }
    return saved;
  }
}
