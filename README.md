> [!WARNING]
> **🚧 Under construction — not yet ready for use.** A beta release is coming.
> Use the current version at your own risk.

<div align="center">

# 🏭 herdr-factory

**The autonomous work → pull-request factory.**

Point it at a Jira board, a GitHub repo's issues, a Sentry project's errors, or a folder of task briefs. Walk away.
Merged PRs come out the other end.

[Install](#install) · [Quick start](#quick-start) ·
[Markdown briefs](#markdown-briefs--work-without-a-ticket) ·
[GitHub issues](#github-issues--label-an-issue-get-a-pr) ·
[Sentry errors](#sentry--fix-production-errors) · [The belts](#the-belts) ·
[Highlights](#highlights) · [Agent skill](#the-agent-skill) · [Reference](#reference)

</div>

![The work_to_pull_request belt: work sources drop items onto a conveyor that runs through work, evidence, review and PR stations, through a CI + human-review gate, to merge and teardown](docs/images/belt-work-to-pull-request.svg)

herdr-factory is an autonomous, worktree based, coding-agent factory built on top of [herdr](https://herdr.dev) that fits the workflow your team already has:

- **Plugs into your existing development process.** Jira tickets or GitHub issues in, GitHub
  pull requests out — through your normal CI and code review.
- **Full agent sessions, fully visible.** Every step is a real interactive session in a herdr
  pane — not a hidden sub-agent — so you can watch the work and steer it precisely when needed.
- **Local only.** No data leaves your machine: work queue, run history, logs, and even the
  opt-in telemetry stay on it. (herdr can also host the same factory on a remote machine — same
  guarantees, different hardware.)
- **Opinionated _and_ customizable.** A belt is an ordered pipeline of composable **step primitives**
  (`work`, `evidence`, `review`, `pr`, `custom`); the shipped `work_to_pull_request` template is the
  complete ticket → merged-PR flow, and you compose your own belts from the very same primitives —
  with the pipeline's typed inputs/outputs checked at config-load so a hand-built belt is as reliable
  as the shipped one.
- **Works with all your favourite agent harnesses.** Claude Code, opencode, pi, codex, … — if it
  runs in a terminal pane, the factory can drive it.

## Install

One command, macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh | sh
```

The installer is self-contained and idempotent: it ships everything the factory
itself needs (including its own Node runtime) and keeps it up to date. It also registers the factory
as a herdr plugin so each new worktree gets its [layout](#layouts) built automatically (when `herdr`
is on PATH; otherwise link it later with `herdr plugin link <checkout>`).

**You provide the tools the factory drives** — the same ones you'd use by hand:

| Tool                         | Used for                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| [`herdr`](https://herdr.dev) | worktrees, workspaces, panes, and agent lifecycle — the factory floor (**≥ 0.7.5**; `herdr update`) |
| your agent's CLI             | the workers — `claude`, `opencode`, `pi`, `codex`, … (factory-spawned panes default to `claude`; [configurable](#agent-optional)) |
| `gh` (authenticated)         | PR discovery, CI/review polling                                                                  |
| `git`                        | branch cleanup, heartbeats                                                                       |

The installer finishes by printing this checklist and running `herdr-factory doctor`, so you see
what's still on you (herdr, an agent CLI, `gh auth`) right away — the herdr check also enforces the
**0.7.5** floor (its agent/pane CLI changed there), and `--deep` additionally confirms the running
herdr server speaks a protocol this herdr CLI can talk to. Run `herdr-factory doctor` (or
`doctor --deep`) any time — it checks everything above, plus the supervisor, server, database, and
each repo's config, sources, and evidence bucket.

<details>
<summary>Private repo / custom clone URL / uninstall</summary>

```sh
# clone over a read-only deploy key (writes the key + ssh config for you)
curl -fsSL <url>/install.sh | HERDR_DEPLOY_KEY=~/.ssh/factory_deploy HERDR_SSH_HOST=github.com sh

# override the clone source or branch
curl -fsSL <url>/install.sh | HERDR_REPO_URL=git@github.com:you/herdr-factory.git sh

# uninstall (keeps your config + state; prints how to remove those too)
curl -fsSL <url>/install.sh | sh -s -- --uninstall
```

</details>

## Quick start

The factory ships with a full TUI for configuration and monitoring — run `herdr-factory` with no
arguments to open it (live dashboard · config editor · doctor). Everything below can be done from
there; the steps show the underlying files. Or hand the setup to your coding agent:
`herdr-factory skill install` installs an [agent skill](#the-agent-skill) that runs the whole
interview, validates the result, and can debug the factory later.

### 1. Add your Jira credentials

Per-repo, in `~/.config/herdr-factory/repos/my-app/env` (`chmod 600`) — the folder name is what
you'll pass to `--repo`:

```sh
JIRA_EMAIL=you@org.com
JIRA_API_TOKEN=...          # id.atlassian.com → Security → API tokens
```

(Jira is the walkthrough; a [GitHub Issues source](#github-issues--label-an-issue-get-a-pr)
needs no credentials at all beyond your already-authenticated `gh` CLI — add a `GITHUB_TOKEN`
line to the same file only if you want it to use a dedicated token instead.)

### 2. Point it at a repo and a project

Fastest path — from **inside your project checkout**, let the factory scaffold the config for you:

```sh
cd ~/dev/my-app
herdr-factory init            # writes repos/<dir-name>/config.yml, inferring the repo path + github owner/name
# herdr-factory --repo my-app init --source jira   # name the config folder, pick the source
```

`init` picks a zero-config source by default — `github_issues` when your checkout has a GitHub origin
(auth is your `gh` login, the repo derives from the remote), otherwise `local_markdown`. Pass
`--source jira|github_issues|local_markdown|sentry` to choose; credentialed sources also get a
`chmod 600` `env` scaffold with the keys to fill in. It refuses to clobber an existing config unless
you pass `--force`. Then edit the `EDIT`-marked placeholders and run
`herdr-factory --repo <name> doctor --deep`.

Or write it by hand — `~/.config/herdr-factory/repos/my-app/config.yml`:

```yaml
# yaml-language-server: $schema=../../config.schema.json
repo:
  path: ~/dev/my-app # the main checkout; worktrees fork from origin/main by default

work_sources:
  - type: jira
    jira:
      base_url: https://your-org.atlassian.net
      project: APP
      board: 254 # the Agile board id pickup pulls from (required)
      # status:         (defaults) — todo: To Do · in_development: In Progress · review: In Review
      #                  add `done: <status>` to move the ticket there when the PR merges (opt-in)

belt:
  - name: tickets-to-prs
    source: jira
    label: agent # tickets carrying this label are eligible for this belt (required — no default)
    steps: # the canonical work → review → pr pipeline (add an { type: evidence } step to verify visually)
      - { type: work } # no tab/pane → the factory spawns each step's pane
      - { type: review }
      - { type: pr }
```

Everything else — branch naming, budgets, concurrency — has sensible defaults. The first line is a
modeline: your editor's YAML language server validates the file against the factory's own schema
as you type. (`examples/example-repo/` has a fully annotated config, and running plain
`herdr-factory` opens a TUI with a built-in config editor.)

### 3. Feed it a ticket

Label a ticket `agent`, move it to **To Do**, and walk away. The factory claims it (→ _In
Progress_), spins up a herdr worktree, and runs it through the belt: **work** implements and
commits, **review** gates with fresh eyes (bouncing it back to work with findings if it isn't
right), **pr** pushes, opens the PR (→ _In Review_), and drives CI green — then the factory
watches the PR until it merges and recycles the worktree. The ticket's description, comments, and
image/video attachments are all handed to the agent as its spec.

### 4. Watch it work

```sh
herdr-factory                          # the TUI: live dashboard · config editor · doctor
herdr-factory --repo my-app run --follow # run the factory in the foreground, streaming live progress
herdr-factory --repo my-app status     # what's in flight, at a glance
herdr-factory --repo my-app logs       # tail the dispatcher log
```

`run --follow` is the quickest first taste: it ticks the repo in the foreground and streams the
timeline (claims, step starts/finishes, PRs opened, merges) until you `Ctrl-C` — no background
service required. Once you're happy, `herdr-factory start` installs the supervisor so the factory
keeps running on its own.

## Markdown briefs — work without a ticket

A `local_markdown` source turns any folder of `*.md` files into a work queue: each file (or
subdirectory of files, for multi-file briefs with assets) is one work item, keyed by its name.
Drop a brief in and the factory picks it up on the next tick; the folder itself is never
modified. Two recipes — both can live in the same `config.yml`, alongside the Jira belt:

**An idea inbox that files the Jira tickets for you.** A belt of `custom` steps researches each
idea inside a worktree and creates the tickets — which your `tickets-to-prs` belt then claims and
ships. The factory generates its own work:

```yaml
work_sources:
  - type: local_markdown
    name: ideas
    local_markdown:
      folder: ~/factory/ideas

belt:
  - name: ideas-to-tickets
    source: ideas
    workspace_name: "research/{{work_id}}-{{work_slug}}"
    steps: # each `type: custom` step's prompt_file IS the whole body (the engine adds only a scaffold)
      # prompt_file_source defaults to `config` (this repo's config folder), so a step just names its prompt_file
      - { type: custom, name: research, prompt_file: prompts/research.md }
      - { type: custom, name: propose, prompt_file: prompts/propose.md }
      - { type: custom, name: create_jira_ticket, prompt_file: prompts/create-ticket.md }
```

The step prompts are yours, in `repos/my-app/prompts/`
(`examples/example-repo/prompts/work_generation/` has working ones); the run ends when the last
step signals done — no PR, no CI watch. `echo "Explore dark mode" > ~/factory/ideas/dark-mode.md`
comes back as a researched proposal, filed as tickets on your board.

**A spike lane — brief in, PR out, no ticket ceremony.** The same `work_to_pull_request` belt,
fed from a folder:

```yaml
work_sources:
  - type: local_markdown
    name: spikes
    local_markdown:
      folder: ~/factory/spikes

belt:
  - name: spikes-to-prs
    source: spikes
    workspace_name: "spike/{{work_id}}-{{work_slug}}"
    steps: [{ type: work }, { type: review }, { type: pr }]
```

```sh
echo "Try virtualizing the results table — does it fix the scroll jank?" > ~/factory/spikes/virtual-table.md
```

The full work → review → pr pipeline runs on the brief and hands you a reviewed PR.

## GitHub issues — label an issue, get a PR

A `github_issues` source turns a repo's own issue tracker into the work queue — no Jira, no
extra credentials (it uses your authenticated `gh` CLI's token unless you set `GITHUB_TOKEN`):

```yaml
work_sources:
  - type: github_issues
    github_issues: {} # all fields optional (repo defaults to the PR repo)

belt:
  - name: issues-to-prs
    source: github_issues
    label: herdr # the trigger label — issues carrying it are eligible (required, no default)
    steps: [{ type: work }, { type: review }, { type: pr }]
```

Label an issue `herdr` (the belt's `label` — its trigger) and the factory claims it — swapping the
label for `herdr:in-development` and **consuming the trigger**, so re-adding `herdr` later is how you
retry a run. The agents get the issue body, the whole comment thread, and any embedded
images/screen-recordings as the spec; the PR carries a `Fixes #n` line so the merge auto-closes
the issue (the factory closes it as completed anyway, as a backstop). A failed run leaves the
issue open, labelled `herdr:aborted`, for retriage; questions and attention notes arrive as
issue comments — reply in a new comment and the run resumes.

## Sentry — fix production errors

A `sentry` source turns a Sentry project's issues (production errors) into the work queue: the
factory polls Sentry on your filter, hands each error's **stacktrace** to an agent, and ships the fix
as a PR. There's **no trigger label** — the config query _is_ the filter, and belts route by
[`match`/priority](#multiple-belts) (like a `local_markdown` source):

```yaml
work_sources:
  - type: sentry
    poll_interval_seconds: 300 # Sentry rate-limits API polling — poll slower than the tick
    sentry:
      organization: my-org # the org slug (or numeric id)
      projects: [backend, web] # project slugs; omit for every project the token can see
      environment: [production] # environment names; omit for all environments
      query: "is:unresolved level:error" # any Sentry issue search (default: is:unresolved)
      # base_url: https://sentry.io          # or a region host (us./de.sentry.io) / self-hosted URL
      # on_merge: comment                     # comment (default) | resolve | resolve_in_next_release | none

belt:
  - name: errors-to-prs
    source: sentry
    steps: [{ type: work }, { type: review }, { type: pr }] # no `label` — sentry has no label concept
```

Credentials are a single token in the repo's `env` (`chmod 600`):

```sh
SENTRY_AUTH_TOKEN=...   # a Sentry Internal Integration token (Settings → Developer Settings,
                        # Issue & Event: read + write), or a personal token with event:read + event:write
```

The agents get a materialized `task.md` — the error's title, culprit, level, event/user counts, and
the **latest event's stacktrace, breadcrumbs and request** (plus the raw payload in `issue.json`) — so
the work agent fixes from a real stack trace. Lifecycle is tracked **internally** (herdr-factory's own
DB, exactly like `local_markdown`): the factory reads Sentry but **never changes an issue's status**.
The one optional Sentry-side write is a courtesy note on the issue linking the merged PR (`on_merge:
comment`, the default); set `on_merge` to `resolve` / `resolve_in_next_release` to move the Sentry
issue's status on merge instead, or `none` to leave Sentry entirely untouched. (OAuth isn't wired yet
— a Bearer token only.)

## The belts

A **belt** pairs a work source with an ordered pipeline of **step primitives** listed in `steps[]`.
Five ship — `work`, `evidence`, `review`, `pr`, and the generic `custom` — each declaring its typed
inputs/outputs, its watchdogs, and how it can hand work back. A belt's lifecycle is **derived** from
what its steps declare: it gets the terminal PR watch because a step produces a pull request, the
bounce cap because a step declares a bounce, the `in_review` status write-back because the PR is
opened. There is no `belt_type` — the same primitives compose the shipped pipeline below and any belt
you build, and the composition is checked at config-load (a step whose input nothing upstream produces
is rejected).

### `work_to_pull_request` — feed it a ticket, get a merged PR

Pictured at the top. The canonical belt is `steps: [{ type: work }, { type: evidence }, { type:
review }, { type: pr }]` — the engine ships each primitive's prompt:

- **work** — implements the change and commits as it goes (a commit-HEAD heartbeat catches stalls),
  following the target repo's own guidelines/skills for setup, patterns, and how its tests are run
  (see [Prompts](#prompts)).
- **evidence** _(opt-in)_ — derives a test plan from the work item's acceptance criteria, then films
  the running app to prove each one. Its "step zero" is to go and read the repo's own guidance before
  starting the app — its agent instructions, its skill/command directories (read by path, symlinks
  followed, `references/` included), and its gitignored local memory (where dev-server URLs, browser
  sessions and test credentials usually live) — and to run the repo's own helpers rather than
  improvise. Signing in is treated as part of the setup: an SSO/identity-provider redirect with MFA is
  expected, the repo's login helper and session are preferred over a hand-rolled flow, and a login it
  genuinely cannot complete goes to **ask-human** rather than bouncing the work. It follows the repo's
  own skills/runbooks for the dev-server
  workflow **and** the login/test account so it exercises the flow as the right persona, drives
  `playwright-cli` for before/after screenshots and video, publishes the captures via the configured
  [`evidence.publisher`](#evidence-optional-repo-wide) (S3, the local server, or a custom command),
  and records a per-criterion verdict table (with the public URLs) in its handoff. If the evidence
  doesn't prove a criterion it **bounces the run back to work** with findings. A flaky app that keeps
  re-capturing past `max_capture_attempts` parks for attention — but only as a backstop against a
  stuck agent: if the parked step then genuinely reaches a terminal — `step-done`, or a bounce back
  to work — the run un-parks and follows it (evidence is non-gating — the cap never vetoes a
  completed verdict, pass or fail). This station runs only when
  the belt's layout provides its pane (`tab` + `pane` in config; see [Layouts](#layouts)) — without one the belt is simply
  work → review → pr.
- **review** — a strict read-only gate with fresh eyes, judging against the repo's own review
  standards (its checklist / review skill / engineering docs) when it has them: it never edits or
  commits (if it commits, the run parks — read-only is enforced), it either passes the work forward
  or **bounces back to work**. Keeping all rework in the work step is deliberate.
- **pr** — pushes the branch, opens the PR with the evidence URLs embedded, and drives the
  automated round (CI green, bot comments addressed).

The run then enters the **reviewing watch**: one batched GitHub GraphQL query per tick covers
every watched PR, and whenever the review signature changes — new unresolved threads, newly
failing checks — a resolver agent is woken in the worktree to address them. The watch has **no time
limit** — it rides until the PR merges or closes, however long review takes — and it holds a
[`max_active_workspaces`](#limits-all-optional) slot **only while a resolver is actively working**,
so an idle PR-in-review never starves the belt of new claims. Merge → teardown (worktree removed,
every local branch the run created deleted — the name it was claimed under and any name it was
renamed to; re-claiming the same ticket later gets a fresh worktree and a fresh PR). Closed
without merge → parked for [attention](#highlights).

Bounces are per-target-step counted; past `max_bounces` (default 6, per-belt override, `0`
disables bouncing) the run parks for attention instead of oscillating. Each station's engine
prompt can be augmented with your own `prompt_file` — see [Prompts](#prompts).

### `custom` steps — your own stations

![A belt of custom steps: a match router claims items onto a conveyor of user-defined stations, each holding its own prompt file, with an ask-human cord above; the last station stamps step-done and the run ends with teardown](docs/images/belt-custom.svg)

A belt whose steps are all `type: custom` is fully agent-driven — e.g. `research → propose →
create_jira_ticket`. Each custom step's `prompt_file` **is** the whole step body; the engine adds
only a handover scaffold (where you are in the belt, the prior step's handoff, how to signal done or
ask a human). With no step producing a pull request, the run has no PR machinery or CI watch and
ends when the **last** step signals `step-done`. Per step you can set `budget_seconds` and a
`heartbeat` (both off/default-safe), and the same worktree, handoff, bounce, and ask-human machinery
that the shipped primitives use applies — mix `custom` steps with `work`/`review`/`pr` freely, the
config-load dataflow check keeps the composition honest.

**Build your own gates.** A `custom` step ref can declare capabilities from a small allow-list, so
you can stand up a bespoke review-like gate ("security review", "docs check", "QA script") or a
code-writing station without forking the engine:

| Declaration | Effect |
|---|---|
| `consumes: [commits]` | Place the step after a code-writing step and receive its context (a **required** input — a step earlier in the belt must produce commits). |
| `produces: [commits]` | A code-writing custom station (makes `heartbeat` meaningful). |
| `read_only: true` | A gate that never edits or commits — **enforced** exactly like `review`/`evidence` (if the branch HEAD moves, the run parks). Mutually exclusive with `produces: [commits]`. |
| `bounce: true` | The step may send the work back to the earliest earlier step that accepts rework (counts toward `max_bounces`). |

So `[work, { type: custom, name: security-review, read_only: true, bounce: true, prompt_file: … }, pr]`
behaves like a bespoke review station: read-only enforced, its bounce counted and capped, and the
bounce/ask-human wiring rendered into its prompt. Producing a `pull_request` or `evidence` from a
custom step stays out of scope (those drag heavy engine machinery — use the `pr`/`evidence`
primitives). Every declaration is checked at config-load: a `bounce: true` with no earlier step to
bounce to, a `consumes: [commits]` with nothing upstream producing them, or `read_only` +
`produces: [commits]` are all rejected with a clear error.

### Multiple belts

A repo runs **as many belts as you like, all ticking in parallel** — several belts on the same
source, belts across different sources, a shipped `work → review → pr` pipeline and a belt of your
own `custom` steps side by side. A belt can even **generate work for another belt**: below, a belt
of `custom` steps turns a folder of Markdown ideas into Jira tickets, and the `work_to_pull_request`
belt beside it claims and ships them — while a third belt runs experiments from its own Markdown
folder, entirely independently.

![Top-down view of three conveyor belts running in parallel on one factory floor. On the left, a belt of custom steps reads Markdown ideas and runs research → propose → file_ticket to generate Jira tickets; those tickets loop across to the middle belt — a work_to_pull_request belt on the Jira source running work → review → pr to a merged pull request. On the right, a separate belt reads a Markdown experiments folder and runs its own steps. A labelled arrow shows the ticket-generator belt feeding work into the Jira belt.](docs/images/multiple-belts.svg)

When more than one belt draws from the **same** label-driven source, each belt uses a **distinct
`label`** to carve out its own slice of the queue — the factory rejects two belts sharing the same
source _and_ label (they'd contend for the same items). So one Jira project can feed a `bugs` belt
(`label: agent-bug`) and a `chores` belt (`label: agent-chore`) that never overlap.

Within a single label, `match` gives finer-grained routing: belts are walked in `priority` order
(lower first) and the first belt whose `match` predicate accepts an item claims it — **first match
wins**, and a belt with no `match` accepts everything its `label` surfaces. `match` is a `.ts` file
in the repo's config folder whose default export is `(ctx) => boolean` (sync or async), with
`ctx = { item, source: { name, type } }` — the item carries `labels` uniformly plus source-native
routing metadata (Jira's status + raw fields, a GitHub issue's number/author/body, a markdown
brief's front-matter). Route bugs to one belt and stories to another, programmatically.

## Highlights

- **Zero tokens on the factory floor.** Polling Jira, GitHub or Sentry, claiming, watching PRs,
  liveness checks, retries — all deterministic code (native `fetch`, `gh`, `herdr`). Agents run only inside
  the steps, and the PR resolver wakes only when the review state actually changes.
- **The ask-human cord.** A blocked or unsure agent runs `ask-human`: the factory posts the
  question through the work source (a Jira or GitHub issue comment, or an inbox file for
  markdown sources), parks
  the run as `waiting_for_human` — **freeing its concurrency slot** — polls for the reply every
  30 seconds, then writes the answer into the worktree and resumes the same step automatically.
  The wait is never a trap: an agent that gets past the blocker on its own and signals `step-done`
  (or bounces the work back) un-parks the run and moves the belt on, closing the now-moot question
  with a note on the ticket so nobody answers into the void.
- **Bounce-back rework.** Evidence and review send flawed work _backward_ with written findings
  instead of patching around it; the work agent re-runs against the feedback file. The
  `max_bounces` backstop keeps a disagreement loop from running forever.
- **Attention is a workflow, not a dead end.** When something needs a person — budget exceeded,
  stalled commits, a closed PR, a pane that never appeared — the run parks: desktop notification,
  the pane relabelled `⚠ ATTENTION`, the reason (with ready-made resume + triage commands) reported
  **where it belongs** — a *mechanical* failure (a factory watchdog, a login, evidence gathering)
  is reported into the run's own agent pane, while an error about the *designated work itself* (the
  rework loop hit its bounce cap, a human closed the PR) is posted on the work item (for
  `local_markdown`, whose notes are just files, it goes to the pane too) — and an hourly re-notify
  so it can't go stale silently. `resume <KEY>` puts it right
  back where it was, with fresh clocks — and re-prompts the step's own idle agent, so a step that
  finished but never signalled `step-done` completes on resume instead of quietly re-parking.
  Parked runs keep their worktree but hold no claim slot.
  A layout-pane wait self-heals before it ever needs a person: no pane means no agent (so no
  `step-done` could rescue it), so the engine re-attempts the spawn across a bounded number of
  extra wait windows — auto-un-parking a run already parked that way — and only parks for a human
  once that budget is spent. And no park (or retry, or watch) has to be decoded from logs:
  **`explain <KEY>`** narrates why a run is where it is — the armed clocks, the background
  retries with their next attempt time, and the exact command that would move it — and
  **`triage <KEY>`** opens your own agent CLI on the run, pre-briefed with that diagnosis, when
  you want a conversation instead of a printout.
- **Crash-safe by construction.** All state is on-disk SQLite and the reconciler is idempotent —
  a tick can be killed anywhere and the next one converges. The server is a coordinator, not a
  source of truth: every command falls back to running in-process when it's down, so a worker's
  `step-done` lands even mid-restart. Workers live in herdr and survive factory restarts. Source
  status write-backs **and evidence uploads** are persisted intents, retried in the background
  until the backend confirms — an upload survives an AWS SSO session expiring mid-run (or any
  transient backend outage) instead of shipping a PR with broken evidence links. For the `s3`
  publisher a persistent auth failure pings you to refresh your AWS credentials, and the next tick
  auto-retries the moment they come back — it re-queues due-now (clearing any suspension) instead of
  waiting out the retry clock, so there's nothing to press (and the credential *config* is re-read every attempt, so repointing a
  profile never needs a server restart). One catch worth knowing: the resident server resolves
  credentials from `~/.aws`, so a helper that only exports them into your interactive shell — or
  caches its SSO token somewhere the AWS SDK doesn't read, like [granted](https://granted.dev)'s
  keychain — stays invisible to it however many times you log in. Bridge it with a
  `credential_process` profile:

  ```ini
  # ~/.aws/config — a dedicated profile: with sso_session present, SSO resolves FIRST and wins
  [profile my-app-factory]
  credential_process = granted credential-process --profile my-app
  region = ap-southeast-2
  ```

  …and point `evidence.profile` at it.
- **Built to scale.** Active runs reconcile in parallel under per-run locks; Jira and GitHub
  traffic flows through token buckets (GitHub's is a process-wide budget) with
  `Retry-After`-honoring retries; all watched PRs share one batched
  GraphQL query per tick; claim admission smooths big-backlog cold starts; every subprocess and
  HTTP call is hard-timeout-bounded, with a wedged-tick watchdog behind it all.
- **Self-driving operations.** One resident server ticks every repo; a stateless scheduled
  supervisor restarts it if it's down, wedged, or outdated; auto-update ships new code (and new
  Node runtimes) within ~a minute of a push, draining gracefully before restart.
- **A control room.** Running `herdr-factory` with no arguments opens a full-screen TUI —
  live dashboard, a schema-validated config editor, and doctor. The dashboard is a **kanban board per
  belt**: the belt's steps are the columns, every work item is a card in the column of the step it is
  on, and its state rides on a single icon (`○` ready · `●` working · `◆` in review · `?` waiting on
  you · `⚠` attention · `✓` done) rather than on the color of the whole row. A card also flags work
  whose background job is stuck even when its steps read _done_ — e.g. an evidence step that finished
  but whose media upload is still retrying on expired AWS creds carries an amber `⚠`. The server also
  exposes a local HTTP API (`127.0.0.1:8765`) with an OpenAPI spec at `/doc` and Swagger UI at `/ui`.
- **An agentic interface.** `herdr-factory skill install` gives your coding agent an
  [agent skill](#the-agent-skill) — it runs the config interview for a repo, answers questions about the
  engine, and triages a stuck run from the same source-verified reference the maintainers use. Installed
  as a symlink into the checkout, so auto-update keeps it honest.
- **Observable.** Set `HERDR_FACTORY_TELEMETRY=1` for OpenTelemetry traces and metrics; a local
  Grafana stack ships via `docker-compose.telemetry.yml` (see [`docs/TELEMETRY.md`](docs/TELEMETRY.md)).

---

# Reference

Deep engine internals (reconciler phases, locking, the outbox, rate limits, invariants) live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## How it works

```
launchd / systemd timer ─every 60s─> herdr-factory ensure-up    (stateless one-shot supervisor)
                                          │ auto-update, then (re)start if down / wedged / outdated
                                          ▼
            herdr-factory serve    (one resident process: ticks every repo + HTTP API on 127.0.0.1:8765)
            │ Phase 0: flush pending source status write-backs (the outbox)
            │ Phase A: advance every active run one idempotent step (parallel, per-run locks)
            │ Phase B: claim eligible work — belts in priority order, first match wins, up to the cap
            ▼
todo ─claim─> worktree ─> step₁ → … → stepₙ ─┬─ work_to_pull_request: → reviewing ─merged─> teardown
              one agent per step;             │    (batched PR watch; resolver woken on new comments/CI)
              handoff notes in between        ├─ ask-human → waiting_for_human → same step resumes
                                              └─ custom: last step-done ─────────────────> teardown
```

Ticks are the level-triggered backbone (external polling, watchdogs, self-healing); a worker's
`step-done`/`bounce`/`ask-human` is an edge-triggered nudge that reconciles that run immediately
instead of waiting for the next tick.

## Configuration

Everything repo-specific lives in `~/.config/herdr-factory/repos/<name>/`:

- `config.yml` — the file described below (`<name>` is what you pass to `--repo`).
- `env` — per-source credentials, `chmod 600`: `JIRA_EMAIL` + `JIRA_API_TOKEN` (both required) for a
  `jira` source; `GITHUB_TOKEN` for `github_issues` (optional — without it the factory uses your
  `gh` CLI's token); `SENTRY_AUTH_TOKEN` for a `sentry` source; `local_markdown` needs none.
  Strictly per-repo; there is no global secrets file.
- `guidelines-prompt.md` _(optional)_ — appended to every step prompt of every belt.
- `prompts/` _(optional)_ — `config`-sourced `prompt_file`s referenced by `config.yml`, **and** a
  [prompt pack](#prompts): a file named for a primitive's slug (`work.md`, `review.md`, …) here
  overrides that step's shipped base prompt.
- Any `match` predicates referenced by `config.yml`.

The server discovers every folder under `repos/` that contains a `config.yml`; onboarding a repo
is pure data (`herdr-factory reload` picks it up without a restart).

### `repo`

- `path` — the **main** checkout (not a linked worktree; validated at load). `~`/`$HOME` expand.
- `base_ref` — what worktrees fork from (default `origin/main`).
- `github` — `owner/name` (default: derived from the origin remote).

### `limits` (all optional)

| Key                          | Default | Meaning                                                         |
| ---------------------------- | ------- | --------------------------------------------------------------- |
| `max_active_workspaces`      | 3       | cap on concurrently **worked** workspaces (one per run); parked + idle PR-watch runs hold no slot |
| `attention_renotify_seconds` | 3600    | re-notify cadence for parked runs                               |
| `step_budget_seconds`        | 3600    | fallback per-step budget — used when a step sets no `budget_seconds` and its primitive declares no default (`work` 5400 · `evidence` 2400 · `review` 1800 · `pr` 3600) |
| `stall_seconds`              | 2700    | no new commits for this long → attention (heartbeat steps only) |
| `max_bounces`                | 6       | bounces to any one step before attention; `0` disables bouncing |
| `max_capture_attempts`       | 5       | evidence capture attempts per pass before attention (flaky-capture cap) |
| `tick_interval_seconds`      | 60      | reconcile cadence per repo                                      |
| `source_poll_interval_seconds` | = `tick_interval_seconds` | how often each work source is polled for new work; a per-source `poll_interval_seconds` overrides it. `≤ tick` polls every tick (unchanged); larger drains that source's backlog at `max_claims_per_tick` per **poll window** |
| `reconcile_concurrency`      | 8       | active runs reconciled in parallel per tick                     |
| `max_claims_per_tick`        | 10      | new-claim admission per tick (cold-start smoothing)             |
| `layout_wait_seconds`        | 600     | wait window for a configured pane; an expired window auto-retries ×3, then attention |

### `work_sources` (≥ 1)

Each entry: a `type`, an optional `name` (default = the type; must be unique per repo — belts
reference it), an optional `poll_interval_seconds` (how often this source is polled for new work;
overrides `limits.source_poll_interval_seconds` — handy for a rate-limited board polled slower than
the tick), an optional `max_active_workspaces` (default **2** — the most **worked** workspaces this
source may hold in flight at once, summed across every belt that pulls from it; belts are walked in
priority order and claiming stops once a source hits its cap, so `limits.max_active_workspaces` still
caps the repo total but no single source can monopolize it), and a type block:

- **`jira`** — `base_url`, `project`, a required `board` (the Agile board id, e.g. `254`), and a
  `status` map: `todo` (default `To Do`), `in_development` (default `In Progress`), `review` (default
  `In Review`), and an optional `done` (no default). Pickup is by the **Agile board** endpoint
  (`/rest/agile/1.0/board/<id>/issue`): the board's own saved filter scopes the query, and the ticket
  status + the belt's label narrow it. The label that flags a ticket for pickup is set per **belt**
  (`label` — see [`belt`](#belt--1)), not here. The status of
  record lives in Jira. By default the factory never writes a terminal status — merged/closed is left
  to Jira's GitHub integration. Set `status.done` to opt in: a merged PR then moves the ticket to that
  status at teardown (after the merge, before the worktree is recycled); a closed/abandoned run still
  leaves the ticket untouched. The `status` map also accepts **extra named entries**
  (`status.<key>: <Jira status name>`, e.g. `qa: QA Review`) that a belt's
  [`effects`](#effects--configurable-task-progression) can target by key — how you add columns like
  a QA lane to the ticket's progression. Ticket description, comments, and image/video attachments are
  materialized into the worktree for the agents. Authentication is **API token only** — `JIRA_EMAIL` +
  `JIRA_API_TOKEN` (both required) in the repo's `env` (the Agile board API needs Basic auth, so there
  is no OAuth).

  A source that **isn't authenticated yet** (no credentials) is *paused*, not broken: its claims and
  status write-backs hold, you get one notification, and it resumes automatically the moment it
  authenticates again — so an unauthenticated source never wedges the factory.
  `herdr-factory --repo <name> auth status` shows where each source stands.
- **`local_markdown`** — `folder`: a directory where each top-level `*.md` file _or_ top-level
  subdirectory containing at least one top-level `*.md` is one work item (key = filename stem /
  dir name; names starting `__` are skipped as still-being-drafted). Title/type come from YAML
  front-matter, else the first H1, else the filename. Lifecycle is tracked in the factory's own
  DB — **the folder is never modified**. A file materializes as `task.md`; a directory is copied
  whole as `task/`, so multi-file briefs (spec + assets) work.
- **`github_issues`** — polls a repo's open issues carrying the belt's pickup label (its `label`,
  which acts as the trigger — set per **belt**, see [`belt`](#belt--1)), oldest first; the status of
  record stays on GitHub, projected as labels. Fields (all optional): `repo` (`owner/name`; default
  = the repo PRs are opened against), `state_labels` (`in_development`/`in_review`/`aborted`,
  defaults `herdr:in-development` / `herdr:in-review` / `herdr:aborted`; created on demand — plus
  **extra named entries** `state_labels.<key>: <label>` that a belt's
  [`effects`](#effects--configurable-task-progression) can target, e.g. `qa: herdr:qa`),
  `close_on` (`merged`/`done`/`aborted`, defaults `true`/`true`/`false`), `type_labels` (issue label
  → work type; GitHub's native issue type wins when present) + `default_type` (default `Feature`),
  `max_pages` (pages of 100 per poll, default 1). Lifecycle: claiming swaps in the in-development
  label and **consumes the trigger label** (the belt's `label`) — re-adding it is the retry; success
  strips the state labels and closes the issue as completed (a backstop over the PR's `Fixes #n`
  auto-close — it never reopens); an aborted run leaves the issue **open** with the aborted
  label unless `close_on.aborted` (then closed as not-planned). The issue body, all human
  comments, and embedded images/videos are materialized for the agents; ask-human questions are
  posted as issue comments (reply in a **new** comment).

  ```yaml
  work_sources:
    - type: github_issues
      github_issues:
        repo: my-org/my-app # optional — defaults to the PR repo
  # the trigger label is the belt's `label` (below), not a source field
  ```

- **`sentry`** — polls a Sentry project's issues (production errors) and ships fixes as PRs.
  `organization` (slug or id) + `projects` (slugs; omit for every accessible project) + `environment`
  (a list of names; omit for all) + `query` (any Sentry issue search; default `is:unresolved`) are
  the pickup filter — there is **no trigger label** (the config query IS the filter, so belts route by
  `match`/priority like `local_markdown`; a belt on a `sentry` source must **not** set `label`).
  `base_url` defaults to `https://sentry.io` (region hosts like `us.`/`de.sentry.io` and self-hosted
  URLs work too); `stats_period` (default `14d`, suffix `s/m/h/d/w`) bounds how recently an error must
  have fired to count. Auth is a Bearer token in `env` — `SENTRY_AUTH_TOKEN`, a Sentry **Internal
  Integration** token (Settings → Developer Settings, with Issue & Event read+write) or a personal
  token with `event:read` + `event:write`. **No OAuth yet** (a Bearer token only). Lifecycle is
  tracked **internally** (the factory's own `work_items` ledger, like `local_markdown`) — Sentry
  issues are never moved for state. `on_merge` (default `comment`) posts a note linking the merged PR;
  `resolve` / `resolve_in_next_release` move the Sentry issue's status on merge instead, and `none`
  leaves Sentry untouched. `materialize` writes the error's metadata + the latest event's
  stacktrace/breadcrumbs/request as `task.md` (raw payload in `issue.json`). Because Sentry rate-limits
  API polling, pair a `sentry` source with a higher `poll_interval_seconds`.

### `belt` (≥ 1)

Common fields: `name` (unique), `source` (a `work_sources` name), `label` (the pickup
label — the tag the factory looks for to claim this belt's work; **required** for a belt on a
label-driven source — `jira` / `github_issues` — with **no default**, and omitted for a source with
no label concept — `local_markdown` / `sentry`), `priority` (default 100, lower = matched first),
`active` (default `true`; set `false` to **temporarily pause** a belt — it then takes on no new work,
while any of its in-flight runs progress to completion as usual; the flag only gates new claims, so
it's a delete-free way to disable a belt), optional
`match` (see [Multiple belts](#multiple-belts)), optional `max_bounces` override, and optional
`workspace_name` — the **worktree/workspace** name template (and the branch the worktree starts on),
default `{{semantic_work_prefix}}/{{work_id}}-{{work_full_slug}}`. It must contain
`{{work_id}}`; other vars: `{{work_slug}}`, `{{work_full_slug}}`, `{{work_type}}`,
`{{semantic_work_prefix}}`. The prefix taxonomy behind `{{semantic_work_prefix}}` and the slug-length
caps are configurable — see [`branch`](#branch-optional) (defaults: fix/chore/feature, `{{work_slug}}`
≤20, `{{work_full_slug}}` ≤50). A short unique suffix is always appended, so
re-claiming a previously-merged item gets a fresh worktree and PR. This name is the run's
**identity**; the branch can move off it later — see
[Branch names are tracked, not fixed](#branch-names-are-tracked-not-fixed). Optional `default_layout` +
`layout_matching` pick which `layouts` entry (below) the factory builds into this belt's worktrees —
see [Layouts](#layouts). Optional `effects` — configurable task progression onto source statuses
(see [Effects](#effects--configurable-task-progression)).

#### Effects — configurable task progression

By default the factory moves the source item at three points: claim → `in_development`, PR opened →
`in_review`, and (opt-in) merge → your terminal status. A belt's optional **`effects`** list widens
that to **your** progression: map a **trigger** — entering a step, producing a product, or tearing
down with an outcome — to the status the item should move to. Omit the block and the defaults are
unchanged.

```yaml
work_sources:
  - type: jira
    jira:
      base_url: https://your-org.atlassian.net
      project: APP
      board: 254
      status:
        # the canonical mapping (todo/in_development/review) plus EXTRA named statuses a belt
        # effect can target by key:
        qa: QA Review
        done: Done

belt:
  - name: tickets-to-prs
    source: jira
    label: agent
    effects:
      - { on: produce, product: evidence, to: qa, anchor: in_review } # evidence passed → "QA Review"
      - { on: teardown, outcome: merged, to: done } #                     merged → "Done"
    steps: [{ type: work }, { type: evidence, tab: work, pane: evidence }, { type: review }, { type: pr }]
```

- **`on`** — `enter` (a `step:` you name — the first step is claim time), `produce` (a `product:` —
  `evidence` or `pull_request`), or `teardown` (an `outcome:` — `merged`/`closed`/`abandoned`/`timeout`/`completed`).
- **`to`** — either a **canonical state** (`todo`/`in_development`/`in_review`/`merged`/`done`/`aborted`,
  works on any source) or a **source-native status key** you added to the source's map (a jira
  `status.<key>`, a github_issues `state_labels.<key>`). A custom `to` needs an **`anchor`** — the
  canonical state whose lifecycle position it sits just before — which fixes its ordering.
- Effects are **forward-only**: one that would move the item backward (e.g. a re-run re-entering an
  earlier step) is a no-op, and every effect rides the same durable, retry-safe status outbox as the
  built-in transitions — never fire-and-forget. A trigger maps to exactly one status.
- **Internal-ledger sources** (`local_markdown`, `sentry`) keep the canonical states only in v1;
  a belt effect targeting a *custom* status on them is rejected at config-load with a clear error
  (custom states there would need a database migration). Effects targeting canonical states work on
  every source.

Optional **`branch`** — a per-belt override of the repo-wide [`branch`](#branch-optional) taxonomy
(prefix map + slug caps); each field resolves belt over repo over the defaults.

Optional **`pr`** — belt-level **PR behavior**, applied by the `pr` step when it opens the PR (only
valid on a belt that has a `pr` step — a stray block is rejected at load):

```yaml
belt:
  - name: tickets-to-prs
    source: jira
    label: agent
    pr:
      draft: true # open as a draft PR
      title: "[{{semantic_work_prefix}}] {{work_id}} {{work_slug}}" # same vars as workspace_name (rendered verbatim)
      labels: [needs-review] # applied via `gh` at PR creation (created on demand)
      reviewers: [octocat] # requested reviewers
      assignees: [me] # PR assignees
      automated_round_minutes: 10 # CI/bot polling window the pr step runs; 0 = skip the round entirely
    steps: [{ type: work }, { type: review }, { type: pr }]
```

All fields optional. `title` is a template using the same vars as `workspace_name` (rendered
verbatim — no branch sanitisation). `automated_round_minutes` sizes the CI/bot round the `pr` step
runs after opening (default ~10 min; `0` opens the PR then hands straight to the dispatcher's review
watch). It's delivered as **prompt policy** — the `pr` agent applies it with `gh pr create`, so the
agent stays the single actor and an **absent block leaves the PR flow byte-identical** to before.

**Renaming or deleting a belt** cleans up after itself. A belt's `name` is its identity (each run
records the belt it's on), so the TUI config editor handles the two edits specially on save:
**renaming** a belt migrates all of its runs — in-flight and historical — onto the new name (so
nothing is orphaned and the dashboard/timeline stay coherent); **deleting** a belt is **refused
while it has work in progress** (an error tells you which runs, and the save is reverted so nothing
is lost), and once it's idle the delete purges the belt's run records and cleans up any leftover
worktrees — its event timeline is kept for audit. Editing `config.yml` by hand and running
`herdr-factory reload` enforces the same delete guard (a reload that would drop a belt with live
work is refused, leaving the old config running); rename **via the TUI** to migrate a busy belt's
runs.

**`steps` (≥ 1)** — the ordered pipeline. Each step references a shipped primitive by `type`:

```yaml
steps:
  - type: work # implements + commits; the shipped work→evidence→review→pr template starts here
    tab: work
    pane: agent
    prompt_file: .herdr/work-notes.md # OPTIONAL: augments the engine's built-in work prompt
    prompt_file_source: repo
  - { type: evidence, tab: evidence, pane: agent } # opt-in: runs ONLY when given a tab+pane
  - { type: review, tab: review, pane: agent }
  - { type: pr } # no tab/pane → the factory spawns this pane itself
```

Per step: `type` (`work` | `evidence` | `review` | `pr` | `custom`), optional `name` (defaults to
`type`, unique within the belt), optional `tab`/`pane` (both-or-neither — with them the factory
targets the pane the belt's layout builds (see [Layouts](#layouts)), without them it spawns a
dedicated pane; `evidence` is **skipped**
when it has no tab/pane), optional `budget_seconds` (else the primitive's default — `work` 5400 ·
`evidence` 2400 · `review` 1800 · `pr` 3600 — else `limits.step_budget_seconds`), and `heartbeat`
(commit-stall detection; on for `work`/`pr`, opt-in elsewhere).

**A belt with a `default_layout` must give its FIRST step a `tab`/`pane`.** The claim creates the
worktree and dispatches that step in the same pass, and a dedicated pane is a new herdr tab — which
makes the layout hook decline the build (see [Layouts](#layouts)), leaving every later
layout-targeted step to park. Config-load rejects the shape, naming the offending step and offering
the three fixes (target it, reorder so a layout-targeted step runs first, or drop `default_layout`).
It's the first **surviving** step that counts — an `evidence` step skipped for want of a tab/pane
isn't it — and later steps may omit tab/pane freely, since by then the layout exists.

For `work`/`evidence`/`review`/`pr` the engine ships the prompt and `prompt_file` (with an optional
`prompt_file_source`) _augments_ it — unless you set `prompt_mode: replace`, which makes your
`prompt_file` **own** that step's body outright: the shipped prose is dropped, but the engine still
wraps your prompt with the handover scaffold, your repo guidelines, and token substitution (so a
replacement prompt can still use `@@…@@` tokens). It's the escape hatch for a step you want to drive
entirely yourself while keeping the engine's belt plumbing. A **`custom`** step ships no prompt, so
its `prompt_file` is **required** and is the whole body — that's how you build your own stations:

```yaml
steps:
  - { type: work, tab: work, pane: agent, prompt_file: prompts/work.md, prompt_mode: replace } # own the work prompt
  - { type: custom, name: research, prompt_file: prompts/research.md } # prompt_file_source defaults to `config`
  - { type: custom, name: propose, prompt_file: prompts/propose.md, budget_seconds: 1800 }
```

`prompt_file_source` is optional — it defaults to `config` (the repo's config folder, where custom-step
prompts usually live), so you only set it to pin a prompt to `repo` (read from the target checkout).
`prompt_mode` defaults to `augment`; `replace` is valid only on an engine-prompted step **with** a
`prompt_file` (a `custom` step's prompt is already the whole body — config-load rejects it there).

A `custom` step ref may also declare capabilities — `consumes: [commits]`, `produces: [commits]`,
`read_only: true`, `bounce: true` — to build your own gates and code-writing stations (see
[`custom` steps](#custom-steps--your-own-stations)). These four are legal only on a `custom` step
(a shipped primitive's capabilities are fixed) and are validated by the same config-load dataflow check.

The belt's lifecycle is **derived** from its steps: a `pr` step (which produces a pull request) gives
it the terminal PR watch + the `in_review` write-back; an `evidence`/`review` step gives it a bounce
back to `work`. The composition is validated at config-load — a belt whose step needs an input no
earlier step or the source produces (e.g. `review` with no upstream `work`) is rejected with a clear
error. `evidence` and `review` are **read-only** (enforced: if one commits, the run parks).

### `evidence` (optional, repo-wide)

Where the evidence station publishes captures — omit the block and it still captures, assesses,
and can bounce; it just publishes nothing. The backend is a **seam**, selected by `publisher`
(default `s3`; a block with no `publisher:` key is `s3`, unchanged). Every publisher lays evidence
under the same key layout `herdr-factory/<github_username>/<key_prefix>/<key>/<run>-<timestamp>/`
and produces "prefix + filename" URLs, so prompts and PR embedding never change. `key_prefix`
(optional) and `github_username` (optional; default = the `gh` login at publish time) are shared by
all three. Delivery is durable — the URLs are published up-front and the bytes retry in the
background until the backend accepts them.

**`s3`** — S3 + CloudFront (the original). Non-secret pointers only; AWS credentials come from the
ambient chain (`AWS_*` env, SSO, `~/.aws`, or the named `profile`) — never stored in config or
handed to an agent.

```yaml
evidence: # publisher: s3 is the default
  bucket: my-evidence-bucket
  region: us-east-1
  cloudfront_domain: d123abc.cloudfront.net # bare host or URL; used to build the public links
  key_prefix: my-app # optional
  profile: my-aws-profile # optional named profile
  github_username: raza # optional; default = `gh` login at publish time
```

**`local`** — zero cloud setup. Captures are copied into a directory the resident server serves at
`/evidence/<key>/…`, and the URLs point at that server. Good enough for same-machine/tailnet
reviewers and the dashboard (the server must be running for the links to resolve).

```yaml
evidence:
  publisher: local
  public_base_url: http://my-box.tailnet.ts.net:8765 # optional; default http://127.0.0.1:<server port>
```

**`command`** — bring-your-own backend (GCS, Azure, an internal artifact store). The executable is
run with two trailing args — the capture directory and the key prefix — and must upload the bytes
and print one public URL per file to stdout (each ending in that file's path). A non-zero exit or a
timeout is retried on the outbox's flat 30s clock (suspending after 10 failures). Because the URLs come from stdout, they are known only
after a successful run (a deferred `command` publish has no links to embed until it lands).

```yaml
evidence:
  publisher: command
  command: ./publish-evidence.sh # a bare path, or an argv array [tool, --flag, …]
  timeout_seconds: 300 # optional; default 300
```

`doctor --deep` verifies the setup with a per-publisher round-trip: an S3 write probe, a
`local` static-serve fetch, or a `command` dry-run.

### `conventions` (optional)

Repo-wide conventions injected into agent prompts. Today it carries one key:

```yaml
conventions:
  commits: "Conventional Commits — feat/fix/chore(scope): summary" # short free text …
  # commits: docs/commit-guide.md   # … or a file pointer (relative to this config folder, or absolute)
```

`conventions.commits` surfaces as `@@COMMIT_CONVENTIONS@@` in the **work** and **pr** prompts (see
[Prompts](#prompts)): the value is either short free text or a path to a file whose contents are
used (a path is resolved against the repo's config folder, or given absolutely). Omit the key and
the token renders empty — the prompts are unchanged. Beyond the `pr` step reading the target repo's
own `.github/PULL_REQUEST_TEMPLATE.md` automatically (as `@@PR_TEMPLATE@@`), this is how you steer
the *commit* shape without editing a prompt file. (v1: the config key **is** the convention — there
is no auto-detection of commitlint configs.)

### `branch` (optional)

The branch-naming taxonomy: how a work-item type maps to `{{semantic_work_prefix}}`, and the length
caps for the `{{work_slug}}` / `{{work_full_slug}}` vars a [`workspace_name`](#belt--1) template uses.
Repo-wide, and **overridable per belt** (a belt-level `branch:` block) — each field resolves belt over
repo over the defaults. Omit it everywhere and branch names are **unchanged**: the historical
`bug|defect → fix`, `chore|task → chore`, else `feature` taxonomy, with `{{work_slug}}` ≤ 20 and
`{{work_full_slug}}` ≤ 50.

```yaml
branch:
  prefixes:
    story: feat # story-typed items → feat/… branches
    bug: fix
    default: chore # any type that matches no key above
  slug_max: 20 # cap for {{work_slug}}
  full_slug_max: 50 # cap for {{work_full_slug}}
```

A work **type** is matched against each `prefixes` key **case-insensitively by substring** (so a
`Dev bug` type matches the `bug` rule, and `Sub-task` matches `task`), keys tried in declaration order
(first match wins). The reserved `default` key is the fallback for an unmatched type — omit it and the
fallback is `feature`. A belt's `prefixes` map **fully replaces** the repo's (it's not merged), while
each slug cap overrides independently; unset fields fall back to the repo block, then the defaults.

#### Branch names are tracked, not fixed

A run's **identity is its worktree** — the name from `workspace_name`, the herdr workspace, the
checkout path — never its branch. The factory can only name a branch from what the work source knows
**at claim time**, and plenty of repos need a name it cannot know then: a CI rule that every branch
carries a ticket key, a ticket the agent itself creates during the work step, a prefix taken from a
convention document in the repo.

So the branch is **tracked**. An agent renames it once, before it pushes:

```
herdr-factory --repo <name> set-branch <KEY> fix/RWR-18500-toast-crash
```

…which is what `@@SET_BRANCH_CMD@@` renders into every step prompt (the shipped `work` prompt tells
the agent to use it when the repo's convention needs another shape). The engine renames the branch in
the worktree, records the change on the run's timeline, and from then on uses the new name for
prompts, PR discovery, and cleanup. A rename made **without** the command (a bare `git branch -m`) is
picked up on the next reconcile pass anyway — the command exists so a bad rename fails loudly at the
agent instead of silently at the wrong moment. It refuses:

- a name that isn't a valid git ref, or one that already exists in the repo;
- a **protected** branch — the `base_ref` or whatever the main checkout has checked out (these are
  also never deleted at teardown);
- any rename **after the run's PR is open** — the PR's head is the branch that was pushed, and
  renaming then would strand it.

Nothing else changes: the worktree keeps the name it was created under (so `layout_matching` and the
layout hook still resolve it), teardown deletes both names, and PR discovery looks under both. A belt
whose repo has no such convention never sees any of this.

### `agent` (optional)

The **agent harness** the factory launches in the panes it spawns itself — the binary and its
flags. Repo-wide, **overridable per belt and per step**:

```yaml
agent:
  command: opencode # the executable the spawned pane runs (default: claude)
  flags: [--some-flag] # its flags (default: none once you set an `agent:` block)
  # kind: claude      # ONLY when `command` isn't itself a herdr agent name (a wrapper script, an
  #                   # absolute path): the herdr agent kind to start it as

belt:
  - name: ship
    source: jira
    label: agent
    agent: { command: codex } # this belt's spawned panes run codex instead
    steps:
      - { type: work } # spawns codex (inherits the belt)
      - { type: pr, agent: { command: claude, flags: [--dangerously-skip-permissions] } } # per-step override
```

The spawned pane's command line is `<command> <flags…> <prompt>`, so `command` is a herdr-recognized
agent (`claude`, `opencode`, `codex`, `pi`, … — whatever `herdr integration install` supports, so
herdr can detect its idle/working state) and the flags are whatever that agent takes. The factory
creates the pane and asks herdr to **start the agent in it**, which waits until the agent is ready for
input — so the first prompt can't be dropped into a shell that isn't listening yet. That needs herdr to
recognize the harness: a bare, known name (`claude`) is recognized automatically, while a wrapper
script or an absolute path needs `kind:` to name the herdr agent it really is (without it, the argv is
simply typed into the pane and the readiness wait is skipped). The PR-watch resolver reuses the `pr`
step's harness (else the repo's).

Resolution is **whole-block, most-specific-wins** — step over belt over repo — **not** field-merged:
because flags are command-specific, a belt that switches `command` to `opencode` must not inherit the
repo's claude `--dangerously-skip-permissions`. So once you write an `agent:` block, `command` defaults
to `claude` and `flags` defaults to **empty** — list the flags you want. **Omit `agent:` everywhere and
nothing changes**: spawned panes launch `claude --dangerously-skip-permissions`, exactly as before (see
the [security note](#security-note)). This block governs the panes the **factory spawns**; a
[layout](#layouts) pane names its own agent (`agent: claude` + `agent_args`), so the layout owns the
harness for the panes it builds.

### Layouts

A **layout** is a herdr tab/pane arrangement the factory builds into a worktree the moment it's
created — the dev environment a worktree needs (agent panes, dev servers, editors, log tails). This
was absorbed from the [workspace-manager herdr plugin](https://github.com/razajamil/herdr-plugin-workspace-manager):
the factory is now itself a herdr plugin (registered by `install.sh`, or manually with
`herdr plugin link <checkout>`) that listens for `worktree.created` and builds the matching layout
into **any** new worktree — whether you created it by hand or the factory claimed a ticket.

> **Don't run another herdr layout plugin for repos the factory manages.** Because the factory now
> owns layout application on `worktree.created`, a second layout plugin — e.g.
> [workspace-manager](https://github.com/razajamil/herdr-plugin-workspace-manager) — would fire on
> the same event and build a competing (or duplicate) layout into the same worktree. Disable that
> plugin's mapping for any factory-managed repo, or uninstall it.

Define a repo-level library and point belts at it:

```yaml
layouts:
  - id: app-dev
    setup: { command: mise run setup, blocking: true } # runs once before the rest (blocking = wait for it)
    tabs:
      - title: work # a step with `tab: work, pane: agent` targets the pane below
        panes:
          - title: agent # the step's agent — herdr starts it and waits until it's ready
            agent: claude
            agent_args: [--dangerously-skip-permissions]
            setup: true # …and this is the pane the layout's `setup.command` runs in
          - { title: server, command: mise run dev, split: right, size: "40%" }
      - title: review
        panes:
          - { title: agent, agent: opencode }

belt:
  - name: fix-tickets
    source: jira
    label: agent
    default_layout: app-dev # built into every worktree this belt claims
    layout_matching: # optional: pick a different layout per branch — first glob that matches wins
      - { worktree_pattern: "hotfix/*", layout: app-dev-hotfix }
    steps:
      - { type: work, tab: work, pane: agent } # dispatched to the layout's work/agent pane
      # …
```

- **Agent panes** — `agent: <kind>` names a herdr-recognized agent (`claude`, `opencode`, `codex`,
  `pi`, … — whatever `herdr integration install` supports). herdr starts it in that pane and **returns
  only once it has detected the agent and marked it ready for input**, so the layout knows it actually
  came up and a step's first prompt can't be dropped into a shell that isn't listening. Companions:
  `agent_args` (passed to the agent), `agent_name` (a stable herdr alias — lowercase, unique; derived
  when unset), `agent_timeout_ms`. A pane **no step targets** may also carry a `prompt` (+ optional
  `prompt_timeout_ms` to wait for it to settle) — a step-targeted pane must not, since the step's own
  prompt is what gets dispatched there.
- **Command panes** — `command` runs as the pane's **process**, inside your interactive login shell, so
  `.zshrc`/`.bash_profile` setup (mise, asdf, nvm, PATH) applies. It isn't typed into the pane, so it
  leaves no scrollback and can't race a shell that isn't ready. The pane returns to a prompt when the
  command exits unless you set `persist: false`. A pane sets `agent` or `command`, never both.
- **Everything else** — `env: {KEY: value}` per pane (and per layout, with the pane's entries winning).
  A step's `tab`+`pane` targets a pane by its tab title + pane title, and that pane must start an
  agent — an `agent:` kind, or a `command` that launches one — which the config loader checks when you
  save. `split` is `vertical`/`right` or `horizontal`/`down`; `size` is a `"30%"` percentage, a `0<n<1`
  fraction, or an integer cell count. At most one pane may be `setup: true` — the layout-level
  `setup.command` runs there first (on an **agent** pane it is executed *in* the pane rather than as the
  pane's process, so herdr can still start the agent there) (`blocking: true` waits for it to finish before any other pane's
  command or agent starts; an agent on the setup pane always waits for it).
- **Selection** — a belt builds its `default_layout`, unless an earlier `layout_matching` glob
  matches the worktree's branch. A hand-created worktree (no owning run) resolves by walking the
  repo's belts. Layouts are keyed to the repo by the config file (one config = one repo), so no
  repo path is restated.
- **Idempotent** — applied exactly once per worktree, and only to a **fresh** (1-tab/1-pane) linked
  worktree, so it never clobbers an arranged or restored workspace. That freshness gate loses a race
  against a step spawning its own pane (a new tab, decided in-process while this out-of-process hook
  is still booting), so a belt with a `default_layout` must target its **first** step at a layout
  pane — validated at config-load, not left to fail at runtime.

A step whose `tab`/`pane` names a pane the layout doesn't (yet) provide waits up to
`limits.layout_wait_seconds`; an expired window is automatically re-armed up to 3 times (a
transient herdr/layout race self-heals — even from an already-parked run), and only then does the
run park for attention. An untargeted first step is no longer one of the causes — config-load
refuses that belt — so a park here means the factory plugin isn't linked with herdr, the layout's
tab/pane titles don't match the step's, or the belt gets its layout **only** from a
`layout_matching` rule: that shape is exempt from the first-step check (those rules commonly serve
hand-created worktrees), so a matching rule intercepting a factory claim can still lose its build
silently. Omit `layouts` (and a belt's
`default_layout`/`layout_matching`) and steps just spawn their own dedicated panes — zero layout
setup required.

### Prompts

A step's body is the engine's built-in **base prompt** for its primitive (per source type under
`src/prompts/`), optionally augmented by your `prompt_file` — or **replaced** by it
(`prompt_mode: replace`, so your file owns the body and the shipped prose is dropped) — or, for a
`custom` step, your `prompt_file` alone. The `prompt_file` is the factory's public authoring
surface, and the full contract it writes against — every token, its scope, the `@@WHEN@@` clause
syntax, and the validation rules — is documented in [`docs/PROMPTS.md`](docs/PROMPTS.md).
`prompt_file_source` says where it's read from and **defaults to `config`** = the repo's config
folder (checked at load); set it to `repo` = the target repo's checkout, read from the run's
**worktree at render time**, so prompts can live version-controlled next to the code.

**The shipped prompts defer to the target repo.** Every built-in base prompt (`work`, `evidence`,
`review`, `pr`, and the PR `resolver`) tells its agent to look for the target repo's own instructions
first — its `CLAUDE.md` / `AGENTS.md` (including nested, directory-level ones), agent skills and
commands under `.claude/`, `CONTRIBUTING.md`, runbooks under `docs/` — and to **prefer them over the
prompt's generic advice**, falling back to the shipped defaults only where the repo is silent. The
deference is deliberately scoped to *how the work is done*: setup and dev-server commands, patterns
and code style, where tests live and which lint/type-check/test commands count, review standards,
capture tooling (browser skill, viewport, recording size), test accounts and personas, and the PR
description shape. It never extends to the factory's **flow** — a gate's read-only posture,
committing incrementally, the handoff note, `step-done` / ask-human / bounce, who owns the work
item's status, `conventions.commits`, or the belt's own [`pr:` policy](#belt--1) all win over
anything the repo documents, and the handover scaffold states that precedence on every step (custom
steps included). So a repo that ships a `playwright-cli` skill or a review checklist gets its own
conventions used; a repo that ships none behaves exactly as before.

**User-overridable prompt packs — the base-prompt resolution chain.** `prompt_file` _augments_ the
shipped base; a **prompt pack** _replaces_ it. Drop a file named for the primitive's slug
(`work.md`, `review.md`, `pr.md`, `evidence.md`, or the PR `resolver.md`) into a pack directory and
the engine uses it as the base instead of its shipped one. Packs resolve highest-precedence first:

1. **repo checkout** — `<repo>/.herdr/prompts/` — version-controlled next to the code; read from the
   run's worktree at render time (so a branch can carry its own prompts).
2. **config folder** — `repos/<name>/prompts/` — the same folder your `custom`-step prompt files
   live in; resolved at config-load.
3. **engine shipped** — `src/prompts/` — the built-in default; always present, so the chain always
   resolves.

The first file found wins and replaces the shipped base; within any layer a per-source variant
(`<pack>/<source_type>/<slug>.md`, e.g. `.herdr/prompts/jira/work.md`) beats the shared
`<pack>/<slug>.md`, mirroring the shipped library's own `prompts/<type>/<slug>.md` layout. A step's
`prompt_file` still augments whichever base wins, so you can override the pack **and** append
per-step instructions. It's convention-based — there's nothing to configure; just add the files.

**Ejecting the shipped pack.** The engine's built-in prompts live inside the package, so to start
from them, `herdr-factory --repo <name> prompts eject` copies the whole shipped pack into the repo's
config folder at `repos/<name>/prompts/` (the `config` root above). It's copy-only — it never edits
`config.yml` — and prints the `prompt_file:` lines to paste onto a belt step. Re-ejecting skips files
that already exist (so it never clobbers your edits) unless you pass `--force`; `--step <name>` ejects
just one prompt (`work`/`review`/`pr`/`evidence`/`resolver`, with its per-source variants). Point a
step's `prompt_file` at a copy to augment that step's shipped prompt with your edits.

Around the body the engine always adds: a handover scaffold (which belt and step this is, the
full step sequence, the prior step's handoff note and pane/session pointer for on-demand
questions, the ask-human protocol, the bounce protocol where applicable, and the finish protocol —
write your handoff, then run step-done), your repo's `guidelines-prompt.md`, and token
substitution. Universal tokens (always injected):

`@@KEY@@ @@REPO@@ @@BELT@@ @@STEPS@@ @@STEP@@ @@TYPE@@ @@SUMMARY@@ @@BRANCH@@ @@WORKTREE@@
@@MEMORY_DIR@@ @@WORK_DOC@@ @@WORK_DOC_KIND@@ @@HANDOFF_IN@@ @@HANDOFF_OUT@@ @@PRIOR_PANE@@
@@PRIOR_SESSION@@ @@STEP_DONE_CMD@@ @@ASK_HUMAN_CMD@@ @@BOUNCE_CMD@@ @@BOUNCE_TARGET@@
@@BOUNCE_REASON_FILE@@ @@CLI@@ @@COMMIT_CONVENTIONS@@`

(`@@COMMIT_CONVENTIONS@@` renders your [`conventions.commits`](#conventions-optional) value when set
and **nothing** when unset, so an unset key leaves the work/pr prompts byte-identical to before.)

Plus **capability-scoped** tokens, injected only when the step declares the machinery they belong to:
`@@EVIDENCE_DIR@@ @@EVIDENCE_UPLOAD_CMD@@ @@CAPTURE_ATTEMPT_CMD@@` appear only when an upstream step
*produces* `evidence` (so in a work → review → pr belt the review/pr prompts carry no evidence tokens
at all); `@@CAPTURE_LOCK_ACQUIRE_CMD@@ @@CAPTURE_LOCK_RELEASE_CMD@@` appear only for a step that
declares an `exclusive_resource` guard (the evidence capture mutex), the lock name coming from the
guard; and `@@PR_TEMPLATE@@ @@PR_OPTIONS@@ @@PR_AUTOMATED_ROUND@@` appear only for a step that
*produces* `pull_request` (the `pr` step) — `@@PR_TEMPLATE@@` carries the target repo's own PR
template (read from the worktree at render time) so the PR follows the team's shape (empty when the
repo ships none), while `@@PR_OPTIONS@@` and `@@PR_AUTOMATED_ROUND@@` render the belt's
[`pr:` behavior block](#belt--1) (draft/title/labels/reviewers/assignees and the automated-round
window) — both at their pre-block defaults when the belt sets no `pr:`.

Prompts also support **product-gated clauses** — `@@WHEN:<product>@@ … @@END@@` — kept only when that
product is active for the step (produced by it or upstream), otherwise the whole clause (prose **and**
its tokens) is dropped. That's how the shipped `review`/`pr` prompts reference evidence without ever
pointing at evidence a shorter belt never captured. Base prompts never name neighbour steps by name —
they reference prior/next work only through `@@HANDOFF_IN@@`/`@@HANDOFF_OUT@@` and the `@@STEPS@@`
sequence, so a primitive reads correctly in any belt order.

Your `prompt_file` is **validated against this contract** — a `config`-sourced one at config load
(so `doctor`/`reload`/the TUI editor catch it before any run), a `repo`-sourced one at render time.
A token that would reach the agent unrendered (unknown, or out of scope for the step) or a malformed
`@@WHEN@@`/`@@END@@` clause is rejected with an error naming the belt, step, file, and problem.

Everything a run reads and writes lives in `.memory/herdr-factory/` inside its worktree: the
rendered prompts, handoff notes, the work doc (`ticket.json`, or `task.md`/`task/`), attachments,
bounce feedback, human questions and replies, and captured evidence. Never commit this folder in
your repo (add `.memory/` to its `.gitignore`) — a committed copy would shadow each new run's real
work doc, so the factory removes it from every freshly created worktree.

### Editor schema

`config.yml`'s first line — `# yaml-language-server: $schema=../../config.schema.json` — points
the YAML language server at a JSON Schema generated from the engine's own zod schema (so it can't
drift): autocomplete, required fields, enums (e.g. a valid step `type`), and unknown-key errors.
`herdr-factory install` writes it to
`~/.config/herdr-factory/config.schema.json`, and the resident `serve` process **rewrites it on every
startup** — so an auto-update (which restarts the server onto the new code) keeps the installed schema
in lock-step with the running engine automatically; `herdr-factory schema` regenerates it by hand if
you ever need to. A committed copy at the repo root serves the in-repo example (`npm run
schema`; a test guards it against drift). Cross-field rules — belt `source` refs, unique names,
tab/pane both-or-neither, a `default_layout` belt's first step carrying one, `{{work_id}}` presence,
file existence — are validated at load with readable errors.

## Commands

```
# inspect & operate a repo
herdr-factory --repo <name> status | eligible | runs [--all] | timeline <KEY> | logs [n] | tick
herdr-factory --repo <name> explain <KEY> [--source <name>]         # why the run is where it is — clocks, retries, what would move it
herdr-factory --repo <name> triage <KEY> [--print]                  # open YOUR agent CLI on a stuck run, pre-briefed with the diagnosis
herdr-factory --repo <name> run [--follow]                          # run the factory in the FOREGROUND, streaming live progress
herdr-factory --repo <name> claim <KEY> [--belt <name>]
herdr-factory --repo <name> teardown <KEY> [--source <name>]
herdr-factory --repo <name> resume <KEY> [--source <name>]          # un-park an `attention` run
herdr-factory --repo <name> retry-now [KEY] [--source <name>]       # you fixed the cause: clear suspensions, retry now
herdr-factory --repo <name> auth status                            # each source's credential presence (no network)

# agent → dispatcher signals (rendered into every step prompt; you rarely type these)
herdr-factory --repo <name> step-done <KEY> <step> [--source <name>]
herdr-factory --repo <name> bounce <KEY> <toStep> --reason|--reason-file … [--source <name>]
herdr-factory --repo <name> ask-human <KEY> <step> --question|--question-file … [--source <name>]
herdr-factory --repo <name> set-branch <KEY> <branch> [--source <name>]   # move the run onto this repo's branch convention
herdr-factory --repo <name> evidence-upload <KEY> [--source <name>]
herdr-factory capture-lock acquire|release <resource> [owner]       # machine-global exclusive_resource lock

# scaffold a repo config from inside the repo (name defaults to --repo, else the checkout dir)
herdr-factory [--repo <name>] init [--source jira|github_issues|local_markdown|sentry] [--path <dir>] [--force]
herdr-factory --repo <name> prompts eject [--step <name>] [--force]  # copy the shipped prompt pack into repos/<name>/prompts/ to edit
herdr-factory skill install [--into <dir>] [--copy|--symlink] [--force]  # install the agent skill (see The agent skill)

# the machine-wide server + supervisor (no --repo)
herdr-factory serve | ensure-up [--restart] | restart | reload | update | provision-node
herdr-factory install | uninstall | start | stop
herdr-factory schema [--stdout]
herdr-factory doctor [--deep] [--repo <name>]
```

The mutating/nudge commands (`tick`, `claim`, `teardown`, `resume`, `retry-now`, `step-done`,
`ask-human`, `bounce`) route through the running server when it's up — a warm, in-process reconcile —
and fall back to executing directly against the DB when it isn't; reads (`status`, `eligible`, `runs`,
`timeline`, `logs`, `explain`) always go straight to the DB. `--source` disambiguates a key active
in more than one source; `claim --belt` is required only when the repo has more than one belt.

`retry-now` is the way out of a **suspension whose cause you have already fixed**. The durable
retries — source status write-backs and evidence uploads — retry on a flat 30-second clock and, after
**10 failed attempts, suspend**: the engine stops retrying, notifies you, flags the repo row in the
TUI, and waits. The engine clears a suspension by itself only for causes it can probe (expired AWS
credentials, which it re-tests every tick). For everything else — a timeout, a source that was
briefly down — you fix the cause and run `retry-now`: it clears the repo's suspensions (each gets a
fresh 10-attempt window), makes every waiting retry due immediately, and flushes them on the spot;
pass a `KEY` to scope it to one run. It reports how many were actually stuck, so `0` tells you the
delay is somewhere else. Nothing else about a run changes — which is why it is the right tool for a
perfectly healthy run whose only stuck thing is a background upload, where `resume` (an
`attention`-only un-park) refuses.

`explain <KEY>` answers "why does this run look stuck?" in plain language: the run's current story
(what it waits on, which budget/stall/layout clock is armed and when it fires), every background
debt still being retried — status write-backs, evidence uploads, queued signals — with attempt
counts and the next retry time, the bounce counters, and the ready-made command that would move it
(`resume`, a reply, a credential refresh). A park explains its own reason code and whether the
engine can still rescue it by itself. It also warns when no server is ticking the repo — the
commonest reason a retry never fires. The same narrative appears in the TUI: press `d` on a run.

`triage <KEY>` goes one step further: when reading isn't enough, it opens a **conversation**. It
writes a briefing — the `explain` narrative, the run's recent events, where the worktree and logs
live, the skill's playbook paths, and ground rules (diagnose first; never `teardown`/`bounce`
without your OK) — then launches your configured agent harness interactively in your terminal,
pointed at it. The harness comes from the repo's [`agent:`](#agent-optional) block (`claude` by
default) with the worker flags deliberately dropped — you are present to approve actions.
`--print` prints the briefing instead of launching (any harness, tmux, pipes). It runs in your
terminal, not a herdr pane, so it works even when herdr itself is the problem. Attention reports
(in the pane, or on the work item for work errors) advertise it alongside the resume command.

`run` is the **foreground first-run** path — the fastest way to see the factory work before you
install the background supervisor. It reconciles the repo on its configured cadence (the same
`reconcileRepo` the server ticks) **in-process** and streams the run timeline as it happens —
claims, step starts/finishes, bounces, PRs opened, merges, attention parks. Plain `run` rides until
the repo goes idle (local work implemented and PRs opened) then summarizes what's left and exits;
`run --follow` never auto-exits — it tails until you `Ctrl-C` (like `tail -f`). It takes the
per-repo tick lock, so it **cooperates** with a resident server if one is already up (a pass the
server is mid-way through is simply skipped) while still streaming that server's own progress — so
`run --follow` doubles as a live console onto a background factory.

`auth status` reports each source's credential presence (env-var presence only, no network). Every
source authenticates from the repo `env` — `JIRA_EMAIL` + `JIRA_API_TOKEN` for `jira`,
`SENTRY_AUTH_TOKEN` for `sentry`, `GITHUB_TOKEN` (or your `gh` login) for `github_issues` — so there
is no browser login.

`serve` binds `127.0.0.1:8765` (override with `HERDR_FACTORY_PORT`) with the OpenAPI spec at
`/doc` and Swagger UI at `/ui`. `update` pulls the latest code (hard reset to the branch's
upstream) and restarts onto it — the supervisor does the same automatically every ~60s.

## The TUI

Plain `herdr-factory` (no arguments) opens a full-screen terminal UI built on
[opentui](https://github.com/anomalyco/opentui). `Tab`/`Shift+Tab` switch the three tabs, number
keys jump to a numbered section, arrows move within it, `Esc` pops back out, `q` quits.

The UI is also fully mouse-navigable: click a tab to switch, click a section or row to jump to it,
and use the scroll wheel in any list. In the config editor, clicking a group toggles it and clicking
a text field starts editing; value controls (toggles, enums, add/remove actions) act on a second
click of the already-focused row, so a stray navigational click can't change a value. Modal choices
are clickable, and clicking the dimmed backdrop dismisses a dialog. Rows, tabs, and choices tint subtly on
hover, and the mouse shows a pointer everywhere except inside a text field, where it becomes a text
cursor.

- **Dashboard** — repos contain their belts, and each belt contains its active and eligible work
  items. `↑↓` navigates, `↵` opens a run's event timeline, `t` ticks, `c` claims an eligible item,
  `x` tears down, and `r` refreshes (mutating actions require confirmation). Empty belts stay hidden.
  A repo with a problem — a run parked for attention, suspended jobs, evidence uploads blocked on
  AWS creds, a source that cannot authenticate — carries a **red ⚠ icon and count** on its row, so a
  broken repo is visible at a glance; highlight the row to read the full detail on the action line,
  or press `d` for the detail view, where everything unhealthy (the problems, a failed auth probe, a
  down belt) renders **in red**. Problems are **recorded, not polled**: the engine writes a problem
  the moment its own machinery observes one (a login failure, an expired AWS session caught by the
  periodic creds probe, a blocked delivery) and clears it the moment the cause recovers — the
  dashboard just reads the record.
  `s` is the "I fixed it, go now" key, and it reads the situation: on a run parked for `⚠` attention
  it **resumes** (the CLI's [`resume`](#commands) — un-park and pick up where it left off); on any
  other run it **clears that run's suspended background jobs** and makes its waiting retries due now;
  on a repo row it does the same repo-wide, which is the shape of the usual cause — one expired
  `aws sso login` stalls every run's evidence upload at once. Background retries run on a flat
  30-second clock and suspend after 10 failures, so `s` is how a fixed cause gets a fresh window.
  Press `d` for Detail, which is contextual: on a **run** it opens the work item's full detail — the
  untruncated summary, type, source/belt, branch, live status and worker state, PR, age, a
  **"What's happening" narrative** (the same plain-language story `explain <KEY>` prints: what the
  run waits on, which clocks are armed, what retries in the background, and what would move it),
  plus the belt's step-by-step progress (with per-step timing) and the event timeline; on a
  **repo** it opens general AWS SSO/source-auth diagnostics followed by configuration, work counts,
  and a live source/pickup health check for every belt.
- **Config** — a repo list `[1]` and a full `config.yml` editor split across four bordered panels:
  `[2]` config (repo · limits · secrets · evidence), `[3]` work sources, `[4]` layouts (the
  repo-level [layout](#layouts) library — nest into a layout to edit its tabs and panes; belts
  point at one via `default_layout`/`layout_matching`), `[5]` belts. The four
  panels are an accordion — collapsed by default, and jumping to one (number keys `2`/`3`/`4`/`5`, a
  click, or `↵` from the repo list) expands it and collapses the others, so only one is open at a
  time. It edits the YAML surgically (comments and the schema modeline preserved), validates against
  the engine schema, `^S` saves, `[`/`]` reorder list entries. The repo list always heads with
  **`+ new repo…`**: it prompts for a name, checkout path, and source type, then scaffolds
  `repos/<name>/{config.yml, env}` (sharing [`init`](#2-point-it-at-a-repo-and-a-project)'s scaffold —
  the same annotated placeholders) and opens it for editing, so a zero-repo install bootstraps its
  first repo entirely in the TUI. Adding a belt offers a **pipeline preset** — *ticket → PR*
  (work → review → pr, with the pickup `label` seeded for a label-driven source) or a *custom
  pipeline* — and `+ add step` defaults to `work`. Steps are **allocated to layout panes by picking,
  not typing**: once a belt has a `default_layout`, each step's `tab` and `pane` become pick-lists over
  that layout's real tabs and panes — the pane list follows the chosen tab, and choosing a tab lands on
  one of its panes, so the both-or-neither pair is always complete and `[4]`/`[5]` never need
  cross-referencing (with no `default_layout` there's nothing to enumerate, so they stay free text).
  The pick-lists start unset, so picking a `default_layout` and leaving the **first** step's pane
  unpicked fails the save — that belt could never build its layout (see [Layouts](#layouts)).
  Renaming a layout id, tab title, or pane title in `[4]` **repoints every belt and step that
  referenced it** and reports what moved — the one case it won't guess is a target two of the same
  belt's layouts both define (left alone, and flagged). When a step's `config`-sourced `prompt_file` or a
  belt's `match` names a file that doesn't exist yet, the editor offers to **create it with a
  commented stub** so the save it just set up can't fail on a missing reference; the optional
  `guidelines-prompt.md` is editable inline as a multiline buffer. Credentials appear as masked,
  replace-only `secrets (env)` fields —
  declared per source type (`JIRA_EMAIL`/`JIRA_API_TOKEN` for jira, `GITHUB_TOKEN` for
  github_issues, `SENTRY_AUTH_TOKEN` for sentry) — written separately to the `env` file (`chmod 600`).
- **Doctor** — the same checks as the CLI: `r` re-runs, `d` toggles deep mode (live herdr/gh/S3
  probes). The `herdr`/`gh`/`claude`/`git` presence checks resolve against the **service's** PATH
  (the environment the resident server runs its tools in), not the TUI's own — so they read the
  same whether you open the TUI from a terminal or a GUI launcher (Spotlight, a dock icon, a
  hotkey), which otherwise inherits only the bare system PATH.

The TUI renders through opentui's native core, which needs FFI — the launcher adds the flags and
resolves the same vendored Node the engine uses, so there's nothing to set up.

## The agent skill

The factory ships an **agent skill** — the same documentation you're reading, restructured as an
operating manual for a coding agent. Install it once and your agent can set the factory up for a repo,
answer questions about the engine, and debug a stuck run without you reading any of this:

```sh
herdr-factory skill install               # → ~/.claude/skills/herdr-factory (symlinked to the checkout)
herdr-factory skill install --into .      # → ./.claude/skills/herdr-factory (copied, so you can commit it)
```

The default install is a **symlink into the running checkout**, so auto-update keeps the skill in
lock-step with the engine it documents — the same guarantee the [editor schema](#editor-schema) gets.
`--into <checkout>` copies it instead, for a team that wants the skill version-controlled next to the
code (re-run with `--force` after a factory update to refresh the copy).

Then just ask, in your repo:

```
> set up herdr-factory for this repo
> why is RWR-1234 parked?
> add an evidence step to the bugs belt
```

The skill runs a config **interview** — asking only what it can't infer from your checkout, then
validating with `doctor --deep` before it hands back — and loads one per-topic reference on demand: the
config schema with every load-time rejection, the four work sources, belt composition, layouts, the
prompt contract, the CLI, paste-ready recipes, what your target repo should document, the engine's
internals, installing/operating the factory, and a symptom → diagnosis → fix playbook. It's `SKILL.md` +
`references/` under [`skills/herdr-factory/`](skills/herdr-factory/) — plain Markdown, so an agent
harness with no skill mechanism can be pointed at the folder directly.

## Files on disk

```
~/.local/share/herdr-factory/    the code checkout (managed by install.sh + auto-update)
~/.config/herdr-factory/         config.schema.json · repos/<name>/{config.yml, env, guidelines-prompt.md, …}
~/.local/state/herdr-factory/    herdr-factory.db · runtime/<node>/ · node-path · server.json
                                 update-status.json (last auto-update outcome — surfaced in doctor/TUI)
                                 logs/ (supervisor + server) · <repo>/logs/<date>.log (per-repo)
<worktree>/.memory/herdr-factory/   per-run working memory: prompts · handoffs · work doc · evidence
```

## Environment variables

| Variable                    | Effect                                                      |
| --------------------------- | ----------------------------------------------------------- |
| `HERDR_FACTORY_PORT`        | server port (default 8765)                                  |
| `HERDR_FACTORY_CONFIG_DIR`  | config root (default `~/.config/herdr-factory`)             |
| `HERDR_FACTORY_STATE_ROOT`  | state root (default `~/.local/state/herdr-factory`)         |
| `HERDR_FACTORY_AUTO_UPDATE` | `0` disables the supervised auto-update                     |
| `HERDR_CHANNEL`             | update channel: `main` (default, tracks upstream) or `stable` (follows the latest release tag) |
| `HERDR_FACTORY_TELEMETRY`   | `1` enables OpenTelemetry (plus the standard `OTEL_*` vars) |
| `HERDR_BIN_PATH`            | path to the `herdr` binary (default: `herdr` on PATH)       |

`HERDR_FACTORY_AUTO_UPDATE` and `HERDR_CHANNEL` are captured into the launchd/systemd **service
environment at install time** — set them and re-run `herdr-factory install` (or the installer) to
change them; exporting the variable in your shell alone does nothing. See
[`RELEASING.md`](RELEASING.md) for the channel model and how a release tag is cut.

## Security note

Factory-spawned workers launch with **`claude --dangerously-skip-permissions`** by default, so the
loop runs unattended. Each worker is confined to its own throwaway worktree, but can run commands,
push branches, and open PRs **without prompting**. Agents in _your_-layout panes are whatever you
launched them as. The harness **and** this permission posture are config, not code: set an
[`agent:` block](#agent-optional) — repo-wide, per belt, or per step — to change the command or the
flags (e.g. drop `--dangerously-skip-permissions`, or switch to a different agent CLI) **without
touching the checkout** (which the auto-updater hard-resets anyway). Omit it and the default above is
unchanged.

## Platform

- **macOS** — supervisor via a `launchd` LaunchAgent (`com.herdr-factory.server`).
- **Linux** — supervisor via a systemd `--user` timer (`herdr-factory.timer`; the installer
  enables lingering so it runs headless). glibc and musl (Alpine), x64 and arm64 — the installer
  verifies the vendored Node starts and names the missing system package if not.
- **Windows** — not yet; the service seam is one scheduled `ensure-up` command.

## Development

```sh
git clone git@github.com:razajamil/herdr-factory.git && cd herdr-factory
pnpm install                 # Node ≥ 26 (.node-version pins 26.4.0)
npm test                     # vitest — the fast unit suite
npm run typecheck
npm run schema               # regenerate the committed config.schema.json
scripts/e2e                  # the end-to-end suite, in a container (see below)
```

### The end-to-end suite

`npm test` proves the reconciler against fakes. **`scripts/e2e`** proves the factory: it builds a
container (pinned Node + pinned herdr Linux binary) and runs whole belts against a **real headless
`herdr server`** — real worktrees, real PTY panes, real agents signalling through the real CLI, real
`serve`, real SQLite. Only the outside world is substituted: GitHub is a `gh` shim over a local bare
`origin`, and the step agents are a scripted agent that **reads the rendered prompt and runs the
signal command it finds there** (so the suite also guards the agent-CLI contract). A full belt —
brief → work → review → pr → merged → teardown — runs in about 17 seconds.

```sh
scripts/e2e                                   # everything; artifacts in artifacts/e2e/<ts>/
scripts/e2e --scenario w2pr-happy --keep      # one scenario, keep its world
scripts/e2e --no-build -- --reporter=verbose  # iterate without rebuilding
scripts/e2e --lane fake                       # only the no-herdr lane (failure injection + scale)
```

29 scenarios, ~6 minutes in the container: the core belts, layouts, every attention park and the human
loop, the evidence station, the PR lifecycle, source parity for Jira and Sentry, belt/config breadth, a
herdr outage, a live TUI boot in a real PTY — and four performance measures that record real numbers
into each scenario's `metrics.json` (external-call budget, throughput at 60 items, per-pass latency
under load, and a ~900-pass resource soak). A second lane swaps herdr for a shim, which is how an
unreachable herdr and 60 concurrent runs get tested without 60 PTYs.

One tier is opt-in: `--tier ds4` hands the **shipped prompts** to a local model (opencode against a
DeepSeek V4 endpoint on `:8000`) and asks whether the work reaches a PR. It costs nothing per run, and
it is the only check on the part of the system a human never reviews at runtime — what the factory
actually says to agents. Non-gating, because a model having an off day must not turn a build red.

Results are machine-readable (`summary.md`, `results.json`, `junit.xml`) and every scenario keeps its
SQLite DB, engine log, herdr server log, agent transcript, rendered prompts and `gh`/`herdr` argv
traces for post-mortem. Nothing touches your real install: each scenario gets its own HOME, herdr
config, config dir, state root and port. See [`test/e2e/README.md`](test/e2e/README.md) for the
scenario list, how to write one, and what the harness has already found.

The engine is TypeScript run directly via Node's native type-stripping (no build step), state in
the built-in `node:sqlite` (no native modules). Design and invariants:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · telemetry: [`docs/TELEMETRY.md`](docs/TELEMETRY.md).
