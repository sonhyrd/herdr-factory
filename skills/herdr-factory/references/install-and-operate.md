# Installing and operating the factory itself

Everything about the herdr-factory **installation** — what the installer does and doesn't provide, how
it fails, how it updates itself, how it is removed, the launchd/systemd service behind it, and the TUI
that drives it.

**Answers these questions:**

- I ran `install.sh` and it finished — why is nothing working yet? What do *I* still have to install?
- Why does a layout pane's agent never report idle, when `doctor` says every tool is present?
- Which `HERDR_*` variables does the installer read, and how do I install from a private repo?
- Is re-running the installer safe — and what does it destroy?
- `install.sh` died on a fresh box: what does each `error:` line mean and what fixes it?
- How does auto-update actually work, why did exporting `HERDR_CHANNEL` change nothing, and where is the last attempt recorded?
- `herdr-factory uninstall` didn't uninstall much — what is the *real* uninstall, and what survives it?
- Where is the launchd job / systemd unit, how do I inspect it, and why can't the service find a tool my shell finds?
- How do I run the factory on several machines from one fork and one config?
- How do I drive the TUI, and how do I rename a belt that has live runs?

---

## 1. Prerequisites the installer does NOT provide

`install.sh` bootstraps only what the factory **itself** needs: its own vendored Node (pinned by
`.node-version`), pnpm, `pnpm install`, the two launcher shims, the herdr plugin link, and the
supervisor service. Everything the factory **drives** is yours to install and authenticate — this is
`install.sh`'s `you_provide_checklist` and the `you provide (install + auth)` group in `src/doctor.ts`.

| You provide | Why the factory needs it | Where to get it | Checked by |
|---|---|---|---|
| **`herdr` ≥ 0.7.5** | worktrees, workspaces, tabs/panes, agent lifecycle — the entire execution substrate | **https://herdr.dev** (`herdr update` to upgrade). **Nothing in this skill bundle and nothing in `install.sh` installs it** | `doctor` → `herdr`, which runs `herdr --version` and enforces the **0.7.5 floor** read from `herdr-plugin.toml`'s `min_herdr_version` (`v<x> is too old — the factory needs >= 0.7.5 (run \`herdr update\`)`); `--deep` → `herdr (daemon responds)`, which additionally checks `herdr status server`'s `compatible:` line and runs `herdr workspace list`, reporting `v0.7.5, protocol 17` |
| **An agent CLI** | the thing that does the work in each pane: `claude` · `opencode` · `codex` · `pi` · … (a pane's `command` defaults to `claude`) | the vendor | `doctor` checks **`claude` unconditionally**, even when your panes run `opencode`/`codex` — a ✗ there is cosmetic for a non-claude setup, and a ✓ proves nothing about the harness you actually configured. **`cursor-agent` is the exception**: with `--repo`, and only when that repo's config actually starts a Cursor agent, `doctor` checks it on PATH and `--deep` runs `cursor-agent status` (`cursor-agent (signed in)`) |
| **`cursor-agent`, signed in** | every step whose pane runs a Cursor agent | Cursor. Sign in with **`cursor-agent login` on that host** — it opens a browser and blocks, so it can never be fixed unattended, which is exactly why `doctor` names it | `doctor --repo <r>` → `cursor-agent`; `--deep` → `cursor-agent (signed in)` (a missing binary ✗s as "not on PATH", not as a login problem) + `cursor models` (every `--model` id in that repo's config must still be in `cursor-agent models` — a rejected id makes cursor-agent print its model list and exit). `not configured` when no belt runs a Cursor agent |
| **The agent skills your prompts name** | the prompts delegate the real work to skills (`pr-review`, `pw-prove`, `to-spec`, …); a missing one doesn't fail — the agent just improvises | install/link them under the engine's own root: `~/.cursor/skills/<name>/SKILL.md` for Cursor steps, `~/.claude/skills/<name>/SKILL.md` for Claude ones | `doctor --repo <r> --deep` → `agent skills`, which reads the names out of the **loaded prompts** and stats each one. `none named by the prompts` when there are none |
| **`ocr`** | `pr-review`'s third review track shells out to it; **nothing in `install.sh` installs it** | its vendor | `doctor --repo <r>` → `ocr`, only when a prompt names the `pr-review` skill |
| **`gh`, authenticated** | PR discovery, CI/review polling, `github_issues` writes | `gh auth login` after install | `doctor` → `gh` (presence); `--deep` → `gh (authenticated)`, which runs `gh auth status` |
| **`git`** | branch cleanup, heartbeats, base refs | usually already present | `doctor` → `git` |

### The check `doctor` does not make: `herdr integration install <agent>`

**This is a separate, per-machine step and the single most common "everything looks fine but nothing
progresses" cause.** herdr only knows whether a pane's agent is `working` or `idle` if that harness's
integration hook is installed; the hooks live in `$HOME` (e.g. `~/.claude/hooks/herdr-agent-state.sh`),
so they are **machine-wide, not per-repo, and not per-checkout**. Without the hook the pane's
`agent_status` is `gone` forever — a layout-targeted step waits its entire budget, retries, and parks
`layout_wait_timeout`. `herdr-factory doctor` checks **none** of this.

```sh
herdr integration status          # every supported harness + current | outdated (vN < vM) | not installed
herdr integration install claude  # (or opencode | codex | pi | …) — once per machine, per harness
```

`current (vN)` is the only healthy state; `outdated` means herdr shipped a newer hook — re-run
`install`. Pane targeting and the rest of the layout contract are in [layouts.md](./layouts.md); the
full target-repo checklist is in [target-repo.md](./target-repo.md).

---

## 2. Installing

```sh
curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh | sh
```

POSIX `sh` — it runs under dash, busybox ash and bash, so `| sh` works on every supported target
(macOS + Linux, x64 + arm64, glibc + musl). In order it: detects OS/arch/libc → optionally seeds a
deploy key + ssh config → clones or updates the checkout → downloads and SHA-256-verifies the pinned
official Node into `<state>/runtime/<ver>` and points `runtime/current` at it → installs pnpm and runs
`pnpm install` → links the shims → links the herdr plugin → installs the supervisor service → prints the
you-provide checklist and runs `herdr-factory doctor`.

**Tools it requires up front** (`require_tools`): `git`, `curl`, `tar`, and **either** `shasum` **or**
`sha256sum`. Anything missing aborts before it touches the disk:

```
error: missing required tool(s): git curl. Install them and re-run (macOS: xcode-select --install; Debian: apt-get install git curl tar; Alpine: apk add git curl tar).
```

### Environment variables `install.sh` honours

| var | default | effect |
|---|---|---|
| `HERDR_REPO_URL` | `https://github.com/razajamil/herdr-factory.git` | what to clone. An `ssh://`/`git@host:` URL is the private-repo path |
| `HERDR_BRANCH` | `main` | branch to clone and **hard-reset to** on every re-run |
| `HERDR_APP_DIR` | `~/.local/share/herdr-factory` | the code checkout (also what auto-update resets) |
| `HERDR_BIN_DIR` | `~/.local/bin` | where the `herdr-factory` / `herdr-factory-tui` symlinks are dropped |
| `HERDR_FACTORY_STATE_ROOT` | `~/.local/state/herdr-factory` | `runtime/`, `node-path`, the DB, `server.json`, `update-status.json`, `fleet-last-seen.json`, `fleet-ssh/` (only when that path fits a Unix socket's 104 bytes — else `/tmp/hf-<uid>/`), `logs/` |
| `HERDR_PNPM_VERSION` | `11` | `npm install -g pnpm@<v>` via the vendored Node, only when `runtime/current/bin/pnpm` is absent |
| `HERDR_DEPLOY_KEY` | — | literal key **content** or a path to a key file; seeds `~/.ssh/herdr-factory_deploy` (`chmod 600`) |
| `HERDR_SSH_HOST` | — | real hostname behind the repo URL's `Host` alias, written as `HostName` in the ssh block |
| `HERDR_SKIP_SERVICE` | — | any non-empty value ⇒ `skipping service install (HERDR_SKIP_SERVICE set)`; nothing schedules `ensure-up`, so the factory only runs when you run it |

**Captured into the service environment at install time** (because `install.sh` ends with
`HERDR_FROM_INSTALLER=1 herdr-factory install`, which bakes its own process env into the plist/unit —
`PASSTHROUGH_ENV` in `src/watchers/launchd.ts` / `src/watchers/systemd.ts`): `HERDR_CHANNEL`,
`HERDR_FACTORY_AUTO_UPDATE`, `HERDR_FACTORY_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_SERVICE_NAME`,
`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_SDK_DISABLED` — plus `PATH` and `HOME`.
`HERDR_FACTORY_CONFIG_DIR`, `HERDR_FACTORY_STATE_ROOT`, `HERDR_FACTORY_PORT` and `HERDR_BIN_PATH` are
**not** baked in (see [cli.md](./cli.md) §8 for what that mismatch looks like).

**Pipe trap.** `VAR=x curl … | sh` exports `VAR` to *curl*, not to the shell running the script. Put the
assignment on the right of the pipe, or export it first:

```sh
curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh | HERDR_CHANNEL=stable sh
export HERDR_DEPLOY_KEY=~/.ssh/id_factory HERDR_SSH_HOST=github.com HERDR_REPO_URL=git@github.com:acme/herdr-factory.git
curl -fsSL … | sh
```

**The private-repo path.** With `HERDR_DEPLOY_KEY` set, the installer writes the key to
`~/.ssh/herdr-factory_deploy` (0600), parses the host out of `HERDR_REPO_URL`, and appends an ssh block —
`Host <host>` / `HostName <HERDR_SSH_HOST>` / `User git` / `IdentityFile …` / `IdentitiesOnly yes` — to
`~/.ssh/config`, guarded by an exact-field match so re-runs don't duplicate it (`==> wrote ssh config
block for '<host>'`). An unparseable URL only warns: `warn: could not parse host from <url> — skipping
ssh config`.

**Idempotency — and what re-running destroys.** Re-running is the supported repair/upgrade path: it
re-verifies Node (skipping the download if `runtime/<ver>/bin/node` is already executable), always
re-runs `pnpm install`, re-links the shims, re-links the herdr plugin if it points elsewhere, and
re-installs the service (which is how you re-bake `PATH` and the passthrough env — §6). But
`sync_repo` on an existing checkout runs:

```sh
git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
```

**`--hard`, with no dirty-checkout guard** — unlike the supervised updater (§4), the installer silently
discards any local edit in `$APP_DIR`. Never keep work there. Note it always resets to
`origin/$HERDR_BRANCH` regardless of `HERDR_CHANNEL`; the channel only governs the *supervised* updater.

---

## 3. "install.sh failed" playbook

Every line below is `install.sh`'s own `die`/`warn` text. `error:` aborts; `warn:` continues.

| Symptom (verbatim) | Cause | Fix |
|---|---|---|
| `error: missing required tool(s): <list>. Install them and re-run (…)` | no `git`/`curl`/`tar`, or neither `shasum` nor `sha256sum` | macOS `xcode-select --install` · Debian `apt-get install git curl tar` · Alpine `apk add git curl tar` (coreutils/perl supplies the sha tool) |
| `error: unsupported OS: <uname -s> (macOS + Linux only; Windows is a separate installer)` | not Darwin/Linux | WSL, or the separate Windows installer |
| `error: unsupported arch: <uname -m> (x64 + arm64 only)` | e.g. armv7 | unsupported — no vendored Node build exists |
| `error: git clone failed. If this is a private repo, provide a deploy key: HERDR_DEPLOY_KEY=~/key HERDR_SSH_HOST=<host> … and ensure the remote host is reachable.` | private repo with no key, wrong `HERDR_REPO_URL`, or no network | set `HERDR_DEPLOY_KEY` + `HERDR_SSH_HOST` (§2) and re-run; verify by hand with `git clone <url> /tmp/probe` |
| `error: .node-version must pin an exact x.y.z (got '<v>')` | a hand-edited `.node-version` in `$APP_DIR` | it's about to be hard-reset anyway — `git -C $APP_DIR checkout .node-version` and re-run |
| `error: download failed: <base>/<file>` | nodejs.org (or unofficial-builds.nodejs.org on musl) unreachable; proxy | `curl -fSL <base>/<file> -o /dev/null` to confirm, then fix egress/proxy |
| `error: no SHASUMS256 entry for <file> at <sums_url>` | the pinned version has no build for this OS/arch/libc combination (most often musl) | check the URL by hand; on musl the base is `https://unofficial-builds.nodejs.org/download/release/v<ver>` |
| `error: checksum mismatch for <file> (expected <e>, got <a>)` | truncated download or a tampering/MITM proxy | delete `<state>/runtime/.dl-*` (the EXIT trap normally does), re-run; if it repeats, distrust the network path |
| `error: extracted tarball has no bin/node` | corrupt archive | re-run |
| four indented loader lines, then `error: the vendored Node (<path>) could not start. Fix: install libatomic — Debian/Ubuntu: sudo apt-get install libatomic1 · Fedora/RHEL: sudo dnf install libatomic — then re-run install.sh.` | minimal glibc image (typically Debian/arm64) missing `libatomic` | install the named package, re-run |
| same, but `Fix: install the C++ runtime — Alpine: sudo apk add libstdc++ · Debian/Ubuntu: sudo apt-get install libstdc++6` | musl/Alpine base image missing `libgcc`/`libstdc++` | install the named package, re-run |
| same, but `Fix: install the missing system library shown above` | some other missing `.so` | read the indented loader output above the `error:` line — it names the library |
| The installer stops right after `==> installing dependencies (pnpm install)` with pnpm/npm output and **no `error:` line** | `install_deps` has no `die` wrapper — `set -e` aborts on pnpm's own exit code (network, registry auth, corrupt store) | reproduce it: `cd ~/.local/share/herdr-factory && ~/.local/state/herdr-factory/runtime/current/bin/pnpm install`, fix what it prints, then re-run `install.sh` |
| `warn: <BIN_DIR> is not on your PATH — add it: export PATH="<BIN_DIR>:$PATH"` | `~/.local/bin` not on PATH | add the export to your shell rc. Install **continues** (the epilogue uses the absolute path), but nothing later finds `herdr-factory` |
| `warn: the herdr-factory launchers need bash (not found) — install it (Alpine: sudo apk add bash).` | busybox-only box; the two shims are bash scripts | `apk add bash`. Install continues but the closing `doctor` run is **skipped**, and every `herdr-factory` invocation fails until bash exists |
| `warn: herdr not on PATH — skipping plugin link. Layouts won't auto-apply until you run: herdr plugin link '<APP_DIR>'` | herdr installed after the factory (the normal order for a fresh box) | install herdr, then `herdr plugin link ~/.local/share/herdr-factory` (or just re-run `install.sh`) — see [layouts.md](./layouts.md) |
| `warn: herdr plugin link failed — register it manually: herdr plugin link '<APP_DIR>'` | herdr rejected the link (id collision, daemon down) | run the command by hand and read its error |

The closing `doctor` run is deliberately `|| true`: **✗ rows on a fresh box are expected** — they are the
you-provide list from §1, not an install failure.

---

## 4. Updating

The factory keeps itself current; you normally do nothing.

| Piece | Behaviour |
|---|---|
| Cadence | the supervisor fires `ensure-up` every **~60 s** (launchd `StartInterval 60` / systemd `OnUnitActiveSec=60`). `ensure-up` runs the self-update **first**, then restarts the server if it's missing, unresponsive, on a different version, or has a stale tick loop (`src/watchers/supervisor.ts`) |
| `HERDR_FACTORY_AUTO_UPDATE` | `0`/`false`/`no`/`off` disables the self-update. **Anything else, including unset, enables it** |
| `HERDR_CHANNEL` | exactly `stable` (case-insensitive, trimmed) ⇒ hard-reset to the **newest release tag** matching `v?X.Y.Z`, compared numerically, pre-releases ignored. Anything else (incl. unset or a typo) ⇒ `main`: hard-reset to the branch upstream `@{u}` |
| What an update does | `git fetch` → `git reset --hard <target>` → if `.node-version` changed, re-provision the vendored Node and flip `runtime/current` → if `package.json`/`pnpm-lock.yaml`/`.node-version` changed, `pnpm install` (falling back to `npm install`) → `ensure-up` restarts `serve` onto the new sha |
| Dirty-checkout refusal | a checkout with **any** staged/unstaged/untracked change is never reset. The tick logs `self-update: dirty checkout — reset to <ref> skipped (uncommitted local changes)`, fires one throttled (6 h) herdr notification titled `herdr-factory: auto-update skipped`, and records the skip |
| Force it now | `herdr-factory update` → `no update: <reason>` or `updated <from12> → <to12>; restarting server` + `restart: noop\|started\|restarted`. Reasons: `not a git checkout` · `cannot read HEAD` · `up to date` · `dirty checkout` · `reset failed` · `no release tags yet (stable channel)` |
| Repo main checkouts | the same tick also fast-forwards each **loaded repo config's `repo.path`** (`src/watchers/checkouts.ts`), at most once per **10 min per repo**. It only ever runs `git fetch <remote>` + `git merge --ff-only <base_ref>`, and only when HEAD is on the branch `base_ref` names, no staged/unstaged change exists (untracked files are fine) and the history is a pure fast-forward. Otherwise it logs once per state change — `checkout-sync: <repo>: on <branch>, skipped (base branch is <base>)` · `dirty tree, skipped` · `diverged, skipped` — and moves on. It never stashes, resets, checks out or rebases, one repo's failure never affects another, and `~/.config/herdr-factory` is never touched (that one you roll out by hand) |
| Where the outcome lives | `<stateRoot>/update-status.json` (`{channel, at, outcome: updated\|up_to_date\|skipped\|failed, reason, head, target, targetRef, behind, dirtySkip, warning}`) — `src/watchers/update-status.ts` |

**Both toggles are captured into the service environment at INSTALL time.** Exporting `HERDR_CHANNEL`
or `HERDR_FACTORY_AUTO_UPDATE` in your shell changes nothing about the resident service — the plist/unit
holds the values that were in the environment when `herdr-factory install` last ran. To change either:

```sh
HERDR_CHANNEL=stable herdr-factory install    # rewrites the plist/unit with the new value, reloads it
```

**Where you see it.** `doctor`'s `auto-update` check and the TUI's top-right status text both read
`update-status.json` (via `updateWarning()` in `src/watchers/update-status.ts`), so they always agree.
The check is amber `⚠`, never a ✗ — it cannot fail `doctor`'s exit code:

| doctor line | Meaning |
|---|---|
| `✓ auto-update — main: up to date on origin/main (3m ago)` | healthy |
| `✓ auto-update — stable: updated (a1b2… → c3d4… (v0.4.1)) (12m ago)` | landed a release |
| `⚠ auto-update — main: reset to origin/main skipped — checkout has uncommitted changes (2h ago)` | **the dirty guard**: `git -C ~/.local/share/herdr-factory status --porcelain`, then commit/stash/discard |
| `⚠ auto-update — main: last update FAILED — reset failed — <git msg> (5m ago)` | the reset itself failed |
| `⚠ auto-update — main: behind origin/main — <reason> (…)` | not on its channel target |
| `⚠ auto-update — main: updated but dependency install failed — <msg> (…)` | code landed, deps are stale — run `pnpm install` in `$APP_DIR` |
| `✓ auto-update — stable: follows the latest release tag (no update attempt recorded yet)` | fresh box, or auto-update disabled |

The main-checkout sweep has its own check, reading `<stateRoot>/checkout-sync.json`
(`{<repo>: {repo, path, at, outcome: fast_forwarded|up_to_date|skipped|failed, reason, head}}`,
`src/watchers/checkouts.ts`). Also amber-or-green, never a ✗ — a human working in a checkout is normal:

| doctor line | Meaning |
|---|---|
| `✓ main checkouts up to date — chrysus: up to date (2m ago) · widget: up to date (2m ago)` | healthy |
| `⚠ main checkouts up to date — widget: on sonhyrd/1540-thing, skipped (base branch is main) (4m ago)` | somebody left the checkout on a branch; nothing to do unless you want it back on `main` |
| `⚠ main checkouts up to date — chrysus: dirty tree, skipped (4m ago)` | uncommitted work in the main checkout — commit/stash it and the next sweep catches up |
| `⚠ main checkouts up to date — chrysus: diverged, skipped (4m ago)` | local commits that aren't on `origin/main` — resolve by hand |
| `✓ main checkouts up to date — no sync recorded yet …` | fresh box (the first sweep runs on the next `ensure-up` tick) |

The **skill bundle** rides along: `herdr-factory skill install` defaults to a *symlink* into
`~/.claude/skills/herdr-factory`, so an auto-update keeps the skill in lock-step with the engine. A
`--copy`/`--into <checkout>` installation does not.

---

## 5. Uninstalling

Two different things share the word, and only one of them is an uninstall.

| Command | What it does |
|---|---|
| `herdr-factory uninstall` | **service only.** Unloads + deletes the launchd job / systemd units, then stops the resident `serve` (`stopServer`). Prints `uninstalled <label>`. The code, the vendored Node, the shims, the DB and every config stay. **In-flight worker agents keep running** — they are herdr panes, not children of the server |
| `curl -fsSL https://raw.githubusercontent.com/razajamil/herdr-factory/main/install.sh \| sh -s -- --uninstall` | **the full removal.** `install.sh`'s `uninstall()` |

The full uninstall, in order (`install.sh` `uninstall()` — it deliberately skips `require_tools`, so it
works on a box that no longer has git/curl/tar):

1. `"$BIN_DIR/herdr-factory" uninstall` — the service + server stop above. A failure only warns:
   `warn: service uninstall reported an error`.
2. `herdr plugin unlink herdr-factory` (best-effort, only if `herdr` is on PATH) — stops the layout hook.
3. `rm -f "$BIN_DIR/herdr-factory" "$BIN_DIR/herdr-factory-tui"` — the shims.
4. `rm -rf "$STATE_ROOT/runtime"` — **the vendored Node and pnpm**.
5. `==> removed shims + vendored Node runtime.`

**Deliberately left behind**, with the exact lines it prints:

```
warn: left in place (contains your data): /Users/you/.local/share/herdr-factory (code) and /Users/you/.local/state/herdr-factory (DB, config).
warn: to remove them too: rm -rf '/Users/you/.local/share/herdr-factory' '/Users/you/.local/state/herdr-factory'
```

`$APP_DIR` is the checkout; `$STATE_ROOT` is `herdr-factory.db`, `logs/`, `server.json`,
`update-status.json`, `node-path` and the served `evidence/` tree. That second `rm -rf` therefore
**destroys all run history and every published local-evidence artifact** — a merged PR that links to
`/evidence/…` will 404 afterwards.

**Never touched by either command:**

| Survivor | Path | Remove by hand if you want it gone |
|---|---|---|
| Every repo config, prompt override, and secret | `~/.config/herdr-factory/` (`repos/<name>/{config.yml,env,prompts/}`, `config.schema.json`) | `rm -rf ~/.config/herdr-factory` — note `install.sh`'s warn text says "$STATE_ROOT (DB, config)", which is **wrong about config**: configs are here, not in the state root |
| The deploy key | `~/.ssh/herdr-factory_deploy` | `rm -f ~/.ssh/herdr-factory_deploy` |
| The ssh config block | the `# added by herdr-factory install.sh` stanza in `~/.ssh/config` | edit it out by hand |
| The installed skill | `~/.claude/skills/herdr-factory` (a symlink into `$APP_DIR` by default — it dangles once `$APP_DIR` is gone) | `rm ~/.claude/skills/herdr-factory` |
| Agent integrations | `~/.claude/hooks/herdr-agent-state.sh` etc. | `herdr integration uninstall <agent>` — they belong to herdr, not the factory |
| Worktrees, workspaces and branches from past runs | your repos | `herdr` owns them; tear runs down *before* uninstalling if you want them reaped |

---

## 6. The services

One repo-agnostic supervisor job per machine. It runs the one-shot `ensure-up`, which keeps the single
resident `serve` (serving **every** configured repo) alive; `serve` itself is not the supervised
process, which is why a wedged daemon can be restarted from outside. Platform dispatch is
`src/watchers/service.ts`; an unsupported platform throws
`no supervisor service for <platform> (macOS launchd / Linux systemd only)`.

| | macOS — `src/watchers/launchd.ts` | Linux — `src/watchers/systemd.ts` |
|---|---|---|
| Identity (`service.label()`) | `com.herdr-factory.server` | `herdr-factory.timer` |
| Files | `~/Library/LaunchAgents/com.herdr-factory.server.plist` | `~/.config/systemd/user/herdr-factory.service` **and** `herdr-factory.timer` |
| Cadence | `StartInterval 60` + `RunAtLoad`, `ProcessType Background` | `OnBootSec=30`, `OnUnitActiveSec=60`, `AccuracySec=15`, `Persistent=true` |
| Command | `<baked node> <APP_DIR>/src/cli/index.ts ensure-up` | same, via `ExecStart=`, `Type=oneshot`, `KillMode=process` (so the detached `serve` survives the oneshot exiting — [troubleshooting.md §2.15](./troubleshooting.md#215-linux-the-supervisor-starts-serve-every-tick-but-it-never-stays-up)) |
| Supervisor logs | `StandardOutPath`/`StandardErrorPath` → `<stateRoot>/logs/supervisor.{out,err}.log` | **the journal** — the unit declares no `StandardOutput=`: `journalctl --user -u herdr-factory.service`. (`<stateRoot>/logs/` is still created at install, but nothing writes `supervisor.*.log` there on Linux) |
| Inspect by hand | `launchctl list \| grep com.herdr-factory.server` (pid, last exit, label) | `systemctl --user status herdr-factory.timer` · `systemctl --user list-timers herdr-factory.timer` |
| `isLoaded` (what `doctor` reads) | label appears in `launchctl list` | `systemctl --user is-enabled herdr-factory.timer` == `enabled` |
| Extras at install | boots out any **legacy per-repo** `com.herdr-factory.<repo>` watch jobs and deletes their plists | `loginctl enable-linger <user>` (best-effort, so the timer runs headless), `daemon-reload`, `enable --now` |

What each command does (`src/cli/index.ts`; per-command output is in [cli.md](./cli.md) §3):

| command | launchd | systemd | also |
|---|---|---|---|
| `install` | write the plist → `bootout` → `bootstrap` | write both units → `enable-linger` → `daemon-reload` → `enable --now …timer` | **rewrites the plist/unit**, so this is the only command that re-bakes `PATH` + the passthrough env. Then runs `ensure-up` and rewrites `config.schema.json` |
| `start` | **installs it if the plist is absent**, else `bootout` + `bootstrap` | **installs it if the timer file is absent**, else `systemctl --user restart …timer` | then `ensure-up`. On an existing install it reloads the file as-is — it does **not** re-bake anything |
| `stop` | `bootout` (the plist file stays on disk) | `systemctl --user stop …timer` — **stops but does not disable**, so `is-enabled` still says `enabled` and the timer returns on next login/boot | then `stopServer` |
| `uninstall` | `bootout` + delete the plist | `disable --now …timer`, `stop …service`, delete both unit files, `daemon-reload` | then `stopServer` |

### The PATH-is-frozen-at-install-time trap

The plist/unit stores a literal snapshot of `process.env.PATH` from the shell that ran
`herdr-factory install` (`install.sh` prepends `<stateRoot>/runtime/current/bin` to it first). It is
never refreshed.

**Consequence:** a tool installed *after* that moment — the usual case for `herdr`, `gh`, or an agent CLI
on a fresh box, and for anything under a version manager whose shims land in a new directory — is
invisible to the resident `serve`, so steps fail with "command not found" behaviour while your terminal
runs the tool fine. And because `src/doctor.ts` deliberately resolves `git`/`herdr`/`gh`/`claude`
against `service.servicePath()` (the **baked** PATH) rather than your shell's, `doctor` reports `✗ herdr`
for a binary that is plainly on your PATH. That ✗ is correct: it is telling you where the work actually
happens.

**Fix:** re-run `herdr-factory install` from a shell whose PATH contains the tool (`start` will not do
it). Read the baked value back:

```sh
# macOS
plutil -extract EnvironmentVariables.PATH raw ~/Library/LaunchAgents/com.herdr-factory.server.plist
# Linux
grep '^Environment="PATH=' ~/.config/systemd/user/herdr-factory.service
```

### Several machines

One fork of the factory and one config, run on every host:

1. **Install from your fork on each host.** Keep `HERDR_CHANNEL` unset (`main`): the supervised
   updater hard-resets to the checkout's upstream, which is your fork's `origin` — a merge to your fork
   reaches every host within a tick.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/<you>/herdr-factory/main/install.sh \
     | HERDR_REPO_URL=https://github.com/<you>/herdr-factory.git sh
   ```

2. **Keep the config dir in a private git repo**, cloned to `~/.config/herdr-factory` on each host.
   Update a host with:

   ```sh
   git -C ~/.config/herdr-factory pull --ff-only && herdr-factory reload
   ```

3. **Never commit the per-repo `env` files** (credentials). Add `repos/*/env` to that repo's
   `.gitignore` and copy each `env` to each host by hand (`chmod 600`). Repo `path:`s must exist on
   every host.
4. **Hosts without systemd/launchd** (containers, some VPSes): install with `HERDR_SKIP_SERVICE=1`,
   then keep a supervisor loop running in a long-lived herdr pane:

   ```sh
   while :; do herdr-factory ensure-up; sleep 60; done
   ```

   That loop is the **only** thing running the auto-updater on such a host (each `ensure-up` updates
   first). The updater's git runs with no controlling terminal and `GIT_TERMINAL_PROMPT=0`, so an ssh
   host-key/passphrase or credential prompt fails the tick instead of blocking the loop, and every git
   call is killed after 120s (installs after 10min) — a hung fetch records `failed` and the next tick
   retries. If the loop dies, `doctor` shows `⚠ auto-update stalled — last check <age>` after 30min.

5. **Before a second host polls a tracker source, enable `claim_guard`** on that source in the shared
   config, or both hosts claim the same item — see
   [work-sources.md](./work-sources.md#several-factories-on-one-source-claim_guard). `local_markdown`
   and `sentry` have no claim ledger: serve those repos from one host only.
6. **Per-host capacity goes in `machine.yml`, not the shared config.** `repos/*/config.yml` is identical on
   every host, so its `limits` can't differ per machine. Create `~/.config/herdr-factory/machine.yml` on
   each host and add `machine.yml` to the config repo's `.gitignore`:

   ```yaml
   max_active_workspaces: 3   # worked runs across all repos on THIS host
   min_free_memory_mb: 4096   # stop claiming below this much available memory
   ```

   The same file carries the other host-shaped setting: `layout_hook.ignore_pane_labels` (default
   `[Sidebar]`) — the pane labels the layout hook discounts when deciding a workspace is fresh, so a
   herdr plugin that adds its own pane to every new tab on THIS host doesn't stop every layout from
   building (see [layouts.md](./layouts.md)).

   Then `herdr-factory reload`. Neither gate touches running work. `poll_interval_seconds` is shared
   config too, so it can't make one host slower than the others. To make a host (say a laptop) the
   **last resort**, give it a lower cap and a higher memory floor — e.g. `max_active_workspaces: 1`,
   `min_free_memory_mb: 12288` — or `max_active_workspaces: 0` to stop it claiming at all. See
   [config-reference.md](./config-reference.md#314-machineyml-host-local-optional--srcmachinets).

---

## 7. The TUI

```sh
herdr-factory            # zero arguments launches the TUI (NOT help)
herdr-factory-tui        # the same thing; takes no arguments
```

Rendered with opentui through native FFI — Node ≥ 26 plus `--experimental-ffi`, which the
`bin/herdr-factory-tui` shim adds (it also sets `OPENTUI_LIBC=musl` when musl is detected). It talks to
the resident server over the local HTTP API; with no server the Dashboard degrades to a repo list and
its actions no-op, while the Config editor still works fully (it edits files on disk).

**Three tabs** (`src/tui/index.ts`). The Dashboard is built eagerly; Config and Doctor are lazily
imported on first activation — you may see ` loading...` or ` failed to load: <message>` in a fresh tab.

| Tab | For | Notes |
|---|---|---|
| **Dashboard** | watch and drive live work: per machine → per repo → per belt → a **kanban board** of active runs and eligible items | auto-refreshes every 3 s; on a one-machine install the tab bar's top-right status text reads `● server up · v<version> · uptime <d>`, and with a [fleet](#the-dashboard-with-a-fleet) it reads `● fleet <reachable>/<total> machines · v<version> here`. Either form takes a ` · ⚠ <note>` tail in amber: the last auto-update wanting attention, plus (with a fleet) every remote that is `unverifiable (last seen <d>)` and every remote whose server is on **another version** than this machine's — a box the updater has not reached is otherwise invisible from here (`fleetStatusLine`, `src/tui/fleet-view.ts`). Only the Dashboard tab polls, so this text holds its last value while another tab is active. A repo with problems (runs parked for attention, suspended jobs, expired AWS SSO / source sessions, auth failures) **names** the first one in red after the active count — `⚠ <cause>` (the detail up to its ` — <hint>` half, truncated to 64 chars), plus `(+N more)` when it has several; highlighting the row prints the full problem details in red on the action line. A cause that **more than one of a host's repos reports identically** is said once for that machine (`⚠ <cause> — on several repos`) and left off those rows — one `gh auth` is one login — but the rows themselves stay, so `d` still reaches each repo's full detail (`sharedProblems`/`shortProblem`, `src/tui/fleet-view.ts`). It rides with the host gate, so it lands under the machine header on a fleet and above the repo rows on a one-machine install (`hostLines`). `/status.problems` is RECORDED state (the v37 problem ledger + derived parked/suspended entries): the engine records a problem when its own machinery observes it (the auth gate, a failed delivery, the evidence creds probe on its ~5-min tick cadence) and clears it on recovery — the dashboard never probes anything on load, so an expired AWS session lights the row without a failed upload and without opening the detail view. The host-local `machine.yml` gate (`cap <n>/<N> working across all repos · memory <free> MB available (floor <min> MB)`) is printed **once per machine** and never on a repo row: above the repo rows on a one-machine install, under the machine header with a [fleet](#the-dashboard-with-a-fleet) (`hostLines`, `src/tui/fleet-view.ts`). It is what answers "why has nothing been claimed?" when the cap is saturated or free memory is under the floor. Server down ⇒ the status text reads ``⚠ server not running — start it with `herdr-factory serve` `` and each repo becomes a `<repo>   (server down)` row |
| **Config** | the five-section config editor over `~/.config/herdr-factory/repos/<name>/config.yml` + its `env` file, with a `+ new repo…` wizard | edits a YAML `Document`, so comments and formatting survive |
| **Doctor** | the machine-wide health checks | see the caveat at the end of this section |

### Keybindings

Global (`src/tui/index.ts`):

| key | action |
|---|---|
| `Tab` / `Shift+Tab` | next / previous tab |
| `Esc` | pop to the top level (the tab bar) from any depth, including mid-edit |
| `←` / `→` | at the top level only: previous / next tab |
| `↵` | at the top level: dive into section 1 |
| `1`…`9` | jump straight to that numbered section of the active tab (works from anywhere except a focused text input) |
| `^S` | save — only the Config editor implements it |
| `q` | quit (not while a text input has focus) |
| `Ctrl-C` | quit |

#### The board

Each belt renders as a kanban board (`src/tui/kanban.ts`): a `ready` column of eligible-but-unclaimed
items, then one column per belt step, with every work item a card in the column of the step it is
currently on (a run past its last step — a PR watch — stays under that step). A card reads
`<icon> <KEY> <summary>` plus compact right-aligned meta (`#<pr>` and how long it has been in this
step); a trailing amber `⚠` means a stuck background job. Cards are the only thing colored, and only
on the icon — a card's key and summary always stay in the normal text hierarchy. A legend line in the
shell's bottom footer (right above the keybinding line) spells the common icons out, shown only while
the Dashboard tab is active:

| icon | state | means |
|---|---|---|
| `○` | ready | eligible at the source, nothing has claimed it |
| `◐` | starting | claiming (worktree/pane being set up) |
| `●` | working | a belt step's agent is live |
| `◆` | in review | `reviewing` — the token-free PR watch |
| `?` | waiting on you | `waiting_for_human` — parked on a question |
| `⚠` | attention | the engine's needs-a-human park (stalled / over budget / asked a human) |
| `✗` | failed | terminal `abandoned` / `timeout` / `closed` outcome |
| `✓` | done | the step is finished (`tearing_down` / `done`) |

The board is responsive: it fits as many columns side by side as 20 columns each allows and wraps the
rest onto further shelves, so a narrow terminal degrades to stacked lanes rather than truncating. A
resize re-lays it immediately. Runs whose belt no longer exists appear in one full-width
`unassigned (no belt)` lane. The highlighted card's ⚠ detail (attention reason / stuck upload) is
printed on the action line while it is highlighted.

**A belt holding one or two cards drops the grid** and renders one line per card instead —
`● 54  work  48m  nudge an idle agent…` (icon · key · step · age/PR · summary) — because five column
headers and a rule to say "one run, in work, 48m" is most of an 80×24 screen. The columns come back
as soon as a belt carries three or more (`compactBoard`, `src/tui/kanban.ts`). Selection, clicks and
every key work identically on both.

**"needs you" heads the board** (`needsYou`, `src/tui/fleet-view.ts`) — a short section *above* the
machine headers, reading the whole fleet and **never** narrowed by the `m` filter (a PR waiting on
another box is still waiting). In order: PRs that are green and waiting on a merge
(`✓ <KEY>  PR #<n> is green — ready to merge  (<repo> @<machine>)`, from `active[].prGreen`, which the
server reads off the `pr_green` watch state — no GitHub call on the 3 s poll) — or, when a code push
since the evidence is being re-verified, `↻ <KEY>  PR #<n> evidence stale since <sha> (head <sha>) —
re-running` (from `active[].evidenceStale`, the `evidence_head` watch state) — or, while a factory
review verdict on the PR is being fixed or self-checked, `↻ <KEY>  PR #<n>: fixing hf-review round 1
(5 findings)` / `self-check round 2 running` / `self-check round 2 clean` / `hf-review round 3 needs a
human`, and the idle-without-push lines (`… clean — the resolver pushed nothing …` / `… needs a human — the resolver pushed nothing …`) (from `active[].hfReview`, the `hf_review` watch state), runs parked for
attention (`⚠ <KEY>  parked — <reason>`), runs in `waiting_for_human` (`? <KEY>  waiting for a human
reply`), and machines that have gone silent (`✗ <machine> unverifiable — <why>`). **Empty ⇒ it is not
drawn at all.** Its run entries *are* the runs: `s`, `x`, `d` and `↵` act on them from there, so a
parked run never has to be hunted down a second time; a machine entry is not actionable.

**Idle repos collapse to one line per machine**: a repo with **no active run, no eligible work and no
problem** becomes a word in `  idle · <repo> · <repo>` under its host, because that row carries
exactly one fact and one line can carry it for all of them. A repo with **eligible-but-unclaimed
work** is not idle and keeps its row; a repo whose status failed to load is not idle either (it keeps
its row and its `(status unavailable)` line); and on an `unverifiable` machine the line reads
`  unverified · …`. `i` expands them all (`isIdleRepo`/`idleLine`, `src/tui/fleet-view.ts`).

Dashboard, on the highlighted card or row (`src/tui/dashboard.ts`) — every mutating action goes through
a confirm modal, and the result lands on the bottom action line:

| key | action | applies to |
|---|---|---|
| `↑` / `↓` | move the highlight, staying in the same column where one is available | all cards/rows |
| `←` / `→` | move to the card in the neighbouring column, on the same line | cards |
| `↵` | open the ticket's timeline | run cards |
| `d` | **repo** row → repo detail: a red `⚠ Problems` section first (the same entries as the row's red light), then AWS SSO / per-source auth / per-belt steps+health+eligible counts — every unhealthy line renders **red**, healthy ✓ lines green; **run** card → full work-item detail (overview + step progress + timeline) | repo, run |
| `t` | run one reconcile tick on that row's repo — `Run a reconcile tick on "<repo>"?` | any card/row |
| `c` | claim the item — picks the belt automatically when the source has exactly one, otherwise asks | `ready` cards |
| `s` | **resume / retry now**, routed on the highlighted card: a run parked for `attention` is **resumed** (`Resume "<key>" (un-park it and pick up where it left off)?` → `✓ resumed "<key>" → <phase>`); any other run, or a repo/ready row, gets the **bulk clear-and-retry** (`Clear "<scope>"'s suspended background jobs and retry them now (uploads, source write-backs)?` → `✓ "<scope>": N jobs due now (M suspensions cleared) — flushed`, or `— a tick is mid-pass`, or `"<scope>": no suspended or waiting jobs`). A run card scopes to that run; a repo row is repo-wide and clears every suspension the repo row flags in red | run, repo, ready |
| `x` | tear the run down — `Tear down "<key>" (removes its worktree)?` | run cards |
| `o` / `O` | open the run in a browser: `o` = its **PR**, falling back to the **work item** while there is no PR; `O` (shift-`o`) = always the work item (GitHub issue / Jira `browse/<KEY>` / Sentry issue). No web page for the source's items (`local_markdown`) ⇒ `<key>: no PR or work item URL — this source has no web page for it`. Opener: `$BROWSER` if set, else `open` (macOS) / `xdg-open`; over SSH with no display (`SSH_CONNECTION` and neither `DISPLAY` nor `WAYLAND_DISPLAY`) the URL is printed on the action line instead. A **remote** machine's run opens locally — the URLs are resolved by the machine that owns the run and ride on `/status`. Terminals that advertise OSC 8 also render the `#NN` refs and each card's work key as clickable links | run cards |
| `m` | filter the board to one machine, or back to all of them — a chooser over `all machines` + every machine in the [fleet](#the-dashboard-with-a-fleet). On a one-machine install it answers `this is the only machine in the fleet` and changes nothing | anywhere |
| `i` | expand the collapsed **idle** repos, or collapse them again (`showing every repo` / `idle repos collapsed`; while expanded the board's last line reads `(showing idle repos — press i to collapse them)`) | anywhere |
| `r` | refresh now | anywhere |

With a fleet, every confirmation above also names the machine it would land on (`Tear down "<key>" on
<machine> …?`), and so does its result — see [below](#the-dashboard-with-a-fleet).

Config editor (`src/tui/config-editor.ts`). Sections: `[1] Repos (this machine)` (a left-hand list —
config lives on each host, so this tab is always about the machine you are on) and an accordion of
`[2] Config` · `[3] Work sources` · `[4] Layouts` · `[5] Belts`, of which exactly one is expanded.

| key | action |
|---|---|
| `1`…`5` | focus that section (expands it, collapses the others) |
| `↑` / `↓` | move between rows |
| `↵` | open a group · edit a text field · cycle an enum/reference · run an action row (`+ add …`, `‹ remove … ›`) |
| `space` | toggle a bool, cycle an enum, expand/collapse a group |
| `←` / `→` | cycle an enum/reference value backwards/forwards, or collapse/expand the highlighted group |
| `[` / `]`, or `Shift+↑` / `Shift+↓` | **reorder** the highlighted group within its array (a source, layout, belt, tab, pane or step) |
| while editing a text field | `↑`/`↓` hop to the previous/next field, `↵` moves to the next field, `Esc` pops to the tab bar |
| `^S` | save |

#### The Dashboard with a fleet

The Dashboard reads the same fleet `herdr-factory fleet` does — this machine plus every **enabled**
entry of `herdr machine list` (see [cli.md](./cli.md)) — and its keys act on the machine that owns the
run. There is nothing to configure, and **nothing changes on a one-machine install**: with a single
machine the board renders exactly as it always has, headers and badges and all of the below absent
(`fleetMode()` in `src/tui/dashboard.ts` gates every bit of it on there being more than one machine).

Once there IS another machine:

- **A header per machine**, above its repos: `✓ <machine> (<ssh target | this machine>) — v<version> ·
  N running`, then `    N repos · read <d> ago`, then the host-local `machine.yml` gate (cap occupancy
  across all repos, free memory) on its own line when the host sets one. The lines are deliberately
  short — a herdr pane is routinely ~50 columns, and a fact that falls off the right edge is not
  reported.
  A problem several of the host's repos share is named here too, one line each
  (`    ⚠ <cause> — on several repos`).
- **A `@<machine>` badge** on every repo row (`<repo>  @<machine>   active N/M`), so a row still says
  where it is once you have scrolled past its header. The host gate is deliberately **not** repeated
  on the row: cap occupancy and the memory floor are host-wide by definition and the header prints
  them once (`hostLines`, `src/tui/fleet-view.ts` — the same two lines a ONE-machine board prints
  above its repo rows, since it has no header to hang them under).
- **`m` filters** the board to one machine or back to all. A filter naming a machine that has left the
  fleet falls back to all — an empty board would read as "no work".
- **A machine that stops answering is `unverifiable`, not empty.** Its header becomes
  `✗ <machine> (<target>) — unverifiable` / `    last seen <d> ago · NOT known to be gone` /
  `    <why>`, and it **keeps the rows of its last successful read** — as plain
  `<KEY>   <belt>/<step>   unverifiable` lines rather than cards, because a card carries a live state
  icon and a ticking age that this read cannot vouch for. Blanking them would say the runs are gone
  when they are merely unobservable, which is the reading an operator acts on. Keys on those rows are
  refused up front (`✗ <machine> is unverifiable — it cannot be acted on until it answers again`).
  Its collapsed repos read `  unverified · <repo> · <repo>`, never `idle`: those rows are a remembered
  read, and "idle" would be a claim about now.
  The machines that *are* answering carry on untouched; one silent box costs its own rows, not the view.
- **Every action is routed**, through that run's own machine client and no other (`route()` in
  `src/tui/dashboard.ts`, `clientFor` in `src/tui/fleet-view.ts`) — tick, claim, teardown,
  resume/retry-now, and the read-only timeline and detail views too. Two machines can be working an
  item with the **same key**, so the confirmation names the machine (`Tear down "<key>" on <machine>
  (removes its worktree)?`) and so does the result (`✓ torn down "<key>" on <machine>`).
- A machine header row is not itself actionable: `a machine header is not actionable — pick one of its
  repos or cards`.

The Doctor tab reports each remote's own `/health` too (below). The **Config** tab stays local by
design: config lives on each host, and editing another machine's from here would be a write across a
link the factory deliberately does not have.

If herdr cannot be asked for its machine list (not installed, no server, an older CLI), the fleet is
this machine alone and the action line says why, once.

Modals: confirm (`y` / `↵` = yes, `n` / `Esc` = no) · chooser (`↑↓` + `↵`, `Esc` cancels) · prompt (`↵`
submit, `Esc` cancel) · multiline editor, e.g. `guidelines-prompt.md` (`^S` save, `Esc` cancel) ·
scrollable info panes such as a timeline (`↑↓`/wheel scroll, `Esc` or `q` close). Clicking the backdrop
dismisses any of them.

**It is fully mouse-navigable.** Click a tab to switch; click a row — or a single kanban card, resolved
from the click's column — to select it (click an already-highlighted run again to open its timeline);
click a panel to focus its section; click a chooser option or a `[y] yes` / `[n] no` to answer a modal;
the wheel scrolls any scroll box. Rows tint on hover (on the board, just the card under the pointer)
and the pointer switches to an I-beam over text inputs.

**What `^S` does** (`save()` in `src/tui/config-editor.ts`): flush every panel's typed values → write any
changed credentials to the repo's `env` file → validate the whole document with the zod schema (on
failure: up to six `  ✗ <dotted.path>: <message>` rows and `✗ N validation error(s) — not saved`, and
nothing is written) → write `config.yml` → diff the belts (below) → `POST /reload` (silent when no
server is running; `✗ saved, but repo "<name>" failed to load: <error>` when the server rejects it).
The save runs the **schema only** — it does not load the config, so `prompt_file` existence and the
prompt contract are not checked before the file lands (see [prompts.md](./prompts.md)).

### Renaming or deleting a belt (the one operation with no CLI)

A run records its belt **name** at claim time and never updates it, and **nothing outside this save path
infers a rename** — every other route sees the old name simply disappear. Hand-editing `config.yml`
therefore gives you one of three bad outcomes, depending on how the change is picked up (`src/server/serve.ts`):

| Route | What happens to a hand-renamed belt |
|---|---|
| `herdr-factory reload`, belt has in-flight work | the reload is **refused for that repo** and the repo's tick timer is **stopped** until a good reload: `  ⚠ <repo>: not reloaded: belt "<b>" (N in progress) still has work — rename via the TUI (it migrates the runs) or tear the work down first` (server log: `repo "<n>": reload refused — belt "<b>" (N in progress) still has work`) |
| `herdr-factory reload`, belt idle | treated as **delete + add**: the old belt's run rows are purged (the events timeline is kept) and its history disappears under the new name |
| No server / next cold `serve` start | no diff is computed at all — the in-flight runs' `runs.belt` no longer resolves and each parks for `attention` with reason `belt_missing` |

The TUI save path is the supported route because it is the only one that migrates the runs.

**To rename:**

1. **Config** tab → `[1]` → highlight the repo → `↵` (the editor jumps into `[2]`).
2. `[5]` → highlight the belt group → `↵` to expand → highlight `name` → `↵` → type the new name → `↓`/`Esc` to leave the field.
3. `^S` — it fires even with the field still focused (the global handler intercepts `^S` before the input sees it). **Change nothing else in that save.**

Step 3's caveat is load-bearing. `diffBelts` (`src/core/belt-admin.ts`) infers a rename **only when it is
unambiguous**: exactly one belt name disappeared, exactly one appeared, and the two belt bodies are
identical in every field except `name` (compared as sorted-key JSON, so YAML key order doesn't matter).
A rename bundled with any other edit to that belt — or two renames in one save — degrades to
**delete + add**, which purges the old belt's history and is blocked outright if it has live work.
Rename alone, save, then make your other edits.

**To delete:** expand the belt → run the `‹ remove belt ›` action → confirm
`Remove belt "<name>"? On save its finished-run data is purged (blocked if work is in progress).` → `^S`.

**What the save actually does** — `applyBeltChangesForRepo` (`src/belt-apply.ts`) posts to the running
server, which applies the change **atomically under the repo tick lock and reloads its Deps**; with no
server it does the same work in-process under that lock. `applyBeltChanges` is **guard-first and
all-or-nothing**:

| Outcome | Engine behaviour | Status line |
|---|---|---|
| Rename | `runs.belt` is rewritten for **every** run of that belt, active **and** historical, so the dashboard, timeline and history stay coherent; records a `belt_reassigned` event | `✓ saved · N run(s) migrated · server reloaded` (a belt with no runs at all: `✓ saved · belts updated · server reloaded`) |
| Delete, belt idle | reaps any leaked worktree of its ended runs, purges its run rows + child rows, **keeps the events timeline**; records `belt_deleted` | `✓ saved · N run(s) purged · M worktree(s) cleaned · server reloaded` |
| Delete, belt still has work | **nothing is applied at all** — no rename migrates either — and the editor **rewrites `config.yml` back to its previous contents** while keeping your draft in memory, so you can tear the work down and re-save | `✗ not saved — belt "<b>" (N in progress) still has work; tear it down or let it finish first` |
| Server reload failed afterwards | the DB change stuck; the old Deps keep running | `✗ saved, but reload failed: <error>` |

**HTTP equivalent** (there is **no** CLI command): `POST /repos/{repo}/belt-apply` with
`{"renames":[{"from":"old","to":"new"}],"deletes":["gone"]}`, returning
`{runsMoved, runsPurged, worktreesCleaned, blocked:[{belt,activeRuns}], ok, failures:[]}`. It only
touches the DB and worktrees — **you must have written the new `config.yml` yourself first**, and you
must revert that file yourself if `blocked` comes back non-empty.

### The Doctor tab is not `doctor --deep`

`src/tui/doctor.ts` calls `baseGroups()`: the machine-wide groups only — *managed by
herdr-factory* (`node runtime >= 26`, `auto-update`, `main checkouts up to date`, `supervisor service`, `server`, `database`) and
*you provide* (`git`, `herdr`, `gh`, `claude`). `r` re-runs the shallow checks; `d` runs the deep ones
(`gh auth status`, `herdr workspace list`). The banner reads
`● all checks passed (shallow) · r: re-run · d: deep` or
`⚠ N check(s) failing (deep) · M warning(s) · …`.

The only thing it adds beyond this machine is an `Other machines in the fleet:` group — one row per
**remote** machine, built from that machine's own `/health` (`fleetHealthLines()` in
`src/tui/fleet-view.ts`), because a remote running an older build, or not answering at all, is
invisible from this machine's checks. A remote that cannot be reached is a `✗` row and **counts
toward the banner's failure total**. The group is absent on a one-machine install, and a fleet that
cannot be listed never fails the local checks.

It **never runs the repo group** — config validity, source buildability, per-source auth and health,
required secrets, the evidence publisher and the evidence-upload backlog are all invisible here (for
this machine *and* for every remote: a remote's row is its `/health` summary, not its repos' health).
A green Doctor tab proves nothing about a repo. Run:

```sh
herdr-factory --repo <name> doctor --deep
```

Every check and its remediation is in [troubleshooting.md](./troubleshooting.md).

It does carry one row the CLI has no equivalent for — the TUI's own, under a `This TUI:` group:
`✓   theme — <name> (following herdr's config | from HERDR_FACTORY_THEME | default — herdr names no
theme)`, amber with ` · unknown theme "<x>" — rendering the <y> palette` appended when the resolver
fell back. It counts as a warning in the banner, never a failure.

### Theming (the TUI follows herdr)

`src/tui/theme.ts` is the only place in `src/tui` that names a color, and it picks its palette at
launch:

1. `HERDR_FACTORY_THEME` — a herdr theme name, or `dark`/`light`. Wins over everything.
2. `[theme] name` in herdr's own config: `$XDG_CONFIG_HOME/herdr/config.toml`, else
   `~/.config/herdr/config.toml`. Read (not stat'd), so a symlinked config resolves. `[theme.custom]`
   and any later table end the section, so only the real `name` counts.
3. Nothing → `light`, the palette the TUI shipped with. An install that never themed herdr sees no
   change at all.

A palette ships for every herdr built-in (`catppuccin`, `terminal`, `tokyo-night`, `dracula`, `nord`,
`gruvbox`, `one-dark`, `solarized`, `kanagawa`, `rose-pine`, `vesper`) and for the light variants
`light_name` points at (`catppuccin-latte`, `tokyo-night-day`, `gruvbox-light`, `one-light`,
`solarized-light`, `kanagawa-lotus`, `rose-pine-dawn`). All of them carry the same role names, so
every `theme.*` token exists whichever palette won, and text roles hold WCAG-AA contrast against the
background (measured in `test/tui-theme.test.ts`).

A name this build doesn't know never crashes the TUI. It resolves to the nearest palette available:
the family whose name it extends (`kanagawa-dragon` → kanagawa), else `light` or `dark` as the name
suggests (`-light`/`-day`/`-dawn`/`-latte`/`-lotus` vs `-dark`/`night`/`mocha`/…), else `light`.

Two caveats worth saying out loud:

- The theme is resolved **once, at start**. Changing herdr's theme takes effect on the TUI's next
  launch — there is no live reload.
- herdr's `auto_switch` / `dark_name` / `light_name` are **not** followed. The factory can't read the
  host terminal's light/dark appearance, so it follows `name` only; with `auto_switch = true` and no
  `name`, the TUI stays light. Use `HERDR_FACTORY_THEME` to pin it.
