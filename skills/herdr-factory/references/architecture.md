# Engine architecture

How the engine actually works, so you can explain *why a live run did what it did* rather than guess. Mechanics only — the symptom→fix playbooks live in [troubleshooting.md](./troubleshooting.md).

Answers these questions:

- Why did nothing happen for 60 seconds? What is a "tick" and what does it do, in what order?
- What phase is my run in, what is it waiting on, and what will move it?
- Why did the factory not claim a new item even though slots look free?
- Why did a step get parked / respawned / re-run from the start?
- Why did the Jira status change (or fail to change) after the worktree was already gone?
- Why did the PR watch not wake an agent when a review comment landed?
- Why did my server restart itself?

---

## 1. The model

One resident server per machine holds a SQLite database of **runs**. A platform timer runs `herdr-factory ensure-up` every 60 s, which starts/restarts `herdr-factory serve` if it is down, wedged, or outdated. `serve` runs one **tick** timer per configured repo. A tick is a full **reconcile pass**: it flushes durable side effects, then walks every active run and moves it one step toward done, then claims new work if there is room. Everything is level-triggered — the tick alone is sufficient to make progress — and agent signals (`step-done`, `bounce`, `ask-human`) are edge nudges that reconcile *that one run* immediately instead of waiting for the next tick. All state lives in the DB; nothing is held in memory that a crash would lose.

```
launchd job / systemd timer ──every 60 s──▶ herdr-factory ensure-up
                                                  │  down? tick-stale? version != mine?
                                                  ▼
                          herdr-factory serve   (one per machine, binds 127.0.0.1:8765)
                                                  │
                    one setInterval per repo at limits.tick_interval_seconds (60 s)
                                                  ▼
                            reconcileRepo(repo)      ← under lock  tick:<repo>
                                                  │
   ┌──────────────────┬───────────────────────────┴──────────────────────┬────────────────────┐
   │ Phase 0          │ Phase A                                          │ Phase B            │
   │ LOCK-FREE        │ per-run locked, parallel (reconcile_concurrency)  │ claim new work     │
   │ flush the outbox │ reconcileRun() for every run with ended_at NULL   │ belts by priority  │
   └──────────────────┴───────────────────────────┬──────────────────────┴────────────────────┘
                                                  ▼  dispatchPhase(run.phase)
              claiming ─▶ running ─┬─▶ reviewing ─▶ tearing_down ─▶ done
                                   ├─▶ waiting_for_human ─(reply)─▶ running
                                   └─▶ attention  (parked: resume / auto-rescue / PR merge)
```

Agent nudges enter at the same `reconcileRun`, under `run:<id>` only — never the tick lock. `herdr-factory tick` with no server does the whole pass in-process.

---

## 2. The tick

`reconcileRepo` (`src/core/reconcile.ts`) runs under `tick:<repoName>`, TTL `max(tick_interval_seconds * 2, 300)` s. Held ⇒ the caller logs `another tick already running — skipping` and does nothing. The server also keeps a cheap in-memory `ticking` flag per repo; the DB lock is the cross-process backstop against a stray CLI `tick`.

### Phase 0 — flush the outbox (lock-free, must never mutate a run)

Flows run in this order, each in its own try/catch so one failure can't starve the other:

1. **transition outbox** — `source_transition` intents (status write-backs to Jira / GitHub / Sentry). First, because a pending write-back **vetoes claiming** that item, so write-backs must converge before eligibility is trusted.
2. **intent ledger** — every other intent kind, plus each kind's `prePass` and the deadline sweep.

Both drain `LIMIT 25` rows per pass, so a large backlog takes several ticks.

### Phase A — advance every active run

- `activeRuns(repo)` = `ended_at IS NULL`, ordered by `created_at`.
- **One batched GitHub GraphQL query first**, before the walk, for every run in phase `reviewing`, `attention`, or `waiting_for_human` that has a `prNumber`. A throw degrades to per-run polling with `batched PR fetch failed (N PRs) — falling back to per-run polling: …`.
- Runs are reconciled in parallel at `limits.reconcile_concurrency` (default 8), each under `run:<id>`.
- A run whose lock is already held by an in-flight nudge is **skipped this pass**: `<KEY>: busy (nudge in flight) — skipped this pass`.
- A per-run throw is caught, logged, recorded as an `error` event; the pass continues.

### Phase B — claim new work

See §5. Ends by logging `claimed N; working X/Y, idle/parked Z` and calling `touchTick(repo)`.

### Ordering guarantees you can rely on

| Guarantee | Why it matters |
|---|---|
| 0 → B: write-backs converge before eligibility is trusted | merged work is not re-claimed and re-done |
| A → B: occupancy counted after this pass's teardowns and parks | a slot freed this tick is usable this tick |
| Phase 0 never mutates a run (the "two-lane contract") | delivery is lock-free; a run reaction crosses lanes as a *handoff* consumed once under the run lock |
| `touchTick` runs at the end of every completed pass (including the at-capacity early return) | it is the **only** signal the wedged-tick watchdog reads |

### `reconcileRun` — per-run order

1. Resolve source and belt once. Missing ⇒ park `belt_missing` / `source_missing` (a `tearing_down` run still finishes cleanup; `attention`/`done` are left alone).
2. **Stale policy**: an unhandled stale write-back. If `toState === "in_development"`, `prNumber == null`, phase ∈ {`claiming`,`running`} ⇒ the work never really started ⇒ `teardown("abandoned")`. Otherwise park `source_item_stale`. Returns either way.
3. **Pending agent signal** (`bounce` / `ask_human` durable rows) — applied ⇒ return.
4. **Ledger handoffs** — a handoff may return an escalation, which parks here.
5. `dispatchPhase(run.phase)`.
6. `applyPendingFocus` on every pass (moves the user's herdr focus to the active step's pane, but only if they are already on this worktree and on one of this belt's panes).

### Level-triggered vs edge-triggered

The tick is the backbone: budgets, stalls, PR state, human replies, respawns, and re-notifications are all *level* checks that re-derive the truth from the DB and the world. Nothing depends on an event having been delivered. Agent nudges are pure latency optimizations — `step-done` is fire-and-forget under `run:<id>` because the `done` flag is monotonic and durable *before* the nudge; `bounce` and `ask-human` are recorded as durable intents first and then use a bounded ~15 s lock wait (30 × 500 ms), so a contended run answers `run busy — question recorded; it will be posted on the next reconcile pass` and loses nothing.

---

## 3. The run state machine

Exact phase strings (`src/types.ts`): `claiming` · `running` · `waiting_for_human` · `reviewing` · `tearing_down` · `done` · `attention`.

Outcomes the reconciler actually writes: `merged`, `completed`, `abandoned`. (`closed` and `timeout` exist in the type and in the config vocabulary but no code path writes them.)

```
                      ┌───────────┐
   Phase B claim ────▶ │ claiming  │ ──layout pane never came up──▶ attention
                      └─────┬─────┘
        first step dispatched│
                            ▼
   human reply         ┌───────────┐ ──terminal pr step + live non-draft PR──▶ ┌───────────┐
      ┌────────────────│  running  │                                          │ reviewing │
      │      ask-human └─────┬─────┘ ──last step done, belt has no pr step──┐  └─────┬─────┘
      │      ┌──────────────▲│                                             │  PR MERGED│
      ▼      ▼              ││                                             ▼  ◀────────┘
┌─────────────────────┐     ││                                     ┌──────────────┐   ┌──────┐
│  waiting_for_human  │─PR merged─▶                                │ tearing_down │──▶│ done │
└─────────────────────┘     ││                                     └──────────────┘   └──────┘
                            ││                                            ▲
  guard park · bounce_limit ││ resume · step-done · bounce                 │ adopted PR merged
  pr_closed · stale · … ────▶└─────── ┌───────────┐ ───────────────────────┘  or manual teardown
                                      │ attention │
                                      └───────────┘
```

| From → To | Trigger |
|---|---|
| — → `claiming` | `createRun` (Phase B claim, or `claim <KEY>`) |
| `claiming` → `claiming` | worktree not ready, or the first step's layout pane isn't up yet |
| `claiming` → `running` | first step dispatched; then the `enter` effect fires (engine default `in_development`) |
| `claiming` → `attention` | `layout_wait_timeout`, `belt_missing`, `source_missing` |
| `claiming` → `tearing_down` | pre-work stale write-back (abort), or manual `teardown` |
| `running` → `running` | forward advance to the next step; bounce rewind; confirmed-dead-pane respawn |
| `running` → `waiting_for_human` | `ask-human` signal consumed |
| `running` → `reviewing` | terminal PR-opening step adopts a live non-draft (or merged) PR |
| `running` → `tearing_down` → `done` | last step done on a belt with no PR watch ⇒ outcome `completed` |
| `running` → `attention` | any guard park, `bounce_limit`, `pr_closed`, `unknown_step`, mid-flight `source_item_stale`, `external_wait_deadline` |
| `waiting_for_human` → `running` | reply found; or self-heal when there is no pending question but `run.step` is still valid |
| `waiting_for_human` → `attention` | `human_wait_missing_question`, `human_poll_failing`, `source_item_stale` |
| `waiting_for_human` → `tearing_down` → `done` | the adopted PR merged while parked (checked **before** the question) ⇒ `merged` |
| `reviewing` → `reviewing` | resolver woken, resolver observed idle, or the PR went green (one "ready to merge" notification — the factory never merges) |
| `reviewing` → `tearing_down` → `done` | PR `MERGED` ⇒ `merged` |
| `reviewing` → `attention` | PR `CLOSED` ⇒ `pr_closed` |
| `attention` → `running` | watchdog-park rescue on a genuine `step-done`; accepted `bounce`; `layout_wait_timeout` respawn rescue |
| `attention` → `running`/`reviewing`/`claiming`/`waiting_for_human` | human `resume` (target derived from progress, §4 seam E) |
| `attention` → `tearing_down` → `done` | adopted PR merged while parked; or manual `teardown` |
| `tearing_down` → `done` | teardown finished: `phase='done'`, `outcome`, `ended_at` set |

A crash mid-teardown leaves `phase='tearing_down'` with `ended_at NULL`, so the run is still active and the next pass re-runs teardown (idempotent).

### What each waiting state is waiting on

| Phase | Waiting for | Driven by | Holds a concurrency slot? |
|---|---|---|---|
| `claiming` | the herdr worktree, then the first step's configured pane showing an **idle** agent | every tick, bounded by `layout_wait_seconds` | **yes** |
| `running` | the step agent's `step-done` / `bounce` / `ask-human` | nudge (edge) + watchdogs (level) | **yes** |
| `waiting_for_human` | a source-native human reply to the posted question | poll on a flat 30 s cadence | no |
| `reviewing` | the PR to merge or close; actionable review state to wake a resolver | one batched GraphQL query per tick; **no time limit** | only while `resolverActive` |
| `attention` | a human (`resume` / `teardown`), plus auto-rescues and a PR merge | tick; re-notify every `attention_renotify_seconds` | no |
| `tearing_down` | worktree removal and branch delete | tick | **yes** |

Occupancy is a SQL predicate, not a counter: `ended_at IS NULL AND phase NOT IN ('attention','waiting_for_human') AND NOT (phase='reviewing' AND run_products.active = 0)`.

---

## 4. Step entry and advance

Three distinct pieces of per-step state, deliberately separate:

| State | Meaning |
|---|---|
| `run_steps.pass` | which **entry** into this step the state belongs to. Baked into the pass's prompt as `--pass N`, so a signal from a superseded pass is rejectable. |
| `run_steps.started_at` | pass bookkeeping only — the layout-wait window and per-attempt dispatch clock. **Not** the budget clock. |
| `run_steps.dispatched_at` | "this pass's prompt reached an agent". `null` ⇒ the spawn branch, not a watchdog, owns the retry. |
| `run_steps.pane_id` | the pane-reuse handle; deliberately **survives** re-entries, so it can never mean "dispatched". |
| `watch_state(run_id, step, watch)` | the actual watch clocks: `budget.based_at`, `heartbeat.sig`/`based_at`, `read_only.sig`/`based_at`. |

### The invariant

> **Every (re-)entry into a step re-bases that step's clocks.** Any seam that re-points `run.step` at a step must (a) clear `done`, (b) bump `pass` and null `dispatched_at`, (c) stamp a fresh `started_at` with `absent_at = null`, and (d) call `applyWatchRebase(runId, step, trigger)`.

The bug this exists to prevent (RWR-18147): after a bounce, an intermediate step's `done` was cleared but its ancient `started_at` survived; if the layout pane wasn't instantly ready the spawn returned `waiting` without re-basing, and the very next tick's budget watchdog parked the run "over budget (idle)" before it had ever re-run.

Re-bases **write NULL rows, never delete** — a delete would let a legacy fallback resurrect a cleared clock. Rebase triggers are declared per guard: `budget` rebases on `entry`, `resume`, `reply_resume`; `heartbeat` and `read_only` on `entry`, `resume`.

### The seams, and exactly what each does

| Seam | Effect |
|---|---|
| **A. Spawn success** | render `prompt-<step>.md`, dispatch, then record `{paneId, startedAt: now, absentAt: null, dispatchedAt: now}`, set `budget.based_at = now` unconditionally, reset guards with `resetOn: "dispatch"`, and for a read-only step set `read_only = {sig: HEAD, basedAt: null}` (unfrozen). On `waiting`, **nothing is recorded** — the caller decides. |
| **B. Forward advance** | `{phase:"running", step:next}` → fire the next step's `enter` effect (no engine default for a non-first step) → reset `resetOn: "forward_entry"` guards → `{done:false, startedAt:now, absentAt:null, pass:+1, dispatchedAt:null}` → rebase `entry` → spawn. |
| **C. Bounce** | rewinds the target **and every completed step between the target and the bouncer** (`done:false` + rebase `entry`), so an intermediate evidence step really re-captures. Target also gets `pass:+1`, `dispatchedAt:null`, fresh `startedAt`. Writes `feedback-<toStep>.md`, releases the bouncer's exclusive-resource locks, then spawns the target. The bouncer never sets its own `done`, so the forward pass re-enters it cleanly. |
| **D. Human-reply resume** | deliberately narrow: clear `done`, fresh `startedAt`, rebase `reply_resume` ⇒ **budget only** (the frozen read-only baseline and the stall history survive). The pass is **not** bumped, so the already-baked `--pass` stays valid. Re-prompts the live pane if there is one, else spawns. |
| **E. Human `resume`** | target derived from progress: pending question ⇒ `waiting_for_human` (fresh poll window); valid `run.step` ⇒ `running` with rebase `resume` (budget + heartbeat + read_only) and `resetOn:"resume"` refunds — but **`done` is not cleared**, so a step already done advances on the next pass; else PR-watching belt with a `prNumber` ⇒ `reviewing` with `lastThreadSig` cleared; else ⇒ `claiming`. A `bounce_limit` park additionally refunds the bounce counter for **every** belt step. |
| **F. Layout-wait respawn rescue** | from `attention`: bump the shared `layout_wait` counter, fresh wait window, back to `running`/`claiming`, then dispatch **in the same pass**. |
| **G. Watchdog-park rescue** | from `attention` when the step is recorded `done` and the park reason is auto-rescuable: back to `running`, clear a read-only baseline so the same HEAD move can't re-trip, then advance **in the same pass**. |

### `reconcileStep` order of operations

1. **Spawn branch**: no run-step row, or no `pane_id`, or `dispatched_at == null` ⇒ spawn; `waiting` ⇒ layout wait; return.
2. **PR adoption** (only for a step declaring `opensPr`): adopt the PR number when its state isn't `CLOSED`; a `CLOSED` PR is acted on **only when it is ours** (`pr.number === run.prNumber`), so a stale closed PR on a reused branch can't disturb a fresh attempt.
3. **Pre-advance watches** (today: `read_only`). `park` ⇒ escalate. `defer` ⇒ end the pass.
4. **Advance** if `done`, or the PR is `MERGED`, or the PR is ready for review (terminal PR step + PR-watching belt + a live non-draft PR): release step locks, archive `feedback-<step>.md` → `feedback-<step>-addressed-pass<N>.md`, fire `produce` effects, then next step / `enterReviewing` / `teardown("completed")`.
5. Not advancing ⇒ **watchdog watches** (heartbeat, then budget — declaration order, first trip wins).
6. **Liveness**: check the pane; if it looks gone, re-check with a fresh (unmemoized) read. herdr unreachable is never treated as dead. A first confirmed absence only stamps `absent_at`; only a **second** confirmed absence ≥ 45 s later respawns, and `done` is re-read first so a finished-and-exited agent is never relaunched.
7. Else log `<KEY>: awaiting step-done <step> (pane <id>)`.

### Layout wait

The wait window is `limits.layout_wait_seconds` (600). Past it, if the step's `layout_wait` counter is below the respawn limit (3), the layout pane's **own agent is re-started** when that pane resolves and is sitting at a shell prompt with no agent (the same `agent start` the build issues — kind and args off the layout pane, under the name the build gave it, Claude's folder trust pre-answered; the layout hook starts a pane's agent only once, so a start that failed would otherwise never be retried), and the wait is then **re-armed in place** (`layout pane … not up after Ns — re-arming the wait (retry i/limit)`). Only when the budget is spent does it park `layout_wait_timeout`. Wall clock before a park: `(1 + 3) × layout_wait_seconds` ≈ 40 min at defaults. The same 3 credits are shared by the in-place re-arm and the post-park rescue; a successful dispatch or a `resume` refunds them.

Dispatch never spawns its own pane when a `tab`/`pane` is configured — a fresh pane must be `idle`, and a reused pane that is `working` defers rather than queue into a foreign turn. The prompt submission itself is **confirmed** (`herdr agent prompt --wait --until working`): an unconfirmed one counts as "not dispatched" and retries under the same wait, so a dropped prompt can't start the budget clock. See [layouts.md](./layouts.md).

### Gate receipts and the per-step timing export

`gate_receipts` (v39) is the belt's answer to "has this already been checked on *this* tree?".
`herdr-factory gate <key> <name> -- <cmd>` runs a verification command in the run's worktree —
verbatim argv, no shell, no timeout, output teed, exiting with the command's own code — and records
`{step, pass, gate, command, head, exit_code, duration_ms, tail}`. The row's identity is
`(run_id, gate, head)`: the commit is what makes a receipt trustworthy, so re-running a gate at the
same commit **supersedes** its receipt instead of accumulating one, and the row count is the honest
count of distinct (gate, SHA) pairs the run verified. `herdr-factory gates <key>` renders them
CURRENT (head == the worktree's HEAD now, tree was clean), STALE, or DIRTY (`${HEAD}+dirty` when the
worktree had uncommitted work — it can never equal HEAD), which is what the `review` prompt is written
against.

Every `step-done` then records a **`step_timing`** event — `{step, pass, wallMs, shellMs, modelMs,
gates}` — where `wallMs` is the pass's `dispatched_at → now` and `shellMs` is the summed duration of
that (step, pass)'s receipts. It reports only what the engine measured: a gate run *bare*, or any
other subprocess the agent spawned, falls into `modelMs`. Rows die with the run (`purgeBeltRuns`
deletes them alongside `run_steps`/`guard_counters`); the events survive on the timeline.

### Why a "finished" step can look stuck

`step-done` is rejected when: the step isn't in the belt; the step isn't `run.step` (`"X" is not the run's active step ("Y") — signal ignored`, unless it is already done, which is a friendly noop); or the `--pass` doesn't match (`stale step-done for pass N — the <step> step is on pass M; finish the current pass and run its own step-done command`). One exception: the belt's **PR-opening step** is accepted while the run is in `reviewing`, because the hand-off to the PR watch clears `run.step` before that agent signals — and the ready-to-merge watch waits on that signal (#78). Bounce intents are re-validated against the issuing step *and* its pass at consume time.

---

## 5. Claiming

Phase B, in order:

0. **Machine gate** (only when `<configDir>/machine.yml` sets it): available memory below `min_free_memory_mb` ⇒ log `low memory: <free> MB < <min> MB — not claiming` (once per state change), `touchTick`, **return**. With `max_active_workspaces` set, everything below runs under the `machine:claim` lock, WAITED on for half a tick interval (floor 10 s, 500 ms polls) so repos ticking in lockstep each get a turn rather than the same one losing every tick (held past the wait ⇒ `machine claim lock held (another repo is claiming) — claims deferred N ticks (machine claim lock)`, return — N is the consecutive count in `repos.claim_deferrals`, cleared by every pass that does NOT defer on the lock — including the low-memory and absent-cap returns above, so it always means "deferred on the most recent pass"); `countOccupyingAll() >= cap` ⇒ `machine at capacity (n/N)` (once), return; else the machine headroom also caps `slots` in step 2. Running work is never touched.
1. `occupying = countOccupying(repo)`; `slots = limits.max_active_workspaces - occupying`. `<= 0` ⇒ log `at capacity (X/Y working, Z idle/parked)`, `touchTick`, **return**.
2. Cap `slots` at `limits.max_claims_per_tick` (10).
3. Per-source remaining = that source's `max_active_workspaces` (default **2**) minus its current occupancy, memoized for the pass and decremented as claims land.
4. Walk belts in **`priority` ascending** (ties keep config order). Per belt: inactive ⇒ `belt <name>: inactive — skipping (no new claims; in-flight runs continue)` **before any poll**; unknown source ⇒ warn; source at its cap ⇒ `belt <name>: source "<s>" at its concurrency cap (N) — skipping`, again before polling.
5. Poll eligible items — one poll per `(source, label)` per pass, cached. The poll-window gate engages only when the source's `poll_interval_seconds` exceeds the tick interval; last-poll time is in-memory on the long-lived server, so a one-shot CLI `tick` always polls. Any poll failure degrades to an empty list so one source can't starve the others; an auth failure additionally **pauses** that source's claims and write-backs until any call to it succeeds.
6. Per item, in the source's order: stop on either slot counter hitting zero; skip if an active run already exists for `(repo, source, key)`; skip if a status write-back is still pending (`<KEY>: skipping claim — a status write-back to "<src>" is still pending`); evaluate `belt.match` (a throw is caught and the item skipped; no `match` accepts everything). Decrement both slot counters **before** the claim attempt so a burst of failures can't transiently overshoot the cap.
7. `claim` inserts the run row (`phase='claiming'`) with a fresh per-claim uid in the worktree name (`runs.worktree_name`, frozen — the run's identity; `runs.branch` starts equal to it and is TRACKED afterwards, since an agent may `set-branch` onto the repo's convention), then reconciles it under its own lock immediately. A unique-index violation is a friendly `already claimed by a concurrent pass — skipping duplicate claim`. With the source's `claim_guard` on, the claim ledger runs next, before anything else: it first releases any claim THIS host left open for a run that is gone from its DB, then another factory's open claim comment (or a lost race — lowest comment id wins) deletes the row and logs `claimed elsewhere by <host> (run <id>) — skipping`; see [work-sources.md](./work-sources.md#several-factories-on-one-source-claim_guard).

8. **Before the worktree is created** (in the `claiming` pass, not on the reopen path), the engine fetches the base ref in `repo.path` — `git fetch --no-tags <remote> <branch>`, only for a `<remote>/<branch>` `base_ref` — so the run is cut from the remote's tip rather than from whatever that clone last fetched. A failure never blocks the claim: the worktree is created from the local ref and the run logs `<KEY>: could not fetch <base_ref> in <path> — cutting the worktree from the local ref (<base_ref> is <age>); the base may be stale`.

Dedup is per `(repo, work_source, ticket_key)` and DB-enforced, which is what makes "first matching belt wins" hold across a pass. The same key in two different sources is two independent runs.

**Who holds a slot** — this is the part people get wrong:

| Run state | Slot? |
|---|---|
| `claiming`, `running`, `tearing_down` | yes |
| `attention` (parked, any reason) | **no** |
| `waiting_for_human` | **no** |
| `reviewing` with an idle resolver | **no** — a PR can sit in review forever without starving claims |
| `reviewing` with `resolverActive = true` | yes |

Defaults: `limits.max_active_workspaces` **3**, per-source **2**, `max_claims_per_tick` **10**, `reconcile_concurrency` **8**, `tick_interval_seconds` **60**. Full list in [config-reference.md](./config-reference.md).

---

## 6. The PR / `reviewing` watch

**Adoption happens in the `pr` step, not in `reviewing`.** Once a number is recorded the engine fetches by number; before that, by branch (first sighting only). Handing off to `reviewing` fires the `produce: pull_request` effect (engine default `in_review`) and sets `{phase:"reviewing", step:null, prNumber, resolverActive:false}`. It fires on **PR adoption**, not on `step-done`: a *draft* PR keeps the `step-done` gate, a merged PR always hands off, and only the belt's **terminal** PR-opening step qualifies.

Each tick, for every watched PR, one **batched aliased GraphQL query** (chunked at 25 PRs per query) returns `{unresolved, failing, pending, sig}` where `sig = sha1(JSON.stringify({t: unresolvedThreadIds, c: failingContexts}))` — `pending` (checks that have not concluded: a CheckRun with a null conclusion, a PENDING/EXPECTED StatusContext) is **not** in the hash, so a check merely finishing never counts as a new review round. The batched and per-run paths compute the hash **bit-identically**, which is what keeps `lastThreadSig` continuity working when the two mix.

Then, in order:

1. `MERGED` ⇒ `teardown("merged")`. `CLOSED` ⇒ park `pr_closed`. There is **no time limit** on the watch — no `watch_hours` knob exists.
2. **Ready-to-merge notification** (`noteGreenPr`): `green = prStepDone && state OPEN && !isDraft && unresolved === 0 && failing === 0 && pending === 0`. `prStepDone` is the gate added for issue #78: `enterReviewing` moves the run to `reviewing` as soon as a review-ready PR is adopted — *before* the pr step's `step-done` — so the agent may still be polling CI and may still push. While that step's `run_steps` row exists and is not `done`, the PR is not green (the mark is cleared), so the first tick after `step-done pr` is the one that notifies. A run adopted into `reviewing` that never spawned the step has no row and is not gated. Since `run.step` is `null` in `reviewing`, `step-done` for the belt's PR-opening step is accepted there as the one exception to the "must name the run's active step" check. On the first pass that sees a green PR, `deps.herdr.notify("herdr-factory: <KEY> ready to merge", "<KEY> is ready to merge — PR #n \"title\" in <owner/repo> is green with no unresolved threads · <url>")` and record a `pr_green` event. **The factory never merges** — this is a notification only, and no code path anywhere calls `gh pr merge`. Episode state is one `watch_state` row (run, `pull_request`, `pr_green`) whose `sig` is **the head commit the operator was told about** (`PrInfo.headOid`, from `headRefOid` on both PR lookups). It is cleared when the PR stops being green, and a *different* head is a new episode — so a push is a new green even on a repo with **no CI**, where the rollup never moves and keying on green-ness alone would say nothing. Result: once per green head, never once per tick; red → green → red → green is two notifications, not four. No duration is reported (the watch fires on the first tick that sees green, so any "green for …" would be zero). Accepted edge: a pushed commit whose check runs do not exist yet reads as green for a few seconds, so a tick in that window pings early and self-corrects on the next one.
3. `actionable = unresolved > 0 || failing > 0`; `fresh = actionable && sig !== run.lastThreadSig`.
4. **`if (!fresh && !resolverActive) return;`** — pure idle watching does zero herdr calls and holds no slot.
5. Read the pane state (herdr unreachable ⇒ return, retry next tick).
6. Believed-active resolver whose pane isn't `working` ⇒ `resolverActive = false`, log `resolver idle — PR #n watch no longer holds a slot`.
7. `fresh` + pane `working` ⇒ don't pile on; just keep `resolverActive = true`.
8. `fresh` + idle/gone ⇒ wake a resolver by rendering `prompts/resolver.md` into `.memory/herdr-factory/prompt-resolver.md` and re-prompting or spawning. **Only if the wake succeeds** is `{lastThreadSig, resolverActive:true}` recorded — a failed spawn must not mark the round handled.

A merge is also caught while the run is parked in `attention` or `waiting_for_human`; both poll the adopted PR and tear down on `MERGED`. A merge seen at the terminal `pr` step goes `running → reviewing → (next pass) teardown`, so a merge costs one extra tick.

**Teardown order** (idempotent, re-run after a crash):

1. `{phase:"tearing_down", outcome}`.
1b. **Hand over if this process is inside the worktree.** A terminal signal (`step-done` on a belt's last step, an ending `bounce`, an operator's `teardown`) is applied in-process by the CLI the agent runs, whose cwd is the run's own worktree — and step 3 HUPs every pane in that workspace, killing that process mid-call. Its run lock then sits stale for the full 300s TTL (`busy (nudge in flight)` on every tick) and `ended_at` is never set. So when `process.cwd()` is inside `run.worktree_path`, teardown stops here: the phase is stamped and the next tick — which runs outside every worktree and re-enters `tearing_down` from the top — finishes it, one tick later. A PR belt never hits this (its teardown lands on the merge watch, which only a tick runs). The hand-over assumes *someone* is outside; if you see this deferral logged **repeatedly at warn** for one run, the engine itself was started inside that worktree, nothing will ever finish the run, and it must be restarted from outside.
2. Terminal write-back **before** cleanup: fire the `teardown` effect for the outcome. Never blocks cleanup.
3. Remove the worktree — reading `<absolute git dir>/hf-port` **first** (the dev-server port the run reserved; see [target-repo.md](./target-repo.md)): `herdr worktree remove` → `workspace close` if it survives → `rm -rf` the worktree path (guarded so it can never be the repo itself) → `git worktree prune` → `git branch -D` for **every** name the run used (`worktree_name`, the current `branch`, and the HEAD branch read just before the checkout was destroyed), skipping protected ones (`base_ref` / the main checkout's branch). Once the workspace is closed (and before the `rm -rf`) it kills whatever still LISTENs on `hf-port` — `lsof -nP -ti tcp:<port> -sTCP:LISTEN` → the listener's **process group** gets `SIGTERM`, grace, then `SIGKILL`. A dev server started in a layout pane is reparented when the workspace closes, so this is the only thing that reaps it. **Never a pattern kill** (`pkill -f`/`killall` would take out sibling runs' servers), and never fatal: a missing/unreadable `hf-port`, or a port nothing is listening on, is one log line and teardown carries on.
4. Warn about any evidence uploads dropped without reaching their destination.
5. Abandon every intent kind **without** `survivesTeardown` — i.e. everything except `source_transition`.
6. `endRun(outcome)` ⇒ `phase='done'`, `ended_at` set; `torn_down` event.

---

## 7. ask-human

The step scaffold tells the agent to write its question to `.memory/herdr-factory/human-question-<step>.md` and run the rendered ask-human command, then stop.

Engine side: validate the step and source, **enqueue the durable `agent_signal` intent first** (born `waiting` with its handoff stamped in the same transaction, latest-wins supersession — so there is no window between "recorded" and "owed"), then take the bounded run-lock wait to apply it. The phase flips to `waiting_for_human` **before** the question is posted, so a failed post leaves the run parked and un-posted, and the post is retried every pass. A different pending question **supersedes** the old one, which is closed with `(superseded by a newer question from the agent — no human reply was received)`. There is at most one pending question per run (DB-enforced).

Poll loop, in order: (1) a merged adopted PR outranks the park; (2) **the parked step's own `done` flag outranks the park** — a `step-done` from the step that asked means the agent got past the blocker itself, so the question is closed as moot (`human_question_moot` + a "no answer needed" note on the item), the run un-parks (`resumed`, reason `step_done_after_human_park`) and `reconcileStep` advances the belt; a `bounce` from the parked step lands the same way (`bounce_after_human_park`). Without this a finished step waited forever on a reply nobody would send; (3) no pending question ⇒ self-heal to `running` or park `human_wait_missing_question`; (4) no external id ⇒ re-post; (5) cadence gate; (6) poll. Misses reschedule on the flat 30 s cadence. An auth failure counts as a *miss*, never toward escalation; 10 consecutive poll **throws** park `human_poll_failing`.

On a reply: the question is closed, the reply is written to `.memory/herdr-factory/human-replies/question-<id>.md` (headed with the question, step, author, and reply), a `human_reply` event is recorded, and seam D resumes **the same step, on the same pass** — clearing the step's `done` so a flag that landed concurrently with this pass (`markStepDone` runs outside the run lock) can't advance the step out from under the "continue, then step-done" instruction the resume just gave. A run parked *out of* the human loop with its question still pending returns to `waiting_for_human` on resume, not `running` — resuming to `running` would orphan the reply.

---

## 8. Bounces and attention as flow control

A **bounce** is the only backward edge and it is declared, not discovered: the target must be in the belt, strictly earlier, and be the belt's nearest **earlier** step that consumes `bounce_feedback` — each step's single bounce target is derived at config load (`StepConfig.canBounceTo`, from `resolveBounceTargets`); there is no `can_bounce_to` config key, and the belt-step schema is strict so writing one fails to load. A step may only bounce at all if its descriptor declares it (or a `custom` ref sets `bounce: true`), and a bounce with no upstream `bounce_feedback` consumer is rejected at load: `belt "<name>" step "<step>" declares a bounce but no earlier step consumes bounce_feedback`. Rejections are explicit — `"<toStep> is not before <fromStep> — bounces only go backward"`, `"the <fromStep> step may not bounce to <toStep>"`. The bounce counter is keyed on the **target** step and capped by `belt.max_bounces ?? limits.max_bounces` (6; `0` disables bouncing). See [belts-and-steps.md](./belts-and-steps.md).

`attention` is a park, not a failure: phase flips, the reason and its machine-readable code are recorded, the pane is renamed `⚠ ATTENTION <KEY>`, herdr notifies, and the reason (with the exact resume command) is **routed by what broke**: a *mechanical* failure — any factory watchdog or plumbing code (budgets, stalls, layout waits, capture caps, poll failures, config drift, plugin guards) — is reported into the run's own agent pane as a framed `[herdr-factory report …]` message; only an error about the *designated work itself* (`bounce_limit`, `pr_closed`) is posted on the work item — and on a file-channel source (`local_markdown`) even those go to the pane, since its notes are hidden files nobody watches. While parked, the run re-notifies every `attention_renotify_seconds` and **holds no slot**.

**`rework` is the operator's bounce** and the one backward edge a *person* owns: `rework <KEY> <toStep> --note "…"` runs the same `bounceStep` in operator mode — same rewind, feedback note, rework banner, pass bump, re-dispatch and `max_bounces` cap — but from any live phase (including a park an agent bounce may not rescue), free of the issuing step's `canBounceTo`, and allowed to target the step that is currently running. It records a `rework` event (`{by: "operator", fromStep, toStep, pass, bounces}`) and is refused once the belt is over (`reviewing`/teardown). It exists because a herdr pane cannot be un-typed: prompting a step's pane after its `step_done` puts an agent to work outside the belt's knowledge, and what it leaves behind is what the tree guard (§10) catches.

The two states compose as flow control:

- **A watchdog park is a backstop, not a veto.** A genuine terminal signal from the parked step — `step-done` *or* a `bounce` — un-parks the run and advances or rewinds it. The timer only wins when the agent has genuinely gone quiet.
- **`layout_wait_timeout` is categorically different**: no agent ever existed, so a terminal signal cannot rescue it. It heals only by re-attempting the spawn, with a bounded credit budget.
- **Everything else is human-only.** `resume` is generous by design — it rebases clocks, refunds counters (including belt-wide bounce refunds after a `bounce_limit` park), and nudges an idle pane with "continue the step, or run step-done if it's already complete".

Effects are **forward-only**: a status write-back whose rank is strictly below the highest already enqueued for the run is skipped with `effect → X skipped (would move backward, rank a < b)`, so a retried early transition can never walk the source backward.

---

## 9. Durability — the intent ledger

One table (`intents`) is the outbox for everything that must survive a crash, a restart, or the run itself. Five kinds:

| kind | ordering | delivered by | survives teardown | notes |
|---|---|---|---|---|
| `source_transition` | **fifo** per run | reconciler | **yes** | status write-backs. In-order delivery is checked **against the DB**, so an earlier sibling that is merely waiting (or suspended) still blocks. |
| `agent_signal` | latest-wins | (born `waiting`) | no | durable `bounce` / `ask-human`. Superseding marks the scope's other live rows `superseded`. |
| `evidence_publish` | latest-wins | kernel | no | S3/local upload of captures. Leased 300 s so the CLI's inline upload and the server's flush can't double-claim. |
| `human_reply_poll` | independent | engine-scheduled | no | one `waiting` row per pending question; carries the poll clock. |
| `external_wait` | independent | (born `waiting`) | no | the only externally-enqueuable kind; resolves by API fulfil or its deadline. |

The retry clock is shared and **flat**: every failed attempt reschedules 30 s out (`RETRY_INTERVAL_SECONDS`), and at **10 failed attempts (`MAX_RETRY_ATTEMPTS`) the row SUSPENDS**: `suspended_at` is stamped, the row stops being due (still `pending` — it keeps the claim veto and its FIFO slot), an `intent_suspended` event is recorded, and the operator is notified unthrottled. The repo's dashboard row shows the suspension in red (`/status.problems`). A source auth failure is a *pause*, not a loss: rows are held, and the first successful call to that source requeues every held row as due-now — clearing suspensions with a fresh attempt window.

**The problem ledger** (v37, `problems` table) is the generic record behind the dashboard's red repo light: one open row per (repo, cause key — `source:<name>`, `publisher:<type>`), REPORTED by the machinery that observes a mechanical failure (the auth gate; any `auth`-classified delivery failure via its `cause_scope`; the evidence creds probe, which now also runs proactively every ~5 min so an expired SSO session is recorded before any upload fails) and CLEARED by the same machinery on recovery (a successful source call, a delivery, a healthy probe — recovery clears unconditionally, so a row persisted across a restart cannot go stale). `/status.problems` = this ledger + derived entries for parked runs and suspended intents. The dashboard only reads; nothing is re-checked on load.

**Getting out of a suspension you have already fixed.** Only causes the engine can *probe* clear themselves: a source auth pause (above) and S3 credentials (the `evidence_publish` pre-pass, `auth`-classified rows only). Anything classified `transient` — a timeout, an unknown SDK error, a source that was briefly 500ing — sits suspended after its 10 attempts. `retry-now` (`POST /repos/{repo}/retry-now`, CLI `retry-now [KEY]`, `s` on the TUI board) is the operator's due-now: every suspended `pending` row in the repo, or one run's, is cleared (attempts reset to 0 — a fresh window; a still-broken cause re-suspends after ~5 minutes), every merely mid-interval row becomes due (attempts kept — they count toward the same cap), and Phase 0 is then flushed **under the repo tick lock**, so the rows land on that call. Rows already due are not counted (`requeued: 0` ⇒ the delay is not the retry clock; `unsuspended` counts the cleared suspensions), `waiting` rows are untouched, and no run is mutated — which is why it, and not `resume`, is the fix for a healthy run whose only stuck thing is a background upload. A re-enqueue of the same intent also clears its suspension (a fresh obligation gets a fresh window).

Why claiming is vetoed while a write-back is pending: the source's own "is this item eligible" answer is **known stale** until the transition lands. Without the veto, a run that merged and moved the ticket to Done — but whose write-back is still retrying — would be re-claimed and the work re-done. This is also why terminal write-backs are the one kind that outlives the run: the retry loop keeps going after `ended_at` is set, and the veto depends on that row still existing.

Delivery and run mutation never mix. A delivery that needs the run to react stamps a **handoff marker** (`stale`, `deadline`, `fulfilled`, `signal`), which the run-locked pass consumes exactly once.

---

## 10. Guards and watchdogs

A step's guards are declarations on its descriptor; the watch harness walks them in declaration order and the **first trip wins**. Verdicts are `ok | defer | trip`; outcomes are `none | defer | extend | park`.

| Guard | Stage | Measures | Trips when | Escalation code | Rescue class |
|---|---|---|---|---|---|
| `heartbeat` | watchdog | HEAD sha of the worktree (only on steps producing `commits`) | no new commit for `> limits.stall_seconds` (2700) | `step_stalled` | terminal-signal |
| `budget` | watchdog | wall clock since the step's last (re-)entry | `now - budget.based_at > step.budget_seconds` | `step_budget` | terminal-signal |
| `read_only` | **pre_advance** | HEAD vs a baseline | HEAD moved **after** the baseline froze | `read_only_violation` | terminal-signal |
| `layout_wait` | spawn phase | how long the configured pane has been missing | window spent and respawn credits (3) exhausted | `layout_wait_timeout` | respawn (bounded) |
| `capture_cap` | signal-driven | evidence capture attempts | attempts > `limits.max_capture_attempts` (5) | `capture_limit` | terminal-signal |
| `exclusive_resource` | n/a | the machine-global `capture` lock | never parks | (`capture_lock`, unused) | none |
| `bounce_cap` | n/a (not a GuardSpec) | bounces **into** a target step | over `max_bounces` | `bounce_limit` | human only |
| tree guard | n/a (not a GuardSpec — checked at `step-done` and at dispatch) | the worktree of a step whose posture is `read_only` | `git status --porcelain` is non-empty (HEAD is the `read_only` watch's business, not this one) | `dirty_tree` (at dispatch; a `step-done` is refused instead of parking) | human only |

`heartbeat` is declared **before** `budget` on the descriptors so a stall diagnosis wins when both windows have expired.

**The idle nudge sits in front of all of them** and is not a guard — it never parks. When a running step's watches evaluate to `none` and its pane has been continuously `isReadyForInput` (`idle`/`done`) for `limits.idle_nudge_seconds` (default **300**, `0` disables), the engine sends it the same message `resume` sends — "continue the step; if it is already complete, write your handoff note and run the step-done command now" — pointed at `.memory/herdr-factory/prompt-<step>.md`, whose baked `--pass` stamp is still valid (a nudge never bumps the pass). Once per idle **episode**, marked in a `watch_state` row (`run`, step, `idle_nudge`): `based_at` = first seen idle, `sig` = the HEAD when the nudge went out. The episode ends — and the row clears — when the pane goes `working` again, when HEAD moves, or on a `resume`. A `working` pane is never nudged; a gone pane belongs to the respawn path. It rides the memoized pane state **and does not wait for confirmation** (`agent prompt` with no `--wait`), so it costs no extra herdr call per tick and never pins the run lock the `step-done` it is eliciting needs — `nudged` in its event means "herdr accepted the submission". Only `resume` waits for the agent to actually wake. Each nudge records an `idle_nudge` event (`detail`: `step`, `pane`, `nudged`, `idleSeconds`), and `explain` reports it in the `step_budget` / `step_stalled` narratives.

The **tree guard** (`core/tree-guard.ts`) is not a watch: it is checked synchronously at the two seams where a read-only step's verdict is about to be trusted. `applySignal`'s `step-done` is **refused** (exit 1, with the diff stat, recording `step_done_refused`) when the worktree is DIRTY; `parkIfTreeDirty` parks the run `dirty_tree` before the forward advance into such a step, its spawn, or a `rework` re-dispatch. It says nothing about HEAD on purpose: a commit is the watch's park, which a step-done RESCUES, and refusing that step-done as well would wedge the run (an agent cannot un-commit). The refusal is stamped into the `read_only` watch row's `meta`, which `runObligations`/`explain` surface so an operator can see why a running step never finishes.

`read_only` deserves its own note (RWR-18204): the baseline **tracks** live HEAD while `based_at` is null — absorbing the previous step's trailing handoff-window commits — and **freezes** the first pass on which this step's own pane reads `working`. Only a HEAD move after the freeze trips. So a prior step's late commit does not park a read-only review step.

Two engine-universal watches are not GuardSpecs:

- **`pane_liveness`** — tri-state, described in §4 step 6. Rescue is a respawn; a failed respawn hands the retry to the bounded layout wait.
- **`pass_staleness`** — terminal signals carry `--pass N`; a stale-pass signal is rejected loudly rather than silently applied to the wrong attempt.

### The two rules

1. **A live agent is never parked by a timer.** A guard declaring `vetoWhenWorking` resolves the step's own pane state on a trip; `working` converts the park into an `extend` (`<step> past <window> but still working — extending`). The documented trade is that a working-but-wedged agent escapes the stall timer.
2. **Liveness never acts on uncertainty.** A `HerdrUnreachableError` in the observe lane — the watchdog veto, the dead-pane check, the resolver state read — **defers the whole pass**. The one exception is the read-only baseline's **freeze** check: unreachable herdr there defers only the freeze (the pane is read as not-working and the baseline keeps tracking HEAD), never the pass. A respawn needs a fresh, unmemoized, confirmed absence **twice, ≥ 45 s apart**.

The full park-reason table with remediation is in [troubleshooting.md](./troubleshooting.md); `GET /repos/:repo/obligations?key=<KEY>` reports every armed guard with its live facts and its `rescue` class (`terminal-signal | respawn | human | none`), and `herdr-factory --repo <r> explain <KEY>` renders the same view as a plain-language narrative with next commands.

---

## 11. Rate limits and timeouts

Every rate limit is the same token bucket (time-based refill, starts full, sleeps until a token is available):

| Bucket | Rate / burst | Scope |
|---|---|---|
| Jira (all calls) | 5/s, burst 10 | per configured jira source, per process |
| Sentry (all calls) | 3/s, burst 6 | per configured sentry source, per process |
| GitHub REST reads | 5/s, burst 10 | process-wide |
| GitHub REST mutations | two chained buckets, both acquired per attempt: 1/s burst 2 (≈60/min vs GitHub's 80/min secondary cap) and `(500−10)/3600`/s burst 10 (≤500/hr in every window) | process-wide |

GitHub's 5,000 req/hr primary limit is deliberately **not** enforced by a bucket: it is counted per **account**, and the `gh` CLI, the operator's own tooling and every other host on the same login spend it outside these buckets. It is handled reactively by the **rate-limit gate** instead — a 403/429 that outlasts the retries carrying `x-ratelimit-remaining: 0` or a `Retry-After` holds the whole source until the reset the response named, skipping its polls (and recording `source:<name>:rate-limit` on the problem ledger, so `status`, `explain` and the dashboard show it) until the hold expires or a call succeeds. Each tick logs its spend — `github: <n> call(s) this tick (<r> REST, <c> gh CLI)` — so an operator can see which host is eating the shared budget. Give each host its own `GITHUB_TOKEN` rather than a shared `gh` login.

HTTP retry policy: retryable = transport error, timeout, 429, 5xx (all other 4xx fail fast; GitHub's `403 + Retry-After` secondary limit is opted in per client). Default 3 extra attempts, `exponential(500 ms, ×2)` jittered. **`Retry-After` is honored before the schedule delay**, capped at 60 s (lower per caller), and is synthesized from `x-ratelimit-remaining: 0` + `x-ratelimit-reset` when the header is absent. Write calls use `retries: 1` — a 429 was definitively not processed, but a lost 5xx write may have landed, and a rare duplicate comment beats a retry storm.

Hard timeouts, which are what stop a hung dependency from wedging a tick:

| Call | Timeout |
|---|---|
| subprocess (`herdr`, `gh`, `git`) | 60 s, via `execFile`'s native `timeout` with `SIGTERM` — thrown **even under `allowFail`** |
| `command` evidence publisher | `evidence.timeout_seconds` (default **300 s**) — on expiry: `publish command timed out after Ns`. `s3`/`local` spawn no subprocess at all |
| herdr worktree / tab / pane operations | 180 s |
| HTTP default | 30 s (Jira media 120 s) |
| CLI → server request | 600 s (claim/tick do real work) |

Non-HTTP throttles: the per-source new-work poll gate (only engages when the interval exceeds the tick), `max_claims_per_tick`, a 5 s memo on `herdr agent list` (bypassable with a fresh read), and the batched PR query.

**The wedged-tick watchdog.** `repos.last_tick_at` is stamped at the end of every completed pass. `/health` reports `tickStale` per repo when `now - max(lastTickAt, serverStartedAt) > max(10 × tick_interval_seconds, 900)` s — so at least 15 minutes, and never on a fresh boot. `ensure-up` restarts a stale-but-answering server exactly as it would a dead one; the restart is also what stops the wedged holder's lock heartbeat, so its locks expire.

Locks are heartbeat-extended every `max(5 s, TTL/3)` while the holder lives, which means **TTL expiry is proof the holder process is dead**, never that it was slow. A holder whose extend fails stops beating and logs `lock <key> lost mid-hold (owner <owner>) — a concurrent holder may be reconciling the same target` at error level — grep that string when diagnosing duplicate agents.

---

## 12. The server and the supervisor

`serve` is one resident process for the whole machine, binding **`127.0.0.1:8765`** (`HERDR_FACTORY_PORT` overrides). Single-instance is enforced twice: a soft check (`server.json` exists and `/health` answers ⇒ `another server already healthy on :<port> — exiting`) and the authoritative one, the TCP bind — a failure logs `failed to bind 127.0.0.1:<port> — <msg>` and exits 1.

Hot reload (`POST /reload`) diffs each repo's belts. A removed belt with in-flight work **refuses that repo's reload** (the old config keeps running) rather than orphan runs. A cold start has nothing to diff and is always lenient.

Graceful shutdown clears the tick timers, closes the HTTP server, waits up to **15 s** for in-flight ticks, removes `server.json`, flushes telemetry, and exits 0.

`ensure-up` is a stateless one-shot the platform timer runs every 60 s:

1. If auto-update is enabled, run the self-update first. A successful update forces a restart (this process read its own `VERSION` at start).
2. Sweep the configured repos' **main checkouts** (`src/watchers/checkouts.ts`, throttled to 10 min per repo): `git fetch <remote>` + `git merge --ff-only <base_ref>`, only when the checkout is on the branch `base_ref` names, has no staged/unstaged change and fast-forwards cleanly; otherwise a logged skip. Best-effort — one repo never affects another or the restart decision below.
3. Read `server.json`, then `/health`. **No-op only when** health is ok **and** `info.version === VERSION` **and** no repo is `tickStale` ⇒ `server healthy on :<port> (v<version>)`.
4. Otherwise restart, with the reason chosen in this order: `server not responding — restarting` · `server v<a> != v<b> — restarting` · `tick loop stale for <repos> — restarting wedged server`.
5. Stop = `POST /shutdown` → SIGTERM regardless → poll for exit every 200 ms up to **18 s** (deliberately outlasting the server's 15 s drain) → SIGKILL → remove `server.json`. Then spawn a detached `serve`.

The self-update resets the package checkout to the channel target (`main` = the tracked upstream; `stable` = the newest numeric `vX.Y.Z` tag). Guards: a **dirty checkout is never reset** — it records `dirtySkip` and notifies the operator once per 6 h. Post-steps are best-effort and recorded as warnings: re-provision Node if `.node-version` changed (download with a mandatory SHA-256 gate and an atomic symlink flip), then install dependencies if the lockfile or Node changed. The restart itself *is* the drain: the graceful-first stop sequence above.

`VERSION` is the package version plus the git HEAD sha, so **any new commit trips the outdated check** on the next supervisor pass.

The scheduled service is launchd (`com.herdr-factory.server`, `StartInterval 60`) on macOS and a systemd `--user` timer (`herdr-factory.timer`, `OnUnitActiveSec=60`) on Linux; anything else throws. Note that only a narrow env allowlist is baked into the plist/unit — `HERDR_FACTORY_CONFIG_DIR`, `HERDR_FACTORY_STATE_ROOT`, and `HERDR_FACTORY_PORT` are forwarded supervisor→serve but **not** baked in, so a non-default config dir or port needs another mechanism.

### The fleet (`src/fleet/`)

Everything above is one machine: one `serve`, one DB, one `server.json`. The fleet layer reads
**several** machines without changing any of that. Two surfaces consume it: `herdr-factory fleet`
(the table) and the **TUI Dashboard** (`src/tui/fleet-view.ts` — per-machine boards, and every key
routed to the machine that owns the run).

- **Who is in it**: this machine plus every *enabled* entry of `herdr machine list --json`. No config key. `herdr machine disable` removes a box; a herdr that cannot be asked leaves the local machine alone (so a single-machine install behaves exactly as before).
- **How a remote one is reached**: an SSH local forward (`ssh -N -L <free port>:127.0.0.1:8765 <target>`, ControlMaster reused), so every server keeps binding `127.0.0.1` only. `HERDR_FACTORY_FLEET_ENDPOINTS` names a machine's base URL directly instead. The ControlPath is length-checked against a Unix socket's 104 bytes: `<state>/fleet-ssh/%C` when it fits, else `/tmp/hf-<uid>/%C` (0700), else `ControlMaster=no` — overflowing it kills the forward outright rather than just its reuse. Because `ControlPersist` keeps that connection alive between calls, the client we spawn exits **0** as soon as a backgrounded master owns the tunnel: the forward's own `/health` decides reachability, only a non-zero exit (or the timeout) is `unverifiable`, and tear-down is `ssh -O cancel` over the same ControlPath (the forward, not the shared master). A master that outlived its connection still answers `-O check` with `Master running`, so **stale** is diagnosed as the pair (master running, forward failed) and answered with `-O exit` plus **one** retry on a fresh connection. Concurrent reads of one machine share a **single in-flight open** (one ssh, one port, no ControlPath race), a forward is never replaced or dropped without being torn down (no orphaned `ssh -N`), and a **held forward is re-probed with `/health`** before it is handed out — so a master that outlived the remote server's restart is retired and re-opened, and the machine recovers without restarting the TUI. The probe is addressed to loopback but crosses the forward, so it shares the 2500ms wide-area floor (`REMOTE_MIN_READ_TIMEOUT_MS`, now owned by `transport.ts` and imported by `client.ts` — one place decides how long a read over a forward may take).
- **One interface**: `MachineClient` — every call a UI needs (status, eligible, timeline, obligations, health, claim, teardown, resume, retry-now, tick, reload). The TUI reads and acts through it for *every* machine, this one included, rather than keeping a client of its own. Reads answer `null` for an unreachable machine; actions answer `{ok:false,error}`. Unreachability never throws.
- **Two invariants**: machines are read in **parallel under a per-machine timeout** (`readMachines`, shared by both surfaces so the verdict cannot drift — 5000ms for the local machine, 15000ms for a remote one, which must build its forward before it can read anything), so one slow box costs its own row and not the view; and a machine that does not answer is **`unverifiable` with its last successful read time** (`<state>/fleet-last-seen.json`) and a named cause — the transport's (ssh's first line of stderr, its exit code, the `/health` attempts that ran) or, when the forward came up and the API is what did not answer, the client's (the call and the budget it missed; reads over a forward are floored at 2500ms, not the local 500ms) — never "no runs" — the difference decides whether an operator wrongly claims an item another machine is already working. In the TUI it also **keeps its last known rows**, marked as such and refusing actions. Actions route to the owning machine only, and an ambiguous key is refused rather than guessed.

---

## 13. Files on disk

Four roots:

| Root | Default | Contents |
|---|---|---|
| config dir | `~/.config/herdr-factory` (`HERDR_FACTORY_CONFIG_DIR`) | `repos/<name>/config.yml`, per-repo `prompts/`, `config.schema.json` |
| state root | `~/.local/state/herdr-factory` (`HERDR_FACTORY_STATE_ROOT`) | everything below |
| target repo | wherever the user's checkout is | the main checkout; never a run's workspace. See [target-repo.md](./target-repo.md) |
| per-run worktree | created by herdr from the repo | the branch checkout the agents work in |

Inside the state root:

| Path | What |
|---|---|
| `herdr-factory.db` | **the single global SQLite DB** — every repo's runs, events, intents, locks, watch state |
| `<repoName>/logs/<YYYY-MM-DD>.log` | all per-repo engine work: passes, claims, spawns, parks, intent deferrals, teardowns |
| `layout-hook/` | the layout hook's own state: `applied/<sha1>` claims (one per worktree), `decided/<workspaceId>` (focus-event cache, cleared at herdr startup), `setup/<token>.status` (a build's setup exit code, reaped after a day) |
| `logs/supervisor.out.log`, `logs/supervisor.err.log` | `ensure-up` decisions and the launchd-started server's stdout (macOS; Linux goes to journald) |
| `server.json` | `{pid, port, version, startedAt}` — the advertised server; a malformed file reads as "no server" |
| `update-status.json` | the last self-update attempt: channel, outcome, head/target, `behind`, `dirtySkip`, `warning` |
| `fleet-last-seen.json` | when each fleet machine last answered a read — what an `unverifiable` machine's row reports instead of "no runs" |
| `evidence/` | captures served by the `local` evidence publisher |
| `runtime/<version>`, `runtime/current` | the vendored Node, with `current` as the atomically-flipped symlink |

Per run, in the worktree at **`.memory/herdr-factory/`** (factory-owned; add `.memory/` to the target repo's `.gitignore`):

| File | Written by | What |
|---|---|---|
| `prompt-<step>.md` | engine | the **exact** rendered prompt for this pass — read this to see what the agent was actually told |
| `prompt-resolver.md` | engine | the PR-resolver wake prompt |
| `task.md` / `ticket.json` / `issue.json` / `task/` | the work source's materialize | the work item itself, plus `attachments/` for images and video |
| `handoff-<step>.md` | each step's agent | what it did and why, read by the next step |
| `feedback-<step>.md` | engine, on a bounce | the rework brief; archived to `feedback-<step>-addressed-pass<N>.md` when the step advances |
| `bounce-<step>.md` | a bouncing agent | its findings, quoted into the bounce |
| `human-question-<step>.md` | an asking agent | the question the engine posts to the source |
| `human-replies/question-<id>.md` | engine | the human's answer |
| `evidence/` | the evidence step's agent | captures awaiting publish |

A **freshly created** worktree gets its `.memory/herdr-factory/` scrubbed (a committed copy could otherwise supplant the real work item, since materialize is skip-if-exists). A **re-opened** worktree is never scrubbed — that directory is the run's live state.

---

## 14. Crash-safety invariants worth knowing

- **Reconcile is idempotent.** Every pass re-derives what to do from the DB and the world. Killing the server mid-tick loses nothing but time; the next pass picks up where the state says it is.
- **At most one active run per `(repo, work_source, ticket_key)`**, enforced by a DB partial index rather than a check. The loser of an insert race is a warn-and-skip.
- **Terminal write-backs outlive the run.** The `source_transition` intent keeps retrying after `ended_at` is set, and Phase B's claim veto depends on that row still being there.
- **Stale handling is two-phase.** The lock-free flush only *stamps* staleness; the run-locked pass consumes it once and decides abort-vs-park from the **run's** progress, not from which intent went stale — so a late claim-time stale can never destroy a `reviewing` run's worktree.
- **A pass starts undispatched.** `dispatched_at = null` means the spawn branch owns the retry, so a crash between "row written" and "prompt sent" retries the send instead of starting a budget clock on an agent that never existed.
- **The agent-facing CLI surface is a cross-release compatibility contract.** Rendered prompts bake exact command lines into agents that outlive auto-update restarts, so those commands only ever change additively.
- **Migrations are expand/contract**, and in-flight runs must survive them. A draining old-code process may briefly write the new schema around a restart.

---

## 15. Telemetry

Off by default. Enable with `HERDR_FACTORY_TELEMETRY=1` (and `OTEL_SDK_DISABLED` unset); the OTLP endpoint defaults to `http://localhost:4318`, service name `herdr-factory`, metric export interval 10 000 ms.

What you get: spans for the whole causal chain (`cli.command`, `supervisor.ensure_up`, `updater.self_update`, `server.tick_repo`, `tick.lock`, `run.lock`, `reconcile.repo`, `reconcile.run`, `exec.run`, `http.*`, plus one span per client method); histograms for tick, CLI-command, dependency, HTTP, and rate-limit-wait durations; counters for domain events, attention events, tick lock skips, and source-auth transitions. Domain events are mirrored as span events, and telemetry writes **no** rows to the SQLite `events` table — the timeline is independent.

The local stack is `docker-compose.telemetry.yml` (`grafana/otel-lgtm`): `docker compose -f docker-compose.telemetry.yml up`, then Grafana on **`http://localhost:3001`** (`GRAFANA_PORT`, default 3001 — `docs/TELEMETRY.md` says 3000, which is wrong). Smoke-test with `herdr-factory telemetry-smoke`. For the supervised server, telemetry env must be present at `herdr-factory install` time, because it is baked into the plist/unit.
