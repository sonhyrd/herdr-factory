# The end-to-end harness

`npm test` proves the reconciler is right against fakes. This suite proves the **factory** is right:
a real `serve`, a real headless herdr building real worktrees and PTY panes, real agents signalling
through the real CLI, real SQLite, real prompt rendering, real intent delivery — in a container, in
seconds, with machine-readable results.

```sh
scripts/e2e                                   # build the image, run everything, collect artifacts
scripts/e2e --scenario w2pr-happy --keep      # one scenario, keep its world
scripts/e2e --no-build -- --reporter=verbose  # iterate without rebuilding
HF_E2E_SLOW=1 scripts/e2e                     # include the slow scenarios
```

Results land in `artifacts/e2e/<timestamp>/` (`artifacts/e2e/latest` points at the newest):
`summary.md`, `results.json`, `junit.xml`, and per scenario the SQLite DB, the engine log, the herdr
server log, the agent transcript, every rendered prompt, and the `gh`/`herdr` argv traces.

## The model

|  | choice | what it buys |
|---|---|---|
| **Lane** | `real` (default) — a headless `herdr server` per world | the herdr contract, layouts, agent adoption, prompt delivery |
| | `fake` — a shim on `HERDR_BIN_PATH` (`harness/herdr-fake/`) | failure injection herdr won't do on request, and scale without PTYs |
| **Tier** | `scripted` (default) — the harness's agent | determinism: every scenario and edge case, in seconds |
| | `ds4` — a local model via opencode (`--tier ds4`) | that a real model can follow the **shipped** prompts |
| **Driver** | `serve` (default) — the resident server ticks itself | the production shape: auth gate, poll cadence, `/evidence`, hot reload |
| | `tick` — one pass per call | pass-by-pass determinism when a scenario needs it |

## Writing a scenario

```ts
scenario({ name: "...", briefs: {...}, config: (p) => ({...}), agent: {...} }, async (w) => {
  await w.waitForPhase("my-key", "reviewing");
  w.gh.merge(w.db.run("my-key")!.pr_number!);
  await w.waitForEnd("my-key", "merged");
  expectTimeline(w, "my-key", ["claimed", "pr_opened", "torn_down"]);
});
```

- **`config`** returns the repo's `config.yml`, merged over harness defaults (`repo`, compressed
  `limits`, `agent: claude`). Time is compressed with config, never a fake clock — `core/layout.ts`
  mixes `deps.now()*1000` with `Date.now()`, so an injected clock is unsafe on the layout path.
- **`agent`** is the behaviour script: `commit`, `hangMs`, `signal` (`step-done`/`bounce`/
  `ask-human`/`none`), `captureAttempts`, `evidence`, `replayStalePass`, `openPr`, `setBranch`
  (rename onto the repo's branch convention via the prompt's `set-branch` command), `run`. Resolution
  is `passes["<step>:<pass>"]` ▸ `steps[step]` ▸ `default` ▸ built-in. `w.setAgentScript()` swaps it
  mid-scenario (the agent re-reads it every turn).
- **`fleetMachines`** declares extra `serve` processes in the same world — each another MACHINE of the
  fleet, with its own config dir, state root, port, DB and briefs folder over the same target
  checkout, and its repo named after the machine. The world writes the fleet's transport override
  (`HERDR_FACTORY_FLEET_ENDPOINTS`) and answers `herdr machine list` from a file of its own — on the
  real lane through the world's `herdr` wrapper, so a scenario's fleet never touches the operator's
  saved machines — and the fleet reaches them with no SSH, the only part of the transport a container
  cannot have. `w.machine(name)` is that factory: its `cli()`, its `api()`, and `stop()` for the
  "a machine goes away" half of a fleet assertion.
- **Assertions** rank: `w.db.run()/events()/steps()/intents()` → `expectTimeline` /
  `expectParked` / `expectNoPendingIntents` → `w.factory.repoApi("GET", "obligations?key=…")` →
  filesystem (`w.branchExists`, `w.humanInbox`, `w.factory.evidence`) → argv traces
  (`w.herdr.notifications()`, `w.herdr.paneReports()`, `w.gh.calls()`).
- **Where a park's explanation lands decides which helper you wait on.** `w.waitForNote(key, …)` is
  for a COMMENTS-channel source (jira/github_issues/sentry) only; everything else —  every mechanical
  park, and a work error on a file-channel source such as `local_markdown` — is submitted into the
  run's own pane, so wait on `w.waitForPaneReport(key, …)` instead. Getting this backwards is silent:
  the run parks correctly and the assertion just times out.
- **Every failure** carries `w.diagnose()`: run state, timeline, engine log, agent transcript, herdr
  agents, and every pane's `process-info` + screen.

The scripted agent **reads the rendered prompt and runs the signal command it finds there** — it
never reconstructs one. That makes the suite a live check of the agent-CLI contract
(ARCHITECTURE §14: those command lines are baked into prompts of agents that outlive any restart).

## Scenarios

| Scenario | Covers |
|---|---|
| `w2pr-happy` | brief → work → review → pr → PR opened → merged → teardown; transition order, branch + worktree reaped |
| `branch-rename` | the repo's branch convention wins: the work agent `set-branch`es onto a ticket-key name, and the push, the PR, the merge watch and teardown all follow it while the worktree keeps its own name |
| `custom-belt` | a `custom` pipeline, config-folder prompt files, token rendering, `completed`, no PR machinery |
| `layouts` | plugin hook, `layout.apply` per tab, blocking setup, splits, step→pane dispatch, pane display metadata, hand-created worktrees |
| `layout-setup-on-agent-pane` | regression: an agent pane that also runs the layout's setup still gets its agent |
| `fast-signal` | regression: a `step-done` that beats its own dispatch is accepted, not dropped |
| `budget-park` | an agent that finishes without signalling is parked, reported three ways, and healed by `resume` re-prompting it |
| `stall-park` | an agent that stops committing trips the heartbeat, and recovers when it commits again |
| `read-only-violation` | a gate that commits is caught with its evidence — and still honoured if it completed |
| `bounce-cap` | rework bounces are counted, the oscillation parks at the cap, and `resume` refunds the budget |
| `ask-human` | a blocked agent asks through the work source, frees its slot, and resumes on the answer |
| `ask-human-self-resolved` | an agent that asks and then unblocks itself: its `step-done` un-parks the run and closes the moot question |
| `missing-api-key` | an uncredentialed source is never dialled and never claims, while its neighbour ships; credentials un-pause it |
| `evidence` | the opt-in evidence station captures, publishes through the `local` publisher, and the resident server serves the bytes |
| `evidence-publish-retry` | a failing publisher retries in the background, flags the run's `problem`, and delivers once `intents/recover` is called |
| `capture-cap` | a flaky capture loop parks at the cap — and the station's own verdict still wins |
| `pr-review-watch` | a draft PR keeps the step-done gate, a ready one hands off without it, and a new review thread wakes a resolver that holds a slot only while working |
| `pr-closed-park` | a PR closed without merging parks for a human and keeps its worktree |
| `belt-matrix` | priority order, a `match` predicate, first-match-wins, an `active: false` belt that takes nothing, and the per-source cap |
| `config-rejections` | 12 broken configs are each refused at load with a message that names the problem — and the server survives all of them |
| `jira-parity` | a source whose status of record is the BACKEND: label pickup, ordered write-backs, a belt effect onto a custom Jira column |
| `jira-ask-human` | the reply channel as comments, including the marker filter that stops the factory answering itself |
| `jira-stale-item` | a ticket that vanishes is `stale`, not an infinite retry |
| `sentry-parity` | the mirror image: internal ledger, Sentry never moved for lifecycle, the `on_merge` note, and a release regression reopening the work |
| `fleet-cli` | the fleet: two factory servers in one world (its own config dir, state root, port and DB each) merged into one `fleet --json`; discovery really goes through `herdr machine list`, and stopping one machine reports it `unverifiable` with its last-seen time, never as empty |
| `herdr-unreachable` | an outage injected into the world's wrapper: liveness DEFERS while herdr can't be asked, judges once it can, and never respawns a second agent |
| `perf-scale-drain` | 60 briefs through a cap of 5: one run per item, the cap never exceeded (sampled continuously), every item terminal |
| `perf-call-budgets` | 12 watched PRs cost **one** batched GraphQL query per pass — no per-run `pr view`, no re-discovery by `pr list` |
| `perf-tick-latency` | p50/p95 of a full pass with 20 active runs, and that one slow `gh` costs its own call rather than the loop |
| `tui-boot` | the real launcher in a real PTY: opentui's FFI resolves, `app_ready` inside its budget, no stack trace on screen |
| `tui-fleet` | the fleet in the terminal: the real TUI over two factory servers — both machines' headers and runs on screen, `x` on a key BOTH machines are working tearing down only the one on the machine the card belongs to (its own server serves it; the twin here is untouched), and a machine that stops answering turning its rows `unverifiable` with its last-seen time rather than blanking them |
| `tui-theme` | the TUI follows herdr's theme, read from a real `config.toml` at launch: `tokyo-night`, `HERDR_FACTORY_THEME` overriding it, an unknown name falling back, and no herdr theme still light |
| `ds4-w2pr` | *(tier ds4)* a real local model, the **shipped** prompts, no harness hints: does the work reach a PR? |
| `perf-resource-soak` | ~900 passes (six full lifecycles, then a long idle tail): RSS, FDs, DB and worktrees stay flat, and the server is still healthy |

What they measure, from the container run (every scenario records its numbers into `metrics.json`, and
`summary.md` reprints them — so a regression shows up as a number, not a feeling):

| | measured |
|---|---|
| 12 watched PRs over 5 passes | **5** GraphQL calls, **0** `pr view`, **0** `pr list` — one batched query per pass, flat in the number of PRs |
| a full pass with 20 active runs | p50 **36ms**, p95 **43ms**; a 3s-sleeping `gh` costs its own pass (**3046ms**) and the next is **50ms** |
| 60 items, source cap 5 | drained in **62s** (~1.0s/item), cap reached and never exceeded across ~300 samples |
| ~900 passes | RSS **+54%** (under the 2× tripwire, and the number to watch), FDs **24 → 24** (peak 27), DB **+200KB**, worktrees back to **1** |
| TUI boot in a real PTY | node **25ms** → modules **41ms** → `app_ready` **61ms** |

## Things the harness found — and what changed

Each was reproduced end-to-end, fixed in the engine, and is now pinned by a scenario that fails if it
comes back.

1. **An agent pane that also ran the layout's `setup` command never got an agent.** `paneScript`
   appended `HAND_BACK = exec $SHELL -i` to any agent pane carrying a command, and herdr 0.7.5's
   `agent start` then accepted the request but launched nothing (`agent.get` timed out after 60s;
   `pane process-info` showed the pane's process replaced by a non-login `/bin/bash -i`, where a
   working agent pane shows the agent as a child of herdr's own shell). Every step targeting the pane
   burned its layout wait and the run parked `layout_wait_timeout` — and the shipped README's
   canonical layout is exactly this shape. **Fixed** (`core/layout.ts`): an agent pane is handed to
   herdr as a plain shell and the setup command is run *in* it with `pane run`.
   → `layout-setup-on-agent-pane`.
2. **A signal that arrived before the engine recorded the dispatch was dropped, and the agent could
   not tell.** `reconcileClaiming` wrote `run.step` only after `spawnStep`, which blocks until herdr
   reports the agent ready — with the prompt already delivered on the argv. A `step-done` in that
   window was rejected (`"work" is not the run's active step ("none")`) and the run then waited for a
   signal that never came again, until its budget expired; the rejection **exited 0**. **Fixed**:
   `run.step` is recorded before the dispatch (`core/reconcile.ts`, matching what every later step
   already did) and a rejected signal now prints to stderr and exits 1 (`cli/index.ts`). Because
   `run.step` is now set during `claiming`, "still claiming" is read from `isPreDispatchClaim`.
   → `fast-signal`, which asserts the race actually happens *and* is handled.
3. **`HERDR_AGENT` in a pane's env pre-claims the pane** — `agent start` answers `agent_pane_busy:
   not an available shell` — and the factory was setting that hint on the very pane it was about to
   adopt into. **Fixed** (`clients/herdr.ts`): the hint is set only on the typed (`run`) path, which
   is the case it exists for. → covered by every adopt-path scenario.
4. **herdr identifies a pane's agent by the foreground process's `argv[0]`.** `exec node agent.cjs`
   is never detected (60s timeout); `exec -a claude node agent.cjs` is adopted in ~3s. Not an engine
   bug — a fact anything wrapping an agent must respect (the harness's own shims do).
5. **`pane report-agent` takes agent authority over a pane**: calling it during startup knocks out
   herdr's own adoption record and `agent start` then fails on `agent.get`. Real harnesses don't call
   it; neither does the scripted agent.
6. **`bounce` and `ask-human` could never read their own arguments.** `bin/herdr-factory` did
   `cd "$pkg"`, so the CLI resolved the RELATIVE file paths the prompts render
   (`--reason-file .memory/herdr-factory/bounce-<step>.md`) against the factory checkout instead of the
   agent's worktree: ENOENT every time, i.e. the rework loop and the human loop both silently broken
   for any agent that ran the command it was given. **Fixed**: the launchers run the entry by absolute
   path and leave the caller's cwd alone (nothing in `src/` depended on it — §14 already required
   that). → `bounce-cap`, `ask-human`.
7. **A finished agent (`done`) was treated as not ready.** herdr latches `done` once an agent has
   completed a turn — exactly the state the commonest park leaves behind — so `resume` declined to
   re-prompt it and the layout dispatch would have declined to use it. **Fixed**: `isReadyForInput`
   (`idle` or `done`) at both gates. → `budget-park`.
8. **`resume` decided on a stale pane state.** The nudge read the ~5s agent-list memo (which exists to
   collapse per-tick liveness polling), so a resume arriving seconds after an agent stopped could see
   "still working" and nudge nobody. **Fixed**: a fresh read for that one-shot operator action, and the
   observed state is recorded on the `resumed` event so `nudged:false` is diagnosable. → `bounce-cap`.
9. **A belt that MIXES layout panes with dedicated-pane steps silently loses its layout.**
   The layout hook only builds into a *fresh* (1-tab/1-pane) worktree, and the engine's first
   dedicated-pane spawn adds a tab — so if the first step has no `tab`/`pane`, the hook finds a
   two-tab workspace and skips. Every later step that DOES target a layout pane then waits for a pane
   that will never exist, burns its layout wait and parks `layout_wait_timeout`. Config-load can't see
   it today (it only checks that targeted panes exist in the layout). **Found, not fixed** — the fix is
   a design call (reject the mix at load, make the hook tolerant of factory-created tabs, or hold the
   first dedicated spawn until the layout decision lands). Every layout scenario here gives all of its
   steps a pane, which is the shape to recommend meanwhile.
10. **An inline evidence publish leaves no trace in the timeline.** `evidence-upload` publishes
   inline and marks its ledger intent delivered; `evidence_uploaded` is recorded only by the LEDGER
   delivery, i.e. only when the publish was deferred and retried. The happy path is observable through
   the intent row and the bytes, not the event log. **Not fixed** (a one-line addition if you want the
   event on both paths).
11. **Teardown drops an undelivered evidence publish** — deliberately (the bytes live in the worktree
   it is removing), which a `work_to_pull_request` belt never notices because the PR watch keeps the
   run alive, but a short belt can. The evidence scenarios carry a `pr` step for exactly this reason.
12. **A Jira ticket that vanished was retried forever.** `github_issues` maps its own 301/404/410 to
   `stale` (`classifyGone`), but `jira-source` had no equivalent: `transition` rethrew, so the outbox
   retried a deleted ticket on its 60s→1h backoff indefinitely — and, because Phase B skips an item
   with an undelivered write-back, the item stayed un-claimable behind it. `askHuman`/`pollHumanReply`
   surfaced the raw HTTP error too, where §5 says they throw `StaleItemError` so a waiting run
   escalates rather than polling a ticket nobody can answer. **Fixed** (`clients/jira-source.ts`):
   404/410 → `stale` / `StaleItemError`, same rule and same reason as github_issues.
   → `jira-stale-item`. (Found while the Jira fake was being verified against the real client — the
   fake's own 404 injection is what asked the question.)
13. **Jira `materialize` on a gone ticket returns normally**, having written no `ticket.json`, so a
   claim can point an agent at a work doc that doesn't exist. Left as-is: `materialize` is
   best-effort by charter, and with the fix above the claim's own write-back now reports `stale` and
   the run is aborted before the agent gets far. Worth revisiting if that ordering ever changes.
14. **Documentation drift** (fixed): `runs.pr_number` / `resolver_active` / `last_thread_sig` moved to
   `run_products` in v18 but ARCHITECTURE §6 still showed them on `runs`; the §6 event list named
   `merged`/`closed`, which nothing emits, and omitted `layout_applied`, `layout_apply_failed`,
   `intent_deadline`, `intent_fulfilled`.

15. **Concurrency is capped at two levels, and the source's is the tighter default.** The first
   `perf-scale-drain` set `limits.max_active_workspaces: 5`, asked for 60 items, and drained the whole
   backlog **two at a time** — a work source's own `max_active_workspaces` defaults to 2, and nothing
   logs "at capacity" when the source cap is what binds. Both defaults are documented (README, and the
   skill's config reference); the scenario now sets both and asserts *which one* binds. Setting only the
   repo-wide limit is the trap: it looks like the throughput knob and isn't. Fixing it took the same
   drain from 60 items in 180s to 60 in 76s.

## Traps in the harness itself (each now fails loud instead of lying)

A fake that lies is worse than no fake. Three of these cost real time, and all three presented as "the
agent never signalled" 120 seconds later — so each now has a guard that fires at world start.

- **A pane's login shell reorders PATH.** macOS's `/etc/zprofile` runs `path_helper`, which rebuilds
  PATH from `/etc/paths[.d]` and *appends* what it inherited — so the world bin landed behind
  `/opt/homebrew/bin` and herdr's `--kind claude` launched **real Claude Code** into the pane. It
  adopted as `claude`, reported `idle`, and never signalled. Fixed with world dotfiles that re-prepend
  the bin after the system profile, and `assertShimsWin()`, which resolves every shim through
  `$SHELL -lic` and refuses to start if anything but the world's own binary wins.
- **The engine's launcher needs Node ≥ 26.** A real-lane pane happened to find homebrew's 26; a
  fake-lane agent (a direct child, no login shell) found mise's 24, and every `step-done` died with a
  version error that the agent correctly reported as "not a rejection, not retrying". The world now
  ships a `node` shim pointing at the harness's own node, the harness refuses to run below 26, and
  `assertShimsWin()` runs `herdr-factory --version` through a pane's shell before any scenario starts.
- **`date +%s%3N` is GNU-only.** On macOS the wrapper wrote `{"ts":17850611963N,…}` — invalid JSON —
  so `calls()` silently degraded and `notifications()` always answered "none fired", making every
  notification assertion vacuously true. The timestamp now falls back to whole seconds, and `calls()`
  THROWS on a malformed line (only a torn final line, which a live append can produce, is skipped).
- **The argv log is LINE-based, so a multi-line argument arrives split.** The wrapper records
  `printf '%s\n' "$@" | jq -R .`, which makes one array entry per LINE — a park's pane report puts its
  `Resume with: … resume <KEY>` tail in `argv[4]`/`argv[5]`, and a multi-line `--body` loses everything
  after its first line. Anything reading a recorded argument now rejoins those entries
  (`paneReportsFrom`, `flagValueFrom`, stopping at the next `--flag`), because the failure is silent:
  the assertion just never matches and times out 90 s later against a run that did exactly the right
  thing.
- **One submission is one turn — even when it spans lines.** The scripted agent reads stdin line by
  line, so a multi-line `agent prompt` (a park's operator report, with its `Resume with: …` tail)
  fired a full turn PER LINE. Each turn holds `working` for 1.5 s, so a 3-line report pinned the pane
  `working` for ~4.5 s of every 5 s park cycle — and `resume`, which never interrupts a working pane,
  could not nudge the agent while the run kept re-parking. Lines are now buffered and taken as a
  single turn once stdin goes quiet (`SUBMIT_QUIET_MS`).
- **Injection knobs must be file-backed, not env.** A resident `serve` never sees an env change, so
  `GhFake.inject()` / `FakeHerdr`'s knobs write to their state file, which the shims re-read per call.
  `HerdrServer.unreachable` is the same idea: a flag file the wrapper checks.

## Container notes (learned the hard way)

- The world root is **short** (`/h/<id>`): herdr's socket lives under its config dir and a long path
  overflows `sun_path`, killing the server at boot.
- Panes inherit the **herdr server's** environment, so the server is started with the whole world env
  — that is what makes an agent's `herdr-factory step-done` reach the world's config and state.
- The world's `herdr` wrapper (which records argv) must exec an **absolute** real herdr, or it
  re-resolves to itself and exec-loops.
- `notification show` degrades to `{shown:false, reason:"disabled"}` in a container — harmless, and
  the wrapper's argv log is how notifications are asserted.

## Not built yet (the plan's later milestones)

`github_issues` hardcodes `api.github.com`, so it cannot get the source-parity treatment jira and
sentry get (both take a configurable `base_url`); it needs a `GITHUB_API_URL` seam first. The fakes
under `harness/sources/` are stateful, not route tables: `jira-fake.ts` parses the pickup JQL and
really moves statuses, `sentry-fake.ts` serves the issue/event shapes the materializer renders — each
documented in its own `.md`, each verified by driving the ENGINE'S OWN client against it.

The **ds4 tier** runs on the HOST, not in the image: `opencode` isn't installed in the container and
the model server lives on the developer's machine. Run it with `HF_E2E_TIER=ds4 npx vitest run --config
test/e2e/vitest.e2e.config.ts` (or `scripts/e2e --tier ds4` once opencode is added to the image), with
the local server up on `:8000`. The tier filter defaults to `scripted`, so `--tier ds4` selects the
model scenarios and only those; a scenario always runs as the tier it declares. Preflight fails fast
and says which of the two prerequisites is missing rather than letting a scenario time out.

The mixed layout/dedicated-pane hazard the harness surfaced is now **closed at config load**: a belt
with `default_layout` whose first surviving step has no `tab`/`pane` is refused, because that step's
dedicated pane is a new tab and the layout hook then declines its freshness gate — so the layout is
never built and every later targeted step parks blaming herdr. Measured both ways with a throwaway
probe before choosing the fix; the reverse order was always fine, which is what made a load-time rule
the cheap answer. `config-rejections` pins the message; four unit tests pin the scope, including that
a *skipped* evidence step ahead of a targeted one stays legal.
