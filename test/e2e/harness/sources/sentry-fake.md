# The fake Sentry backend

`./sentry-fake.ts` is a stateful, offline stand-in for Sentry's REST API — enough of `/api/0/…` to
drive the engine's **own** `SentryClient` + `SentrySource` (`src/clients/sentry.ts`,
`src/clients/sentry-source.ts`) through a whole belt.

There is no client override in the engine and none is needed: the sentry source takes a configurable
`base_url`, so `sentry: { base_url: fake.url }` swaps the entire backend. (Same seam as jira;
`github_issues` needed one and now has `GITHUB_API_URL` — see ./github-fake.md — and
`local_markdown` has no backend at all.)

```ts
import { SentryFake } from "../harness/sources/sentry-fake.ts";

const sentry = new SentryFake({ organization: "acme", project: "backend" });

scenario({
  name: "sentry-happy",
  beforeStart: () => sentry.listen(),
  afterStop: () => sentry.close(),
  env: { SENTRY_AUTH_TOKEN: "sntryu_e2e" },
  config: () => ({
    work_sources: [{ type: "sentry", name: "errors", sentry: {
      base_url: sentry.url, organization: "acme", projects: ["backend"],
      environment: ["production"], query: "is:unresolved", stats_period: "14d", on_merge: "comment",
    } }],
    belt: [{ name: "fix", source: "errors", steps: [{ type: "work" }, { type: "pr" }] }],
  }),
}, async (w) => {
  sentry.seed({ id: "4823", title: "TypeError: cannot read property 'id' of undefined",
                culprit: "widgets.handlers.create", release: "v1.2.3" });
  await w.waitForPhase("4823", "reviewing");
  w.gh.merge(w.db.run("4823")!.pr_number!);
  await w.waitForEnd("4823", "merged");
  expect(sentry.notes("4823")[0]).toContain("Fixed by");     // on_merge: comment
  expect(sentry.status("4823")).toBe("unresolved");          // …and NOT a status write
});
```

Everything is in-process state: a `seed()` / `setRelease()` / `addNote()` between ticks is visible to
the very next poll, with nothing to restart or reload.

## Why a stateful fake and not `HttpStub`

The sentry source's contract is a *lifecycle*, and every interesting part of it is a
read-after-write that a canned route table cannot express:

| behaviour | what it needs |
|---|---|
| `on_merge: comment` is idempotent across a retried `merged` intent | the second POST must see the first one's note |
| `on_merge: resolve` | the status must actually change, and stay changed |
| ask-human ▸ reply | note ids and `dateCreated` must be **monotonic** — the reply poll accepts only a note dated *strictly after* the question |
| regression reopen | the **list** payload must omit the release while the **detail** payload carries it |
| the auth gate | "no request was made at all" must be assertable |

## Endpoints

Paths, query parameters and response fields are taken from the engine's client, not from memory.

| method + path | client call | answer |
|---|---|---|
| `GET /api/0/organizations/{org}/` | `getOrganization()` (doctor probe, `health()`) | `{id, slug, name, status}` |
| `GET /api/0/projects/{org}/{slug}/` | `getProject()` (`health()`, slug→id) | `{id, slug, name, platform, …}`; unknown slug ⇒ **404** |
| `GET /api/0/organizations/{org}/issues/?query=&statsPeriod=&limit=&project=…&environment=…` | `listIssues()` ▸ `listEligible()` | JSON **array** of issues, **without** `firstRelease`/`lastRelease` |
| `GET /api/0/organizations/{org}/issues/{id}/` | `getIssue()` ▸ `describe`, `materialize`, the regression probe | the issue **with** `firstRelease`/`lastRelease` |
| `PUT /api/0/organizations/{org}/issues/{id}/` | `updateIssue()` ▸ `on_merge: resolve` / `resolve_in_next_release` | applies `status`, returns the detail payload |
| `GET /api/0/organizations/{org}/issues/{id}/events/latest/[?environment=…]` | `getLatestEvent()` ▸ the stacktrace in task.md | the event, or **404** when the issue was seeded `event: null` |
| `GET /api/0/organizations/{org}/shortids/{shortId}/` | `resolveShortId()` ▸ `describe("BACKEND-1AB")` | `{shortId, groupId, group, organizationSlug, projectSlug}` |
| `GET /api/0/organizations/{org}/issues/{id}/comments/` | `listComments()` ▸ reply poll + both idempotency scans | notes **newest-first** (the endpoint's default order) |
| `POST /api/0/organizations/{org}/issues/{id}/comments/` | `addComment()` ▸ `postNote`, `askHuman`, `on_merge: comment` | **201** + the created note |

A request for **another org** 404s, so a wrong `sentry.organization` fails loudly instead of quietly
returning nothing. Anything else under `/api/0/` 404s; anything outside it 404s too.

### Payload facts that are load-bearing

- **`count` is a STRING** (`"137"`) — exactly as Sentry sends it, and the source coerces it. Seeding
  takes a number.
- **The release is DETAIL-ONLY.** `firstRelease`/`lastRelease` appear on the issue detail payload and
  are absent from the list payload. The whole regression-reopen path exists *because* of that
  asymmetry: for a terminal item Sentry flags `substatus: "regressed"`, the source spends one bounded
  detail call (cap 20/poll) to learn which release re-introduced it. Leaking the release into the list
  payload would silently disable that code path.
- **`resolvedInNextRelease` round-trips as Sentry serves it**: the PUT is accepted verbatim, but the
  payload renders `status: "resolved"` + `statusDetails: {inNextRelease: true}`. `fake.status(id)`
  returns what the factory **wrote** (`"resolvedInNextRelease"`), which is the assertion you want.
- **Note ids are numeric strings and strictly increasing; `dateCreated` is strictly increasing too.**
  The reply poll compares `dateCreated > question.dateCreated`, and falls back to comparing numeric
  ids when a timestamp is unusable — so a same-millisecond note would otherwise be dropped.
- Issues come back in **seed order** by default: the list sorts last-seen descending, and every seed
  defaults to the same instant (the fake's construction time), so the insertion-order tie-break wins.
  Set `lastSeen` to order them explicitly — or to age one out of the `statsPeriod` window.

## The scenario-facing API

```ts
const fake = new SentryFake({ organization: "acme", project: "backend" });
await fake.listen();  fake.url;  await fake.close();
```

| member | what it does |
|---|---|
| `seed(issue)` | add an issue (see the fields below) |
| `addProject(slug, name?)` | register an extra project so `health()` can resolve it |
| `status(id)` | `unresolved` \| `resolved` \| `resolvedInNextRelease` \| `ignored` — as last **written** |
| `notes(id)` | bodies of the notes the **factory** posted, oldest first |
| `allNotes(id)` | every note (factory + human) with id/timestamp/author |
| `addNote(id, body, author?)` | a **human** note arriving — how an ask-human question gets answered |
| `setRelease(id, release)` / `release(id)` | the detail-only `lastRelease.version` |
| `markRegressed(id)` | `substatus: "regressed"` **and** status back to `unresolved`, the way Sentry reopens a recurrence |
| `requests(match?)` | every served request (`{ts, method, path, body, status}`), filtered by a substring of `<METHOD> <target>` |
| `reset()` | truncate the request log + drop unconsumed one-shot failures (issues and notes survive) |

`seed()` fields: `id` (the canonical numeric key), `title`, and optionally `shortId` (default
`<PROJECT>-<id>`), `culprit`, `level`, `count`, `userCount`, `release`, `regressed`, `project`,
`status`, `platform`, `environments`, `isUnhandled`, `issueCategory`, `metadata`, `firstSeen`,
`lastSeen`, `event`.

`sentryWithIssue()` returns a fake with one actively-firing error already seeded — the shape most
scenarios want.

### The synthesized event

Seed without an `event` and the latest-event endpoint answers a generated payload carrying all three
entry types the materializer renders — an `exception` with a three-frame stacktrace (outermost first,
which is Sentry's order and what `renderEntries` reverses), `breadcrumbs`, and a `request` — plus
`environment`/`release`/`level` tags. The crashing frame is `metadata.function` at
`metadata.filename`, line 42, marked `inApp`. Both are derived from the **culprit**, which Sentry
writes either as a dotted symbol path or as a file path — so `widgets.handlers.create` gives
`create` in `app/handlers.py`, while `app/routes/checkout.ts` gives `handler` in
`app/routes/checkout.ts` (splitting a file path on `.` would name the function after its extension).
The two framing frames follow the crashing frame's extension. The rendered task.md then contains:

````markdown
### Exception

```
TypeError: cannot read property 'id' of undefined
  at create (app/handlers.py:42)  <- in-app
  at dispatch (app/router.py:88)
  at main (app/main.py:12)
```
````

Pass `event: {...}` to control the payload exactly, or `event: null` to make `events/latest/` **404** —
the "no event payload was available at materialize time" branch of task.md, which is a real state for
a brand-new issue mid-ingest.

## Failure injection

| knob | effect |
|---|---|
| `requireAuth` (default **true**) | a request with no `Authorization: Bearer …` ⇒ **401**. On by default because the engine's auth gate is supposed to stop an uncredentialed source *before* the client is reached — an unauthenticated request arriving here is itself the bug |
| `expectToken` (default `null`) | only this exact bearer token is accepted; any other ⇒ **401** |
| `failWith` (default `null`) | every matching request answers this status while set |
| `failMatch` (default `null`) | scope `failWith` to requests whose `<METHOD> <target>` matches (substring or regex) |
| `failOnce(status, match?)` | fail the **next** matching request, then serve normally |
| `gone: Set<string>` | issue ids (or short ids) that answer `goneStatus` — a deleted or merged-away issue |
| `goneStatus` (default `404`) | `404` or `410`; both read as "gone" to the engine |
| `rejectDuplicateNotes` (default **false**) | an identical factory note ⇒ **400**, like Sentry's within-the-hour duplicate rule. Off by default (it would turn a legitimately repeated attention note into a failure); turn it on to prove the ask-human / `on_merge: comment` idempotency scans really do read before they write |

Injection is checked **before** auth, which is before routing — so a "backend is down" phase beats
everything, and the request is logged either way.

How each maps through the engine:

| injected | the engine sees |
|---|---|
| 401 | `SourceUnauthenticatedError{reason:"rejected"}`, hint *"check SENTRY_AUTH_TOKEN in the repo env"* → the source is paused by the auth gate |
| 403 | the same error, with the **scope** hint (*"the token lacks the required scope (event:read to poll, event:write to comment/update)"*) |
| 404 / 410 | `isSentryNotFound` ⇒ `StaleItemError` from `askHuman`/`pollHumanReply`; `getLatestEvent` degrades to `null`; `materialize` logs and writes no task.md (the next claiming tick retries) |
| 429 / 5xx | **retried** by the http policy — 3 extra attempts for reads, 1 for writes, exponential backoff with jitter. Costs real seconds; prefer 401/403/404 unless the retry is the thing under test |

## Deliberate simplifications

- **The issue search query is a subset.** `is:` (unresolved/resolved/ignored/muted/regressed),
  `level:`, `environment:`, `release:`, `project:`, and bare words as a case-insensitive substring of
  title/culprit/exception value. Every **other** `key:value` facet **matches everything** — modelling
  Sentry's search language is not this fake's job, and an over-permissive filter is much easier to
  diagnose than a silently-dropping one (which would look like an engine bug).
- **No pagination.** One page; `limit` truncates; no `Link` header (the client reads one page by
  design — claims are admission-capped per tick anyway).
- `statsPeriod` is validated (`\d+[smhdw]`, else **400**, as the org endpoint does) and filters on
  `lastSeen`. `project` is honoured via the resolved **numeric** ids (or `-1` = all); an absent
  `project` param is treated as "all" rather than rejected.
- Assignment, bookmarks, `seenBy`, tags-on-the-issue, and activity other than notes are rendered as
  empty/`null` — nothing in the engine reads them.
- The duplicate-note 400's wording is ours; only the status code is Sentry's.

## Engine facts to keep in mind when scripting a scenario

- `SentryClient` **caches the project slug → numeric id** for the life of the process. A project
  registered after the first successful poll is never re-resolved; a slug that 404s is skipped with a
  warning and retried next poll (that one is *not* cached).
- One shared **token bucket** guards the whole client: 3 req/s sustained, burst 6. A poll that also
  spends regression probes will be throttled, not rejected — budget scenarios should count requests,
  not assume they are instantaneous.
- `materialize` is **idempotent on task.md**: once written, later ticks make no Sentry calls at all.
  Mutating the fake after the first materialize will not change what the agent reads.
- `store.setWorkItemRelease` (the release baseline the reopen logic compares against) **no-ops when
  the ledger row does not exist yet** — the row is created at claim, and materialize stamps it. A
  scenario asserting the baseline has to let the claim happen first.
- `transition` never returns `stale` for sentry: the status of record is the internal `work_items`
  ledger, and Sentry is only ever written for the optional `on_merge` courtesy. Deleting an issue
  (`gone`) therefore does **not** break the lifecycle — only the reply channel and materialize.
