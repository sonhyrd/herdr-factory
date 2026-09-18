# Layouts

How the factory builds a herdr tab/pane arrangement into each new worktree, how a step targets a pane in it, and every way that can fail.

Answers these questions:

- Do I need a `layouts:` block at all, or will steps just spawn their own panes?
- What are the legal keys/values under `layouts[]` — split directions, `size`, `ratio`, `setup`?
- How does a step's `tab`/`pane` resolve to a real herdr pane, and why does it sometimes never resolve?
- Which layout does a given worktree get — `default_layout` or a `layout_matching` glob?
- Why was no layout built at all? (Almost always: the herdr plugin isn't linked.)
- How do I force a layout to be rebuilt into an existing worktree?
- How long does a step wait for its pane before parking, and what happens then?

---

## Do you need a layout?

**No, by default.** Omit `layouts` (and every belt's `default_layout` / `layout_matching`) and each step gets its own dedicated pane: the factory creates a tab and has herdr start the resolved `agent:` harness in it (`herdr agent start --kind --pane`, which blocks until the agent is ready for input). Zero setup, no plugin link needed, works fine.

You need a layout when:

| reason | detail |
|---|---|
| A step must run in a pane **you** control | e.g. an agent pane sitting beside a long-running `pnpm dev` pane in the same tab, so the agent can see the server's output. |
| You use an `evidence` step | `evidence` declares `posture.requiresLayout` (`src/steps/evidence/descriptor.ts`). With no `tab`+`pane` it is **silently SKIPPED**, never spawned. The TUI warns inline: `↳ no tab/pane ⇒ this <type> step is SKIPPED (it only runs in a layout pane)`. |
| A layout-level `setup` command must run before work starts | e.g. `pnpm install` in the fresh worktree, `blocking: true`. |
| A human watches the worktree and wants a fixed window shape | tab/pane titles are stable and addressable. |

The cost: a layout only exists if the **herdr plugin hook** is linked and fires (see [The build mechanism](#the-build-mechanism--the-herdr-plugin-hook)). No link ⇒ no layout ⇒ every `tab`/`pane` step burns its wait budget and parks.

---

## The `layouts:` schema

Repo-level array, `default([])`. Every object is `.strict()` — an unknown or misspelled key is a load error.

```yaml
layouts:
  - id: app-dev
    setup:
      command: pnpm install --frozen-lockfile
      blocking: true
    tabs:
      - title: work
        panes:
          - title: agent
            agent: claude        # herdr starts this agent here, and waits until it's ready
            agent_args: [--dangerously-skip-permissions]
            setup: true
          - title: server
            command: pnpm dev
            split: down
            size: "35%"
```

| key | type | default | notes |
|---|---|---|---|
| `id` | string, trimmed, min 1 | **required** | Unique across `layouts`; what a belt's `default_layout`/`layout_matching` references. |
| `env` | map of scalars | `{}` | Environment for **every** pane in this layout (a pane's own `env` wins). |
| `setup.command` | string, trimmed, min 1 | **required inside `setup`** | Runs once, in the single `setup: true` pane, **before** that pane's own `command`. On an **agent** pane it is executed *in* the pane (`pane run`, through the same login shell, as a child) instead of being baked into the pane's process — an agent can only be started in a pane that is sitting at herdr's own shell. If that pane never reaches a prompt the setup is reported as failed rather than silently waited out. |
| `setup.blocking` | bool | `false` | The builder waits for it (cap `SETUP_TIMEOUT_MS` = 600 s) before **any** pane `command` or `agent` starts. (The topology is already fully built by then — see [what the builder issues](#what-the-builder-actually-issues).) |
| `tabs[]` | array | **required**, min 1 | `a layout needs at least one tab` |
| `tabs[].title` | string, trimmed, min 1 | *optional* | The herdr tab label. **Untitled ⇒ unaddressable by a step.** |
| `tabs[].panes[]` | array | **required**, min 1 | `a tab needs at least one pane` |
| `panes[].title` | string, trimmed, min 1 | *optional* | The herdr pane label — what a step's `pane` matches. **Untitled ⇒ unaddressable.** |
| `panes[].command` | string, trimmed, min 1 | *optional* | A shell command run as the pane's **process**, inside your interactive **login** shell (`sh -c 'exec "$SHELL" -lic …'`) — so mise/asdf/nvm PATH setup applies exactly as it did when it was typed. Not typed into the pane: no scrollback, no racing an unready shell. Mutually exclusive with `agent`. |
| `panes[].persist` | bool | `true` | Hand the pane back to an interactive shell when `command` exits. `false` lets the pane close with it. Only valid alongside `command`. |
| `panes[].agent` | enum: a herdr agent kind (`claude`, `opencode`, `codex`, `gemini`, `pi`, … — the `herdr agent start --kind` set) | — | This pane hosts that agent: the build runs `agent start --kind --pane`, which returns only once herdr has **detected** it and marked it ready for input. What a step-targeted pane should use. Mutually exclusive with `command`. |
| `panes[].agent_args` | list of scalars | `[]` | Passed to the agent after `--` (e.g. `[--dangerously-skip-permissions]`). |
| `panes[].agent_name` | string matching `[a-z][a-z0-9_-]{0,31}` | derived | herdr's agent alias — its own charset rule, and unique among LIVE agents. Unset ⇒ derived from the kind + workspace. |
| `panes[].agent_timeout_ms` | int > 0 | 60000 | How long to wait for the agent to become ready. |
| `panes[].prompt` | string | — | An opening prompt submitted once the agent is ready. **Not for a step-targeted pane** — the step's own prompt is what gets dispatched there (rejected at load). |
| `panes[].prompt_timeout_ms` | int > 0 | — | Set ⇒ block until the agent settles (idle/done) after prompting; unset ⇒ submit and move on. |
| `panes[].env` | map of scalars | `{}` | Environment for the pane's process. Merged over the layout's `env:` (the pane wins). |
| `panes[].setup` | bool | `false` | Marks **the** pane the layout-level `setup.command` runs in. At most one per layout. |
| `panes[].split` | `vertical` \| `horizontal` \| `right` \| `down` | `right` | How this pane splits off the **previous** pane. **Ignored on pane 0** (it is the tab's root pane). |
| `panes[].size` | `"NN%"` string or number > 0 | — | This pane's **own** extent along the split axis. Mutually exclusive with `ratio`. |
| `panes[].ratio` | number, `0 < n < 1` | — | Legacy/undocumented: the fraction the **PREVIOUS** pane keeps. Passes straight through to herdr. |

Split normalization: `vertical`/`right` → a new pane to the **right**; `horizontal`/`down` → **below**.

`size` forms (`normalizeSize`, `src/config.ts`):

| written | means |
|---|---|
| `"30%"` | 30% of the parent along the split axis. Must satisfy `0 < pct < 100`. |
| `0.3` | Same as `"30%"` — a number `< 1` is read as a fraction. |
| `40` | 40 terminal cells. Numbers `>= 1` must be whole. |

**`size` sizes the NEW pane; a herdr split's `ratio` sizes the FIRST (existing) side** — the builder inverts it, so `size: "30%"` becomes `ratio: 0.7`, clamped to `[0.01, 0.99]`. A **cells** size is resolved against the box actually being split: the tab is measured ONCE before the build (`herdr pane layout --pane <root>`) and each split's boxes are computed as the tree is walked — so pane 2 splitting a 50-cell pane 1 sizes against 50, not against the whole tab. When the tab can't be measured, a cells size falls back to an **even split** (`ratio: 0.5`).

> **The FIRST step of a `default_layout` belt must carry a `tab`/`pane`.** The hook builds a layout only
> into a *fresh* (1-tab/1-pane) worktree, and a step with no `tab`/`pane` spawns its own pane
> immediately — a new tab, which makes the worktree non-fresh before the hook ever looks, so the layout
> is skipped entirely. Config load now refuses that shape (see [Layout-specific load
> errors](#layout-specific-load-errors)); *later* steps may still omit `tab`/`pane`, harmlessly, because
> by then the layout exists. A belt whose layout comes only from a `layout_matching` rule is **not**
> covered, and there the failure is still silent — the symptom lands the opposite side of the mistake:
> the steps that DO name panes sit in `<step> waiting for layout pane <tab>/<pane>` until they park
> `layout_wait_timeout`. See [Mixing layout panes with dedicated
> panes](#mixing-layout-panes-with-dedicated-panes--the-first-step-decides).

### Layout-specific load errors

| error text | cause |
|---|---|
| `set either ratio or size, not both` (path `size`) | both set on one pane |
| `set either \`agent\` or \`command\`, not both (an agent pane starts its agent itself)` (path `agent`) | both set — an agent is started INTO the pane's shell, which a command would occupy |
| `\`persist\` only applies to a pane with a \`command\`` (path `persist`) | `persist` with no command |
| `these keys need an \`agent:\` on the same pane: agent_name, agent_args, prompt, agent_timeout_ms, prompt_timeout_ms` (path `agent`) | an agent-only key on a pane with no `agent:` — almost always a typo, and ignoring it would leave a pane that never starts an agent |
| `agent_name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 chars) — herdr's own rule` | herdr answers `invalid_agent_name` otherwise |
| `two panes in this layout share an \`agent_name\` — herdr agent names must be unique` (path `tabs`) | herdr requires uniqueness among live agents; the build would fail partway |
| `layout "<L>" pane <tab>/<pane> sets a \`prompt\`, but belt "<b>" step "<name>" targets that pane — remove the pane's \`prompt\` …` | a step-targeted pane carrying its own opening prompt would race the step's dispatch (a cross-field check, so it appears under the belt's step) |
| `at most one pane in a layout may set \`setup: true\`` (path `tabs`) | two `setup: true` panes |
| `a layout with a \`setup\` block needs one pane marked \`setup: true\` to run it in` (path `setup`) | `setup:` present, no pane marked |
| `duplicate layout id "<id>" — layout ids must be unique` | two layouts share an `id` |
| `layout "<id>": size "<raw>" must be a percentage between 0% and 100%` | `"0%"`, `"120%"` |
| `layout "<id>": a fixed pane size (<n>) must be a whole number of cells` | `size: 40.5` |
| `belt "<b>" default_layout "<x>" is not a defined layout (defined: …)` | unknown id |
| `belt "<b>" layout_matching[<j>] references unknown layout "<x>" (defined: …)` | unknown id in a rule |
| `belt "<b>" sets default_layout "<L>", but its first step "<name>" has no \`tab\`/\`pane\` — that step spawns a dedicated pane, whose new tab makes the layout hook skip the build ("not a fresh 1-tab/1-pane workspace"), and every later layout-targeted step then parks with \`layout_wait_timeout\`. Give the first step a tab/pane in "<L>", reorder so a layout-targeted step runs first, or remove default_layout from this belt.` | the belt's first **surviving** step targets no layout pane, so its dedicated pane's tab would beat the hook and the layout would never be built (path `belt.<i>.steps.<j>.pane`, `j` = that step's index in the WRITTEN steps list) |

The complete load-time rejection catalogue is in [config-reference.md](./config-reference.md).

### What the builder actually issues

**Topology: one `layout.apply` per tab.** `tabTree` (`src/core/layout.ts`) turns each configured tab into herdr's declarative pane tree — nested splits with their ratios, plus every pane's `label`, `cwd` (the worktree checkout), `env` and `command` argv — and one call builds it, answering with the created pane ids in tree order.

`layout.apply` lives on herdr's **socket API**, not its CLI (`src/clients/herdr-socket.ts` is a minimal request/response client used for this alone; the socket path comes from `HERDR_SOCKET_PATH`, which herdr injects into every plugin command). Three consequences worth knowing:

- `tab_id` and `workspace_id` are **mutually exclusive**. Tab 0 passes `tab_id` — the worktree's existing tab — and herdr **rebuilds** it: it builds the replacement first and closes the old tab afterwards (so the workspace is never briefly tabless), giving the tab a new id. Safe here because layouts are built into a freshly-created 1-pane worktree before any pane id is recorded, and steps resolve panes by label. Tabs 1..n pass `workspace_id` and are appended.
- `tab_label` names the resulting tab **either way**, so there is no follow-up `tab rename`.
- A pane count mismatch fails loudly: `layout "<id>": herdr built <n> panes for tab <i>, expected <m>`.

Cell sizes are resolved from the tab's area, queried **once** before the build (`herdr pane layout --pane <root>` → `layout.area`) and then divided arithmetically as the tree is walked — no re-measuring between splits.

**Pane commands ride IN the tree**, as argv herdr launches as the pane's process:
`sh -c 'exec "${SHELL:-/bin/sh}" -lic '<script>''`. Your interactive **login** shell, because that is
what a typed command used to get — mise/asdf/nvm PATH setup has to keep applying — and a process rather
than keystrokes, so it can't race a shell that isn't listening and leaves no scrollback. The script ends
with `exec "$SHELL" -i` (hand the pane back to a prompt) unless the pane sets `persist: false`; an agent
pane and a plain pane always end that way, because `agent start` needs a pane sitting at a prompt.

**Then, in order, what a tree can't express:**

1. **setup**, whose command is prepended to its `setup: true` pane's own script and followed by
   `printf '%s' "$?" > <status file>`. The runner polls that file (cap 600 s). No terminal scraping: a
   sentinel could scroll out of the matched rows, wrap, or be matched from the shell's own echo before
   the command ran. Progress shows on the pane as an `hf_setup` token (`running` → cleared, or
   `failed-<code>` / `timed-out`), and a failure also raises a herdr notification. Never fatal.
2. **each agent pane**: poll `herdr pane process-info` until the pane's shell is genuinely idle, then
   `herdr agent start <name> --kind <k> --pane <id> --timeout <ms> [-- agent_args…]`, which blocks until
   herdr has detected the agent. Then the pane's optional `prompt:`. A failed agent logs, notifies, and
   is skipped — it never tears down the layout that is already built.

`blocking: true` gates every pane **command and agent** — dev servers and agents start only after setup
finishes — while the panes themselves are visible from the start. (Before 0.7.5 it gated pane *creation*,
because panes were split one CLI call at a time.) An agent on the setup pane waits for setup regardless
of `blocking`, since it can't start until that pane is back at a prompt.

---

## Step → pane targeting

```yaml
steps:
  - { type: work, tab: work, pane: agent }
```

- `tab` and `pane` are **both-or-neither**: `tab and pane must be set together (or both omitted to spawn a dedicated pane)` (reported at path `pane`).
- **On a `default_layout` belt the FIRST step must supply them.** Both-or-neither applies to every step, but only the first is *mandatory* — it dispatches in the same flow that creates the worktree, and a dedicated pane there costs the whole layout build. "First" means the first **surviving** step: a `requiresLayout` step with no `tab`/`pane` (today only `evidence`) is dropped at load, so the check looks past it. Later steps may omit both. Load error:
  `belt "<b>" sets default_layout "<L>", but its first step "<name>" has no \`tab\`/\`pane\` — … Give the first step a tab/pane in "<L>", reorder so a layout-targeted step runs first, or remove default_layout from this belt.` (path `belt.<i>.steps.<j>.pane`, `j` = the offending step's index in the WRITTEN list). Mechanism and the case it does **not** cover: [Mixing layout panes with dedicated panes](#mixing-layout-panes-with-dedicated-panes--the-first-step-decides).
- They match **herdr labels by exact string equality** — the layout's `tabs[].title` and `panes[].title`. No trimming, no case folding, no fuzzy match. A trailing space or a different emoji is a permanent miss.
- **Untitled tabs/panes cannot be targeted.** The loader's target set only contains titled tab × titled pane pairs.
- **Two steps of one belt may not target the same pane**: `belt "<b>" steps "<a>" and "<b>" target the same layout pane (tab "<t>", pane "<p>") — each step needs its own agent pane`. Reason: they would share one agent, so the second step's prompt would land in a conversation still carrying the first step's context — and dispatch defers while that agent is `working`, burning the layout-wait budget. **Two different belts may reuse the same titles** — a worktree only ever runs one belt.
- **Validated at load, but only against the belt's `default_layout`.** A belt with no `default_layout` is skipped (its panes come from outside the factory), and `layout_matching` targets are deliberately **exempt** (those rules commonly serve hand-created worktrees). So a target that exists only in a `layout_matching` layout fails at **runtime** as a layout-wait park, not at save. Load error when it does fire:
  `belt "<b>" step "<name>" targets pane <tab>/<pane>, but layout "<L>" does not define it — its labeled panes are: <tab/pane, …>. Fix the step's tab/pane, or add a pane titled "<pane>" to a tab titled "<tab>" in the layout.`
- **The target pane must also START an agent** — an `agent:` kind, or a `command` that launches one. A pane that starts neither would make the step wait out its whole budget and park, so it is rejected at load:
  `belt "<b>" step "<name>" targets pane <tab>/<pane> in layout "<L>", but that pane starts no agent — set an \`agent:\` kind on it (herdr starts that agent as part of the build) or give it a \`command\` that launches one.`
- **A step-targeted pane must NOT carry its own `prompt`** — the step's prompt is what the reconciler dispatches there, and two would race in one agent. Also rejected at load.

**Dispatch-time resolution** (`dispatchToLayoutImpl`, `src/core/step.ts`), in order:

1. the pane id recorded for this step, if `herdr agent list` still shows it alive (a re-entry's durable handle);
2. `tab list` label == `tab` → `pane list` label == `pane`. This stays valid for the pane's whole life: run state is published as display **metadata**, so the factory never renames the pane out from under its own lookup.
3. the same lookup against `<step>:<KEY>` — a **drain-window shim** for panes that the pre-metadata code renamed and that are still live across an upgrade. Removable once no such pane can exist.

Then: no target → wait. A **fresh** target whose state isn't `idle` → wait. A reused target that is `working` → wait (never interleave two conversations in one pane). Otherwise `herdr agent prompt --wait --until working --until blocked` — atomic submission (no separate Enter) **plus a handshake**: herdr reports whether the submission actually moved the agent, and an unconfirmed one is treated exactly like "pane not ready" (logged `<KEY>: prompt to layout pane <id> was not confirmed; will retry`, the pass stays undispatched, the layout wait owns the retry). That is what stops a dropped prompt from starting the step's budget clock against an agent that never got the work. On success the pane's display name is published as `<step>:<KEY>`.

**When herdr never flips the status.** State detection is per-harness, and some harnesses don't report it — `cursor-agent` on Linux takes the prompt and starts editing while `herdr pane list` still says `agent_status: idle`, so the `--until working` handshake times out every time. A dispatch is therefore ALSO confirmed by **progress**: herdr's per-pane `revision` (the terminal-content counter in `agent list`), read before and after the submission. A pane whose revision advanced reacted to the prompt, so the dispatch counts and no later tick re-submits it. Only a pane that produced nothing at all is unconfirmed and retried. If you see `was not confirmed; will retry` repeating for a pane whose agent is visibly working, that pane is producing no output herdr can see — check `herdr integration status` for the harness's kind.

**The targeted pane's `command` must be a herdr-integrated agent harness.** Pane state is whatever `herdr agent list` reports as `agent_status` for that pane, or `gone` when herdr tracks no agent there. A pane running a plain shell command, or an agent whose herdr integration was never installed (`herdr integration install claude|opencode|codex|pi|…`, machine-wide), never reports `idle` — the step waits its whole budget and parks. `herdr-factory doctor` does **not** check this; use `herdr integration status`. Prerequisites and how to install them: [install-and-operate.md](./install-and-operate.md).

The repo/belt/step `agent:` block governs the panes the factory **spawns** (a step with no `tab`/`pane`). A LAYOUT pane names its own agent — `agent: <kind>` + `agent_args` — so the layout owns the harness for the panes it builds. See [belts-and-steps.md](./belts-and-steps.md).

### Mixing layout panes with dedicated panes — the FIRST step decides

A belt may still mix targeted and untargeted steps — the targeting checks skip any step without
`tab`/`pane`, and once the layout exists a dedicated pane is harmless. What is no longer legal is an
untargeted step **first**, because that costs the whole layout build:

| belt shape (with `default_layout`) | what happens |
|---|---|
| `steps[0]` **targets** a layout pane | the step waits for its pane, the hook builds the layout, everything resolves — later untargeted steps get their own dedicated tab, harmlessly |
| `steps[0]` has **no** `tab`/`pane` | **rejected at load** (path `belt.<i>.steps.<j>.pane`) — give that step a tab/pane, reorder so a layout-targeted step runs first, or drop `default_layout`. `steps[0]` here means the first **surviving** step: a `requiresLayout` step with no `tab`/`pane` is dropped at load, so it is not the step that dispatches, and the check looks past it |

Why: a claim creates the worktree and dispatches `steps[0]` in the same reconcile flow. An untargeted
step spawns a *dedicated pane*, which is a new **tab** (`herdr tab create`) — one CLI round-trip from
the already-running engine. The layout hook is an out-of-process plugin command that has to boot Node, load
config and query herdr (~300–400 ms), and its very first look at the workspace then sees 2 tabs, so
gate 7 declines: `workspace <id> is not a fresh 1-tab/1-pane workspace; skipping`. Nothing coordinates
the two — the engine never waits on the hook, and the hook never learns why it lost. The reverse order
always works, and that asymmetry is why the whole fix is a load-time rule.

**The one shape that still fails silently: no `default_layout`, layout from a `layout_matching` rule
only.** The rule is scoped to `default_layout`, like every other layout-target check, because a matching
rule commonly serves HAND-created worktrees whose step order the factory doesn't control — so a rule that
intercepts a *factory* claim can still lose its layout exactly as above, with nothing rejected at load.
(Same for hand-built worktrees and a second layout plugin.) What it looks like: no `layout_applied`
event, an extra tab labelled `<step>-<key>` (the dedicated pane's agent name), `layout_wait_retry`
events, then an attention park whose message asks *"is the herdr layout for this worktree running?"* —
pointing at herdr when the cause is the belt's own first step. The only place the real reason appears is
`herdr plugin log list --plugin herdr-factory`. Fix it by hand the same way: give `steps[0]` a
`tab`/`pane` in the matched layout, or move it after a step that targets one.

---

## Layout selection

```yaml
belt:
  - name: app
    default_layout: app-dev
    layout_matching:
      - { title: hotfixes, worktree_pattern: "hotfix/*", layout: app-dev-hotfix }
    steps:
      # The first step must target a pane (see above) — otherwise its dedicated pane's tab
      # stops the layout from ever being built, and load refuses the belt.
      - { type: work, tab: work, pane: agent }
```

`resolveBeltLayout` (`src/core/layout-match.ts`): walk `layout_matching` **in written order**; the first rule whose glob matches **and** whose `layout` id exists wins. Otherwise `default_layout` (if set and defined). Otherwise nothing is built.

- `worktree_pattern` is a glob over the **git branch name of the worktree**, not a path. Despite the key's name.
- Full-string anchored. Only `*` (any run of characters, **including `/`**) and `?` (exactly one character) are special; everything else is literal.
- `title` on a rule is documentation only.
- The branch comes from `herdr worktree list --workspace <w> --json` → the entry whose `open_workspace_id` matches (fallback: `path` == the checkout path) → its `branch`.

### A factory-claimed worktree gets only the tabs its belt uses

`pruneLayoutToBelt` (`src/core/layout-match.ts`), applied by `resolveHookLayout` for an **owned** run only. Layouts are a shared library — the same entry usually serves several belts and is written for the longest one — so a belt reusing it would otherwise come up with idle terminals and idle agents for steps it never dispatches. A `work`→`pr` belt pointing at a four-tab `work`/`evidence`/`review`/`pr` layout builds **two** tabs.

A tab survives when:

- some step on this belt names it in `tab:` (title match, exactly as `tab:`/`pane:` targeting matches it), **or**
- it hosts the layout's `setup: true` pane — the `setup.command` runs nowhere else, **or**
- one of its panes carries its own `prompt:` — the documented way to put agent work in a pane no step targets.

Everything else is dropped, agents included. Three cases prune **nothing**:

- the belt's steps target no layout pane at all (they all spawn dedicated panes) — the layout is furniture the user wants (dev servers, logs);
- no step's `tab:` matches any tab in the layout — a mismatch, left whole so the step's `layout_wait` still reports it instead of it becoming an empty build (config load catches this for a `default_layout`, not for a `layout_matching` one);
- a **hand-created** worktree — no belt dispatches into it, so nothing in it is unused.

What was dropped is logged (`layout "<id>": belt "<belt>" targets no step at tab(s) <titles> — not building them`) and recorded on the `layout_applied` event as `detail.prunedTabs`.

**Which belt gets asked** is `resolveHookLayout`: if an **active run** owns that branch, its belt decides **alone** — that belt's layout, or nothing. A layout-less belt (a `quick`/`review`/`plan` belt whose steps spawn dedicated panes) therefore gets **no** layout painted into its workspace; borrowing another belt's would break the spawn with `failed to spawn dedicated agent (no tab/pane configured)`. Only for **hand-created worktrees** (a branch no active run owns) do we walk **all** the repo's belts and take the first that yields a layout. Belts are sorted by `priority` at load, so "walk the belts" means priority order. There is no workspace-specificity scoring: one config file = one repo.

---

## The build mechanism — the herdr plugin hook

**`applyLayout` has exactly one caller: the herdr event hook** (`src/core/layout-hook.ts`). The reconciler never builds a layout, and never self-heals a missing one. (`src/core/layout.ts` carries a stale comment claiming `reconcileClaiming` builds it — it does not.)

`herdr-plugin.toml` at the factory checkout root declares id `herdr-factory`, `min_herdr_version = "0.7.5"`, three events and one startup hook, all running `["bash", "bin/herdr-factory", "layout-hook"]` (a **relative** command, so herdr must run it with cwd = plugin root):

| hook | why |
|---|---|
| `worktree.created` | the factory's own claim path |
| `workspace.created` | other creation paths |
| `workspace.focused` | the herdr UI's "new worktree" command emits **only** this to plugins |
| `[[startup]]` (`layout-hook --startup`) | once per herdr **server** start, before any event can fire: reaps claims for worktrees that vanished while herdr was down and clears the "decided" cache (whose keys are workspace ids the next server recycles). Logs `[layout-hook] startup: reaped <n> orphan claim(s)[, cleared the decided cache]`. Touches no herdr API — it runs while the server is still coming up. |

The hook dedupes, so the extra events are harmless. It reads the event **payload** (`HERDR_PLUGIN_EVENT_JSON`, `HERDR_PLUGIN_EVENT`) and never the ambient `HERDR_PANE_ID`/`HERDR_WORKSPACE_ID`, which describe whichever pane happened to be focused.

### Linking

`install.sh` links it best-effort. If `herdr` wasn't on PATH at install time it only warns:
`herdr not on PATH — skipping plugin link. Layouts won't auto-apply until you run: herdr plugin link '<APP_DIR>'`

```sh
herdr plugin link ~/.local/share/herdr-factory     # $HERDR_APP_DIR — the code checkout
```

Plugin links are **global per user** (herdr 0.7.5's breaking change — they used to be session-isolated),
so one link covers every herdr session. A link made inside a named session before 0.7.5 no longer counts
and must be redone.

If a **different** root is already linked under the id `herdr-factory`, unlink first (the id collides):

```sh
herdr plugin unlink herdr-factory && herdr plugin link ~/.local/share/herdr-factory
```

### Verifying it's registered and firing

```sh
herdr plugin list --plugin herdr-factory --json      # plugin_root, enabled, events[]
herdr plugin log list --plugin herdr-factory --limit 5
```

`plugin log list` already emits JSON — passing `--json` errors with `unknown option: --json`. Rows carry `command, event, exit_code, status, started_unix_ms, finished_unix_ms, log_id, plugin_id, stdout, stderr`.

Read the **strings**, not the status:

| row content | meaning |
|---|---|
| `stdout: applied layout "<id>"`, `exit_code: 0` | built |
| `stderr: [layout-hook] <reason>`, `exit_code: 0`, `status: succeeded` | **skipped** — a skip is a deliberate exit 0. `status: succeeded` on a hook that "did nothing" is normal. |
| `stderr: [layout-hook] <message>`, `exit_code: 1`, `status: failed` | the apply threw |

Also: `herdr plugin enable|disable herdr-factory`. `doctor` checks **none** of this — no plugin-link check, no integration check.

> **Do not run a second layout plugin on a factory-managed repo.** `herdr-plugin-workspace-manager` subscribes to the identical three events and will build a competing or duplicate layout into the same worktree — or win the race and leave the factory hook logging `not a fresh 1-tab/1-pane workspace; skipping`. Disable/uninstall it, or drop its mapping for these repos.

### Gates, in order — each string is exactly what lands in the plugin log

1. no workspace id in the payload → `no workspace id in event`
2. focus event **and** already decided → `already decided` (the hot path — no herdr query at all)
3. no checkout path → `not a worktree workspace`
4. not a linked worktree → `main checkout — never touch`
5. no configured repo whose `resolve(repo.path)` equals `resolve(repo_root)` → `no factory repo config for <repoRoot>` (a repo whose `config.yml` currently fails to load is silently skipped here)
6. no layout resolves → `no layout matches <checkoutPath>`
7. not fresh → `workspace <id> is not a fresh 1-tab/1-pane workspace; skipping`. **Plugin panes don't count**: when `pane_count` isn't 1 the hook asks herdr for the workspace's panes (`pane list --workspace`) and discounts the ones labelled by a herdr plugin — `machine.yml`'s `layout_hook.ignore_pane_labels`, default `[Sidebar]` (trimmed, case-insensitive; `[]` discounts none). Exactly one remaining pane ⇒ fresh. So a host running `herdr-sidebar` still gets its layouts, while a pane the USER opened still declines the build. Two ways to hit this that don't look like "not fresh": a belt whose **first** step has no `tab`/`pane` — its dedicated pane is a new TAB, created before the hook's snapshot, so the layout is never built — which config load now rejects for a `default_layout` belt, leaving it reachable only where the layout comes from a `layout_matching` rule (see *Mixing layout panes with dedicated panes* under Step → pane targeting); and a herdr that doesn't report `tab_count`/`pane_count`, which reads as `null !== 1` and silently declines **every** build.
8. already claimed → `layout already applied for <checkoutPath>; skipping`
9. no root TAB resolvable → releases the claim and throws `layout hook: no tab found for workspace <id>`. The root **pane** is only *measured* (its box sizes `cells` panes; `layout.apply` rebuilds the tab rather than splitting from it), so an unresolvable one is not fatal — cell sizes fall back to even splits.

On success: records a `layout_applied` event and logs `layout hook: built "<id>" into <checkoutPath>` to `<state>/<repo>/logs/<YYYY-MM-DD>.log`. On a throw: releases the claim (so a transient failure can retry), records `layout_apply_failed` `{layout, workspaceId, error}`, exits 1.

**`layout_applied`/`layout_apply_failed` for a hand-created worktree carry `run_id = null`**, and `herdr-factory timeline <KEY>` selects by run id — so they never appear there. Use `herdr plugin log list` and the daily repo log.

### Idempotency and freshness

- **Freshness is 1 tab AND 1 pane.** A restored/arranged workspace, `herdr worktree open` on an existing branch, a pane you split before the hook ran, or a **partially-failed earlier apply** all fail this gate — permanently, for that worktree.
- **Applied exactly once per worktree**, keyed on `sha1(resolve(checkoutPath))` under the layout state dir: `<state>/layout-hook/applied/<sha1>/meta.json` = `{path, ino, birthtimeMs}`. `mkdir` is the atomic cross-process lock. A recreated worktree at the same path is detected as stale (inode differs, or birthtime is newer) and re-won. The decided cache (`<state>/layout-hook/decided/<workspaceId>`) is written **only on focus events**, and cleared wholesale by the `[[startup]]` hook — it is valid only for the life of one herdr server.
- State dir = `HERDR_FACTORY_LAYOUT_STATE_DIR`, else `<stateRoot>/layout-hook` (default `~/.local/state/herdr-factory/layout-hook`). **The hook runs in the herdr daemon's environment, not your shell's** — its config dir, state root and `herdr` binary all resolve from there.

**Force a rebuild** — the worktree must also be back to 1 tab / 1 pane, so in practice:

```sh
rm -rf ~/.local/state/herdr-factory/layout-hook/applied   # drop all claims (safe: freshness still gates)
# then remove and recreate the worktree, and focus it (or `herdr worktree create` again)
```

Removing the worktree alone also works: `reapOrphanClaims()` drops `applied/` entries whose recorded path no longer exists — now run by the `[[startup]]` hook (once per herdr server start) rather than on every event, since correctness rests on the inode/birthtime staleness check, not on the sweep.

---

## The layout-wait budget

`limits.layout_wait_seconds`, default **600**. The guard attaches **only** when the step ref supplies both `tab` and `pane` — a step without a layout target never waits and never parks this way.

| phase | behavior |
|---|---|
| within the window | logs `<KEY>: <step> waiting for layout pane <tab>/<pane> (<waited>s/<limit>s)` each tick and retries. The clock is `run_steps.started_at`, created on the first attempt so it spans ticks. |
| window expires, credits left (limit **3**) | bumps the guard counter, **re-arms in place** with a **full fresh window**, records `layout_wait_retry` `{step, tab, pane, attempt, limit}`, logs `… not up after <waited>s — re-arming the wait (retry <a>/<limit>)`. |
| credits exhausted | parks: reason `layout_wait_timeout`, attention `<step>: layout pane <t>/<p> never became available`, body `<step> step (belt <belt>): configured pane <t>/<p> didn't come up with an idle agent within <N>min (3 automatic retries exhausted) — is the herdr layout for this worktree running?` |

**Total wall-clock budget is `(1 + 3) × layout_wait_seconds` = 40 min by default.** The escalation body quotes a **single** window (10 min) — it is misleading; ~40 minutes have actually elapsed.

A `layout_wait_timeout` park can never heal via `step-done` (no agent ever existed), so it is handled by the post-park auto-rescue path instead: while the guard counter is below the limit it flips the run back to `running`/`claiming`, clears the `⚠ ATTENTION` display cue the escalation published, records `resumed` `{reason: "layout_wait_respawn", …}`, and re-dispatches **on the same pass**. But the in-place re-arms and the rescue share **one** `guard_counters(run_id, step, guard)` row — so a park you actually see has already spent the budget and needs a human:

```sh
herdr-factory --repo <repo> resume <KEY>     # refunds the counter → a fresh (1+3)-window budget
```

The counter is also refunded on a successful dispatch. Related: when a live layout pane dies and no replacement resolves, the reconciler logs `<KEY>: <step> replacement pane not available — handing the retry to the layout wait` — **the engine never recreates a dead layout pane**; the hook fires once per worktree.

---

## Failure modes

| symptom | cause | fix |
|---|---|---|
| No layout at all; every `tab`/`pane` step parks `layout_wait_timeout`; `herdr plugin list --plugin herdr-factory --json` empty | plugin never linked (`herdr` absent when `install.sh` ran) | `herdr plugin link ~/.local/share/herdr-factory` |
| Old/unexpected hook behavior | plugin linked at a stale `plugin_root` | `herdr plugin unlink herdr-factory && herdr plugin link <APP_DIR>` |
| `"enabled": false`, no plugin-log rows | plugin disabled | `herdr plugin enable herdr-factory` |
| Duplicate/competing panes, or `not a fresh 1-tab/1-pane workspace; skipping` | a second layout plugin (workspace-manager) on the same events | disable it, or drop its mapping for factory-managed repos |
| `workspace <id> is not a fresh 1-tab/1-pane workspace; skipping` | reopened/arranged worktree, or a pane split before the hook ran | remove + recreate the worktree, or hand-build the tab/pane with byte-identical titles |
| `workspace <id> is not a fresh 1-tab/1-pane workspace; skipping` on **every** run, on a host whose herdr plugin adds a pane to each new tab | that plugin's pane label isn't discounted (only `Sidebar` is, by default) | add it to `layout_hook.ignore_pane_labels` in `<configRoot>/machine.yml`; for the stuck workspace, close the extra pane, `rm -rf <state>/layout-hook/decided/<ws>` and re-fire the hook |
| No `layout_applied` event, an extra tab labelled `<step>-<key>`, then every targeted step parks `layout_wait_timeout` (real reason only in the plugin log) | the belt's first step has no `tab`/`pane`, so its dedicated pane's tab beat the hook — possible only when the layout comes from a `layout_matching` rule (or the worktree is hand-built), since a `default_layout` belt is rejected at load | give `steps[0]` a `tab`/`pane` in the matched layout, or reorder so a layout-targeted step runs first |
| `layout already applied for <path>; skipping` | a reopened worktree at a claimed path | `rm -rf <state>/layout-hook/applied/<sha1>` (or the whole `applied/` dir), then recreate the worktree |
| `no factory repo config for <root>` | `resolve(repo.path)` ≠ herdr's `repo_root` — `resolve()` does **not** realpath, so a symlinked home or `/Users` vs `/System/Volumes/Data` misses | set `repo.path` to exactly what `herdr worktree list --json` reports as `repo_root` |
| `no factory repo config for …` but the path is right | that repo's `config.yml` currently fails to load (the hook swallows it) | `herdr-factory --repo <r> doctor` and fix the config error |
| `no layout matches <checkoutPath>` | the belt has neither `default_layout` nor a matching rule for that branch | add `default_layout`, or drop the steps' `tab`/`pane` and accept dedicated panes |
| Pane exists but the step waits forever | it starts no agent, or its `command` isn't a herdr-integrated harness → `agent_status` is `gone`, never `idle` | prefer an `agent:` kind; `herdr integration status`; `herdr integration install <agent>` (machine-wide — [install-and-operate.md](./install-and-operate.md)) |
| Endless wait; `tab list`/`pane list` labels differ from config | title mismatch (case, spaces, emoji), or an **untitled** tab/pane | make step `tab`/`pane` byte-identical to the layout titles; give every targeted tab **and** pane a `title` |
| Runtime park on a target that "exists" | the target is only in a `layout_matching` layout — load-time allocation checks `default_layout` only | add the pane to `default_layout` too, or accept the runtime behavior |
| Pane exists but has no `label` | the pane was built outside the factory (hand-split), or `layout.apply` was given an untitled pane | give the pane a `title` in the layout, or `herdr pane rename <id> <title>` by hand |
| `could not start <kind> in <pane>` in the log + a "agent did not start" notification | that agent's herdr integration isn't installed, or the pane never reached a shell prompt (see the preceding `not back at a shell prompt` warning) | `herdr integration install <agent>`; check the pane's own `command`/setup actually finishes |
| Every layout build fails; `stderr` mentions `layout.apply` / the socket | herdr older than 0.7.5, or a herdr CLI/server protocol mismatch | `herdr update`; `herdr-factory doctor --deep` reports both |
| `status: failed` row + `layout_apply_failed`, and every retry then skips on freshness | partial apply — the workspace is now multi-tab | fix the underlying herdr failure, then remove + recreate the worktree |
| Later tabs never spawn; the hook hangs | a `blocking: true` setup command that doesn't terminate (capped at 600 s) | make setup non-blocking, or make it exit |
| Hook reads the wrong config dir / state root | `HERDR_FACTORY_CONFIG_DIR` / `HERDR_FACTORY_STATE_ROOT` set in your shell but not in the herdr daemon's env | don't override them, or export them into herdr's environment |

Symptom-first playbooks for the resulting parks are in [troubleshooting.md](./troubleshooting.md).

---

## Worked example

Two tabs: an agent pane beside a dev server, plus a dedicated capture tab for `evidence`. `review` and `pr` take no `tab`/`pane`, so they spawn their own panes — you only need to lay out the panes you actually care about.

```yaml
layouts:
  - id: app-dev
    setup:
      command: pnpm install --frozen-lockfile
      blocking: true # nothing else spawns until deps are installed
    tabs:
      - title: work
        panes:
          - title: agent # step `work` is dispatched here
            agent: claude # herdr starts claude in this pane and waits until it's ready for input
            agent_args: [--dangerously-skip-permissions]
            setup: true # setup.command runs HERE first, before any pane's agent/command
          - title: server # no step targets this — any command is fine
            command: pnpm dev
            split: down # below the agent pane
            size: "35%" # the SERVER pane gets 35% of the tab height
      - title: verify
        panes:
          - title: capture # step `evidence` is dispatched here
            agent: claude
            agent_args: [--dangerously-skip-permissions]

belt:
  - name: app
    source: jira
    label: factory # REQUIRED on a jira/github_issues belt — the pickup label (no default); a local_markdown/sentry belt must omit it
    default_layout: app-dev
    steps:
      - { type: work, tab: work, pane: agent }
      - { type: evidence, tab: verify, pane: capture }
      - { type: review } # spawns its own dedicated pane
      - { type: pr } # spawns its own dedicated pane
```

What the hook builds, in order:

1. `layout.apply` with `tab_id` = the worktree's existing tab and `tab_label: work` — one call: `agent` | `server` split `down` at `ratio: 0.65`, both labelled, both `cwd` = the checkout, and `server` carrying `pnpm dev` as its argv. The `agent` pane's argv is `pnpm install --frozen-lockfile; printf '%s' "$?" > …; exec "$SHELL" -i`.
2. `layout.apply` with `workspace_id` + `tab_label: verify` — appends that tab with its single labelled `capture` pane.
3. Poll the setup status file until `pnpm install` records its exit code (it's `blocking`, so tab 2 waits — and the `hf_setup` token shows `running` on the pane meanwhile).
4. Then, per agent pane: wait for its shell prompt, `agent start … --kind claude --pane <id> -- --dangerously-skip-permissions` in `agent`, then the same in `capture`.

Copy-paste-ready full configs are in [recipes.md](./recipes.md).
