# herdr-factory CLI

Every command the `herdr-factory` binary exposes — exact syntax, flags, output, exit codes, and whether it talks to the resident server or does the work in-process.

Answers these questions:

- Which command answers "is the factory healthy / what's in flight / why is this run stuck"?
- Does this command need `--repo`, and what is the error when I forget it?
- What does `status` / `eligible` / `runs` / `timeline` / `logs` / `auth status` print when things are fine, and what does trouble look like?
- How do I un-park a run, force a tick, reload config after an edit, or eject prompts?
- What is the difference between `run`, `serve`, and `start` — and when do I install the supervisor?
- How do I fire a `step-done` by hand for a stuck run, and why do these signal commands never break across releases?
- Which environment variables matter, and why does exporting one in my shell not affect the installed service?
- Which diagnostics exist only on the local HTTP API?

---

## 1. Invocation basics

Two executables, both bash launchers that re-exec Node:

| binary | entry | notes |
|---|---|---|
| `herdr-factory` | `src/cli/index.ts` | **Zero args launches the TUI**, not help. `herdr-factory layout-hook` is special-cased to `src/cli/layout-hook.ts` (herdr calls it; see [layouts.md](./layouts.md)). |
| `herdr-factory-tui` | `src/tui/main.ts` | Takes **no arguments**. Adds `--experimental-ffi`; sets `OPENTUI_LIBC=musl` when musl is detected. |

**Node re-exec.** The launcher runs the active `node` if its major is ≥ 26; otherwise it uses the baked path in `<stateRoot>/node-path`; otherwise it exits 1 with:

```
herdr-factory requires Node >= 26, but the active node is '<node -v|none>'
and no usable baked Node path was found (<path>).
Fix: run install.sh (which vendors a pinned Node), or run any herdr-factory command once with
Node >= 26 active to bake the path; afterwards it works from any directory.
```

Every successful invocation re-bakes `node-path` (preferring the vendored `<stateRoot>/runtime/current/bin/node` symlink, never demoting a managed path to an ambient node). The launcher `cd`s to the package root first, so commands work from any directory. Prerequisites and the `install.sh` path: [install-and-operate.md](./install-and-operate.md).

**`--repo <name>`** is a program-level (global) option and works **before or after** the subcommand: `herdr-factory --repo proj status` and `herdr-factory status --repo proj` are equivalent. The value is the **config-folder name** under `~/.config/herdr-factory/repos/<name>/` — not the git repo name (`init` defaults it to the checkout's directory basename). Commands that need it and don't get it print to stderr and exit 1:

```
this command needs a repo: herdr-factory --repo <name> <command>
```

**Other globals.** `-V, --version` prints `<package version>+<git short12 sha>` (e.g. `0.1.0+d71240bfe0f1`) — the sha is how the supervisor detects an outdated running server. `-h, --help` works on the program and every subcommand.

**Exit conventions.** Unknown option/command/missing positional → commander error, exit 1. Any thrown error → the message on stderr, exit 1. `doctor` is the only command that sets `process.exitCode = 1` instead of exiting immediately. Signals and no-op operations exit **0** (see §4). There is **no `--json` flag anywhere**; the only JSON emitters are `eligible` and `schema --stdout`.

---

## 2. Which command do I want

| Intent | Command |
|---|---|
| Is the install healthy? | `herdr-factory doctor`, then `herdr-factory --repo <r> doctor --deep` |
| What's in flight right now? | `herdr-factory --repo <r> status` (add `runs --all` for history) |
| What's in flight on **every machine**? | `herdr-factory fleet` (`--json` to script it) — this machine plus every enabled `herdr machine list` entry |
| Why is *this* run stuck? | `herdr-factory --repo <r> explain <KEY>` (the narrative), then `--repo <r> timeline <KEY>` and `--repo <r> logs 200`; raw JSON: `curl -s 127.0.0.1:8765/repos/<r>/obligations?key=<KEY>` (§10) |
| Hand the diagnosis to an agent | `herdr-factory --repo <r> triage <KEY>` — launches the operator's agent CLI pre-briefed (`--print` to just emit the briefing) |
| What happened to this item? | `herdr-factory --repo <r> timeline <KEY>` |
| Make it run now | `herdr-factory --repo <r> tick` (one pass) or `--repo <r> run --follow` (foreground, streaming) |
| Un-park an `attention` run | `herdr-factory --repo <r> resume <KEY>` |
| I fixed the cause — clear the suspensions and retry | `herdr-factory --repo <r> retry-now [KEY]` (repo-wide with no key) |
| Start work on one item by hand | `herdr-factory --repo <r> claim <KEY> --belt <belt>` |
| Abandon a run + its worktree | `herdr-factory --repo <r> teardown <KEY>` |
| Scaffold a config from nothing | `herdr-factory init` from inside the checkout ([setup-interview.md](./setup-interview.md)) |
| Apply a config edit without a restart | `herdr-factory reload` |
| Customise prompts | `herdr-factory --repo <r> prompts eject` ([prompts.md](./prompts.md)) |
| Install this skill for an agent | `herdr-factory skill install` (or `--into <repo-checkout>`) |
| Run the factory in the background | `herdr-factory install` once, then `start` / `stop` ([install-and-operate.md](./install-and-operate.md)) |
| Check credentials | `--repo <r> auth status` (presence only) or `doctor --repo <r> --deep` (really exercises them) |
| Regenerate the editor schema | `herdr-factory schema` |

---

## 3. Command reference

**R** = requires `--repo`. **Route**: *server-first* = POST to the resident server, falling back to in-process only when there is no server (§5); *in-process* = never contacts the server.

### Inspect

| command | R | route | prints |
|---|---|---|---|
| `status` | yes | in-process DB + one `/health` ping | header, ACTIVE table, FINISHED table, server + supervisor lines (§6 anatomy); with a `machine.yml`, a `machine: cap n/N working across all repos · memory <free> MB available (floor <min> MB)[ — <active gate>]` line after `Runs:`; one `  ⏳ <source>: rate limited — holding polls for <n>s. <detail>` line per rate-limit-held source, right after `Sources:` |
| `runs [--all]` | yes | in-process DB | one line per run, no header. `--all` = last 100 by `created_at DESC`; default = active only (`ended_at IS NULL`) |
| `timeline <key>` | yes | in-process DB | events of the ticket's **most recent run only**, `<ISO ts>  <type>  <detail JSON>` |
| `explain <key> [--source <n>]` | yes | in-process DB + one `/health` ping | the plain-language rendering of the obligations view (§6 anatomy): the run's phase story or park reason, every pending retry with its next attempt time, armed clocks, bounce counters, and ready-made next commands. A key with no run recorded also prints `note: this host is not claiming new work right now — <gate> (machine.yml)` while a machine gate is engaged. Either way it ends with a `note: <source>: rate limited — holding polls for <n>s. …` line per rate-limit-held source — the usual reason a run's clocks look frozen |
| `triage <key> [--source <n>] [--print]` | yes | in-process DB, then an **interactive launch** | writes a briefing (the `explain` narrative + recent events + locations + playbook paths + ground rules) into the run's `.memory/herdr-factory/` (state dir when no worktree), then launches the repo `agent:` **command** (flags dropped — a human is present) in your terminal, cwd = the worktree. `--print` prints the briefing instead. No active run → a one-line pointer, exit 0; a missing harness binary → exit 1 naming it and suggesting `--print` |
| `eligible` | yes | in-process (hits every source) | `JSON.stringify(out, null, 2)` of `{source, key, summary, type}`; `[]` when nothing is eligible |
| `logs [n]` | yes | in-process (file) | last `Number(n) || 50` lines of `<stateRoot>/<repo>/logs/<UTC-date>.log`. `logs 0` and `logs abc` both mean 50. Missing file → `no log for today at <path>`, exit 0 |
| `auth status` | yes | in-process (env only, **no network**) | one line per source; presence of each source's declared secrets |
| `doctor [--deep]` | optional (adds a repo group) | in-process; `--deep` adds network | grouped `✓ / ⚠ / ✗` checks + one `Next:` hint. `process.exitCode = 1` iff any `✗`; `⚠` never fails it |
| `fleet [--json] [--timeout <ms>]` | **no** (a `--repo` narrows it to that repo) | HTTP to every machine's `/health` + `/repos/*/status`, in parallel | a line per machine then the run table (§6 anatomy). `--json` = the whole snapshot. Never non-zero for an unreachable machine — that is reported, not raised |

Notes:
- `runs`/`status` pad columns with `padEnd` and never truncate them — long keys just push columns right (`status`'s trailing summary is the one exception: it is cut at 50 chars). Parse by splitting on whitespace, not fixed offsets.
- `auth status`'s only valid action is `status`; anything else exits 1 with `unknown auth action "<x>" — use: status`.
- Secrets are read only from `<configDir>/repos/<name>/env` (`KEY=value`, `#` comments). There is no global secrets file.
- `doctor` resolves `git`/`herdr`/`gh`/`claude` against the **installed service's PATH** parsed out of the plist/unit, not your shell's PATH — so it can report `✗` for a tool your shell runs fine. The `herdr` check also runs `herdr --version` and enforces the floor in `herdr-plugin.toml` (`>= 0.7.5`), reporting `v<x> is too old — the factory needs >= 0.7.5 (run \`herdr update\`)`; `--deep` adds the running server's protocol compatibility (`v0.7.5, protocol 17`). Full check-by-check remediation is in [troubleshooting.md](./troubleshooting.md).

### Operate

| command | R | route | prints |
|---|---|---|---|
| `tick` | yes | server-first | exactly one line: `tick: ran (via server)` / `tick: ran (in-process)` / `tick: another tick already running (in-process)` |
| `run [--follow]` | yes | **in-process only** (takes the per-repo tick lock, so it cooperates with a resident server) | header + a live event feed; see §7 |
| `claim <key> [--belt <name>]` | yes | server-first | `<key>: claimed` |
| `teardown <key> [--source <name>]` | yes | server-first | `<key>: torn down` |
| `resume <key> [--source <name>]` | yes | server-first | `<key>: resumed -> <phase>`, or `<key>: no active run` / `<key>: run busy — retry the resume` via the server — the in-process fallback appends ` in a moment` (exit 0 either way) |
| `retry-now [key] [--source <name>]` | yes | server-first | `<repo\|key>: N stuck jobs made due now (M suspensions cleared) and flushed` · `… (a tick is mid-pass — it will deliver them)` when the tick lock was held · `<repo\|key>: no suspended or waiting retries` (nothing was stuck — the delay is elsewhere) · `<key>: no active run` |
| `watch` | yes | in-process, resident | `[legacy/dev]` single-repo loop; all output goes to the **logger** (stderr + the log file), nothing to stdout. The server replaces it |

With `machine.yml` `max_active_workspaces` set, `claim` exits 1 with `<key>: not claimed — machine at capacity (n/N); raise max_active_workspaces in machine.yml or wait for a run to finish` (or `… another repo is claiming right now (machine claim lock held); retry in a moment`), server up or down.

**Trap:** `claim` prints `<key>: claimed` and `teardown` prints `<key>: torn down` **even when nothing happened** — an already-active run or a missing run only logs a WARN to stderr and still exits 0. Never treat their stdout as confirmation; check `status`/`timeline`.

`claim` errors (exit 1): `unknown belt "<b>"; configured: <list>` · `multiple belts configured — pass --belt <name> (one of: …)` · `belt "<b>" references unconfigured work source "<s>"` · whatever the source's lookup throws (e.g. `HTTP 404: https://api.github.com/repos/<o>/<n>/issues/999: …`).

`teardown`/`resume`/`retry-now` error (exit 1): `<key>: active in multiple sources (<s1>, <s2>) — pass --source <name>`.

`retry-now` is the deliver-lane counterpart of `resume`, and the two do not overlap: `resume` moves a
parked run's `phase` and refuses anything not in `attention`; `retry-now` touches only the intent
ledger's own rows — every **suspended** pending intent in the repo (or one run's, with a key) is
cleared with `attempts` reset to 0 (a fresh 10-attempt window), every merely mid-interval row becomes
due now (its `attempts` kept), then Phase 0 is flushed under the repo tick lock so they land on this
call. Rows that were already due are not counted, so `no suspended or waiting retries` is a real
diagnostic. Reach for it after fixing a cause the engine cannot probe: AWS creds classified `auth`
and source auth self-heal on the next tick, but a timeout, an unknown SDK error, or a source that
was briefly 500ing sit suspended after 10 flat 30 s retries.

### Agent signals

See §4 for semantics and messages.

| command | R | route |
|---|---|---|
| `step-done <key> <step> [--source <n>] [--pass <n>]` | yes | server-first |
| `bounce <key> <toStep> [--source <n>] [--reason <text>\|--reason-file <path>] [--step <n>] [--pass <n>]` | yes | server-first |
| `ask-human <key> <step> [--source <n>] [--question <text>\|--question-file <path>]` | yes | server-first |
| `capture-attempt <key> <step> [--source <n>]` | yes | server-first |
| `set-branch <key> <branch> [--source <n>]` | yes | server-first |
| `evidence-upload <key> [--source <n>]` | yes | **in-process only — never routes** |
| `capture-lock <acquire\|release> <resource> [owner]` | **no** | in-process, global DB |

`capture-lock` loads **no config at all** — it opens `<stateRoot>/herdr-factory.db` directly, so it works on a machine with zero repo configs. `owner` defaults to `worker`. `acquire` polls every 5s with a 1200s lock TTL and gives up after 1 hour (`timed out waiting for the <resource> lock`, exit 1); success prints `<resource> lock acquired by <owner>`. `release` is owner-scoped and silently no-ops when the lock isn't held: `<resource> lock released by <owner>`. Any other action → exit 1 `capture-lock: acquire|release <resource> [owner]`.

`evidence-upload` enqueues a durable ledger intent **first**, prints the predicted public URLs, then attempts an inline publish. It exits **0** on every failure path — the ledger owns retry:

```
public URLs (use these in your handoff even if delivery is deferred — they resolve once the bytes land):
<url>…
published <N> evidence file(s) via <publisher>
```

Deferred (`auth`/`transient`): `evidence-upload: publish deferred — <reason>. The engine will retry automatically; the URLs above resolve once it lands.` Config error (`permanent`): `evidence-upload: publish FAILED (config error) — <reason>. Run \`herdr-factory --repo <repo> doctor --deep\`.` Early no-ops: no `evidence:` block configured · `<key>: no active run with a worktree — nothing to publish` · `evidence-upload: no files in the evidence dir — nothing to publish` (dir = `<worktree>/.memory/herdr-factory/evidence`).

### Scaffolding

| command | R | prints |
|---|---|---|
| `init [--source <type>] [--path <dir>] [--force]` | optional (names the config folder; else the checkout's basename) | `scaffolded repo "<name>" (<source>[, origin <o/n>]) at:` + config/schema/secrets paths + per-source `next steps:` |
| `prompts eject [--step <name>] [--force]` | yes | `Ejected <N> prompts into <dir>:` + file list + paste-ready step lines; or `Skipped <N> already-present files (pass --force to overwrite):` |
| `schema [--stdout]` | no | `wrote <configDir>/config.schema.json` (and writes `machine.schema.json` beside it) + the `# yaml-language-server: $schema=../../config.schema.json` modeline. `--stdout` prints the JSON Schema and writes nothing |
| `skill install [--into <dir>] [--copy] [--symlink] [--force]` | no | `Installed the herdr-factory skill at <dest> (<symlink → src>\|<N> files copied from <src>)`, or `Skill already installed at <dest> → <source>` |
| `telemetry-smoke` | no | `telemetry smoke trace emitted (service: herdr-factory, trace root: cli.command)`, or `telemetry disabled — set HERDR_FACTORY_TELEMETRY=1 and OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` |

`init` specifics (full walkthrough in [setup-interview.md](./setup-interview.md)): `--source` must be one of `jira | github_issues | local_markdown | sentry` (else exit 1 `unknown --source "<x>" — use one of: …`); it refuses an existing config with `config already exists at <path> — pass --force to overwrite it (or edit it directly)`; `--path` is used **verbatim** (never normalised to the git top-level), so a subdirectory fails `assertMainCheckout`; it writes a chmod-**0600** `env` file only for sources with required secrets (`jira`, `sentry`) and **never** overwrites an existing one, even with `--force`; and it does **not** register the repo with a running server — run `reload` after.

`prompts eject`: only action is `eject` (else exit 1 `unknown prompts action "<x>" — use: eject`). Existing files are skipped unless `--force`. An unknown `--step` exits 1: `no shipped prompt named "<x>" — available: evidence, pr, resolver, review, work`. It works before `init`, printing a note rather than failing — so a typo'd `--repo` silently creates a stray `repos/<typo>/prompts/` folder.

`skill install` defaults: **symlink** into `~/.claude/skills/herdr-factory` (so the auto-updater keeps the skill in lock-step with the engine), **copy** for `--into <checkout>` → `<checkout>/.claude/skills/herdr-factory` (committable). Errors: `skill install: pass either --copy or --symlink, not both` · `<dest> already exists (<a symlink to …|an installed skill|a directory>) — pass --force to replace it` · `the shipped skill bundle is missing (expected <dir>/SKILL.md) — reinstall herdr-factory` · `unknown skill action "<x>" — use: install`.

### Machine-wide server and supervisor

None of these take `--repo` — the server serves every configured repo.

| command | prints |
|---|---|
| `serve` | resident daemon; all output is `<ISO> [server:<level>] <msg>` on **stdout** |
| `ensure-up [--restart]` | `ensure-up: noop\|started\|restarted` plus `[<level>] <msg>` decision lines |
| `restart` | `restart: noop\|started\|restarted` (= `ensureUp({force:true})`; does **not** skip auto-update) |
| `update` | `no update: <reason>` or `updated <from12> → <to12>; restarting server` + `restart: <action>` |
| `reload` | `reloaded — serving: a, b, c` (or `(no repos)`), plus `  ⚠ <repo>: <error>` per failing repo (`  ⚠ machine.yml: not reloaded: invalid machine config …` when machine.yml is invalid — nothing reloads) |
| `install` | `installed + loaded <label> — scheduled ensure-up keeps the server serving all configured repos` + the schema path + a `Next: configure your first repo…` pointer (suppressed when `HERDR_FROM_INSTALLER` is set) |
| `uninstall` | `uninstalled <label>` (in-flight workers untouched) |
| `start` | `started <label>` + `Next: watch it work — run \`herdr-factory\` for the TUI dashboard, or \`herdr-factory --repo <name> status\`.` |
| `stop` | `stopped <label>` + `server stopped` / `no server running` |
| `provision-node` | `node <version> provisioned (current → this) at <path>` or `node <version> already current at <path>` |

- **`reload` is server-only** — it uses `serverFetch` with no local fallback. With no server it prints `no server running — config is read fresh on the next \`serve\` start (try \`herdr-factory start\`)` and exits **0**. A reload that would orphan work is refused: `repo "<n>": reload refused — belt "<b>" (<k> in progress) still has work`.
- `serve` binds `127.0.0.1:<HERDR_FACTORY_PORT|8765>`. It exits early on `another server already healthy on :<port> — exiting`; a bind failure prints `failed to bind 127.0.0.1:<port> — <msg>` and exits 1. On success it writes `<stateRoot>/server.json` (`{pid, port, version, startedAt}`), logs `serving on 127.0.0.1:<port> — repos: <a, b>`, **rewrites `<configDir>/config.schema.json` on every start**, and ticks each repo at its own `tick_interval_seconds`. A repo that fails to load logs `repo "<n>": failed to load — <msg>` and is dropped from the loop. SIGTERM/SIGINT/`POST /shutdown` drain gracefully (≤15s) and remove `server.json`.
- `ensure-up` is what launchd/systemd schedules every 60s. It runs the auto-update first (unless disabled), then restarts the server if `server.json`/`/health` is missing, if `info.version !== VERSION`, or if any repo's tick loop is stale (`now - max(lastTickAt, serverStartedAt) > max(10 × tickIntervalSeconds, 900)`). Decision lines you'll see: `server healthy on :<port> (v<v>)` · `server not responding — restarting` · `server v<a> != v<b> — restarting` · `tick loop stale for <repos> — restarting wedged server` · `started serve` · `restarted serve`.
- `update` is **channel-aware**: `HERDR_CHANNEL=stable` hard-resets to the newest release tag `v?X.Y.Z` (pre-releases ignored); anything else resets to the branch upstream `@{u}`. (The README's "hard reset to the branch's upstream" is stale.) `no update: <reason>` reasons: `not a git checkout`, `cannot read HEAD`, `up to date`, `dirty checkout`, `reset failed`, or a resolve error such as `no release tags yet (stable channel)`. Every attempt is recorded in `<stateRoot>/update-status.json`, which is what `doctor`'s `auto-update` check reads.
- **`start` self-installs.** `start()` checks for the plist/timer file and calls `install()` when it is absent, so `herdr-factory start` on a machine that never ran `install` still writes and loads the job (`src/watchers/launchd.ts`, `src/watchers/systemd.ts`). It differs from `install` only in what it *doesn't* redo on an already-installed machine: it does not re-bake the service environment (§8), does not rewrite `config.schema.json`, and does not boot out legacy per-repo jobs. Prefer `install` after changing a baked env var; `start` is the cheap "bring it back up". Full lifecycle: [install-and-operate.md](./install-and-operate.md).
- Service identity: macOS launchd label `com.herdr-factory.server` (`~/Library/LaunchAgents/com.herdr-factory.server.plist`, `StartInterval 60`); Linux `herdr-factory.timer` in `~/.config/systemd/user/` (`OnUnitActiveSec=60`). Supervisor logs: `<stateRoot>/logs/supervisor.{out,err}.log`. An unsupported platform throws `no supervisor service for <platform> (macOS launchd / Linux systemd only)`.

---

## 4. Agent→dispatcher signals

`step-done`, `bounce`, `ask-human`, `capture-attempt`, `set-branch`, `evidence-upload` are **rendered into step prompts** as `@@STEP_DONE_CMD@@`, `@@BOUNCE_CMD@@`, `@@ASK_HUMAN_CMD@@`, `@@CAPTURE_ATTEMPT_CMD@@`, `@@SET_BRANCH_CMD@@`, `@@EVIDENCE_UPLOAD_CMD@@` and are normally run by the worker agent, not typed by hand. A diagnosing agent does sometimes need to fire one manually — most often `step-done` for a run whose agent died after finishing its work.

Rendered form (single source of truth, `src/signals/registry.ts`): `<abs path to bin/herdr-factory> --repo <repo> <signal> <positionals…> [--flag value…]` — `--repo` comes **before** the signal name and values are **not shell-quoted**. Prompts render the *file* variants (`--reason-file .memory/herdr-factory/bounce-<step>.md`, `--question-file .memory/herdr-factory/human-question-<step>.md`).

**Cross-release compatibility.** A rendered prompt outlives the engine that rendered it — an agent may still be sitting on a command string from before the last auto-update or restart. So this surface is **additive only**: new arguments arrive as *optional* flags (`--pass` and `bounce --step` are both marked "optional for upgrade safety" in the registry), never as new required positionals, and an unstamped signal is still accepted. When constructing a signal by hand, pass only what you need; omitting `--source`/`--pass` is always valid.

**`set-branch` — the branch is tracked, the worktree is the identity.** The factory names a run's
branch at claim time from the work item; a repo whose branching/CI convention needs another shape
(commonly "every branch carries a ticket key") has its agent rename it **once, before pushing**:
`set-branch <key> <branch>` does the `git branch -m` inside the worktree, patches `runs.branch`, and
records a `branch_changed` event. It is refused for an invalid or already-taken name, for a protected
branch (the repo's `base_ref` or the main checkout's branch), while HEAD is detached, and **after the
run's PR is open** (the PR head is the pushed branch — renaming then strands it). A rename done
without the command is picked up by the next reconcile pass anyway (`syncRunBranch`), so a run never
"loses" its branch; the command exists to fail loudly and early. `runs.worktree_name` never moves —
it is what the layout hook matches, and teardown deletes every name the run used.

File arguments (`--reason-file`, `--question-file`) resolve against **your** current directory — the launcher deliberately does not change directory, so the relative paths the prompts render (`.memory/herdr-factory/bounce-<step>.md`) resolve inside the agent's worktree, where the agent was told to write them.

All five dispatcher signals go through the same `applySignal` engine function on both the server and the local path, so the two can't drift. **A rejected signal prints to stderr and exits 1** — the exit code is an agent's only feedback, and a rejection that exited 0 used to leave the agent believing it had finished while the run sat until its step budget expired. Success (including the idempotent `already recorded done`) still exits 0:

| signal | success output | rejection messages (stderr, **exit 1**) |
|---|---|---|
| `step-done` | **nothing — silence is success** | `no active run` · `step "<s>" is not in belt "<b>"` · `"<s>" is not the run's active step ("<active>") — signal ignored` · `stale step-done for pass N — the <step> step is on pass M; finish the current pass and run its own step-done command` (`already recorded done` is treated as success, so it prints nothing) |
| `bounce` | `<key>: bounced to <toStep>[ — <message>]` | `<key>: run busy — bounce to <toStep> recorded; it will be applied on the next reconcile pass` · cap hit → `<key>: bounce limit exceeded — escalated to attention` (the run is parked, **not** sent back; `<key>: cap exceeded — parked for attention` only when a concurrent reconcile pass consumed the bounce first) · `<key>: step "<toStep>" is not in belt "<b>"` |
| `ask-human` | `<key>: waiting for human answer (question #<id>)` (`, posting deferred` when the source write is queued) | `<key>: run busy — question recorded; it will be posted on the next reconcile pass` |
| `capture-attempt` | `<key>: capture attempt #<n> recorded` | cap hit → `<key>: <message>` (parked for attention) |
| `set-branch` | `<key>: branch renamed <old> -> <new>` (plus ` — note: "<old>" was already pushed; delete the stale remote branch (git push origin --delete <old>)` when it had a remote ref) · `<key>: already on <new>` · `<key>: tracking <new>` | `"<n>" is not a valid branch name: <why>` · `branch "<n>" already exists in this repo …` · `"<n>" is a protected branch …` · `PR #<n> is already open from "<b>" — renaming now would strand it …` · `the worktree's HEAD is detached …` · `this run has no worktree yet …` |

Flag errors also exit 1: `ask-human: pass either --question or --question-file, not both` · `ask-human: provide a non-empty --question or --question-file` · `bounce: pass either --reason or --reason-file, not both` · `bounce: provide a non-empty --reason or --reason-file (the findings the earlier step must address)`.

Step semantics (what a bounce rewinds, what a cap does) live in [belts-and-steps.md](./belts-and-steps.md).

---

## 5. Server routing and the fallback contract

- `server-first` commands (`tick`, `claim`, `teardown`, `resume`, `retry-now`, `step-done`, `ask-human`, `bounce`, `capture-attempt`, `set-branch`) POST to `127.0.0.1:<port>` with a 10-minute timeout (they do real work).
- The local fallback fires **only** when there is no server to reach: no `<stateRoot>/server.json`, connection refused, or timeout. A server we *reached* that answers non-2xx propagates its error and exits 1 — there is no silent fallback.
- The single most useful "my CLI and my server disagree" diagnostic (HTTP 404):
  ```
  $ herdr-factory --repo proj tick
  repo "proj" not configured (server knows: herdr-factory, reckon-frontend)
  # exit 1
  ```
  Usual cause: the repo was scaffolded after the server started (run `reload`), or your shell's `HERDR_FACTORY_CONFIG_DIR` differs from the service's (§8).
- Other server statuses: 400 body-validation (`<path>: <message>; …` or `invalid request`), 404 `<key>: no active run` / `no intent #<id> in <repo>`, 500 otherwise, 404 `no route for <METHOD> <path>`.

---

## 6. Read-command output anatomy

### `status`

```
herdr-factory [reckon-frontend] — cap 15 workspaces
Sources: core-jira-tickets(jira) · adhoc-pr(local_markdown) · sentry(sentry)
  ⏳ issues: rate limited — holding polls for 1734s. GitHub rate limit exhausted (x-ratelimit-remaining: 0) on GET /repos/acme/app/issues — HTTP 403; …
Belts (priority order): fix-core-jira-tickets(work_to_pull_request, src:core-jira-tickets, p1) · sentry-issue-to-jira-ticket(custom, src:sentry, p3, INACTIVE)
Runs: 2 running (cap 15) · 27 finished

  ACTIVE (2)
    RWR-17849        fix-core-jira-tickets waiting_for_human worker:gone      PR:-      [UI] Make invoice number editable when
      steps: work✓ evidence●
    staging-cherry-pick adhoc-pr         waiting_for_human worker:idle      PR:#6837  staging cherry pick

  FINISHED (27, newest first)
    RWR-18374        fix-core-jira-tickets done         merged           PR:-      [UI] Update page size for "Add multiple
server: running (pid 29590, port 8765, v0.1.0+d71240bfe0f1)
supervisor: loaded
```

Column 3 is `run.step` when the phase is `running`, otherwise the phase. `worker:` is the live herdr pane state (`working` · `idle` · `gone` · `no-pane` when the run has no pane · `unknown` when the herdr call itself failed). `Runs: A running` counts `ended_at IS NULL`, which **includes parked runs**, so `A` can exceed the number of runs holding a slot. `(none in flight)` replaces the ACTIVE rows when there are none; the FINISHED block is omitted entirely at zero and gains a `, latest 100` suffix when the query hit its limit.

Broken-status tells, most useful first:

| line | meaning |
|---|---|
| `server: advertised but not responding` | `server.json` exists but `/health` fails — wedged or dead `serve`. `herdr-factory ensure-up --restart` |
| `server: not running` | nothing is ticking. `herdr-factory start` |
| `supervisor: not loaded` | no scheduled `ensure-up`; the server will not come back by itself. `herdr-factory install` |
| an ACTIVE row with phase `attention` | parked. `timeline <KEY>` carries the machine `reason` code; `resume <KEY>` un-parks |
| phase `waiting_for_human` | blocked on a source reply |
| `worker:gone` on a `running` row | the agent pane died; the watchdog will park it |
| `worker:unknown` | the herdr daemon isn't answering — `doctor --deep` |
| `Runs: N running (cap N)` | at the cap; no new claims until something drains |
| `…, INACTIVE` on a belt | that belt makes no new claims by config (in-flight runs continue) |

### `runs` / `timeline`

```
#58   staging-cherry-pick waiting_for_human           PR:- chore/staging-cherry-pick-staging-cherry-pick-0c464a
#57   RWR-18374    done         merged    PR:- chore/RWR-18374-ui-update-page-size-1a9a28
```

Phases: `claiming | running | waiting_for_human | reviewing | tearing_down | done | attention`. Outcomes: `merged | closed | abandoned | timeout | completed`.

```
2026-07-24T06:38:52.000Z  claimed  {"branch":"chore/staging-cherry-pick-…","source":"adhoc-pr","belt":"adhoc-pr"}
2026-07-24T07:22:37.000Z  layout_wait_retry  {"step":"work","tab":"fix","pane":"work","attempt":1,"limit":3,"agentRestarted":true}
2026-07-24T08:06:19.000Z  attention  {"reason":"layout_wait_timeout","step":"work","tab":"fix","pane":"work","respawnsUsed":3}
2026-07-24T08:15:26.000Z  resumed  {"phase":"claiming","step":null,"nudged":false}
2026-07-24T08:23:10.000Z  pr_opened  {"number":6837}
```

Healthy = rows/events. **Empty output is ambiguous**: no runs, wrong `--repo`, wrong key, or an older run (`timeline` shows only the ticket's newest run) — all exit 0. Trouble looks like `stale`, repeated `layout_wait_retry` then `attention`, `signal_rejected`, `evidence_upload_failed`, or `error` events.

### `eligible`

```
[
  { "source": "briefs", "key": "fix-login", "summary": "Fix the login redirect", "type": "brief" }
]
```

`[]` is healthy when nothing is labelled. A per-source failure is a **stderr warn**, not an error — stdout still emits valid JSON and exit is 0:

```
2026-…Z [WARN] issues: eligible query failed: HTTP 404: https://api.github.com/repos/acme/widget/issues?labels=agent&…
```

Typical causes: `HTTP 401/403` (bad or expired token), `HTTP 404` (wrong or private repo), a Jira board id that doesn't exist.

**The CLI and the HTTP route are not the same read.** `eligible` is the only one that queries the sources live — it polls every belt, INACTIVE ones included, so it can list items the dashboard will never show and nothing will claim. `GET /repos/{repo}/eligible` (what the dashboard and the TUI read) **never** calls a source: it answers from the last successful tick poll, adds `belt` and `polledAt` (epoch seconds, so a UI can show the list's age), skips inactive belts and anything that already has an active run. A server that hasn't ticked yet answers `[]`, and a list up to one `poll_interval_seconds` stale is expected. Use the CLI when you need to know what the source says *right now*; the endpoint is deliberately free, because one open TUI polling it live used up the whole (account-wide) GitHub budget.

### `logs`

```
2026-07-25T09:53:03.701Z [INFO] belt sentry-issue-to-jira-ticket: inactive — skipping (no new claims; in-flight runs continue)
2026-07-25T09:53:03.702Z [INFO] claimed 0; working 0/15, idle/parked 2
```

`claimed <n>; working <a>/<cap>, idle/parked <p>` once per tick is the heartbeat — **its absence** means this repo isn't being ticked (server down, repo failed to load, or wrong `--repo`). Log lines go to stderr **and** the file. The filename uses the **UTC** date, so `no log for today at <path>` also means "nothing has run yet this UTC day".

### `auth status`

```
auth status — repo proj:
  core-jira-tickets (jira): ✓ JIRA_EMAIL + JIRA_API_TOKEN present
  briefs (local_markdown): no authentication required
  issues (github_issues): using the gh CLI login (`gh auth status`)
  sentry (sentry): ✗ set SENTRY_AUTH_TOKEN in the repo env
```

Presence-only: a **wrong** token still shows `✓`. Use `doctor --repo <r> --deep` to actually exercise it. Which secrets each source declares is in [work-sources.md](./work-sources.md).

### `explain`

The plain-language rendering of the obligations view (`src/core/explain.ts` over `runObligations`) — identity line, then the phase story (or the park's reason-code narrative with its rescue class), then the deliver-lane debts, bounce counters, and ready-made next commands:

```
RWR-18147 — run #58 on belt tickets-to-prs (attention)

The run is parked: the work step's pane never became available (work: layout pane fix/work never became available).
The engine already re-attempted the spawn on its own (3 of 3 respawn windows used) — this park means the pane is genuinely not coming up.
Common causes: the factory isn't linked as a herdr plugin, or the step's tab/pane names don't match the layout's real titles.

Owed to the world (durable, retried until delivered):
  · status write-back → In Progress: attempt 4, next try in ~12m.
      last error: HTTP 401 unauthorized

Next:
  herdr-factory --repo proj resume RWR-18147   # refunds the respawn budget
  herdr plugin link ~/.local/share/herdr-factory   # if the layout never builds at all
```

Semantics worth knowing:

- **Retry clocks render against `deps.now()`**; a past-due retry prints `due now (the next tick runs it)`. When no server is ticking, a trailing `note:` says every clock above only advances on a tick — the single most misread "stuck" state.
- **No active run** is not an error (exit 0): with a prior run it prints `<key>: no active run — the newest run #<id> ended <age> ago (<outcome>).` plus a `timeline` pointer; with no run at all it points at `eligible`/`claim`.
- Exit 1 only for the usual resolution errors: missing `--repo`, or `<key>: active in multiple sources (…) — pass --source <name>`.
- The same lines appear in the TUI: `d` on a run → the detail's **"What's happening"** section (fed by `GET /obligations`, so it needs the server; the CLI path reads the DB directly).
- An `attention` run explains its own `attention_reason_code` (the full code table is in [troubleshooting.md](./troubleshooting.md) §3); an unknown/plugin code falls back to the stored reason text plus the guard's derived rescue class.

### `triage`

`explain`'s escalation: a briefing file plus an interactive session. The briefing (markdown) carries the `explain` narrative verbatim, the last 15 events, the run/worktree/config/log locations, this skill's `references/troubleshooting.md` + `references/cli.md` paths (readable as plain markdown by any harness), and ground rules — resume is safe once cause is agreed; `teardown`/`bounce`/proxy `step-done` require the operator's explicit OK. Launch details worth knowing:

- The harness is the **repo-level** `agent:` block's `command` only (per-belt/per-step overrides are ignored — triage is not a belt step), and the configured worker **flags are dropped on purpose**: they set the unattended posture (`--dangerously-skip-permissions`), and a triage session has the operator present.
- The session runs **in the invoking terminal** (`stdio: inherit`), never in a herdr pane — so it works when herdr or the server is down. The opening prompt tells the agent to read the briefing file and propose one next command.
- The attention note a park posts to the work source ends with both ready-made commands: `resume <KEY>` and `triage <KEY>`.
- Note for an agent reading this: if YOU are the harness the operator launched via `triage`, the briefing file named in your opening prompt is your starting context — read it before running anything.

### `fleet`

Every run on every machine, plus a line per machine. The fleet is **this machine plus every *enabled*
entry of `herdr machine list`** — no config key, nothing to register. `herdr machine disable <p>`
takes a box out; a machine with no saved machines prints exactly what a single-machine install always
saw.

```
herdr-factory fleet — 2 machines (1 reachable, 1 unverifiable) · 2 runs

  ✓ local (this machine) — v0.1.0 · 1 repo · 1 running · cap 1/4 working across all repos · memory 7412 MB available (floor 1024 MB)
  ✗ build-box (ops@build-box) — unverifiable: ops@build-box: Permission denied (publickey). (ssh exited 255, 3 /health attempts) · last seen 4m ago · its runs are NOT known to be gone

  MACHINE  REPO  KEY     BELT         STEP  PHASE    AGE  PROBLEMS
  local    app   HF-101  ship-gh      work  running  12m  -
```

Semantics worth knowing:

- **A remote machine's API is reached over an SSH local forward** (`ssh -N -L <free port>:127.0.0.1:8765 <target>`, ControlMaster reused), so every server keeps binding `127.0.0.1` only. The local machine is read from `server.json`, as the TUI always has.
- **A machine on another build is marked.** A reachable remote whose `/health` version differs from this machine's gets `⚠ build differs from this machine (v<local>)` on its line — the box the updater has not reached (the TUI dashboard's status line says the same: `<name> on v<x> (this machine v<y>)`).
- **ssh exiting 0 is not a failure.** `ControlPersist` keeps the shared connection alive between calls, so the `ssh` that opens a forward exits 0 the moment a backgrounded master takes it over. A machine is judged by whether its forwarded port answers `/health`; only a non-zero ssh exit (or the timeout) reads `unverifiable`. Tear-down cancels the forward through the control socket (`ssh -O cancel`) and leaves the shared connection up for the next read.
- **The ControlMaster socket goes wherever it fits.** A Unix socket path is capped at 104 bytes (macOS), so the socket lives in `/tmp/hf-<uid>/` (mode 0700) unless `<stateRoot>/fleet-ssh/%C` is short enough, and the forward runs unmultiplexed if neither fits. Nothing to configure, and no reason left for a machine to read `unverifiable` while `ssh -L` by hand works.
- **A stale ControlMaster is replaced once.** The same reuse that makes the next read cheap lets a master outlive the connection it multiplexes (the remote server restarted under it, the network path moved); `ssh -O check` still answers `Master running` because it only pings the local socket. A running master *plus* a forward through it that did not come up is read as stale: `-O exit` drops it and the forward is retried once on a fresh connection, and if that fails too the row carries both attempts' reasons.
- **`unverifiable` ≠ empty, and it always names a cause.** A machine that times out or refuses reports `unverifiable` with the time it last answered (remembered in `<stateRoot>/fleet-last-seen.json`) and the real reason rather than a generic "could not reach its API": **ssh's own first line of stderr with its exit code and how many `/health` attempts ran** when the forward is what failed (`orca@build-box: Permission denied (publickey). (ssh exited 255, 3 /health attempts)`), or **the call and the budget it missed** when the forward came up and the API is what did not answer (`no answer from /health within 2500ms`). Its runs are **unknown, not gone** — do not claim an item because it did not appear in a fleet read where its machine was unverifiable.
- **Machines are read in parallel**, each under `--timeout` — default **5000ms for this machine, 15000ms for a remote one** (which has to bring its forward up before it can read anything; `--timeout` sets both). Reads over a forward are floored at 2500ms rather than the 500ms a local `/health` gets: a box that is merely far away is not a box that is down. One dead box costs one pause and not the view.
- **Actions route to the owning machine only.** A key active on two machines is refused rather than guessed (`… is active on more than one machine (…) — narrow it with --machine or --repo`), and a key found nowhere names the machines that read as unverifiable.
- `--json` emits `{readAt, machines[], runs[]}`: every machine with `state`, `version`, `lastSeenAt`, `detail`, `repos`, `machineLine`, `problems`, and the flattened run list (`machine`, `repo`, `key`, `source`, `belt`, `step`, `phase`, `ageSeconds`, `prNumber`, `problems`). Script against this, not the table.
- Exit code is 0 for an unreachable machine — that is data. `--timeout` with a non-number exits 1.

---

## 7. `run` vs `serve` vs `start`

- **`run` — the foreground first-run path.** In-process, never talks to the server, but takes the same per-repo tick lock, so it cooperates with a resident server instead of double-ticking (it prints `note: a resident server is already running (pid N) — this run cooperates via the tick lock and streams its progress.`). Header, then one line per new event: `  HH:MM:SS  <TICKET>  <label> — <extra>`, seeded from the current max event id so history isn't replayed. Labels are human ("`▶ step started`", "`✓ step done`", "`↩ bounced back`", "`⏸ asked a human`", "`⚠ needs attention`", "`✓ merged`"). A failed pass prints `  ⚠ reconcile pass failed — <msg>` to stderr and keeps looping. Its belt header **omits** `beltType` (unlike `status`) — don't reuse one parser for both.
- **Plain `run` exits when idle**, evaluated right after a pass when nothing occupies a slot:
  ```
  nothing in flight — no eligible work to claim and no runs active.
  Next: feed the source (label a ticket / drop a *.md brief), then re-run — or `herdr-factory start` to keep the factory watching in the background.
  ```
  or, with runs left behind, `local work drained. Remaining:` and a bulleted count of runs waiting on PR review, parked, and in flight. **`attention`, `waiting_for_human`, and idle `reviewing` runs hold no slot**, so `run` exits while they sit unfinished — by design. `--follow` keeps streaming until Ctrl-C instead.
- **`serve`** is the resident multi-repo daemon: it ticks *every* configured repo and exposes the HTTP API. Run it directly only to watch its log or to debug; normally the supervisor owns it.
- **`start`** reloads the supervisor job and brings the server up — and **installs the job first if it is absent** (`src/watchers/launchd.ts` / `systemd.ts`: `start()` falls through to `install()` when the plist/timer file is missing), so `start` on a fresh machine does bring the supervisor up. `stop` unloads the job and stops the server; **already-running worker agents keep running**.
- **`install` vs `start`.** Both end with a loaded job and a live server. `install` additionally **re-bakes the service environment** (`PATH`, `HOME`, `HERDR_CHANNEL`, `HERDR_FACTORY_AUTO_UPDATE`, `HERDR_FACTORY_TELEMETRY`, `OTEL_*` — see §8), **rewrites `<configDir>/config.schema.json`**, boots out any legacy per-repo `com.herdr-factory.<repo>` job (launchd only) and runs `loginctl enable-linger` (systemd only). `start` reuses the plist/unit exactly as it stands. So: `install` after changing any baked-in env var or upgrading; `start` to bring back a machine you `stop`ped. Either way, run one of them as soon as you want work to progress without a terminal open — PR watching, human replies, and ledger retries all need a ticking engine.

Sequence for a first repo: `init` → `doctor --repo <r> --deep` → `run --follow` (watch one item end-to-end) → `install` (hand it to the background). Installing/updating/uninstalling the factory itself: [install-and-operate.md](./install-and-operate.md).

---

## 8. Environment variables

| var | effect | default |
|---|---|---|
| `HERDR_FACTORY_CONFIG_DIR` | config root: `repos/<name>/{config.yml,env,prompts/}` + `config.schema.json` | `~/.config/herdr-factory` |
| `HERDR_FACTORY_STATE_ROOT` | state root: `herdr-factory.db`, `server.json`, `update-status.json`, `fleet-last-seen.json`, `fleet-ssh/` (unless too long for a Unix socket — see `fleet`), `node-path`, `runtime/`, `logs/`, `<repo>/logs/` | `~/.local/state/herdr-factory` |
| `HERDR_FACTORY_PORT` | server TCP port on 127.0.0.1 | `8765` |
| `HERDR_BIN_PATH` | path to the `herdr` binary | `herdr` (on PATH) |
| `HERDR_FACTORY_FLEET_ENDPOINTS` | path to a JSON file of `{"<machine name>": "http://host:port"}`; a named machine is dialled at that URL instead of being forwarded over SSH (a host whose server is off 8765 — and the seam the e2e suite uses in place of real SSH). Absent/unreadable file = no overrides | unset |
| `HERDR_FACTORY_AUTO_UPDATE` | `0`/`false`/`no`/`off` disables the supervised self-update; **anything else, including unset, enables it** | enabled |
| `HERDR_CHANNEL` | exactly `stable` (case-insensitive) → newest release tag; anything else → branch upstream | `main` |
| `HERDR_FACTORY_TELEMETRY` | `1|true|yes|on` enables OTel traces + metrics | off |
| `OTEL_SDK_DISABLED` | truthy hard-disables telemetry even with `HERDR_FACTORY_TELEMETRY=1` | unset |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | base; `/v1/traces` and `/v1/metrics` appended | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `..._METRICS_ENDPOINT` | per-signal override, used verbatim | — |
| `OTEL_SERVICE_NAME` · `OTEL_METRIC_EXPORT_INTERVAL` · `OTEL_RESOURCE_ATTRIBUTES` | service name · export interval in ms · resource attrs | `herdr-factory` · `10000` · — |
| `HERDR_FROM_INSTALLER` | set ⇒ `install` suppresses its onboarding pointer line | unset |
| `HERDR_FACTORY_LAYOUT_STATE_DIR` | overrides the layout-hook idempotency dir (claims, the decided cache, setup status files) | `<stateRoot>/layout-hook` |
| `HERDR_FACTORY_FOCUS_HOOK` | `0` drops the `workspace.focused` layout trigger entirely — for a herdr build whose in-app worktree creation does emit `worktree.created` (see [layouts.md](./layouts.md)) | enabled |
| `HERDR_FACTORY_TUI_TIMING` | `1` appends startup timings — plus the resolved `theme`/`theme_source` — to `/tmp/herdr-factory-tui-startup.log` | unset |
| `HERDR_FACTORY_THEME` | TUI palette: a herdr theme name, or `dark`/`light`. Overrides herdr's `[theme] name` (see [install-and-operate.md](./install-and-operate.md#theming-the-tui-follows-herdr)) | follows herdr, else `light` |
| `OPENTUI_LIBC` | auto-set to `musl` when musl is detected | unset |
| `HERDR_PLUGIN_EVENT_JSON` · `HERDR_PLUGIN_EVENT` | the layout hook's only input (herdr sets these) | — |
| `HERDR_SOCKET_PATH` | where the factory finds herdr's socket for `layout.apply` (herdr injects it into every plugin command); falls back to `$XDG_CONFIG_HOME/herdr[/sessions/$HERDR_SESSION]/herdr.sock` | injected by herdr |

**The propagation trap.** Two different allowlists exist, and they don't match:

- The **installed launchd/systemd service** bakes only `PATH`, `HOME`, `HERDR_CHANNEL`, `HERDR_FACTORY_AUTO_UPDATE`, `HERDR_FACTORY_TELEMETRY` and `OTEL_*` into the plist/unit — **at install time**. Exporting `HERDR_CHANNEL` or `HERDR_FACTORY_AUTO_UPDATE` in a shell does nothing to the running service; you must re-run `herdr-factory install` with the new value exported.
- `HERDR_FACTORY_CONFIG_DIR`, `HERDR_FACTORY_STATE_ROOT`, `HERDR_FACTORY_PORT` and `HERDR_BIN_PATH` are **not** baked in at all. A shell override of the config dir makes your CLI and the service disagree about which repos exist — which is exactly what `repo "<r>" not configured (server knows: …)` is telling you. (They *are* forwarded when the supervisor spawns `serve` from your shell, which is why the mismatch can hide until a service-launched restart.)

Install-time shell knobs, read by `install.sh` only and never by the CLI: `HERDR_APP_DIR` (default `~/.local/share/herdr-factory`), `HERDR_BIN_DIR` (default `~/.local/bin`), `HERDR_REPO_URL`, `HERDR_PNPM_VERSION` (default `11`), `HERDR_SKIP_SERVICE`. What the installer does with them: [install-and-operate.md](./install-and-operate.md).

---

## 9. Things the README doesn't mention

1. `watch` exists, marked `[legacy/dev]` — one repo, resident, all output on stderr. The server replaces it.
2. `capture-attempt` and `set-branch` are real commands with prompt tokens.
3. `telemetry-smoke` and the `layout-hook` launcher arg.
4. `evidence-upload` **never** routes through the server (the README's routed-signal list implies it does; the source is explicit that it doesn't).
5. `update` is channel-aware (README says "hard reset to the branch's upstream"; only true off `stable`).
6. `--repo` is accepted after the subcommand as well as before.
7. `claim`/`teardown` print success text even when nothing happened.
8. `explain <KEY>` is the CLI rendering of `obligations`; the RAW obligations JSON and the intent-ledger rows/nudges remain HTTP only (§10).

---

## 10. The local HTTP API

Base URL `http://127.0.0.1:<HERDR_FACTORY_PORT|8765>`. OpenAPI document at **`/doc`**, Swagger UI at **`/ui`** — both generated from the mounted routes, so they are always accurate for the running engine.

| route | use |
|---|---|
| `GET /health` | `{ok, version, pid, startedAt, uptimeSec, repos:[{name, active, lastTickAt, tickStale}]}` — the fastest "is the server alive and are its tick loops fresh" check |
| `GET /repos/{repo}/obligations?key=<KEY>[&source=]` | **"why is this run waiting and what would move it"**: the run's phase/step/attention reason, pending transitions, pending evidence uploads, pending signal, human question state, ledger rows, plus the armed guards/engine watches with their rescue and facts |
| `GET /repos/{repo}/intents?kind=&status=&key=` | the durable intent ledger rows behind a stuck handoff |
| `POST /repos/{repo}/intents/{id}/retry` · `/fulfil` · `POST /repos/{repo}/intents/recover` | operator nudges on a wedged ledger row |
| `POST /repos/{repo}/retry-now` (body `{}` or `{"key","source"}`) | the bulk form: clear every suspended pending row (attempts reset) and make every waiting one due now, in the repo (or one run's) + a Phase-0 flush under the tick lock. Answers `{ok, requeued, unsuspended, flushed}` |
| `GET /repos/{repo}/status` · `/runs` · `/eligible` · `/timeline?key=` | the JSON forms of the read commands (the TUI's surface) |
| `POST /repos/{repo}/belt-apply` · `POST /shutdown` | apply a belt change · graceful stop |
| `GET /evidence/*` | what the `local` evidence publisher serves |

Prefer `obligations` over log archaeology when diagnosing one run: it is the engine's own answer to "what is this run owed and what is watching it". `--repo <r> explain <KEY>` prints the same view as a narrative (§6) — reach for the raw JSON when you need the exact facts (clock epochs, intent ids to `retry`/`fulfil`, guard fact keys) rather than the story. Example:

```sh
curl -s "127.0.0.1:8765/repos/reckon-frontend/obligations?key=RWR-18374"
```

Symptom-first playbooks that combine these reads are in [troubleshooting.md](./troubleshooting.md); what the phases and watches mean is in [architecture.md](./architecture.md).
