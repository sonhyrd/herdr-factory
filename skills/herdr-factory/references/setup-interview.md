# Setup interview

The executable script for taking a repo from nothing to a validated `config.yml` that claims its first work item.

Answers these questions:

- "Set up herdr-factory for this repo." / "Configure the factory here."
- "Which work source should I use, and what do I need from the user before I can write the config?"
- "What does `herdr-factory init` write, and what do I still have to fill in?"
- "Do I need a layout? Do I need an evidence step? What limits should I touch on day one?"
- "Where do the credentials go, and how do I prove they work?"
- "My config won't load — how do I read the error and fix it?"
- "How do I take the first run and confirm the factory actually claimed something?"

## Rules for running this interview

1. **Infer before asking.** Every value derivable from the checkout (repo path, repo name, GitHub origin, default source type, base ref) is inferred in Phase 0/1 and only *confirmed* — never asked cold.
2. **Ask in batches at the marked STOP-AND-ASK points.** Everything between two stops is decided from the previous answers.
3. **Never invent a value.** See [Never guess these](#never-guess-these). A placeholder that validates is worse than a question — it fails at first poll with an empty result and no error.
4. **Edit the scaffold; do not hand-write YAML from scratch.** `init` emits a validated, schema-annotated skeleton.
5. **After every edit, validate** (Phase 4). A load-time rejection is cheap; a silently-dropped key is not.
6. Config lives at `~/.config/herdr-factory/repos/<repoName>/config.yml` (`$HERDR_FACTORY_CONFIG_DIR` overrides the root). `<repoName>` is the **config-folder name**, which is what `--repo` takes — not the git repo name.

---

## Phase 0 — orient before asking anything

Run all of these first. They cost nothing and each one removes a question.

| command | what it tells you | what to do with it |
|---|---|---|
| `herdr-factory doctor` | the factory itself: `node runtime >= 26`, `auto-update`, `supervisor service`, `server`, `database`, then `git` / `herdr` / `gh` / `claude` presence | command not found ⇒ the factory isn't installed: **STOP**, point at `install.sh` ([install-and-operate.md](./install-and-operate.md)). `✗ supervisor service` / `✗ server` is fine for authoring, but must be fixed before Phase 6. `✗ gh` / `✗ herdr` blocks a real run. |
| `ls ~/.config/herdr-factory/repos` | existing per-repo config folders (a folder only counts as a repo if it holds `config.yml`) | a folder for this checkout already exists ⇒ **edit path**, not fresh setup |
| `git rev-parse --show-toplevel` | the checkout root | this is what `init` uses for `repo.path`; its `basename` is the default repo name |
| `test -d "$(git rev-parse --show-toplevel)/.git" && echo main \|\| echo linked-worktree` | main checkout vs linked worktree (`.git` as a **file** = linked worktree) | `linked-worktree` ⇒ **STOP**: `init` and `loadConfig` both refuse it (`repo.path "<p>" looks like a linked worktree (.git is a file); herdr needs the MAIN checkout`). Find the primary clone. |
| `git remote get-url origin` | whether a GitHub origin resolves | resolves ⇒ `init` defaults the source to `github_issues` and PRs have a home; no origin ⇒ default is `local_markdown`, and you will need `repo.github` or a remote before a `pr` step can work |
| `curl -s 127.0.0.1:8765/health` | is a resident server up (default port `8765`, `HERDR_FACTORY_PORT` overrides) | up ⇒ every config change needs `herdr-factory reload` afterwards; `init` does **not** register a new repo with a running server |
| `git -C <root> log --oneline -1 origin/main` | does `origin/main` exist | fails ⇒ ask for the real default branch and set `repo.base_ref` |

**The decision this phase produces** — pick exactly one:

| situation | route |
|---|---|
| no config folder for this checkout | **fresh setup** → Phase 1 |
| a config folder exists and `doctor --repo <n>` shows `✓ config loads + sources buildable` | **edit** → read the existing `config.yml` in full, then jump to only the Phase 2 sub-question the user asked about. Do **not** re-run `init` (it refuses without `--force`, and `--force` discards the file). |
| a config folder exists and `config loads + sources buildable` is ✗ | **repair** → Phase 4 with the reported message; skip Phases 1–3 |

---

## Phase 1 — scaffold, don't hand-write

From **inside the target checkout**:

```sh
herdr-factory init                    # or: herdr-factory --repo <name> init --source jira
```

**What it infers** (in this order):
1. `repoPath` = `--path` if given (used verbatim, *not* normalised to the git root — a subdirectory fails the main-checkout assert), else `git rev-parse --show-toplevel`. Neither ⇒ throws `not inside a git repository (<cwd>) — run \`init\` from within your project checkout, or pass --path <checkout>`.
2. asserts a **main** checkout (`.git` must be a directory).
3. `ghRepo` from `git remote get-url origin`.
4. `source` = `--source` else `github_issues` when an origin resolved, else `local_markdown`.
5. repo name = global `--repo` else `basename(repoPath)`.

**What it writes**

| file | when | clobbers? |
|---|---|---|
| `<configDir>/repos/<name>/config.yml` | always | only with `--force` |
| `<configDir>/config.schema.json` | always | always rewritten (also by `schema`, `install`, and every `serve` start) |
| `<configDir>/repos/<name>/env`, mode **0600** | only for a source with a required secret ⇒ `jira`, `sentry` | **never** — an existing env file is preserved |

The scaffolded `config.yml` is always the same skeleton: the schema modeline `# yaml-language-server: $schema=../../config.schema.json`, `repo.path` home-shortened, `base_ref: origin/main`, a commented `# github: <owner/name>` line when the origin resolved, exactly one `work_sources` entry, and one belt with `steps: [{type: work}, {type: review}, {type: pr}]` — plus `label: agent` for `jira`/`github_issues` and **no label line** for `local_markdown`/`sentry`.

**The placeholders are marked `# EDIT:`** — grep for them and treat each as an open question:

```sh
grep -n 'EDIT:' ~/.config/herdr-factory/repos/<name>/config.yml
```

`jira` gets four (`base_url`, `project`, `board`, plus the status comment); `github_issues` gets one only when no origin resolved; `local_markdown` gets the briefs folder; `sentry` gets the org slug. `init` self-validates its own output, so a fresh scaffold always loads.

**Prefer hand-writing only when** the config needs more than one source or more than one belt from the start, or the user is porting an existing config. Even then: scaffold first, then add blocks — you inherit the modeline and the correct top-level key spellings. If the target shape is already a known one, start from [recipes.md](./recipes.md) instead of inventing it.

**Flags**: `--source <jira|github_issues|local_markdown|sentry>` (bad value ⇒ exit 1 `unknown --source "<x>" — use one of: jira | github_issues | local_markdown | sentry`), `--path <dir>`, `--force` (overwrites `config.yml`, never the `env` file).

---

## Phase 2 — the questions

### 2a. Which work source

**STOP-AND-ASK #1.** One question, four options. Recommend the one Phase 0 inferred.

| answer | recommend when | belt `label` |
|---|---|---|
| `github_issues` | there's a GitHub origin and the team already tracks work in issues — cheapest possible start (auth is the existing `gh` login) | **required** |
| `jira` | the team's tickets live in Jira | **required** |
| `local_markdown` | trying the factory out, or the work is ad-hoc briefs with no tracker | **forbidden** |
| `sentry` | the work items *are* production errors | **forbidden** |

Then ask only the follow-ups for the chosen type.

#### `github_issues`

Follow-ups: (1) which repo holds the issues — default is the PR repo resolved from the origin; (2) the trigger label (see 2b).

```yaml
work_sources:
  - type: github_issues
    name: issues
    github_issues: {}          # repo defaults to the resolved origin
```

Issues elsewhere:

```yaml
    github_issues:
      repo: acme/tracker       # owner/name
```

- Credential: **none required**, but recommended. `GITHUB_TOKEN` in the repo env is optional; unset ⇒ the `gh` CLI login is used (`gh auth token`). A PAT is needed when the `gh` login lacks `issues:write` on the **polled** repo — and is the right answer whenever MORE THAN ONE HOST polls GitHub: the rate limit is counted per account, so hosts sharing one `gh` login share one 5,000/hr budget and exhaust it together. One `GITHUB_TOKEN` per host.
- Eligible = open, carries the belt's label, is not a PR, and carries none of the in-flight `state_labels` (`herdr:in-development`, `herdr:in-review`, plus any extras). The `herdr:aborted` label deliberately does **not** gate — re-adding the trigger label is the retry gesture.
- The trigger label must **exist in the repo** or `doctor --deep` fails: `github_issues: trigger label "<label>" does not exist in <repo> — create it (or fix the belt's \`label\`) and add it to issues you want worked`. Create it: `gh label create agent --repo <owner/name>`.
- Setting `type_labels` **replaces** the whole default map `{bug: Bug, defect: Bug, chore: Chore, task: Chore, enhancement: Feature}` — it does not merge. Leave it alone on day one.

#### `jira`

Follow-ups, all four mandatory and none guessable: site URL, project key, **Agile board id**, and the exact `To Do` status name on that board.

```yaml
work_sources:
  - type: jira
    name: jira
    poll_interval_seconds: 300
    jira:
      base_url: https://your-org.atlassian.net   # full URL with scheme; a bare host is rejected
      project: PROJ
      board: "254"
      status:
        todo: To Do
        in_development: In Progress
        review: In Review
```

- **`board` is the Agile board id, not the project key.** The user reads it off the board URL — `.../jira/software/c/projects/PROJ/boards/254` ⇒ `254`. A board belonging to a different project polls empty forever with no error.
- **The review key is `review`, not `in_review`.** The `status` map has a catchall, so `in_review:` is silently absorbed as a *custom* status while the canonical review mapping stays `"In Review"`. Same for any typo. Nothing warns you.
- Status names go into JQL verbatim (`status = "<todo>"`), so casing must match Jira exactly for **pickup**; the transition lookup is case-insensitive, so a casing error breaks claiming but not write-back. A `"` in a status name, the project key, or the label produces malformed JQL → HTTP 400 → the poll degrades to `[]` with `<name>: eligible query failed: …`.
- Credentials: `JIRA_EMAIL` + `JIRA_API_TOKEN` (API token only — there is no OAuth; the Agile board API isn't reachable with an OAuth token. A 401 hint text mentions `auth login`; **there is no such command** — ignore it).
- `poll_interval_seconds: 300` is a reasonable default; the client is capped at 5 req/s anyway.

#### `local_markdown`

One follow-up: the briefs folder.

```yaml
work_sources:
  - type: local_markdown
    name: briefs
    local_markdown:
      folder: ~/dev/acme-work-items      # ~ and $HOME expand
```

- No credentials. `auth status` prints `no authentication required`.
- One item per top-level `<key>.md` **or** per top-level directory containing at least one top-level `*.md`. A `<key>.md` file wins a collision with a `<key>/` directory. Nested markdown does not qualify a directory.
- **Invisible names**: anything starting `.` or `__`, and any name outside `[A-Za-z0-9._-]+` (spaces are not claimable — logged as `local_markdown: skipping "<name>" — rename it to [A-Za-z0-9._-]+ to make it claimable`).
- Status lives in the factory's own `work_items` ledger, not the file. Once an item leaves `todo` it is never picked up again, **even if you edit the file**.
- This block is the only source block that is not strict — an unknown key inside `local_markdown:` is silently dropped.

#### `sentry`

Follow-ups: org slug, which projects, which environments, and how tight the query should be.

```yaml
work_sources:
  - type: sentry
    name: sentry
    poll_interval_seconds: 300
    sentry:
      organization: my-org           # the slug from the URL, or a numeric id — not the display name
      projects: [frontend]           # [] or omitted = every project the token can see
      environment: [production]      # lists, not scalars
      query: "is:unresolved level:error"
      stats_period: 14d              # ^\d+[smhdw]$
      on_merge: comment              # comment | none | resolve | resolve_in_next_release
```

- **`projects` and `environment` are arrays.** `environment: production` fails schema validation; write `environment: [production]`.
- Omitting `projects` means *every* project the token can see — almost always too broad for one belt. Ask.
- Credential: `SENTRY_AUTH_TOKEN`, required, needing **`event:read` + `event:write`** — an Internal Integration token (Settings → Developer Settings) or a personal token (User Settings → Personal Tokens). A 403 means a missing scope, not a bad token.
- Eligibility filtering lives on the **source**, not the belt. A second filter = a second `work_sources` entry.
- `poll_interval_seconds: 300` is strongly recommended — Sentry rate-limits REST polling and the client is deliberately the most conservative (3 req/s).

Full per-source detail: [work-sources.md](./work-sources.md).

### 2b. The pickup label

**STOP-AND-ASK #2** — only for `jira` / `github_issues`. There is **no default**: omit it and the config is rejected with `belt "<b>": source "<s>" (<type>) picks up work by a <label|trigger label> — set the belt's \`label\` (there is no default)`. Setting it on `local_markdown` / `sentry` is likewise rejected: `… has no label concept — remove \`label\``.

Ask: *"Which label marks an item as 'the factory may work this'?"* Recommend `agent` (what `init` scaffolds).

Collision rules to state when helping them pick:
- The label must not already be in use for anything else — every item wearing it in the todo status is claimable.
- Two belts on the **same source** may not share a label (`belts "<a>" and "<b>" both pick up "<s>" work by label "<l>" — they'd contend for the same items; give each belt a distinct label`). Splitting one source across belts by *distinct* labels is the supported pattern.
- Jira labels are case-sensitive and go into JQL verbatim; GitHub labels are compared case-insensitively.

```yaml
belt:
  - name: issues-to-prs
    source: issues
    label: agent
```

### 2c. Pipeline shape

Start from what `init` wrote and walk outward. The default is deliberate — **recommend shipping it unchanged for the first run**:

```yaml
    steps:
      - { type: work }      # implements + commits
      - { type: review }    # read-only critique; can bounce back to work
      - { type: pr }        # opens the PR, then the engine watches it
```

**STOP-AND-ASK #3**: *"Ship `work → review → pr` as-is for the first run, or add something now?"* Options:

| add | what it costs | the fragment |
|---|---|---|
| nothing | — | leave as scaffolded |
| **evidence** (visual proof before review) | two layout panes (its own **and** the belt's first step's), an `evidence:` publisher block, plus a dev-server command you must ask for | see below |
| a **custom gate** | a prompt file you have to write | `- { type: custom, name: gate, prompt_file: prompts/gate.md, read_only: true, bounce: true }` |
| a **fully custom belt** (e.g. triage, no PR) | you own every prompt | steps of `type: custom` only; no `pr` step ⇒ no PR watch |

Composition rules the schema enforces, in the order they bite:
- Dataflow: `review` and `pr` both **require `commits`**; `evidence` requires `work_spec` + `commits`. A step whose required input nothing upstream produces is rejected: `belt "<b>" step "<n>" requires "<product>" but neither the source nor an earlier step produces it`. So a `work` (or a `custom` with `produces: [commits]`) must come first.
- `consumes` / `produces` / `read_only` / `bounce` are legal **only** on `type: custom`; the product allow-list for `consumes`/`produces` is **`commits` only**.
- `custom` **must** have `prompt_file` — it has no built-in prompt, and its file is the whole body (never set `prompt_mode: replace` on it).
- A step declaring `bounce: true` needs an earlier step that consumes `bounce_feedback` — `work` and `custom` both do.
- `read_only: true` together with `produces: [commits]` or `heartbeat: true` is rejected.
- Step `name` defaults to `type`, so two unnamed `custom` steps collide. Name them (`^[a-z0-9][a-z0-9_-]*$`).
- A belt-level `pr:` behavior block on a belt with no PR-opening step is an error, not a no-op.

Detail and the effects/bounce semantics: [belts-and-steps.md](./belts-and-steps.md). Prompt authoring for a custom step: [prompts.md](./prompts.md).

#### The evidence step, if they want it

Two hard requirements, both easy to get wrong:

1. **A `tab` + `pane` pair.** `evidence` is the one primitive with `requiresLayout: true` — a bare `{ type: evidence }` is **silently skipped at load**. No error, no warning: the belt just resolves to `work → review → pr` and the user believes evidence is running. Always set both (setting only one is rejected: `tab and pane must be set together (or both omitted to spawn a dedicated pane)`).
2. **An `evidence:` publisher block** (2f). Without one, capture still happens but `evidence-upload` exits early with `evidence-upload: no \`evidence:\` block configured for this repo — skipping publish (no URLs produced)` and downstream steps get no links.

```yaml
layouts:
  - id: dev
    tabs:
      - title: work
        panes:
          - { title: agent, agent: claude, agent_args: [--dangerously-skip-permissions] }
          - { title: server, command: pnpm dev, split: right, size: "40%" }
      - title: qa
        panes:
          - { title: evidence, agent: claude, agent_args: [--dangerously-skip-permissions] }

belt:
  - name: issues-to-prs
    source: issues
    label: agent
    default_layout: dev
    steps:
      - { type: work, tab: work, pane: agent } # the FIRST step must target a pane too — see below
      - { type: evidence, tab: qa, pane: evidence }
      - { type: review } # untargeted from here on is fine: the layout already exists
      - { type: pr }
```

When the belt sets `default_layout`, every step's `tab`/`pane` pair is validated at load against that layout's **titled** panes — an untitled pane cannot satisfy a target, that pane must itself start an agent (`agent:`, or a `command` that launches one), and the error lists what is available. Two more obligations bite in this shape, and the example above is written to satisfy both:

- **The first step needs a pane as well**, which is why `work` carries one. A belt with `default_layout` whose first *surviving* step has no `tab`/`pane` is rejected at load — surviving, because a bare `evidence` step is dropped before this check, so it lands on the steps that remain:

  ```
  belt "<b>" sets default_layout "<L>", but its first step "<n>" has no `tab`/`pane` — that step spawns a dedicated pane, whose new tab makes the layout hook skip the build ("not a fresh 1-tab/1-pane workspace"), and every later layout-targeted step then parks with `layout_wait_timeout`. Give the first step a tab/pane in "<L>", reorder so a layout-targeted step runs first, or remove default_layout from this belt.
  ```

  Reported at `belt.<i>.steps.<j>.pane`, `<j>` being that step's index in the **written** steps list. Later steps may omit `tab`/`pane` freely — they get a dedicated pane, harmlessly, because the layout is already built by then.
- **No two steps of one belt may target the same pane** (`each step needs its own agent pane`) — so `evidence` gets a second titled pane rather than sharing `work`/`agent` with the `work` step.

With no `default_layout` the target, agent-in-pane and first-step checks are all skipped (the panes are assumed to come from a hand-made herdr workspace) and a wrong name instead parks the run at run time with `layout_wait_timeout`. One pane per step is enforced on every belt regardless.

`pnpm dev` is a placeholder — **ask** for the repo's real dev-server command.

### 2d. Do they need a layout at all?

**STOP-AND-ASK #4**, and lead with the honest answer: **no.** A step with no `tab`/`pane` gets a pane the factory spawns itself (running `claude --dangerously-skip-permissions` unless an `agent:` block says otherwise) — zero layout config, and the scaffolded pipeline works that way.

Declare a `layouts[]` entry + `default_layout` only when:
- you added an `evidence` step (it needs a pane, and usually a sibling pane running the dev server), or
- the user wants to watch the run in a specific herdr tab/pane arrangement, or
- a step must drive a pane that already runs something else (a step targeting an existing pane drives whatever that pane runs — the `agent:` block only applies to panes the **factory** spawns).

Say what a `default_layout` commits them to before they pick it: the belt's **first** step must then target a pane in that layout (it is a load error otherwise, 2c), and the layout must give that pane an agent. So a layout and untargeted steps are not a mix-and-match — an interview that scaffolds steps with no `tab`/`pane` must not also set `default_layout`, and a belt that wants a layout pays for at least its first step's pane. Later steps stay free either way.

Everything about the layouts library, pane sizing, `layout_matching`, and the herdr plugin hook that builds them: [layouts.md](./layouts.md).

### 2e. Limits worth touching on day one

Exactly one: **`limits.max_active_workspaces`** (default **3**) — how many runs may occupy a slot for this repo at once.

```yaml
limits:
  max_active_workspaces: 3
```

Leave every other limit alone. Two facts to state so the user isn't surprised:
- Each `work_sources[]` entry has its own `max_active_workspaces`, defaulting to **2**. Raising the repo cap alone will not push one source past 2 concurrent runs.
- `limits` is **not** strict and neither is the root object: a misspelled key (`limit:`, `max_active_workspace:`) is **silently dropped** and the default applies. There is no error and the editor schema won't flag it either. Verify by re-reading the file after editing, not by trusting a green `doctor`.

Every key, type and default: [config-reference.md](./config-reference.md).

### 2f. Evidence publishing

Only if 2c added an evidence step. **STOP-AND-ASK #5**: *"Where should captured evidence be published?"*

| publisher | recommend when | required keys |
|---|---|---|
| `local` | first run, solo use, or no cloud yet — **recommend this to start** | none (`public_base_url` optional; defaults to `http://127.0.0.1:<server port>`) |
| `s3` (the default when `publisher:` is omitted) | evidence must be linkable from a PR others read | `bucket`, `region`, `cloudfront_domain` |
| `command` | an existing upload script owns this | `command` (string or argv array) |

```yaml
evidence:
  publisher: local
```

```yaml
evidence:
  publisher: s3
  bucket: acme-herdr-evidence
  region: ap-southeast-2
  cloudfront_domain: d111111abcdef8.cloudfront.net    # a full URL is accepted and normalised to the bare host
  # profile: my-sso-profile
  # key_prefix: acme-frontend
```

AWS credentials come from the ambient chain (`aws sso login`), **never** from config — and the chain that matters is the **resident server's**, not your shell's: a helper that exports creds into an interactive session (`assume`, `aws-vault`) or caches its SSO token outside `~/.aws/sso/cache` (granted's keychain) needs a dedicated `credential_process` profile, or every upload sits auth-stuck while you're "logged in" ([troubleshooting.md](./troubleshooting.md) §evidence uploads). `local` needs the resident server running to serve the URLs. Verify either with `doctor --repo <n> --deep`, which does a real round-trip (the s3 probe leaves one tiny `.herdr-doctor` object behind by design).

### 2g. Terminal status write-back

**STOP-AND-ASK #6** — and lead with the per-source default, because they differ:

| source | what happens on merge **by default** | to change it |
|---|---|---|
| `jira` | **nothing.** `status.done` is unset, so a merged ticket is left alone (Jira's own GitHub integration usually closes it). | add `status: { done: Done }` — the name must be a status the ticket's workflow can actually transition to |
| `github_issues` | the issue **is closed** as `completed` (`close_on.merged` and `close_on.done` default `true`; `close_on.aborted` defaults `false`, so failed work stays open wearing `herdr:aborted`) | `close_on: { merged: false }` |
| `sentry` | a comment **is posted**: `[herdr-factory] Fixed by <pr> (merged by herdr-factory).` (`on_merge: comment`) | `on_merge: none` for a fully read-only integration |
| `local_markdown` | internal ledger only; the source folder is never modified for lifecycle | — |

```yaml
    jira:
      status:
        done: Done        # opt-in
```

If they opt into `jira.status.done`, warn: a target status the workflow can't reach makes `transition` throw, and the durable outbox then retries **forever** (60s → 1h, never gives up) logging `<KEY>: no transition from "In Progress" to "Done"`. The status must be reachable from `In Review`/`In Progress` in that project's workflow.

Custom (non-canonical) statuses driven by belt `effects` are a separate feature — one line: they need both an `anchor` and a declaration under the source's `status`/`state_labels` map, and are rejected outright on `local_markdown`/`sentry`. See [belts-and-steps.md](./belts-and-steps.md).

---

## Phase 3 — credentials

One file, per repo, never global: **`~/.config/herdr-factory/repos/<name>/env`**, `chmod 600`.

```sh
touch ~/.config/herdr-factory/repos/<name>/env
chmod 600 ~/.config/herdr-factory/repos/<name>/env
```

Format: `KEY=value`, one per line; `#` comments and blank lines skipped; the first `=` splits; both sides trimmed. **No quote stripping, no escapes, no multi-line values** — a value written `"abc"` keeps its quotes and will be sent as `"abc"`.

| source | keys | required |
|---|---|---|
| `jira` | `JIRA_EMAIL` (the Atlassian account email, not a username), `JIRA_API_TOKEN` (id.atlassian.com → Security → API tokens) | both |
| `sentry` | `SENTRY_AUTH_TOKEN` (`event:read` + `event:write`) | yes |
| `github_issues` | `GITHUB_TOKEN` | **no** — falls back to the `gh` CLI login, but give each host its own token (the rate limit is per account) |
| `local_markdown` | — | — |

`init` pre-writes this file with the keys **empty** for `jira`/`sentry` (deliberately, so `doctor` flags them) and never touches an existing one. A key present but empty (`JIRA_API_TOKEN=`) counts as missing. Process env is **not** consulted for these keys.

Verify, in this order:

```sh
herdr-factory --repo <name> auth status      # presence only, no network
herdr-factory --repo <name> doctor --deep    # actually exercises the credential
```

`auth status` prints `✓ <KEYS> present` / `✗ set <KEYS> in the repo env` / `using the gh CLI login (\`gh auth status\`)` / `no authentication required`. **A wrong-but-present token still shows ✓** — only `--deep` catches it.

**A source with missing or rejected credentials pauses; it does not break anything.** Config load and server startup succeed, the source's claims and status write-backs are held, one notification fires (re-notified hourly), and recovery is automatic on the next successful call — held write-backs are re-queued. Log line: `<source>: work source not authenticated (<reason>) — pausing its claims + status write-backs until re-authenticated`.

---

## Phase 4 — validate

The loop, repeated until clean:

```sh
herdr-factory --repo <name> doctor --deep
```

1. Read the **`config loads + sources buildable`** row. Its ✗ detail is the raw loader message and may be multi-line.
2. Fix at the reported path.
3. Re-run. **Non-zod throws abort on the first failure**, so several passes can be needed even though zod issues are reported all at once.

**Reading a zod error.** The header is `invalid config for repo "<name>" (<path>):` and each issue is one indented line `  <dotted.path>: <message>`. The path is dotted with **0-based array indices**:

| error line | where in the YAML |
|---|---|
| `belt.0.steps.2.pane: tab and pane must be set together …` | 3rd entry of `steps:` under the 1st entry of `belt:` |
| `belt.0.steps.0.pane: belt "…" sets default_layout "…", but its first step … has no \`tab\`/\`pane\` …` | the **1st** `steps:` entry — the step to fix (or reorder), not the belt's `default_layout:` key |
| `work_sources.1.jira.board: set \`jira.board\` to the Agile board id …` | the `board:` key of the 2nd `work_sources` entry |
| `belt.0.effects.1: Unrecognized key: "product"` | 2nd `effects` entry of the 1st belt |
| `(root): …` | the top-level object |

Non-zod, load-time throws that appear in the same row (each aborts the load on its own): a missing `match` file or `prompt_file` (both resolved relative to the **config folder**, not the repo — and `~` does *not* expand there), a prompt-contract violation, a layout `size` out of range, `repo.path` not a git checkout / a linked worktree, and `work source "<name>": no GitHub repo to poll — set github_issues.repo (owner/name), or repo.github / a git origin so the default resolves`.

**The trap that no error catches**: the root object, `repo:`, `limits:` and the `local_markdown:` block are not strict. A misspelled top-level block (`belts:`, `work_source:`, `layout:`, `convention:`) is **silently ignored** and the defaults apply. After a clean doctor, re-read the file and confirm every top-level key is one of: `repo`, `limits`, `work_sources`, `belt`, `layouts`, `evidence`, `conventions`, `branch`, `agent`. Note `belt` is **singular** but holds an array; `work_sources` is plural.

The full catalogue of load-time rejections with exact error text: [config-reference.md](./config-reference.md). Symptom-first debugging: [troubleshooting.md](./troubleshooting.md).

Also worth doing once:

```sh
herdr-factory schema     # refresh <configDir>/config.schema.json so the editor modeline is accurate
herdr-factory reload     # only if Phase 0 found a resident server — it won't see a new/edited repo otherwise
```

`reload` can refuse: `not reloaded: belt <detail> still has work — rename via the TUI (it migrates the runs) or tear the work down first`.

---

## Phase 5 — the target repo

The config can be perfect and the results still poor if the checkout gives the agents nothing to work with. Confirm, before the first run:

- `.memory/` is in the repo's `.gitignore` (the factory writes `.memory/herdr-factory/` into every worktree; a committed one is scrubbed with a warning).
- a `CLAUDE.md` / `AGENTS.md` exists and says how to build, test, and run the app — the shipped prompts defer to it over their own generic advice.
- the skills the shipped prompts look for exist if you added an evidence step (browser-automation / dev-server).
- `gh` is authenticated as an identity that may open PRs on the origin.
- `repo.base_ref` names a branch that exists.
- `repo.path` is the main checkout, and it's clean.

Full checklist with the reasons: [target-repo.md](./target-repo.md).

---

## Phase 6 — first run

Take the first run **in the foreground** — it streams every event and exits when idle, which is exactly what you want while confirming the config.

```sh
herdr-factory --repo <name> run --follow
```

Feed it exactly one item first, per source:

| source | how to feed one item |
|---|---|
| `github_issues` | `gh label create agent --repo <owner/name>` (once), then `gh issue create --label agent --title … --body …` |
| `jira` | put a real ticket in the `status.todo` status **on that board** and add the belt's label |
| `local_markdown` | write `<folder>/my-first-task.md` — name matching `[A-Za-z0-9._-]+`, not starting `.` or `__` |
| `sentry` | nothing to create — any issue matching `query` + `stats_period` is eligible. Tighten `query` **before** the first run or the factory will claim whatever is loudest. |

Each line is `  HH:MM:SS  <KEY>  <label> — <detail>`. A healthy first run shows these labels: `claimed`, `source status` (→ `in_development`), `worktree created`, `layout built` (only with a layout), then `▶ step started` / `✓ step done` once per step, then `PR opened` and a second `source status` (→ `in_review`). Plus one heartbeat line per tick in the log: `claimed <n>; working <a>/<cap>, idle/parked <p>` — its **absence** means the repo isn't being ticked.

Labels that mean stop and read: `⚠ needs attention`, `waiting for layout pane` (repeated), `layout build failed`, `↩ bounced back`, `source item gone (stale)`, `evidence upload failed`, `signal rejected`, `error`.

Idle exit (without `--follow`) prints either:

```
nothing in flight — no eligible work to claim and no runs active.
Next: feed the source (label a ticket / drop a *.md brief), then re-run — …
```

or a `local work drained. Remaining:` block. Note `run` exits while runs sit in `attention`, `waiting_for_human`, or idle `reviewing` — those hold no slot. That is by design, not a failure.

**If nothing is claimed**, in this order: `herdr-factory --repo <name> eligible` (the pickup query as JSON — `[]` plus a stderr `<source>: eligible query failed: …` names the real cause), then `doctor --repo <name> --deep`, then [troubleshooting.md](./troubleshooting.md)'s "nothing is being claimed" playbook. Do not start guessing at config.

**Only once a run has reached at least `PR opened`**, install the background supervisor:

```sh
herdr-factory install     # writes + loads the launchd/systemd unit, then brings the server up
herdr-factory --repo <name> status
```

`herdr-factory start` would also work on a fresh machine — `start()` installs the plist/unit when it is absent — but prefer `install` here: it is the only one that also re-bakes the service environment (`PATH` and the `HERDR_*`/`OTEL_*` passthrough) and rewrites `<configDir>/config.schema.json`. Use `start` later, to bring back a machine you `stop`ped. `doctor` should then show `✓ supervisor service` and `✓ server — running on :<port> (v…)`. Every CLI command and what it prints: [cli.md](./cli.md); the full install/update/uninstall lifecycle and the TUI: [install-and-operate.md](./install-and-operate.md).

---

## Never guess these

Every value below has a wrong-but-valid form that passes validation and then fails silently or points at the wrong thing. **Ask. Every time.**

| value | why guessing fails | where the user gets it |
|---|---|---|
| `jira.board` | a board id from another project polls empty forever, no error | the number in the board URL `…/boards/254` |
| `jira.project` | wrong key ⇒ JQL 400, poll degrades to `[]` | the ticket prefix, e.g. `PROJ-123` ⇒ `PROJ` |
| `jira.status.*` names | must match that Jira **exactly** for pickup; `done:` must be workflow-reachable | the board's column names / the ticket's status dropdown |
| the belt `label` | a guessed label matches nothing — or worse, matches an existing team label and claims work nobody meant to hand over | ask which label the team will use; create it if new |
| `evidence.bucket` / `region` / `cloudfront_domain` | a wrong bucket or region produces published URLs that never resolve | the user's AWS/CDN setup |
| the repo's dev-server command (a layout pane `command`) | the evidence step captures a dead port and bounces the work | the repo's `CLAUDE.md` / `package.json` scripts — read them, then confirm |
| `sentry.organization` / `projects` | the **slug**, not the display name; a bad slug is skipped with a warning, and omitting `projects` claims from every project | the Sentry URL path segments |
| `github_issues.repo` | defaults to the PR repo; if issues live elsewhere, guessing sends the factory to the wrong tracker | ask where issues are filed |
| `repo.base_ref` | a non-existent ref breaks every worktree | `git symbolic-ref refs/remotes/origin/HEAD`, then confirm |

Corollary: if the user can't supply one of these yet, leave the `# EDIT:` placeholder in place, say so explicitly, and **do not run the first run** — a scaffold that validates is not a scaffold that works.
