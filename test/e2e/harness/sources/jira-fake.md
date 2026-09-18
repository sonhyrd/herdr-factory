# The fake Jira backend

`jira-fake.ts` is a **stateful** Jira Cloud stand-in: a real HTTP server that holds issues, moves
them through a workflow and stores comments, so a scenario can drive the engine's own
`JiraClient`/`JiraSource` end to end and then assert on what the ticket *became*.

The only seam it needs is `jira.base_url` — point it at the fake and the engine is unmodified:

```ts
import { JiraFake } from "../harness/sources/jira-fake.ts";

const jira = new JiraFake({ project: "APP", boardId: 7 });

scenario(
  {
    name: "jira-source",
    beforeStart: async () => {
      await jira.listen();
      jira.seed({ key: "APP-1", summary: "Crash on save", type: "Bug", labels: ["agent"] });
    },
    afterStop: () => jira.close(),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "not-a-real-token" },
    config: () => ({
      work_sources: [{ type: "jira", name: "board", jira: { base_url: jira.url, project: "APP", board: 7 } }],
      belt: [{ name: "tickets", source: "board", label: "agent", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    await w.waitForEnd("APP-1", "completed");
    expect(jira.statusHistory("APP-1")).toEqual(["In Progress", "In Review"]);
  },
);
```

The engine must have credentials in the repo env (`JIRA_EMAIL` + `JIRA_API_TOKEN`) or the auth gate
stops it before any network call — the fake will simply never be dialled (which is exactly what
`missing-api-key` asserts, against `HttpStub`).

`HttpStub`'s `emptyJiraBoard()` still exists and is still the right tool when the question is
"**was** Jira called?". Reach for `JiraFake` when the question is "what did the factory **do** to the
ticket?".

## Control surface

| member | what it does |
|---|---|
| `new JiraFake({ project?, boardId?, statuses? })` | `project` "APP", `boardId` 1, workflow `To Do`/`In Progress`/`In Review`/`Done` plus any extras |
| `listen()` / `close()` / `url` | binds a free port on 127.0.0.1; `url` is `jira.base_url`. `close()` drops keep-alive sockets first, so it never hangs on undici's pool |
| `seed({ key, summary, type?, status?, labels?, description?, attachments? })` | adds an issue. `key` must be `PROJ-N`: the prefix is the project the pickup JQL filters on. Seeding twice throws |
| `status(key)` | the CURRENT status name |
| `statusHistory(key)` | every **applied** transition, in order — the ordering invariant. The seeded status is *not* included; the full trail is `[seedStatus, ...statusHistory(key)]` |
| `comments(key)` | `{ id, body, author, created }[]`, oldest first, `body` flattened to the text the engine extracts from the ADF |
| `addComment(key, body, author?)` | a **human** reply arriving (unmarked, so `pollHumanReply` takes it). Returns the comment id |
| `requests(match?)` | `{ ts, method, path, body }[]`, filtered by a substring of `<METHOD> <path>`. `path` keeps the query string, so the JQL and the `fields` projection are assertable |
| `reset()` | truncates the request log only (per-phase call budgets); issues and comments survive |
| `statuses: Set<string>` | the reachable workflow. `add` one your belt configures, `delete` one to force the engine's "no transition" error |
| `requireAuth: boolean` | **default true** — 401 unless the request carries a `Basic` header |
| `failWith: number \| null` | force a status on *every* call; checked before auth and routing |
| `gone: Set<string>` | keys that no longer exist: dropped from the board search, `goneStatus` on every per-issue route |
| `goneStatus: number` | what a `gone` key answers (404 default; 410 if a scenario wants it) |

Mutations are immediate — the engine is a separate process talking HTTP, so the next tick sees them
with no reload.

## What it serves

Every route, query parameter, request body and response shape is taken from `src/clients/jira.ts`
and `src/clients/jira-source.ts`.

| request | answer |
|---|---|
| `GET /rest/agile/1.0/board/<id>/issue?jql=…&fields=summary,issuetype,status,labels&maxResults=50` | `{startAt,maxResults,total,isLast,issues:[{id,key,self,fields}]}` — really filtered by the JQL, really projected to `fields`, really truncated to `maxResults`. A board id other than `boardId` ⇒ **404** |
| `GET /rest/api/3/issue/<key>?fields=summary,description,issuetype,status,labels,attachment,comment` | the `JiraIssue` the materializer writes to `ticket.json`. Key lookup is case-insensitive (and accepts the numeric id) and the answer carries the **canonical** key |
| `GET /rest/api/3/issue/<key>/transitions` | `{transitions:[{id,name,to:{id,name,statusCategory}}]}` — one per reachable status |
| `POST /rest/api/3/issue/<key>/transitions` `{"transition":{"id":"…"}}` | applies it, appends to `statusHistory`, answers **204 with an empty body** (the engine sends this one through `send()`, not a JSON-parsing helper — a JSON body here would hide a regression). An id that isn't currently offered ⇒ 400 |
| `GET /rest/api/3/issue/<key>/comment?orderBy=created&startAt=0&maxResults=100` | `{startAt,maxResults,total,comments:[…]}`, oldest first (`orderBy=-created` reverses). **Paged**: the slice starts at `startAt`, so a >100-comment thread takes as many calls as the client walks |
| `POST /rest/api/3/issue/<key>/comment` `{"body":<ADF>}` | **201** with the created comment (`id`, `created`, `author`, the ADF stored verbatim). A v2-style string body ⇒ 400 |
| `GET /rest/api/3/attachment/content/<id>` | the attachment bytes. The `content` URL the issue advertises is **absolute**, as Jira sends it — `downloadAttachments` fetches it directly rather than joining it onto the auth base |

### Deliberate details

- **The pickup JQL is parsed, not ignored.** `project = "…" AND status = "…" [AND labels = "…"] ORDER
  BY created ASC` is the whole supported grammar; anything else is a **400** naming the clause. A
  claimed ticket therefore really leaves the pickup query (INV-1 re-claim convergence), and a change
  to the query shape surfaces as a failing pickup instead of a silently unfiltered board.
- **A transition's `name` is deliberately not its target status** (`"Move to in review"` → `In
  Review`). The engine matches case-insensitively on `.to.name`; a regression that matched `.name`
  must fail here.
- **The workflow is permissive** — every status but the current one is reachable, because the *belt*
  owns the ordering under test (assert it with `statusHistory`), not Jira's graph. A belt configured
  with status names outside the default four must `statuses.add(…)` them, or the engine gets Jira's
  honest `no transition from "X" to "Y"`.
- **Timestamps are Jira's format**, `2026-06-28T09:15:00.000+0000` (no colon in the offset) — the
  reply cutoff runs `Date.parse()` over that exact string. Comment timestamps are forced strictly
  increasing so the cutoff path can't tie.
- **An unserved route is a loud 404** whose message names the method and path. A bland `{}` would let
  a newly-added engine call pass as an empty-but-successful answer.
- **Auth is Basic-only** (`requireAuth` default true): the Agile API rejects Bearer, which is *why*
  the jira source is api_token only.

## Failure injection

```ts
jira.failWith = 401;          // credentials rejected → SourceUnauthenticatedError("rejected")
jira.failWith = 503;          // backend down
jira.gone.add("APP-2");       // deleted / moved / permission revoked
jira.goneStatus = 410;
jira.statuses.delete("Done"); // the terminal transition is no longer offered
```

Two engine facts to plan around:

- `httpWithPolicy` retries 429/5xx **3 times** with exponential backoff (`src/clients/http.ts`), so a
  `failWith = 503` call takes ~7 s to fail, and a Retry-After-less 429 the same. 401/403/404 fail
  fast (4xx is not retried).
- `JiraClient` shares one 5 req/s (burst 10) token bucket across every call it makes. A scenario
  seeding dozens of issues will see the fake answer in bursts — that back-pressure is the engine's,
  not the fake's.

## Known engine gaps this fake exposes

Verified by driving `JiraSource` against it:

1. **A gone issue is not `stale`.** With `gone.add("APP-2")`, `transition()` rethrows the raw
   `HttpStatusError: HTTP 404` instead of returning `{ kind: "stale" }`, so the transition outbox
   retries a deleted ticket on the 60 s→1 h backoff forever. `github-issues-source.ts` maps its
   404/410 to `stale`; the jira source has no equivalent. Same for `askHuman`/`pollHumanReply`, which
   are supposed to throw `StaleItemError` (types.ts) and instead surface the HTTP error.
2. **`materialize` on a gone issue succeeds with no work doc.** With `gone` set it logs
   `warn: APP-9: could not save ticket.json` + `warn: APP-9: attachment download had issues`,
   creates only the empty `attachments/` directory, and **returns normally** — so the claim proceeds
   and the agent is pointed at a `ticket.json` that does not exist.
