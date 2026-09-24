# Troubleshooting a herdr-factory

Symptom → diagnosis → fix playbooks for a factory that is stuck, silent, parked, or slow.

Answers these questions:

- Nothing is being claimed — which gate is holding it?
- This run is parked for attention. What raised it and how do I clear it?
- The agent says it finished but the run hasn't moved.
- I edited `config.yml` and nothing changed.
- `doctor` is all green but the factory does nothing.
- Where are the logs, and which log has the answer?
- What can I safely read (or edit) in the SQLite DB?
- Which nudge should I try, and which one destroys work?
- How do I stop one run without throwing its work away?

Everything below is verified against `src/`. Sibling references: config keys in
[config-reference.md](./config-reference.md), engine mechanics in
[architecture.md](./architecture.md), commands in [cli.md](./cli.md), layouts in
[layouts.md](./layouts.md).

---

## 1. Triage — run these before theorising

In order. Each step rules out a whole class of cause; stop when one produces a finding.

| # | Command | Rules out / establishes |
|---|---|---|
| 1 | `herdr-factory --repo <r> doctor --deep` | Install, service, server liveness, config validity, source auth + live health, evidence publisher, **orphaned dev servers** (amber: listeners under `~/.herdr/worktrees` no live, unparked run owns — the `orphaned dev servers` row in §4). `--repo` is a global option — `herdr-factory --repo <r> doctor` and `herdr-factory doctor --repo <r>` both work; without it, **zero** repo checks run (§5) |
| 2 | `herdr-factory --repo <r> status` | Belts (priority + `INACTIVE`), sources, every active run with phase/step, live herdr pane state per run, per-step ✓/● ticks, plus `server:` / `supervisor:` lines. |
| 3 | `curl -s 127.0.0.1:8765/health \| jq '.repos'` | **Is this repo being served, and is its tick loop alive?** `doctor` does not check either (§5). Look at `name`, `lastTickAt`, `tickStale`. |
| 4 | `herdr-factory --repo <r> explain <KEY>` | **The plain-language "why is this run waiting"**: the phase/park story, every pending retry with its next attempt time, armed clocks, bounce counters, ready-made next commands — plus a warning when no server is ticking the repo. Reads the DB directly (works with the server down). |
| 5 | `herdr-factory --repo <r> timeline <KEY>` | What the run actually did — the domain event log (`claimed`, `step_spawned`, `layout_wait_retry`, `bounced`, `attention`, `resumed`, `error`, …). |
| 6 | `curl -s '127.0.0.1:8765/repos/<r>/obligations?key=<KEY>' \| jq` | The RAW form of `explain`: undelivered write-backs, pending evidence uploads, an unconsumed agent signal, the pending human question with its poll clock, live ledger rows, and every armed guard with live facts + its `rescue` class. Read-only, lock-free. Reach for it when you need exact facts (clock epochs, intent ids) rather than the narrative. |
| 7 | `herdr-factory --repo <r> logs 300` | Today's engine log: the claim-gate lines, watchdog deferrals, intent deferrals, lock-lost errors. Only today's file (§6). |
| 8 | `herdr-factory --repo <r> eligible` | What this repo's **active** belts would claim right now (JSON, per-belt labels **and** `match` applied — so it agrees with the dashboard). The **only** live source query — the dashboard and `GET /eligible` answer from the last tick poll instead (never a live call), so they can be up to one `poll_interval_seconds` behind this, and empty until the server's first tick. A dashboard with no eligible rows right after a restart is therefore normal, not a broken source. |

Two facts that shape all triage: **the CLI reads config and the DB fresh on every invocation; the
resident server does not** — so `doctor`/`status`/`eligible` can be perfectly green while the server
runs stale config or isn't serving the repo at all (cross-check with `/health`). And the HTTP port is
`HERDR_FACTORY_PORT` else `8765`, host always `127.0.0.1`, with Swagger UI at `/ui` and OpenAPI at
`/doc`.

### Symptom index

| Symptom | Playbook |
|---|---|
| No runs start; `eligible` shows work | [2.1 nothing is being claimed](#21-nothing-is-being-claimed) |
| A run sits in `attention` | [2.2 a run is parked](#22-a-run-is-parked-for-attention) → §3 table |
| Phase `claiming`/`running` but no agent pane | [2.3 a step never starts](#23-a-step-never-starts--the-pane-never-appears) |
| Agent finished; phase/step unchanged | [2.4 finished but not advancing](#24-the-agent-finished-but-the-run-didnt-advance) |
| Same step re-runs over and over | [2.5 bounce loop](#25-a-step-keeps-getting-bounced) |
| Phase `reviewing` forever | [2.6 stuck in reviewing](#26-a-run-is-stuck-in-reviewing) |
| Phase `waiting_for_human` forever | [2.7 stuck waiting_for_human](#27-a-run-is-stuck-in-waiting_for_human) |
| PR is open, nothing happens next | [2.8 PR opened, then silence](#28-the-pr-opened-but-nothing-happened-after) |
| Evidence links 404 / never appeared | [2.9 evidence never published](#29-evidence-never-published--links-broken) |
| Edited config.yml, no effect | [2.10 config changes not taking effect](#210-config-changes-arent-taking-effect) |
| Server answers `/health`, nothing ticks | [2.11 wedged tick](#211-the-server-is-up-but-nothing-ticks-wedged-tick) |
| One repo works, another is ignored | [2.12 a repo silently isn't served](#212-a-repo-silently-isnt-being-served) |
| A source used to pick up work, now doesn't | [2.13 a source stopped picking up work](#213-a-source-stopped-picking-up-work) |
| Everything is slow / throttled | [2.14 slow or rate limited](#214-everything-is-slow--rate-limited) |
| Linux: `ensure-up: started serve` every tick, `doctor` says server not running | [2.15 systemd kills the server](#215-linux-the-supervisor-starts-serve-every-tick-but-it-never-stays-up) |
| I want to abandon a run but keep its work | [9.1 stopping a run without losing its work](#91-stopping-a-run-without-losing-its-work) |

---

## 2. Playbooks

### 2.1 Nothing is being claimed

**Means**: Phase B of the tick either never ran, or walked the belt list and skipped every item.
Every skip except one is logged; walk the gates in the order the engine checks them.

```sh
herdr-factory --repo <r> logs 200          # the claim-gate lines
herdr-factory --repo <r> eligible          # what the sources offer
curl -s 127.0.0.1:8765/health | jq '.repos'
```

| # | Gate | Evidence | Fix |
|---|---|---|---|
| 1 | **The server isn't ticking this repo** | repo absent from `/health .repos[]`, or `tickStale: true` | §2.12 / §2.11 |
| 1b | **Config on disk doesn't load** | `config invalid: <error> — not claiming` each tick; the TUI's "needs you" and the repo's problems show `config invalid: … — claims paused until the file loads`; `doctor`'s `config loads + sources buildable` ✗ says the same | The server runs on its in-memory config but refuses to claim while `config.yml` doesn't load with the installed code (typically a key a newer version added — update this host, or remove the key). Fix the file: the next tick claims again (`config loads again — claims resume`), no restart or `reload` |
| 2 | **Repo at its workspace cap** | `at capacity (3/3 working, 1 idle/parked)` — Phase B returns immediately | Raise `limits.max_active_workspaces` (default **3**), or tear down/finish a run. Parked and `waiting_for_human` runs, and an idle PR watch, hold **no** slot (see Q1b) |
| 2b | **Machine gate** (`machine.yml`) | `machine at capacity (n/N)` / `low memory: <free> MB < <min> MB — not claiming` (logged once when it engages, in whichever repo's log noticed) / `machine claim lock held (another repo is claiming) — claims deferred N ticks (machine claim lock)`; `status` prints the `machine:` line, plus `⏳ claims deferred N ticks (machine claim lock)` while N > 0 (`explain <key>` says the same for an unclaimed key) | Host-wide, across every repo: raise `max_active_workspaces` / lower `min_free_memory_mb` in `<configDir>/machine.yml`, then `herdr-factory reload`; or finish/tear down a run in **any** repo. `doctor` shows the limits in effect. Phase B waits half a tick interval (floor 10 s) for the lock, so a deferral means a holder ran long; a rising N on ONE repo is that repo being starved — check what the other repos' claim sections are doing |
| 3 | **Per-tick admission cap** | claims stop at 10 in one pass | `limits.max_claims_per_tick` (default **10**); the rest come next tick. Rarely the real cause |
| 4 | **Belt inactive** | `belt <name>: inactive — skipping (no new claims; in-flight runs continue)` | Set `active: true` on the belt (checked *before* polling) |
| 5 | **Belt's source not configured** | `belt <name>: source "<s>" not configured — skipping` | Fix `belt.source` to a configured source `name` |
| 6 | **Source at its own cap** | `belt <name>: source "<s>" at its concurrency cap (2) — skipping` | Per-source `max_active_workspaces` defaults to **2**, not 3 |
| 7 | **Poll window not elapsed** | no poll line at all for that source this pass | Engages **only** when the source's `poll_interval_seconds` > `limits.tick_interval_seconds`. The last-poll time is **in-memory on the server**, so `herdr-factory --repo <r> tick` (one-shot) always polls — if the one-shot claims and the server doesn't, this is it |
| 8 | **Source auth paused** | `<src>: work source not authenticated (<reason>) — pausing its claims + status write-backs until re-authenticated` | The poll throws, degrades to `[]`, no claims. `herdr-factory --repo <r> auth status`, `doctor --deep`. Auto-resumes the moment any call to that source succeeds |
| 9 | **Source query failing (non-auth)** | `<src>: eligible query failed: …` | Also degrades to `[]` so one source can't starve others. `doctor --deep` names the real HTTP error |
| 10 | **Nothing is eligible** | `eligible` prints `[]` for that belt | Source-side. github_issues: the trigger **label is consumed at `in_development`** — re-add it to retry an item; the label must exist in the repo (case matters in config, GitHub's namespace is case-insensitive); and check `kind` — a default source skips every PR, a `kind: pull_requests` one skips every issue. jira: `status.todo` name/board id/project key. local_markdown: folder contents. sentry: project slugs. See [work-sources.md](./work-sources.md) |
| 11 | **Already claimed** | silent skip | Dedup is per **(repo, source, key)** — the same key in two sources is two independent runs |
| 11b | **Claimed by another factory** (`claim_guard` on) | `<belt>/<KEY>: claimed elsewhere by <host> (run <id>) — skipping` | Another host holds an open claim comment on the item. If that host is dead, post `[herdr-factory release id=<id> host=<host>]` on the item — another host's claims are never reaped (a factory clears only its own, for runs gone from its DB). See [work-sources.md](./work-sources.md#several-factories-on-one-source-claim_guard) |
| 12 | **Undelivered write-back veto** | `<KEY>: skipping claim — a status write-back to "<src>" is still pending` | The item's eligibility is known-stale; this is the only thing stopping merged work being re-claimed and re-done. Fix the write-back (§8) — do **not** work around it |
| 13 | **`match` rejected it** | **no log line at all** (a falsy `match` is a silent skip) | `eligible` lists items *before* `match` runs, so "listed but never claimed and no other log line" ⇒ the predicate said no. A predicate that *throws* logs `belt X: match predicate threw for KEY: …` |

Belts are walked in `priority` order (lower first, ties keep config order); the first belt whose
`match` accepts an item claims it.

### 2.2 A run is parked for attention

**Means**: `phase = 'attention'`. The routing key is `runs.attention_reason_code`.

```sh
herdr-factory --repo <r> status                                  # the parked runs
herdr-factory --repo <r> explain <KEY>                           # the park narrated: reason, rescue, next commands
herdr-factory --repo <r> triage <KEY>                            # or hand it to an agent, pre-briefed (--print to just emit the briefing)
herdr-factory --repo <r> timeline <KEY>                          # the `attention` event + its detail
curl -s '127.0.0.1:8765/repos/<r>/obligations?key=<KEY>' | jq '.run, .watches'
```

`explain` narrates the park's reason code and its rescue; `obligations` is the raw form, reporting
each armed guard's `rescue` class: `terminal-signal` (a genuine `step-done` or
`bounce` un-parks it automatically on the next pass), `respawn` (bounded auto-retry),
`human` (only `resume`/`teardown`), `none`. Then route by code using **§3**.

While parked the operator is re-notified every `limits.attention_renotify_seconds` (default 3600)
with ``<reason> — resume with `herdr-factory --repo <repo> resume <KEY>` or tear it down. (parked
~Xmin)``. The `~Xmin` is measured from `updated_at`, which the re-notify itself bumps — after the
first hour it reports roughly the renotify window, **not** total park duration. Use the `attention`
event's timestamp in the timeline for real park age.

`attention_reason_code` is **never cleared** — only trust it while `phase = 'attention'`.

### 2.3 A step never starts / the pane never appears

**Means**: the step's prompt was never dispatched to an agent. `run_steps.dispatched_at IS NULL`.

```sh
herdr-factory --repo <r> logs 200 | grep -E 'waiting for layout pane|re-arming the wait|worktree'
herdr-factory --repo <r> timeline <KEY>       # worktree_created · layout_applied · layout_apply_failed · layout_wait_retry
curl -s '127.0.0.1:8765/repos/<r>/obligations?key=<KEY>' | jq '.watches.guards'
```

Branches:

| Finding | Meaning | Fix |
|---|---|---|
| Phase `claiming`, no `worktree_created` event | herdr never created the worktree | `herdr-factory doctor --deep` (`herdr (daemon responds)`); `herdr workspace list` by hand; check `repo.path` is the **main** checkout |
| `layout_apply_failed` event, or no `layout_applied` at all | the per-belt layout never got built — usually the factory isn't linked as a herdr plugin | `herdr plugin link ~/.local/share/herdr-factory`. Nothing in `doctor` checks this. A failed build also raises a desktop notification and leaves the reason in `herdr plugin log list --plugin herdr-factory`. See [layouts.md](./layouts.md) |
| Panes exist but a pane's agent never came up | `could not start <kind> in <pane>` in the plugin log + a "agent did not start" notification | That agent's herdr integration isn't installed (`herdr integration install <kind>`), or the pane never reached a shell prompt (a preceding `not back at a shell prompt` warning). The rest of the layout is left standing — it is never torn down over one pane |
| …and that pane is the layout's **setup pane** (`setup: true` **and** `agent:`) | this used to be fatal — the setup wrapper ended in `exec $SHELL -i` and herdr will not adopt an agent into that re-exec'd shell (it accepts `agent start`, then times out after 60s). **Fixed**: an agent setup pane is left a plain shell and the setup command is run *in* it | If you still see it, the factory is behind — check `herdr-factory doctor` (auto-update) and that `layout "<id>": running setup in <pane>` appears in the log. Regression test: `test/e2e/scenarios/layout-setup-on-agent-pane.e2e.ts`; more herdr-adoption facts in [testing.md](./testing.md) |
| …and NO `layout_applied` event exists at all | the layout was never built: the belt's **first** step had no `tab`/`pane`, so its dedicated pane added a tab before the out-of-process hook's first look, and the hook only builds into a FRESH 1-tab/1-pane worktree. The decline reaches no event and no repo log — only `herdr plugin log list --plugin herdr-factory` (`not a fresh 1-tab/1-pane workspace; skipping`) | Give the **first** step a `tab`/`pane` from the layout (later steps may stay untargeted — the layout exists by then), or drop the layout from that belt. Not reachable on a belt with `default_layout`: that shape is now refused at load (see below). Surviving causes: a belt with **no** `default_layout` whose layout comes only from a `layout_matching` rule, a hand-built worktree, or a second layout plugin winning the race ([layouts.md](./layouts.md)) |
| …and you (or a plugin) opened a pane/tab in the run's brand-new workspace before the layout appeared | **Fixed**: this used to decline the build for good (`not a fresh 1-tab/1-pane workspace; skipping` + a `decided` marker) while the run waited out its layout window. A factory run's worktree is now built even when it isn't fresh — the layout arrives as extra tabs beside what you opened (`layout_applied` with `detail.appended: true`) | Nothing. If you still see it, the factory is behind — check `herdr-factory doctor` (auto-update) |
| …and it is **every** run on this host, whose herdr runs a plugin that adds a pane (a sidebar) to each new tab | that pane makes every new workspace 2 panes. The hook discounts plugin panes by LABEL — `machine.yml`'s `layout_hook.ignore_pane_labels`, default `[Sidebar]` — so a plugin using any other label still declines every build of a hand-created worktree (a run's worktree gets its layout as extra tabs beside the plugin's) | Add that pane's label (from `herdr pane list --workspace <ws>`) to `layout_hook.ignore_pane_labels` in `<configRoot>/machine.yml`. To rescue a workspace already declined: close the plugin's pane, `rm -rf <state>/layout-hook/decided/<ws>`, and let the next focus event re-fire the hook |
| A tab from the layout wasn't built at all, and the repo log says `layout "<id>": belt "<b>" targets no step at tab(s) <titles> — not building them` | **Intended**: a factory-claimed worktree builds only the tabs its own belt's steps target, so a short belt reusing a longer belt's layout doesn't get idle terminals and idle agents (`layout_applied` carries `detail.prunedTabs`) | Nothing to fix if that tab was for another belt's steps. To keep an untargeted tab, give it work of its own — the layout's `setup: true` pane, or a pane with its own `prompt:` — or point a step at it. Hand-created worktrees always get every tab ([layouts.md](./layouts.md)) |
| `<KEY>: <step> waiting for layout pane <tab>/<pane> (Ns/600s)` | the configured tab/pane title does not exist in the running layout, or its agent isn't **idle** | Fix the step's `tab`/`pane` (set together, or both omitted) to match the layout's real titles. Config load validates step→pane allocation only against `default_layout` |
| `… not up after Ns — re-arming the wait (retry i/3)` | the bounded respawn budget is being spent | Wall-clock bound before a park is `(1 + 3) × layout_wait_seconds` = 40 min at defaults. The counter is **shared** between the in-place re-arm and the post-park rescue |
| Parked `layout_wait_timeout` | budget spent | If the reason has a `— layout hook: …` suffix (present only when the build failed), read it first (`explain` leads with it) — e.g. `no factory repo config for … (repo "<r>" config failed to load: …)` means fix the config. Then fix the layout and `resume` (refunds the 3 credits) |
| A run's workspace never got its layout because the repo's config didn't load when it was created | the hook skipped it without settling it (no `decided` marker) | Fix the config. The next focus builds it, and a waiting run's next window expiry builds it itself (`… has none of layout "<id>"'s tabs — building it`) — no `resume` needed while budget remains |
| A pane exists and is `working` | a fresh pane must be `idle`; a reused pane that is `working` is never queued into | Let it finish, or `resume` after it goes idle |
| `<KEY>: prompt to layout pane <id> was not confirmed; will retry`, repeating, while the agent is visibly working — and the agent's queue fills with identical copies of the prompt | herdr's state detection is per-harness and this one never flips (seen with `cursor-agent` on Linux: it works while `herdr pane list` still says `agent_status: idle`), so the `--until working` handshake times out every tick and the pass is never marked dispatched | **Fixed**: a stalled handshake now falls back to the pane's `revision` (herdr's terminal-content counter), so a pane that visibly reacted counts as dispatched and is never re-prompted. If you still see it repeating, the pane is producing no output herdr can see — check `herdr integration status` for that harness's kind and that `herdr agent list` reports a `revision` for the pane. See [layouts.md](./layouts.md) |
| Step has **no** `tab`/`pane` | the step spawns its own dedicated pane via `agentStart` — layout-wait never applies, and a busy dedicated pane is not deferred (the message queues) | If no pane appears at all: the agent binary isn't on the **service** PATH (§5, last row) |

**Caught at load vs. only at runtime.** A belt that sets `default_layout` no longer loads when its
first *surviving* step is untargeted (surviving: a bare `evidence` step is dropped first, so the check
lands on the step that actually dispatches first):

```
belt "<b>" sets default_layout "<L>", but its first step "<step>" has no `tab`/`pane` — that step spawns a dedicated pane, whose new tab makes the layout hook skip the build ("not a fresh 1-tab/1-pane workspace"), and every later layout-targeted step then parks with `layout_wait_timeout`. Give the first step a tab/pane in "<L>", reorder so a layout-targeted step runs first, or remove default_layout from this belt.
```

reported at `belt.<i>.steps.<j>.pane`, `<j>` being the offending step's index in the **written** steps
list. Also caught at load and scoped to `default_layout` the same way: a target the layout doesn't
define, a targeted pane that starts no agent, and a targeted pane carrying its own `prompt` (two steps
of one belt sharing a pane is rejected on **any** belt, layout or not).
Everything else stays a runtime symptom — a title that exists only in a `layout_matching` layout, a
`layout_matching`-only belt whose rule intercepts a factory claim (same silent lost-layout failure as
the row above, unenforceable at load because those rules commonly serve hand-created worktrees), a
missing plugin link, and an agent harness herdr can't adopt.

### 2.4 The agent finished but the run didn't advance

**Means**: `step-done` was rejected, or the advance is gated on something else.

```sh
herdr-factory --repo <r> timeline <KEY> | grep -E 'step_done|signal_rejected|attention'
herdr-factory --repo <r> logs 100
```

| Branch | Signature | Fix |
|---|---|---|
| Wrong pass | `stale step-done for pass N — the <step> step is on pass M; finish the current pass and run its own step-done command` | The step was re-entered (bounce/re-advance) and the pane holds an old prompt. Read the freshly rendered `.memory/herdr-factory/prompt-<step>.md` and run **its** command |
| Not the active step | `"X" is not the run's active step ("Y") — signal ignored` | Signal the step the run is actually on |
| Already recorded | `step "X" is already recorded done — nothing to do` | Benign; the advance happens on the next pass |
| Run was busy | `<KEY>: busy (nudge in flight) — skipped this pass` | Self-heals next tick |
| `rs.done = 1` but phase `attention` | a watchdog parked it just before/after the signal | If the code has `rescue: terminal-signal`, the next pass un-parks and advances automatically. Otherwise `resume` |
| PR step, draft PR | `prReadyForReview` needs a **live non-draft** (or MERGED) PR at the belt's terminal PR-opening step | Mark the PR ready for review, or let the step's own `step-done` gate it |
| Read-only step committed | parked `read_only_violation` at the `pre_advance` stage — the advance is blocked *before* it happens | §3 |
| Dirty tree under a read-only step | `the <step> step cannot finish on this tree — the worktree has uncommitted changes. …` + the diff stat, **exit 1** (the tree guard) | Someone edited the worktree without committing — usually a previous step's agent prompted again after its `step-done`. Commit or revert it on the step that owns it, then re-run the step's own `step-done`. A `rework <KEY> <step> --note …` is the right move when the edit means the work must actually be redone |
| One extra tick before the visible change | the last step of a non-`watch_pr` belt advances into `teardown("completed")`; a merged PR at the terminal step goes `running → reviewing → (next pass) teardown` | Normal |

`resume` does **not** clear `run_steps.done` (only a human-reply resume does), so resuming a run
whose step is already done advances it on the following pass.

### 2.5 A step keeps getting bounced

**Means**: a later step keeps rejecting the work and rewinding to an earlier one.

```sh
herdr-factory --repo <r> timeline <KEY> | grep bounced        # detail: fromStep, toStep, bounces, notePath, reason (first 500 chars)
# and read the feedback the bouncer wrote:
cat <worktree>/.memory/herdr-factory/feedback-<toStep>.md
ls  <worktree>/.memory/herdr-factory/feedback-*-addressed-pass*.md
```

- The counter is `guard_counters.bounce_cap` keyed on the bounce **TARGET** step (Q6). Cap is
  `belt.max_bounces ?? limits.max_bounces` (default **6**; `0` disables bouncing); exceeding it parks
  `bounce_limit`, which is human-only.
- A bounce rewinds **every** completed step between the target and the bouncer (so an intermediate
  evidence step really re-captures), re-bases their clocks, and bumps the target's `pass`.
- Fix the *cause*, not the cap: the feedback files say what the reviewer keeps rejecting. Usually the
  target repo lacks the guidance/skills the shipped prompts defer to
  ([target-repo.md](./target-repo.md)) or the review prompt is over-strict
  ([prompts.md](./prompts.md)). `resume` from a `bounce_limit` park refunds `bounce_cap` for **every**
  belt step, but that just buys another 6 rounds of the same loop unless something changed.

### 2.6 A run is stuck in `reviewing`

**Means**: usually **not** stuck. `reviewing` has **no time limit** (there is no `watch_hours`), and
a PR with nothing actionable does zero herdr calls and holds **no** slot by design.

```sh
gh pr view <n> --json isDraft,mergeable,statusCheckRollup,reviewDecision
herdr-factory --repo <r> timeline <KEY> | grep -E 'pr_opened|resolver_woken|pr_green'
```

The watch wakes a resolver agent only when `unresolved > 0 || failing > 0` **and** the review
signature differs from the recorded one.

| Branch | Signature | Fix |
|---|---|---|
| Nothing actionable | no unresolved threads, no failing checks | Correct. It waits for a human to merge or close — **the factory never merges**. If the checks have all *concluded* green you also got one "ready to merge" notification (`pr_green` in the timeline) |
| Green PR, no "ready to merge" notification | **the pr step has not signalled `step-done` yet** (it opened the PR and is still polling CI/bot reviews — look for `step_done` with `step: pr` in the timeline), a check has not concluded yet (`pending > 0` — "not failing" is not green), the PR is a draft, a review thread is unresolved, or the operator was already told about **this** green (the mark is the head commit; it clears when the PR goes non-green, and a push is a new green) | `gh pr checks <n>` for a still-running check; `gh pr view <n> --json headRefOid` vs the `pr_green` event's `head` for the mark; otherwise nothing to fix — it fires once per green head |
| Green PR went back to `running` at `evidence` (a `rework` event with `by: "pr_watch"`) | a push after the evidence (resolver or pr step) changed code; the gates re-run at the new head, then the pr step relinks the evidence | Normal. `explain <KEY>` shows the evidence SHA against the PR head and the changed files. Docs/Markdown/translation-only pushes never trigger it |
| Actionable but no `resolver_woken` | the signature already matches `run_products.signature` (round considered handled), or `wakeResolver` found no pane to use | `resume` — it clears `lastThreadSig` + `resolverActive`, so the next tick re-wakes the resolver |
| `resolver idle — PR #n watch no longer holds a slot` | the resolver pane went idle; the round is handed back to watching | Normal |
| PR merged, run still active | teardown happens on the **next** pass | Wait one tick |
| PR closed | parks `pr_closed` | Reopen the PR then `resume`, or `teardown` |

### 2.7 A run is stuck in `waiting_for_human`

**Means**: a question is posted at the source and the reply poll hasn't found an answer.

```sh
herdr-factory --repo <r> timeline <KEY> | grep -E 'human_question|human_reply'
curl -s '127.0.0.1:8765/repos/<r>/obligations?key=<KEY>' | jq '.intents.humanQuestion'
herdr-factory --repo <r> logs 100 | grep 'waiting for human reply'
```

The poll runs on a flat 30-second cadence — log line
`waiting for human reply to question #N (next poll in Xs)`.

| Branch | Signature | Fix |
|---|---|---|
| Never posted | `human_questions.external_id IS NULL`; log `human question #N post deferred: …`, then `human question #N still not posted: …` each pass (`question recorded; posting deferred:` is the ask-human command's own output, not a log line) | The engine re-posts every pass. Fix source auth/permissions; the question text is in the DB and in `.memory/herdr-factory/human-question-<step>.md` |
| Reply exists but wasn't seen | the poll matches on `externalId` + `externalCreatedAt` | Reply as a **new comment** on the item (not an edit of the question), then wait one poll window |
| Parked `human_poll_failing` | 10 consecutive poll **throws** (auth failures don't count) | `doctor --deep` the source, then `resume` (fresh window, error run cleared) |
| Parked `human_wait_missing_question` | phase says waiting, no pending question row | Fix `run.step` or `teardown` |
| Pending question with **no** `human_reply_poll` intent (Q9 `poll_intent_id IS NULL`) | the clock's only home is missing: `nextPollAt` reads 0, so it polls every pass and the miss bookkeeping throws — you see a repeating `error` event `recordHumanPollMiss: question N has no poll clock` | A real human reply still lands and resolves it. Otherwise `teardown` and re-claim; `resume` cannot re-arm a missing clock |
| PR merged while parked | merge outranks the park — the run tears down `merged` | Normal |
| **The step already finished** — `run_steps.<step>.done = 1` while the phase still says waiting | log `step-done <step> recorded` followed by more `waiting for human reply` lines | **Should self-heal**: the next pass un-parks and advances (`resumed` event, reason `step_done_after_human_park`, plus `human_question_moot`). If it does *not*, the factory is running code older than that rescue — `herdr-factory update`, then `tick` |

A terminal signal from the parked step **outranks the wait**: a `step-done` (or a `bounce`) from the
step that asked means the agent got past the blocker on its own, so the run un-parks and follows it,
closing the question as `answered` with a synthetic answer + a `human_question_moot` event and a
"no answer needed" note on the item. A reply that arrives afterwards is never read — check
`human_questions.answer` before assuming the human's guidance was applied.

A run parked out of the human loop with its question still pending returns to `waiting_for_human`
on `resume` (with a fresh poll window), not to `running` — resuming to `running` would orphan the reply.

### 2.8 The PR opened but nothing happened after

**Means**: the `running → reviewing` handoff didn't fire, or fired and there is nothing to do.

```sh
herdr-factory --repo <r> timeline <KEY> | grep -E 'pr_opened|torn_down'
sqlite3 "$DB" "SELECT * FROM run_products WHERE run_id = <id>;"
```

- Handoff fires on **PR adoption** at the belt's **terminal** PR-opening step — not on `step-done`.
  A **draft** PR keeps the `step-done` gate; a MERGED PR always hands off.
- No `pr_opened` event + no `run_products` row ⇒ the PR was never adopted: the step's `opens_pr`
  isn't set, or the PR's head branch is neither the run's current `branch` nor its `worktree_name`
  (first-sighting adoption tries both with `prForBranch`, then polls `prByNumber`). A **closed** PR is
  only acted on when it is *ours* (`pr.number === run.prNumber`), so a stale closed PR on a reused
  branch can't disturb a fresh attempt — and a discovered PR **older than the run** is skipped
  outright (`ignoring PR #N on <branch> — it predates this run`), which is what stops a re-claim, or a
  branch renamed to a convention name, from adopting a previous attempt's merged PR. Check the run's
  two names: `sqlite3 "$DB" "SELECT worktree_name, branch FROM runs WHERE id = <id>;"` against
  `gh pr view <n> --json headRefName`.
- The agent renamed the branch and the run kept up? That is supported: `set-branch` (or a bare
  `git branch -m`, followed on the next pass) moves `runs.branch`, leaving `worktree_name` frozen —
  look for a `branch_changed` event on the timeline. A rename **after** the PR is open is refused;
  if one happened by hand anyway, the PR was already adopted by number, so the watch is unaffected —
  but the pushed head is now orphaned and only a human can delete it.
- No step on the belt produces `pull_request` (no `pr` step) ⇒ the derived `watchPr` is false (it is
  **not** a config key — `steps.some(… produces "pull_request")` in `src/config.ts`), so the last
  step's `step-done` completes the run (`completed`) and no review watch exists. Add a `pr` step to
  get one. Otherwise it's §2.6.

### 2.9 Evidence never published / links broken

**Means**: the URLs were printed up front (they are deterministic for `s3`/`local`) but the bytes
never landed, or the publish intent is stuck.

```sh
herdr-factory --repo <r> doctor --deep      # `evidence publisher (<p>)` + `evidence uploads`
curl -s '127.0.0.1:8765/repos/<r>/intents?kind=evidence_publish' | jq
herdr-factory --repo <r> timeline <KEY> | grep -E 'evidence_uploaded|evidence_upload_failed'
```

| Branch | Signature | Fix |
|---|---|---|
| AWS creds expired | recorded on the problem ledger within ~5 min (the prePass probe — the repo row turns red before any upload fails); `doctor`: `<n> stuck on AWS creds — refresh AWS credentials …`; intent `error_class = 'auth'`; the throttled notify is also reported into the run's own pane while the run is live | Refresh them. Recovery is automatic (the publish kind's pre-pass probes liveness every tick — even while the row is waiting or suspended — and re-queues: `evidence publish: creds recovered — re-queued N stuck upload(s) for immediate retry`). To force it now: `herdr-factory --repo <r> retry-now` (or `s` on the TUI board, or `POST /repos/<r>/intents/recover` `{"causeScope":"publisher:s3"}`) |
| **You logged in and it's STILL auth-stuck** | `doctor --deep` says the publisher is **writable** (a fresh process resolves creds fine) while the server keeps deferring the same row | The server can't see your credentials, or is holding a stale view of where they come from. Two distinct causes — check both:<br>1. **A credential helper the SDK can't read.** The resident server is launchd-spawned: creds `assume`/`aws-vault` export into your *shell*, and granted's SSO token in the **macOS keychain**, are both invisible to it. Prove it with `env -u AWS_ACCESS_KEY_ID -u AWS_SESSION_TOKEN aws sts get-caller-identity --profile <p>` — "Token has expired and refresh failed" means the server sees the same. Fix: a **dedicated** `credential_process` profile (below) and point `evidence.profile` at it.<br>2. **A pre-`ignoreCache` server.** Builds before that fix memoized `~/.aws/config` for the process's whole life, so a profile added/repointed while it ran never resolved. `herdr-factory restart` (and `update` to get the fix). |
| Permanent failure | `error_class = 'permanent'`, event `evidence_upload_failed`, notify `herdr-factory: <key> evidence publish failed`, amber `⚠` on the run's TUI dashboard card. **The run is untouched — this is never a park** | `doctor --deep` shows the real reason (bucket/region/access-denied/command exit) |
| Transient retrying, then **suspended** | `<n> pending — retrying (last: …)`, notify is deliberately **silent** while retrying. After 10 failed attempts (flat 30 s apart) the row **suspends**: `intent_suspended` event, an error log (`… intent SUSPENDED after 10 failed attempts: …`), an unthrottled notification (`herdr-factory: <repo> — job suspended`), a report into the run's own agent pane (when the run is still live), and a red problem entry on the repo's TUI row | Nothing auto-recovers a `transient` row (only `auth` is probed), so once you have fixed the cause use `herdr-factory --repo <r> retry-now [KEY]` — or `s` on the TUI board — to clear the suspension (fresh 10-attempt window) and flush |
| Dropped at teardown | `<KEY>: N evidence upload(s) dropped at teardown — bytes never reached S3 (likely SSO was down through merge)` | Unrecoverable; the worktree is gone. Fix creds before the next run |
| Worktree removed first | intent failed with `evidence dir gone (torn down before publish)` | Same |
| No files | `evidence-upload: no files in the evidence dir — nothing to publish` | The capture step wrote nothing; see the capture prompt/skill |
| `command` publisher, no links | `publish command printed no URLs to stdout (expected one public URL per file)` | The command must print one absolute URL per line (scheme required); `command` cannot pre-compute URLs, so links only appear after a success |

Note `doctor`'s `evidence uploads` count **saturates at 100**, and the row it labels `last:` is
actually the **oldest** of the returned rows.

### 2.10 Config changes aren't taking effect

**Means**: the resident server holds the config it built at boot (or at the last `/reload`). The CLI
builds fresh config every invocation — that asymmetry is the trap.

```sh
herdr-factory --repo <r> doctor           # does the file even load?
herdr-factory reload                      # then read the response body
curl -s 127.0.0.1:8765/health | jq '.repos[].name'
```

| Branch | Signature | Fix |
|---|---|---|
| Never reloaded | `/health` shows the repo but behaviour is old | `herdr-factory reload` (server-wide; re-runs `loadRepos()`) |
| No server | `no server running — config is read fresh on the next serve start (try herdr-factory start)` | `herdr-factory start` |
| Reload refused for this repo | `failures[]` contains `not reloaded: belt <detail> still has work — rename via the TUI (it migrates the runs) or tear the work down first` | The **old** Deps keep running. Rename the belt via the TUI belt-apply flow (it migrates `runs.belt`) — [install-and-operate.md](./install-and-operate.md) — or tear the in-flight runs down |
| Reload failed for this repo | `failures[]` contains the load error | Fix the config; the server keeps serving the previous build (or none) |
| Config edited in a different config dir | CLI sees it, server doesn't | `HERDR_FACTORY_CONFIG_DIR` / `HERDR_FACTORY_STATE_ROOT` / `HERDR_FACTORY_PORT` are **not** baked into the launchd plist / systemd unit — only `HERDR_CHANNEL`, `HERDR_FACTORY_AUTO_UPDATE`, `HERDR_FACTORY_TELEMETRY` and the `OTEL_*` keys are. If you export them in your shell your CLI reads a **different config dir and DB** than the service. Symptom: `herdr-factory runs` is empty while the dashboard shows live runs |
| Env/PATH change | a newly installed tool, or a changed `HERDR_CHANNEL` | Re-run `herdr-factory install` — the service PATH and the passthrough env are captured at install time |
| In-flight runs unaffected | expected | `belt.active: false` gates **new claims only**; step/budget changes apply at the next step (re-)entry |

### 2.11 The server is up but nothing ticks (wedged tick)

**Means**: `/health` answers 200 but no repo's `last_tick_at` advances. **`doctor` does NOT catch
this** — its `server` row is a liveness ping only.

```sh
curl -s 127.0.0.1:8765/health | jq '.repos'          # tickStale per repo
sqlite3 "$DB" "SELECT name, datetime(last_tick_at,'unixepoch'), unixepoch()-last_tick_at AS age FROM repos;"
sqlite3 "$DB" "SELECT name, owner, datetime(expires_at,'unixepoch') FROM locks WHERE name LIKE 'tick:%';"
tail -50 ~/.local/state/herdr-factory/logs/supervisor.err.log
```

- `tickStale` threshold is `max(10 × tick_interval_seconds, 900)` seconds — **at least 15 min** —
  baselined against `max(lastTickAt, serverStartedAt)` so a fresh boot isn't flagged.
- `touchTick` runs at the end of every completed pass, on **both** exits of Phase B (including the
  at-capacity early return) — but **not** if Phase A throws outside its per-run catch. A repo whose
  `last_tick_at` freezes while others advance is the signature.
- The supervisor (`ensure-up`, every 60 s) restarts a stale-but-answering server exactly as it would
  a dead one, logging `tick loop stale for <repos> — restarting wedged server`, and the restart is
  what stops the wedged holder's lock heartbeat so its locks expire. So a wedge should self-heal
  within ~a minute; if it doesn't, the supervisor isn't loaded or `ensure-up` is erroring → read the
  supervisor log, then `herdr-factory restart` by hand.
- Repeating `another tick already running — skipping` with a `tick:<repo>` lock whose owner pid is
  gone: an expired lock is stolen automatically on the next acquire. Only delete the row by hand if
  `expires_at` is still in the future and the pid is definitely dead — with the server stopped (§8).

### 2.12 A repo silently isn't being served

**Means**: `loadRepos()` runs only at `serve` start and on `/reload`. A repo whose `buildDeps` throws
is collected into `failures` and is **silently absent from the tick loop**. Both directions of drift
are invisible to `doctor`, which reads its **own** freshly-built config, not the server's.

```sh
curl -s 127.0.0.1:8765/health | jq -r '.repos[].name'
ls ~/.config/herdr-factory/repos
herdr-factory reload            # the response lists failures[]
```

- **Repo added/fixed after boot**: `doctor` says `config loads + sources buildable ✓` while the
  server has never heard of it. Fix: `herdr-factory reload`.
- **Repo the server dropped at boot**: you fixed the file, `doctor` is green, and the server is
  still running without it. Fix: `herdr-factory reload` (or `restart`).
- `/reload` can also **refuse** a repo (§2.10) — read `failures[]`, don't assume "saved · reloaded"
  in the TUI means the server took it.
- There is **no per-repo enable/disable**. `repos.enabled` exists in the schema and is read nowhere.
  To stop a repo: remove its folder under `<configDir>/repos/`, or set `active: false` on its belts
  (which gates new claims only).

### 2.13 A source stopped picking up work

```sh
herdr-factory --repo <r> auth status
herdr-factory --repo <r> doctor --deep | sed -n '/^repo /,$p'
herdr-factory --repo <r> eligible
curl -s '127.0.0.1:8765/repos/<r>/intents?kind=source_transition&status=pending' | jq
curl -s '127.0.0.1:8765/repos/<r>/status?refresh=1' | jq '.sources'   # auth: {state: ok|down|na, detail?, account?}; the S3/creds light is .evidenceSso
```

| Branch | Signature | Fix |
|---|---|---|
| Auth paused | log `… pausing its claims + status write-backs until re-authenticated`; `doctor --deep` source row fails | Fix the credential in `<configDir>/repos/<r>/env` (per-repo only; process env is **not** consulted for declared secrets, and an empty value counts as missing). Auto-resumes on the next successful call. Note `doctor`'s shallow `auth <name>` row reports ✓ for a present-but-**rejected** credential — only `--deep` exercises it |
| Rate limited | HTTP 429/403 + `Retry-After` honoured, retries then the source is **held until the reset** (`rate limited — holding its polls for <n>s`) | §2.14 |
| Stale write-backs blocking items | pending `source_transition` rows for those keys | §8; each blocked key logs `skipping claim — a status write-back … is still pending` |
| Trigger label consumed | github_issues consumes the pickup label at `in_development` | Re-add the label to retry that issue |
| Item wearing an in-flight state label | github_issues skips it (belt-and-braces over run dedup) | Strip the stale state label |
| Wrong `kind` | github_issues polls issues **or** pull requests, never both (`github_issues.kind`) | Set `kind: pull_requests` to claim labelled PRs; use a second source with its own `name` for the other kind |
| Poll window | see §2.1 gate 7 | — |
| Source renamed in config | every in-flight run parks `source_missing` | Source names are append-only. Restore the old `name`, then `resume` |

### 2.14 Everything is slow / rate limited

**Means**: usually correct pacing, not a fault. Check the buckets before touching anything.

| Bucket / cap | Value |
|---|---|
| Jira (all calls) · Sentry (all calls) | 5/s burst 10 · 3/s burst 6, per client instance |
| GitHub REST reads · mutations | 5/s burst 10 · ~60/min **and** ≤500/hr, both process-wide |
| `tick_interval_seconds` · `reconcile_concurrency` | 60 (the level backstop; agent nudges are the edge path) · 8 |
| `dueTransitions` / `dueIntents` batch | LIMIT **25** per pass — a large backlog drains over several ticks |
| `herdr agent list` | memoized 5 s (`paneAlive`/`paneState` can force a fresh read) |
| Subprocess · HTTP timeouts | 60 s (herdr worktree ops 180 s) · 30 s (Jira media 120 s) — a hung CLI can never wedge a tick |

Diagnostics: log lines `transition deferred (attempt N, retry in Ms)`; telemetry histogram
`herdr_factory.rate_limit.wait_ms` labelled by host; `http.retry_after_honored` events. GitHub's
5,000/hr primary limit is deliberately **not** enforced locally (the `gh` CLI and your own tooling
spend the same budget) — it is handled **reactively** instead, by the rate-limit gate below.

**GitHub 403 `API rate limit exceeded for user ID …`** — the limit is per **account**, so several
hosts sharing one `gh auth` login share one 5,000/hr budget, and exhausting it breaks `gh`, the
agents and your own tooling at once. The fix is one `GITHUB_TOKEN` per host in
`<configDir>/repos/<r>/env`, not a shared login.

| Signal | Meaning |
|---|---|
| `<source>: rate limited — holding its polls for <n>s (until the backend's own reset)` | A 403/429 with `x-ratelimit-remaining: 0` (or a `Retry-After`) outlasted the retries. The whole source is held until the reset the response named — re-polling an empty budget is what keeps it empty |
| `<source>: rate limited — not polling for another <n>s` | Each tick skipped while the hold stands. `status` shows `⏳ <detail>`, `explain` a matching `note:`, and the dashboard's repo light reads the problem-ledger row `source:<name>:rate-limit` (kind `rate_limit`) |
| `<source>: rate limit cleared — polls resuming` | The hold expired (or a call succeeded). **No operator action is needed** — it releases itself |
| `github: <n> call(s) this tick (<r> REST, <c> gh CLI)` | The tick's spend against the shared budget. `REST` = the `github_issues` source, `gh CLI` = the PR/review watcher. Compare across hosts to find who is eating it |

Held write-backs stay queued and deliver on recovery; a run waiting on a human reply is rescheduled
as a normal miss, never escalated. A 403 with budget left and no `Retry-After` is **not** a limit —
that is a missing scope (`gh auth refresh -s repo`), and it is reported as an ordinary error.

If a whole repo feels slow, check the tick isn't being skipped (§2.11) and that no single step is
holding all the workspace slots (Q1b).

### 2.15 Linux: the supervisor starts `serve` every tick but it never stays up

**Means**: `journalctl --user -u herdr-factory.service` logs `started serve` roughly every minute, yet
`doctor` keeps reporting `server — not running`; `herdr-factory serve` in a foreground shell works.

**Cause**: a `herdr-factory.service` unit written before the fix lacks `KillMode=process`. The unit is
`Type=oneshot`, and `ensure-up` spawns `serve` detached — but still inside the service's cgroup, so the
default `KillMode=control-group` kills `serve` the moment `ensure-up` exits. A first install looks fine
because `install.sh` starts `serve` from your interactive shell, outside that cgroup; the first restart
the supervisor does itself (self-update, stale tick, version change) takes the server down for good.

```sh
grep -E '^(Type|KillMode)=' ~/.config/systemd/user/herdr-factory.service   # want Type=oneshot + KillMode=process
herdr-factory install     # rewrites both units, daemon-reloads, re-enables the timer, runs ensure-up
```

A self-update does **not** rewrite the unit — only `install` (or re-running `install.sh`) does, so an
existing host needs that one re-install after updating. launchd (macOS) is not affected.

---

## 3. The attention / park reason table

`escalateAttention` always: sets `phase='attention'` + `attention_reason` + `attention_reason_code`,
records an `attention` event, flags the run's pane with an `⚠ ATTENTION <KEY>` title +
`hf_state=attention` token (display-only `pane report-metadata` — the pane's real label, which a step's
`pane:` target resolves by, is never touched), fires a herdr notify,
and **routes the reason report by what broke**: a *mechanical* code (every factory watchdog and
plumbing reason — budgets, stalls, layout waits, capture caps, poll failures, config drift, plugin
guards) is reported into the run's own agent pane as a framed `[herdr-factory report — for the
operator; no action needed] …` message; only a *work* error (`bounce_limit`, `pr_closed`) posts a
note on the work item — and on a file-channel source (`local_markdown`) even those go to the pane.
Both forms end with the ready-made
``Resume with: herdr-factory --repo <repo> resume <KEY>`` and
``Or let your agent diagnose it: herdr-factory --repo <repo> triage <KEY>`` lines.

| `attention_reason_code` | Raised by | Reason text the user sees | Auto-rescue | How to clear |
|---|---|---|---|---|
| `step_budget` | `budget` watch (watchdog stage) | `<step> step over budget (worker: <paneState>)` | **yes** — a genuine `step-done` **or** `bounce` from the parked step | `resume <KEY>` (re-bases the budget clock, refunds capture/layout counters, nudges an idle pane). Raise the step's `budget_seconds` if it parks repeatedly. A `working` pane is never parked by a timer — the trip is held as `extend` |
| `step_stalled` | `heartbeat` watch, only on steps producing `commits` | `<step> step stalled (worker: <paneState>)` | **yes** | No new commits for `limits.stall_seconds` (default 2700) while the pane isn't `working`. Same fix as budget |
| `read_only_violation` | `read_only` watch, **`pre_advance`** stage | `<step> is read-only but committed (HEAD moved)` | **yes** — a `step-done` also clears the enforcement baseline (the tree guard deliberately does NOT refuse that step-done: an agent cannot un-commit, so refusing would wedge the run) | Inspect `detail.baseline` → `detail.head`. If the commit was legitimate/foreign, `step-done` or `resume` (which re-bases `read_only`) clears it. The baseline *tracks* HEAD until this step's own agent is first seen `working`, so a prior step's trailing commit should not park it |
| `dirty_tree` | the tree guard at **dispatch** (`parkIfTreeDirty`) — the forward advance into, or the spawn/rework re-dispatch of, a step that never commits | `<step> cannot start — the worktree has uncommitted changes` | **no** | Only a person can decide whether the uncommitted change should be committed or dropped. The park's `detail.stat` (and the pane/notification body) carries the diff stat. Clean the worktree, then `resume` — the run is still on the step that finished, so the resume re-runs the advance |
| `evidence_upload_failed` | the evidence gate at the advance into a PR-opening step (`holdForEvidenceUpload`) — the run's latest `evidence_publish` is `failed`, or still `pending` but suspended after 10 attempts (a pending one just holds the advance, no park) | `<step> cannot start — evidence upload failed\|stuck: <last error>` | **no** | Fix the publisher (`doctor --deep`; for `command`, run the script by hand), then `resume` — `evidence_publish` refunds on resume (suspension cleared, due now), and the gate holds until it lands. A `failed` row can't be retried (e.g. the capture dir is gone): `rework <KEY> <evidence step>` re-captures |
| `capture_limit` | capture-attempt counter past `limits.max_capture_attempts` (5) | `capture attempt N over cap (C) on <step>` | **yes** | `resume` refunds `capture_cap`. Real cause is usually a flaky app or an undemonstrable change — fix the app or bounce the work back |
| `layout_wait_timeout` | layout wait after `1 + 3` windows | `<step>: layout pane <tab>/<pane> never became available[ — layout hook: <its failure line, only when the build failed>]`, or `<step>: agent in pane <id> was never detected by Herdr (status unknown)` when the pane's agent runs but `herdr agent list` shows it with no `agent` label (the engine already relaunched it once — `pane_relaunched` in the timeline; by hand: quit it, retype its command at the shell, `resume`) | **respawn** (bounded, limit 3, counter shared with the in-place re-arm) | §2.3. `resume` refunds the respawn budget. The commonest configuration cause — an untargeted **first** step killing the layout build — is now rejected at load, so a park here points instead at the plugin link (`herdr plugin link`), a title that doesn't match the layout's real tab/pane, or a belt whose layout comes only from a `layout_matching` rule (unchecked at load). An agent herdr reports as `unknown` is **not** a cause while herdr still labels it (`"agent":"cursor"`): dispatch accepts it — only an `unknown` pane with no agent label is the detection failure above |
| `bounce_limit` | bounce past `belt.max_bounces ?? limits.max_bounces` | `bounced to <toStep> N× (max M)` | **no** | Human decision. `resume` refunds `bounce_cap` **belt-wide**; otherwise `teardown` |
| `pr_closed` | the `pr` step or the `reviewing` watch | `PR #n closed without merging` | **no** (but a later **merge** still tears the run down) | Reopen the PR then `resume` (returns to `reviewing` with the thread signature cleared), or `teardown` |
| `source_item_stale` | mid-flight stale write-back, or the human-reply loop | `work item gone at the source (<why>)` / `work item gone while waiting for a human reply (<why>)` | **no**; `skipSourceNote` (nothing to post to) | Mid-flight: `resume` to continue anyway (a PR may exist) or `teardown`. Human-loop variant: `teardown` — resuming just re-parks after the next poll. A **pre-work** `in_development` stale never parks: the run is aborted with `teardown("abandoned")` |
| `belt_missing` | per-run pass, belt not resolvable | `belt "<name>" not configured` | **no** | Re-add the belt name (or use the TUI belt-rename, which migrates `runs.belt` — [install-and-operate.md](./install-and-operate.md)), then `resume`. `resume` itself refuses while the belt is missing: `belt "X" is not configured — re-add it or tear the run down` |
| `source_missing` | per-run pass, source not resolvable | `work source "<name>" not configured` | **no** | Re-add the source under its old `name` (names are append-only), then `resume` |
| `unknown_step` | phase dispatch | `step "<s>" is not in belt "<b>"` | **no** | Restore the step name in the belt, or `teardown`. A `resume` with an invalid `run.step` falls back to `claiming` |
| `human_reply_unknown_step` | human-reply resume | `human reply arrived for unknown step "<s>"` | **no** | Restore the step name and `resume`; the reply file is already in the worktree |
| `human_wait_missing_question` | the human-reply loop | `waiting_for_human without a pending question` | **no** | DB inconsistency. Fix `run.step` or `teardown` |
| `human_poll_failing` | 10 consecutive poll **throws** | `reply polling has failed N times in a row` | **no** | `doctor --deep`, then `resume` (fresh window, error run cleared) |
| `external_wait_deadline` | an `external_wait` intent's deadline | `external wait expired[: <note>]` | **no** (payload `on_deadline: "ignore"` opts out of parking) | `POST /repos/<r>/intents/<id>/fulfil` late, or `resume` / `teardown` |
| *(a plugin guard's reason)* | a registered `GuardSpec` + evaluator | evaluator-defined | per its `autoRescueOnDone` / `autoRespawnLimit` | `obligations` reports the derived `rescue` class |

Both `step_budget` and `step_stalled` should now be **rare for a merely forgetful agent**: an idle
pane is re-prompted once after `limits.idle_nudge_seconds` (default 300) long before either window
expires, and `explain <KEY>` says so — *"The engine already nudged this idle agent N ago and it still
never signalled — that is a wedged agent, not a slow one."* When you see that line, `resume` will
probably not help either: the agent is stuck, not slow. Check the pane itself. A park with **no**
such line, on the other hand, is an agent that was genuinely working (or `idle_nudge_seconds: 0`).

**What is NOT a park** (common misreadings):

- **A source that can't authenticate** → *pause + throttled notify*. Its claims and write-backs are
  held; it auto-resumes the moment any call to that source succeeds.
- **A permanently-failing evidence upload** → *notify + the amber `⚠` problem flag on the run's
  dashboard card*. The run is untouched and completes normally.
- **The `capture` lock** → `capture_lock` exists as a guard reason string, but `exclusive_resource`
  **never parks** (rescue class `none`). A blocked evidence agent just waits at `capture-lock
  acquire` (up to 1 h). A **layout apply failure** likewise doesn't park — it surfaces later as
  `layout_wait_timeout`.

---

## 4. `doctor` failure → remediation

Condensed; `⚠` (amber) never fails the exit code, `✗` sets exit 1.

| Row ✗/⚠ | Detail | Fix |
|---|---|---|
| `node runtime >= 26` | `v24.x is too old` | Invoke via the `herdr-factory` launcher shim (it re-execs the vendored Node), or re-run `install.sh` ([install-and-operate.md](./install-and-operate.md)) |
| `auto-update` ⚠ | `last update FAILED — <reason>` / `reset to <ref> skipped — checkout has uncommitted changes` / `behind <ref>` / `updated but <warning>` | In `~/.local/share/herdr-factory`: `git fetch && git status`, then commit/stash/discard local edits (the updater refuses to hard-reset over them); `herdr-factory update` to retry; stable channel with no release tags needs a tag or `HERDR_CHANNEL=main herdr-factory install`; read `<state>/logs/supervisor.err.log` |
| `auto-update` ⚠ | `auto-update stalled — last check <age> (nothing is running \`ensure-up\` every 60s)` — no attempt recorded for 30min while auto-update is on | Nothing schedules `ensure-up`: check `launchctl list \| grep herdr-factory` / `systemctl --user status herdr-factory.timer`, or on a `HERDR_SKIP_SERVICE=1` host that the `while :; do herdr-factory ensure-up; sleep 60; done` loop is still running (restart it). `herdr-factory update` catches up at once |
| `auto-update` ✗ | exec error on `@{u}` | `git branch --set-upstream-to=origin/main main` in the app checkout |
| `main checkouts up to date` ⚠ | `<repo>: on <branch>, skipped (base branch is <base>)` / `dirty tree, skipped` / `diverged, skipped` / a fetch error | That repo's MAIN checkout (`repo.path`) is drifting behind `origin` — runs are unaffected (worktrees fork from `origin/<base>`), but what a human opens there is stale. In that checkout: get back on the base branch, commit/stash the changes, or resolve the divergence; the next `ensure-up` sweep (≤10 min) catches it up. The factory never stashes/resets/rebases it for you |
| `supervisor service` ✗ | `not loaded — run \`herdr-factory install\`` | `herdr-factory install`; verify `launchctl list \| grep herdr-factory` / `systemctl --user status herdr-factory.timer` |
| `server` ✗ | `not running (run \`herdr-factory start\`)` / `registered but not responding` | `herdr-factory start` (`serve` for foreground debugging) / `herdr-factory restart`; check `<state>/server.json` pid+port, `lsof -i :8765`, `HERDR_FACTORY_PORT`; delete a stale `server.json` if the pid is gone |
| `machine limits (machine.yml)` ✗ | `invalid machine config (<path>):\n  <key>: <msg>` | Fix or delete `<configDir>/machine.yml` (only `max_active_workspaces`, `min_free_memory_mb` — non-negative integers — and `layout_hook.ignore_pane_labels`, a list of strings). ✓ shows the limits in effect, or `none — per-repo caps only` |
| `database` ✗ | `not initialized yet (created on the first serve)` | Any `--repo` command creates + migrates it (including `doctor --repo`, so a second run shows ✓ with no other action) |
| `git`/`gh`/`claude` ✗ | opaque `command -v` failure | Install the tool, then **re-run `herdr-factory install`** — the checks resolve against the **service** PATH, frozen at install time |
| `herdr` ✗ | `not on PATH (or \`herdr --version\` gave no version)` / `v<x> is too old — the factory needs >= 0.7.5 (run \`herdr update\`)` | Install herdr, or `herdr update`. 0.7.5 is a hard floor: the factory's `agent start --pane`/`agent prompt`/`pane process-info`/`layout.apply` calls don't exist below it. The floor is read from `herdr-plugin.toml` |
| `herdr (daemon responds)` ✗ | exec failed/timed out, or `v<x> CLI cannot speak the running server's protocol <n> — restart herdr` | Start the herdr app; `herdr workspace list` by hand; check `HERDR_BIN_PATH`; on a protocol mismatch the binary was updated under a still-running server — restart herdr; confirm `herdr plugin link ~/.local/share/herdr-factory` |
| `gh (authenticated)` ✗ | `gh auth status` non-zero | `gh auth login`; for github_issues the token also needs push/issues:write |
| `cursor-agent` ✗ | opaque `command -v` failure | Install Cursor's CLI, then **re-run `herdr-factory install`** (service PATH). Only checked with `--repo`, and only when a belt actually runs a Cursor agent — otherwise the row reads `not configured — no belt runs a Cursor agent` |
| `cursor-agent (signed in)` ✗ (`--deep`) | `not on PATH — install Cursor's CLI (\`cursor-agent\`), then re-run \`herdr-factory install\` …` | The binary is **missing**, not signed out — `--deep` establishes presence before it interprets anything `cursor-agent status` said (under `allowFail` a spawn ENOENT arrives as an ordinary non-zero result, which is how this row used to prescribe a login that would itself be command-not-found). Install it, then re-run `herdr-factory install`: the row resolves against the **service** PATH, frozen at install time |
| `cursor-agent (signed in)` ✗ (`--deep`) | `not signed in — run \`cursor-agent login\` on this host (it opens a browser) [cursor-agent said: <its first line>]` | `cursor-agent login` **interactively on that host** — it opens a browser and blocks, so it can never be fixed unattended. Until it is, every Cursor step's pane comes up unusable. The bracketed text is `cursor-agent`'s own first line, shown whichever way it exited — on a **broken install** it is the real reason (`error: unknown command status`), not a login problem at all |
| `cursor models` ✓ (`--deep`) | `not checked — cursor-agent is not on PATH (see the row above)` | Not a failure: one root cause gets one ✗. Fix the `cursor-agent` row and this one checks for real on the next run |
| `cursor models` ✗ (`--deep`) | `\`cursor-agent models\` failed (exit <n>) — <its first line> — sign in with \`cursor-agent login\` if it wants authentication` | The CLI is there but would not list models — usually an expired/absent login (`Error: Authentication required`). Its own first line is quoted; this row never shows a raw `exec failed: …` |
| `cursor models` ✗ (`--deep`) | `<id> not in \`cursor-agent models\` — fix the \`--model\` id in this repo's config` | Cursor renamed/retired the id. `cursor-agent models` lists the live ones; fix every `--model` in that repo's `config.yml` (repo `agent.flags`, a belt/step `agent.flags`, and each layout pane's `agent_args`). A rejected id makes cursor-agent print its model list and **exit**, leaving a pane that *looks* ready. Ids on a `claude` agent (`--model opus`) are Claude Code's namespace and are not checked |
| `agent skills` ✗ (`--deep`) | `<name> missing at ~/.cursor/skills/<name>/SKILL.md (nor under ~/.claude/skills, ~/.agents/skills)` for Cursor, `… at ~/.claude/skills/<name>/SKILL.md` for Claude — one entry per missing skill | Install or re-link the skill on that host, under a root the engine that runs the step reads (Cursor: any of the three; Claude: `~/.claude/skills` only). The names are read from the **loaded prompts** (a `~/.claude|.cursor/skills/<name>/…` path, or a bolded `**<name>** skill`), so renaming a skill directory — or a prompt naming a skill nobody installed — is what trips this |
| `ocr` ✗ | `not on PATH — install \`ocr\`, then re-run \`herdr-factory install\` … (pr-review's third review track shells out to it; nothing in \`install.sh\` provides it)` | Install `ocr`. This row gets a hint of its own rather than the shared `command -v` failure the other you-provide tools show, because it is the one tool here that **nothing** installs — "where does it come from" is the question a ✗ has to answer. Only checked when a prompt names the `pr-review` skill — otherwise `not configured` |
| `config loads + sources buildable` ✗ | `no config for repo "<n>" at <path>` | `ls ~/.config/herdr-factory/repos`; the repo name **is** the directory name; scaffold with `herdr-factory init` |
| … ✗ | `config invalid: <path>: <msg>[; …] — the server claims nothing for this repo until it loads` | Edit the reported dotted path(s). The server pauses claims for this repo until the file loads (runs in flight continue). See [config-reference.md](./config-reference.md) |
| … ✗ | `repo.path "<p>" is not a git checkout (no .git)` / `looks like a linked worktree (.git is a file); herdr needs the MAIN checkout` | Point `repo.path` at the primary clone |
| … ✗ | `belt "<b>": match not found: <abs>` / `prompt_file not found` / `must \`export default\` a function` | Relative paths resolve against the **config folder**, not the repo; a match module must `export default (ctx) => boolean` — one `MatchContext` argument (`{ item, source }`), **not** the item itself, so destructure: `({ item }) => item.labels.includes("x")` |
| … ✗ | `violates the prompt contract` | Fix the tokens; see [prompts.md](./prompts.md). Only `prompt_file_source: config` prompts are validated at load |
| `git origin resolved` ✗ | `no origin — set repo.github or add a git remote` | Add the remote or set `repo.github: owner/name` |
| `auth <n>` ✗ | `set JIRA_EMAIL + JIRA_API_TOKEN in the repo env` / `set SENTRY_AUTH_TOKEN in the repo env` / `GitHub auth missing — set GITHUB_TOKEN in the repo env, or authenticate the gh CLI` | Add to `<configDir>/repos/<r>/env` (`chmod 600`). An empty value counts as missing |
| `source <n>` ✗ | jira `Jira rejected the credentials (HTTP 401\|403)`; HTTP 400/404 from the board query | Regenerate the API token (`JIRA_EMAIL` is the account **email**; Jira is api_token-only); verify the numeric board id, project key and exact `status.todo` name |
| `source <n>` ✗ | `github_issues: trigger label "<l>" does not exist in <repo>` / `issues are disabled` (only checked when `kind: issues`) / `no push/write access` | `gh label create '<l>' --repo <owner/name>` or fix the belt's `label`; enable Issues; `gh auth refresh -s repo` |
| `source <n>` ✗ | sentry `cannot reach organization` / `project … not reachable`; `local_markdown folder does not exist` | Fix `organization`/`base_url`/the project **slug** or token scope; `mkdir -p <folder>` |
| `evidence publisher (s3)` ✗ | `AWS SSO/credentials expired or unresolved` / `bucket does not exist` / `wrong region` / `access denied — credentials lack s3:PutObject` / `timed out reaching S3` | `aws sso login[ --profile <p>]` · fix `bucket` · set `region` to the bucket's real region · grant `s3:PutObject` on `arn:aws:s3:::<bucket>/herdr-factory/*` · retry |
| `evidence publisher (local)` ✗ | `resident server not reachable at 127.0.0.1:<port>` / `served bytes did not match the probe` | `herdr-factory start` · another process is serving `<state>/evidence`, or two factories share a state root |
| `evidence publisher (command)` ✗ | `could not run: spawn … ENOENT` / `exited <code>` / `printed no URLs to stdout` / `timed out after <n>s` | Absolute path + `chmod +x` · run it by hand · print one absolute URL per line · raise `evidence.timeout_seconds` |
| `evidence uploads` ✗ | `<n> stuck — AWS SSO/creds expired` | §2.9 |
| `orphaned dev servers` ⚠ (`--deep` only) | `<n> listener(s) outlived their run or its park — <cmd> pid <p> on :<port> (<n> MB) in <cwd>` — a dev server whose worktree has no live run, or whose run is parked (attention / waiting_for_human — the engine stopped the run's own `hf-port` listener when it parked, so anything still listening there is a leak). It holds the port (so the next run's server moves up its range and an evidence pass can film a **stale server on old code**) and its whole RSS, which the scheduler still counts as free | Check what it is (`ps -o pid,rss,etime,args -p <pid>`), then kill it **by hand** — `doctor` never kills. Stop the leak at the source: have the repo write its port to `$(git rev-parse --absolute-git-dir)/hf-port` so teardown reaps it ([target-repo.md](./target-repo.md)). Amber `could not check — …` just means `lsof` is missing or refused |

The `s3` deep probe **writes one tiny object by design** (`…/.herdr-doctor`) and leaves it behind.

---

## 5. What `doctor` does not check

Each with the by-hand check.

| Gap | By-hand check |
|---|---|
| **A wedged tick loop reads as healthy.** The `server` row is a liveness ping; `/health`'s per-repo `lastTickAt`/`tickStale` is ignored | `curl -s 127.0.0.1:8765/health \| jq '.repos'` (§2.11) |
| **Only ONE repo is ever checked** — the `--repo` value. Without `--repo`, **zero** repo checks run (the README's "each repo" is wrong) | Loop `ls ~/.config/herdr-factory/repos` and run `doctor --repo` for each |
| **The TUI Doctor tab never runs the repo group** — config validity, source health, secrets and evidence are invisible there | "The TUI doctor is green" proves nothing; run `herdr-factory --repo <r> doctor --deep` |
| **It doesn't check the repo is *served*** — and it reads its own fresh config, not the server's | §2.12 |
| **The unconditional agent-CLI check is still hardcoded to `claude`** — `cursor-agent` is now checked too (with `--repo`, when a belt runs a Cursor agent, along with its `--model` ids), but any other configured `agent.command` (`opencode`, `codex`, a wrapper script) is never probed | `command -v <your agent>` under the **service** PATH, and run the exact `agent.command + flags` by hand |
| **Agent-CLI *authentication* is only checked for Cursor** (`cursor-agent (signed in)`, `--deep`). Nothing checks that `claude`/`opencode`/… are logged in or have quota — presence ≠ logged in ≠ has quota | Start the agent interactively once and confirm it answers |
| **Skills are only checked when a prompt NAMES them** in one of the two recognised forms — a skill a prompt only alludes to ("use the repo's review skill"), or one an installed skill depends on in turn, is invisible | `ls ~/.cursor/skills ~/.claude/skills ~/.agents/skills`; read the skill's own `SKILL.md` for what it shells out to |
| **No herdr plugin / layout check** — without `herdr plugin link`, per-belt layouts silently never apply | `herdr plugin list`; then look for `layout_applied` in a run's timeline (§2.3) |
| **The service PATH is frozen at `herdr-factory install` time** | macOS: `plutil -extract EnvironmentVariables.PATH raw ~/Library/LaunchAgents/com.herdr-factory.server.plist`. Linux: `grep '^Environment="PATH=' ~/.config/systemd/user/herdr-factory.service`. A tool installed later is invisible to `serve` even though your shell finds it — re-run `install`. A PATH lacking `/bin` breaks the probe itself (`spawn sh ENOENT` on every row) |
| **No DB integrity/schema check** — `database` is `existsSync` only | `PRAGMA integrity_check;` `PRAGMA foreign_key_check;` `SELECT * FROM schema_version ORDER BY version;` |
| **Live auth rejection is invisible in shallow mode**, and the in-memory auth gate is never read | `doctor --deep`; `curl -s '.../repos/<r>/status?refresh=1'` |
| **Nothing about stuck/parked runs**; and only `evidence_publish` intents are surfaced (transitions, reply polls, `waiting`/`failed` rows are ignored) | `status`, `explain <KEY>`, `timeline <KEY>`, `GET /repos/<r>/obligations?key=<KEY>`, `GET /repos/<r>/intents` (the raw obligations JSON and the intent rows are HTTP-only) |
| **Orphan detection needs `lsof`, and only sees TCP listeners** — a leaked dev server that has already lost its port (or a machine with no `lsof`) reads as ✓/amber-unknown, and a listener whose cwd is outside `~/.herdr/worktrees` is never attributed to a run | `ps -eo pid,rss,etime,args \| grep -i 'nuxt\|vite\|next' ` and compare against `herdr-factory --repo <r> status` — the CLAUDE.md trap "the dev servers of finished runs can outlive teardown: check `ps` before assuming a host is busy" |
| **No writability/disk checks**, and `aws` presence is never checked despite every S3 remediation telling you to run `aws sso login` | `df -h`; `command -v aws` |
| **`repo.github` vs real origin mismatch is never flagged** — `repo.github` unconditionally wins, so a stale value silently sends PRs at the wrong repo while the row prints ✓ | Compare with `git -C <repo.path> remote get-url origin` |
| **`evidence uploads` can crash the whole command** (it isn't wrapped in the error-catching helper): a locked/corrupt DB makes `doctor` print no groups at all | If `doctor` exits with a bare error and no output, suspect the DB |

Also: shallow mode is **not** side-effect-free despite its own comment — it spawns subprocesses,
hits loopback HTTP, and with `--repo` creates/migrates the DB, creates state+log dirs, and
**imports every belt's `match` module** (arbitrary user code).

---

## 6. Logs

| File / stream | Contents |
|---|---|
| `<state>/<repo>/logs/<YYYY-MM-DD>.log` | **All per-repo engine work**: reconcile passes, claim gates, spawns, watch parks, intent deferrals, auth-gate transitions, lock-lost errors, teardown. Line format `<ISO ts> [<LEVEL>] <msg>`. Also mirrored to the stderr of whichever process ran it |
| `<state>/logs/supervisor.out.log`, `supervisor.err.log` | macOS only: `ensure-up` decisions (`server healthy on :<port>`, restart reasons, `self-update: …`). **Not** the resident server's own output — the supervisor spawns `serve` detached with `stdio: "ignore"`, so its `[server:*]` lifecycle lines (`repo "X": failed to load …`, `reload refused`) go to /dev/null. Run `herdr-factory serve` in the foreground to see them |
| `journalctl --user -u herdr-factory.service` | Linux equivalent — the systemd unit sets no output redirection, so nothing lands in `<state>/logs` |
| stdout of a foreground `herdr-factory serve` / `run` | Everything, live |
| SQLite `events` table | The domain timeline — `herdr-factory --repo <r> timeline <KEY>` or `GET /repos/<r>/timeline?key=` |
| `<worktree>/.memory/herdr-factory/` | `prompt-<step>.md` (the exact rendered prompt), `handoff-<step>.md`, `feedback-<step>.md`, `feedback-<step>-addressed-pass<N>.md`, `human-question-<step>.md`, `human-replies/question-<id>.md`, `task.md`, `ticket.json`, `evidence/` |
| `<state>/update-status.json` | The last auto-update attempt — first thing to read for "why is this box behind" |
| `<state>/checkout-sync.json` | The last main-checkout fast-forward per repo — why `~/work/<repo>` is behind `origin` |

`<state>` = `HERDR_FACTORY_STATE_ROOT` or `~/.local/state/herdr-factory`.
`herdr-factory --repo <r> logs [n]` tails **today's** file only (default 50 lines) and prints
`no log for today at <file>` when absent — read older days directly.

**Symptom → which log**

| Symptom | Log |
|---|---|
| Repo isn't picking up work | repo log: `at capacity`, poll skips, auth-pause lines |
| Nothing happens at all / stale ticks | supervisor log + `/health` `tickStale` |
| A step never advances | `explain <KEY>` + repo log + `GET /repos/<r>/obligations?key=<KEY>` |
| Status not moving in Jira/GitHub | repo log `transition deferred …` + `GET /intents?kind=source_transition` |
| Evidence links broken | repo log `evidence publish` lines + `doctor --deep` + TUI amber |
| Duplicate agents in one worktree | repo log, grep `lock … lost mid-hold` (error level) |
| Box behind on code | `update-status.json` + supervisor `self-update:` lines + `doctor`'s `auto-update` row |
| A repo's main checkout behind `origin` | `checkout-sync.json` + supervisor `checkout-sync:` lines + `doctor`'s `main checkouts up to date` row |

**Grep-able lines that pin a state** (exact substrings):

```
at capacity (                              # Phase B returned early
claimed N; working X/Y, idle/parked Z      # end of a normal pass
another tick already running — skipping    # tick lock held
busy (nudge in flight) — skipped this pass # run lock held by a nudge
inactive — skipping (no new claims         # belt.active: false
at its concurrency cap (                   # per-source cap
skipping claim — a status write-back       # the known-stale-eligibility veto
work source not authenticated (            # source paused
waiting for layout pane                    # layout wait, inside the window
not up after Ns — re-arming the wait       # layout wait, spending a respawn credit
awaiting step-done                         # dispatched, waiting on the agent
past ... but still working — extending     # vetoWhenWorking held a timer trip
watchdog deferred                          # herdr unreachable; never parks on uncertainty
pane ... not listed — confirming before re-spawn / pane gone (confirmed twice) — re-spawning
resolver idle — PR #n watch no longer holds a slot
transition deferred (attempt N, retry in Ms) / intent deferred (attempt N)
effect → X skipped (would move backward
lock ... lost mid-hold                     # ERROR: two reconcilers may share a target
```

---

## 7. State inspection (read-only)

One SQLite file per **machine**, shared by every repo. `runs`, `events`, `intents`, `work_items`,
`human_questions` and `source_auth` carry a `repo` column; the run-scoped children (`run_steps`,
`run_products`, `guard_counters`, `watch_state`) and `locks` do **not** — scope those by joining
`runs` (as Q6–Q8 do).

```sh
DB="${HERDR_FACTORY_STATE_ROOT:-$HOME/.local/state/herdr-factory}/herdr-factory.db"
```

It is a **normal SQLite 3 file** — the stock `sqlite3` CLI works. Caveats:

- `sqlite3 -readonly "$DB"` **fails when the `-shm` sidecar is absent** (idle DB, server stopped):
  `Error: in prepare, unable to open database file (14)`. Use `sqlite3 "$DB" "<SELECT>"` (the
  pragmatic default — a SELECT mutates no rows) or `sqlite3 "file:$DB?immutable=1" "<SELECT>"`
  (only safe when nothing is writing). Prelude: `.mode box` `.headers on` `.timeout 5000`.
- All timestamps are epoch **seconds** — wrap with `datetime(col,'unixepoch')`.
- `PRAGMA foreign_keys = ON` is set by the engine (hand `DELETE`s cascade-block), and WAL is required
  by the multi-process access model: never run `VACUUM`, `PRAGMA journal_mode=DELETE`, or `.recover`.
- **Never diagnose from these dead columns**: `runs.worker_done`, `runs.review_done`,
  `runs.review_pane`, `runs.progress_sig`, `runs.progress_at`, `run_steps.bounces`,
  `run_steps.capture_attempts`, `repos.enabled`.
- **Never trust PR numbers or resolver state from `herdr-factory runs` or `status.finished`** — that
  read doesn't join `run_products`, so `prNumber` is missing and `resolverActive` is always true.
  Query `run_products` (Q1).

**Q1 — what's in flight** (the correct run read joins `run_products`)

```sql
SELECT r.id, r.repo, r.work_source, r.belt, r.ticket_key, r.phase, r.step,
       rp.number AS pr, COALESCE(rp.active,0) AS resolver_active,
       r.attention_reason_code, r.attention_reason,
       datetime(r.created_at,'unixepoch') AS created,
       datetime(r.updated_at,'unixepoch') AS updated, r.branch, r.worktree_path
FROM runs r
LEFT JOIN run_products rp ON rp.run_id = r.id AND rp.product = 'pull_request'
WHERE r.ended_at IS NULL ORDER BY r.repo, r.created_at;
```

**Q1b — occupancy vs `max_active_workspaces`** (mirrors the engine's own count)

```sql
SELECT r.repo, r.work_source, COUNT(*) AS occupying
FROM runs r
LEFT JOIN run_products rp ON rp.run_id = r.id AND rp.product = 'pull_request'
WHERE r.ended_at IS NULL
  AND r.phase NOT IN ('attention','waiting_for_human')
  AND NOT (r.phase = 'reviewing' AND COALESCE(rp.active,0) = 0)
GROUP BY r.repo, r.work_source;
```

**Q2 — why is this run parked**

```sql
SELECT id, ticket_key, phase, step, attention_reason_code, attention_reason,
       datetime(attention_notified_at,'unixepoch') AS last_notified
FROM runs WHERE phase = 'attention' AND ended_at IS NULL ORDER BY updated_at;

SELECT id, datetime(ts,'unixepoch') AS ts, json_extract(detail,'$.reason') AS reason, detail
FROM events WHERE run_id = :runId AND type = 'attention' ORDER BY id DESC LIMIT 5;
```

**Q3 — this run's timeline** (`timeline <KEY>` shows only the latest run for the key; the second
query includes earlier runs and detached admin rows)

```sql
SELECT e.id, datetime(e.ts,'unixepoch') AS ts, e.type, e.detail
FROM events e
WHERE e.run_id = (SELECT id FROM runs WHERE repo = :repo AND ticket_key = :key
                  ORDER BY id DESC LIMIT 1)
ORDER BY e.id;

SELECT id, run_id, datetime(ts,'unixepoch') AS ts, type, detail
FROM events WHERE repo = :repo AND ticket_key = :key ORDER BY id;
```

**Q3b — open problems (the red repo light's source of truth)**

```sql
SELECT key, kind, detail, datetime(created_at,'unixepoch') AS since FROM problems
WHERE repo = :repo ORDER BY created_at;
```

A row here was RECORDED by the engine when it observed the failure and is DELETED by the same
machinery on recovery — if a row looks stale, the cause has not demonstrably recovered yet (a
successful source call, a delivery, or a healthy creds probe is what clears it).

**Q4 — stuck / suspended intents**

```sql
SELECT id, kind, scope, ticket_key, status, attempts, error_class,
       suspended_at,                       -- non-NULL = retries stopped (10 failures); clear with retry-now / `s`
       datetime(next_attempt_at,'unixepoch') AS next_attempt,
       next_attempt_at - unixepoch() AS due_in_sec,
       lease_until, handoff_marker, consumed_at,
       substr(COALESCE(last_error,''),1,160) AS last_error
FROM intents WHERE repo = :repo AND status IN ('pending','waiting')
ORDER BY kind, scope, seq;
```

FIFO blockage — the #1 cause of "my status write-back never fired":

```sql
SELECT later.id AS blocked_id, earlier.id AS blocker_id, earlier.status,
       earlier.error_class, earlier.attempts, earlier.last_error
FROM intents later
JOIN intents earlier ON earlier.kind = later.kind AND earlier.scope = later.scope
 AND earlier.seq < later.seq AND earlier.status IN ('pending','waiting')
WHERE later.kind = 'source_transition' AND later.status = 'pending';
```

**Q5 — held locks**

```sql
SELECT name, owner, datetime(expires_at,'unixepoch') AS expires,
       expires_at - unixepoch() AS ttl_left_sec,
       CASE WHEN expires_at <= unixepoch() THEN 'EXPIRED (stealable)' ELSE 'held' END AS state
FROM locks ORDER BY name;
```

**Q6 — bounce (and every capped-guard) count per step**

```sql
SELECT r.ticket_key, r.belt, gc.step, gc.guard, gc.count,
       datetime(gc.updated_at,'unixepoch') AS updated
FROM guard_counters gc JOIN runs r ON r.id = gc.run_id
WHERE r.ended_at IS NULL ORDER BY gc.guard, gc.count DESC;
```

`guard` ∈ `bounce_cap` (keyed on the bounce **target** step) · `capture_cap` · `layout_wait`.
The DB holds only the count — the caps live in config (`max_bounces` 6, `max_capture_attempts` 5,
layout respawn limit 3).

**Q7 — step timings; then every step still awaiting its first dispatch (the layout-wait suspects)**

```sql
SELECT rs.step, rs.pass, rs.done,
       datetime(rs.started_at,'unixepoch')    AS started,
       datetime(rs.dispatched_at,'unixepoch') AS dispatched,
       datetime(rs.done_at,'unixepoch')       AS done_at,
       COALESCE(rs.done_at, unixepoch()) - rs.started_at AS elapsed_sec,
       rs.pane_id, rs.absent_at
FROM run_steps rs WHERE rs.run_id = :runId ORDER BY rs.id;

SELECT r.ticket_key, rs.step, rs.pass, unixepoch() - rs.started_at AS waited_sec
FROM run_steps rs JOIN runs r ON r.id = rs.run_id
WHERE r.ended_at IS NULL AND rs.dispatched_at IS NULL AND rs.done = 0;
```

`run_steps.started_at` is **pass bookkeeping** (the layout-wait window + per-attempt dispatch clock),
**not** the budget clock.

**Q8 — live watch clocks** (the real budget / stall / read-only windows)

```sql
SELECT r.ticket_key, ws.step, ws.watch, ws.sig,
       datetime(ws.based_at,'unixepoch') AS based_at,
       unixepoch() - ws.based_at AS age_sec
FROM watch_state ws JOIN runs r ON r.id = ws.run_id
WHERE r.ended_at IS NULL ORDER BY ws.run_id, ws.step, ws.watch;
```

Compare `age_sec` for `budget` against the step's `budget_seconds`, and for `heartbeat` against
`limits.stall_seconds`. `read_only` with `based_at IS NOT NULL` = the baseline is **frozen** (only a
HEAD move after that trips); `NULL` = still tracking. Rows are never deleted — `sig IS NULL AND
based_at IS NULL` means "deliberately cleared", not "absent".

`idle_nudge` is the proactive nudge's episode, not a watch that can park: `based_at` = when the pane
was first seen at its prompt, `sig` = the branch HEAD at the moment the one nudge of that episode
went out (`NULL` = the `limits.idle_nudge_seconds` window has not elapsed yet). Both `NULL` = no open
episode (the pane is `working`, HEAD moved, or the run was resumed).

**Q9 — human questions and their poll clocks**

```sql
SELECT hq.id, hq.run_id, hq.ticket_key, hq.step, hq.status,
       hq.external_id IS NOT NULL AS posted,
       i.id AS poll_intent_id, i.attempts AS poll_errors,
       json_extract(i.state,'$.pollAttempts') AS poll_misses,
       datetime(i.next_attempt_at,'unixepoch') AS next_poll,
       substr(hq.question,1,100) AS question
FROM human_questions hq
LEFT JOIN intents i ON i.kind = 'human_reply_poll'
  AND i.scope = 'run:'||hq.run_id AND i.dedup_key = 'q-'||hq.id
WHERE hq.status = 'pending' ORDER BY hq.id;
```

**Q10 — last tick per repo** (the wedged-tick signal)

```sql
SELECT name AS repo, datetime(last_tick_at,'unixepoch') AS last_tick,
       unixepoch() - last_tick_at AS tick_age_sec FROM repos;
```

**Q11 — recent failures across the whole repo**

```sql
SELECT datetime(ts,'unixepoch') AS ts, repo, run_id, ticket_key, type, detail FROM events
WHERE repo = :repo
  AND type IN ('error','attention','stale','signal_rejected','evidence_upload_failed',
               'layout_apply_failed','intent_deadline','intent_suspended') ORDER BY id DESC LIMIT 40;
```

### Safe to hand-edit vs never

Prefer the supported surfaces — they take the right locks and record events. Anything below assumes
`herdr-factory stop` first; writing while `serve` runs bypasses the `tick:`/`run:` locks.

**Tolerable by hand** (idempotent, the engine re-derives):

- `DELETE FROM locks WHERE name = 'capture' AND expires_at <= unixepoch();` — an already-expired
  row. Prefer `herdr-factory capture-lock release capture <owner>`.
- `UPDATE intents SET next_attempt_at = unixepoch() WHERE id = ?;` — exactly what
  `POST /repos/<r>/intents/<id>/retry` does (and `retry-now` does in bulk, plus the flush). Prefer
  the endpoint or `retry-now`.
- `UPDATE work_items SET status = 'todo' WHERE …;` — the internal ledger is a best-effort label
  (`local_markdown` / `sentry` only), any→any by design.
- `SELECT`s, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`.

**Never by hand**

| Don't | Why | Instead |
|---|---|---|
| `UPDATE runs SET phase = …` | phase changes are coupled to pane spawn/rename, watch re-bases, counter refunds, focus and events; a hand flip orphans or double-spawns an agent | `resume` |
| `UPDATE runs SET ended_at = …` / `DELETE FROM runs` / `INSERT INTO runs` | skips teardown effects and worktree removal, orphans `run_steps` (no FK) while FK-blocking on `events`/`intents`; an insert must go through the active-ticket race arbiter + branch/worktree creation | `teardown` / `claim` |
| `UPDATE run_steps SET done = 1` | skips pass validation, the clock re-base, the watchdog rescue, and records no `step_done` event | `step-done <key> <step>` |
| `UPDATE run_steps SET pass = …` / `dispatched_at = …` | `pass` is the anti-replay stamp already baked into rendered prompts; desyncing it silently rejects every real signal | never |
| `DELETE FROM watch_state` | the contract is "re-bases write NULLs, never delete"; deleting loses the read-only freeze marker | `resume` |
| `UPDATE intents SET status='delivered'` on a `source_transition` | the source's status of record permanently diverges and eligibility can re-claim merged work | fix auth and let it retry, or `teardown` |
| `INSERT INTO intents` / `UPDATE intents SET consumed_at = …` | you'd have to set `seq` yourself or the FIFO gate mis-orders; erasing a handoff silently skips the abort/park decision the run-locked pass still owes | `POST /repos/<r>/intents` (only `external_wait`); otherwise let the next pass consume it |
| `DELETE FROM events` | the audit record; belt purges deliberately detach (`run_id = NULL`) instead of deleting | never |
| `UPDATE runs SET belt = …` | belt renames must move active and historical rows atomically under the tick lock with a Deps reload, or every run parks `belt_missing` | the TUI belt-apply flow ([install-and-operate.md](./install-and-operate.md)) |
| touching `source_auth` | holds live tokens | `auth status` |

---

## 8. Locks and the outbox

### Locks

All of them live in one `locks` table (`name`, `owner`, `acquired_at`, `expires_at`, epoch seconds).
`acquireLock` **steals an expired holder unconditionally**; `releaseLock`/`extendLock` are
**owner-scoped** (a release with the wrong owner is a silent no-op).

| Lock | Owner | TTL | Symptom when stuck | Safe fix |
|---|---|---|---|---|
| `tick:<repo>` | `pid:<pid>:<seq>` | `max(tick_interval × 2, 300)` s | repo stops reconciling; `another tick already running — skipping` every pass | Nothing — an expired lock is stolen on the next acquire. If `expires_at` is in the future but the pid is dead, wait out the TTL or `herdr-factory restart` (which stops the holder's heartbeat). Delete the row only with the server stopped |
| `machine:claim` | `pid:<pid>:<seq>` | `max(tick_interval × 2, 300)` s | only with `machine.yml` `max_active_workspaces`: repos log `machine claim lock held (another repo is claiming) — claims deferred N ticks (machine claim lock)` after waiting half a tick interval (floor 10 s) for it; a manual `claim` fails `another repo is claiming right now` (no wait) | Held for one repo's claim section; expires with its holder like `tick:` |
| `run:<id>` | `pid:<pid>:<seq>` | 300 s | one run never advances while others do; `<KEY>: busy (nudge in flight) — skipped this pass` every tick; nudges answer `run busy — retry … in a moment` | Expires within 300 s of the holder dying |
| `capture` | the run's **ticket key** | 1200 s | an evidence agent hangs at `capture-lock acquire` (it polls every 5 s for up to **1 h**), blocking every other evidence step on the machine | `herdr-factory capture-lock release capture <that exact owner>` — the release is owner-scoped, so pass the owner from Q5. A manual acquire with no owner argument is the literal `worker`, which the engine's ticket-key-scoped backstop release will never clear. Self-heals after 20 min |

`tick:` and `run:` are heartbeat-extended every `max(5s, TTL/3)` while the holder lives, so **TTL
expiry means the holder process is dead**, never "slow". A holder whose extend fails logs
`lock <key> lost mid-hold (owner <owner>) — a concurrent holder may be reconciling the same target`
at **error** level — the one lock line worth alerting on, because two reconcilers may be driving one
target: restart the server and check the worktree for duplicate agents. After a hard `SIGKILL` of
`serve`, up to ~5 min of runs are skipped while locks expire — which is why shutdown has an 18 s
graceful window.

### The intent ledger (outbox)

An **intent** is one durable, retried side effect on the `intents` table. Five kinds:

| kind | What it is | Ordering | Survives teardown |
|---|---|---|---|
| `source_transition` | a status write-back to the work source | **fifo** per run | **yes** (Phase B's claim veto depends on it) |
| `evidence_publish` | upload a captured evidence dir | latest-wins | no |
| `agent_signal` | a durable `bounce` / `ask-human` from an agent | latest-wins | no |
| `human_reply_poll` | the reply-poll clock for one pending question | independent | no |
| `external_wait` | an externally fulfilled wait (the only kind you may create) | independent | no |

The retry clock is **flat**: every failed attempt reschedules 30 s out, and at **10 failed attempts
the row SUSPENDS** (`suspended_at` stamped): retries stop, an `intent_suspended` event and an
unthrottled notification fire, and the repo's TUI row turns red. A suspended row stays `pending` —
it keeps the claim veto and its FIFO slot — until `retry-now` / `s` (attempts reset to 0) or a
cause-recovery probe clears it. At most **25** rows are attempted per pass, so a backlog drains
over several ticks.

Two behaviours explain most "it never fired": **the FIFO gate is checked against the DB**, so an
earlier sibling in the same `(kind, scope)` blocks a later one *even while it is waiting or suspended*
(one transition stuck on auth holds every later transition for that run — Q4's blockage query finds
it); and **a row with an unconsumed handoff is deliberately not delivered** — it is in the run's
court, waiting for the next run-locked pass (`handoff_at IS NOT NULL AND consumed_at IS NULL`).

A permanently failing intent surfaces as: a throttled herdr notification (only `evidence_publish`
implements notify today); the repo log line `<key>: <kind> intent deferred (attempt N): <error>`; the
amber `⚠` problem flag on the run's TUI dashboard card (evidence only, and only once `error_class` is set —
a never-attempted row is deliberately not a problem); `doctor`'s `evidence uploads` row; the
`obligations` endpoint (`GET /repos/<r>/obligations?key=<KEY>`); and `explain <KEY>`'s "Owed to the
world" section (attempt count, next retry time, the credential fix for an auth-class failure).

Retrying:

```sh
herdr-factory --repo <r> retry-now [KEY]                              # clear ALL suspensions + rows due now + flush
curl -s -X POST 127.0.0.1:8765/repos/<r>/intents/<id>/retry            # un-suspend + due now, one row
curl -s -X POST 127.0.0.1:8765/repos/<r>/intents/<id>/fulfil \
     -H 'content-type: application/json' -d '{"result":{}}'            # resolve an external_wait
curl -s -X POST 127.0.0.1:8765/repos/<r>/intents/recover \
     -H 'content-type: application/json' -d '{"causeScope":"publisher:s3"}'
```

- `retry-now` (`POST /repos/<r>/retry-now`, body `{}` or `{"key":"<KEY>"}`; `s` on the TUI board) is the
  blunt instrument and usually the right one: every suspended `pending` row in the repo — or one run's —
  is cleared with a fresh 10-attempt window (`attempts` reset to 0), every merely mid-interval row
  becomes due now (its `attempts` kept), then Phase 0 is flushed **under the repo tick lock** so the
  rows land on that call (`flushed: false` in the answer means a tick already held the lock and will
  deliver them). It reports `requeued` (rows that were actually stuck — `0` means the delay is
  elsewhere) and `unsuspended` (the cleared suspensions). It changes nothing about any run: no phase,
  no clocks.
- `retry`/`retry-now` only touch `status='pending'` rows — a `failed`/`abandoned` row **cannot** be
  retried this way; the engine re-opens it on the next natural trigger. `waiting` rows (external
  triggers) are untouched too.
- **AWS creds recovery path**: refresh the credentials, then either wait (the publish kind's
  pre-pass probes liveness and re-queues automatically) or force it with `retry-now` /
  `intents/recover {"causeScope":"publisher:s3"}`. Cause strings are `source:<sourceName>` and
  `publisher:s3|local|command`. Note `resume` does **not** make a stuck upload due now unless the
  kind opts in (`refundOnResume`) — and no shipped kind does; `retry-now` is the tool for that, and it
  works on a healthy, unparked run, which `resume` refuses.
- A source-auth recovery re-queues that source's held write-backs automatically the moment any call
  to it succeeds.
- **Making a credential helper visible to the server.** A dedicated profile whose ONLY credential
  source is the helper — do not add `credential_process` to a profile that already has `sso_session`
  (the AWS CLI resolves SSO first and fails on the stale `~/.aws/sso/cache` token):

  ```ini
  # ~/.aws/config
  [profile my-app-factory]
  credential_process = granted credential-process --profile my-app
  region = ap-southeast-2
  ```

  Point `evidence.profile` at `my-app-factory` and `herdr-factory reload`. No `--auto-login` — a
  background server must never pop a browser; when the helper's session lapses the factory notifies
  and resumes on the next tick after you log in again. Verify with `doctor --deep` (a real S3
  round-trip) and the credential config is re-read on every attempt, so no restart is needed.

---

## 9. Escalating nudges — least to most destructive

| # | Action | What it does |
|---|---|---|
| 1 | `herdr-factory reload` | Re-reads every repo's config into the running server. No run is touched. Can refuse a repo (read `failures[]`) |
| 2 | `herdr-factory --repo <r> tick` | Forces one reconcile pass now (via the server if up, else in-process under the tick lock). Level-triggered: it can only do what the next tick would have done anyway |
| 3 | `herdr-factory --repo <r> retry-now [KEY]` | Clears every suspended `pending` ledger row in the repo (or one run's) with a fresh attempt window, makes every waiting one due now, then flushes Phase 0 under the tick lock. Touches only those rows' schedules — no phase, no clocks, no run. The right move when you have already fixed a cause the engine can't probe (anything not `auth`-classified). `s` on the TUI board |
| 4 | `herdr-factory --repo <r> step-done <KEY> <step>` | Records the step complete, exactly as the agent would. Validated against the belt, the active step, and the `--pass` stamp. Un-parks a `rescue: terminal-signal` watchdog park. **Only use it if the work really is finished** |
| 5 | `herdr-factory --repo <r> resume <KEY>` | Un-parks an `attention` run back to `running`/`reviewing`/`claiming`/`waiting_for_human`: re-bases the step's watch clocks, refunds resume-scoped counters (capture, layout respawns, and — on a `bounce_limit` park — the bounce budget belt-wide), clears `lastThreadSig`/`resolverActive` for a PR watch, and nudges an idle pane to continue. Does **not** clear `run_steps.done`. Refuses while the belt is missing |
| 6 | `POST /repos/<r>/intents/<id>/retry` | Clears + re-queues ONE ledger row due now (no flush). Touches only that row's schedule |
| 7 | `herdr-factory restart` | Graceful `POST /shutdown` + SIGTERM, SIGKILL only after 18 s (outlasting the server's 15 s in-flight-tick drain), then re-spawn. In-flight runs survive; their agents keep working; locks the dead process held expire. This is the fix for a wedged tick |
| 8 | `herdr-factory --repo <r> teardown <KEY>` | **Destructive.** Fires the terminal write-back, then removes the herdr worktree, closes the workspace, `rm -rf`s the worktree path and **deletes the branch (`git branch -D`)**. Any uncommitted or unpushed work in that worktree is gone, and pending evidence uploads are abandoned (logged as `N evidence upload(s) dropped at teardown`). The run ends with an outcome; re-claiming the item starts a fresh run on a fresh branch |

Only `teardown` destroys anything. `belt apply` (the TUI belt rename/delete flow —
[install-and-operate.md](./install-and-operate.md)) can also purge runs and clean worktrees — treat it
as equally destructive.

### 9.1 Stopping a run without losing its work

**There is no non-destructive per-run cancel or pause.** Nothing in the CLI or the HTTP API suspends
one run and keeps its worktree:

| what people reach for | what it actually does |
|---|---|
| `belt.active: false` (+ `reload`) | Gates **new claims only** — the claim loop skips the belt before polling and logs `belt <b>: inactive — skipping (no new claims; in-flight runs continue)`. Every in-flight run on that belt keeps reconciling, keeps its agent, keeps its worktree |
| `herdr-factory stop` | Stops the engine machine-wide. **Already-running worker agents keep running** in their panes, unsupervised; nothing advances until you `start` again. Not a per-run control |
| `resume` / `bounce` / `step-done` | Move a run *along* the belt. None of them ends it |
| `teardown` | The only way to end a run — and it is destructive (row 7 above) |

So "stop this one run" always means `teardown`, and teardown (`src/core/reconcile.ts`, `teardownImpl`
→ `removeRunWorktree`) removes the herdr workspace, `rm -rf`s the worktree directory, `git worktree
prune`s, and runs `git branch -D <run branch>` in the main checkout. **Uncommitted work, unpushed
commits, and un-uploaded evidence bytes are gone.** The *remote* branch is never touched — which is
the whole rescue. It also fires the terminal write-back first: a manual `teardown` is always outcome
`abandoned` ⇒ work state `aborted`, so the source item moves too (for `local_markdown` that means the
file is never re-listed). Re-claiming the item later starts a fresh run on a fresh branch.

**Before you tear down a run whose work matters:**

```sh
# 1. Find the run's worktree + branch (worktree_path is NOT in `status`, `runs`, or `obligations`).
DB="${HERDR_FACTORY_STATE_ROOT:-$HOME/.local/state/herdr-factory}/herdr-factory.db"
sqlite3 "$DB" "SELECT id, ticket_key, phase, step, branch, worktree_path
               FROM runs WHERE repo='<r>' AND ticket_key='<KEY>' AND ended_at IS NULL;"

# (No sqlite? `git -C <repo.path> worktree list` shows the same path/branch pairs.)
WT=<worktree_path>; BR=<branch>

# 2. See what would be lost.
git -C "$WT" status --porcelain          # uncommitted
git -C "$WT" log --oneline @{u}..        # unpushed (fails if the branch was never pushed)

# 3. Preserve it. Pushing is the durable option — the remote branch survives teardown.
git -C "$WT" add -A && git -C "$WT" commit -m "wip: $BR before teardown"
git -C "$WT" push -u origin "$BR"

# 4. Only now:
herdr-factory --repo <r> teardown <KEY>
```

If you can't push (no remote, secrets in the tree), copy the files out instead — but copy, don't move,
and expect the copy to be a **plain directory, not a git worktree**: a linked worktree's `.git` is a
file pointing into `<main checkout>/.git/worktrees/<name>`, which teardown prunes, so the copy's
history link dangles afterwards. Bundle the history first if you need it:

```sh
git -C "$WT" bundle create ~/rescue-<KEY>.bundle --all   # history, portable
cp -a "$WT" ~/rescue-<KEY>                               # working tree, incl. .memory/herdr-factory/
```

`.memory/herdr-factory/` holds the run's task doc, feedback files and un-uploaded evidence — copy it
if you care about the agent's reasoning trail, because pending `evidence_publish` intents are
abandoned at teardown (`N evidence upload(s) dropped at teardown`).

To stop the *belt* from picking up more while you sort this out, set `belt.active: false` and
`herdr-factory reload` — remembering it does nothing to the run in front of you.
