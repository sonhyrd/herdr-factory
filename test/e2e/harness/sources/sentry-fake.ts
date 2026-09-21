// A fake Sentry backend: enough of the REST API (`/api/0/…`) to drive the engine's OWN
// `SentryClient` + `SentrySource` (src/clients/sentry.ts, src/clients/sentry-source.ts) end to end.
//
// WHY this can exist at all: the sentry source takes a configurable `base_url`, so pointing it at
// `fake.url` swaps the whole backend without an engine seam — the same trick the jira fake uses.
// (github_issues needed one: it now resolves its base from `GITHUB_API_URL` — see ./github-fake.ts.)
//
// WHY it is a stateful fake and not a route table (HttpStub): the sentry source's contract is a
// LIFECYCLE, and every interesting part of it is a read-after-write. `on_merge: resolve` must be
// observable as a status change; `on_merge: comment` must be idempotent across a retried intent,
// which means the second POST has to see the first one's note; ask-human polls for a note that
// arrived AFTER the question, which means note ids and timestamps have to be monotonic; and the
// regression-reopen path only runs because the LIST payload omits the release while the DETAIL
// payload carries it. A canned-response server can't express any of that.
//
// Shapes, paths and query parameters are taken from the engine's client, not from memory — see
// ./sentry-fake.md for the endpoint table and the fidelity notes (what is real Sentry behaviour and
// what is deliberately simplified).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** One served request. `path` is the full request target INCLUDING the query string, because for the
 *  poll the query IS the contract (project / environment / query / statsPeriod / limit). */
export interface SentryFakeRequest {
  ts: number;
  method: string;
  path: string;
  body: string;
  /** The status we answered with. */
  status: number;
}

/** One note (Sentry "activity" of type `note`) on an issue. */
export interface SentryFakeNote {
  /** Numeric string, monotonically increasing — the engine falls back to comparing these when a
   *  note carries no usable timestamp, so ordering here is load-bearing. */
  id: string;
  dateCreated: string;
  text: string;
  /** `factory` = posted through the API (i.e. by the engine); `human` = injected by a scenario. */
  origin: "factory" | "human";
  author: string;
}

export interface SentrySeedIssue {
  /** The canonical key — a numeric string in real Sentry, and what the engine stores as the item key. */
  id: string;
  /** The human, project-prefixed id (e.g. "BACKEND-1AB"). Defaults to `<PROJECT>-<id>`. */
  shortId?: string;
  title: string;
  culprit?: string;
  /** error | warning | fatal | info | debug. Default "error". */
  level?: string;
  /** Total event count. Rendered as a STRING, which is how Sentry sends it. */
  count?: number;
  userCount?: number;
  /** `lastRelease.version` — served ONLY on the detail payload (see the class doc). */
  release?: string;
  /** Sentry's own regression flag (`substatus: "regressed"`), which also reopens the issue. */
  regressed?: boolean;
  /** Project slug. Defaults to the fake's project; an unknown slug is registered on the fly. */
  project?: string;
  /** unresolved | resolved | resolvedInNextRelease | ignored. Default "unresolved". */
  status?: string;
  platform?: string;
  /** Environments this issue has events in. `[]` (default) = it matches every `environment=` filter. */
  environments?: string[];
  isUnhandled?: boolean;
  /** "error" (default) or "performance" — the source maps performance to a `Performance` ticket type. */
  issueCategory?: string;
  /** Exception metadata. `type`/`value` default to the title split on its first ": "; `filename`/
   *  `function` default to the synthesized crashing frame's location. */
  metadata?: { type?: string; value?: string; filename?: string; function?: string };
  firstSeen?: string;
  /** Drives the `statsPeriod` window and the list's default (last-seen desc) sort. Defaults to the
   *  fake's construction time — the SAME instant for every seed, so the sort's insertion-order
   *  tie-break holds and the poll returns issues in SEED order. Set it to order them explicitly. */
  lastSeen?: string;
  /** The latest-event payload. Omitted = a synthesized event with an exception + stacktrace,
   *  breadcrumbs and a request (everything the materializer renders into task.md). `null` = the
   *  events/latest endpoint 404s, i.e. the "no event payload was available" branch of task.md. */
  event?: Record<string, unknown> | null;
}

interface StoredIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  level: string;
  /** As WRITTEN (so `resolvedInNextRelease` survives round-tripping); the payload normalizes it. */
  status: string;
  substatus: string | null;
  count: number;
  userCount: number;
  release: string | null;
  platform: string;
  project: string;
  environments: string[];
  isUnhandled: boolean;
  issueCategory: string;
  metadata: { type?: string; value?: string; filename?: string; function?: string };
  firstSeen: string;
  lastSeen: string;
  event: Record<string, unknown> | null | undefined;
  notes: SentryFakeNote[];
  /** Insertion order — the stable tie-break for the list's last-seen sort. */
  seq: number;
}

/** The statuses Sentry accepts on a PUT; anything else is a 400 (which is how a typo in the engine's
 *  write-back would surface, rather than being silently swallowed). */
const WRITABLE_STATUSES = new Set(["unresolved", "resolved", "resolvedInNextRelease", "ignored"]);

const NOT_FOUND = { detail: "The requested resource does not exist" };

function errorBodyFor(status: number): Record<string, unknown> {
  if (status === 401) return { detail: "Invalid token" };
  if (status === 403) return { detail: "You do not have permission to perform this action." };
  if (status === 404 || status === 410) return NOT_FOUND;
  if (status === 429) return { detail: "You are attempting to use this endpoint too frequently." };
  return { detail: `sentry-fake: injected HTTP ${status}` };
}

const PERIOD_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function periodMs(period: string): number | null {
  const m = /^(\d+)([smhdw])$/.exec(period);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = PERIOD_MS[m[2] ?? ""];
  return unit === undefined ? null : n * unit;
}

/** Split "TypeError: x is undefined" into the exception type + value Sentry's `metadata` carries. */
function splitTitle(title: string): { type: string; value: string } {
  const at = title.indexOf(": ");
  return at > 0 ? { type: title.slice(0, at), value: title.slice(at + 2) } : { type: "Error", value: title };
}

/**
 * Where the crashing frame lives, derived from the culprit — because Sentry's culprit is EITHER a
 * dotted symbol path ("widgets.handlers.create") OR a file path ("app/routes/checkout.ts"), and
 * splitting a file path on "." would name the function after its extension.
 */
function frameLocation(culprit: string | null): { filename: string; function: string } {
  if (!culprit) return { filename: "app/handlers.py", function: "handler" };
  if (culprit.includes("/")) return { filename: culprit, function: "handler" };
  return { filename: "app/handlers.py", function: culprit.split(".").pop() || "handler" };
}

/**
 * The synthesized latest event. It carries all three entry types the materializer renders —
 * `exception` (with a stacktrace whose LAST frame is the crashing one, which is the order Sentry
 * uses and the order `renderEntries` reverses), `breadcrumbs`, and `request` — so a scenario that
 * only calls `seed()` still gets a task.md with a real stacktrace in it.
 */
function defaultEvent(issue: StoredIssue): Record<string, unknown> {
  const meta = issue.metadata;
  const fn = meta.function ?? "handler";
  const file = meta.filename ?? "app/handlers.py";
  // Keep the two framing frames in the same language as the crashing one, so a JS/TS culprit doesn't
  // produce a stacktrace half-written in Python.
  const ext = /\.[a-z]+$/.exec(file)?.[0] ?? ".py";
  return {
    // Real event ids are 32 hex chars; issue ids are numeric, so padding keeps it hex-valid.
    eventID: issue.id.padStart(32, "0"),
    id: issue.id.padStart(32, "0"),
    groupID: issue.id,
    title: issue.title,
    culprit: issue.culprit,
    platform: issue.platform,
    message: "",
    dateCreated: issue.lastSeen,
    dateReceived: issue.lastSeen,
    size: 4096,
    tags: [
      { key: "environment", value: issue.environments[0] ?? "production" },
      { key: "release", value: issue.release ?? "unknown" },
      { key: "level", value: issue.level },
      { key: "server_name", value: "web-01" },
      { key: "url", value: "https://api.example.test/v1/widgets" },
    ],
    entries: [
      {
        type: "exception",
        data: {
          values: [
            {
              type: meta.type ?? "Error",
              value: meta.value ?? issue.title,
              module: null,
              mechanism: { type: "generic", handled: !issue.isUnhandled },
              stacktrace: {
                // Outermost first — the crashing frame is LAST.
                frames: [
                  { function: "main", filename: `app/main${ext}`, absPath: `/srv/app/main${ext}`, module: "app.main", lineNo: 12, colNo: null, inApp: false, context: [] },
                  { function: "dispatch", filename: `app/router${ext}`, absPath: `/srv/app/router${ext}`, module: "app.router", lineNo: 88, colNo: null, inApp: false, context: [] },
                  {
                    function: fn,
                    filename: file,
                    absPath: `/srv/${file}`,
                    module: null,
                    lineNo: 42,
                    colNo: 9,
                    inApp: true,
                    context: [
                      [41, "    payload = request.get_json()"],
                      [42, "    return payload[key].strip()"],
                      [43, "    # unreachable"],
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: "breadcrumbs",
        data: {
          values: [
            { timestamp: issue.firstSeen, type: "default", category: "auth", level: "info", message: "user signed in" },
            { timestamp: issue.lastSeen, type: "http", category: "http", level: "info", message: "POST /v1/widgets 200" },
            { timestamp: issue.lastSeen, type: "error", category: "app", level: "error", message: `unhandled ${meta.type ?? "Error"}` },
          ],
        },
      },
      { type: "request", data: { method: "POST", url: "https://api.example.test/v1/widgets", query: [["id", "42"]], headers: [["Content-Type", "application/json"]] } },
    ],
    contexts: { runtime: { name: issue.platform, version: "3.12.0", type: "runtime" } },
  };
}

/**
 * A stateful fake Sentry on 127.0.0.1. `listen()` picks a free port; `url` is what a sentry source's
 * `base_url` should be set to (the client appends `/api/0` itself).
 *
 * ```ts
 * const sentry = new SentryFake({ organization: "acme", project: "backend" });
 * sentry.seed({ id: "4823", title: "TypeError: x is undefined", culprit: "handlers.run", release: "v1.2.3" });
 * // … the belt runs, the PR merges …
 * expect(sentry.status("4823")).toBe("resolved");        // on_merge: resolve
 * expect(sentry.notes("4823")[0]).toContain("Fixed by"); // on_merge: comment
 * ```
 */
export class SentryFake {
  private server: Server | null = null;
  private port = 0;
  private readonly issues = new Map<string, StoredIssue>();
  private readonly projects = new Map<string, { id: string; name: string }>();
  private readonly log: SentryFakeRequest[] = [];
  private noteSeq = 1000;
  private lastNoteMs = 0;
  private nextProjectId = 4500001;
  private seedSeq = 0;
  /** Default firstSeen/lastSeen for every seed — one fixed instant, so the list's last-seen sort
   *  falls through to the seed-order tie-break instead of depending on millisecond timing. */
  private readonly seededAt = new Date().toISOString();
  private readonly onceFailures: { status: number; match: string | RegExp | null }[] = [];

  /** The org slug in every path the client builds — a request for another org 404s, which is how a
   *  mis-wired `sentry.organization` shows up as a failure instead of as silence. */
  readonly organization: string;
  readonly project: string;

  /** Reject a request with no `Authorization: Bearer …` with 401. On by default: the engine's auth
   *  gate is supposed to stop an uncredentialed source BEFORE the client is reached, so an
   *  unauthenticated request arriving here is itself a bug. */
  requireAuth = true;
  /** When set, only this exact bearer token is accepted (any other ⇒ 401). */
  expectToken: string | null = null;
  /** Every matching request answers this status while set — "Sentry is down / the token was
   *  revoked" phases. 401/403 surface as `SourceUnauthenticatedError`; 404/410 as a stale item.
   *  NB 429/5xx are RETRIED by the engine's http policy (3 extra attempts, exponential backoff), so
   *  they cost seconds — prefer 401/403/404 unless the retry is the thing under test. */
  failWith: number | null = null;
  /** Scope `failWith` to requests whose `<METHOD> <target>` matches (substring or regex). */
  failMatch: string | RegExp | null = null;
  /** Issue ids (or short ids) that answer `goneStatus` — a deleted or merged-away issue. */
  gone: Set<string> = new Set();
  /** 404 (default) or 410 — both are "gone" to the engine (`isSentryNotFound`). */
  goneStatus = 404;
  /** Real Sentry rejects an identical note by the same user within the hour with a 400. Off by
   *  default (it would turn a legitimately repeated attention note into a failure); turn it on to
   *  prove the ask-human / on_merge idempotency guards actually scan before they post. */
  rejectDuplicateNotes = false;

  constructor(opts?: { organization?: string; project?: string }) {
    this.organization = opts?.organization ?? "acme";
    this.project = opts?.project ?? "backend";
    this.addProject(this.project);
  }

  get url(): string {
    if (!this.port) throw new Error("SentryFake: listen() first — the URL is only known once bound");
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
      server.close(() => resolve());
    });
  }

  // --- seeding + control ------------------------------------------------------------------------

  /** Register a project slug (and mint its numeric id). Called for you by the constructor and by
   *  `seed()`; call it directly only to make an EXTRA project resolvable to `health()`. */
  addProject(slug: string, name?: string): { id: string; name: string } {
    const existing = this.projects.get(slug);
    if (existing) return existing;
    const created = { id: String(this.nextProjectId++), name: name ?? slug };
    this.projects.set(slug, created);
    return created;
  }

  seed(issue: SentrySeedIssue): void {
    const project = issue.project ?? this.project;
    this.addProject(project);
    const split = splitTitle(issue.title);
    const where = frameLocation(issue.culprit ?? null);
    this.issues.set(issue.id, {
      id: issue.id,
      shortId: issue.shortId ?? `${project.toUpperCase()}-${issue.id}`,
      title: issue.title,
      culprit: issue.culprit ?? null,
      level: issue.level ?? "error",
      status: issue.status ?? "unresolved",
      substatus: issue.regressed ? "regressed" : null,
      count: issue.count ?? 1,
      userCount: issue.userCount ?? 1,
      release: issue.release ?? null,
      platform: issue.platform ?? "python",
      project,
      environments: issue.environments ?? [],
      isUnhandled: issue.isUnhandled ?? true,
      issueCategory: issue.issueCategory ?? "error",
      metadata: {
        type: issue.metadata?.type ?? split.type,
        value: issue.metadata?.value ?? split.value,
        filename: issue.metadata?.filename ?? where.filename,
        function: issue.metadata?.function ?? where.function,
      },
      firstSeen: issue.firstSeen ?? this.seededAt,
      lastSeen: issue.lastSeen ?? this.seededAt,
      event: issue.event,
      notes: [],
      seq: this.seedSeq++,
    });
  }

  /** The issue's status exactly as the factory last WROTE it: unresolved | resolved |
   *  resolvedInNextRelease | ignored. (The served payload normalizes `resolvedInNextRelease` to
   *  `status: "resolved"` + `statusDetails.inNextRelease`, which is what Sentry does.) */
  status(id: string): string {
    return this.must(id).status;
  }

  /** Bodies of the notes the FACTORY posted, oldest first — the reply channel's write side. Notes a
   *  scenario injected with `addNote` are excluded (see `allNotes`). */
  notes(id: string): string[] {
    return this.must(id)
      .notes.filter((n) => n.origin === "factory")
      .map((n) => n.text);
  }

  /** Every note on the issue, oldest first, factory and human alike. */
  allNotes(id: string): SentryFakeNote[] {
    return [...this.must(id).notes];
  }

  /** A human note arriving on the issue — how an ask-human question gets answered. Its timestamp is
   *  guaranteed to be strictly after every earlier note's, because the engine only accepts a reply
   *  dated strictly after the question. */
  addNote(id: string, body: string, author = "Ops Human"): SentryFakeNote {
    const note: SentryFakeNote = { id: String(this.noteSeq++), dateCreated: this.nextNoteTime(), text: body, origin: "human", author };
    this.must(id).notes.push(note);
    return note;
  }

  /** Set the release the issue was last seen on. Served ONLY on the detail payload, which is what
   *  makes the source spend a bounded detail call per Sentry-flagged regression to learn it. */
  setRelease(id: string, release: string): void {
    this.must(id).release = release;
  }

  release(id: string): string | null {
    return this.must(id).release;
  }

  /** Flag the issue the way Sentry does when a "fixed" error comes back: `substatus: "regressed"`
   *  AND status back to `unresolved` (so an `is:unresolved` poll sees it again). Pair it with
   *  `setRelease` to drive the release-moved reopen. */
  markRegressed(id: string): void {
    const issue = this.must(id);
    issue.substatus = "regressed";
    issue.status = "unresolved";
  }

  /** Every request served so far, oldest first, optionally filtered by a substring of
   *  `<METHOD> <target>` (e.g. `"GET /api/0/organizations/acme/issues/?"` for the poll). */
  requests(match?: string): SentryFakeRequest[] {
    return match ? this.log.filter((r) => `${r.method} ${r.path}`.includes(match)) : [...this.log];
  }

  /** Fail the NEXT matching request with `status`, then serve normally again — for "the write failed
   *  once and the retried intent must not double-post" cases. */
  failOnce(status: number, match?: string | RegExp): void {
    this.onceFailures.push({ status, match: match ?? null });
  }

  /** Truncate the request log (and drop unconsumed one-shot failures), so a scenario can assert a
   *  per-phase call budget rather than a whole-run total. Seeded issues and notes are untouched. */
  reset(): void {
    this.log.length = 0;
    this.onceFailures.length = 0;
  }

  private must(id: string): StoredIssue {
    const issue = this.lookup(id);
    if (!issue) throw new Error(`sentry-fake: no issue "${id}" (have: ${[...this.issues.keys()].join(", ") || "none"})`);
    return issue;
  }

  /** By numeric id or short id (case-insensitively — Sentry's short ids are uppercase but its
   *  lookups are not case-sensitive). */
  private lookup(id: string): StoredIssue | undefined {
    const direct = this.issues.get(id);
    if (direct) return direct;
    const lower = id.toLowerCase();
    for (const issue of this.issues.values()) if (issue.shortId.toLowerCase() === lower) return issue;
    return undefined;
  }

  /** Monotonic ISO timestamps: two notes in the same millisecond would otherwise be indistinguishable
   *  to the reply poll, which compares `dateCreated` STRICTLY greater than the question's. */
  private nextNoteTime(): string {
    const now = Math.max(Date.now(), this.lastNoteMs + 1);
    this.lastNoteMs = now;
    return new Date(now).toISOString();
  }

  // --- serving ----------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const entry: SentryFakeRequest = {
      ts: Date.now(),
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: Buffer.concat(chunks).toString("utf8"),
      status: 0,
    };
    // Logged BEFORE any injection or auth check: "the request was made at all" is the assertion the
    // auth-gate and call-budget scenarios are built on, and it must survive every failure mode.
    this.log.push(entry);
    try {
      this.route(entry, req, res);
    } catch (e) {
      // A throw here is a bug in the fake, not in the engine — say so loudly rather than answering
      // something the client would read as a legitimate backend error.
      this.send(res, entry, 500, { detail: `sentry-fake: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private send(res: ServerResponse, entry: SentryFakeRequest, status: number, body: unknown): void {
    entry.status = status;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** Injection first (a "down" backend beats everything), then auth, then routing. */
  private route(entry: SentryFakeRequest, req: IncomingMessage, res: ServerResponse): void {
    const key = `${entry.method} ${entry.path}`;
    const matches = (m: string | RegExp | null): boolean => (m == null ? true : typeof m === "string" ? key.includes(m) : m.test(key));
    const onceAt = this.onceFailures.findIndex((f) => matches(f.match));
    if (onceAt >= 0) {
      const once = this.onceFailures.splice(onceAt, 1)[0];
      if (once) return this.send(res, entry, once.status, errorBodyFor(once.status));
    }
    if (this.failWith != null && matches(this.failMatch)) return this.send(res, entry, this.failWith, errorBodyFor(this.failWith));

    if (this.requireAuth) {
      const auth = req.headers.authorization ?? "";
      const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? "";
      if (!token) return this.send(res, entry, 401, { detail: "Authentication credentials were not provided." });
      if (this.expectToken != null && token !== this.expectToken) return this.send(res, entry, 401, { detail: "Invalid token" });
    }

    const url = new URL(entry.path, "http://sentry.fake");
    const segs = url.pathname.split("/").filter((s) => s.length > 0);
    if (segs[0] !== "api" || segs[1] !== "0") return this.send(res, entry, 404, NOT_FOUND);
    const p = segs.slice(2);

    // GET /api/0/projects/{org}/{slug}/ — health(), and the slug -> numeric id resolution the org
    // issues poll needs (cached per client, so one lookup per project per process).
    if (p[0] === "projects" && p[1] === this.organization && p.length === 3 && entry.method === "GET") {
      const slug = p[2] ?? "";
      const project = this.projects.get(slug);
      if (!project) return this.send(res, entry, 404, NOT_FOUND);
      return this.send(res, entry, 200, { id: project.id, slug, name: project.name, platform: "python", isMember: true, status: "active" });
    }

    if (p[0] !== "organizations" || p[1] !== this.organization) return this.send(res, entry, 404, NOT_FOUND);

    // GET /api/0/organizations/{org}/ — the doctor's connectivity probe.
    if (p.length === 2 && entry.method === "GET") {
      return this.send(res, entry, 200, { id: "1", slug: this.organization, name: this.organization, status: { id: "active", name: "active" } });
    }

    // GET /api/0/organizations/{org}/shortids/{shortId}/ — `describe` with a human id.
    if (p[2] === "shortids" && p.length === 4 && entry.method === "GET") {
      const issue = this.lookup(p[3] ?? "");
      if (!issue || this.goneFor(issue) != null) return this.send(res, entry, this.goneFor(issue) ?? 404, NOT_FOUND);
      return this.send(res, entry, 200, {
        organizationSlug: this.organization,
        projectSlug: issue.project,
        groupId: issue.id,
        group: this.renderIssue(issue, false),
        shortId: issue.shortId,
      });
    }

    if (p[2] !== "issues") return this.send(res, entry, 404, NOT_FOUND);

    // GET /api/0/organizations/{org}/issues/?query=…&statsPeriod=…&limit=…&project=…&environment=…
    if (p.length === 3 && entry.method === "GET") return this.listIssues(entry, res, url);

    const id = p[3];
    if (id === undefined) return this.send(res, entry, 404, NOT_FOUND);
    const issue = this.lookup(id);
    if (!issue) return this.send(res, entry, 404, NOT_FOUND);
    const goneStatus = this.goneFor(issue);
    if (goneStatus != null) return this.send(res, entry, goneStatus, NOT_FOUND);

    if (p.length === 4) {
      if (entry.method === "GET") return this.send(res, entry, 200, this.renderIssue(issue, true));
      if (entry.method === "PUT") return this.updateIssue(entry, res, issue);
      return this.send(res, entry, 405, { detail: "Method not allowed" });
    }

    // GET /api/0/organizations/{org}/issues/{id}/events/latest/ — the stacktrace source.
    if (p.length === 6 && p[4] === "events" && p[5] === "latest" && entry.method === "GET") {
      const event = issue.event === null ? null : (issue.event ?? defaultEvent(issue));
      // A brand-new issue mid-ingest genuinely 404s here; the source degrades to a task.md without
      // a stacktrace rather than failing the claim.
      if (!event) return this.send(res, entry, 404, NOT_FOUND);
      return this.send(res, entry, 200, event);
    }

    // GET|POST /api/0/organizations/{org}/issues/{id}/comments/ — the reply channel.
    if (p.length === 5 && p[4] === "comments") {
      if (entry.method === "GET") return this.send(res, entry, 200, this.renderNotes(issue));
      if (entry.method === "POST") return this.addComment(entry, res, issue);
      return this.send(res, entry, 405, { detail: "Method not allowed" });
    }

    return this.send(res, entry, 404, NOT_FOUND);
  }

  private goneFor(issue: StoredIssue | undefined): number | null {
    if (!issue) return null;
    return this.gone.has(issue.id) || this.gone.has(issue.shortId) ? this.goneStatus : null;
  }

  private listIssues(entry: SentryFakeRequest, res: ServerResponse, url: URL): void {
    const statsPeriod = url.searchParams.get("statsPeriod");
    const window = statsPeriod == null ? null : periodMs(statsPeriod);
    // The org endpoint validates the period (the project-scoped one is even stricter — 24h/14d only,
    // which is precisely why the client routes through the org endpoint).
    if (statsPeriod != null && window == null) return this.send(res, entry, 400, { detail: `Invalid statsPeriod: "${statsPeriod}"` });

    const wantProjects = url.searchParams.getAll("project");
    const allProjects = wantProjects.length === 0 || wantProjects.includes("-1");
    const wantEnvs = url.searchParams.getAll("environment");
    const query = url.searchParams.get("query") ?? "";
    const rawLimit = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100;
    const cutoff = window == null ? null : Date.now() - window;

    const out = [...this.issues.values()]
      .filter((i) => this.goneFor(i) == null)
      .filter((i) => allProjects || wantProjects.includes(this.addProject(i.project).id))
      .filter((i) => !wantEnvs.length || !i.environments.length || i.environments.some((e) => wantEnvs.includes(e)))
      .filter((i) => cutoff == null || Date.parse(i.lastSeen) >= cutoff)
      .filter((i) => this.matchesQuery(i, query))
      // Sentry's default sort is last-seen descending; the seq tie-break keeps same-instant seeds in
      // seed order, so a scenario's expected key list is deterministic.
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || a.seq - b.seq)
      .slice(0, limit)
      .map((i) => this.renderIssue(i, false));
    this.send(res, entry, 200, out);
  }

  /**
   * A deliberately small subset of Sentry's issue search: `is:` (unresolved/resolved/ignored/muted/
   * regressed), `level:`, `environment:`, `release:`, `project:`, and bare words as a
   * case-insensitive substring of title/culprit/exception value. Every OTHER `key:value` facet
   * MATCHES — modelling Sentry's search language is not this fake's job, and a silently-dropping
   * filter would be worse than an over-permissive one (a scenario would see an empty poll and blame
   * the engine). See ./sentry-fake.md.
   */
  private matchesQuery(issue: StoredIssue, query: string): boolean {
    for (const token of query.trim().split(/\s+/).filter(Boolean)) {
      const at = token.indexOf(":");
      const key = at > 0 ? token.slice(0, at).toLowerCase() : "";
      const value = (at > 0 ? token.slice(at + 1) : token).replace(/^"|"$/g, "");
      if (key === "is") {
        if (value === "regressed") {
          if (issue.substatus !== "regressed") return false;
        } else if (value === "unresolved" || value === "resolved" || value === "ignored" || value === "muted") {
          if (this.renderStatus(issue) !== (value === "muted" ? "ignored" : value)) return false;
        }
        continue;
      }
      if (key === "level" && issue.level !== value) return false;
      if (key === "release" && issue.release !== value) return false;
      if (key === "project" && issue.project !== value) return false;
      if (key === "environment" && issue.environments.length && !issue.environments.includes(value)) return false;
      if (key) continue;
      const hay = `${issue.title} ${issue.culprit ?? ""} ${issue.metadata.value ?? ""}`.toLowerCase();
      if (!hay.includes(value.toLowerCase())) return false;
    }
    return true;
  }

  private updateIssue(entry: SentryFakeRequest, res: ServerResponse, issue: StoredIssue): void {
    let body: Record<string, unknown>;
    try {
      body = (entry.body ? JSON.parse(entry.body) : {}) as Record<string, unknown>;
    } catch {
      return this.send(res, entry, 400, { detail: "Malformed JSON body" });
    }
    const next = body.status;
    if (next !== undefined) {
      if (typeof next !== "string" || !WRITABLE_STATUSES.has(next)) {
        return this.send(res, entry, 400, { status: [`"${String(next)}" is not a valid choice.`] });
      }
      issue.status = next;
      // Sentry clears the regression flag once the issue is (re)resolved — so a resolve write-back
      // can't leave an item looking permanently regressed to the next poll.
      if (next !== "unresolved") issue.substatus = null;
    }
    this.send(res, entry, 200, this.renderIssue(issue, true));
  }

  private addComment(entry: SentryFakeRequest, res: ServerResponse, issue: StoredIssue): void {
    let body: { text?: unknown };
    try {
      body = (entry.body ? JSON.parse(entry.body) : {}) as { text?: unknown };
    } catch {
      return this.send(res, entry, 400, { detail: "Malformed JSON body" });
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return this.send(res, entry, 400, { text: ["This field is required."] });
    if (this.rejectDuplicateNotes && issue.notes.some((n) => n.origin === "factory" && n.text === text)) {
      // Wording is ours; the 400 is what matters (Sentry's exact copy isn't documented).
      return this.send(res, entry, 400, { detail: "You have already posted this comment." });
    }
    const note: SentryFakeNote = { id: String(this.noteSeq++), dateCreated: this.nextNoteTime(), text, origin: "factory", author: "herdr-factory" };
    issue.notes.push(note);
    this.send(res, entry, 201, this.renderNote(note));
  }

  /** Newest-first — the endpoint's default order, which the source re-sorts for itself. */
  private renderNotes(issue: StoredIssue): unknown[] {
    return [...issue.notes].reverse().map((n) => this.renderNote(n));
  }

  private renderNote(note: SentryFakeNote): Record<string, unknown> {
    return {
      id: note.id,
      type: "note",
      dateCreated: note.dateCreated,
      data: { text: note.text },
      user: {
        id: note.origin === "factory" ? "9001" : "9002",
        name: note.author,
        username: note.author.toLowerCase().replace(/\s+/g, "."),
        email: `${note.author.toLowerCase().replace(/\s+/g, ".")}@example.test`,
      },
    };
  }

  private renderStatus(issue: StoredIssue): string {
    return issue.status === "resolvedInNextRelease" ? "resolved" : issue.status;
  }

  private renderIssue(issue: StoredIssue, detail: boolean): Record<string, unknown> {
    const project = this.addProject(issue.project);
    const body: Record<string, unknown> = {
      id: issue.id,
      shareId: null,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      permalink: `${this.url}/organizations/${this.organization}/issues/${issue.id}/`,
      logger: null,
      level: issue.level,
      status: this.renderStatus(issue),
      statusDetails: issue.status === "resolvedInNextRelease" ? { inNextRelease: true } : {},
      substatus: issue.substatus,
      isPublic: false,
      platform: issue.platform,
      project: { id: project.id, name: project.name, slug: issue.project, platform: issue.platform },
      type: issue.issueCategory === "performance" ? "transaction" : "error",
      issueCategory: issue.issueCategory,
      metadata: issue.metadata,
      numComments: issue.notes.length,
      assignedTo: null,
      isBookmarked: false,
      isSubscribed: false,
      hasSeen: false,
      isUnhandled: issue.isUnhandled,
      // Sentry sends the event count as a STRING; the source coerces it, so send it Sentry's way.
      count: String(issue.count),
      userCount: issue.userCount,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
    };
    if (detail) {
      // ONLY the detail payload carries the release. The org issues LIST endpoint omits it, and the
      // source's regression-reopen path is built on exactly that asymmetry (it spends one bounded
      // detail call per Sentry-flagged regression to learn the release). Leaking release into the
      // list payload here would silently disable that code path and the scenario covering it.
      const release = issue.release ? { version: issue.release, shortVersion: issue.release, dateCreated: issue.firstSeen } : null;
      body.firstRelease = release;
      body.lastRelease = release;
      body.activity = [];
      body.seenBy = [];
      body.participants = [];
      body.userReportCount = 0;
      body.tags = [];
    }
    return body;
  }
}

/** A SentryFake with one seeded, actively-firing error — the shape most scenarios want. */
export function sentryWithIssue(opts?: { organization?: string; project?: string; id?: string; release?: string }): SentryFake {
  const fake = new SentryFake(opts);
  fake.seed({
    id: opts?.id ?? "4823",
    title: "TypeError: cannot read property 'id' of undefined",
    culprit: "widgets.handlers.create",
    count: 137,
    userCount: 12,
    release: opts?.release ?? "v1.2.3",
  });
  return fake;
}
