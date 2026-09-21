# Belts and steps

How to compose a `belt` whose `steps:` pipeline actually loads and runs — the five step primitives, what
each one declares, and every composition rule the loader enforces.

Answers these questions:

- Which steps do I need, in what order, and what does each one actually do at runtime?
- Why was my belt rejected with `requires "commits" but neither the source nor an earlier step produces it`?
- How do I add a bespoke gate (security review, QA sign-off) that can send work back?
- Where does a bounce go, how many times, and what happens at the cap?
- How do I move the Jira/GitHub status at a point in the pipeline that isn't the default?
- How do I run two pipelines off one queue and route items between them?
- How do I pause a belt, rename it, or delete it without stranding in-flight runs?

Siblings: config keys outside the pipeline → [config-reference.md](./config-reference.md); panes and the
layout hook → [layouts.md](./layouts.md); prompt bodies and tokens → [prompts.md](./prompts.md); engine
phases and the PR watch → [architecture.md](./architecture.md).

---

## 1. The model

A belt is **one work source paired with an ordered list of steps**. Everything else about its lifecycle
is *derived from what its steps declare* — there is no `belt_type` key (it was removed; the belt schema
is `.strict()`, so writing `belt_type:` is a hard `Unrecognized key: "belt_type"`).

| Derived property | Derived from | Effect |
|---|---|---|
| `watchPr` | some kept step produces `pull_request` | after the last step the run enters the `reviewing` phase and the engine watches the PR until it merges or closes — notifying the operator once when it goes green and mergeable, and **never merging it** |
| the `in_review` write-back | the `pull_request` product capability's `effectOnProduce` | firing `produce(pull_request)` → `in_review` on the source |
| a bounce path | some step declares a bounce (`evidence`, `review`, or a `custom` step with `bounce: true`) | that step may send work backward to an earlier `work`/`custom` step |
| the evidence machinery (capture cap, capture mutex, upload outbox) | some step produces `evidence` | only an `evidence` step brings it |
| `beltType` (`work_to_pull_request` \| `custom`) | `watchPr` | **display label only** — it changes no behavior |

A minimal belt:

```yaml
belt:
  - name: default
    source: jira
    label: agent-ready
    steps:
      - { type: work }
      - { type: review }
      - { type: pr }
```

Belt keys that shape the pipeline are covered here: `steps`, `effects`, `pr`, `max_bounces`, `match`,
`priority`, `active`. The rest (`workspace_name`, `branch`, `agent`, `label`, `default_layout`,
`layout_matching`) live in [config-reference.md](./config-reference.md) and [layouts.md](./layouts.md).

---

## 2. The five primitives

| | `work` | `evidence` | `review` | `pr` | `custom` |
|---|---|---|---|---|---|
| does | implement + verify + commit incrementally | drive the running app, capture video/screenshots, judge acceptance criteria | fresh-eyes code review | push, open the PR with `gh`, run the automated round | whatever your `prompt_file` says |
| consumes (**required**) | **`work_spec`**, `work_raw`, `bounce_feedback` | **`work_spec`**, **`commits`**, `handoff` | **`commits`**, `handoff`, `evidence` | **`commits`**, `handoff`, `evidence`, `close_reference` | `work_spec`, `handoff`, `bounce_feedback` (all optional) |
| produces | `commits`, `handoff` | `evidence`, `handoff` | `handoff` | `pull_request`, `commits`, `handoff` | `handoff` (+ `commits` if opted in) |
| read-only | no | **yes** | **yes** | no | opt-in (`read_only: true`) |
| default `budget_seconds` | **5400** | **2400** | **1800** | **3600** | none → ref `budget_seconds` else `limits.step_budget_seconds` (**3600**) |
| heartbeat guard | **yes** (produces `commits`) | no | no | **yes** | only with `heartbeat: true` |
| bounces | no (it is the *receiver*) | **yes** | **yes** | no | opt-in (`bounce: true`) |
| guards, in declared order | heartbeat, budget, layout_wait | budget, read_only, capture_cap, layout_wait, capture-lock | budget, read_only, layout_wait | heartbeat, budget, layout_wait | budget, layout_wait |
| skippable | no | **yes** — dropped entirely when the ref has no `tab`+`pane` | no | no | no |
| ships a prompt | `src/prompts/work.md` + per-source `jira/`, `github_issues/`, `sentry/` overrides | `src/prompts/evidence.md` | `src/prompts/review.md` | `src/prompts/pr.md` + `github_issues/pr.md` | **no** — `prompt_file` is required and is the whole body |

Notes that matter when composing:

- `handoff` is produced by **every** step and optionally consumed by `evidence`, `review`, `pr`, and
  `custom` (a `work` step declares no handoff consume, though the engine scaffold still points it at the
  prior step's note). Optional consumes are never validated — that is what makes any order structurally
  connectable.
- `commits` is only ever produced by `work`, `pr`, or a `custom` step that opts in. So `evidence`,
  `review`, and `pr` are **illegal before any commits producer**.
- `work_spec` is a root product on every source, so a `work` step is legal as the first step everywhere.
- `layout_wait` only attaches when the step sets `tab`+`pane`; `capture_cap` only attaches to a step
  that produces `evidence`. Guard order is load-bearing: heartbeat is declared before budget so a
  stall diagnosis wins a double-trip.
- Escalation reason codes you will see in `status`, in the HTTP `obligations` endpoint
  (`GET /repos/<repo>/obligations?key=<KEY>`), and narrated by `explain <KEY>`: `step_budget`, `step_stalled`,
  `read_only_violation`, `dirty_tree`, `layout_wait_timeout`, `capture_limit`, `capture_lock`, `bounce_limit`.
  Park texts and remediations → [troubleshooting.md](./troubleshooting.md).

---

## 3. Runtime behavior, per primitive

**Common to all five.** On entry the engine renders the step's prompt to
`<worktree>/.memory/herdr-factory/prompt-<step>.md`, then dispatches a one-line message to the agent:
`Read .memory/herdr-factory/prompt-<step>.md in this worktree and follow it exactly. This is an
autonomous task — do not pause to ask for confirmation.`

Pane targeting (`src/core/step.ts`):

- **`tab` + `pane` set** — the factory resolves, in order: the recorded live `pane_id`; then a pane
  matching the configured `tab`/`pane` *titles* (must be `idle`). That label stays valid for the pane's
  whole life — run state is published as display METADATA (`<step>:<KEY>` as the agent name, an
  `⚠ ATTENTION` title when parked, `hf_step`/`hf_key`/`hf_state` tokens), never by renaming the pane. A
  third tier still matches a pane renamed `<step>:<KEY>` by pre-metadata code, as a drain-window shim.
  No target ⇒ the step waits and the `layout_wait` guard runs. The factory **never spawns its own pane
  when `tab`+`pane` are set** — the layout must supply it, and config-load rejects a target pane that
  starts no agent.
- **no `tab`/`pane`** — the factory creates a tab (carrying `HERDR_FACTORY_TICKET=<KEY>`), waits for its
  shell prompt, then has herdr start the harness in it (`agent start --kind --pane`, blocking until the
  agent is ready for input) with `[agent.command, ...agent.flags, prompt]`. There is no `layout_wait`
  bound on this path; a busy dedicated pane just queues the message. That created **tab** is why the
  first kept step of a `default_layout` belt may not omit `tab`/`pane` (§4) — it beats the layout hook to
  the workspace and the build is then skipped.

**Submission is confirmed.** `herdr agent prompt` is atomic (it types and presses Enter), and the
factory asks herdr to observe the agent react (`--wait --until working`). An unconfirmed submission —
keystrokes dropped into an agent that wasn't listening — counts as **not dispatched**: the pass stays
undispatched and retries under the layout wait, instead of starting the step's budget clock against an
agent that never got the work.

Finishing is always the same protocol: write `handoff-<step>.md`, then run the rendered `step-done`
command. Signals carry `--pass N`; a `step-done` minted in an earlier pass is rejected with
`stale step-done for pass N — the X step is on pass M; finish the current pass and run its own
step-done command`, and a `bounce` from an earlier pass is rejected at consume time with
`issued on pass N of "X" but that step is on pass M`. `ask-human` is always available; `bounce` only
when the step has a resolved target.

### work

The step whose prompt owns implementing the change and committing it incrementally (the `pr` step also
commits, during its automated round — hence its own heartbeat). The **heartbeat** guard watches HEAD: no new commit
within `limits.stall_seconds` (default **2700**) parks `step_stalled`. **budget** parks `step_budget`
past `budget_seconds` (5400). Both guards **veto while the pane state is `working`** — a live agent is
never parked by a timer (logged `past <what> but still working — extending`). Both are rescued by a
genuine later `step-done` or `bounce`. Before either can trip, an agent that has sat at its prompt for
`limits.idle_nudge_seconds` (default **300**) is re-prompted once — see the idle nudge in
`references/architecture.md` §10. `work` never opens a PR and never touches the item's status.

### evidence

- **Requires a layout pane.** `requiresLayout: true` means an `evidence` step with no `tab`+`pane` is
  **silently dropped at load** — no error, no warning. The belt becomes `work → review → pr` and the
  step contributes no products, is no bounce target, and gets no `run_steps` row. This is the evidence
  opt-in — `init`'s scaffolded "add an `{ type: evidence }` step" comment omits the tab/pane half.
- **Capture-attempt cap.** The agent signals `capture-attempt` once at the start of each capture
  attempt (a retake within the same attempt is deliberately not a new signal). `attempts > limits.max_capture_attempts`
  (default **5**, so the 6th signalled attempt) parks `capture_limit`. The counter is refunded on a
  fresh *forward* entry into the step and on human `resume` — **never** on a crash-recovery respawn.
  `max_capture_attempts: 0` parks on the first attempt.
- **Non-gating by design.** `capture_limit` is a watchdog park: a later genuine `step-done` (or a
  bounce) un-parks and advances, so a flaky app cannot wedge the pipeline. Separately, publishing never
  blocks — `evidence-upload` prints the deterministic URLs up front and enqueues a durable outbox
  intent; an upload failure notifies but **never parks**. With no `evidence:` block configured it
  prints ``evidence-upload: no `evidence:` block configured for this repo — skipping publish (no URLs
  produced)`` and the step still captures and assesses.
- **Capture mutex.** A machine-global lock named `capture` (TTL 1200 s, acquire polls every 5 s up to
  1 h) serializes evidence steps — across belts *and across repos*, since all repos share one DB. It
  never parks; it is force-released when the step exits.
- Read-only (see below) and, per the shipped prompt, bounces on any acceptance criterion it cannot
  prove — but recaptures rather than bounces for its own weak takes.

### review

Read-only fresh-eyes gate; exactly one of pass-forward or bounce. **Read-only is enforced by HEAD
movement**, not by sandboxing: at spawn the engine records the branch HEAD, then *keeps tracking* live
HEAD (absorbing the prior step's trailing commits) until this step's pane is first observed `working`, at
which point the baseline **freezes**. Only a post-freeze HEAD change trips, parking
`read_only_violation`. The guard runs at the **pre_advance** stage with **no working-pane veto** — a
completed-but-violating step still parks, and a working agent that commits parks immediately; a genuine
`step-done` un-parks and advances. If the HEAD read fails at spawn there is no baseline row and the guard
is inert for that pass.

**The tree guard** (`core/tree-guard.ts`) covers the case HEAD movement cannot see — an edit nobody
committed. For every step whose resolved posture is `read_only` (so `evidence` and a `custom`
`read_only: true` step too):

- its **`step-done` is refused** — `ok:false`, exit 1, with the diff stat — while the worktree is
  dirty (`git status --porcelain`, so untracked files count). A `step_done_refused` event is
  recorded and the reason is stamped where `explain` reads it;
- it is **never dispatched onto a dirty tree**: the forward advance into it, its spawn, and a `rework`
  re-dispatch all park the run as `dirty_tree` (human-only rescue) rather than filming or reviewing a
  tree that is about to change. A park on the advance leaves the run on the step that just finished, so
  `resume` re-runs the advance once the tree is clean.

The two are deliberately split at the commit: a *commit* is the watch's park, which the step's own
`step-done` RESCUES (a completed verdict is never thrown away over misbehaviour on the way to it), and
refusing that step-done as well would wedge the run — an agent cannot un-commit. An *uncommitted* edit
is invisible to HEAD and trivially actionable, so it is refused instead.

### pr

Pushes the branch, opens the PR with `gh`, embeds the published evidence URLs from the handoff, lifts
the earlier steps' recorded assumptions out of those notes into `## Assumptions` (heading omitted when
there are none) plus a `## Not proven by any check` section — appended to the repo's own PR template,
not substituted for it, since teardown deletes the handoff notes — then
runs the **automated round** — it waits for CI and review bots and addresses their findings.
`@@PR_AUTOMATED_ROUND@@` renders the belt's `pr.automated_round_minutes`: unset ⇒ the prompt's default
(~10 min), `N` ⇒ ~N min, **`0` ⇒ skip the round entirely**.

Engine-side: on every tick the step looks up the PR (by branch, then by number once adopted) and adopts
the number on the first non-`CLOSED` sighting. An adopted PR later found `CLOSED` parks `pr_closed`.

**Adoption hands off, not `step-done`.** When the `pr` step is the belt's *terminal* PR-opening step, a
live non-draft (or merged) adopted PR moves the run to `reviewing` **without waiting for `step-done`** —
so a pr agent that keeps working or blocks on a question can't strand a mergeable PR. A **draft** PR
keeps the `step-done` gate. A `pr` step that is *not* last keeps the plain `step-done`/merge advance.

**A merged PR costs one extra tick**: even when the PR is already `MERGED` at the `pr` step, the advance
routes through `enterReviewing` (phase `reviewing`), and the merge teardown lands on the *following*
tick when the PR watch reads `MERGED`.

### custom

No shipped prompt: `prompt_file` is required and its text *is* the body (plus the engine's handover
scaffold). Budget falls back to `limits.step_budget_seconds` (3600) unless the ref sets
`budget_seconds`. It always consumes `bounce_feedback` optionally, so **every custom step is a valid
bounce target**. See §5.

---

## 4. Step ref fields

`belt[].steps[]` is `.strict()` — an unknown key is rejected.

| key | type | default | notes |
|---|---|---|---|
| `type` | `work` \| `evidence` \| `review` \| `pr` \| `custom` | — | **required**; closed enum |
| `name` | lowercase slug `/^[a-z0-9][a-z0-9_-]*$/` | **= `type`** | must be unique in the belt. Bad slug → `step name must be a lowercase slug ([a-z0-9_-], starting alphanumeric)` |
| `tab` | string | — | both-or-neither with `pane`; **both required on the first kept step of a belt that sets `default_layout`** — an untargeted first step costs that belt its layout entirely, so load rejects it (§6, and [layouts.md](./layouts.md) for the mechanism) |
| `pane` | string | — | both omitted ⇒ the factory spawns a dedicated agent pane. Harmless on any *later* step of a `default_layout` belt — the layout is already built by then |
| `budget_seconds` | positive int (quoted numbers coerce) | descriptor default → `limits.step_budget_seconds` | |
| `heartbeat` | boolean | **false** | legal on any type, but only meaningful on `custom`: it adds `commits` to `produces` **and** attaches the heartbeat guard. On `evidence`/`review` it is therefore rejected (read-only + commits). On `work`/`pr` it is a no-op |
| `prompt_file` | string | — | **required for `custom`**. Path relative to the repo's config folder (or absolute); `~` is **not** expanded here |
| `prompt_file_source` | `config` \| `repo` | **`config`** | `repo` = read from the run's worktree at render time (not existence-checked or contract-validated at load) |
| `prompt_mode` | `augment` \| `replace` | **`augment`** | `replace` drops the shipped base prose only — the scaffold, repo guidance, and token substitution all remain |
| `agent` | `.strict()` `{ command?, flags? }` | step → belt → repo → `{command: "claude", flags: ["--dangerously-skip-permissions"]}` | **whole-block, most-specific-wins** — it does *not* merge field-by-field. Only applies to panes the factory spawns |
| `consumes` | `array(enum["commits"])` | — | **`custom` only**; entries are **required** inputs |
| `produces` | `array(enum["commits"])` | — | **`custom` only**; does **not** imply a heartbeat guard |
| `read_only` | boolean | — | **`custom` only** |
| `bounce` | boolean | — | **`custom` only** |

Setting exactly one of `tab`/`pane` → `tab and pane must be set together (or both omitted to spawn a
dedicated pane)`. The TUI config editor does **not** expose `consumes`/`produces`/`read_only`/`bounce` —
those must be hand-written in `config.yml`.

---

## 5. `custom` steps

The capability allow-list is deliberately small — the only product a `custom` step may name is
**`commits`**. `produces: [pull_request]` or `[evidence]` fails at **parse** time with a raw zod enum
error (`belt.0.steps.0.produces.0: Invalid input: expected "commits"`); those drag heavy engine
machinery and stay descriptor territory.

| opt-in | effect | interaction |
|---|---|---|
| `consumes: [commits]` | appended as a **required** input | the belt is rejected unless an earlier step (or, impossibly for `commits`, the source) produces it |
| `produces: [commits]` | becomes a `commits` producer for downstream dataflow | does **not** attach the heartbeat guard |
| `heartbeat: true` | adds `commits` to `produces` **and** attaches the heartbeat guard | mutually exclusive with `read_only` |
| `read_only: true` | attaches the read-only guard (identical HEAD-movement enforcement to `review`) | mutually exclusive with producing `commits`; also makes the scaffold emit an explicit "This is a read-only step (no commits)" section, since a custom step has no base prompt describing its posture |
| `bounce: true` | resolves `canBounceTo`; counts toward `max_bounces` exactly like `evidence`/`review` | rejected if no earlier step consumes `bounce_feedback` |

A worked bespoke gate — a read-only security review between `work` and `pr` that can send work back:

```yaml
belt:
  - name: default
    source: jira
    label: agent-ready
    default_layout: dev
    steps:
      - { type: work, tab: work, pane: agent }
      - type: custom
        name: security-review
        read_only: true          # may not commit; HEAD movement parks the run
        bounce: true             # may send the work back to `work`
        tab: security
        pane: agent
        budget_seconds: 1200
        prompt_file: prompts/security-review.md
      - { type: pr, tab: pr, pane: agent }
```

Resolves to: `security-review.readOnly = true`, `canBounceTo = ["work"]`, guards
budget + layout_wait + read_only, and the belt still has `watchPr = true` from the `pr` step. The
prompt file must satisfy the prompt contract (see [prompts.md](./prompts.md)) — it is validated at load
because `prompt_file_source` defaults to `config`.

A custom code-writer plus a custom checker also composes — `scaffold` below is a `commits` producer but
gets **no** heartbeat guard (that is the separate `heartbeat: true` opt-in):

```yaml
steps:
  - { type: custom, name: scaffold, produces: [commits], prompt_file: prompts/scaffold.md }
  - { type: custom, name: check, consumes: [commits], read_only: true, prompt_file: prompts/check.md }
```

---

## 6. Composition rules (the dataflow check)

Validation happens in two passes. **First, skipped steps are removed** — a `requiresLayout` step
(today only `evidence`) with no `tab`+`pane` is dropped **from the dataflow pass**: it contributes no
products, is no bounce target, and can't collide on a layout pane. It still exists for the per-step
checks over the *written* list — it holds its step name (a second bare `{ type: evidence }` is a
duplicate-name error), it still trips the capability-opt-in / `prompt_file` / `prompt_mode` rules, and
an `on: enter` effect may still name it (see §8). Then the loader walks the kept steps in order with a
set of `available` products seeded from the source:

| source type | products available at belt start |
|---|---|
| `jira` | `work_spec`, `work_raw`, `human_reply` |
| `local_markdown` | `work_spec`, `human_reply` |
| `github_issues` | `work_spec`, `work_raw`, `human_reply`, `close_reference` (the work doc's `Closing reference:` line — absent under `kind: pull_requests`, which carries the PR's head/base branch instead) |
| `sentry` | `work_spec`, `work_raw`, `human_reply` |

For each step: every **required** consume must already be in `available`; a declared bounce must have an
earlier `bounce_feedback` consumer; then the step's `produces` are added to `available`. Optional
consumes are never validated — they simply drop their prompt clause and tokens.

### Legal

```yaml
# the shipped four-step pipeline (drop every tab/pane to get `init`'s dedicated-pane default,
# which also silently drops the evidence step)
steps:
  - { type: work,     tab: work,     pane: agent }
  - { type: evidence, tab: evidence, pane: agent }
  - { type: review,   tab: review,   pane: agent }
  - { type: pr,       tab: pr,       pane: agent }

# all-custom belt: no PR machinery; the run tears down `completed` when the last step signals done
steps:
  - { type: custom, name: research, prompt_file: prompts/research.md }
  - { type: custom, name: propose,  prompt_file: prompts/propose.md, budget_seconds: 1800 }

# custom → custom bounce (a custom step always accepts bounce_feedback)
steps:
  - { type: custom, name: draft, prompt_file: prompts/draft.md }
  - { type: custom, name: gate,  bounce: true, prompt_file: prompts/gate.md }   # canBounceTo == ["draft"]
```

### Illegal, with the exact error

Every message below is prefixed by `invalid config for repo "<name>" (<path>):` and reported at a dotted
path such as `belt.0.steps.1`.

| `steps:` (or belt) | error |
|---|---|
| `[{type: review}, {type: pr}]` — no `work` | `belt "X" step "review" requires "commits" but neither the source nor an earlier step produces it` |
| `[{type: evidence, tab: e, pane: a}, {type: work}]` | `belt "X" step "evidence" requires "commits" but neither the source nor an earlier step produces it` |
| `[{type: custom, name: audit, consumes: [commits], prompt_file: a.md}]` first | `belt "X" step "audit" requires "commits" but neither the source nor an earlier step produces it` |
| `[{type: custom, name: gate, bounce: true, prompt_file: g.md}]` first | `belt "X" step "gate" declares a bounce but no earlier step consumes bounce_feedback` |
| `read_only: true` + `produces: [commits]` (or + `heartbeat: true`) | ``belt "X" step "bad" (type custom) is read-only and cannot produce commits — drop `read_only`, or remove `produces: [commits]`/`heartbeat` `` |
| `heartbeat: true` on `evidence` or `review` | the same read-only/commits message (heartbeat ⇒ commits) |
| `read_only`/`bounce`/`consumes`/`produces` on a non-`custom` step | ``belt "X" step "work" (type work) cannot declare `read_only` — capability opt-ins are only for `custom` steps (a work step's capabilities are fixed by its primitive)`` (one issue per offending field) |
| `{type: custom, name: x}` with no `prompt_file` | `belt "X" step "x" (type custom) needs a prompt_file — it has no built-in prompt` |
| `{type: custom, …, prompt_mode: replace}` | `belt "X" step "x" (type custom) has no built-in prompt to replace — its prompt_file is already the whole body; drop prompt_mode` |
| `{type: work, prompt_mode: replace}` with no `prompt_file` | `belt "X" step "work" sets prompt_mode: replace but has no prompt_file — there is nothing to replace the built-in prompt with` |
| two steps on the same `tab`+`pane` | `belt "X" steps "work" and "review" target the same layout pane (tab "work", pane "agent") — each step needs its own agent pane` |
| `[{type: work}, {type: work}]` | `belt "X" has duplicate step name "work" (name defaults to type — give one an explicit unique name)` |
| `steps: []` | `a belt needs at least one step` |
| `{type: work, tab: work}` (no `pane`) | `tab and pane must be set together (or both omitted to spawn a dedicated pane)` |
| `[{type: work}, {type: review, tab: r, pane: agent}]` on a belt with `default_layout: L` — the first **kept** step is untargeted | ``belt "X" sets default_layout "L", but its first step "work" has no `tab`/`pane` — that step spawns a dedicated pane, whose new tab makes the layout hook skip the build ("not a fresh 1-tab/1-pane workspace"), and every later layout-targeted step then parks with `layout_wait_timeout`. Give the first step a tab/pane in "L", reorder so a layout-targeted step runs first, or remove default_layout from this belt.`` (reported at `belt.0.steps.0.pane` — the offending step's index in the **written** list, so a dropped bare `{type: evidence}` written ahead of it would make it `steps.1`) |
| `{type: research}` | zod enum error on `belt.0.steps.0.type` (closed enum) |
| `produces: [pull_request]` on a custom step | parse-time zod enum error (`commits` is the only allowed value) |
| `pr:` block on a belt with no `pr` step | ``belt "X" sets a `pr:` behavior block but has no step that opens a pull request — add a `pr` step or remove the block`` |

Two more traps:

- A step's `tab`/`pane` is only checked against a layout when the belt sets `default_layout`
  (`belt "X" step "N" targets pane t/p, but layout "L" does not define it — its labeled panes are: …`),
  and so is the first-kept-step rule above. With no `default_layout`, a typo surfaces only at runtime as
  a `layout_wait_timeout` park — and a belt whose layout comes *only* from a `layout_matching` rule can
  still lose the layout outright to an untargeted first step, silently, with the reason visible nowhere
  but `herdr plugin log list --plugin herdr-factory` ([layouts.md](./layouts.md)).
- A belt whose **only** written step is a bare `{ type: evidence }` passes validation (`min(1)` applies
  to the written list) and resolves to **zero** kept steps. UNVERIFIED what the reconciler does with a
  zero-step belt — don't ship one.

---

## 7. Bounces

**Target resolution happens at load.** For a bouncing step at index *i*, the loader scans the kept
steps **forward from index 0** and takes the first one whose *descriptor* consumes `bounce_feedback` —
so the target is the **earliest** accepting step, not the nearest. Only `work` and `custom` accept;
`evidence`, `review`, and `pr` can never be bounce targets. In `work → custom(draft) → review`,
`review.canBounceTo == ["work"]`. The result is always 0 or 1 elements; empty ⇒ the config is rejected.
The engine enforces membership, so an agent cannot pick a different target.

**Applying a bounce** (`bounce <KEY> <toStep> --reason-file … --step <from> --pass N`):

1. The cap is checked **first**: `max_bounces = belt.max_bounces ?? limits.max_bounces` (default **6**).
   The counter is bumped, then `bounces > max_bounces` parks `bounce_limit` and returns
   `ok: true, escalated: true` with `bounce limit exceeded — escalated to attention` — the agent is
   *told the run parked*; it is not an error. `max_bounces: 0` disables bouncing.
2. Any `exclusive_resource` the bouncing step held is released.
3. **Every step from the target up to (not including) the bouncer** is marked not-done and has its
   clocks re-based — so a `review → work` bounce forces `evidence` to re-capture too.
4. The target's `pass` increments; `feedback-<toStep>.md` is written from the bouncer's reason file, and
   the target's re-rendered prompt gets a "⚠ Rework requested — READ THIS FIRST" banner keyed on that
   file's existence. On the target's next completion the note is archived as
   `feedback-<toStep>-addressed-pass<N>.md`.
5. The run returns to `running` on the target and its own pane is re-prompted.

The bouncer does **not** signal `step-done`, so once the target re-completes, the forward pass re-enters
the still-not-done bouncer, bumping *its* pass and re-basing its clocks.

The operator's **`rework <KEY> <toStep> --note "…"`** runs steps 1–5 identically (cap included) — it is
the same engine path in operator mode — but records a `rework` event instead of `bounced`, lands from
any live phase including a park, ignores `canBounceTo`, and may target the step that is currently
running. Forward, `reviewing` and teardown are refused. See [cli.md](./cli.md).

**Counting.** The counter is keyed on the **target** step (`guard_counters(run, targetStep, bounce_cap)`)
and is cumulative for the run's life — it has no automatic refund. Only a human `resume` from a
`bounce_limit` park refunds, and because the counter is per-target it refunds **belt-wide** (every
step's counter). The HTTP obligations endpoint (`GET /repos/<repo>/obligations?key=<KEY>`, add
`&source=` to disambiguate) lists `bounceCaps: [{step, count, max}]` for every step with a non-zero
count; `explain <KEY>` prints the same counters as a `Rework bounces so far:` line.

Rejection messages: `no running step to bounce from`; `step "X" is not in belt "B"`;
`X is not before Y — bounces only go backward`; `the Y step may not bounce to X`. Every bounce is
validated at consume time and can also be rejected with
`issued by step "X" but the run has moved to "Y"` or `issued on pass N of "X" but that step is on pass M`.

---

## 8. `effects` — configurable task progression

`effects` re-points *when* the belt writes a status back to the work source. Each entry is `.strict()`
and needs a trigger plus `to`:

| `on` | extra key | legal values | engine default for that trigger |
|---|---|---|---|
| `enter` | `step` | any step **name** in the belt | entering the **first** step → `in_development` |
| `produce` | `product` | **only** `evidence` \| `pull_request` | producing `pull_request` → `in_review` |
| `teardown` | `outcome` | `merged` \| `closed` \| `abandoned` \| `timeout` \| `completed` | `merged`→`merged`, `completed`→`done`, `closed`/`abandoned`/`timeout`→`aborted` |

A belt effect on a trigger **replaces** that trigger's engine default. Triggers with no default fire
only when configured (e.g. entering a non-first step, producing `evidence`).

**Of the five outcomes, the engine only ever writes three**: `merged` (PR merged), `completed` (last
step done on a belt with no PR watch) and `abandoned` (manual `teardown`, stale-item abort, fallbacks).
No path in `src/core/reconcile.ts` tears down with `closed` or `timeout` — they are legal in the type
and in config, so a `{ on: teardown, outcome: closed }` effect loads without complaint and then never
fires. Don't write one.

`to` is either a **canonical state** — `todo`, `in_development`, `in_review`, `merged`, `aborted`,
`done` — or a **source-native custom status key**. A custom key **requires `anchor:`** (a canonical
state fixing its lifecycle rank) and must be declared in the source's own map (`jira.status.<key>` or
`state_labels.<key>`).

Semantics:

- **Forward-only.** Rank is `todo` 0, `in_development` 1, `in_review` 2, `merged`/`done`/`aborted` 3; a
  custom status ranks `anchor − 0.5` (it sits *just before* its anchor stage). An effect whose rank is
  strictly lower than the highest already enqueued for the run is a logged no-op, so a bounce or a
  forward re-advance can never walk the source backward.
- **Internal-ledger sources reject custom statuses.** `local_markdown` and `sentry` keep status in the
  factory's own `work_items` table and support canonical states only.
- **One effect per trigger.** Two entries on the same trigger →
  `belt "X" has two effects on the same trigger (produce pull_request) — a trigger maps to exactly one status`.
- `on: enter` validates against **all written** step names (including a skipped `evidence`), while
  `on: produce` validates against the **kept** steps' products — so an effect on entering a skipped
  step loads fine and never fires.

Worked example — a Jira board with extra columns:

```yaml
work_sources:
  - type: jira
    name: jira
    jira:
      base_url: https://acme.atlassian.net
      project: ACME
      board: 254
      status:
        in_development: In Progress
        review: In Review        # NOTE: the canonical jira key is `review`, not `in_review`
        qa: QA                   # custom key, targetable by an effect
        shipped: Shipped

belt:
  - name: default
    source: jira
    label: agent-ready
    steps:
      - { type: work,     tab: work,     pane: agent }
      - { type: evidence, tab: evidence, pane: agent }
      - { type: review,   tab: review,   pane: agent }
      - { type: pr,       tab: pr,       pane: agent }
    effects:
      - { on: produce,  product: evidence, to: qa, anchor: in_review }  # captured evidence ⇒ "QA"
      - { on: teardown, outcome: merged,   to: shipped, anchor: merged } # merged ⇒ "Shipped", not "merged"
```

Rejection messages: `belt "X" effect on entering step "qa" — no such step in the belt (steps: work,
review, pr)`; `belt "X" effect on producing "evidence" — no step in the belt produces it`; and for a
missing anchor, ``belt "X" effect target "qa" is not a canonical state (todo, in_development,
in_review, merged, aborted, done); as a custom source status it needs an `anchor` (a canonical WorkState
fixing its lifecycle rank)``.

---

## 9. The belt-level `pr:` block

| key | type | default |
|---|---|---|
| `draft` | boolean | unset |
| `title` | string template (same vars as `workspace_name`: `{{work_id}}`, `{{work_type}}`, `{{work_slug}}`, `{{work_full_slug}}`, `{{semantic_work_prefix}}`), rendered verbatim | unset |
| `labels` | array of strings | unset |
| `reviewers` | array of strings | unset |
| `assignees` | array of strings | unset |
| `automated_round_minutes` | non-negative int — **`0` is legal** and skips the CI/bot round | unset ⇒ the prompt's default (~10 min) |

These are **prompt policy, not engine enforcement**: they render into `@@PR_OPTIONS@@` and
`@@PR_AUTOMATED_ROUND@@`, and the `pr` agent is the single actor that runs `gh pr create`. The shipped
`pr` prompt says this block wins over the repo's own PR conventions on title/draft/labels/reviewers/assignees.

The block is **rejected** on a belt with no `pull_request`-producing step (it would silently no-op):
``belt "X" sets a `pr:` behavior block but has no step that opens a pull request — add a `pr` step or
remove the block``.

```yaml
    pr:
      title: "{{work_id}}: {{work_full_slug}}"
      labels: [agent]
      automated_round_minutes: 0     # skip the CI/bot round entirely
```

---

## 10. Multiple belts and `match`

Belts run in parallel; they are independent pipelines sharing the repo's concurrency limits.

- **Ordering.** Belts are stable-sorted by `priority` **ascending** (default **100**, negatives
  allowed); ties keep config order. At claim time the **first** belt whose `match` accepts an item wins.
- **Dedup.** Once *any* belt has an active run for a `(source, key)` pair, no other belt claims that
  item — which is what makes "first matching belt wins" hold across the pass.
- **The distinct-label rule.** Two belts may share one source only via **distinct** `label`s. Identical
  `(source, label)` is rejected: `belts "A" and "B" both pick up "jira" work by label "agent-ready" —
  they'd contend for the same items; give each belt a distinct label`. `label` is **required** for
  `jira` and `github_issues` (they pick up by label/trigger label) and **forbidden** for
  `local_markdown` and `sentry` — those belts route by `match` and `priority` instead.

**`match` module contract.** `match:` is a path to a `.ts` file, resolved relative to the repo's config
folder (`~/.config/herdr-factory/repos/<name>/`) or absolute. `~` is **not** expanded. It must
`export default` a function taking one `ctx` and returning `boolean` or `Promise<boolean>`; Node strips
the types on import, so there is no build step.

`ctx` is `{ item, source }`:

- `source` — `{ name, type }`.
- `item` — `{ key, summary, type, displayKey?, url?, sourceType, labels: string[], fields: {} }`, plus
  per-source extras: `jira` adds `status`; `local_markdown` adds `path`, `filename`, `frontMatter`,
  `body`; `github_issues` adds `number`, `repo`, `state`, `assignees`, `author`, `body`; `sentry` adds
  `shortId`, `project`, `status`, `level`, `culprit`, `count`, `userCount`, `permalink`. `labels` is
  always an array (`[]` when the source has no label concept) and `fields` is the raw source payload.

```ts
// ~/.config/herdr-factory/repos/acme/match-frontend.ts
export default ({ item }) => {
  if (item.sourceType === "sentry") return (item.level ?? "") === "fatal";
  const area = String(item.fields?.customfield_10050?.value ?? "");
  return item.labels.includes("frontend") || area === "Web";
};
```

```yaml
belt:
  - name: frontend
    source: jira
    label: agent-ready
    priority: 10                    # tried first
    match: match-frontend.ts
    steps: [{ type: work }, { type: evidence, tab: evidence, pane: agent }, { type: review }, { type: pr }]
  - name: backend
    source: jira
    label: agent-ready-be           # MUST differ from the frontend belt's label
    priority: 100
    steps: [{ type: work }, { type: review }, { type: pr }]
```

Failure modes: a missing file throws at load (`belt "X": match not found: /abs/path`); a default export
that isn't a function throws at startup (``belt match file /abs/path must `export default` a function
(got object)``); a predicate that **throws at claim time** is logged
(`belt frontend: match predicate threw for ACME-1: <err>`) and the item is skipped for that belt.

---

## 11. `active: false` — the pause switch

```yaml
  - name: default
    active: false
```

`active` gates **new claims only**. An inactive belt is skipped *before* its source is polled (so the
source isn't polled or poll-stamped on its behalf), logged as
`belt <name>: inactive — skipping (no new claims; in-flight runs continue)`. In-flight runs of that belt
keep reconciling normally and finish. It is a zero-cost temporary pause. Note `active` is a strict
boolean — `active: "false"` is **rejected**.

---

## 12. Renaming and deleting a belt

A run records its belt **name** at claim and never updates it, so the name is the belt's identity.

- **Rename** — the TUI/server infers a rename only when it is unambiguous: exactly one belt name
  disappeared, exactly one appeared, and their bodies (every field except `name`) are **identical**. It
  then migrates every run — active *and* historical — to the new name and records a `belt_reassigned`
  event. A rename tangled with an edit, or several renames at once, degrades safely to delete + add.
- **Delete** — **refused while the belt has any in-flight run**:
  `belt "X" has 2 run(s) in progress — let them finish or tear them down before deleting it`. The guard
  is all-or-nothing: if any deleted belt is busy, *nothing* is applied (no rename migrates either) and
  the whole config change is refused. With no live runs, the belt's run rows and child rows are purged
  (the events timeline is kept) and any leaked worktree is reaped.
- **The same guard runs at reload**, so hand-editing `config.yml` to drop a busy belt is refused too.
  If a belt does vanish out from under live runs, they park for attention with `belt_missing`
  (`belt "B" not configured`) — re-add it or tear the runs down.

**Nothing migrates a renamed *step*.** An in-flight run's per-step rows keep the old step name, and the
reconciler parks the run with `unknown_step` (`step "X" is not in belt "B"`). Reordering or renaming
steps of a belt with live runs has the same effect. Let runs drain, or tear them down, before changing a
belt's step names.
