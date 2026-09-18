# The fake `herdr` lane

`./herdr` is a drop-in stand-in for the herdr CLI; `./state.ts` (`FakeHerdr`) is the scenario-facing
control + query surface over its state, and over the argv log the shim appends on **every**
invocation. Selected with `lane: "fake"` on a scenario.

The `real` lane (a headless `herdr server` per world — `../herdr.ts`) proves the herdr contract. Two
things it cannot do, which is the whole reason this one exists:

1. **Failure injection.** You cannot ask a real herdr to make `agent list` fail, or to make a pane
   vanish while its agent lives. Those drive load-bearing engine paths: `HerdrUnreachableError` must
   **defer** rather than park a healthy run, and a respawn requires **two confirmed absences ≥45 s
   apart** (`PANE_ABSENCE_CONFIRM_SECONDS`).
2. **Scale.** The perf scenarios want 60–100 concurrent runs. In the real lane that is 60–100 PTYs,
   agent processes and a herdr server; here it is 60–100 detached child processes and one JSON file.

`FakeHerdr`'s public methods are **identical** to `HerdrServer`'s — same names, same signatures, same
return shapes (the `Agent`/`Pane`/`Tab`/`Workspace`/`HerdrCall` types are imported from `../herdr.ts`,
not re-declared). A scenario must not care which lane it is on; `w.herdr.agents()` reads the same
either way. Everything beyond that surface is injection.

## What stays REAL

Three things are not faked, because the engine depends on them being true:

| | why |
|---|---|
| `worktree create` runs a real `git worktree add` (and `worktree remove` really removes + deregisters) | the worker heartbeat and the read-only watch run `git rev-parse HEAD` in the checkout; `materialize` writes `.memory/herdr-factory/` into it; teardown asserts the branch and dir are reaped |
| `agent start` / `pane run` launch the configured executable as a **detached child** with the pane's cwd + env | liveness must be a process that can really die (and really outlive a park); no terminal — that is the point of this lane |
| `agent prompt` writes the text to that process's **stdin** | the scripted agent reads lines from stdin, and the whole agent-CLI contract rides on the prompt arriving verbatim |

## Wiring

```
HERDR_BIN_PATH=<world>/bin/herdr    # a copy of ./herdr — FakeHerdr.install(binDir) puts it there
HF_HERDR_LOG=<art>/herdr-calls.jsonl   # the {ts,argv} JSONL log (same shape the real lane's wrapper writes)
HF_AGENT_STATE_DIR=<world>/agent-state # REQUIRED: where agent_status is read from (see below)
```

Everything else defaults off `HOME` (the world root), so no new env is needed:

| path | default | holds |
|---|---|---|
| `HF_HERDR_STATE` | `<HOME>/herdr-fake-state.json` | workspaces, tabs, panes, agent pids |
| `HF_HERDR_INJECT` | `<HOME>/herdr-fake-inject.json` | the injection knobs (written by `FakeHerdr`) |
| `HF_HERDR_WORKTREES` | `<HOME>/worktrees` | `worktree create`'s checkouts (`<root>/<repo>/<branch-slug>`) |
| `HF_HERDR_RUNTIME` | `<HOME>/.herdr-fake` | per-pane stdin FIFOs and captured output |

Two things a world must **not** do on this lane:

- **Do not set `HF_HERDR_REAL` to a real herdr.** The scripted agent resolves its own herdr as
  `HF_HERDR_REAL || HERDR_BIN_PATH || herdr` (`../agent/agent.cjs`), so a stale value points the agent
  at a herdr that knows nothing about its pane. Leave it unset (or point it at the shim).
- **Do not declare `layouts`** in a fake-lane scenario's config — see the blind spots below.

`FakeHerdr.start()` boots nothing: it creates the directories, writes a blank state file and clears
the injection file (so a reused world root cannot leak the previous scenario's panes or knobs).
`stop()` reaps every process this lane launched — they are **detached**, so nothing else would.

```ts
const herdr = new FakeHerdr({ bin, env, logPath, callLog });   // same opts as HerdrServer
await herdr.start();
// … the engine claims work, spawns agents, ticks …
herdr.unreachable = true;                 // `agent list` now fails → HerdrUnreachableError
herdr.hideAgent(paneId);                  // pane reports absent while its process lives
herdr.killAgent(paneId);                  // genuinely kill it — nothing is lying
herdr.failSubcommand("agent start");      // adoption fails
herdr.stallPrompt(paneId);                // the submission is dropped
herdr.latency(700, ["agent list"]);       // slow herdr, scoped
herdr.resetInjection();
await herdr.stop();
```

## Served argv

Every shape `src/clients/herdr.ts` issues, answered with the exact envelope its parsers read. The
**subcommand** column is the classification the injection knobs and the log key on: the first two argv
tokens.

| subcommand | argv | answer |
|---|---|---|
| `worktree create` | `--cwd R --branch B --base REF --no-focus --json` | real `git worktree add [-b] …`, then `{result:{workspace:{workspace_id,worktree:{checkout_path,repo_root,repo_name,is_linked_worktree,branch}},root_pane:{pane_id,workspace_id,tab_id,cwd}}}`. Idempotent for a branch that already has a workspace. Refuses a **linked** worktree as `--cwd` (herdr's rule: main checkout only) |
| `worktree open` | `--cwd R --branch B --no-focus --json` | same shape; requires the branch to exist, adopts an already-registered checkout |
| `worktree remove` | `--workspace W --force --json` | kills the workspace's processes, `git worktree remove --force` + `rm -rf` + `git worktree prune`, drops the workspace. Unknown id ⇒ exit 1 |
| `worktree list` | `[--workspace W] --json` | `{result:{worktrees:[{path,branch,open_workspace_id}]}}` — read from `git worktree list --porcelain`, cross-referenced with our workspaces |
| `workspace get` | `W` | `{result:{workspace:{…,active_tab_id,tab_count,pane_count,worktree:{…}}}}`. **Unknown ⇒ exit 1** (this is how the engine verifies a removal) |
| `workspace list` | | `{result:{workspaces:[…]}}` |
| `workspace close` | `W` | kills its processes, drops the workspace, **leaves the git worktree** |
| `tab create` | `--workspace W --no-focus [--label L] [--cwd C] [--env K=V]…` | `{result:{tab:{tab_id,…},root_pane:{pane_id,workspace_id,tab_id,cwd}}}`. The root pane inherits the tab's label (what `tabPaneByLabel` resolves by) and the `--env` pairs |
| `tab rename` | `T L` | relabels |
| `tab list` | `[--workspace W]` | `{result:{tabs:[{tab_id,workspace_id,label,pane_count}]}}` |
| `pane list` | `[--workspace W]` | `{result:{panes:[{pane_id,tab_id,workspace_id,label,cwd,focused,agent_status,title,revision}]}}` |
| `pane layout` | `--pane P` | `{result:{layout:{tab_id,area:{width:177,height:48},panes:[{pane_id,rect}]}}}` — a fixed tab area (there is no terminal to measure) |
| `pane process-info` | `--pane P` | `{result:{process_info:{shell_pid,foreground_process_group_id,foreground_processes:[{pid,command}]}}}`. With no live child the pane's synthetic shell owns the foreground ⇒ `isAtShellPrompt` is **true**; with one, the child does ⇒ **false** |
| `pane run` | `P "<command>"` | launches `/bin/sh -c <command>` in the pane (FIFO stdin). A recognised harness — the pane's `HERDR_AGENT` hint, else a known kind as argv[0] — is registered as an **agent**, mirroring herdr's auto-detection of a typed harness; anything else is just a running command. A pane that already has a live process ⇒ exit 1 `pane_busy` |
| `pane close` | `P` | kills the pane's process, drops the pane |
| `pane read` | `P --source recent --lines N --format text` | the tail of the pane's captured stdout+stderr (raw text for `--format text`, else JSON) |
| `pane report-metadata` | `P --source S --seq N [--display-agent A] [--title T\|--clear-title] [--token k=v]… [--clear-token k]…` | stored on the pane; an older `--seq` loses to a newer one. Assertions read the **argv log** (`paneMetadata()`) |
| `agent list` | | `{result:{agents:[{pane_id,workspace_id,tab_id,agent,name,agent_status,interactive_ready,cwd,agent_session:{value},revision}]}}` — one entry per pane with a **live** process, `agent_status` read from the agent's own status file. `revision` is herdr's terminal-content counter (here: the size of the pane's captured output), which is how the engine confirms a prompt landed on a harness whose status never flips |
| `agent start` | `NAME --kind K --pane P --timeout MS [-- ARGS…]` | PATH-resolves `K`, launches it with `ARGS` in the pane, then **blocks** until the agent reports a status (the adoption handshake) or the timeout. Refuses: `invalid_agent_name` (herdr's `[a-z][a-z0-9_-]{0,31}`), `agent_name_in_use`, `agent_pane_not_found`, `agent_pane_busy` (incl. a pane whose env carries `HERDR_AGENT` — verified herdr behaviour, see `../../README.md` #3), `unknown_agent_kind`, `agent_exited`, `agent_start_timeout` |
| `agent prompt` | `TARGET "<text>" [--wait --until S… --timeout MS]` | delivers one line to the agent's stdin (`TARGET` = pane id or agent name). With `--wait`, blocks until the status file **changes** into one of the `--until` states, else exit 1 `agent_prompt_stalled` (no `--until` ⇒ herdr's default `idle`/`done`/`blocked`) |
| `agent focus` | `P` | focus bookkeeping (`pane list`'s `focused`, the workspace's `active_tab_id`) |
| `agent read` | `TARGET [--lines N] [--format text]` | like `pane read`; served for completeness — the engine never calls it |
| `notification show` | `TITLE --body B --sound request` | `{result:{shown:false,reason:"disabled"}}` — the same degradation the real lane shows in a container. `notifications()` asserts through the argv log |
| `plugin link` \| `plugin list` \| `plugin log` | | success, and **nothing happens** (see the blind spots) |
| `--version` / `version` | | `herdr 0.7.5 (herdr-factory e2e fake)` — clears `doctor`'s 0.7.5 floor |
| `status server` | | `version:`/`protocol: 17`/`compatible: yes` lines — what `doctor --deep` parses |
| `server stop` | | no-op success |
| `server` | | **exit 2**: this lane has no server; a scenario trying to boot one is a wiring bug |

Three deliberately different failure modes:

- **Unknown argv ⇒ exit 2** with `herdr-fake: unsupported argv: [...]`. Never a bland success: a new
  engine call this fake does not implement must break the scenario that needs it, not silently pass as
  "worked". (The gh fake does the opposite for the opposite reason — a model agent's stray `gh` call
  must not fail a run, whereas every `herdr` call here is the engine's own.)
- **Recognised but unservable ⇒ exit 1** with a herdr-like machine-readable code first
  (`agent_pane_busy: …`), which is what the engine logs as `lastAgentError`.
- **Injected ⇒ exit 1** with `herdr-fake: HF_HERDR_FAIL injected a failure for "<subcommand>"`.

## `agent_status` comes from the agent, never from the fake

There is no terminal and no herdr detection here, so `agent_status` is read from
`$HF_AGENT_STATE_DIR/<paneId>.status` — a file the **agent itself** writes (`../agent/agent.cjs`'s
`setState`, which writes it alongside the OSC title the real lane's detection reads). Values:
`working` / `idle`. Anything else the file says is passed through verbatim; an unwritten file reads as
`unknown`.

That keeps `working` — the state that vetoes the budget and stall watchdogs and freezes the read-only
baseline — honest: the fake cannot invent it. It also means `HF_AGENT_STATE_DIR` is **required**;
`agent start` fails fast rather than blocking out its whole adoption timeout without it.

A pane whose agent **process has exited** is absent from `agent list` (so `paneState` answers `gone`)
and reports `agent_status: "gone"` in `pane list` — no injection involved.

The `--wait --until` handshake requires a state **change**, not merely a matching value: a settle wait
(`--until idle --until done`) is asked of an agent that is *already* idle, and answering instantly
would report a submission landed that the agent never reacted to. herdr's own failure is exactly "no
state change followed the submission", so a turn that bails without moving is reported
`agent_prompt_stalled`.

## Failure injection

Knobs live in the injection **file** (`FakeHerdr` writes it) so a scenario can flip one mid-run: the
resident `serve` was started with a fixed environment and would never see an env change. Each also has
an **env** form, useful only as static scenario setup via `ScenarioSpec.processEnv`. A key present in
the file wins over its env fallback.

| `FakeHerdr` | file key | env | effect |
|---|---|---|---|
| `unreachable = true` | `fail: ["agent list"]` | `HF_HERDR_FAIL=agent list` | `agent list` exits 1 ⇒ the client throws `HerdrUnreachableError`. Every liveness caller must DEFER (never park a healthy run, never respawn) |
| `failSubcommand(sub, on?)` | `fail: [sub…]` | `HF_HERDR_FAIL=<sub>[,…]`\|`*` | any subcommand fails — `"agent start"` (adoption fails ⇒ the pane it created is closed and the claim retries), `"worktree create"`, `"pane report-metadata"`, … |
| `hideAgent(id)` / `showAgent(id)` | `hiddenPanes: [id…]` | `HF_HERDR_HIDE_PANES=<id>[,…]`\|`*` | the pane is omitted from `agent list` and reports `gone` in `pane list` **while its process keeps running** — the dead-pane/respawn path. Hold it across the ≥45 s confirmation window to make the engine respawn. The hidden agent's **name** is freed too, so the respawn's `agent start` is not refused for a collision (and the original process really is still there — the duplicate-agent hazard, faithfully) |
| `killAgent(id)` | — | — | actually SIGTERM/SIGKILL the process group. Nothing is lying: the pane is absent because the agent is dead |
| `stallPrompt(id, on?)` | `promptStall: [id…]` | `HF_HERDR_PROMPT_STALL=<id>[,…]`\|`*` | `agent prompt` exits 1 `agent_prompt_stalled` and the text is **not** delivered — a dropped submission. The pane produces no output either, so its `revision` does not move and the engine's progress probe agrees: the dispatch must be treated as not having happened rather than start a budget clock |
| `latency(ms, subs?)` | `sleepMs`, `sleep` | `HF_HERDR_SLEEP_MS`, `HF_HERDR_SLEEP` | sleep before answering (all subcommands, or the listed ones). Proves the engine's 60 s `DEFAULT_EXEC_TIMEOUT_MS` kills the child instead of wedging the tick |
| `resetInjection()` | — | — | clears the file (env fallbacks still apply) |

The argv line is logged **before** any injected failure or sleep, so a call the engine kills at its
exec timeout is still visible to the suite.

## The argv log

One JSONL line per invocation, appended to `$HF_HERDR_LOG` — **exactly** the real lane's wrapper shape,
`{ts, argv}` and nothing else, so `calls()` / `notifications()` / `paneMetadata()` and every call-budget
assertion work unchanged across lanes.

`calls()` is "every herdr invocation the **factory** made", so a call made from inside a **pane** is not
logged: `launch()` marks every pane's environment with `HF_HERDR_FAKE_PANE=1` and the shim skips the log
line when it sees it. Without that, the scripted agent's own boot-dwell `herdr agent list` would land in
the log here but not in the real lane (where the agent invokes `HF_HERDR_REAL` directly, bypassing the
recording wrapper), and the same scenario would count differently per lane. Set
`HF_HERDR_LOG_PANES=1` to record them anyway when debugging what an agent asked herdr. (The marker is
our own rather than `HERDR_PANE_ID`, which a developer running the suite from inside a real herdr pane
already has in their environment — that would have silently emptied the log.)

Beyond the shared surface, `FakeHerdr` also exposes `state()` (the raw state file), `agentPid(paneId)`
and `agentPids()` — enough to assert that a process really did (or didn't) outlive a park, a respawn or
a teardown.

## What this lane CANNOT cover

- **Layouts. Do not declare `layouts` in a fake-lane scenario.** Two independent reasons:
  `layout.apply` is a herdr **socket** call, not a CLI one (`src/clients/herdr-socket.ts` — herdr
  exposes it on its API only), and there is no socket here; and the per-belt layout is built by a
  herdr **plugin hook** (`worktree.created`), which needs a herdr host to fire it. `plugin link`
  answers success and registers nothing, so a belt whose steps target `tab`/`pane` labels would wait
  for panes that never appear and park `layout_wait_timeout`. Layouts belong to the real lane
  (`layouts`, `layout-setup-on-agent-pane`).
- **Anything about real terminal / PTY behaviour.** No shell, no rc-file sourcing window, no screen
  rendering. `pane read` returns the agent's captured stdout+stderr, not a terminal screen; a fresh
  pane is at its "shell prompt" immediately, where a real one is not; `pane layout`'s area is a fixed
  177×48. Regressions in the real shell/adoption sequencing (the `HAND_BACK = exec $SHELL -i` bug, the
  `exec -a claude` argv[0] detection fact, `pane report-agent` stealing agent authority) can only be
  caught in the real lane.
- **herdr's own agent detection.** `agent_status` is whatever the agent writes to its status file, so
  this lane proves the engine's *reaction* to a status, never that herdr would have observed it. The
  `⠋`/`✳` OSC-title manifests that make real detection work are exercised only in the real lane.
- **Focus semantics.** `agent focus` is bookkeeping — there is no frontmost application, so nothing
  can contradict it, and `focusedPane()` only ever sees what we recorded.
- **Notifications.** `notification show` always answers `{shown:false,reason:"disabled"}`; assert
  through the argv log (`notifications()`), which is what the real lane does in a container anyway.
- **Multi-pane tabs.** Every tab here is one pane (only `layout.apply` splits, and that is socket-only)
  — a scenario cannot exercise pane resolution *within* a tab.

## Implementation notes

- `./herdr` is **plain JavaScript** with a shebang and no extension: node cannot strip types from an
  extensionless file. It uses neither `require` nor top-level `await` (only dynamic `import()`), so it
  behaves the same whether node decides the file is CommonJS or ESM. Node builtins only.
- **Agent stdin is a FIFO** per pane, and the launcher is
  `sh -c 'exec 3<> "$1"; shift; exec "$@" <&3'`. Opening the FIFO **read-write** makes the shell its
  own writer, so the reader never sees EOF when a one-shot `agent prompt` writer closes — without that
  the scripted agent would exit ("stdin closed") after its first prompt. Both `exec`s mean the recorded
  pid **is** the agent's pid, with no wrapper process in between, which is what makes `killAgent()` and
  every liveness answer refer to the real thing. Writes are `O_NONBLOCK`, so a pane whose reader is
  gone fails `ENXIO` instead of blocking the tick.
- Launched processes are **detached** (their own process group), which is why they survive the shim
  invocation that started them — and why they are killed by *group* signal, and why `FakeHerdr.stop()`
  must reap them.
- Panes carry the ambient `HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID` a real pane has (the
  scripted agent reads `HERDR_PANE_ID` to know which status file is its own), plus the pane's own
  `--env` pairs, over the shim's environment — which stands in for "panes inherit the herdr server's
  environment" in the real lane.
- State is one JSON file, read fresh on every invocation, with read-modify-write behind a coarse
  `mkdir` lock next to it. Holds are ~1 ms (parse + rewrite a small JSON); slow work — `git`, launching
  a process, the adoption/prompt waits — stays **outside** the lock. Ids are `w<N>` / `w<N>:t<M>` /
  `w<N>:p<M>`, allocated under the lock so two concurrent shims can never hand out the same pane.
- **`git worktree add` is serialized per repo** (its own `mkdir` lock, taken *outside* the state lock)
  and each attempt re-decides how to add. git's worktree bookkeeping is not concurrency-safe: with 30
  parallel adds and no lock, two thirds failed, because a contended `worktree add -b <branch>` still
  **creates the branch** before dying — after which every retry died on `a branch named <branch>
  already exists`, and a half-created directory made git refuse the target as well. So each attempt
  re-reads whether the branch and the checkout already exist (and clears a partial directory) instead
  of trusting the plan it started with, and a create that loses the race for the lock answers the
  workspace the winner registered rather than making a second one over the same checkout.
- Measured on this shim (macOS, one repo): 60 concurrent `worktree create` in ~4.3 s, 60 concurrent
  `agent start` (each blocking on its own adoption handshake) in ~1.5 s, 60 concurrent
  `agent prompt --wait` in ~0.25 s, 60 concurrent `worktree remove` in ~1.1 s.
