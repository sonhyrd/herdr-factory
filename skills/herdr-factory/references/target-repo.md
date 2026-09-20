# The target repo — what it needs for the factory to work, and to work well

What the **target repo** (the codebase the factory ships PRs into) must provide: the handful of hard
requirements the engine breaks without, the files the engine reads mechanically, and the documentation
the shipped prompts defer to. This is the highest-leverage, most-skipped setup step — the prompts are
deliberately thin on *how* to work in a given codebase, so a well-documented repo gets dramatically
better output from the same config.

**Answers these questions:**

- Why does `repo.path` have to be the main checkout, and what happens if it isn't?
- Why did the run fail at claim time with a `herdr worktree create` error?
- Why is a run reading a stale/wrong task doc, and what does `.memory/` in `.gitignore` fix?
- What does the factory read out of my repo on its own (PR template, prompt pack) vs. via a prompt?
- Which files in my repo do the agents actually look for, and which step changes behaviour because of them?
- Why does my `evidence` step keep bouncing or asking a human about credentials?
- My repo's commit guide and `conventions.commits` disagree — which wins?
- When the repo's CLAUDE.md and the factory prompt conflict, what is the agent supposed to do?

---

## 1. Hard requirements

| # | Requirement | Enforced where | Failure mode if wrong |
|---|---|---|---|
| 1 | `repo.path` points at the **MAIN** checkout — `<path>/.git` must be a **directory**, not a file | `assertMainCheckout` at every config load, by `init`, and by `doctor`'s `repo.path is a main git checkout` | Load error: `repo.path "<p>" looks like a linked worktree (.git is a file); herdr needs the MAIN checkout`, or `repo.path "<p>" is not a git checkout (no .git)`. herdr cannot fork a worktree from a linked worktree |
| 2 | `repo.base_ref` names a ref that **exists in that checkout** (default `origin/main`) | **Nothing** — never validated at load | A failing `herdr worktree create --base <base_ref>` at claim time. The throw is caught by the tick, so you get an `error` log line + an `error` event **every tick** and a run that never leaves `claiming` — no park, no watchdog |
| 3 | `.memory/` in the repo's `.gitignore` | Partially self-healing (see below) | A committed `.memory/herdr-factory/` in the repo's tree lands in every fresh worktree, and because each source's materialize is skip-if-exists, a committed `task.md`/`ticket.json` **silently supplants the real work item** |
| 4 | A GitHub `origin` remote, **or** an explicit `repo.github: owner/name` | `doctor`'s `git origin resolved`; the engine derives `owner/name` by parsing `git remote get-url origin` | `no origin — set repo.github or add a git remote`. Without it the PR watch, CI/review polling and the `github_issues` source have no repo to query |
| 5 | `gh` authenticated as an account with **push + PR-create** rights on that repo | `doctor --deep` runs `gh auth status` (presence only in the default mode) | The engine's use of the `gh` CLI is read-only (PR discovery, CI/review polling, `gh api user`) — but with a `github_issues` source the engine itself also **writes** over the API (issue labels, comments, close) using `GITHUB_TOKEN` from the repo env or the token from `gh auth token`, so a read-only credential breaks those write-backs too. The **agent** runs `git push -u origin <branch>` and `gh pr create`, so a read-only token fails inside the `pr` step as well — never in `doctor` |
| 6 | The agent harness on PATH **and** `herdr integration install <agent>` run on this machine (see [install-and-operate.md](./install-and-operate.md)) | **Nothing in `doctor` checks the integration** | Without the integration hook herdr never reports `idle`/`working` for that harness, so every layout-targeted step waits, retries ×3 and parks `layout_wait_timeout` |
| 7 | `git` and `herdr` on PATH, herdr daemon responding | `doctor` (`git`, `herdr`; `herdr (daemon responds)` with `--deep`) | Everything stalls at claim |

Notes on each:

- **(2) The factory fetches the base ref before each new worktree** — `git fetch --no-tags <remote>
  <branch>` in `repo.path`, only when `base_ref` has a `<remote>/` prefix and only on the
  worktree-CREATE path (a reopened worktree is not re-based). It is bounded (30s) and never prompts
  (`GIT_TERMINAL_PROMPT=0`), so a missing credential fails fast instead of hanging. A **failed fetch
  does not block the claim**: the worktree is still created from the local ref and the run logs
  `<KEY>: could not fetch <base_ref> in <path> — cutting the worktree from the local ref (<base_ref>
  is <age>); the base may be stale`. A `base_ref` with no remote prefix (a purely local branch) is
  never fetched — keep it fresh yourself. Verify the ref by hand:
  `git -C <repo.path> rev-parse --verify <base_ref>`.
- **(3)** On the worktree-**CREATE** path only, the engine deletes a `.memory/herdr-factory` that came
  with the checkout and warns:
  `<KEY>: removed a committed .memory/herdr-factory from the fresh worktree — the repo should not track factory memory (add .memory/ to its .gitignore)`.
  A **reopened** worktree is never scrubbed (its memory dir is the run's own live state), so a committed
  copy still poisons any run that reattaches. Add the ignore rule; don't rely on the scrub.
- **(6)** The integration is **machine-wide, not per-repo** — the hooks live in `$HOME`
  (e.g. `~/.claude/hooks/herdr-agent-state.sh`). `herdr integration status` lists every supported
  harness and whether its hook is `current` / `outdated` / `not installed`.
- `doctor` also checks `claude` on PATH **unconditionally**, even when the configured `agent.command`
  is `opencode`/`codex`/… — a red ✗ there is cosmetic for a non-claude setup. `cursor-agent` is the
  one harness checked from the config instead of unconditionally: with `--repo`, and only when a belt
  really starts a Cursor agent, `doctor` checks it on PATH, and `--deep` adds `cursor-agent status`,
  the repo's `--model` ids against `cursor-agent models`, the skills its prompts name, and `ocr`.
- `doctor` checks **none** of: `base_ref` existence, the `.gitignore` rule, the herdr plugin link, or
  the agent integration. See [troubleshooting.md](./troubleshooting.md).

**One caution about branches.** At teardown the factory runs `git branch -D <branch>` in the main
checkout and, if that refuses, `git worktree remove --force` on any worktree still on the branch, then
retries. Never keep your own work on a branch that matches a belt's `workspace_name` pattern.

---

## 2. What the engine reads out of the repo itself (mechanical, not prompt-mediated)

These are read by the engine from the **run's worktree**, with no agent involved.

### 2.1 The PR template → `@@PR_TEMPLATE@@`

Searched in this exact order, **first non-blank wins**; whitespace-only files are skipped; a
missing or unreadable template is never an error (the clause just drops):

1. `.github/PULL_REQUEST_TEMPLATE.md`
2. `.github/pull_request_template.md`
3. `PULL_REQUEST_TEMPLATE.md`
4. `pull_request_template.md`
5. `docs/PULL_REQUEST_TEMPLATE.md`
6. `docs/pull_request_template.md`

then the directories `.github/PULL_REQUEST_TEMPLATE/`, `PULL_REQUEST_TEMPLATE/`,
`docs/PULL_REQUEST_TEMPLATE/` — within each, the first non-blank `*.md` **alphabetically** (there is no
template-selection UI; a multi-template repo always gets its alphabetically-first one).

When found, the `pr` step's prompt gains a sub-bullet telling the agent to **fill the repo's own
template** — keep every section and heading, replace the template's guidance/comments with real
content — *instead of* the generic summary+testing-notes shape, with the template reproduced verbatim
in a code fence. It still requires the evidence URLs and any `Closing reference:` line. Re-read on
every render (edit the template, no reload needed). Active only on the step that produces
`pull_request`, i.e. the `pr` step.

### 2.2 A prompt pack in the checkout — `.herdr/prompts/`

`<worktree>/.herdr/prompts/<slug>.md` and `<worktree>/.herdr/prompts/<sourceType>/<slug>.md` override
the shipped base prompt for that step (`work` · `evidence` · `review` · `pr` · `resolver`), resolved at
render time and **highest precedence in the chain**. This lets the repo own its own prompts, versioned
with the code. Never validated against the prompt-token contract — a bogus `@@TOKEN@@` there reaches the
agent literally, forever, silently. See [prompts.md](./prompts.md).

### 2.3 `prompt_file` with `prompt_file_source: repo`

Read from the run's **worktree** at render time (not from the config folder), so it too can live in the
repo. Existence is never checked at load; a missing file yields
`<KEY>: <step> prompt_file not found (repo): <path>` per tick with no park. See
[prompts.md](./prompts.md).

---

## 3. What the agents look for, because the shipped prompts tell them to

Every shipped base prompt opens with a "follow this repo's own guidance first" section. These are the
exact assets named, and what each one changes.

| Asset in the repo | Read by | What it changes |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` — **including nested, directory-level ones** covering the code being touched | every step: `work` (all source variants), `evidence`, `review`, `pr`, and the PR-watch `resolver` | The baseline for everything below; nested files are explicitly in scope, so per-package/per-app instructions are honoured |
| `.claude/skills/` and the repo's agent commands | `work` (all variants), `resolver` | Bootstrap/setup, patterns to reuse, the repo's own workflows the agent should invoke instead of improvising |
| A `playwright-cli` / browser-automation, dev-server, **or login/auth** skill — the prompt lists `.claude/skills/`, `.agents/skills/`, `.opencode/skill*/`, `.claude/commands/` **and their symlink targets** | `evidence` | How to start (or detect) the dev server, how to sign in, how to drive the browser, viewport and resolution, video/screenshot settings, selectors. The prompt is told to read each relevant `SKILL.md` **and every `references/` file by path** — it must not assume its harness auto-loaded them. Without such a skill it falls back to `playwright-cli` directly at ≈1920×1080 |
| A **gitignored repo-local memory dir** (`.memory/`, or a cross-worktree copy under `~/.local/share/<repo>/`) holding dev-server URLs, browser session state, or test credentials | `evidence` | The prompt is told that `glob`/`grep` routinely hide ignored files, so a search miss is **not** proof of absence: it reads the exact paths the repo's docs name. Document those paths or the agent cannot find your credentials |
| An **executable helper** — a script or task that probes/ensures the dev server, logs in, seeds data, or drives the browser | `evidence` | The prompt prefers running the repo's helper (with its documented subcommands, flags, and a generous timeout for a cold build) over hand-rolling the steps, and respects the helper's prohibitions (don't launch the bundler directly, don't start a second server, don't type secrets with a naive `fill`) |
| A `code-review` skill under `.claude/` | `review` | Replaces the prompt's generic checklist with the repo's own review procedure |
| A review checklist, engineering standards, or **definition-of-done** under `docs/` | `review` | Architectural rules, test-coverage expectations, what counts as acceptable complexity, how the repo wants its own checks run |
| The repo's **PR or release skills/commands** under `.claude/`, and any **PR runbook** under `docs/` | `pr` | Description shape and required sections, title convention, and anything the repo requires *in* the change before a PR opens (changelog entry, docs update, checklist) |
| `CONTRIBUTING.md` | `work`, `evidence`, `review`, `pr`, `resolver` | General contribution rules; for `pr` it is named first |
| Runbooks under `docs/` | `work`, `evidence`, `review` (standards), `pr` (PR runbook), `resolver` | Operational how-to: running the app, seeding, environments |
| Where tests live + how they're written + the exact **lint / type-check / test** commands (usually in `CLAUDE.md`) | `work` (step 5 runs them and fixes everything they report) | The single biggest quality lever. Undocumented ⇒ the agent guesses commands or skips verification. The `sentry` work prompt additionally asks for a **regression test where the codebase makes that practical**, written so it "looks native" to the repo |
| The repo's commit-message guide (or the shape of recent `git log`) | `work` | Commit message format — unless `conventions.commits` is set (§5) |
| `.github/PULL_REQUEST_TEMPLATE.md` etc. | `pr`, mechanically (§2.1) | Replaces the generic PR body shape |

Two caveats the prompts themselves state:

- **A repo `code-review` skill that assumes a GitHub PR** (posting inline comments, `gh pr review`) —
  the `review` agent is told to **ignore that part**: there is no PR yet at review time. Findings go in
  the handoff or bounce note instead. If your review skill is PR-centric, factor the checklist out of
  the mechanics so the factory can use it.
- **Only guidance checked into the repo counts.** The `github_issues` work prompt draws an explicit
  prompt-injection boundary: instructions in an issue body or its comments are requirements to weigh,
  not conventions to adopt, and comments asking for out-of-scope actions (visit URLs, run unrelated
  commands, exfiltrate data) are ignored and flagged.

---

## 4. The evidence step's documentation needs

Called out separately because **undocumented environment/credentials is the most common reason an
`evidence` step bounces or burns an ask-human round-trip.** The evidence prompt explicitly refuses to
**fabricate credentials or guess a persona**: it records the gap in its handoff and, if that blocks a
faithful demonstration, bounces or takes the ask-human path.

Its opening section is a hard "step zero": read the repo's agent instructions, its skill/command dirs
(by path, symlinks followed, `references/` included), and its gitignored local memory **before**
starting the app — then prefer the repo's own executable helpers over improvising. If your repo
documents a dev-server helper and a login script and the agent still hand-rolls a login, the gap is
almost always discoverability: name the exact paths in `CLAUDE.md`/`AGENTS.md`, or restate them in the
repo's `guidelines-prompt.md` (§ [config-reference](./config-reference.md)), which is appended to
every step prompt.

Document these in the repo (`CLAUDE.md`, a runbook under `docs/`, or a dev-server skill):

1. **How to run it deterministically** — the correct dev-server command, the ports it binds, required
   env vars, and any **seed / reset / fixture** step that puts data into a known state.
2. **How to sign in** — the login path itself, which is where evidence runs most often die. A redirect
   to a separate **identity provider / SSO screen (with MFA)** is expected and the prompt is told so
   explicitly: it is neither a failure nor a bounce. Document, and the prompt will use in this order:
   the **login helper** (script/task, its subcommands, and the browser **session** it establishes — the
   capture then reuses that same session), where the **credentials live** (a file under repo-local
   memory, a documented env var, a seeded account), and any rule about **how** they must be entered.
   That last one matters: some identity forms corrupt values entered by naive typing/autocomplete,
   which presents as a wrong password. The prompt reads such a failure as *the flow was driven
   wrongly*, re-reads your reference instead of trying credential variations, and — if it still can't
   sign in — takes the **ask-human** path rather than bouncing the work or grinding the budget.
3. **Who to sign in as** — the documented **test credentials / seeded accounts**, and **which persona,
   role, or tenant** a given kind of item implies. The prompt gates on this: an admin-only feature must
   be shown as an admin, per-tenant behaviour in its tenant, a gated view from an account that holds the
   permission (and, when the item is *about* the gating, also one that lacks it). Capturing logged out,
   as the wrong role, or on a login wall / permission-denied / empty state is scored **not proven**.
4. **Capture tooling and its settings** — the browser skill, the deterministic viewport, and the video
   recording size. Where the repo sets a recording size the agent uses it; otherwise it records at the
   viewport's native size. (Video zoom/resolution belongs to the target repo's capture skill, not to
   factory config.)

Also relevant:

- `@@EVIDENCE_DIR@@` is `.memory/herdr-factory/evidence` — scratch, **never committed**. Another reason
  for the `.memory/` ignore rule (§1.3).
- A branch that won't build, or a server that errors on boot, is treated as an upstream problem and
  **bounces** — so a repo whose bootstrap is undocumented will bounce rather than ask.
- An `evidence` step with no `tab`/`pane` is **silently skipped** — it only runs in a layout pane. See
  [layouts.md](./layouts.md).

---

## 5. Commit conventions: the repo's guide vs. `conventions.commits`

- **Unset (the default):** the `work` prompt tells the agent to follow the repo's own convention — its
  commit guide, or the shape of recent `git log`. Nothing to configure.
- **Set:** `conventions.commits` is either short free text or a **file pointer** (absolute, else
  resolved against the repo's *config folder* `~/.config/herdr-factory/repos/<name>/` — **not** the
  checkout). It renders `@@COMMIT_CONVENTIONS@@` onto the `work` and `pr` prompts as:

  > **Commit-message conventions** (configured for this repo — apply them to every commit message;
  > where they disagree with a convention the repo's own docs suggest, these win):

  So **the config key wins over repo docs, by design.** Set it only when you want to override the repo,
  or when the repo documents nothing. The file's *contents* are re-read every render; adding or changing
  the *key* needs a config reload.

Related precedence, same shape: where the repo's PR conventions and the belt's `pr:` block disagree on
title, draft state, labels, reviewers or assignees, **the belt's policy wins** — it is explicit
configuration for this run. See [belts-and-steps.md](./belts-and-steps.md).

---

## 6. The precedence rule

Stated in the handover scaffold appended to **every** step prompt (including `custom`), and repeated by
each shipped base in its own idiom:

**The repo governs HOW the work is done.** Bootstrap/setup commands; architecture, patterns to reuse,
naming, code style; where tests live and the exact lint/type-check/test commands; review standards,
architectural rules, coverage expectations, acceptable complexity; dev-server/seed/reset commands, test
accounts and personas, capture tooling and viewport; PR description shape, required sections, title
convention, and pre-PR requirements. Where the repo documents one of these, the agent does it the repo's
way; where the repo is silent, the prompt's defaults apply.

**The factory's flow always wins, and is never overridable by a repo document:**

- the posture the prompt assigns — read-only steps stay read-only (the engine parks the run if the
  branch's HEAD moves) and do not commit;
- incremental commits to the run's branch during `work` (the progress heartbeat depends on them);
- not opening the PR from any step other than `pr`;
- the handoff note, and finishing via `step-done` / ask-human / bounce — never by stopping silently;
- the work item's status: **the dispatcher owns every transition**, no agent touches it;
- the capture slot lock, the capture-attempt signal, the publish command, and the per-criterion
  verdict / pass-or-bounce decision in `evidence`;
- `conventions.commits` and the belt's `pr:` policy over the repo's equivalents (§5).

**On a genuine conflict:** the agent follows the factory prompt **and records the conflict in its
handoff**. Read handoffs — a recurring recorded conflict is the signal to change the repo's docs or the
belt's config.

---

## 7. Setup checklist, ordered by leverage

Run through this with the user. Everything above the line breaks the factory; everything below it
changes output quality.

| # | Do this | Verify with |
|---|---|---|
| 1 | Add `.memory/` to the repo's `.gitignore`; if a `.memory/herdr-factory` is already tracked, `git rm -r --cached` it and commit | `git -C <repo> check-ignore -v .memory/` prints the rule (exit 0); `git -C <repo> ls-files .memory` prints nothing |
| 2 | Point `repo.path` at the main checkout | `test -d <repo.path>/.git` (must be a **directory**); `herdr-factory --repo <name> doctor` → ✓ `repo.path is a main git checkout` |
| 3 | Set `base_ref` to a ref that exists (the factory fetches it before each new worktree; a local, remote-less ref is yours to keep fresh) | `git -C <repo.path> rev-parse --verify <base_ref>`; check freshness with `git -C <repo.path> log -1 --format=%cr <base_ref>` |
| 4 | Confirm the GitHub repo resolves | `herdr-factory --repo <name> doctor` → ✓ `git origin resolved` shows `owner/name`; else set `repo.github` |
| 5 | Authenticate `gh` with write access | `gh auth status`; `gh repo view <owner/name> --json viewerPermission -q .viewerPermission` → `WRITE`, `MAINTAIN` or `ADMIN` |
| 6 | Install the herdr integration for the configured agent harness (per machine) | `herdr integration status` → `<agent>: current (vN)`; anything else ⇒ `herdr integration install <agent>` — [install-and-operate.md](./install-and-operate.md) |
| 7 | Link the herdr plugin (needed only if any step targets a layout `tab`/`pane`) | `herdr plugin list --plugin herdr-factory --json` shows `"enabled":true` at the right `plugin_root` — see [layouts.md](./layouts.md) |
| — | — | — |
| 8 | `CLAUDE.md` (or `AGENTS.md`) at the root, naming: bootstrap/install, the exact lint + type-check + test commands, where tests live, and the patterns to prefer | Open a worktree by hand and ask the agent to run the documented commands from a clean checkout — they must pass with no guessing |
| 9 | *(if the belt has an `evidence` step)* document the dev-server command + ports + env, the seed/reset/fixture step, the test credentials / seeded accounts, and which persona/role/tenant applies | A fresh reader can boot the app and sign in as the right user using only the repo's docs |
| 10 | *(evidence)* document the **login** path end to end: the login helper (and its session name), where the credentials live, how they must be entered, and every screen of the journey (identity provider, MFA, tenant/account picker) | Run the helper by hand in a fresh worktree: one command gets you to the signed-in app shell, printing no secrets |
| 11 | *(evidence)* if credentials/session state live in a **gitignored** dir, name the exact paths in the repo's docs — and make sure they're actually populated in a **fresh worktree** (a setup task that copies from a cross-worktree permanent copy) | `ls <worktree>/<that path>` in a factory worktree, not just your main checkout |
| 12 | *(evidence)* add or point at a `playwright-cli` / browser-automation skill under `.claude/skills/` (or `.agents/skills/` + symlink), including the viewport and recording size | `ls -L <repo>/.claude/skills`; the skill states a deterministic viewport |
| 13 | *(if the belt has a `review` step)* add a `code-review` skill under `.claude/` and/or a review checklist / definition-of-done under `docs/`, with any PR-only mechanics separated from the checklist | `ls <repo>/.claude/skills <repo>/docs`; the checklist is judgeable without a PR |
| 14 | Add a PR template at one of the paths in §2.1, plus PR/release conventions in `CONTRIBUTING.md` or a `docs/` runbook | The first non-blank match in the §2.1 order is the one that will be used; check `.memory/herdr-factory/prompt-pr.md` in a live worktree to see it inlined |
| 15 | Decide commit conventions: leave `conventions.commits` unset to follow the repo, or set it to override (§5) | The rendered `prompt-work.md` contains the **Commit-message conventions** block only when the key is set |
| 16 | Optional: move prompt ownership into the repo via `.herdr/prompts/<slug>.md` (§2.2) | The next step render picks it up — no reload; confirm by reading `.memory/herdr-factory/prompt-<step>.md` in the worktree |

To inspect what an agent actually received, read
`<worktree>/.memory/herdr-factory/prompt-<step>.md` — it is the fully rendered prompt, including the
inlined PR template and any repo-pack override.
