---
name: herdr-factory
description: Set up, explain, and debug herdr-factory — the autonomous work→pull-request factory. Use when configuring a repo for the factory (config.yml, work_sources, belts, steps, layouts, evidence, prompts), when a factory question comes up (how belts/claiming/bounces/the PR watch work), or when something is wrong (nothing is being claimed, a run is parked for attention, a step never starts, doctor is failing, a PR is stuck in review). Triggers on herdr-factory, "the factory", herdr belt, work source, ~/.config/herdr-factory, `herdr-factory` CLI commands, jira/github-issues/sentry/markdown work queues feeding an agent pipeline.
---

# herdr-factory

herdr-factory turns a work queue into merged pull requests without a person in the loop. Work items
(Jira tickets, GitHub issues, Sentry errors, Markdown briefs) are claimed onto a **belt** — an ordered
pipeline of step primitives — each step runs a real agent session in its own [herdr](https://herdr.dev)
worktree pane, and the run ends when the PR merges and the worktree is recycled.

Your job with this skill is one of three things: **set up** a repo's config, **answer** a question about
how the factory works, or **diagnose** a factory that isn't doing what the user expects.

## Orient before you act

Run these first. They cost nothing and they change what you do next.

```sh
herdr-factory doctor                       # is the factory installed + healthy at all?
ls ~/.config/herdr-factory/repos           # which repos are configured (folder name == --repo value)
herdr-factory --repo <name> doctor --deep   # this repo's config, sources, credentials, evidence
herdr-factory --repo <name> status          # what's in flight right now
```

If `herdr-factory` is not on PATH, the factory isn't installed — the installer is
`curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh | sh`. Nothing
else in this skill applies until that succeeds.

## Route to the right reference

Load **one** reference file, not the whole bundle. Each is self-contained.

| The user wants… | Read |
|---|---|
| to set up the factory for a repo, from nothing | [references/setup-interview.md](references/setup-interview.md) — the question script, run it top to bottom |
| a specific config key, default, or error message explained | [references/config-reference.md](references/config-reference.md) |
| to pick / configure a work queue (Jira, GitHub issues, Sentry, Markdown) | [references/work-sources.md](references/work-sources.md) |
| to design a pipeline — which steps, in what order, custom gates, bounces, effects | [references/belts-and-steps.md](references/belts-and-steps.md) |
| panes, dev servers, tab/pane targeting, the herdr layout hook | [references/layouts.md](references/layouts.md) |
| to write or override a step prompt | [references/prompts.md](references/prompts.md) |
| a working config to copy | [references/recipes.md](references/recipes.md) |
| a command, flag, or output explained | [references/cli.md](references/cli.md) |
| what is running across **several machines** | [references/cli.md](references/cli.md) — `herdr-factory fleet` (`--json`); the fleet is this machine plus every *enabled* `herdr machine list` entry |
| **something is broken or stuck** | [references/troubleshooting.md](references/troubleshooting.md) |
| to know *why* the engine did something | [references/architecture.md](references/architecture.md) |
| better results out of the agents | [references/target-repo.md](references/target-repo.md) |
| to install/update/uninstall the factory itself, or drive the TUI | [references/install-and-operate.md](references/install-and-operate.md) |
| to verify a change to the factory itself, or to know why a pane's agent never started | [references/testing.md](references/testing.md) |

When a reference doesn't settle it, read the engine — the checkout is on the machine at
`~/.local/share/herdr-factory/`: `src/config.ts` for the config schema and every load-time rejection,
`src/steps/` for what each primitive declares, `src/core/reconcile.ts` for the run lifecycle,
`src/doctor.ts` for the health checks, `docs/ARCHITECTURE.md` and `docs/PROMPTS.md` for the long-form
design. Never edit that checkout — auto-update hard-resets it.

## Setting up

Don't hand-write a config from memory. The path that works:

1. **Scaffold** — from inside the target checkout, `herdr-factory init` (add `--source jira|github_issues|local_markdown|sentry`). It infers the repo path and GitHub owner/name, writes
   `~/.config/herdr-factory/repos/<name>/config.yml` with `EDIT`-marked placeholders, and scaffolds a
   `chmod 600` `env` file for credentialed sources.
2. **Interview** — follow [references/setup-interview.md](references/setup-interview.md). Ask only what
   you cannot infer; recommend a default for everything else.
3. **Validate** — `herdr-factory --repo <name> doctor --deep`, fix at the dotted path the error names,
   repeat until clean. Every rejection and its fix is catalogued in
   [references/config-reference.md](references/config-reference.md).
4. **Prove it** — `herdr-factory --repo <name> run --follow` in the foreground on one real item, and
   only once that works, `herdr-factory start` to install the background supervisor.

Keep the schema modeline as the first line of every `config.yml` so the user's editor validates as they
type:

```yaml
# yaml-language-server: $schema=../../config.schema.json
```

## Diagnosing

Read the state before theorising. In order:

```sh
herdr-factory --repo <name> status            # phases, steps, PRs, server + supervisor state
herdr-factory --repo <name> explain <KEY>     # why this run is where it is, narrated — with next commands
herdr-factory --repo <name> timeline <KEY>    # the event log for this item's MOST RECENT run
curl -s "127.0.0.1:8765/repos/<name>/obligations?key=<KEY>"  # the raw form of explain, precise facts
herdr-factory --repo <name> logs              # today's dispatcher log
```

`explain` is the first answer to "why is this run not moving": the phase or park story, every
background retry with its next attempt time, armed clocks, and the ready-made command that would
move it (it also warns when no server is ticking the repo). `obligations` is its raw JSON — the
undelivered write-backs, pending uploads, unconsumed signals, the outstanding human question, and
every armed guard with its live clock and whether it can auto-rescue — for when you need exact
facts (intent ids, clock epochs) rather than the narrative.

`triage <KEY>` hands the diagnosis to an agent: it writes a briefing (the `explain` narrative,
recent events, file locations, this skill's playbook paths, ground rules) and launches the repo's
configured harness interactively on it. If you were launched BY `triage`, read the briefing file
named in your opening prompt first, and never run `resume`/`teardown`/`bounce`/`step-done` without
the operator's explicit OK in the conversation.

Triage by symptom — each row has a full playbook in
[references/troubleshooting.md](references/troubleshooting.md):

| Symptom | Most likely cause |
|---|---|
| nothing is claimed | server isn't ticking this repo · belt `active: false` · at a concurrency cap · pickup label missing or already consumed · `match` rejecting it · source credentials paused · an undelivered write-back vetoing the item |
| run parked for attention | route by `attention_reason_code` — the table in troubleshooting.md says which are auto-rescuable and how to clear each |
| step never starts | herdr never created the worktree · no herdr plugin link so no layout was ever built · the belt's FIRST step had no `tab`/`pane`, so its own pane pre-empted the build (only possible on a `layout_matching`-only belt — `default_layout` rejects that shape at load) · its `tab`/`pane` names no pane the layout defines · the target pane's agent never came up (look for `could not start <kind> in <pane>` / a "agent did not start" notification) · (for a step with no `tab`/`pane`) the agent binary is missing from the **service** PATH |
| agent says it's done, run didn't advance | the `step-done` signal never landed — check the timeline, then fire it by hand |
| stuck in `reviewing` | that's normal — the PR watch has no time limit and holds no slot while idle. It notifies you once when the PR is green and mergeable; **it never merges** — you are the merge gate |
| the PR is open but the run never adopts it | its head is a branch the run doesn't know, or the PR predates the run — the run's identity is its **worktree**, and adoption tries `runs.branch` then `runs.worktree_name`. A branch renamed to the repo's convention is supported (`set-branch`); check the timeline for `branch_changed` |
| config edits do nothing | `herdr-factory reload` (or the server never picked the repo up at boot) |
| server up but nothing ticks | wedged tick loop — `doctor` does **not** catch this; check `/health`'s per-repo `lastTickAt` |

Nudges, least to most destructive: `reload` → `tick` → `retry-now [KEY]` → `step-done` →
`resume <KEY>` → intent retry → `restart` → `teardown <KEY>`. **`teardown` destroys the worktree and
branches** — never reach for it to "reset" a run without saying so first.

`retry-now` is the one to reach for when the cause is already fixed and the jobs are **suspended**
(uploads, source write-backs — they retry every 30 s and stop after 10 failures, flagging the repo row
in red on the TUI): it clears the repo's, or one run's, suspensions (fresh 10-attempt window), makes
every waiting retry due now, and flushes them, changing nothing else about the run. Only AWS creds
and source auth recover on their own.

## Ground rules

- **Never invent a config key, flag, or enum value.** The zod schema in `src/config.ts` and the
  generated `config.schema.json` are the only sources of truth; if it isn't in
  [references/config-reference.md](references/config-reference.md), check the source before offering it.
- **Never guess a value only the user knows.** Ask for: the Jira Agile board id, project key and its
  real status names; the trigger label the team actually uses; the S3 bucket / CloudFront domain; the
  repo's dev-server command and test credentials. A wrong guess here fails at claim time, not at save
  time.
- **Validate every config change** with `doctor --deep` (or `reload`, which refuses a config that would
  drop a belt with live work). A saved-but-invalid config means the server silently stops ticking that
  repo.
- **Prefer the CLI and the YAML file.** `herdr-factory` with no arguments opens a TUI with a config
  editor — mention it to the user as their option, but do your own work through the file. The one job
  that genuinely needs the TUI is renaming a belt that has runs (it migrates them); see
  [references/install-and-operate.md](references/install-and-operate.md).
- **Don't touch a run's state by hand in SQLite.** Read freely (it's an ordinary sqlite3 file); mutate
  only through the CLI, which holds the right locks.
- **Confirm before anything destructive**: `teardown`, deleting a belt with live work, `rm`-ing a
  worktree, or replacing an existing `config.yml` (`init --force`).
- **Don't commit `.memory/`** in a target repo — add it to `.gitignore`. The engine scrubs a committed
  `.memory/herdr-factory` from every freshly *created* worktree and warns, but on the worktree-reopen
  path a committed copy shadows the run's real work doc (every source's materialize is skip-if-exists).

## Vocabulary

Use these words precisely; the config and the CLI both key off them.

- **work source** — where items come from: `jira`, `github_issues`, `local_markdown`, `sentry`. Named,
  and referenced by belts. A `github_issues` source with `kind: pull_requests` claims labelled **pull
  requests** instead of issues (and never closes or merges one) — see references/work-sources.md.
- **belt** — one source + one ordered `steps[]` pipeline. A repo runs as many as you like, in parallel.
- **step primitive** — `work` (implements + commits) · `evidence` (films proof, can bounce) · `review`
  (read-only gate, can bounce) · `pr` (pushes, opens the PR, rides CI) · `custom` (your own station,
  your prompt is the whole body).
- **pickup label** — the belt's `label`: the tag that makes an item eligible. Required for `jira` and
  `github_issues`, forbidden for `local_markdown` and `sentry`.
- **bounce** — a gate sending work *backward* to an earlier step with written findings, capped by
  `max_bounces`.
- **attention / parked** — a run stopped for a human. Holds no concurrency slot; `resume <KEY>` puts it
  back with fresh clocks.
- **ask-human** — an agent asking a question through the work source; the run waits, frees its slot, and
  resumes the same step when a reply arrives.
- **the outbox / intents** — durable, retried side effects (source status write-backs, evidence uploads).
- **tick** — one reconcile pass over a repo (default every 60s): flush the outbox, advance every active
  run, then claim new work.

## Fast facts

The values asked for most often. Everything else is in
[references/config-reference.md](references/config-reference.md).

| | |
|---|---|
| config | `~/.config/herdr-factory/repos/<name>/{config.yml, env, guidelines-prompt.md, prompts/}` |
| required top-level keys | `repo`, `work_sources` (≥1), `belt` (≥1) — note `belt` is singular but holds a list |
| state | `~/.local/state/herdr-factory/` — `herdr-factory.db`, `logs/`, `<repo>/logs/<date>.log` |
| code | `~/.local/share/herdr-factory/` (hard-reset by auto-update — never edit it) |
| credentials | per-repo `env`, `chmod 600`: `JIRA_EMAIL`+`JIRA_API_TOKEN` · `SENTRY_AUTH_TOKEN` · `GITHUB_TOKEN` (optional; `gh` login otherwise). No global secrets file. |
| server | `127.0.0.1:8765` (`HERDR_FACTORY_PORT`), OpenAPI at `/doc`, Swagger UI at `/ui` |
| several machines | `herdr-factory fleet [--json]` — every run on every machine, read in parallel over an SSH forward per remote box (nothing to configure: it is this machine plus every *enabled* `herdr machine list` entry). The **TUI Dashboard reads the same fleet**: a header per machine, an `@machine` badge per repo row, `m` to filter to one machine, and every key routed to the machine that owns the run (its confirmation names it). A machine that does not answer reads **`unverifiable` with the time it last answered**, keeping its last known rows — never as having no runs, so never claim an item because it was missing from a read where its machine was unverifiable |
| default pipeline | `steps: [{ type: work }, { type: review }, { type: pr }]` |
| step budgets | `work` 5400s · `evidence` 2400s · `review` 1800s · `pr` 3600s; fallback `limits.step_budget_seconds` 3600 |
| key defaults | `max_active_workspaces` 3 (per source: 2) · `max_bounces` 6 · `tick_interval_seconds` 60 · `stall_seconds` 2700 · `idle_nudge_seconds` 300 (re-prompt an idle step agent once, before any watchdog; `0` off) · `layout_wait_seconds` 600 · `max_capture_attempts` 5 |
| a step with no `tab`/`pane` | gets a pane spawned for it — except `evidence`, which is **silently skipped** without one, and the first step of a `default_layout` belt, which config-load **rejects** (that pane's new tab would cost the belt its layout) |
| a shared layout, short belt | a factory-claimed worktree builds only the tabs **its** belt's steps target (plus the `setup:` tab and any tab with a pane carrying its own `prompt:`) — so a `work`→`pr` belt on a four-tab ship layout gets two tabs, not four idle ones. A hand-created worktree gets every tab. See references/layouts.md |
| a layout pane a step targets | declares its own agent (`agent: claude` + `agent_args: […]`); herdr starts it and waits until it is ready for input. Config-load rejects a target pane that starts no agent |
| on merge | each source decides: `jira` stays **silent** unless you set `jira.status.done`; `github_issues` **closes the issue** as completed (`close_on.merged`, default `true`; never for a `kind: pull_requests` item); `sentry` posts a PR-link comment (`on_merge`, default `comment`). A belt `effects` entry overrides. |
| host-wide limits | optional **host-local** `~/.config/herdr-factory/machine.yml` (gitignore it in a shared config repo): `max_active_workspaces` across all repos + `min_free_memory_mb` claim floor. Gates new claims only; `status`/`doctor` show it; `reload` re-reads it. Also `layout_hook.ignore_pane_labels` (default `[Sidebar]`) — pane labels the layout hook's freshness gate discounts, so a herdr plugin that adds a pane to every new tab doesn't stop every layout from building. See references/config-reference.md §3.14 |
| several factories, one source | one factory per source backend by default (they'd double-claim). `jira`/`github_issues` accept `claim_guard: { enabled: true }` in **every** sharing factory — claims arbitrate on the item's comments (lowest comment id wins); a host releases its OWN stale claims (run gone locally) each tick, but ANOTHER host's dead claim is never auto-cleared → post `[herdr-factory release id=<run> host=<host>]` by hand. See references/work-sources.md |
| spawned agents | `claude --dangerously-skip-permissions` unless an `agent:` block says otherwise (that block drives SPAWNED panes; a layout pane names its own agent) |
| herdr floor | **≥ 0.7.5** — `doctor` enforces it from `herdr-plugin.toml`'s `min_herdr_version`; `--deep` also checks the CLI can speak the running server's protocol |
