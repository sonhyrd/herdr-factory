# Work sources

> A work item that vanishes at the backend (deleted, moved, permissions revoked) is `stale`, not an
> error: jira and github_issues both map 404/410 that way, so the write-back is marked delivered and
> the run is aborted (pre-work) or parked (mid-flight) instead of retrying forever. Sentry and
> local_markdown keep their lifecycle in the factory's own ledger, so nothing can go stale under them.


Where work comes from: the four `work_sources[]` types, their config blocks, credentials, eligibility rules, lifecycle write-backs, and what each one materializes into the worktree.

Answers these questions:

- Which source type should this repo use, and does its belt need a `label`?
- What exactly do I set so that *one specific* ticket/issue/brief/error gets picked up?
- Which env var goes in the repo env file, with which scopes, and what happens if it's missing?
- What does the factory write back to Jira/GitHub/Sentry, and when?
- Which files appear in `.memory/herdr-factory/` for the work agent to read?
- Why is my source returning nothing (or the same item twice), and how do I slow it down?
- Can one repo poll several sources at once?

Belt wiring (`source:`, `label:`, `match:`, effects) lives in [belts-and-steps.md](./belts-and-steps.md). Full key/type/error catalogue: [config-reference.md](./config-reference.md). Symptom playbooks: [troubleshooting.md](./troubleshooting.md).

## Cheat sheet

| | `jira` | `github_issues` | `local_markdown` | `sentry` |
|---|---|---|---|---|
| credentials | `JIRA_EMAIL` + `JIRA_API_TOKEN` (both required) | `GITHUB_TOKEN` (optional — falls back to `gh auth token`) | none | `SENTRY_AUTH_TOKEN` (required) |
| pickup mechanism | Agile board + JQL (`project` + `status.todo` + belt label), 50/poll, 1 page | REST issues list (`labels=` + `state=open`), 100 × `max_pages` — issues, or PRs under `kind: pull_requests` | folder scan, top level only | org issues search (`query` + `stats_period` + `projects`), 100/poll, 1 page |
| ordering | `ORDER BY created ASC` | `sort=created&direction=asc` (oldest first) | `names.sort()` (lexicographic) | Sentry's default for the query |
| status of record | external — Jira | external — GitHub | internal ledger (`work_items`) | internal ledger (`work_items`) |
| belt `label` | **required** | **required** (the *trigger* label) | **must be omitted** | **must be omitted** |
| write-backs | status transitions, comments, ask-human comments | state labels, trigger-label consumption, close on merge/done (issues only — never a PR), comments | none to the folder (only the ask-human inbox file) | none for state; optional `on_merge` note/resolve |
| custom (effect) statuses | yes — `status.<key>` | yes — `state_labels.<key>` | no | no |
| work doc | `ticket.json` | `task.md` | `task.md` **or** `task/` | `task.md` |
| best for | team-process Jira boards where humans watch the ticket move | OSS / repo-native workflow; labels as the whole UI | briefs you write yourself; onboarding and one-offs | production error fixing, unattended |

## The source envelope (all four types)

```yaml
work_sources:
  - type: jira                   # jira | github_issues | local_markdown | sentry
    name: jira                   # optional; default = the type string
    poll_interval_seconds: 300   # optional; default limits.source_poll_interval_seconds ?? limits.tick_interval_seconds (60)
    max_active_workspaces: 2     # optional; default 2 — per-source cap on occupying runs, summed across belts
    jira:                        # a block named after `type` is required; its contents are type-specific (below)
      base_url: https://acme.atlassian.net
      project: PROJ
      board: 254
```

- **Names.** `name` defaults to the type string, and uniqueness is checked on the *resolved* name — two unnamed `jira` sources both resolve to `"jira"` and fail load with ``duplicate work source name "<name>" — give each source a unique name``.
- **Missing list.** No `work_sources` ⇒ ``add a `work_sources` list — at least one source to pull work from (jira, github_issues, local_markdown, or sentry)``.
- **Strictness asymmetry.** The inner blocks of `jira`, `github_issues` and `sentry` are strict — an unknown key is a load error. **`local_markdown`'s inner block is not strict**: unknown keys there are silently dropped. The *outer* source object is strict for all four.
- **Polling vs the tick.** A source is polled every tick when `poll_interval_seconds <= limits.tick_interval_seconds`. When the interval is *larger*, the poll (and therefore every claim from that source) is skipped until the interval elapses, with a tolerance of `min(tick/2, 5)` seconds so a "5 min" cadence doesn't slip a whole tick on jitter. Between polls the source contributes zero eligible items — so its backlog drains at most `limits.max_claims_per_tick` (default 10) per **poll window**. The poll timestamp is stamped on the *attempt*, so a failing or paused source also backs off to its interval.
- **`claim_guard`** (`jira`, `github_issues` only) — see [Several factories on one source](#several-factories-on-one-source-claim_guard). Off by default.
- **`max_active_workspaces`** caps occupying runs for this source across all belts. A belt whose source is at its cap is skipped *before* polling: `belt <b>: source "<s>" at its concurrency cap (<n>) — skipping`.
- **Env file** is strictly per-repo: `<configDir>/repos/<name>/env`, written chmod 600, where `<configDir>` is `$HERDR_FACTORY_CONFIG_DIR` or `~/.config/herdr-factory`. Format is `KEY=value` per line; `#` comments and blank lines are skipped; both sides are trimmed. There is **no quote stripping and no escapes** — `TOKEN="abc"` yields the value `"abc"` *with* the quotes. There is no global/shared secrets file.
- **Missing or rejected credentials pause the source; they are never a startup error.** Descriptors read env vars unconditionally, so config load and startup always succeed. The first call then throws, and the reconciler:
  1. degrades the poll to zero items (no claims from that source this tick);
  2. leaves queued status write-backs **queued** (nothing is lost);
  3. backs the ask-human reply poll off like a miss;
  4. logs `<source>: work source not authenticated (<missing|rejected>) — pausing its claims + status write-backs until re-authenticated` and sends **one** notification titled `herdr-factory: <source> not authenticated`, re-notified every `limits.attention_renotify_seconds` (default 3600).

  Recovery is automatic on the next successful call: `<source>: re-authenticated — resuming work (N held write-back(s) re-queued)`. The gate is in-memory only, so a restart also clears it. `herdr-factory --repo <r> auth status` reports **presence only, no network**; `doctor --deep` is what exercises the credential live. See [cli.md](./cli.md).
- **Write-back retries are flat and capped.** A thrown transition is re-attempted by the outbox every 30 s; after 10 failed attempts it **suspends** (retries stop, the operator is notified, the repo's TUI row flags in red) until `retry-now` / `s` or a source-auth recovery clears it. `applied` / `noop` / `stale` all count as delivered.
- **Materialization** happens on every claiming tick into `.memory/herdr-factory/` inside the run's worktree (each source guards on its own marker file, so it is written once). A *committed* `.memory/herdr-factory/` in a fresh worktree is scrubbed with the warning `removed a committed .memory/herdr-factory from the fresh worktree — the repo should not track factory memory`. Every created or reopened worktree also gets `.memory/` appended (once) to the checkout's `info/exclude`, so the dir never shows as untracked. Failures only warn — the run continues. Prompt tokens `@@MEMORY_DIR@@` / `@@WORK_DOC@@` / `@@WORK_DOC_KIND@@`: see [prompts.md](./prompts.md).
- **Item type drives the branch prefix**, matched case-insensitively by substring: `bug`/`defect` → `fix/`, `chore`/`task` → `chore/`, anything else → `feature/`. This is why `type_labels: {bug: Bug}` gets `fix/`, and why local_markdown's default type `task` gets `chore/`.

---

## `jira`

### Config block

```yaml
- type: jira
  name: jira                                    # optional; default "jira"
  poll_interval_seconds: 300                    # optional
  max_active_workspaces: 2                      # optional; default 2
  jira:
    base_url: https://your-org.atlassian.net    # REQUIRED — site host, trailing slashes stripped
    project: PROJ                               # REQUIRED — project key
    board: 254                                  # REQUIRED — Agile board id (number or string)
    status:                                     # optional; whole map optional
      todo: To Do                               # default "To Do"      — the pickup status
      in_development: In Progress               # default "In Progress"
      review: In Review                         # default "In Review"  — the key is `review`, NOT `in_review`
      done: Done                                # NO DEFAULT — opt-in; unset means merged tickets are left alone
      qa: QA Review                             # any EXTRA key = a custom status usable by a belt effect
```

Required-field messages: ``set `jira.base_url` to your Atlassian site, e.g. https://your-org.atlassian.net``; ``set `jira.project` to your Jira project key, e.g. PROJ``; ``set `jira.board` to the Agile board id pickup pulls from, e.g. 254``.

`status` is a catch-all map, **not strict**. Known keys are exactly `todo`, `in_development`, `review`, `done`; every other key becomes a belt-effect custom status.

### Credentials

| var | required | how to get it |
|---|---|---|
| `JIRA_EMAIL` | yes | the Atlassian account email |
| `JIRA_API_TOKEN` | yes | id.atlassian.com → Security → API tokens |

Auth is HTTP Basic `base64(email:token)`. Missing ⇒ paused with hint `set JIRA_EMAIL + JIRA_API_TOKEN in the repo env`. A live 401 **or** 403 ⇒ paused as `rejected` with hint `Jira rejected the credentials (HTTP <status>) — re-authenticate (api_token: check JIRA_EMAIL + JIRA_API_TOKEN in the repo env; oauth: run \`auth login\`)`.

**There is no OAuth and no `auth login` command** — that hint string is stale. The Agile board API (`/rest/agile/1.0`) is not reachable with an OAuth token, so api_token is the only mode; an API token cannot self-heal, so a rejection surfaces immediately rather than retrying.

### What makes an item eligible

```
GET <base_url>/rest/agile/1.0/board/<board>/issue
    ?jql=<jql>&fields=summary,issuetype,status,labels&maxResults=50

JQL: project = "<project>" AND status = "<status.todo>" AND labels = "<belt.label>" ORDER BY created ASC
```

The board's own saved filter scopes the query; `project`, the todo status and the belt label narrow inside it. One page of 50 per poll, **no pagination** — a deeper backlog surfaces on later polls. The `labels =` clause is omitted only by doctor's probe when no belt feeds the source.

**To get one ticket picked up:** it must be on that board, in that project, in exactly the `status.todo` status, and carry the belt's `label` (Jira labels are case-sensitive; the label goes into the JQL verbatim).

The source does **no** client-side filtering — eligibility is whatever the JQL returns. Dedup is entirely engine-side: an item is skipped when it already has an active run in this source, or when a status write-back to this source is still pending (`<key>: skipping claim — a status write-back to "<source>" is still pending`).

JQL values are interpolated **unescaped**. A `"` in `project`, in the todo status name, or in the belt label produces malformed JQL → Jira 400 → the poll degrades to zero items with `<source>: eligible query failed: HTTP 400: …`.

### Lifecycle write-backs (source of record: Jira)

| canonical state | Jira status written |
|---|---|
| `todo` | `status.todo` |
| `in_development` | `status.in_development` |
| `in_review` | `status.review` |
| `merged`, `done` | `status.done` — **unset ⇒ no-op, zero network** |
| `aborted` | never mapped — a human decides the ticket's fate |

A belt effect's custom status key resolves through the extra `status.<key>` entries and **wins over** the canonical mapping; an unmapped state is a no-op with no network call.

Each write is `GET` current status → case-insensitive compare (equal ⇒ no-op) → `GET .../transitions` → find one whose `to.name` matches case-insensitively → `POST` it. **No matching transition throws** ``<KEY>: no transition from "<current>" to "<target>"`` and the outbox retries every 30 s until it suspends at 10 attempts — see failure modes.

Other writes: notes are comments prefixed `[herdr-factory] `; ask-human posts a comment whose first line is `[herdr-factory question: <repo>/<runId>/<questionId>]` (existing comments are scanned for that marker first, so it is idempotent). Reply polling lists comments after the question, skipping every herdr-marked body (blockquote-aware, so a quote-reply still counts). ADF bodies are flattened; an empty extraction becomes `(Jira comment had no extractable text.)`.

### Materialized files

- `.memory/herdr-factory/ticket.json` — the raw `GET /rest/api/3/issue/<key>?fields=summary,description,issuetype,status,labels,attachment,comment` payload, pretty-printed. This is `@@WORK_DOC@@`; **jira writes no `task.md`** — the agent reads JSON.
- `.memory/herdr-factory/attachments/` — always created. Only `image/*` and `video/*` are downloaded; caps are 12 attachments total, 10 MB per image, 50 MB per video. PDFs and logs are skipped silently. Truncation is logged: `<key>: saved N/M media attachments — rest skipped (over the 12 cap or size limit)`. Filenames are sanitized to `[A-Za-z0-9._-]` with **no collision handling** — two attachments that sanitize to the same name overwrite each other.

`ticket.json` is the idempotency guard, so a failed fetch (`<key>: could not save ticket.json`) simply retries next tick.

- `.memory/herdr-factory/work-content.json` — edit detection's baseline: the description and every other rich-text field (acceptance criteria), by display name, plus `updated` (`GET …/issue/<key>?fields=*all&expand=names`). If it differs before a read-only or PR-opening step, the run parks `work_item_edited`: `ticket.json` is refreshed, the claim-time copy is kept as `ticket.claimed.json`, and `work-item-edits.md` holds the before/after ([troubleshooting.md](./troubleshooting.md)).

### Polling and rate limits

One token bucket per client: 5 req/s sustained, burst 10, shared by every Jira call. 30 s timeout for JSON, 120 s for media. Reads retry 3×; writes retry once (a timed-out write may have landed). A claim costs roughly 5 calls; parked runs additionally poll comments. Raise `poll_interval_seconds` (300 is a good board-friendly value) to spare the board.

### Failure modes

| symptom | cause | fix |
|---|---|---|
| poll always empty, no error | `board` belongs to a different project than `project`, or nothing is in `status.todo` with the label | check the board id in the board URL (`rapidView=`/board id) and that a ticket really sits in the exact todo status |
| `<source>: eligible query failed: HTTP 404: …` | bad `board` id | fix `board`; `doctor --deep` fails on this too |
| `<source>: eligible query failed: HTTP 400: …` | unknown `project`, a status name that doesn't exist, or a quote inside an interpolated value | match Jira's spelling exactly (**casing matters for pickup**) |
| tickets pick up but never move | `status.*` names don't match Jira, or the workflow has no transition | see next row; casing is *not* an issue for transitions |
| `<KEY>: no transition from "In Progress" to "Done"` repeating with `transition deferred (attempt N, retry in Ns)` | the target status is unreachable from the current one in the Jira workflow | add the workflow transition, or point `status.*` at a reachable status; the intent retries forever until it lands |
| source paused after an env-file edit | credentials rejected, or the value kept its quotes | `auth status` (presence), then `doctor --deep`; remove quotes from the env file |
| ticket deleted mid-run | Jira 404 on the write-back; jira never reports `stale` | tear the run down manually (`teardown <key>`) |

### Commonly misconfigured (jira)

1. **`board` is the Agile board id, not the project key.** Both are required and both are used — the board scopes, the project narrows. A board from another project yields a permanently empty poll with no error.
2. **The review key is `review`, not `in_review`.** Writing `status.in_review: Code Review` is *silently accepted* as a custom belt-effect status while `review` stays at the default `"In Review"`. The same trap swallows every typo (`in_developement:`).
3. **Status names must match Jira exactly for pickup** (the JQL compares literally), while the transition lookup is case-insensitive — so a casing error breaks pickup but not write-back.
4. **`status.done` is unset by default**, i.e. merged tickets are left where they are (Jira's GitHub integration usually owns closure). Add it if you want auto-Done.
5. `base_url` is the site host (`https://org.atlassian.net`), not `api.atlassian.com`, and needs the scheme.
6. Renaming the source strands in-flight runs — the name is the durable foreign key (see the last section). The default jira source should keep the name `jira`.

---

## `github_issues`

### Config block

```yaml
- type: github_issues
  name: issues
  github_issues: {}                    # the block key is REQUIRED, but may be empty — every field inside has a default
```

```yaml
- type: github_issues
  name: issues
  github_issues:
    repo: owner/name                   # optional; default = the resolved PR repo (repo.github, else git origin)
    state_labels:
      in_development: herdr:in-development   # default
      in_review: herdr:in-review             # default
      aborted: herdr:aborted                 # default
      qa: herdr:qa                           # any EXTRA key = a custom status usable by a belt effect
    close_on:                          # strict block
      merged: true                     # default true
      done: true                       # default true
      aborted: false                   # default false — failures stay visible
    type_labels:                       # default {bug: Bug, defect: Bug, chore: Chore, task: Chore, enhancement: Feature}
      bug: Bug
    default_type: Feature              # default "Feature"
    max_pages: 1                       # default 1, min 1, max 10 — pages of 100 issues per poll
    kind: issues                       # default "issues"; "pull_requests" polls PRs instead
```

`kind` is an enum — `issues` (default) or `pull_requests`; anything else is a load error. See
[Claiming pull requests](#claiming-pull-requests-kind-pull_requests). `repo` must match `owner/name`. `state_labels` is a catch-all map (known keys `in_development`, `in_review`, `aborted`); `close_on` **is** strict. `type_labels` keys are lowercased and matched case-insensitively. `close_on` and `type_labels` are **not** editable in the TUI config editor — YAML only.

**Startup error** when neither `github_issues.repo` nor a resolvable PR repo exists: ``work source "<name>": no GitHub repo to poll — set github_issues.repo (owner/name), or repo.github / a git origin so the default resolves``. This is the one descriptor that fails at build time.

### Credentials

`GITHUB_TOKEN` — **optional**, masked, hint `optional PAT with issues:write on the polled repo; when unset, the gh CLI's login is used`. Resolution: the env token wins and is never refreshed; otherwise `gh auth token` is run once and only a *successful* result is memoized. Neither ⇒ paused with `GitHub auth missing — set GITHUB_TOKEN in the repo env, or authenticate the gh CLI (\`gh auth login\`)`.

A 401 while using a memoized gh-CLI token triggers exactly one refetch (`github: 401 with a memoized gh-CLI token — refreshing it once (<METHOD> <path>)`); still 401 ⇒ `rejected` with `GitHub rejected the token (401) — refresh GITHUB_TOKEN, or run \`gh auth login\``. Only **401** is treated as an auth rejection — GitHub's 403 is ambiguous (secondary rate limit vs missing scope).

Scope needed: write access on the **polled** repo (labels, comments, close), which is not necessarily the PR repo.

`GITHUB_API_URL` — **optional**, not masked, in the same per-repo `env` file. The REST base every call goes to; default `https://api.github.com`. Set it for **GitHub Enterprise Server** (`https://ghe.example.com/api/v3`). There is deliberately no config key: the base and the token sent to it travel together, so they live in the same file. Validated at startup, not at first poll — a non-URL throws ``GITHUB_API_URL is not a URL: "<v>" — use the API base, e.g. https://ghe.example.com/api/v3``, and a non-`https` base throws ``GITHUB_API_URL must be https (got "<v>") — the API token is sent to it; only loopback may be http``. (Loopback-`http` is allowed for exactly one reason: the e2e suite's GitHub fake.)

### Rate limits — one token per host

GitHub counts its 5,000 requests/hour **per account**, not per machine or process. Several factories sharing one `gh auth` login therefore share one budget, and exhausting it breaks everything on that account at once — `gh`, the agents, the operator's own tooling — with `HTTP 403: API rate limit exceeded for user ID …`. **Recommend a separate `GITHUB_TOKEN` per host in each repo's `env`**, not a shared `gh` login.

When the limit is hit anyway, a `403`/`429` carrying `x-ratelimit-remaining: 0` or a `Retry-After` — surviving the client's retries — becomes a `SourceRateLimitedError` and the reconciler **holds that source until the reset the response named** rather than re-polling (re-polling an empty budget is what keeps it empty):

- Logged once per hold: `<source>: rate limited — holding its polls for <n>s (until the backend's own reset)`, then `<source>: rate limited — not polling for another <n>s (…)` each skipped tick, and `<source>: rate limit cleared — polls resuming` on recovery.
- Recorded on the problem ledger as key `source:<name>:rate-limit`, kind `rate_limit` — so the dashboard's repo light, `status` (as `⏳ <detail>`) and `explain` (as a `note:` line) all show it. Held write-backs stay queued; parked runs waiting on a human are rescheduled as a normal miss, never escalated.
- It clears itself at the reset — no operator action. A `403` with budget left and **no** `Retry-After` is *not* treated as a limit: that is a missing scope, and it stays an ordinary error.

Every tick logs its spend so you can tell who is eating the shared budget: `github: <n> call(s) this tick (<r> REST, <c> gh CLI) — shared with every other host on the same account`. `REST` is the `github_issues` source; `gh CLI` is the PR/review watcher.

### What makes an item eligible

```
GET https://api.github.com/repos/<owner/name>/issues
    ?labels=<belt.label>&state=open&sort=created&direction=asc&per_page=100&page=<1..max_pages>
```

Paging stops early when a batch returns fewer than 100. An item is eligible when **all** hold:

1. it carries the belt's `label` (server-side filter);
2. it is open (server-side);
3. it matches `kind` — **not a pull request** by default, and *only* a pull request under
   `kind: pull_requests`. The list endpoint interleaves both; this is the whole opt-in;
4. it carries **none** of the in-flight state labels: `in_development`, `in_review`, and every extra `state_labels.<key>` (all comparisons case-folded). The `aborted` label deliberately does **not** gate.

**To get one issue picked up:** add the belt's trigger label to an open issue in the polled repo and make sure it wears none of the state labels. **Re-adding the trigger label is the documented retry gesture** for an issue that was aborted or that you want re-worked.

Starvation warning when a full page yields nothing claimable: `github_issues: page <n> of "<label>" was entirely non-claimable (PRs/in-flight) — newer issues may be starving; check for trigger-labeled PRs or raise max_pages` (under `kind: pull_requests` the two nouns swap: `(issues/in-flight)`, `newer pull requests`, `trigger-labeled issues`).

Item type precedence: GitHub's native org-level issue type → the first `type_labels` hit among the issue's labels → `default_type`.

### Lifecycle write-backs (source of record: GitHub)

Mapped states are `in_development`, `in_review`, `merged`, `aborted`, `done` — a `todo` transition costs zero network. Every transition is `GET` → diff → apply, and that GET doubles as the stale probe. Label membership tests are case-folded; writes use your configured spelling. Missing labels are created on demand (`POST /labels` with color `5319e7`, description `managed by <brand>` — `source_comments.brand`, default `herdr-factory`).

| to | what happens |
|---|---|
| `in_development` | add the `in_development` label → remove every other state label → **remove the trigger label last** |
| `in_review` | same label swap; the trigger is not touched |
| custom (effect status) | add `state_labels.<key>`, remove other state labels; **never** consumes the trigger, **never** closes |
| `merged` / `done` | strip `in_development`/`in_review`/`aborted`, then `PATCH {state: closed, state_reason: completed}` iff `close_on.merged` / `close_on.done` and the issue is still open — **never for a pull request** |
| `aborted` | strip `in_development`/`in_review`, add the `aborted` label; close as `not_planned` only if `close_on.aborted` — otherwise the issue stays **open** wearing the label. A pull request always stays open |

**Trigger consumption is last on purpose:** if the swap partially fails and retries, the still-present trigger keeps the item filtered by the in-flight guard, so it can never be double-claimed. It is skipped entirely when the belt (and thus the label) is gone.

Closed-issue policy: closed before `in_development` ⇒ `stale` (`issue #<n> was closed (<reason>) before in_development`) — read as a human cancel. Closed at `in_review` with `state_reason: completed` ⇒ no-op (that is what a `Fixes #n` auto-close writes; the PR watch owns the real signal); any other reason ⇒ `stale`. Closed at a custom status ⇒ `stale`. Already closed and heading to `aborted` ⇒ no-op. **Nothing is ever reopened.**

Gone-ness: 301 ⇒ `transferred to another repository`, 410 ⇒ `deleted`, 404 ⇒ `not found (deleted, or the token lost access)`, all surfaced as `stale`. Redirects are **not** followed on mutations, deliberately — a followed 301 would re-issue an authenticated write against the issue's new repo.

Human loop: notes are `[herdr-factory] <note>` comments; ask-human's first line is `[herdr-factory question: <repo>/<runId>/<questionId>]` and its body ends `Reply in a NEW comment — herdr-factory resumes automatically when it sees the reply. (Edits to existing comments are not seen.)` Reply detection uses `since=` plus a strict created-after guard, so **editing an old comment is not a reply**. Comment listing paginates to 10 × 100 and warns `github: issue #<n> has over <N> comments — the rest were not fetched`.

### Materialized files

- `.memory/herdr-factory/task.md` (the idempotency guard, and `@@WORK_DOC@@`): `# Issue #<n>: <title>` (`# Pull request #<n>: …` under `kind: pull_requests`), then bullets `URL`, `Repo`, `Author`, `State`, `Labels`, and **`Closing reference: Fixes #<n>`** (or `Fixes owner/name#<n>` cross-repo — the shipped pr prompt requires the agent to copy this line into the PR body verbatim), then `## Description`, then one `## Comment by <login> (<date>)` per non-herdr comment.
- `.memory/herdr-factory/issue.json` — raw `{issue, comments}`.
- `.memory/herdr-factory/attachments/attachment-<k><ext>` — media downloaded and the markdown links rewritten to point at them. Caps: 12 attachments, 50 MB each. Both issue and comments are fetched as `full+json` because only the HTML body carries the signed URLs that resolve on private repos (and those signatures expire in minutes). Only these hosts are downloaded from: `private-user-images.githubusercontent.com`, `user-images.githubusercontent.com`, `camo.githubusercontent.com`, and `github.com/user-attachments/…`, https only — anything else is left as a link, with a footnote `> note: N attachment(s) could not be downloaded — follow the original links above.`

- `.memory/herdr-factory/work-content.json` — edit detection's baseline (the body + `updated_at`). A changed body parks the run `work_item_edited` before a read-only or PR-opening step: `task.md` is refreshed, the claim-time copy is kept as `task.claimed.md`, and `work-item-edits.md` holds the before/after. A label change is not an edit.

Titles, bodies and comments are sanitized (HTML comments and control/invisible/bidi characters stripped); the untouched payload stays in `issue.json`. If the issue fetch fails, `task.md` is **not** written (`<key>: could not fetch the issue for materialize: <msg>`) so the next tick retries.

### Polling and rate limits

Buckets are **process-wide singletons** — every repo in the process shares them, because they all spend one authenticated user's budget. Reads: 5 req/s burst 10 (burst smoothing; the 5,000/hr primary budget is *also* spent by the PR watcher and your own tooling). Mutations: ~60/min chained with ≤500/hr. Read policy retries 2×, mutations retry once so a write fails fast back to the durable outbox instead of stalling a tick. 403-with-`Retry-After` is treated as retryable (GitHub's secondary limits answer 403, not 429), but a synthesized wait over 30 s is treated as primary exhaustion and not retried. Timeouts 30 s / 120 s for media.

### Failure modes

| symptom | cause | fix |
|---|---|---|
| `github_issues: cannot reach <repo> — bad auth, or the token lacks access (<msg>)` | wrong `repo`, or token can't see it | fix `repo`; check `gh auth status` / `GITHUB_TOKEN` / `GITHUB_API_URL` |
| `GITHUB_API_URL is not a URL: …` / `GITHUB_API_URL must be https …` | a typo'd GHES base in the repo `env` | it is the host the token is sent to — fix it; the source refuses to build |
| `github_issues: issues are disabled on <repo> — enable them in repo settings` | issues tab off (only checked when `kind: issues`) | enable Issues, or point `repo` at the repo that has them |
| `github_issues: the token has no push/write access to <repo> — labels and comments will fail` | read-only token | use a PAT with write on the polled repo |
| `github_issues: trigger label "<label>" does not exist in <repo> — create it (or fix the belt's \`label\`) and add it to issues you want worked` | belt `label` never created | create the label (case doesn't matter) and apply it |
| poll returns nothing though a labelled issue exists | it still wears a state label, or it's a PR and `kind` is `issues` (or the reverse) | remove `herdr:in-development` / `herdr:in-review`; re-add the trigger; check `kind` |
| new issues never picked up | trigger-labelled PRs fill the oldest-first page | remove the label from the PRs, or raise `max_pages` |
| run parked with `issue #<n> transferred to another repository` / `… deleted` / `… not found` | issue moved/deleted/access lost | tear the run down; the source never reopens or follows the move |
| startup fails with `no GitHub repo to poll` | no `repo`, no `repo.github`, no git origin | set `github_issues.repo: owner/name` |

### Commonly misconfigured (github_issues)

1. **The trigger label lives on the belt, not the source** — there is no `github_issues.label`.
2. `state_labels` typos are silently accepted as custom belt-effect labels; the canonical label keeps its default.
3. Label **casing** is tolerated everywhere here (unlike Jira).
4. `close_on.aborted` is **false** by default — aborted issues stay open wearing `herdr:aborted`.
5. `repo` defaults to the **PR** repo; if issues live elsewhere, set it — and expect the qualified `Fixes owner/name#<n>` closing reference.
6. `type_labels` values feed the branch prefix by substring: `Bug` → `fix/`, `Chore` → `chore/`, everything else → `feature/`.

### Claiming pull requests (`kind: pull_requests`)

`github_issues.kind: pull_requests` flips the poll to the repo's **open pull requests** carrying the
belt's trigger label. Use it to review a PR that has no ticket behind it (one an outside agent
opened, say). The opt-in is per **source**, not per belt — a source claims issues or PRs, never
both; to do both, declare two sources over the same repo with different `name`s.

```yaml
work_sources:
  - type: github_issues
    name: gh-prs
    github_issues:
      repo: my-org/my-app
      kind: pull_requests

belt:
  - name: review-gh
    source: gh-prs
    label: hf-review              # label a PR `hf-review` → the factory reviews it
    # No `pr` step ⇒ nothing produces a pull request, and `in_review` is the produce(pull_request)
    # effect — so a review belt must ask for it, or the PR never wears `herdr:in-review`.
    effects: [{ on: enter, step: review, to: in_review }]
    steps:
      - type: custom
        name: checkout            # `gh pr checkout @@KEY@@`, then `set-branch` so the engine follows
        prompt_file: prompts/pr-checkout.md
        produces: [commits]     # the checkout is what puts the PR's commits in the worktree
      - type: review
```

Identical to issues: the trigger label is consumed on claim, `herdr:in-development` /
`herdr:in-review` / `herdr:aborted` land on the PR, `claim_guard` works across hosts, notes and
ask-human questions are PR comments (a PR's comments *are* issue comments), gone-ness maps the same
way. Three differences:

| | issues | `kind: pull_requests` |
|---|---|---|
| `close_on` | closes the item per `merged`/`done`/`aborted` | **never applies** — closing/merging stays the operator's; a terminal transition only strips state labels |
| `task.md` header | `# Issue #<n>: <title>` | `# Pull request #<n>: <title>` |
| work-doc bullets | `Closing reference: Fixes #<n>` | `Head branch` / `Base branch` / `Draft` / ``Checkout: `gh pr checkout <n>` `` (best-effort: if `GET /pulls/<n>` fails, only the `Checkout` line is written and `github_issues: could not read the branches of pull request #<n> — the work doc omits them` is logged) |

`in_review` needs an **effect** on a review belt: it is the engine's `produce(pull_request)` effect, and a belt with no `pr` step produces no pull request — so without `effects: [{ on: enter, step: review, to: in_review }]` the PR goes straight from `herdr:in-development` to terminal, never wearing `herdr:in-review`.

Also: `health` no longer requires the repo's Issues tab (`has_issues: false` is fine), and its
missing-label error reads `… and add it to pull requests you want worked`. `describe` on the wrong
kind throws `github_issues: #<n> is an issue, not a pull request` (or the reverse on a default
source); a transition that finds the wrong kind returns `stale` with `#<n> is an issue` / `… is a
pull request`. The item's `type` comes from `type_labels`/`default_type` only — a PR has no native
GitHub issue type — so it drives the same branch prefix, which the checkout step then replaces via
`set-branch`.

---

## `local_markdown`

### Config block

```yaml
- type: local_markdown
  name: briefs
  local_markdown:
    folder: ~/dev/work-items    # REQUIRED — a directory of *.md briefs; ~, $HOME and ${HOME} expand
```

The only field. Errors: ``set `local_markdown.folder` to a directory of *.md task briefs (~ and $HOME expand)`` / `` `local_markdown.folder` cannot be empty``. This block is the one that is **not** strict — a mistyped extra key under `local_markdown:` is silently dropped rather than rejected.

### Credentials

None. `auth status` prints `<name> (local_markdown): no authentication required`.

### What makes an item eligible

Pure filesystem, no network. `readdirSync(folder)` — **top level only, non-recursive**. An item is either:

- a top-level `<key>.md` file → key = the filename without `.md`, or
- a top-level directory containing at least one top-level `*.md` → key = the directory name. Markdown nested deeper does not qualify a directory.

A `<key>.md` file always wins a collision with a `<key>/` directory. Then:

| rule | effect |
|---|---|
| name starts with `.` or `__` | skipped — `.notes.md`, `__draft.md` are invisible by design |
| key not matching `[A-Za-z0-9._-]+` | skipped with `local_markdown: skipping "<name>" — rename it to [A-Za-z0-9._-]+ to make it claimable` (so filenames with spaces or `#` never claim) |
| ledger says the item is not `todo` | skipped — the internal ledger, not the file, decides |
| an active run exists for the key | skipped |
| ordering | `names.sort()`, lexicographic |

**To get one brief picked up:** drop `my-task.md` (safe characters only, no leading `.`/`__`) at the top level of `folder`, and make sure the ledger has no non-`todo` row for that key. Missing folder ⇒ zero items, no error (doctor's `health()` is what flags it).

Title/type: front-matter `title` → first `#` heading (fenced code blocks skipped) → the key humanized (`-`/`_` → spaces). Type = front-matter `type`, default `task` (⇒ `chore/` branch prefix). Front-matter is only honored when the leading `---` block parses to a plain **object** — malformed YAML, a bare `---` thematic break, or a YAML array all cause the block to be ignored silently (body kept whole). Front-matter `labels:` (strings only) flows into the match item for belt `match` predicates — belts on this source still must not set `label`.

### Lifecycle (internal ledger)

`statusOfRecord: internal`, all six states mapped. Transitions are a tolerant idempotent upsert of the `work_items` row (`(repo, source, key)` unique; status one of `todo`, `in_development`, `in_review`, `merged`, `aborted`, `done`); `stale` is never returned. **The folder is never modified for lifecycle** — your briefs are not edited, moved, or deleted.

The only writes into the folder are the human channel, in `<folder>/.herdr-factory-human/` (dot-prefixed, so pickup skips it):

- question: `<key>-q<questionId>.md`, containing `# Human question for <key>`, `Run:`/`Step:` lines, `## Question`, then `## Answer` with the placeholder `_Write the answer below this line. herdr-factory resumes automatically once this section is non-empty._`
- notes: appended to `<key>-notes.md`. Since the error-routing change this file only receives the rare informational note (e.g. the moot-question closer) — error reports go to the run's own agent pane instead, because a hidden notes file is where nobody looks.

Reply detection reads the question file, finds the literal `## Answer` heading, strips the italic placeholder and trims. Empty ⇒ still waiting. **Deleting the `## Answer` heading makes the run wait forever.**

### Materialized files

- directory item → the whole tree is copied to `.memory/herdr-factory/task/` (guarded on `task/` existing); `@@WORK_DOC@@` = `task/`, kind `directory of markdown files`. For a directory, title/type/labels come from its primary md (`README.md` case-insensitively, else the first `*.md` alphabetically).
- file item → snapshot to `.memory/herdr-factory/task.md`; `@@WORK_DOC@@` = `task.md`, kind `markdown file`.
- source gone at materialize time → a placeholder `task.md` (`_(source markdown for "<key>" was not found at materialize time)_`) plus warn `<key>: local_markdown source not found (looked for <path>)`.

This is the only source whose work doc shape is decided by stat'ing the worktree.

### Polling and rate limits

No network, no buckets, no timeouts — nothing to spare. `poll_interval_seconds` still gates the scan; leaving it at the tick default is fine.

### Failure modes

| symptom | cause | fix |
|---|---|---|
| `local_markdown folder does not exist: <folder>` (doctor) | wrong path, or `~` not expanded by your shell into the YAML | use `~/…` or an absolute path in the config; the factory expands `~`, `$HOME`, `${HOME}` |
| `local_markdown folder is not a directory: <folder>` | path points at a file | fix `folder` |
| nothing picked up, no log at all | empty folder, or every candidate is dot/`__`-prefixed | rename to publish |
| `local_markdown: skipping "<name>" — rename it to [A-Za-z0-9._-]+ …` | spaces or punctuation in the filename | rename the file |
| wrong title on the run | front-matter didn't parse (so the first `#` heading won) | fix the YAML between the `---` fences |
| an edited brief is never re-picked | the ledger row moved past `todo` | claim it explicitly (below) |
| a nested brief is ignored | only the top level is scanned | move it up, or give its directory a top-level `*.md` |

### Commonly misconfigured (local_markdown)

1. **Re-running an item is a ledger operation, not a file operation.** Once `work_items.status` is not `todo`, editing or touching the file changes nothing. `herdr-factory --repo <r> claim <key> [--belt <b>]` bypasses eligibility entirely (it only checks for an active run and resolves the key), so that is the way to force a re-run. No CLI command resets a ledger row to `todo`.
2. Dot- and `__`-prefixed names are invisible on purpose — use `__` as your "still drafting" marker.
3. One `folder` may feed several repos/sources; the ledger is keyed `(repo, source, key)`, so the same brief is claimed once **per (repo, source) pair**.
4. Belts on this source must omit `label`.
5. Custom belt-effect statuses are rejected at load for this source (a new state would need a `work_items` schema migration).

---

## `sentry`

### Config block

```yaml
- type: sentry
  name: sentry
  poll_interval_seconds: 300      # strongly recommended — Sentry rate-limits REST polling
  sentry:
    base_url: https://sentry.io   # optional; default https://sentry.io; must be http(s); trailing slashes stripped
    organization: my-org          # REQUIRED — org slug (as in the URL) or numeric id
    projects: []                  # default [] = every project the token can see (project=-1) — a LIST
    environment: []               # default [] = all environments — a LIST
    query: "is:unresolved"        # default "is:unresolved" — any Sentry issue-search string
    stats_period: 14d             # default "14d"; must match ^\d+[smhdw]$
    on_merge: comment             # default "comment"; comment | none | resolve | resolve_in_next_release
```

Errors: ``set `sentry.organization` to your Sentry org slug (or numeric id)``; `base_url must be an http(s) URL`; ``a period like "14d" / "24h" / "1w"``. One source = one filter — for a different filter, add another sentry source.

### Credentials

`SENTRY_AUTH_TOKEN` — required, masked. Get it from Settings → Developer Settings (an Internal Integration token) or User Settings → Personal Tokens. Scopes: **`event:read` to poll, `event:write` to comment/update**. Sent as `Authorization: Bearer <token>`; there is no OAuth.

Missing ⇒ paused with `set SENTRY_AUTH_TOKEN in the repo env (a Sentry Internal Integration or personal token with event:read + event:write)`. Rejections are scope-aware:

- 403 ⇒ `Sentry rejected the token (HTTP 403) — the token lacks the required scope (event:read to poll, event:write to comment/update). Recreate SENTRY_AUTH_TOKEN with Issue & Event read+write.`
- 401 ⇒ `Sentry rejected the token (HTTP 401) — check SENTRY_AUTH_TOKEN in the repo env (an Internal Integration or personal token).`

### What makes an item eligible

```
GET <base_url>/api/0/organizations/<organization>/issues/
    ?query=<query>&statsPeriod=<stats_period>&limit=100
    [&project=<numeric id> …  |  &project=-1]  [&environment=<env> …]
```

The **org** endpoint is used deliberately: the project-scoped one rejects any `statsPeriod` other than `24h`/`14d`. One page of 100, no pagination. Configured project *slugs* are resolved to numeric ids once per process; an unresolvable slug is skipped with `sentry: project "<slug>" not found in <org> — skipping it this poll`, and if *every* configured project is unresolvable the poll returns nothing. `environment` is an event/query parameter, not an issue field — it filters at poll time (and on the latest-event fetch) and never appears on the item.

Then the source filters:

1. the issue id must match `[A-Za-z0-9._-]+` (otherwise `sentry: skipping issue with unusable id "<key>" (<shortId>)`);
2. the internal ledger must say `todo` — anything else is suppressed;
3. **release-regression reopen** is the one exception: an item at `merged` or `done` (never `in_development`/`in_review`/`aborted`) is reset to `todo` when the issue's current release differs from the release recorded when it was fixed, or when Sentry marks it `substatus: regressed` and no baseline was recorded. The list payload omits the release, so at most 20 detail probes per poll are spent on regressed issues; the overflow logs `sentry: N more regressed issue(s) not release-checked this poll (probe cap 20) — retried next poll`. Reopen logs `sentry: reopening <shortId> — recurred on release <current> (last fixed on <prior>)` and **resets** the ledger row rather than deleting it;
4. no active run for the key.

**To get one error picked up:** make sure it matches `query` (default `is:unresolved`), has activity inside `stats_period`, belongs to one of `projects` (or leave `projects: []`), and has no non-`todo` ledger row. `herdr-factory claim <key>` accepts either the numeric id or a short id like `BACKEND-1AB` and bypasses the eligibility filter.

Item type: `Performance` for a performance issue, otherwise `Bug` (⇒ `fix/` branch prefix; `Performance` falls through to `feature/`). `labels` is always `[]` — Sentry has no labels, so route with `match`/`priority`.

### Lifecycle (internal ledger + one optional write-back)

`statusOfRecord: internal`, all six states mapped, `stale` never returned. Sentry issues are **never moved for state**. The only outbound state write is on `merged`, and only when `on_merge` is not `none` — and it is best-effort, wrapped so a failure only logs `<key>: Sentry on_merge write-back failed (best-effort): <msg>`.

| `on_merge` | what it does on merge |
|---|---|
| `comment` (default) | posts a note `[herdr-factory] Fixed by <PR url> (merged by herdr-factory).`, after scanning existing notes for the `[herdr-factory] Fixed by` prefix |
| `resolve` | `PUT` the issue to `status: resolved` |
| `resolve_in_next_release` | `PUT` the issue to `status: resolvedInNextRelease` |
| `none` | nothing — a fully read-only Sentry integration |

The PR reference is only available while the run still has a PR number, so the note falls back to `PR #<n>` or `a merged pull request`.

Human loop uses Sentry **notes** (`/organizations/<org>/issues/<id>/comments/`, an internal-but-stable endpoint that works on SaaS and self-hosted): notes are `[herdr-factory] <note>`; ask-human's first line is the `[herdr-factory question: …]` marker and it closes with `Reply in a NEW comment on this Sentry issue — herdr-factory resumes automatically when it sees the reply.` Sentry rejects an identical note from the same user within an hour with a 400, which is why ask-human marker-scans first. Replies are ordered ascending and strictly filtered after the question's timestamp; an uncomparable note is dropped rather than treated as a reply. A 404/410 raises a stale-item error (`sentry: issue <key> is gone`).

### Materialized files

- `.memory/herdr-factory/task.md` (guard and `@@WORK_DOC@@`): `# Sentry issue <shortId>: <summary>`, bullets for URL / project / level·status·platform / events·users·unhandled / first seen·last seen / culprit / exception / location; a fixed `## What to do` section ("Reproduce the failure from the stacktrace below, find the root cause, and fix it. Add a regression test where practical."); then `## Latest event` with `### Exception` (up to 40 frames, most-recent-first, in-app frames prioritised), `### Breadcrumbs (most recent last)` (20), `### Request`, `### Tags` (25, with environment/release inlined) — or `_(No event payload was available at materialize time …)_`.
- `.memory/herdr-factory/issue.json` — raw `{issue, event}`.
- **No `attachments/`** — sentry materializes no media.

Materialize also **stamps the issue's current release into the ledger** — that is the baseline the regression-reopen compares against. Sanitization here is the strictest of all sources (control/invisible/bidi stripped, backtick runs collapsed, *all* whitespace collapsed to single spaces) because Sentry titles, messages, stacktraces and tags are attacker-influenced and the work agent runs with permissions skipped.

### Polling and rate limits

The most conservative client: 3 req/s sustained, burst 6, 30 s timeout, reads retry 3× and writes once. Sentry's 429 carries `X-Sentry-Rate-Limit-Reset` rather than `Retry-After` and is deliberately not parsed — the bucket keeps usage under budget. Budget per poll: 1 list call, plus one lookup per new project slug, plus up to 20 regression probes; materialize adds 2. **Pair a sentry source with a raised `poll_interval_seconds` (300 is the documented example).**

### Failure modes

| symptom | cause | fix |
|---|---|---|
| `sentry: cannot reach organization "<org>" at <base_url> — bad token or wrong org/base_url (<msg>)` | wrong slug, wrong region host, bad token | use the slug from the Sentry URL; set `base_url` to your region/self-hosted host with a scheme |
| `sentry: project "<slug>" is not reachable in <org> — fix the slug or the token's access (<msg>)` (doctor) | project **slug** vs display name, or no access | copy the slug from the project URL |
| poll silently empty though the project exists | every configured slug unresolvable, or `query`/`stats_period` excludes everything | run `doctor --deep` (it fails hard where the poll only warns); widen `stats_period`, check `query` |
| schema error on `environment: production` | `projects` and `environment` are **lists** | write `environment: [production]` |
| far too much work claimed | `projects: []` means every project the token can see | list the projects explicitly |
| a fixed error is reworked | release regression reopen fired | expected; the release baseline changed or Sentry flagged `regressed` |
| unwanted comments on Sentry issues | `on_merge` defaults to `comment` | set `on_merge: none` |
| load error about a custom status | belt effects can't add statuses for an internal-ledger source | target a canonical state |

### Commonly misconfigured (sentry)

1. `organization` is the **slug** in the URL (or a numeric id), never the display name.
2. `projects` and `environment` are lists; `base_url` must include `http(s)://`.
3. `stats_period` bounds recency of activity — `14d` hides errors that stopped firing.
4. A 403 means the token's **scope**, not a bad token.
5. Belts on this source must omit `label`; route with `match`/`priority`.
6. Raise `poll_interval_seconds`; the default (the tick, 60 s) polls Sentry far harder than it likes.

---

## Several sources in one repo

`work_sources` is a list, and one repo can run all four types at once.

- **Names must be unique on the resolved name.** Give every source an explicit `name` as soon as you have two of the same type — two unnamed `jira` entries both resolve to `"jira"` and fail load.
- **The name is what a belt's `source:` refers to**, and belts pick up per `(source, key)` — so two belts on the same source need distinct labels (label-driven sources) or distinct `match` predicates.
- **Names are effectively append-only.** Every run row records the source name it was claimed from, and that name is how the engine resolves the source again for write-backs and reply polling. Renaming a source strands in-flight runs (their write-backs can no longer be delivered) and, for internal-ledger sources, resets the ledger view (`work_items` is keyed `(repo, source, key)`), so already-worked items become eligible again. Drain the belt before renaming.
- **Fairness.** Each source has its own `max_active_workspaces` (default 2) inside the repo-wide `limits.max_active_workspaces`, so a chatty source can't monopolise the repo's capacity. Each source also has its own poll cadence — pace an API-sensitive source (sentry, a shared Jira board) with `poll_interval_seconds` without slowing the others.
- **Per-source prompt overrides** exist for each type (`prompts/<type>/<step>.md`); see [prompts.md](./prompts.md).

```yaml
work_sources:
  - type: jira
    name: jira-bugs
    poll_interval_seconds: 300
    jira: { base_url: https://acme.atlassian.net, project: PROJ, board: 254 }
  - type: sentry
    name: prod-errors
    poll_interval_seconds: 300
    max_active_workspaces: 1
    sentry: { organization: acme, projects: [backend], query: "is:unresolved is:for_review" }
  - type: local_markdown
    name: briefs
    local_markdown: { folder: ~/dev/work-items }
```

## Several factories on one source (`claim_guard`)

Without it, a source backend must be polled by **one** factory (INV-10): claims are arbitrated by the
factory's local DB, so two factories on different machines watching one board both claim a new item —
two worktrees, two agents, two PRs. Enable the guard on the source in **every** factory that shares it:

```yaml
work_sources:
  - type: github_issues          # or jira; local_markdown / sentry reject the key
    claim_guard:
      enabled: true              # default false
      host: contabo              # default: machine.yml's host_alias, else the hostname (chars outside [A-Za-z0-9._-] become '-'); unique per factory
      settle_ms: 2000            # default 2000; wait between posting the claim and re-reading
    github_issues: {}
```

The protocol, run right after the run row is inserted and before any worktree, agent, or
status write: read the item's comments — if another factory's claim is already open, skip the item
without posting anything; otherwise post `[<brand> claim id=<run> host=<host>]` (`<brand>` =
`source_comments.brand`, default `herdr-factory`), wait
`settle_ms`, and re-read. Among claims with no matching `[<brand> release id=<run> host=<host>]`,
the **lowest comment id** wins (ids are assigned by the server, so every factory agrees). The loser
posts its release, deletes its run row, and logs `claimed elsewhere by <host> (run <id>) — skipping`
(a `claimed_elsewhere` event, recorded once per winner). Teardown posts the winner's release.

Before arbitrating, a factory releases claims **it posted itself** whose run no longer exists in its own DB (crashed, or a teardown whose release post failed) — it is the only authority that can tell those apart from live work, and left open they fence the item against every host. Another host's dead claim is still **never** cleared automatically: free it by posting its release comment by hand.

- **Stuck item, log says `claimed elsewhere by <host> (run <id>) — skipping` every tick**, and that host is gone or never finished: post a comment `[herdr-factory release id=<id> host=<host>]` on the item. Nothing reaps it for you.
- **A release failed to post** logs `could not post claim release (post "[herdr-factory release …]" by hand to free the item)` — do exactly that.
- **Costs:** ~`settle_ms` per claim; claim + release comments on every item (two more per lost race). Jira has no compare-and-set, so the guard relies on monotonic comment ids; the whole comment thread is paged (100 per call), so an old claim comment is never missed.
- **Changing the brand or the host name mid-flight is safe.** The ledger is read brand-agnostically, so a host still on `herdr-factory` fences on a flipped host's `[hf claim …]` line and vice versa; and a host recognises claims it posted under its raw hostname before `machine.yml`'s `host_alias` renamed it — while the release it posts to free one keeps that hostname, so every other host pairs claim and release too. Roll either out host by host; two hosts never both own an item during the switch.
- **Our own stale claims self-heal:** after a crash, the same host releases its old claim on the next tick it sees the item (log: `<KEY>: released our own stale claim (run <id> no longer exists here)`) and claims it afresh. Only claims bearing another host's name need the manual release below.
- The markers carry the herdr marker, so ask-human reply polling never mistakes them for a human answer.
