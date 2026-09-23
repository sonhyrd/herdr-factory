# The fake `gh` CLI

`./gh` is a drop-in, offline stand-in for the GitHub CLI, backed by a JSON file a scenario mutates.
`./state.ts` is the scenario-facing control surface (`GhFake`) over that file and over the argv log
the shim appends on **every** invocation.

There is **no `gh` path override in the engine** — `src/clients/github.ts` constructs
`new GitHubClient()` with the default command name `"gh"` — so the only seam is PATH ordering. The
world's `bin/` must come first on PATH for **both** the resident `serve` and every agent pane; agents
inherit the pane env, so one PATH entry covers both.

```
HF_GH_STATE=/h/<id>/art/gh-state.json     # required — the JSON PR store (read fresh on every call)
HF_GH_LOG=/h/<id>/art/gh-calls.jsonl      # required in practice — the JSONL argv log
```

```ts
import { GhFake, initialGhState } from "../harness/gh-fake/state.ts";

const gh = new GhFake({ statePath, logPath });
gh.write(initialGhState({ repo: "acme/widget", login: "factory-bot" }));   // before serve starts
// … the pr step's agent runs `gh pr create` …
const pr = gh.prForBranch("factory/KEY-1")!;
gh.markReady(pr.number);                     // draft → ready-for-review (releases the handoff gate)
gh.setChecks(pr.number, [{ name: "ci", conclusion: "SUCCESS" }]);
gh.push(pr.number);                          // the head moves to a new commit (a new green)
gh.merge(pr.number);                         // OPEN → MERGED
expect(gh.graphqlCallCount()).toBeLessThanOrEqual(ticks);   // ≤1 batched query per tick
```

A mutation through `GhFake` is visible to the **next** engine tick — the shim re-reads the state file
on every invocation, so nothing needs restarting or reloading.

## State file

```jsonc
{
  "login": "factory-bot",        // what `gh api user --jq .login` prints
  "repo": "acme/widget",         // owner/name, as the engine passes it to --repo
  "nextNumber": 1,               // the number `gh pr create` allocates next
  "prs": {
    "7": {
      "number": 7,
      "state": "OPEN",           // "OPEN" | "MERGED" | "CLOSED" — UPPERCASE, see below
      "url": "https://github.com/acme/widget/pull/7",
      "isDraft": false,          // a draft is adopted but keeps the step-done gate
      "headRefName": "factory/KEY-1",
      "title": "KEY-1: …",
      "body": "…",
      "base": "main",
      "labels": [], "reviewers": [], "assignees": [],
      "threads": [{ "id": "T_a", "isResolved": false }],
      "checks": [{ "name": "build", "conclusion": "SUCCESS", "kind": "CheckRun" }]
    }
  }
}
```

**Case matters.** `state` must be `OPEN`/`MERGED`/`CLOSED` (the engine compares string-equal) and
check verdicts must be UPPERCASE GitHub vocabulary: the engine's failing-check test is
case-**sensitive** — `/FAIL|ERROR|TIMED_OUT|CANCELLED|FAILURE/` against `conclusion ?? state`
(`src/clients/github.ts`). `conclusion: null` = still running. `kind` selects which GraphQL union
member the check renders as: `CheckRun` (default) exposes `name`/`conclusion`, `StatusContext`
exposes `context`/`state` — both engine branches are worth covering.

A PR with an **empty** `checks` array renders `statusCheckRollup: null` in the GraphQL answer, exactly
like GitHub does when a commit has no checks at all.

Writes are atomic (temp file + `rename`) on both sides, and the shim serialises read-modify-write
mutations (`pr create` number allocation, thread resolution) behind a `mkdir` lock next to the state
file — verified with 12 concurrent `pr create`s: no lost updates, no duplicate numbers.

## Call log

One JSONL line per invocation, appended to `$HF_GH_LOG`:

```json
{"ts":1753500000000,"argv":["api","graphql","-f","query=…"],"subcommand":"api graphql","exitCode":0}
```

`subcommand` is a **frozen** vocabulary — the call-budget scenarios assert on it:

| `subcommand` | matches |
|---|---|
| `api graphql` | `gh api graphql …` (batched snapshot, review signature, mutations) |
| `api user` | `gh api user …` |
| `pr list` | `gh pr list …` |
| `pr view` | `gh pr view …` |
| `pr create` | `gh pr create …` |
| `pr checks` | `gh pr checks …` |
| `auth` | `gh auth …` |
| `other` | everything else — including served-but-unclassified verbs (`pr ready`, `api repos/…`) and unrecognised argv |

The line is written **before** any injected sleep, so a call the engine kills at its 60 s exec
timeout still shows up in the log (carrying the exit code it *would* have returned).

## Supported argv shapes

### What the engine itself calls (verified against `src/clients/github.ts`)

| argv | answer |
|---|---|
| `gh api user --jq .login` | the bare login on stdout (no `--jq` ⇒ `{"login":…,"id":…,"type":"User"}`) |
| `gh pr list --repo O/N --head B --state all --json number,state,url,isDraft,createdAt --limit 1` | JSON **array**, newest-first (highest number), filtered by `--head`/`--base`/`--state`, truncated to `--limit`, projected to the requested `--json` fields. Unknown branch ⇒ `[]`, exit 0 |
| `gh pr view N --repo O/N --json number,state,url,isDraft[,createdAt]` | JSON **object**. Unknown N ⇒ exit 1 + `GraphQL: Could not resolve to a PullRequest with the number of N. (repository.pullRequest)` |
| `gh pr view N --repo O/N --json statusCheckRollup` | `{"statusCheckRollup":[…]}` — a flat array of `CheckRun` (`name`,`status`,`conclusion`) / `StatusContext` (`context`,`state`) nodes |
| `gh api graphql -f query=<batch> -F owner=O -F name=N` | the batched snapshot. The aliases are parsed out of the query text (`/pr(\d+): pullRequest\(number: (\d+)\)/g`) and answered as `{"data":{"repository":{"pr<N>":{…}}}}` for exactly the ones asked for |
| `gh api graphql -f query=<signature> -F owner=O -F name=N -F n=P` | `{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[…]}}}}}` |

The batched answer per alias:

```jsonc
{"number":7,"state":"OPEN","url":"…","isDraft":false,
 "reviewThreads":{"nodes":[{"isResolved":false,"comments":{"nodes":[{"id":"T_a"}]}}]},
 "commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
   {"__typename":"CheckRun","name":"build","conclusion":"SUCCESS"}]}}}}]}}
```

A **requested-but-absent** PR is omitted from `repository` and the call exits **1** with an `errors`
array alongside the partial `data` — which is what real `gh` does, and what the engine explicitly
tolerates (`allowFail` + "let absent entries stay absent"). Ditto the single-PR signature query for
an unknown number: `{"data":{"repository":{"pullRequest":null}},"errors":[…]}`, exit 1.

### What an agent (scripted or model-driven) calls

| argv | behaviour |
|---|---|
| `gh pr create --repo O/N --head B --title T --body B\|--body-file F [--draft] [--base B] [--label L]… [--reviewer R]… [--assignee A]…` | allocates `nextNumber`, stores the PR (its `headRefOid` is `refs/heads/B` in cwd's repository when that resolves — the real commit, as on GitHub — else `sha<n>0`), prints the PR **url** on stdout (what real `gh` does). `--label a,b` and repeats both work. No `--head` ⇒ `$HF_GH_HEAD`, else cwd's checked-out branch (worktree-aware). An OPEN PR already on that head ⇒ exit 1, `a pull request for branch "B" into branch "main" already exists:` |
| `gh pr checks N [--json name,state,bucket,link,…]` | rows `name<TAB>bucket<TAB>0s<TAB>url`; gh's exit codes: **0** all pass, **8** any pending, **1** any failure. No checks ⇒ exit 0 + `no checks reported on the 'B' branch` on stderr |
| `gh pr view N` (no `--json`) | a human-ish summary + the url |
| `gh pr ready N` / `merge` / `close` / `reopen` | mutate the stored PR (`isDraft:false` / `MERGED` / `CLOSED` / `OPEN`) and print its url |
| `gh pr edit N [--title/--body/--add-label/--add-reviewer/--add-assignee]` | mutates the stored PR |
| `gh pr comment N …` | accepted (not stored); prints the PR url. Unknown N ⇒ exit 1 |
| `gh pr diff`, `gh pr status` | accepted, empty output, exit 0 |
| `gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"T_a"}) … }'` | marks that thread resolved. Unknown thread id ⇒ exit 1; any other mutation ⇒ `{"data":{}}`, exit 0 |
| `gh auth token` | `$HF_GH_TOKEN` or a fake `gho_…` (this is the call `src/clients/github-issues.ts` makes when `GITHUB_TOKEN` is unset) |
| `gh auth status` | a gh-shaped "Logged in to github.com account `<login>`" block, exit 0 — what `doctor --deep` runs |
| `gh api <path>` | `[]` for a collection-looking read path, else `{}` — enough that a stray agent call cannot crash a run |
| `gh --version` | `gh version 2.63.0 (herdr-factory e2e fake)` |
| anything else | logs, prints `{}`, **exit 0** |

Two deliberately different failure modes:

- **Unrecognised** argv ⇒ `{}` + exit 0. A tier-2 model agent's stray call must never hang or fail a
  run.
- **Recognised but unservable** argv (unknown PR number, duplicate create, unknown thread id, missing
  state file) ⇒ **exit 1** with a `gh`-like stderr message. Silence there would be indistinguishable
  from "no PR exists", because every engine call site wraps `runJson` in `.catch()` — a broken fake
  would read as a legitimately absent PR. Fail loud.

## Failure injection

Two ways in, with the same vocabulary and the same meanings. **Env** (set once, when the world is
built) covers "this whole scenario runs against a broken gh". **State file** — `inject` in the JSON,
written with `GhFake.inject({...})` and cleared with `GhFake.inject(null)` — is the only form a
*running* scenario can change, because the shim's environment was fixed when `serve` spawned it. The
shim re-reads the state file on every invocation, so an `inject()` is visible to the very next call;
env wins over state when both are set.

```ts
w.gh.inject({ sleepMs: 3000, sleepFor: "api graphql" }); // this call gets slow…
await w.factory.tickTimed();
w.gh.inject(null); // …and the next tick is normal again
```

| env | state key | effect |
|---|---|---|
| `HF_GH_FAIL=<subcommand>[,<subcommand>…]` \| `*` | `fail` | every matching call exits 1 with `gh-fake: HF_GH_FAIL injected a failure for "<sub>"` |
| `HF_GH_FAIL_ONCE=<subcommand>[,…]` | `failOnce` | only the **first** matching call fails (an exclusive-create marker file next to the log makes it race-free across concurrent invocations; `GhFake.reset()` clears the markers) |
| `HF_GH_SLEEP_MS=<n>` | `sleepMs` | sleep `n` ms before answering — used to prove the engine's 60 s `DEFAULT_EXEC_TIMEOUT_MS` kills the child rather than wedging the tick |
| `HF_GH_SLEEP=<subcommand>[,…]` | `sleepFor` | scope the sleep to those subcommands (default: all) |
| `HF_GH_TOKEN` | — | what `gh auth token` prints |
| `HF_GH_HEAD` | — | fallback head branch for a `gh pr create` with no `--head` |

Values use the same frozen vocabulary as the log's `subcommand`.

Two engine facts to keep in mind when injecting:

- `GitHubClient.currentLogin()` **memoizes** its result (including `null`) for the life of the
  process. Failing `api user` once poisons the login for that whole `serve`, so scope the injection
  or restart the server.
- `currentLogin()` is the one gh call the client does **not** wrap in `.catch()`, so an
  `ExecTimeoutError` from a sleeping `api user` propagates to its callers. Scope long sleeps
  (`HF_GH_SLEEP=api graphql`) unless that propagation is the thing under test.

## Implementation notes

- `./gh` is **plain JavaScript** with a shebang and no extension: node cannot strip types from an
  extensionless file. It also uses neither `require` nor top-level `await` (only dynamic `import()`),
  so it runs identically whether node decides the file is CommonJS or ESM — verified from a directory
  with no `package.json` and from one declaring `"type":"commonjs"`.
- Node builtins only, no dependencies. The core copies it into the world's `bin/` and `chmod +x`es it.
- The `FAILING` regex is duplicated from `src/clients/github.ts` on purpose: if the engine's
  definition of a failing check changes, the fake must be updated deliberately, and the diff shows up
  here.
