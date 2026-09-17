# Our orchestrator on Orca vs herdr-factory

Written 2026-09-16 to decide whether this fork replaces the operator's current orchestrator. Sources:

- **Current:** the `orchestrator` repo (CLAUDE.md, `docs/agents/*`, 29 ADRs, hooks and libs) together with agent-kit's `run-matt` skill, all running on Orca.
- **Factory:** this fork at `c00b2c8`, read in full (`docs/ARCHITECTURE.md`, `src/core/reconcile.ts`, `src/clients/*`, `src/steps/*`). Nothing was run.
- **Herdr:** 0.9.0 installed, plus source at `18061191`.

Verdict key: **F** = factory already covers it · **P** = partly · **G** = gap we add · **X** = conflicts with one of our rules, patch it.

## The rules, as adopted
The Orca-era rules were reviewed topic by topic on 2026-09-16/17 and replaced with **herdr-factory's defaults** wherever they differ. What still holds:
1. **The human merges.** The factory never merges; `+yolo` is dropped.
2. **Done needs a signal, never an idle screen:** a `step-done` for the active step and pass, or the PR's state. Independent checks happen in the evidence and review steps.
3. **"Can't tell" never acts:** Herdr unreachable defers every check.
4. **One work item, one worktree, one branch, one PR**, per repo.

What changed from the Orca era (see *Decisions*):
- **Teardown after merge and on cancelled pre-PR work.** "Never reap" is replaced.
- **Re-spawn of confirmed-dead panes.**
- **Jira writes.**
- **Automatic polling.**
- **Code instead of coordinator agents.**

## Topic by topic

| # | Topic | Our orchestrator + Orca | herdr-factory | Verdict |
|---|---|---|---|---|
| 1 | **Intake** | Asked for, never polled. Two sources: MAMAS Jira assigned to the operator (read-only, categorically) and repo issues. Project resolved from the title, then the linked PR, otherwise ask. Writes nothing. | Polls every 60s over Jira (board JQL on todo status + label), GitHub issues (label swap), Sentry and local markdown. Belts are tried in priority order through `match.ts`. **Writes back**: Jira transitions, GitHub label swap. | **F**: Jira write-back uses herdr-factory's defaults (decided 2026-09-16, see *Decisions*) |
| 2 | **Claim / double-take** | One Run, Orca Task per unit; the cap hook counts the machine | Unique index per (repo, source, key) in the local SQLite. **Two factories sharing one tracker double-claim** (INV-10, `deps.ts:197`) | **G → #1**: claim ledger on the tracker (lowest claim comment wins). Static partitioning rejected (does not scale) |
| 3 | **Placement / caps** | Per-Host cap in `data/registry.md` (local 4, cursor 3, mac 2); a PreToolUse hook refuses a spawn over cap; `npm run place` ranks Hosts; mac is the last resort | **Per repo only**: `limits.max_active_workspaces` (default 3, "repo-global", `ARCHITECTURE.md:1477`), per-source cap (default 2), 10 claims per tick; counts working runs only (parked runs hold no slot; `reconcile.ts:486-498` filters by repo). **No machine-wide cap and no memory check**: 3 repos can run 6-9 agents on one box. "Machine-wide" in the docs means the one `serve` process. | **G → #2**: add a machine-wide cap + memory gate; with #1, pull-by-free-slots does placement, and a slower poll makes mac the last resort |
| 4 | **Multi-machine** | Orca environments (`--environment`), remote worktrees and terminals, a run home; per-server name resolution (ADR-0029) | **None.** One `serve` on 127.0.0.1 with one DB. | **G → #1–#4**: one factory per machine, each local to its own Herdr, with no remote calls. Shared tracker: #1. Machine capacity: #2. Config across machines: #3. Combined read-only view: #4. Herdr's machine view already shows every machine's agents. Remote dispatch through `--machine` was measured at ~27s per call, so it is rejected |
| 5 | **Worktree create** | `orca worktree create --base-branch origin/<head>`; review mode adopts the PR's head branch | `herdr worktree create/open` from `base_ref`; branch template plus uid; agents may rename the branch and the engine follows HEAD | **F** |
| 6 | **Worktree teardown** | Human-only `worktree rm` after the merge; fence, never reap | `teardown` on PR merged, on the last step of a no-PR belt, on an item deleted/closed **before any PR while claiming/running** (aborts to stop token spend), and on manual `x`/`teardown`: `worktree remove --force` → `workspace close` (ends its agents) → `rmrf` → `prune` → local `branch -D` (`reconcile.ts:2248-2340`). An item gone **mid-flight** (PR or review) parks instead (`:733`). Remote branch, PR and tracker item are never deleted | **F**: factory default kept (decision 2026-09-17) |
| 7 | **Spawn** | `worker-start --on` into an existing worktree; the Orca preamble has to be countered in the brief (ADR-0016) | `herdr agent start --kind` in a new tab (waits up to 120s for readiness), or a prompt into a labelled layout pane with a check that the agent started working | **F**, and simpler: there is no preamble to fight |
| 8 | **Brief** | `BRIEF.md` template: contract line (mode, project, host, issue, run, task, engine), Task, Environment, Rules, Report | `prompt-<step>.md` built from shipped prompts, overridable per repo or worktree, with tokens (`@@WORK_DOC@@`, `@@HANDOFF_IN@@`…), a scaffold covering handoff, ask-human, bounce and finish rules, and the repo's CLAUDE.md for how to work | **F**: our brief rules become `repos/<name>/prompts/` overrides and `guidelines-prompt.md` |
| 9 | **Levels** | Three: L1 coordinator session → L2 run coordinator agent per issue (ADR-0014) → L3 stage sessions | Deterministic reconciler (code, not an agent) → one agent per step in its own pane; a resolver agent for PR review rounds | **F**: factory default kept (2026-09-17). Coordination is code; judgment moves through handoffs, querying the prior pane, bounce and ask-human. No epic tracking and no arbitrary rework target, both accepted |
| 10 | **Pipeline / stages** | run-matt: grill → spec → tickets → implement → review → prove → report | Belt `steps[]` of `work / evidence / review / pr / custom`, with declared inputs and outputs validated at load; bounce back to the earliest step that takes feedback, `max_bounces` 6 | **F**: map grill, spec and tickets to `custom` steps, implement to `work`, prove to `evidence`, review to `review`, report to `pr` |
| 11 | **Per-stage agent** | The engine is named per run (`engine=claude/cursor/codex`) | An `agent:` block per step, belt or repo; any Herdr kind including cursor; wrapper scripts typed in with `pane run` | **F** |
| 12 | **Questions / ask** | `orchestration ask`/`reply`; the Stop hook refuses while asks are open (ADR-0028) | Agent writes `human-question-<step>.md` + `ask-human` → run parks `waiting_for_human` → question posted as a tracker comment → replies polled every 30s → same step resumes | **F**: tracker comments are the channel, Jira included |
| 13 | **Gate / merge** | One Orca decision gate per attempt; only the operator resolves it; merge is the one checkpoint (ADR-0013) | Never merges. `pr` step polls CI about 10 min; then watches the PR indefinitely; review threads or failing checks wake the resolver; MERGED → teardown | **F**: the open PR *is* the gate |
| 14 | **Evidence of done** | `worker_done` (the agent's claim; Orca rejects stale or unbound ones); pw-prove; you merge | `step-done` (the agent's claim; rejected unless it names the active step and current pass, `signals.ts:77-110`); an idle screen or a timer never completes a step; artifact existence **not** checked by the engine. Independent checks are the `evidence` (per-criterion, published URLs) and `review` steps, with read-only enforced by a HEAD freeze and bounce-to-work; you merge | **F**: the done signal is equivalent; the gates are stronger. Factory default kept |
| 15 | **Liveness** | `live / unverifiable / exited`; `worker-abandon` fences; never reap; no stall detection | Pane absence double-confirmed with fresh reads ≥45s apart before a **re-spawn**; `HerdrUnreachableError` defers every check; budget/stall timers **park** (vetoed while `working`); nothing is killed. No named `unverifiable`; `workspaceExists` treats any error as gone (`herdr.ts:174`), which only causes retries | **F**: factory default kept (2026-09-17) |
| 16 | **Board** | `npm run board` snapshot across Hosts (gates, live, stalls, next, landed) | Live TUI per machine: kanban (cards = runs, columns = steps), recorded problems with ⚠, a "What's happening" narrative, `s`/`c`/`x` actions, config editor, doctor. `hf_key`/`hf_step`/`hf_state` pane tokens appear in Herdr's **combined machine sidebar**. HTTP API + Swagger | **F** (factory default kept, 2026-09-17). Cross-machine agents come through Herdr sidebar rows `["$hf_key","$hf_step","$hf_state"]`; #4 only adds parked/eligible/problems |
| 17 | **Roster / registry** | `data/registry.md` (Run id, per-Project mode `no-mistakes/direct-PR/local-only` + `+yolo`/`parked`, Host caps) + `data/hosts.md` + the session-start Roster | `repos/<name>/{config.yml, env, guidelines-prompt.md, prompts/}`, zod + JSON schema, `init` / TUI `+ new repo`, `doctor` | **F** (factory default kept, 2026-09-17). Modes become belts: no-mistakes = plan+ship, direct-PR = work→pr, parked = `active: false`. local-only becomes a draft PR (a no-PR belt deletes the local branch at teardown). `+yolo` dropped (the factory never merges). Review mode is t21; Host caps are #2; host traps go in CLAUDE.md or guidelines |
| 18 | **State / restart** | Orca holds all live state (remote run home, per-terminal binding, fencing); the coordinator is stateless | One local SQLite per machine (WAL, migrations): runs (every attempt), run_steps (pass, absent_at), watch_state, events, questions, intent ledger/outbox, problems, heartbeat locks. 60s tick re-derives truth, plus a step-done nudge; bounce/ask-human signals are durable; launchd/systemd `ensure-up` every 60s; a hard kill is safe | **F** (factory default kept, 2026-09-17) |
| 19 | **Memory / decisions** | Pinned tier: 29 ADRs (ADR wins), `docs/agents/*`, registry, hosts.md, issues; placement rule in CLAUDE.md | Per run `.memory/herdr-factory/` (prompts, handoffs, work doc, feedback, replies, evidence; deleted at teardown); per machine the SQLite runs/events/questions + daily logs; permanent record in PR, ticket and git. Design rationale in ARCHITECTURE invariants, PROMPTS.md, design docs, comments; `skills/herdr-factory` for operating it | **F** (factory default kept, 2026-09-17). Our choices live in this doc's *Decisions* (moves to the #3 config repo); handoff notes lost after merge accepted |
| 20 | **Hooks / guards** | Claude hooks: roster (SessionStart), cap (PreToolUse, parses spawn commands), mail (Stop; looped on Cursor #518) | Engine guards per step: budget, heartbeat, read_only, pane_liveness, pass_staleness, layout_wait, capture_cap, exclusive_resource, bounce cap (all defer when Herdr is unreachable; shown by `explain`/`obligations`). Extension points: `match`, `custom` steps, prompt layers, `effects`, `pr:` policy, evidence publisher, `external_wait` intents, step/source registries, OTel. Herdr plugin `layout-hook`; agent integration hooks per machine (not checked by `doctor`) | **F** (factory default kept, 2026-09-17). Setup: `herdr integration install <agent>` on every machine |
| 21 | **Review of PRs handed in** | `review` mode: named by you or Alfred's comment; one run per PR with siblings' merge order; cut at `origin/<head>`, adopt the head branch; pr-review → pw-prove → report | No review mode (its "PR adoption" is the run's own PR; `listEligible` skips PRs; `set-branch` refuses existing names) | **F with config** (2026-09-17): a `review` belt per repo, triggered by label `hf-review` on the ticket, all `custom` steps: checkout (`gh pr checkout`, HEAD tracked) → review (pr-review, commits allowed) → prove (pw-prove) → report. The per-repo active-run index gives one run per repo's PR |
| 22 | **Delivery modes** | Registry mode per Project (`no-mistakes`/`direct-PR`/`local-only`, per-task `review`) + `+yolo`, `parked` | No modes; the belt chosen by label decides; belt `pr:` policy (draft/title/labels/reviewers/assignees/automated round) | **F** (2026-09-17): no-mistakes = `hf-plan`/`hf-ship`, direct-PR = `hf-quick` (work→pr), local-only = `hf-draft` (draft PR), review = `hf-review`, parked = `active: false`, yolo dropped; unlabelled = never claimed |
| 23 | **Safety surface** | Nothing deletes; gate manual; Jira read-only | See *Every destructive path* | **F**: every path kept at factory defaults (2026-09-17), including self-update tracking upstream and the review-belt branch edge |
| 24 | **Maturity / cost** | Two weeks on Orca: token-heavy coordination (agents at L1/L2, large docs, hooks on every call) and buggy (#518 loop, 24 stray gates, 654 acked messages, cap and naming bugs) | ~Zero coordination tokens (code); tokens only inside steps. One author (237/237 commits), activity 187 commits in Jul → 2 in Sep, last push 2026-09-06; "under construction"; no releases, no CI workflows, **no license**; ~28k lines of TS; 42 unit test files (~950 cases) + 31 e2e scenarios against real headless Herdr; vendored Node ≥26.3 | **P** (factory default accepted, 2026-09-17): the fork is ours to own; prove on one real issue before retiring Orca; ask upstream for a license before sharing |

## Claiming across machines (topic 2 in detail)

**How the factory claims:** it checks for an active run for (repo, source, key), then inserts the run row **before** any network or Herdr work. A unique index is the lock, and losing that race logs "already claimed". The tracker label or status is written afterwards through the outbox. It is a projection of the claim, never the lock (INV-10, `src/core/deps.ts:197-200`): *"Two factories with separate DBs on one backend can double-claim."*

**Herdr multi-machine, measured 2026-09-16:**
- `--machine` is **not** in any Herdr release or preview. It landed on master on 2026-09-10 (`043b804`, #3918); the newest preview is 2026-09-08.
- All three hosts run a master build at `3f78f17` from the `sonhyrd/herdr` Actions run `35119220296`. It still reports `0.9.0`.
- `herdr machine add orca@<contabo> --label contabo` worked non-interactively and started contabo's server.
- `herdr --machine contabo agent list` and `workspace list` work. **About 27s per call** (4 samples), against about 3.5s for plain `ssh contabo herdr agent list`.
- `--machine` refuses `--json` ("cannot be combined with other launch options"); output is JSON anyway. It also refuses local management commands such as `status`.
- `--machine` works from a new client even though the mac **server** is still the old process: routing is client-side.

**Options:**
| Option | How | Trade-off |
|---|---|---|
| **A. One trigger label per host** (recommended) | contabo's belts pick up `hf-contabo`, cursor-5's `hf-cursor`, mac's `hf-mac` | No code. The label says both "go" and "where". Every factory stays local to its Herdr, so it doesn't pay the `--machine` latency |
| B. Split by source or repo | contabo takes MAMAS, cursor-5 takes GitHub repos | No code, but coarse |
| C. One factory, remote workers | Patch the factory's `HerdrClient` to add `--machine <host>` per run | One DB, so no double-claim; but ~27s per Herdr call against a 60s tick and many calls per run, and a factory outage stops every host |
| D. Tracker check-and-set before the insert | Re-read the GitHub assignee or Jira status right before claiming | Narrows the race without closing it; Jira has no atomic check-and-set |

### Solving it: two layers

**Layer 1: partition, config only. REJECTED 2026-09-16: it does not scale.** The host list is fixed in every machine's config, and work is split by hash rather than by free capacity, so a busy or down host still gets its share. Kept for the record. No two factories may ever *want* the same item.
Each host's belt gets a `match` predicate, the documented `repos/<name>/match-host.ts`: a default export `(ctx) => boolean`, `ctx = { item, source }`.

```ts
// HOST differs per machine: "mac" | "contabo" | "cursor"
const HOST = "contabo";
const HOSTS = ["contabo", "cursor", "mac"];          // same order on every machine
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export default ({ item }: { item: { key: string; labels: string[] } }) => {
  const pinned = item.labels.find((l) => l.startsWith("hf-") && HOSTS.includes(l.slice(3)));
  if (pinned) return pinned === `hf-${HOST}`;        // hf-contabo pins it to contabo
  return HOSTS[hash(item.key) % HOSTS.length] === HOST; // otherwise a stable split
};
```
Every factory polls the same trigger label. `hf-<host>` pins an item to a host; unpinned items are split by key hash.
- **Guarantee:** no double-claim, as long as `HOSTS` is identical everywhere.
- **Cost:** no failover. An item hashed to a host that is down waits until you pin it elsewhere.
- **Changing `HOSTS`** re-shuffles only unclaimed items; claimed runs are unaffected.

**Layer 2: a claim ledger on the tracker, code (~100-150 lines, upstreamable).** This closes INV-10 for real, with failover, for sources that have comments (Jira, GitHub).
1. **New optional Source hook `claimGuard(key, claimId)`**, built on the clients' existing `addComment`/`listComments` (`jira.ts:162-166`) and `createComment`/`listComments` (`github-issues.ts:218-234`).
2. **Call it in `claimImpl` after `createRun` and before `reconcileRun`** (`reconcile.ts:665`). No worktree, agent or status write exists yet, so losing costs nothing.
3. **Guard protocol:**
   - Post `[herdr-factory claim id=<runId> host=<host>]`.
   - Re-read comments after a short settle (~2s, to absorb list lag).
   - Among claim comments with no matching `[herdr-factory release id=…]`, the one with the **lowest server comment id** wins. Ids are server-assigned and monotonic, so every factory computes the same winner.
4. **Loser:** delete its own run row, post `release`, log "claimed elsewhere by <host>".
5. **Winner:** proceed as today.
6. **Teardown/abort:** post `release`, so the item can be claimed again.
7. **Stale claims (winner's host dead):** never reaped automatically. The item shows as claimed-by-<host>; a human re-labels to retry, which posts a release. This keeps "fence, never reap".
8. **Sources without comments** (local_markdown, sentry): no guard, keep Layer 1.

**Decision:** build Layer 2. It scales with no host list: a factory only reaches Phase B when it has free slots (`reconcile.ts:497`), so claims flow to whichever hosts have capacity. Adding a host means installing a factory with the same config. PR to this fork, offered upstream as an INV-10 amendment.

## How each is set up to work on other repos

Both are a control plane that works in *other* repos' worktrees. What differs is where each piece lives.

| | Our orchestrator + Orca | herdr-factory |
|---|---|---|
| Control plane | A git repo (`orchestrator`) that a Claude coordinator session opens in | An installed service: code in `~/.local/share/herdr-factory/`, launchd/systemd `ensure-up` every 60s keeps one `serve` running (README "How it works") |
| Target repos | Orca Projects (hyrd-widget, nuxt-hyrd-chrysus, agent-kit, …) | Every `~/.config/herdr-factory/repos/<name>/config.yml`; one `serve` ticks all of them |
| Onboarding a repo | Orca `repo add` + `data/registry.md` | `herdr-factory init` inside the checkout → `repo.path` (main checkout), `base_ref` (default `origin/main`), `github`; `reload`, no restart |
| Per-repo settings | Registry line + brief | `config.yml` (sources, belts, limits, agent, layouts), `env` (chmod 600, per-repo secrets), `guidelines-prompt.md`, `prompts/` |
| Work location | Orca worktree on the chosen Host | Herdr worktree created from `repo.path` |
| Run memory | Orca state + `BRIEF.md` | `<worktree>/.memory/herdr-factory/` + one SQLite DB for all repos |
| Rules for agents | CLAUDE.md, `docs/agents/*`, ADRs, brief | Target repo's CLAUDE.md/AGENTS.md for *how*; factory prompts + `guidelines-prompt.md` for *protocol* |
| Hosts | One control plane reaching every Host | One install per machine, each with its own `repos/` and checkouts |

Consequences:
- **A MAMAS ticket must match exactly one repo's config** (`[Chrysus]` vs `[Widget]` via `match`), or two repo configs on the same machine claim it. This is topic 2's double-claim, between repos.
- **Credentials are per repo**: the same Jira token is copied into each `env`.
- **The orchestrator repo's rules become config:** `guidelines-prompt.md` and prompt overrides, versioned in a small config repo synced into `~/.config/herdr-factory/`.

## Decisions
- **2026-09-17: safety surface kept at factory defaults.** Includes self-update from upstream (resets fork patches until #3) and teardown force-removing a worktree on a review run's PR branch if the operator checks it out mid-run.
- **2026-09-17: registry replaced by per-repo config.** local-only becomes a draft PR; `+yolo` dropped, so the human always merges.
- **2026-09-17: questions use the factory default.** Known risk on a shared board: the first non-herdr comment after a question (a teammate, a bot, QA) is taken as the answer. Accepted.
- **2026-09-17: levels use the factory default.** The reconciler (code) replaces the L1/L2 coordinator agents. Losing epic tracking and free-form rework is accepted.
- **2026-09-17: teardown uses the factory defaults.** That includes aborting a pre-PR run whose item was cancelled, which deletes unpushed early work and closes its agents; the trade is no token spend on cancelled work.
- **2026-09-17: multi-machine = one factory per machine** (issues #1-#4 on sonhyrd/herdr-factory). A single factory driving remote machines over `--machine` is rejected for latency.
- **2026-09-16: herdr-factory's defaults apply to trackers, with no extra restrictions.** Jira (MAMAS included) gets whatever the belt's defaults write: claim transitions, question comments, attention notes and `status.done` if configured. The old orchestrator's "Jira is read-only" rule (`docs/agents/dispatch.md:53`, PR #107) has no recorded reason and does not carry over.

## Every destructive path in the factory, and what to do with it
| Path | Trigger | Action |
|---|---|---|
| `teardown` → `worktree remove --force`, `workspace close`, `rmrf`, `branch -D` | PR merged | keep (the operator merged) |
| same | last step of a belt with no PR | keep only for belts that produce no code, otherwise park |
| same | item deleted or closed before a PR exists, run still claiming/running (`reconcile.ts:720-732`) | keep (factory default; stops token spend on cancelled work) |
| same | TUI `x` / CLI `teardown <key>` | keep (human) |
| `pane close` | failed agent adoption (`herdr.ts:299`) | acceptable: its own fresh pane |
| Jira transitions and comments | belt `effects`, `status.done`, ask-human, attention notes | keep factory defaults (decision below) |
| GitHub issue close | merged, or aborted with `close_on.aborted` | leave `close_on.aborted` unset |
| `git reset --hard` of the factory checkout, tracking upstream `main` | self-update | keep (default); **fork patches get overwritten until #3 lands** |
| SIGKILL of `serve` | restart after 18s | fine (workers live in Herdr) |

## Final checklist

Order matters: each phase assumes the ones before it. Everything uses factory defaults unless an issue says otherwise.

### Phase 0: machines
- [x] **Herdr on every machine:** official **v0.9.1** (first release with `--machine`) on mac, contabo and cursor-5, installed 2026-09-17 from the release assets, checksums verified; all three servers restarted onto it. The earlier master build is kept as `herdr-master-3f78f17`.
- [x] **ssh on cursor-5**, then `herdr machine add` from mac. Done 2026-09-17: contabo and cursor-5 saved; cursor-5 is key-only sshd over Tailscale, host key checked. **cursor-5 is a container (PID 1 tini): sshd must be restarted by hand (`sudo /usr/sbin/sshd`) after the container is recreated.** `--machine cursor-5 workspace list` ~37s.
- [x] **Agent integrations:** `herdr integration install claude` on every machine (+ `codex`, `cursor` where used); verify with `herdr integration status`. Done 2026-09-17: claude v10, codex v8, cursor v1 current on mac, contabo and cursor-5. On cursor-5 the codex hook landed in Orca's `CODEX_HOME`; codex isn't installed there.
- [x] **Agent CLIs + auth** (checked 2026-09-17: claude, cursor-agent, gh logged in as sonhyrd and git on all three; codex on mac and contabo only; cursor model setup still to confirm): `claude` on every machine; `cursor` on cursor-5 (install + model; drop setup-cursor-worker's Orca smoke test); `gh auth login`; `git`.
- [x] **Sidebar rows** on mac's Herdr config: default rows plus `$hf_key $hf_step $hf_state` on the agent line (applied with `herdr server reload-config`).
- [x] **Ghostty:** the suraj.io keymap is applied (Ghostty unbinds + Kitty sequences, Herdr `[keys]` with `cmd+` aliases); backups saved as `*.bak-2026-09-17`. Takes effect after a Ghostty config reload.

### Phase 1: one factory, one repo, one machine (contabo)
- [x] **Install from this fork:** `HERDR_REPO_URL=<fork> install.sh`; systemd `--user` supervisor active (linger on). Self-update tracks the **fork's** `main`, not upstream. `doctor --deep` can only go green *after* `init` (the database check waits for a configured repo).
- [x] **`herdr-factory init` for hyrd-widget** (`~/work/hyrd-widget`, `origin/main`). Jira MAMAS source, board 6; `JIRA_*` derived from agent-kit's `ATLASSIAN_AUTH` in `~/.teamai/env`. `nuxt-hyrd-chrysus` was added later from another session.
- [x] **Belts:** `ship` (`hf-ship`), `quick` (`hf-quick`), `review` (`hf-review`, all custom: checkout → review (commits) → prove → report), `plan` (`hf-plan`: grill → spec → tickets). No `draft` belt yet.
- [x] **Prompts:** plan and review custom-step prompts (~15 lines each); `work`/`evidence`/`review`/`pr` use the shipped base prompts unchanged.
- [x] **`guidelines-prompt.md`:** repo CLAUDE.md wins; one item one PR, never merge; dev-server port probing; `gh pr edit --body` workaround; vault credentials; **no glob `rm`** (added after Phase 2's first run).
- [x] **Layout with an evidence pane** (`widget-dev`: work / evidence + dev server / review / pr). Evidence publisher is **`command` → R2** (bucket `herdr-factory-evidence`, Pauls Job account, public r2.dev URL) via `repos/hyrd-widget/publish-r2.sh`, which uses contabo's wrangler OAuth login. The `local` publisher was dropped: its `127.0.0.1` URLs don't render in PRs.
- [x] **Match:** `match-widget.ts` requires a bracketed `[…Widget…]` marker (or a widget PR URL) in the summary; most MAMAS widget tickets lack one, so add it when labelling.
- [x] **Status map:** MAMAS has no "In Review" — `status.review: Code Review`; `status.done` unset (Jira's GitHub integration closes).
- [x] **Agent block:** default.

### Phase 2: prove it
- [~] **One real `hf-ship` issue end to end:** MAMAS-5681 → PR hyrdrocks/hyrd-widget#1501 (2026-09-17). Claim → work → evidence → review → pr → watching. **Pending:** human merge + teardown; no review comment yet, so the resolver is unexercised. `build-gated-tests` fails from `main`, not the PR (proven by the pr step with an empty probe PR; filed as hyrd-widget#1503).
- [ ] **One `hf-plan` issue** producing child `hf-ship` issues that are claimed on their own.
- [~] **One `hf-review` ticket:** MAMAS-9868 → PR nuxt-hyrd-chrysus#3927, run from another session; still running at 2026-09-17.
- [ ] **One ask-human round trip** answered on the ticket.
- [ ] **Compare with a recent Orca run:** tokens, wall time, human interventions. Write the numbers here.

**Lessons from the first `hf-ship` run (MAMAS-5681):**
1. **Claude Code's `rm` guard stalls steps.** `rm -f dir/*` raised a Yes/No prompt despite `--dangerously-skip-permissions`; the evidence step ran over budget and parked until a human answered. Guarded by a `guidelines-prompt.md` rule in both repos.
2. **Evidence must be published somewhere public.** The `local` publisher's URLs are host-local; switched to R2 (see Phase 1).
3. **The evidence step's film is better than pw-prove's clips:** before/after PNG per criterion + one continuous video at ~1920×1080, graded per criterion. Follow-up: sonhyrd/agent-kit#208 (split pw-prove; deferred until all phases are done).
4. **The pr step handles a red check from `main` correctly:** proves the diff is byte-neutral, probes `main`, files an issue, doesn't raise the ceiling.
5. **`runs` lags `explain`:** `runs` showed `claiming` while `explain` already reported the work step. Watch `explain`.
6. **Non-login shells miss `~/.local/bin`:** Herdr servers started via `machine add` give panes a PATH without it, so the `rtk` hook failed. Fixed in `~/.bashrc` on contabo and cursor-5.

### Phase 3: several machines (issues on sonhyrd/herdr-factory)
- [ ] **#3 (rescoped 2026-09-17):** code already syncs natively — install from the fork, auto-update follows the clone's `origin` (the earlier note that self-update tracks upstream was wrong). Config: a private git clone at `~/.config/herdr-factory` on every host, `git pull --ff-only && herdr-factory reload`; per-repo `env` copied per host. Remaining: a docs recipe (in the #8 PR).
- [ ] **#1:** claim ledger on the tracker, so several factories share one source.
- [ ] **#2:** machine-wide worked-workspace cap + free-memory admission gate; slower poll on mac makes it the last resort.
- [ ] **Install the factory on cursor-5 and mac** with the same config repo; caps local 4 / cursor 3 / mac 2 via #2.
- [ ] **#4:** read-only fleet view, only if the Herdr sidebar tokens aren't enough.

### Phase 4: retire Orca
- [ ] **All live Projects on the factory:** hyrd-widget, nuxt-hyrd-chrysus, agent-kit, claude-marketplace.
- [ ] **Stop dispatching through `orchestrator`;** archive the repo (keep the history).
- [ ] **agent-kit:** retire `run-matt`, `autoship`, `setup-cursor-worker`'s Orca parts, `claude-settings`' orca shim, the `check_orca_cli` scripts.
- [ ] **Ask upstream for a license** before sharing the fork or its configs beyond personal use.
