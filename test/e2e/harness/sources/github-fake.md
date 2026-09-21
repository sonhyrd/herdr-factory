# The fake GitHub backend

`./github-fake.ts` is a stateful, offline stand-in for GitHub's REST API — enough of
`/repos/{owner}/{repo}/…` to drive the engine's **own** `GithubIssuesClient` + `GithubIssuesSource`
(`src/clients/github-issues.ts`, `src/clients/github-issues-source.ts`) through a whole belt.

## The seam it needs (and why it is an env key, not a config key)

jira and sentry take a configurable `base_url`, so a fake needs no engine change. `github_issues`
had none: it hardcoded `https://api.github.com`, which is why `test/e2e/README.md` listed it as the
one source that could not get source-parity treatment.

The client now resolves its API base through **`GITHUB_API_URL` in the repo's env file**
(`resolveGithubApiBase`), which is also the GitHub Enterprise Server knob. An env key rather than a
config key because that is where the source's other GitHub credential (`GITHUB_TOKEN`) already
lives, and because the base and the token travel together — the base is the host the token is sent
to.

That last point is why the resolver **validates**: only `https` is accepted, *except* on loopback.
Loopback-http is precisely the hole this fake needs and the only one it opens; a typo'd public
`http://` base would otherwise leak a PAT to whatever the name resolves to, and it now fails at
startup instead.

```ts
import { GithubFake } from "../harness/sources/github-fake.ts";

const gh = new GithubFake({ repo: "acme/app" });

scenario({
  name: "github-something",
  beforeStart: async () => {
    await gh.listen();
    gh.seed({ number: 101, title: "Tidy the widget", kind: "pull_request", labels: ["hf-review"] });
  },
  afterStop: () => gh.close(),
  // A FUNCTION, so it is evaluated after beforeStart — the port is only known once bound.
  env: () => ({ GITHUB_TOKEN: "ghp_e2e", GITHUB_API_URL: gh.url }),
  config: () => ({
    work_sources: [{ type: "github_issues", name: "gh-prs", github_issues: { repo: gh.repo, kind: "pull_requests" } }],
    belt: [{ name: "review-gh", source: "gh-prs", label: "hf-review", steps: [/* … */] }],
  }),
}, async (w) => { /* … */ });
```

## Control surface

| member | what it does |
|---|---|
| `seed({ number, title, kind, labels, body, state, author, head, base, draft })` | one item. `kind: "pull_request"` gives it the `pull_request` key — the single bit `github_issues.kind` filters on. Seeded labels are registered on the repo. |
| `labels(n)` / `state(n)` / `stateReason(n)` | current item state — `state(n) === "open"` is the "nothing closed the PR" assertion |
| `comments(n)` / `addComment(n, body, author)` | the human loop: read what the factory posted, inject an unmarked human reply |
| `requests(match?)` | every request seen, filtered by a substring of `<METHOD> <path>`; `path` includes the query string |
| `closeAttempts()` | every `PATCH` whose body sets `state: closed` — fails on an *attempt*, not only on a close that landed |
| `reset()` | truncate the request log (per-phase call budgets); items are untouched |
| `repoLabels` | labels that exist on the repo — `health` refuses a belt whose trigger label is absent, and the source creates a missing state label on demand |
| `hasIssues` / `push` | what `GET /repos/{repo}` reports — the two `health` refusals |
| `requireAuth` (default `true`) | 401 anything without a `Bearer` header |
| `failWith` | force a status on every call (401/403 rejected, 429/5xx down) |
| `gone` + `goneStatus` | numbers that answer 301/410/404 — the three `classifyGone` maps to `stale` |

## What it serves

Every route is taken from `src/clients/github-issues.ts`, not from the public docs:

| route | used by |
|---|---|
| `GET /repos/{owner}/{repo}` | `health` (`has_issues`, `permissions.push`) |
| `GET /repos/{owner}/{repo}/labels/{name}` · `POST …/labels` | `ensureLabel` (lazy create, 422 = already exists) |
| `GET /repos/{owner}/{repo}/issues?labels=&state=open&sort=created&direction=asc&per_page=&page=` | the pickup poll |
| `GET /repos/{owner}/{repo}/issues/{n}` | `describe`, every transition's stale probe, `materialize` |
| `PATCH /repos/{owner}/{repo}/issues/{n}` | `closeIssue` — **issues only**; a PR must never reach it |
| `GET` · `POST /repos/{owner}/{repo}/issues/{n}/comments` | notes, ask-human, the claim ledger |
| `POST /repos/{owner}/{repo}/issues/{n}/labels` · `DELETE …/labels/{name}` | the state-label swap and the trigger consumption |
| `GET /repos/{owner}/{repo}/pulls/{n}` | the head/base refs a `kind: pull_requests` work doc carries |

Anything else answers **404 naming the route** — a bland `{}` would let a new engine call pass as an
empty-but-successful answer.

### Deliberate details

- **The issues list interleaves pull requests**, exactly like the real endpoint, and only the
  `pull_request` key tells them apart. That quirk *is* what `kind` filters on, so the fake would be
  useless without it.
- **`GET /pulls/{n}` 404s for an issue number** — real behaviour, and what `materialize`'s
  best-effort branch depends on (a failed read costs the head/base bullets, never the work doc).
- **Label matching is case-insensitive, storage keeps the repo's casing** — GitHub's namespace
  behaviour, and the only way the source's case-folded guards are actually exercised.
- **A label `DELETE` that finds nothing answers 404**, which the source reads as the benign
  idempotent "it wasn't there".
- **`x-ratelimit-remaining` on every response** — the client records it per response and reads it
  when classifying a 403/429; a fake without it would silently change that classification.
- **Comment timestamps are strictly increasing.** The reply poll selects comments created strictly
  after the question; two in the same millisecond would make that path flaky in a way real GitHub
  (seconds apart) never is.
- **`body_html` is served on every read**, not only on `full+json` requests. The client asks for it
  on the materialize path only, and serving it always is harmless.
- **No `since`-on-`updated_at` divergence.** The fake never edits a comment, so `created_at` and
  `updated_at` are the same instant; the source's own created-after guard is exercised identically.

## Assertion style: prefer the request log for anything transient

A state label is transient — the next swap removes it, and a short belt can pass through
`herdr:in-development` in under a second. Asserting on `labels(n)` for a mid-flight state is a race.
Assert **"was it ever applied"** on `requests()` instead, and keep `labels(n)` for terminal facts:

```ts
// racy on a fast belt
await w.waitFor(() => gh.labels(101).includes("herdr:in-review"));
// durable
await w.waitFor(() => gh.requests(`POST /repos/${gh.repo}/issues/101/labels`).some((r) => r.body.includes("herdr:in-review")));
```

One trap worth naming: the client **percent-encodes** a label name into the `DELETE` path
(`herdr%3Ain-development`), so compare `decodeURIComponent(r.path)` — a literal with the colon in it
silently never matches and the assertion just times out.

## Known engine gaps this fake exposes

- **A `review` belt with no `pr` step never reaches `in_review` on its own.** `in_review` is the
  `produce(pull_request)` effect, so a review-only belt has to ask for it:
  `effects: [{ on: "enter", step: "review", to: "in_review" }]`. Found here; the published
  `review-gh` examples now carry it.
