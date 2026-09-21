// An in-memory GitHub REST backend behind a fetch stub — the github_issues counterpart of the
// jira fetch-stub harness. Shared by test/github-issues-source.test.ts and the contract suite.
import { GithubIssuesClient } from "../../src/clients/github-issues.ts";
import { GithubIssuesSource, type GithubIssuesSourceCfg } from "../../src/clients/github-issues-source.ts";
import { TokenBucket } from "../../src/clients/http.ts";
import type { WorkState } from "../../src/types.ts";

/** The pickup (trigger) label a github_issues belt would carry — it's a per-belt arg now, not
 *  source config. The helper binds it as the default for listEligible/transition/health so existing
 *  call sites read as before while still exercising the label threading. */
export const TRIGGER_LABEL = "herdr";

/** Wrap a source so the three label-taking methods default to `trigger` when a test omits it —
 *  mirroring how a belt threads its `label` into the real reconcile/doctor paths. */
function bindTrigger(src: GithubIssuesSource, trigger: string): GithubIssuesSource {
  return new Proxy(src, {
    get(target, prop, receiver) {
      if (prop === "listEligible") return (label?: string) => target.listEligible(label ?? trigger);
      if (prop === "transition") return (key: string, to: WorkState, label?: string, ctx?: unknown, statusOverride?: string) => target.transition(key, to, label ?? trigger, ctx as never, statusOverride);
      if (prop === "health") return (labels?: string[]) => target.health(labels ?? [trigger]);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export interface FakeIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason: string | null;
  labels: Set<string>;
  body: string;
  body_html?: string; // defaults to <p>{body}</p>
  user: { login: string };
  assignees: { login: string }[];
  pull_request?: object; // present ⇒ the "issue" is a PR
  /** PR-only: what GET /pulls/{n} answers (the refs the issues endpoints never carry). */
  pull?: { head: { ref: string; repo: { full_name: string } }; base: { ref: string }; draft: boolean };
  type?: { name: string } | null; // native issue type
  comments: { id: number; created_at: string; updated_at: string; body: string; user: { login: string } }[];
}

export interface FakeGithub {
  issues: Map<number, FakeIssue>;
  repoLabels: Set<string>;
  /** number → status the API answers for it (301 transferred / 410 deleted / 404 no access). */
  gone: Map<number, number>;
  calls: { method: string; path: string }[];
  /** EVERY url the stub saw, including non-API hosts (media downloads) — the SSRF assertion. */
  fetchedUrls: string[];
  mutations: () => number;
  hasIssues: boolean;
  push: boolean;
  commentSeq: { n: number };
  /** Shifted one per API request when non-empty: answer with this status instead (rate-limit /
   *  auth failure injection). retryAfter → Retry-After header; remaining/reset → x-ratelimit-*. */
  failNext: { status: number; retryAfter?: number; remaining?: string; reset?: number }[];
  /** Labels whose next GET /labels/{name} lies "404" once — the ensureLabel create race. */
  denyLabelGetOnce: Set<string>;
  /** Full media URL → served bytes (anything not here 404s; non-https hosts too). */
  assets: Map<string, Buffer>;
  addIssue(n: number, opts?: Partial<Omit<FakeIssue, "number" | "labels" | "comments">> & { labels?: string[] }): FakeIssue;
  /** A PULL REQUEST #n: an issue carrying `pull_request` plus a GET /pulls/{n} view. */
  addPull(n: number, opts?: Partial<Omit<FakeIssue, "number" | "labels" | "comments">> & { labels?: string[]; head?: string; base?: string }): FakeIssue;
  addComment(n: number, body: string, login?: string): number;
  /** Edit an existing comment: body changes, updated_at bumps, created_at stays. */
  editComment(n: number, id: number, body: string): void;
  restore(): void;
}

export const DEFAULT_CFG: GithubIssuesSourceCfg = {
  repo: "acme/tracker",
  stateLabels: { inDevelopment: "herdr:in-development", inReview: "herdr:in-review", aborted: "herdr:aborted" },
  stateLabelsExtra: {},
  closeOn: { merged: true, done: true, aborted: false },
  kind: "issues",
  typeLabels: { bug: "Bug", defect: "Bug", chore: "Chore", task: "Chore", enhancement: "Feature" },
  defaultType: "Feature",
  maxPages: 1,
};

const MUTATING = new Set(["POST", "PATCH", "DELETE", "PUT"]);

/** Install the fetch stub and return the model + hooks. Call `restore()` (or afterEach) to undo. */
export function makeFakeGithub(repo = "acme/tracker"): FakeGithub {
  const realFetch = globalThis.fetch;
  const fake: FakeGithub = {
    issues: new Map(),
    repoLabels: new Set(["herdr", "bug", "enhancement"]),
    gone: new Map(),
    calls: [],
    fetchedUrls: [],
    mutations: () => fake.calls.filter((c) => MUTATING.has(c.method)).length,
    hasIssues: true,
    push: true,
    commentSeq: { n: 0 },
    failNext: [],
    denyLabelGetOnce: new Set(),
    assets: new Map(),
    addIssue(n, opts = {}) {
      const issue: FakeIssue = {
        number: n,
        title: opts.title ?? `Issue ${n}`,
        state: opts.state ?? "open",
        state_reason: opts.state_reason ?? null,
        labels: new Set(opts.labels ?? ["herdr"]),
        body: opts.body ?? `Body of issue ${n}`,
        body_html: opts.body_html,
        user: opts.user ?? { login: "reporter" },
        assignees: opts.assignees ?? [],
        pull_request: opts.pull_request,
        pull: opts.pull,
        type: opts.type ?? null,
        comments: [],
      };
      fake.issues.set(n, issue);
      return issue;
    },
    addPull(n, opts = {}) {
      const issue = fake.addIssue(n, { ...opts, pull_request: opts.pull_request ?? { url: `https://api.github.com/repos/${repo}/pulls/${n}` } });
      issue.pull = { head: { ref: opts.head ?? `pr-${n}`, repo: { full_name: repo } }, base: { ref: opts.base ?? "main" }, draft: false };
      return issue;
    },
    addComment(n, body, login = "human") {
      const issue = fake.issues.get(n)!;
      const id = ++fake.commentSeq.n;
      const at = new Date(2026, 5, 28, 0, id).toISOString();
      issue.comments.push({ id, created_at: at, updated_at: at, body, user: { login } });
      return id;
    },
    editComment(n, id, body) {
      const c = fake.issues.get(n)!.comments.find((x) => x.id === id)!;
      c.body = body;
      c.updated_at = new Date(2026, 5, 28, 0, ++fake.commentSeq.n).toISOString(); // later than any created_at so far
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    ({
      ok: status < 300,
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ "x-ratelimit-remaining": "4999", ...headers }),
    }) as Response;

  const issueJson = (i: FakeIssue) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    state_reason: i.state_reason,
    labels: [...i.labels].map((name) => ({ name })),
    body: i.body,
    body_html: i.body_html ?? `<p>${i.body}</p>`,
    user: i.user,
    assignees: i.assignees,
    html_url: `https://github.com/${repo}/${i.pull_request ? "pull" : "issues"}/${i.number}`,
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
    ...(i.type ? { type: i.type } : {}),
  });

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    fake.fetchedUrls.push(String(url));
    // Media routes: anything not under api.github.com is a byte download (or a 404).
    if (u.host !== "api.github.com") {
      const bytes = fake.assets.get(String(url));
      if (!bytes) return json({ message: "no such asset" }, 404);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        headers: new Headers(),
      } as Response;
    }
    fake.calls.push({ method, path: u.pathname });
    const injected = fake.failNext.shift();
    if (injected) {
      return json({ message: `injected ${injected.status}` }, injected.status, {
        ...(injected.retryAfter != null ? { "retry-after": String(injected.retryAfter) } : {}),
        ...(injected.remaining != null ? { "x-ratelimit-remaining": injected.remaining } : {}),
        ...(injected.reset != null ? { "x-ratelimit-reset": String(injected.reset) } : {}),
      });
    }
    const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // GET /repos/o/r
    if (method === "GET" && u.pathname === `/repos/${repo}`) {
      return json({ has_issues: fake.hasIssues, permissions: { push: fake.push } });
    }
    // repo labels
    const labelM = u.pathname.match(new RegExp(`^/repos/${esc}/labels/(.+)$`));
    if (labelM) {
      const name = decodeURIComponent(labelM[1]!);
      if (method === "GET") {
        if (fake.denyLabelGetOnce.delete(name)) return json({ message: "Not Found" }, 404); // the create-race lie
        return fake.repoLabels.has(name) ? json({ name }) : json({ message: "Not Found" }, 404);
      }
    }
    if (method === "POST" && u.pathname === `/repos/${repo}/labels`) {
      const body = JSON.parse(String(init?.body)) as { name: string };
      if (fake.repoLabels.has(body.name)) return json({ message: "already_exists" }, 422);
      fake.repoLabels.add(body.name);
      return json({ name: body.name }, 201);
    }
    // list issues
    if (method === "GET" && u.pathname === `/repos/${repo}/issues`) {
      const label = u.searchParams.get("labels");
      const page = Number(u.searchParams.get("page") ?? "1");
      const list = [...fake.issues.values()]
        .filter((i) => i.state === "open" && (!label || i.labels.has(label)))
        .sort((a, b) => a.number - b.number);
      const per = Number(u.searchParams.get("per_page") ?? "30");
      return json(list.slice((page - 1) * per, page * per).map(issueJson));
    }
    // GET /repos/o/r/pulls/{n} — the PR view (branch refs only live here)
    const pullM = u.pathname.match(new RegExp(`^/repos/${esc}/pulls/(\\d+)$`));
    if (pullM && method === "GET") {
      const pn = Number(pullM[1]);
      const pi = fake.issues.get(pn);
      if (!pi?.pull) return json({ message: "Not Found" }, 404);
      return json(pi.pull);
    }
    // per-issue routes
    const m = u.pathname.match(new RegExp(`^/repos/${esc}/issues/(\\d+)(/(comments|labels)(/(.+))?)?$`));
    if (!m) return json({ message: `no fake route: ${method} ${u.pathname}` }, 500);
    const n = Number(m[1]);
    if (fake.gone.has(n)) return json({ message: "gone" }, fake.gone.get(n)!);
    const issue = fake.issues.get(n);
    if (!issue) return json({ message: "Not Found" }, 404);

    if (m[3] === "comments") {
      if (method === "POST") {
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        const id = ++fake.commentSeq.n;
        const created_at = new Date(2026, 5, 28, 0, id).toISOString();
        issue.comments.push({ id, created_at, updated_at: created_at, body, user: { login: "operator" } });
        return json({ id, created_at, body, user: { login: "operator" } }, 201);
      }
      const since = u.searchParams.get("since");
      // Real GitHub filters `since` on UPDATED_at — an old comment edited later re-enters the
      // window (the edited-old-comment trap the source's created_at guard must catch).
      const list = issue.comments
        .filter((c) => !since || Date.parse(c.updated_at) >= Date.parse(since))
        .map((c) => ({ ...c, body_html: `<p>${c.body}</p>` }));
      return json(list);
    }
    if (m[3] === "labels") {
      if (method === "POST") {
        const labels = (JSON.parse(String(init?.body)) as { labels: string[] }).labels;
        for (const l of labels) issue.labels.add(l);
        return json([...issue.labels].map((name) => ({ name })));
      }
      if (method === "DELETE") {
        const name = decodeURIComponent(m[5]!);
        if (!issue.labels.has(name)) return json({ message: "Label does not exist" }, 404);
        issue.labels.delete(name);
        return json([...issue.labels].map((l) => ({ name: l })));
      }
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { state?: "open" | "closed"; state_reason?: string };
      if (body.state) issue.state = body.state;
      if (body.state_reason) issue.state_reason = body.state_reason;
      return json(issueJson(issue));
    }
    if (method === "GET") return json(issueJson(issue));
    return json({ message: `no fake route: ${method} ${u.pathname}` }, 500);
  }) as typeof fetch;

  return fake;
}

/** A wired source over the fake backend: generous test buckets (no throttling sleeps), stubbed
 *  token, PR repo = issues repo unless overridden. */
export function makeSource(fake: FakeGithub, cfg: Partial<GithubIssuesSourceCfg> = {}, prRepo?: string, brand?: string) {
  return makeWired(fake, cfg, prRepo, { brand }).src;
}

/** As makeSource, but exposing the client + auth/budget seams for the rate-limit/auth tests. */
export function makeWired(
  _fake: FakeGithub,
  cfg: Partial<GithubIssuesSourceCfg> = {},
  prRepo?: string,
  opts: { envToken?: string; buckets?: { read: TokenBucket[]; mutation: TokenBucket[] }; triggerLabel?: string; brand?: string } = {},
) {
  const merged = { ...DEFAULT_CFG, ...cfg };
  const tokenCalls = { n: 0 };
  const budget = opts.buckets ?? { read: [new TokenBucket(10_000, 10_000)], mutation: [new TokenBucket(10_000, 10_000)] };
  const client = new GithubIssuesClient(
    merged.repo,
    opts.envToken,
    async () => {
      tokenCalls.n += 1;
      return `test-token-${tokenCalls.n}`;
    },
    budget,
  );
  const raw = new GithubIssuesSource(merged, client, prRepo ?? merged.repo, undefined, opts.brand);
  return { src: bindTrigger(raw, opts.triggerLabel ?? TRIGGER_LABEL), client, tokenCalls };
}
