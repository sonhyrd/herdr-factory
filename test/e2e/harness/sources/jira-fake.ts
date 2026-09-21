// A fake Jira Cloud backend: a real HTTP server that actually holds issues, moves them through a
// workflow, and stores comments — so the e2e suite can drive the ENGINE'S OWN JiraClient/JiraSource
// against it end to end.
//
// WHY this can exist at all: the jira source takes a configurable `base_url` (jira.base_url →
// JiraApiTokenAuth's base), so pointing it at 127.0.0.1 needs no seam in the engine. (github_issues
// needed one — it grew `GITHUB_API_URL`; see ./github-fake.ts.)
//
// WHY it holds state instead of canned answers (HttpStub's job): the source-parity scenarios assert
// the LIFECYCLE, not the payloads — that a claim really moved the ticket out of the pickup query
// (INV-1 re-claim convergence), that the status trail is ordered, that askHuman's question and the
// human's reply are two distinguishable comments on the same issue (INV-5/INV-6). None of that is
// observable against a route table.
//
// Every path, query parameter, request body and response shape below is taken from
// src/clients/jira.ts + src/clients/jira-source.ts, not from the public Jira docs — the fake's job is
// to answer what THIS client asks, and to be loudly wrong (400/404 with a message naming the path)
// when it asks something new, so an engine change shows up here instead of silently degrading.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** The workflow a fresh fake knows. A transition is offered to every status in the set, so a belt
 *  configured with other status names (`In development`, `QA Review`, …) must add them —
 *  `jira.statuses.add("QA Review")` — or the engine gets Jira's own honest
 *  `no transition from "X" to "Y"`. */
const DEFAULT_STATUSES = ["To Do", "In Progress", "In Review", "Done"];

/** Jira renders timestamps as `2026-06-28T09:15:00.000+0000` (note: no colon in the offset). The
 *  engine's reply cutoff runs `Date.parse()` over exactly this string, so the format is part of the
 *  contract under test — don't "clean it up" to ISO. */
function jiraTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "+0000");
}

/** Plain text → an ADF document, byte-compatible with what JiraClient.addComment posts (one
 *  paragraph per line, empty lines as empty paragraphs). Used for seeded descriptions and for the
 *  human replies a scenario injects, so the engine's extractor sees a real Jira body. */
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

/** ADF → text, mirroring `bodyText` in src/clients/jira-source.ts. Deliberately a MIRROR, not an
 *  import: `comments()` must show a scenario what the engine will extract, and if the engine's
 *  extraction changes, the divergence should be visible in a diff here rather than silently tracked. */
function adfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const rec = node as Record<string, unknown>;
  let out = typeof rec.text === "string" ? rec.text : "";
  const content = Array.isArray(rec.content) ? rec.content : [];
  for (const child of content) out += adfText(child);
  if (rec.type === "paragraph" || rec.type === "heading") out += "\n";
  if (rec.type === "hardBreak") out += "\n";
  return out;
}

/** One issue attachment. `bytes` are served at the `content` URL the issue advertises; `size` may be
 *  overstated to exercise the client's per-type size cap without allocating megabytes. */
export interface JiraFakeAttachment {
  filename: string;
  mimeType: string;
  bytes?: Buffer | string;
  size?: number;
}

/** What a scenario seeds. `key` must look like a Jira key (`PROJ-12`): its prefix is the project the
 *  pickup JQL filters on, and the engine treats the key as a shell token / branch segment (INV-7). */
export interface JiraFakeSeed {
  key: string;
  summary: string;
  type?: string;
  status?: string;
  labels?: string[];
  description?: string;
  attachments?: JiraFakeAttachment[];
}

/** A comment as a scenario reads it back: `body` is the TEXT the engine will extract from the stored
 *  ADF, which is what assertions (markers, question ids, reply text) are written against. */
export interface JiraFakeComment {
  id: string;
  body: string;
  author: string;
  created: string;
}

/** One logged request. `path` is the raw request target (pathname + query), so a scenario can assert
 *  on the JQL and the `fields` projection the engine sent, not just the endpoint it hit. */
export interface JiraFakeRequest {
  ts: number;
  method: string;
  path: string;
  body: string;
}

interface StoredComment {
  id: string;
  /** Exactly the ADF the client POSTed (or the ADF built for an injected human reply) — stored
   *  verbatim so the engine reads back what it wrote, round-trip losses included. */
  body: unknown;
  text: string;
  author: { displayName: string; accountId: string };
  created: string;
}

interface StoredAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  bytes: Buffer;
}

interface StoredIssue {
  id: string;
  key: string;
  project: string;
  seq: number;
  summary: string;
  type: string;
  status: string;
  labels: string[];
  description: string;
  created: string;
  updated: string;
  /** Applied transitions in order — the seeded status is NOT in here (see `statusHistory`). */
  history: string[];
  comments: StoredComment[];
  attachments: StoredAttachment[];
}

interface StatusJson {
  id: string;
  name: string;
  statusCategory: { id: number; key: string; name: string };
}

/** The engine matches a transition case-insensitively on `.to.name` — that field is the contract. */
interface TransitionJson {
  id: string;
  name: string;
  to: StatusJson;
}

function statusCategory(name: string): { id: number; key: string; name: string } {
  const n = name.toLowerCase();
  if (/(^|\b)(to ?do|open|backlog|new)(\b|$)/.test(n)) return { id: 2, key: "new", name: "To Do" };
  if (/(done|closed|resolved|complete)/.test(n)) return { id: 3, key: "done", name: "Done" };
  return { id: 4, key: "indeterminate", name: "In Progress" };
}

/**
 * A stateful Jira Cloud stand-in on 127.0.0.1. `listen()` binds a free port; `url` is what
 * `jira.base_url` should be set to.
 *
 * ```ts
 * const jira = new JiraFake({ project: "APP", boardId: 1 });
 * await jira.listen();
 * jira.seed({ key: "APP-1", summary: "Crash on save", labels: ["agent"] });
 * // … the belt claims it …
 * expect(jira.statusHistory("APP-1")).toEqual(["In Progress", "In Review"]);
 * jira.addComment("APP-1", "Go with option B.", "Pat");   // a human answers the factory's question
 * ```
 */
export class JiraFake {
  private server: Server | null = null;
  private port = 0;
  private readonly issues = new Map<string, StoredIssue>();
  private readonly log: JiraFakeRequest[] = [];
  private readonly statusIds = new Map<string, { statusId: string; transitionId: string }>();
  private nextIssueId = 10000;
  private nextCommentId = 10000;
  private nextAttachmentId = 20000;
  private nextStatusId = 10100;
  private nextTransitionId = 11;
  private nextSeq = 0;
  /** Comment timestamps are forced strictly increasing: the reply poll's fallback path selects
   *  comments created STRICTLY AFTER the question, and two comments in the same millisecond would
   *  make that path flaky in a way real Jira (seconds apart) never is. */
  private lastCommentMs = 0;

  /** The project the seeded keys belong to (a key's own `PROJ-` prefix wins; this is the fallback
   *  for a key without one). */
  readonly project: string;
  /** The Agile board id pickup must address — any other id answers 404, so a mistyped `jira.board`
   *  fails loudly instead of quietly finding nothing. */
  readonly boardId: number;
  /** Statuses this workflow can reach. Mutable: `add` one your belt configures, `delete` one to
   *  prove the engine's "no transition from X to Y" error. */
  readonly statuses: Set<string>;

  /** 401 every call that arrives without a `Basic` Authorization header. On by default — the Agile
   *  API is Basic-only (a Bearer token is rejected too), which is why the jira source is api_token
   *  only, and a fake that accepted anonymous calls would hide a regression that dropped the header. */
  requireAuth = true;
  /** Force this status on EVERY call (401/403 = credentials rejected, 429/500/503 = backend down).
   *  Checked before auth and before routing. */
  failWith: number | null = null;
  /** Keys that no longer exist: excluded from the board search and answered `goneStatus` on every
   *  per-issue endpoint (deleted, moved to another project, or permission revoked). */
  readonly gone = new Set<string>();
  /** What a `gone` key answers — 404 is what Jira sends; 410 exists for symmetry with the sources
   *  that use it. */
  goneStatus = 404;

  constructor(opts: { project?: string; boardId?: number; statuses?: string[] } = {}) {
    this.project = opts.project ?? "APP";
    this.boardId = opts.boardId ?? 1;
    this.statuses = new Set([...DEFAULT_STATUSES, ...(opts.statuses ?? [])]);
  }

  get url(): string {
    if (!this.port) throw new Error("JiraFake: listen() first — the URL is only known once bound");
    return `http://127.0.0.1:${this.port}`;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      if (!server) return resolve();
      // undici (global fetch) holds keep-alive sockets open, so a plain close() waits for the pool
      // to idle out and a scenario's afterStop hangs. Drop the connections explicitly.
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  // ── seeding + inspection (the scenario-facing surface) ────────────────────────────────────────

  seed(issue: JiraFakeSeed): void {
    const key = issue.key.trim();
    if (this.issues.has(key)) throw new Error(`JiraFake: ${key} is already seeded`);
    const status = issue.status ?? "To Do";
    this.statuses.add(status);
    const now = Date.now() + this.nextSeq; // distinct `created` per issue: ORDER BY created ASC is stable
    this.issues.set(key, {
      id: String(this.nextIssueId++),
      key,
      project: key.includes("-") ? key.slice(0, key.lastIndexOf("-")) : this.project,
      seq: this.nextSeq++,
      summary: issue.summary,
      type: issue.type ?? "Task",
      status,
      labels: issue.labels ?? [],
      description: issue.description ?? "",
      created: jiraTimestamp(now),
      updated: jiraTimestamp(now),
      history: [],
      comments: [],
      attachments: (issue.attachments ?? []).map((a) => {
        const bytes = Buffer.isBuffer(a.bytes) ? a.bytes : Buffer.from(a.bytes ?? "");
        return { id: String(this.nextAttachmentId++), filename: a.filename, mimeType: a.mimeType, size: a.size ?? bytes.length, bytes };
      }),
    });
  }

  /** The issue's CURRENT status name. */
  status(key: string): string {
    return this.must(key).status;
  }

  /** Every applied transition, in order. The seeded status is not included — the full trail is
   *  `[seedStatus, ...statusHistory(key)]` — so an assertion reads as the moves the factory made. */
  statusHistory(key: string): string[] {
    return [...this.must(key).history];
  }

  /** Comments oldest first, with the ADF flattened to the text the engine extracts. */
  comments(key: string): JiraFakeComment[] {
    return this.must(key).comments.map((c) => ({ id: c.id, body: c.text, author: c.author.displayName, created: c.created }));
  }

  /** A HUMAN reply arriving on the issue (unmarked — this is what pollHumanReply must pick up).
   *  Returns the new comment id. */
  addComment(key: string, body: string, author = "Pat Human"): string {
    const issue = this.must(key);
    return this.appendComment(issue, adfDoc(body), body, author).id;
  }

  /** Requests seen so far, optionally filtered by a substring of `<METHOD> <path>` (e.g.
   *  `"/rest/agile/"`, `"POST /rest/api/3/issue/APP-1/transitions"`). */
  requests(match?: string): JiraFakeRequest[] {
    return match ? this.log.filter((r) => `${r.method} ${r.path}`.includes(match)) : [...this.log];
  }

  /** Truncate the request log (per-phase call budgets); issues and comments are untouched. */
  reset(): void {
    this.log.length = 0;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const target = req.url ?? "/";
    const method = req.method ?? "GET";
    this.log.push({ ts: Date.now(), method, path: target, body: Buffer.concat(chunks).toString("utf8") });

    if (this.failWith != null) return this.fail(res, this.failWith, `JiraFake.failWith=${this.failWith} (injected)`);
    if (this.requireAuth && !(req.headers.authorization ?? "").startsWith("Basic ")) {
      return this.fail(res, 401, "Client must be authenticated to access this resource.");
    }

    const url = new URL(target, "http://jira.fake");
    const path = url.pathname;
    const body = Buffer.concat(chunks).toString("utf8");

    const board = /^\/rest\/agile\/1\.0\/board\/([^/]+)\/issue$/.exec(path);
    if (board && method === "GET") return this.boardIssues(res, decodeURIComponent(board[1] ?? ""), url);

    const attachment = /^\/rest\/api\/3\/attachment\/content\/([^/]+)$/.exec(path);
    if (attachment && method === "GET") return this.attachmentContent(res, decodeURIComponent(attachment[1] ?? ""));

    const issuePath = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(path);
    if (issuePath) {
      const key = decodeURIComponent(issuePath[1] ?? "");
      const issue = this.lookup(key);
      // A GONE key answers the injected status (404 by default, 410 if a scenario wants it); a key
      // that was never seeded is a plain 404, the same answer Jira gives for a typo.
      if (!issue) {
        return this.fail(res, this.isGone(key) ? this.goneStatus : 404, "Issue does not exist or you do not have permission to see it.");
      }
      const sub = issuePath[2];
      if (!sub && method === "GET") return this.json(res, 200, this.issueJson(issue, this.fieldList(url)));
      if (sub === "/comment" && method === "GET") return this.listComments(res, issue, url);
      if (sub === "/comment" && method === "POST") return this.postComment(res, issue, body);
      if (sub === "/transitions" && method === "GET") return this.json(res, 200, { expand: "transitions", transitions: this.transitionsFor(issue) });
      if (sub === "/transitions" && method === "POST") return this.postTransition(res, issue, body);
    }

    // Loud by design: a path this fake doesn't serve means the engine started calling something new,
    // and a bland `{}` would let that pass as an empty-but-successful answer.
    return this.fail(res, 404, `JiraFake serves no route for ${method} ${path} — add it (and check src/clients/jira.ts).`);
  }

  /** GET /rest/agile/1.0/board/<id>/issue?jql=…&fields=…&maxResults=… — the pickup query. */
  private boardIssues(res: ServerResponse, boardId: string, url: URL): void {
    if (boardId !== String(this.boardId)) {
      return this.fail(res, 404, `Board ${boardId} does not exist or you do not have permission to view it.`);
    }
    const jql = url.searchParams.get("jql");
    let filter: { project?: string; status?: string; label?: string; desc: boolean };
    try {
      filter = parseJql(jql);
    } catch (e) {
      return this.fail(res, 400, e instanceof Error ? e.message : String(e));
    }
    const maxResults = Number(url.searchParams.get("maxResults") ?? "50") || 50;
    const fields = this.fieldList(url);
    const matched = [...this.issues.values()]
      .filter((i) => !this.isGone(i.key))
      .filter((i) => (filter.project ? i.project.toLowerCase() === filter.project.toLowerCase() : true))
      .filter((i) => (filter.status ? i.status.toLowerCase() === filter.status.toLowerCase() : true))
      .filter((i) => (filter.label ? i.labels.some((l) => l.toLowerCase() === filter.label?.toLowerCase()) : true))
      .sort((a, b) => (filter.desc ? b.seq - a.seq : a.seq - b.seq));
    const page = matched.slice(0, maxResults);
    this.json(res, 200, {
      expand: "schema,names",
      startAt: 0,
      maxResults,
      total: matched.length,
      isLast: page.length === matched.length,
      issues: page.map((i) => this.issueJson(i, fields)),
    });
  }

  /** GET /rest/api/3/issue/<key>/comment?orderBy=created&startAt=0&maxResults=100 — paged, like the
   *  real endpoint: the client walks `startAt` until `total`. */
  private listComments(res: ServerResponse, issue: StoredIssue, url: URL): void {
    const orderBy = url.searchParams.get("orderBy") ?? "created";
    const maxResults = Number(url.searchParams.get("maxResults") ?? "100") || 100;
    const startAt = Number(url.searchParams.get("startAt") ?? "0") || 0;
    const ordered = orderBy.startsWith("-") ? [...issue.comments].reverse() : [...issue.comments];
    const page = ordered.slice(startAt, startAt + maxResults);
    this.json(res, 200, { startAt, maxResults, total: issue.comments.length, comments: page.map((c) => this.commentJson(c, issue)) });
  }

  /** POST /rest/api/3/issue/<key>/comment {"body": <ADF>} → 201 with the created comment. */
  private postComment(res: ServerResponse, issue: StoredIssue, raw: string): void {
    let payload: { body?: unknown };
    try {
      payload = JSON.parse(raw) as { body?: unknown };
    } catch {
      return this.fail(res, 400, "Comment body is not valid JSON.");
    }
    if (payload.body === undefined) return this.fail(res, 400, "Comment body is required.");
    // v3 wants ADF; a bare string is v2's shape and would mean the client regressed.
    if (typeof payload.body === "string") return this.fail(res, 400, "Comment body must be an ADF document (Jira Cloud REST v3), not a string.");
    const stored = this.appendComment(issue, payload.body, adfText(payload.body).replace(/\n{3,}/g, "\n\n").trim(), "herdr-factory bot");
    this.json(res, 201, this.commentJson(stored, issue));
  }

  /** POST /rest/api/3/issue/<key>/transitions {"transition":{"id":"…"}} → 204 with NO body (the
   *  engine deliberately sends this one through `send()` rather than a JSON-parsing helper). */
  private postTransition(res: ServerResponse, issue: StoredIssue, raw: string): void {
    let payload: { transition?: { id?: string } };
    try {
      payload = JSON.parse(raw) as { transition?: { id?: string } };
    } catch {
      return this.fail(res, 400, "Transition body is not valid JSON.");
    }
    const id = typeof payload.transition?.id === "string" ? payload.transition.id : undefined;
    if (!id) return this.fail(res, 400, "transition.id is required.");
    const match = this.transitionsFor(issue).find((t) => t.id === id);
    if (!match) {
      return this.fail(res, 400, `Transition id ${id} is not valid for issue ${issue.key} in status "${issue.status}".`);
    }
    issue.status = match.to.name;
    issue.history.push(match.to.name);
    issue.updated = jiraTimestamp(Date.now());
    res.writeHead(204);
    res.end();
  }

  /** GET the absolute `content` URL an attachment advertises — auth headers included, which is why
   *  it lives on this server rather than a separate file host. */
  private attachmentContent(res: ServerResponse, id: string): void {
    for (const issue of this.issues.values()) {
      const found = issue.attachments.find((a) => a.id === id);
      if (!found) continue;
      if (this.isGone(issue.key)) return this.fail(res, this.goneStatus, "Issue does not exist or you do not have permission to see it.");
      res.writeHead(200, { "content-type": found.mimeType, "content-length": String(found.bytes.length) });
      res.end(found.bytes);
      return;
    }
    this.fail(res, 404, `Attachment ${id} not found.`);
  }

  // ── payload builders ──────────────────────────────────────────────────────────────────────────

  /** The requested `fields` list, or null for "everything" (`fields` absent or `*all`). */
  private fieldList(url: URL): string[] | null {
    const raw = url.searchParams.get("fields");
    if (!raw || raw === "*all") return null;
    return raw.split(",").map((f) => f.trim());
  }

  private issueJson(issue: StoredIssue, want: string[] | null): Record<string, unknown> {
    const all: [string, unknown][] = [
      ["summary", issue.summary],
      ["description", issue.description ? adfDoc(issue.description) : null],
      ["issuetype", { id: "10001", name: issue.type, subtask: false }],
      ["status", this.statusJson(issue.status)],
      ["labels", [...issue.labels]],
      ["created", issue.created],
      ["updated", issue.updated],
      [
        "attachment",
        issue.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          created: issue.created,
          // ABSOLUTE, exactly as Jira sends it — downloadAttachments fetches this URL directly
          // instead of joining it onto the auth provider's base.
          content: `${this.url}/rest/api/3/attachment/content/${a.id}`,
        })),
      ],
      ["comment", { comments: issue.comments.map((c) => this.commentJson(c, issue)), maxResults: issue.comments.length, total: issue.comments.length, startAt: 0 }],
    ];
    const fields: Record<string, unknown> = {};
    for (const [name, value] of all) if (!want || want.includes(name)) fields[name] = value;
    return { id: issue.id, key: issue.key, self: `${this.url}/rest/api/3/issue/${issue.id}`, fields };
  }

  private statusJson(name: string): StatusJson {
    return { id: this.idsFor(name).statusId, name, statusCategory: statusCategory(name) };
  }

  private commentJson(c: StoredComment, issue: StoredIssue): Record<string, unknown> {
    return {
      self: `${this.url}/rest/api/3/issue/${issue.id}/comment/${c.id}`,
      id: c.id,
      author: { accountId: c.author.accountId, displayName: c.author.displayName, active: true },
      body: c.body,
      created: c.created,
      updated: c.created,
    };
  }

  /** Every status but the current one is reachable — a deliberately permissive workflow, because the
   *  BELT owns the ordering under test (asserted through `statusHistory`), not Jira's graph.
   *  The transition's own `name` is deliberately NOT the target status name: the engine matches on
   *  `.to.name`, and a regression that matched `.name` instead must fail here. */
  private transitionsFor(issue: StoredIssue): TransitionJson[] {
    const seen = new Set<string>([issue.status.toLowerCase()]);
    const out: TransitionJson[] = [];
    for (const status of this.statuses) {
      const k = status.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: this.idsFor(status).transitionId, name: `Move to ${status.toLowerCase()}`, to: this.statusJson(status) });
    }
    return out;
  }

  private idsFor(status: string): { statusId: string; transitionId: string } {
    const k = status.toLowerCase();
    const existing = this.statusIds.get(k);
    if (existing) return existing;
    const ids = { statusId: String(this.nextStatusId++), transitionId: String(this.nextTransitionId) };
    this.nextTransitionId += 10; // 11, 21, 31 … the shape Jira's own workflow ids take
    this.statusIds.set(k, ids);
    return ids;
  }

  private appendComment(issue: StoredIssue, body: unknown, text: string, author: string): StoredComment {
    const at = Math.max(Date.now(), this.lastCommentMs + 1);
    this.lastCommentMs = at;
    const stored: StoredComment = {
      id: String(this.nextCommentId++),
      body,
      text,
      author: { displayName: author, accountId: `acct:${author.replace(/[^A-Za-z0-9]/g, "-").toLowerCase()}` },
      created: jiraTimestamp(at),
    };
    issue.comments.push(stored);
    issue.updated = stored.created;
    return stored;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────────────────────────

  /** Case-insensitive key lookup (Jira accepts either case and answers with the canonical key), also
   *  by numeric issue id. Returns undefined for a `gone` key. */
  private lookup(keyOrId: string): StoredIssue | undefined {
    if (this.isGone(keyOrId)) return undefined;
    const wanted = keyOrId.toLowerCase();
    for (const issue of this.issues.values()) {
      if (issue.key.toLowerCase() === wanted || issue.id === keyOrId) return this.isGone(issue.key) ? undefined : issue;
    }
    return undefined;
  }

  private isGone(key: string): boolean {
    if (this.gone.has(key)) return true;
    const wanted = key.toLowerCase();
    for (const g of this.gone) if (g.toLowerCase() === wanted) return true;
    return false;
  }

  /** Inspection accessor: throws (listing what IS seeded) rather than returning undefined, because a
   *  typo'd key in an assertion should read as a harness error, not as "no comments yet". */
  private must(key: string): StoredIssue {
    const issue = [...this.issues.values()].find((i) => i.key.toLowerCase() === key.toLowerCase());
    if (!issue) throw new Error(`JiraFake: no issue ${key} (seeded: ${[...this.issues.keys()].join(", ") || "none"})`);
    return issue;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** Jira's error envelope. `message` is carried too because HttpStatusError puts the body text into
   *  its message — a diagnosable failure beats a bare status code in a scenario's log. */
  private fail(res: ServerResponse, status: number, message: string): void {
    this.json(res, status, { errorMessages: [message], errors: {}, message, "status-code": status });
  }
}

/** Parse the pickup JQL the engine builds:
 *  `project = "PROJ" AND status = "To Do" [AND labels = "agent"] ORDER BY created ASC`.
 *  Anything outside that grammar throws → 400, so a change to the query shape surfaces as a failing
 *  pickup instead of a silently unfiltered board. */
function parseJql(jql: string | null): { project?: string; status?: string; label?: string; desc: boolean } {
  if (!jql) return { desc: false };
  const order = /\s+ORDER\s+BY\s+(.+)$/i.exec(jql);
  let desc = false;
  if (order) {
    const clause = (order[1] ?? "").trim().toLowerCase();
    if (clause !== "created asc" && clause !== "created desc") throw new Error(`JiraFake: unsupported ORDER BY in JQL: ${order[1]}`);
    desc = clause.endsWith("desc");
  }
  const where = order ? jql.slice(0, order.index) : jql;
  const out: { project?: string; status?: string; label?: string; desc: boolean } = { desc };
  for (const raw of where.split(/\s+AND\s+/i)) {
    const clause = raw.trim();
    if (!clause) continue;
    const m = /^(project|status|labels)\s*=\s*"([^"]*)"$/i.exec(clause);
    if (!m) throw new Error(`JiraFake: unsupported JQL clause: ${clause} (whole query: ${jql})`);
    const field = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? "";
    if (field === "project") out.project = value;
    else if (field === "status") out.status = value;
    else out.label = value;
  }
  return out;
}
