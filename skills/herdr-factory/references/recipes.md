# Recipes — paste-ready `config.yml` files

Complete, valid per-repo configs for the eight shapes users actually ask for: copy one whole file, edit the marked values, and it loads.

Answers these questions:
- What is the smallest config that actually works?
- What does a Jira board → merged PR config look like, with the status map and the pickup label?
- How do I run Markdown briefs from a folder with no tracker at all?
- How do I build a belt that ends in a filed ticket instead of a PR?
- How do I point a belt at Sentry errors without hammering its API?
- How do evidence + a herdr layout + status effects + a PR policy fit together in one belt?
- How do I insert my own read-only gate step before the PR?
- How do I split one Jira board across two belts?

## Where these files go

| file | path |
|---|---|
| the config | `~/.config/herdr-factory/repos/<name>/config.yml` |
| secrets | `~/.config/herdr-factory/repos/<name>/env` — `KEY=value`, `#` comments, no quoting (a value written `"abc"` keeps its quotes), chmod 600 |
| a step's `prompt_file` | relative to that folder (default `prompt_file_source: config`) |
| a belt's `match` | a `.ts` file relative to that folder |
| repo-wide guidance | `guidelines-prompt.md` in that folder — appended to **every** step prompt of every belt |

`<name>` is the value you pass to `--repo` — a config-folder name, not the git repo name. Keep the first-line modeline; it resolves to `~/.config/herdr-factory/config.schema.json`, written by `herdr-factory init`, `herdr-factory schema`, and `serve` startup. After pasting: `herdr-factory --repo <name> doctor` (add `--deep` to health-check the source), then `herdr-factory --repo <name> run` to ride one batch in the foreground. Load errors print as `invalid config for repo "<name>" (<path>):` followed by one `  <yaml.path>: <message>` line per problem — see [config-reference.md](./config-reference.md) for every rejection.

## 1. Minimum viable — GitHub issues → work · review · pr (start here)

**Use this when** you want the fewest values to supply and no cloud setup: the target repo is on GitHub, `gh` is already logged in, and you don't need visual evidence.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT: the MAIN (non-linked) checkout
  base_ref: origin/main # EDIT if your default branch isn't main

work_sources:
  - type: github_issues
    name: issues
    github_issues: {} # repo to poll defaults to this checkout's git origin

belt:
  - name: issues-to-prs
    source: issues
    label: agent # EDIT: the trigger label issues must carry (required — no default)
    steps:
      - { type: work } # no tab/pane → the factory spawns a dedicated pane per step
      - { type: review }
      - { type: pr }
```

**Edit these**
- `repo.path` — the main checkout that worktrees fork from. A linked worktree is rejected (`looks like a linked worktree`).
- `belt[0].label` — required for `github_issues` (there is no default). The label must already exist in the repo.

**Credentials** — none required. With no `GITHUB_TOKEN` in `env`, the source uses the `gh` CLI login; give each host its own `GITHUB_TOKEN` once more than one polls GitHub (the rate limit is per account). Confirm with `herdr-factory --repo my-repo auth status`.

**First work item**
```sh
gh label create agent; gh issue create --label agent --title "Add a /healthz endpoint" --body "Return 200 with the build sha."
herdr-factory --repo my-repo run
```

Notes: no `layouts:` block means the factory spawns each step's pane itself (`claude --dangerously-skip-permissions`). Adding `{ type: evidence }` here would be **silently skipped** — evidence only exists when it targets a layout pane (recipe 6).

## 2. Jira board → merged PR

**Use this when** Jira is the system of record and a labelled ticket should come back as a merged PR with its status walked along the way.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT
  base_ref: origin/main
  # github: owner/name          # default: derived from the git origin

work_sources:
  - type: jira
    name: jira
    poll_interval_seconds: 180
    jira:
      base_url: https://your-org.atlassian.net # EDIT: the Atlassian site (not api.atlassian.com)
      project: PROJ # EDIT: the project key
      board: "254" # EDIT: the AGILE BOARD ID pickup pulls from — not the project key
      status:
        todo: To Do # EDIT: must match the Jira status name EXACTLY (it goes into JQL verbatim)
        in_development: In Progress
        review: In Review # the key is `review`, NOT `in_review`
        done: Done # opt-in: omit to leave closure to Jira's GitHub integration

belt:
  - name: tickets-to-prs
    source: jira
    label: agent # EDIT: the pickup label — required, no default, case-sensitive in Jira
    workspace_name: "{{semantic_work_prefix}}/{{work_id}}-{{work_slug}}"
    steps:
      - { type: work }
      - { type: review }
      - { type: pr }
```

**Edit these**
- `jira.base_url`, `jira.project`, `jira.board` — all three required; `board` is the Agile board id (a board from another project polls empty forever, with no error).
- `jira.status.*` — the three defaults are `To Do` / `In Progress` / `In Review`. Pickup JQL is `status = "<todo>"`, so a casing mismatch breaks pickup silently.
- `jira.status.done` — **has no default**. Set it to auto-move the ticket when the PR merges; omit it and merge is Jira-silent.
- `belt[0].label`.

**Credentials** — `~/.config/herdr-factory/repos/my-repo/env`:
```
JIRA_EMAIL=you@org.com
JIRA_API_TOKEN=<token from id.atlassian.com → Security → API tokens>
```
API token only — there is no OAuth (the Agile board API can't be reached with an OAuth token). A 401 hint mentioning `auth login` is a stale string; the only auth command is `auth status`.

**First work item**
```sh
# add the label `agent` to a ticket in Jira, then:
herdr-factory --repo my-repo run
# or force one item through, bypassing the label:
herdr-factory --repo my-repo claim PROJ-123 --belt tickets-to-prs
```

Note: a mistyped status key (`in_review:`, `in_developement:`) is **not** an error — Jira's `status` map has a catchall, so the typo becomes a custom belt-effect status while the canonical mapping keeps its default.

## 3. Markdown spike lane

**Use this when** you want to hand the factory work without any ticket ceremony: one `*.md` brief per item in a folder.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT
  base_ref: origin/main

work_sources:
  - type: local_markdown
    name: briefs
    local_markdown:
      folder: ~/dev/my-repo-work-items # EDIT: a folder of *.md briefs (~ and $HOME expand)

belt:
  - name: briefs-to-prs
    source: briefs
    # NO `label:` — local_markdown has no label concept and a label here is rejected
    steps:
      - { type: work }
      - { type: review }
      - { type: pr }
```

**Edit these**
- `local_markdown.folder` — created by you; a missing folder polls empty (doctor flags it). Nothing else: the factory owns status for this source in its own ledger.

**Credentials** — none (`auth status` prints `no authentication required`).

**First work item**
```sh
mkdir -p ~/dev/my-repo-work-items && printf '# Add a /healthz endpoint\n\nReturn 200 with the build sha.\n' > ~/dev/my-repo-work-items/healthz.md
```

Notes: the filename (minus `.md`) is the work key and must match `[A-Za-z0-9._-]+` — spaces make it unclaimable. Names starting `.` or `__` are skipped by design (rename to publish). Only the top level is scanned; a directory counts as one item when it holds a top-level `*.md`. Once an item leaves `todo` in the ledger it is never picked up again, even if you edit the file.

## 4. Idea inbox that files tickets (no PR)

**Use this when** the output is a written proposal or a filed ticket, not code: a belt of `custom` steps that ends when the last step signals step-done.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT
  base_ref: origin/main

work_sources:
  - type: local_markdown
    name: ideas
    local_markdown:
      folder: ~/dev/ideas # EDIT: a folder of *.md idea briefs

belt:
  - name: idea-to-ticket
    source: ideas
    workspace_name: "research/{{work_id}}-{{work_slug}}"
    steps:
      - { type: custom, name: research, prompt_file: prompts/ideas/research.md }
      - { type: custom, name: propose, prompt_file: prompts/ideas/propose.md, budget_seconds: 1800 }
      - { type: custom, name: create_ticket, prompt_file: prompts/ideas/create-ticket.md }
```

**Edit these**
- `local_markdown.folder`.
- The three `prompt_file` paths — every `custom` step **requires** one (it has no built-in prompt), resolved relative to the config folder and validated against the prompt-token contract at load.
- `name:` on each custom step — the default name is the type, so two unnamed `custom` steps collide.

**Files to create** — `~/.config/herdr-factory/repos/my-repo/prompts/ideas/research.md` (and `propose.md`, `create-ticket.md`):
```markdown
# Research — @@KEY@@

You are the **research** step of the **@@BELT@@** belt (steps: @@STEPS@@), working in a dedicated
worktree (`@@WORKTREE@@`) — read the repo's code, CLAUDE.md and skills natively.

## Input
- The idea brief is the @@WORK_DOC_KIND@@: `@@WORK_DOC@@` — read it fully.

## Do
1. Work out what already exists, what's missing, and what the real problem is.
2. Note constraints, risks, open questions, and a rough size.
3. Write NO production code and open nothing — the next step (`propose`) turns this into a proposal.
```
The engine appends the handover scaffold (handoff path, `step-done`, `ask-human`), so the body only states the WHAT. The later steps read `@@HANDOFF_IN@@`. See [prompts.md](./prompts.md) for the full token list.

**Credentials** — none for the source. Whatever the last step needs to file a ticket (an MCP server, a `jira` CLI) is the agent's own tooling in the target repo.

**First work item**
```sh
mkdir -p ~/dev/ideas && printf '# Idea: cache the dashboard query\n\nThe dashboard re-queries on every render.\n' > ~/dev/ideas/dashboard-cache.md
```

Notes: with no `pr` step the belt has no PR watch and no `reviewing` phase — the run tears down `completed` at the last step-done. A `pr:` block on this belt is rejected (`has no step that opens a pull request`). `custom` steps get no built-in heartbeat, so their budget is the only clock: `limits.step_budget_seconds` (3600) unless `budget_seconds` says otherwise.

## 5. Sentry errors → PRs

**Use this when** production errors should become fix PRs. Sentry rate-limits REST polling hard, so this recipe polls slowly and caps concurrency.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT
  base_ref: origin/main

work_sources:
  - type: sentry
    name: sentry
    poll_interval_seconds: 300 # strongly recommended — Sentry throttles REST polling
    max_active_workspaces: 1 # at most one error being worked at a time
    sentry:
      organization: my-org # EDIT: the org SLUG as it appears in URLs (or a numeric id)
      projects: [backend] # EDIT: list of project slugs; [] = every project the token can see
      environment: [production] # a LIST, not a scalar
      query: "is:unresolved level:error"
      stats_period: 7d # recency window: \d+[smhdw]
      on_merge: comment # comment | none | resolve | resolve_in_next_release

belt:
  - name: errors-to-prs
    source: sentry
    # NO `label:` — sentry has no label concept; route with `match`/`priority` instead
    steps:
      - { type: work }
      - { type: review }
      - { type: pr }
```

**Edit these**
- `sentry.organization` — required.
- `sentry.projects` / `sentry.environment` — arrays. `environment: production` (a bare string) fails schema validation.
- `sentry.query` / `stats_period` — the eligibility filter lives on the **source**; for a second filter, add a second `sentry` source with its own name and belt.
- `sentry.on_merge` — default `comment` **does write to Sentry**. Use `none` for a read-only integration.

**Credentials** — `env`:
```
SENTRY_AUTH_TOKEN=<Internal Integration or personal token with event:read + event:write>
```
`base_url` defaults to `https://sentry.io`; set it (with scheme) for `https://us.sentry.io`, `https://de.sentry.io`, or self-hosted.

**First work item**
```sh
herdr-factory --repo my-repo claim BACKEND-1AB   # a shortId or the numeric issue id
```

Notes: an issue that was already fixed reopens by itself when Sentry flags it `regressed` on a new release — the ledger row is reset to `todo`, never deleted. Belt effects targeting a custom status are rejected on sentry (internal ledger, canonical states only).

## 6. Full-fat — evidence + layout + effects + PR policy

**Use this when** you want the whole machine: a two-tab herdr layout with a dev server, an evidence step that captures proof and can bounce, S3 publishing, a Jira status hop on evidence, and PR policy.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT
  base_ref: origin/main

limits:
  max_active_workspaces: 2
  max_capture_attempts: 5 # signalled capture attempts before the evidence step parks

work_sources:
  - type: jira
    name: jira
    poll_interval_seconds: 180
    jira:
      base_url: https://your-org.atlassian.net # EDIT
      project: PROJ # EDIT
      board: "254" # EDIT
      status:
        todo: To Do
        in_development: In Progress
        review: In Review
        done: Done
        qa: QA Review # EDIT: an EXTRA key a belt effect can target (the value is the Jira status)

belt:
  - name: ship-bugs
    source: jira
    label: agent # EDIT
    priority: 1
    max_bounces: 3
    workspace_name: "{{semantic_work_prefix}}/{{work_id}}-{{work_slug}}"
    default_layout: full-dev
    effects:
      - { on: produce, product: evidence, to: qa, anchor: in_review } # evidence passed → "QA Review"
    pr:
      title: "[{{semantic_work_prefix}}] {{work_id}} {{work_slug}}"
      labels: [needs-review]
      reviewers: [octocat] # EDIT or drop
      automated_round_minutes: 10 # 0 skips the CI/bot round entirely
    steps:
      - { type: work, tab: dev, pane: work }
      - { type: evidence, tab: qa, pane: evidence } # runs ONLY because it targets a pane
      - { type: review, tab: qa, pane: review }
      - { type: pr } # no tab/pane → the factory spawns this one

layouts:
  - id: full-dev
    setup: { command: mise run setup, blocking: true }
    tabs:
      - title: dev
        panes:
          - { title: work, agent: claude, agent_args: [--dangerously-skip-permissions], setup: true } # the work step's agent; also runs setup
          - { title: server, command: mise run dev, split: right, size: "40%" }
      - title: qa
        panes:
          - { title: evidence, agent: claude, agent_args: [--dangerously-skip-permissions] }
          - { title: review, agent: claude, agent_args: [--dangerously-skip-permissions], split: down, size: "50%" }

evidence:
  bucket: my-evidence-bucket # EDIT
  region: us-east-1 # EDIT
  cloudfront_domain: d123abc.cloudfront.net # EDIT: bare host or a full URL
  key_prefix: herdr-factory
```

**Edit these**
- Everything in the `jira` block, plus `belt[0].label`.
- `jira.status.qa` — the effect's `to: qa` is the *key*; it must be declared here or load fails.
- The layout's `setup.command` and the server pane's `command` — your repo's real commands.
- The `evidence` block (bucket/region/cloudfront_domain are required together), or swap it for `publisher: local` / `publisher: command`.
- `pr.reviewers` / `pr.labels` / `pr.title`.

**Credentials** — `env` holds `JIRA_EMAIL` + `JIRA_API_TOKEN` only. **AWS credentials never go in config or env** — the publisher uses the ambient AWS chain (`~/.aws`, `AWS_*`, or an optional `evidence.profile`).

**First work item**
```sh
# label a ticket `agent` in Jira, then:
herdr-factory --repo my-repo run
```

Notes:
- Building layouts needs the factory registered as a herdr plugin (the `worktree.created` hook) — see [layouts.md](./layouts.md).
- A step with `tab`+`pane` **never** gets a factory-spawned pane: the layout pane must start an agent — `agent: <kind>` (herdr starts it as part of the build and waits until it's ready) or a `command` that launches one — and the pair must exist as a *titled* tab + *titled* pane in `default_layout`. Both are checked at config load. Two steps of one belt may not share a pane.
- The **first** step must be one of the targeted ones — that's why `work` carries `tab`/`pane` here. A belt with `default_layout` whose first surviving step has none is a **load error** (at `belt.0.steps.0.pane`): its dedicated pane creates a second tab before the out-of-process layout hook gets its first look, the hook then declines to build (`not a fresh 1-tab/1-pane workspace`), and every later targeted step parks with `layout_wait_timeout`. Give the first step a pane, reorder so a targeted step leads, or drop `default_layout`. From step 2 on, untargeted steps are free — `pr` above gets a dedicated pane and the built layout is untouched.
- Drop the evidence step's `tab`/`pane` and the step vanishes silently — but drop the `produce evidence` effect with it: an effect on a product no surviving step produces is a **load error** (`belt "ship-bugs" effect on producing "evidence" — no step in the belt produces it`). With both removed the belt is work → review → pr. Evidence never blocks otherwise: a capture-cap park is un-parked by a later genuine step-done, and an upload failure notifies rather than parking.

## 7. A bespoke read-only gate before the PR

**Use this when** the pipeline needs your own check — security review, migration audit, licence scan — that may send the work back but must never commit.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT
  base_ref: origin/main

work_sources:
  - type: github_issues
    name: issues
    github_issues: {}

belt:
  - name: gated-issues
    source: issues
    label: agent # EDIT
    steps:
      - { type: work }
      - type: custom
        name: security-review
        prompt_file: prompts/security-review.md
        read_only: true # HEAD movement after this step takes over parks the run
        bounce: true # may send the work back (target resolves to `work`)
        budget_seconds: 1800
      - { type: pr }
```

**Edit these**
- `repo.path`, `belt[0].label`, and `prompt_file` — the prompt file is required and must exist at load.

**File to create** — `~/.config/herdr-factory/repos/my-repo/prompts/security-review.md`:
```markdown
# Security gate — @@KEY@@

You are the **@@STEP@@** step of the **@@BELT@@** belt (steps: @@STEPS@@): a read-only security
gate on branch `@@BRANCH@@` in `@@WORKTREE@@`. You must not edit, stage, or commit anything.

## Input
- The previous step's handoff: `@@HANDOFF_IN@@`.
- The change under review: `git diff origin/main...@@BRANCH@@` (three dots — merge base to HEAD).

## Check
1. Secrets, tokens, or customer data added to the tree or to logs.
2. New or changed authn/authz paths, and any input that reaches SQL, a shell, or a URL fetch.
3. Dependencies added: pinned, and from a source we already trust?

## Verdict
- Clean → say so in your handoff and finish the step.
- Anything unsafe → send the work back to **@@BOUNCE_TARGET@@** with the specific findings, one
  per issue, each naming file and line.
```

**Credentials** — none beyond the `gh` login.

**First work item**
```sh
gh issue create --label agent --title "Accept an API key on /export" --body "Add key auth to the export endpoint."
```

Notes: `read_only` + `bounce` are `custom`-only opt-ins — declaring either on `work`/`review`/`pr`/`evidence` is rejected. A bounce target must be an **earlier** step that consumes rework, and only `work` and `custom` do; resolution picks the *earliest* such step, so in `work → draft(custom) → gate` the gate bounces to `work`. `read_only: true` cannot be combined with `produces: [commits]` or `heartbeat: true`. The gate's park reason on a violation is `read_only_violation`, and a genuine step-done un-parks it.

## 8. Two belts, one Jira board

**Use this when** one board feeds two different pipelines — bugs get the full treatment, chores go straight out.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT
  base_ref: origin/main

work_sources:
  - type: jira
    name: jira
    jira:
      base_url: https://your-org.atlassian.net # EDIT
      project: PROJ # EDIT
      board: "254" # EDIT

belt:
  - name: bugs
    source: jira
    label: agent-bug # EDIT: distinct per belt
    priority: 1 # lower = considered first
    match: match-bugs.ts # narrows further: only bugs/defects
    steps:
      - { type: work }
      - { type: review }
      - { type: pr }

  - name: chores
    source: jira
    label: agent-chore # EDIT: must differ from every other belt on this source
    priority: 2
    max_bounces: 2
    steps:
      - { type: work }
      - { type: pr }
```

**Edit these**
- The `jira` block, and both `label` values — two belts may share a source **only** via distinct labels (identical source+label is rejected as contention).
- `priority` — belts are walked ascending; the first belt whose `match` accepts an item claims it.

**File to create** — `~/.config/herdr-factory/repos/my-repo/match-bugs.ts`:
```ts
// Default-export a (sync or async) function receiving { item, source }: does THIS belt claim it?
// `item` is { sourceType, key, summary, type, labels, fields } (`labels` is always an array,
// `fields` the raw source payload) plus per-source extras — jira: { status }; github_issues:
// { number, repo, state, assignees, author, body }; local_markdown: { path, filename,
// frontMatter, body }; sentry: { shortId, project, status, level, culprit, count, userCount }.
export default function matchBugs({ item }) {
  if (item.sourceType !== "jira") return false;
  return /bug|defect/i.test(item.type) || item.labels.includes("bug");
}
```

**Credentials** — `JIRA_EMAIL` + `JIRA_API_TOKEN` in `env`, as recipe 2.

**First work item**
```sh
# label a ticket `agent-bug` in Jira, then:
herdr-factory --repo my-repo run
```

Notes: `match` narrows *within* a belt's label, it does not widen — a ticket labelled `agent-bug` whose type isn't a bug matches no belt and is simply left. Because `claim` takes `--belt`, a manual claim ignores both the label and the predicate. Set `active: false` on a belt to pause new claims while in-flight runs finish (strict boolean — `"false"` is rejected).

## 9. `review-gh` — review a labelled pull request (no ticket)

**Use this when** a PR lands from somewhere the factory did not open it — an outside agent, a contractor, a bot — and you want the factory to review it on demand. Label the PR, get a review; nothing closes or merges it.

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-repo # EDIT: the MAIN checkout of the repo the PRs are on
  base_ref: origin/main

work_sources:
  - type: github_issues
    name: gh-prs
    github_issues:
      repo: my-org/my-app # EDIT (optional — defaults to this checkout's origin)
      kind: pull_requests # poll PULL REQUESTS carrying the belt's label, not issues

belt:
  - name: review-gh
    source: gh-prs
    label: hf-review # EDIT: label a PR with this and the factory claims it
    # `in_review` is the produce(pull_request) effect, and there is no `pr` step here — ask for it
    # explicitly or the PR never wears `herdr:in-review`.
    effects: [{ on: enter, step: review, to: in_review }]
    steps:
      - type: custom
        name: checkout
        prompt_file: prompts/pr-checkout.md
        produces: [commits] # the checkout is what puts the PR's commits in the worktree — `review` requires them
        budget_seconds: 600
      - { type: review }
```

**Edit these**
- `github_issues.repo` and `belt[0].label` — the label must already exist in the repo (`gh label create hf-review`).
- The checkout prompt — the run starts on a fresh branch off `base_ref`, so step 1 must move the worktree onto the PR's head.

**File to create** — `~/.config/herdr-factory/repos/my-repo/prompts/pr-checkout.md`:
```md
You are in a fresh worktree for pull request **#@@KEY@@** of this repo.
Read `@@WORK_DOC@@` — it carries the PR's title, body, every comment, and its `Head branch`.

1. Run `gh pr checkout @@KEY@@` in this worktree.
2. Tell the engine which branch you are on now:
   `herdr-factory --repo my-repo set-branch @@KEY@@ <the head branch> --source gh-prs`
3. Write what you checked out to `@@HANDOFF_OUT@@`, then run
   `herdr-factory --repo my-repo step-done @@KEY@@ checkout --source gh-prs --pass 1`.
```

**Credentials** — none required beyond an authenticated `gh` (or `GITHUB_TOKEN`) with write access to the repo: the run adds/removes labels and posts comments on the PR. On GitHub Enterprise Server also set `GITHUB_API_URL=https://ghe.example.com/api/v3` in the same `env` file.

**First work item**
```sh
gh pr edit 412 --add-label hf-review
herdr-factory --repo my-repo run
```

Notes: claiming **consumes** `hf-review` (re-add it to re-review) and swaps in `herdr:in-development`, then `herdr:in-review`; a failed run leaves the PR open wearing `herdr:aborted`. `close_on` is ignored for a PR — the factory never closes or merges one. No `pr` step here (there is already a PR); the review's findings land wherever your `review` prompt posts them. A source is issues **or** PRs, never both: keep your issue belt on a second `github_issues` source over the same repo with its own `name`.

## Composing your own

Three questions fix a belt's shape:

1. **Where does the work come from, and does that source pick up by label?** `jira` and `github_issues` **require** `belt.label` (no default); `local_markdown` and `sentry` **reject** it — route those with `match` + `priority`. See [work-sources.md](./work-sources.md).
2. **Does the run end in a pull request?** A `pr` step is what gives the belt its PR watch, the `reviewing` phase, and the walk-away-to-merge behaviour; without one, the run tears down `completed` at the last step-done and a `pr:` block is rejected.
3. **Which pane does each step drive?** Omit `tab`/`pane` and the factory spawns a dedicated pane per step (no `layouts:` needed at all). Set both and the step drives a pane your `default_layout` already built with an agent running in it — which is the only way an `evidence` step exists. Mixing the two is allowed, but not in any order: once a belt sets `default_layout`, its **first** step must target a pane (load error otherwise — an untargeted first step's own new tab stops the layout from ever being built), and only later steps may go untargeted.

Then check the dataflow: `evidence`, `review`, and `pr` all require `commits`, which only `work`, `pr`, or a `custom` step with `produces: [commits]`/`heartbeat: true` provides — so a commits producer must come first. A step declaring `bounce` needs an earlier `work` or `custom` step to bounce to. Full composition rules, per-primitive capabilities, and every error text: [belts-and-steps.md](./belts-and-steps.md). Key-by-key reference: [config-reference.md](./config-reference.md). What the target repo itself needs for good results: [target-repo.md](./target-repo.md).
