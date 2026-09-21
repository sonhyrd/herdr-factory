// A fake GitHub REST backend: enough of `/repos/{owner}/{repo}/…` to drive the engine's OWN
// `GithubIssuesClient` + `GithubIssuesSource` (src/clients/github-issues.ts,
// src/clients/github-issues-source.ts) through a whole belt.
//
// WHY this can exist NOW and could not before: the github_issues source used to hardcode
// `https://api.github.com`, which is why `test/e2e/README.md` listed it as the one source parity
// could not reach. It now resolves its API base through `GITHUB_API_URL` in the repo's env file
// (`resolveGithubApiBase`), so `env: { GITHUB_API_URL: gh.url }` swaps the whole backend — the same
// shape as jira's / sentry's `base_url`, just spelled as an env key because GitHub has no per-repo
// config URL. The validator deliberately allows plaintext on LOOPBACK ONLY, which is what lets this
// fake exist without opening a credential-leaking hole for anyone else.
//
// WHY it holds state instead of canned answers (HttpStub's job): the github_issues contract is a
// LIFECYCLE projected onto labels, and every interesting part of it is a read-after-write. A claim
// must really consume the trigger label so the item drops out of the next poll (INV-1); the state
// labels must really swap; and — the whole point of `kind: pull_requests` — a terminal transition
// on a PULL REQUEST must not close it, which is only observable if the fake actually holds an
// open/closed state and records the PATCHes it never received. A route table can express none of it.
//
// Every path, query parameter, request body and response shape below is taken from
// src/clients/github-issues.ts, not from the public GitHub docs — the fake's job is to answer what
// THIS client asks, and to be loudly wrong (a 404 naming the route) when it asks something new, so
// an engine change shows up here instead of silently degrading. See ./github-fake.md.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** One served request. `path` is the full request target INCLUDING the query string: for the poll
 *  the query IS the contract (`labels=` + `state=open` + `sort`/`direction` + paging), and for the
 *  close assertion the BODY is (`{"state":"closed"}`). */
export interface GithubFakeRequest {
  ts: number;
  method: string;
  path: string;
  body: string;
  status: number;
}

export interface GithubFakeComment {
  id: string;
  body: string;
  author: string;
  created: string;
}

/** What a scenario seeds. `kind` decides whether the item carries a `pull_request` key — which is
 *  the single bit the source's `kind` filter reads. */
export interface GithubFakeSeed {
  number: number;
  title: string;
  kind?: "issue" | "pull_request";
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
  author?: string;
  /** pull_request only: the head/base refs GET /pulls/{n} answers with. */
  head?: string;
  base?: string;
  draft?: boolean;
}

interface StoredComment {
  id: number;
  body: string;
  author: string;
  created: string;
}

interface StoredItem {
  number: number;
  title: string;
  isPull: boolean;
  body: string;
  labels: string[];
  state: "open" | "closed";
  stateReason: string | null;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  seq: number;
  comments: StoredComment[];
}

const NOT_FOUND = { message: "Not Found", documentation_url: "https://docs.github.com/rest" };

/**
 * A stateful GitHub stand-in on 127.0.0.1. `listen()` binds a free port; `url` is what
 * `GITHUB_API_URL` in the repo's env file should be set to.
 *
 * ```ts
 * const gh = new GithubFake({ repo: "acme/app" });
 * await gh.listen();
 * gh.seed({ number: 101, title: "Grok: tidy the widget", kind: "pull_request", labels: ["hf-review"] });
 * // … the belt claims it …
 * expect(gh.labels(101)).toContain("herdr:in-development");
 * expect(gh.state(101)).toBe("open");           // a PR run never closes it
 * ```
 */
export class GithubFake {
  private server: Server | null = null;
  private port = 0;
  private readonly items = new Map<number, StoredItem>();
  private readonly log: GithubFakeRequest[] = [];
  private nextCommentId = 10000;
  private nextSeq = 0;

  /** `owner/name` this fake serves. Any other repo path answers 404, so a mistyped
   *  `github_issues.repo` fails loudly instead of quietly finding nothing. */
  readonly repo: string;
  /** Labels that exist on the repo. The source creates a missing state label on demand
   *  (`POST /labels`), and `health` refuses a belt whose trigger label is absent — so what is (and
   *  is not) in here is part of the contract under test. */
  readonly repoLabels: Set<string>;
  /** `false` ⇒ `GET /repos/{repo}` reports `has_issues: false`: a `kind: issues` source must refuse
   *  the repo at health, a `kind: pull_requests` source must not care. */
  hasIssues = true;
  /** `false` ⇒ the token has no write access; health must refuse. */
  push = true;
  /** 401 every call that arrives without a `Bearer` Authorization header. On by default — a fake
   *  that answered anonymous calls would hide a regression that dropped the header. */
  requireAuth = true;
  /** Force this status on EVERY call (401/403 = credentials rejected, 429/5xx = backend down).
   *  Checked before auth and before routing. */
  failWith: number | null = null;
  /** Numbers that no longer exist: excluded from the list and answered `goneStatus` per item
   *  (301 transferred / 410 deleted / 404 no access — the three `classifyGone` maps to `stale`). */
  readonly gone = new Set<number>();
  goneStatus = 404;

  constructor(opts: { repo?: string; labels?: string[] } = {}) {
    this.repo = opts.repo ?? "acme/app";
    this.repoLabels = new Set(opts.labels ?? []);
  }

  get url(): string {
    if (!this.port) throw new Error("GithubFake: listen() first — the URL is only known once bound");
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

  seed(seed: GithubFakeSeed): void {
    if (this.items.has(seed.number)) throw new Error(`GithubFake: #${seed.number} is already seeded`);
    const isPull = seed.kind === "pull_request";
    for (const l of seed.labels ?? []) this.repoLabels.add(l); // a seeded label exists on the repo
    this.items.set(seed.number, {
      number: seed.number,
      title: seed.title,
      isPull,
      body: seed.body ?? `Body of #${seed.number}`,
      labels: [...(seed.labels ?? [])],
      state: seed.state ?? "open",
      stateReason: null,
      author: seed.author ?? "reporter",
      head: seed.head ?? (isPull ? `contrib/pr-${seed.number}` : ""),
      base: seed.base ?? "main",
      draft: seed.draft ?? false,
      seq: this.nextSeq++,
      comments: [],
    });
  }

  /** The item's CURRENT labels (repo casing, insertion order). */
  labels(n: number): string[] {
    return [...this.must(n).labels];
  }

  /** `open` | `closed` — the assertion that a PR run never closes its item. */
  state(n: number): "open" | "closed" {
    return this.must(n).state;
  }

  stateReason(n: number): string | null {
    return this.must(n).stateReason;
  }

  comments(n: number): GithubFakeComment[] {
    return this.must(n).comments.map((c) => ({ id: String(c.id), body: c.body, author: c.author, created: c.created }));
  }

  /** A HUMAN comment arriving on the item (unmarked — what `pollHumanReply` must pick up). */
  addComment(n: number, body: string, author = "pat-human"): string {
    return String(this.append(this.must(n), body, author).id);
  }

  /** Requests seen so far, optionally filtered by a substring of `<METHOD> <path>` (e.g.
   *  `"PATCH "`, `"/issues?"`, `"DELETE /repos/acme/app/issues/101/labels/"`). */
  requests(match?: string): GithubFakeRequest[] {
    return match ? this.log.filter((r) => `${r.method} ${r.path}`.includes(match)) : [...this.log];
  }

  /** Every request that tried to CLOSE something — the strong form of "nothing closed the PR",
   *  because it fails on an attempt the fake rejected as well as on one it honoured. */
  closeAttempts(): GithubFakeRequest[] {
    return this.log.filter((r) => r.method === "PATCH" && /"state"\s*:\s*"closed"/.test(r.body));
  }

  /** Truncate the request log (per-phase call budgets); items and comments are untouched. */
  reset(): void {
    this.log.length = 0;
  }

  private must(n: number): StoredItem {
    const item = this.items.get(n);
    if (!item) throw new Error(`GithubFake: #${n} was never seeded`);
    return item;
  }

  private append(item: StoredItem, body: string, author: string): StoredComment {
    const id = ++this.nextCommentId;
    // Strictly increasing timestamps: the reply poll selects comments created STRICTLY AFTER the
    // question, and two in the same millisecond would make that path flaky in a way real GitHub
    // (seconds apart) never is.
    const c: StoredComment = { id, body, author, created: new Date(Date.now() + id - 10000).toISOString() };
    item.comments.push(c);
    return c;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const entry: GithubFakeRequest = {
      ts: Date.now(),
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: Buffer.concat(chunks).toString("utf8"),
      status: 0,
    };
    this.log.push(entry);
    try {
      this.route(entry, req, res);
    } catch (e) {
      this.send(res, entry, 500, { message: `GithubFake threw: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private send(res: ServerResponse, entry: GithubFakeRequest, status: number, body: unknown): void {
    entry.status = status;
    res.writeHead(status, {
      "content-type": "application/json",
      // The client records this on every response (recordRateLimitRemaining) and reads it when
      // classifying a 403/429 — a fake without it would silently change that classification.
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-resource": "core",
    });
    res.end(JSON.stringify(body));
  }

  /** Injection first (a "down" backend beats everything), then auth, then routing. */
  private route(entry: GithubFakeRequest, req: IncomingMessage, res: ServerResponse): void {
    if (this.failWith != null) return this.send(res, entry, this.failWith, { message: `GithubFake.failWith=${this.failWith} (injected)` });
    if (this.requireAuth && !/^Bearer\s+\S/i.test(req.headers.authorization ?? "")) {
      return this.send(res, entry, 401, { message: "Requires authentication" });
    }

    const url = new URL(entry.path, "http://github.fake");
    const prefix = `/repos/${this.repo}`;
    if (!url.pathname.startsWith(`${prefix}`)) {
      return this.send(res, entry, 404, NOT_FOUND); // another repo — a mistyped `github_issues.repo`
    }
    const rest = url.pathname.slice(prefix.length);
    const m = entry.method;

    // GET /repos/{owner}/{repo} — health()'s probe.
    if (rest === "" && m === "GET") {
      return this.send(res, entry, 200, { full_name: this.repo, has_issues: this.hasIssues, permissions: { push: this.push, pull: true } });
    }

    // GET /repos/{owner}/{repo}/labels/{name}  ·  POST /repos/{owner}/{repo}/labels
    const label = /^\/labels\/(.+)$/.exec(rest);
    if (label && m === "GET") {
      const name = decodeURIComponent(label[1] ?? "");
      return this.repoLabels.has(name) ? this.send(res, entry, 200, { name }) : this.send(res, entry, 404, NOT_FOUND);
    }
    if (rest === "/labels" && m === "POST") {
      const name = String((this.parse(entry.body) as { name?: string }).name ?? "");
      if (this.repoLabels.has(name)) return this.send(res, entry, 422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
      this.repoLabels.add(name);
      return this.send(res, entry, 201, { name });
    }

    // GET /repos/{owner}/{repo}/issues?labels=…&state=open&sort=created&direction=asc&per_page&page
    if (rest === "/issues" && m === "GET") return this.listIssues(entry, res, url);

    // GET /repos/{owner}/{repo}/pulls/{n} — the head/base refs a PR work doc carries. Deliberately
    // NOT served for an issue number: that is the real API's answer too, and `materialize`'s
    // best-effort branch depends on it.
    const pull = /^\/pulls\/(\d+)$/.exec(rest);
    if (pull && m === "GET") {
      const item = this.items.get(Number(pull[1]));
      if (!item || !item.isPull) return this.send(res, entry, 404, NOT_FOUND);
      return this.send(res, entry, 200, {
        number: item.number,
        state: item.state,
        draft: item.draft,
        head: { ref: item.head, repo: { full_name: this.repo } },
        base: { ref: item.base },
      });
    }

    // /repos/{owner}/{repo}/issues/{n}[/comments|/labels[/{name}]] — a PR is served here too
    // (that is exactly the GitHub behaviour `kind: pull_requests` rides on).
    const issue = /^\/issues\/(\d+)(?:\/(comments|labels)(?:\/(.+))?)?$/.exec(rest);
    if (!issue) {
      // Loud by design: a path this fake doesn't serve means the engine started calling something
      // new, and a bland `{}` would let that pass as an empty-but-successful answer.
      return this.send(res, entry, 404, { message: `GithubFake serves no route for ${m} ${url.pathname} — add it (and check src/clients/github-issues.ts).` });
    }
    const n = Number(issue[1]);
    if (this.gone.has(n)) return this.send(res, entry, this.goneStatus, NOT_FOUND);
    const item = this.items.get(n);
    if (!item) return this.send(res, entry, 404, NOT_FOUND);
    const sub = issue[2];

    if (!sub && m === "GET") return this.send(res, entry, 200, this.itemJson(item, true));
    if (!sub && m === "PATCH") {
      const b = this.parse(entry.body) as { state?: "open" | "closed"; state_reason?: string };
      if (b.state) item.state = b.state;
      if (b.state_reason) item.stateReason = b.state_reason;
      return this.send(res, entry, 200, this.itemJson(item, false));
    }
    if (sub === "comments" && m === "GET") {
      const since = url.searchParams.get("since");
      // Real GitHub filters `since` on the comment's UPDATED_at; this fake never edits, so
      // created_at is the same instant — the source's own created_at guard is what the scenarios
      // lean on, and it is exercised identically.
      const list = item.comments.filter((c) => !since || Date.parse(c.created) >= Date.parse(since));
      return this.send(res, entry, 200, list.map((c) => this.commentJson(c)));
    }
    if (sub === "comments" && m === "POST") {
      const body = String((this.parse(entry.body) as { body?: string }).body ?? "");
      return this.send(res, entry, 201, this.commentJson(this.append(item, body, "herdr-bot")));
    }
    if (sub === "labels" && m === "POST") {
      const add = (this.parse(entry.body) as { labels?: string[] }).labels ?? [];
      // GitHub's label namespace is case-insensitive and the API answers the repo's CANONICAL
      // casing — mirror that, or the source's case-folded guards are never actually tested.
      for (const l of add) if (!item.labels.some((x) => x.toLowerCase() === l.toLowerCase())) item.labels.push(l);
      return this.send(res, entry, 200, item.labels.map((name) => ({ name })));
    }
    if (sub === "labels" && m === "DELETE") {
      const name = decodeURIComponent(issue[3] ?? "");
      const at = item.labels.findIndex((l) => l.toLowerCase() === name.toLowerCase());
      if (at < 0) return this.send(res, entry, 404, { message: "Label does not exist" }); // benign + idempotent
      item.labels.splice(at, 1);
      return this.send(res, entry, 200, item.labels.map((l) => ({ name: l })));
    }
    return this.send(res, entry, 404, { message: `GithubFake serves no route for ${m} ${url.pathname} — add it (and check src/clients/github-issues.ts).` });
  }

  /** The pickup poll. Mirrors the real endpoint's defining quirk: it INTERLEAVES issues and pull
   *  requests, and only the `pull_request` key tells them apart — which is the whole thing
   *  `kind` filters on. */
  private listIssues(entry: GithubFakeRequest, res: ServerResponse, url: URL): void {
    const label = url.searchParams.get("labels");
    const state = url.searchParams.get("state") ?? "open";
    const perPage = Number(url.searchParams.get("per_page") ?? "30") || 30;
    const page = Number(url.searchParams.get("page") ?? "1") || 1;
    const desc = url.searchParams.get("direction") === "desc";
    const matched = [...this.items.values()]
      .filter((i) => !this.gone.has(i.number))
      .filter((i) => state === "all" || i.state === state)
      .filter((i) => (label ? i.labels.some((l) => l.toLowerCase() === label.toLowerCase()) : true))
      .sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
    const slice = matched.slice((page - 1) * perPage, page * perPage);
    this.send(res, entry, 200, slice.map((i) => this.itemJson(i, true)));
  }

  private itemJson(item: StoredItem, withHtml: boolean): Record<string, unknown> {
    return {
      number: item.number,
      title: item.title,
      state: item.state,
      state_reason: item.stateReason,
      labels: item.labels.map((name) => ({ name })),
      body: item.body,
      // full+json's HTML rendering — the form that carries signed attachment URLs on a private
      // repo, and the one `materialize` prefers. Requested unconditionally here: the client asks
      // for it on the materialize path only, and serving it always is harmless.
      ...(withHtml ? { body_html: `<p>${item.body}</p>` } : {}),
      user: { login: item.author },
      assignees: [],
      html_url: `https://github.com/${this.repo}/${item.isPull ? "pull" : "issues"}/${item.number}`,
      // The ONE bit that distinguishes a PR from an issue on this endpoint.
      ...(item.isPull ? { pull_request: { url: `${this.url}/repos/${this.repo}/pulls/${item.number}`, html_url: `https://github.com/${this.repo}/pull/${item.number}` } } : {}),
    };
  }

  private commentJson(c: StoredComment): Record<string, unknown> {
    return {
      id: c.id,
      body: c.body,
      body_html: `<p>${c.body}</p>`,
      created_at: c.created,
      updated_at: c.created,
      user: { login: c.author },
      html_url: `https://github.com/${this.repo}/issues/comments/${c.id}`,
    };
  }

  private parse(body: string): unknown {
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      return {};
    }
  }
}
