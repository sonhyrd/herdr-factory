# Design — Step primitives, product capabilities, and composable belts

**Status:** implemented (2026-07) · **Scope:** full redesign in one pass · **Config:** clean break
(no back-compat alias) · **Anchor:** `work_to_pull_request` resolves byte-identically to the
historical `PR_STEPS` (asserted in `test/config.test.ts`). The sections below are the original
proposal (kept for rationale); **Implementation status** immediately after records — verified against
source — where the shipped code matches, diverged, or deferred.

> Goal: make a `custom` belt **exactly as reliable, powerful, and composable as
> `work_to_pull_request`**. Today custom steps get the dumb subset — no bounce, no evidence, no
> read-only gate, no PR-watch, no typed handoff, and no load-time guarantee the pipeline is even
> coherent. This turns every capability w2pr enjoys into a **declared, reusable primitive** the
> reconciler wires generically, and adds **load-time typed-dataflow validation** so a hand-built
> belt fails at config-parse time instead of mid-run.

---

## Implementation status (as-built — verified against source)

The redesign shipped. The three registries, the clean-break belt model, load-time dataflow
validation, `read_only` enforcement, the `run_products` table, and the render-time optional-consume
dropping are all live. This table is the delta between the proposal below and the shipped code.

**Shipped as designed**

- **§1/§3 — three registries.** `STEP_DESCRIPTORS` (`src/steps/registry.ts`: `work`/`evidence`/`review`/`pr`/`custom`), `PRODUCT_CAPABILITIES` (`src/products/registry.ts`), `SIGNAL_DESCRIPTORS` (`src/signals/registry.ts`). The reconciler branches on declarations (`consumes`/`produces`/`controls`/`guards`/posture), never a step name.
- **§4 — the resolver prompt is a first-class library entry.** `src/prompts/resolver.md`, rendered by `core/watch.ts` (`wakeResolver`): tokenized (`@@KEY@@`/`@@PR_NUMBER@@`) and source-overridable, with the slug + token set + overridability all read from the `pull_request` watch capability's `WatchResolverSpec.wakePrompt`. It's written into the worktree and dispatched via a one-line read-pointer, exactly like a belt step, on the work step's pane/agent (issue #88; it originally reused the pr step's pane).
- **§6 — effects.** `belt_start → in_development` is the engine default at claim; `produce(pull_request) → in_review` rides the `pull_request` capability's `effectOnProduce`; both fire forward-only/monotonic through the transition outbox. **Exposed to config (w2-02):** an optional per-belt `effects` block maps the same three trigger families (step enter / product produce / teardown outcome) to a status — a canonical `WorkState` or a **source-native custom status** (widened jira `status.<key>` / github_issues `state_labels.<key>`) delivered via the outbox's new `to_status` column while `to_state` stays the canonical anchor. Monotonicity is now explicit — `fireEffect` refuses an effect ranking below the run's highest enqueued rank (custom statuses rank at `anchor − ½`). Internal-ledger sources keep the canonical states only (custom rejected at load); the charter gains INV-13 (custom statuses map at the source layer).
- **§7 — `read_only` declared *and* enforced.** HEAD movement during a read-only step (`evidence`/`review`) parks the run (`core/reconcile.ts`; baseline HEAD captured at spawn in `core/step.ts`).
- **§8 — typed dataflow, both halves.** Load-time: a required consume with no upstream producer rejects the belt, and a bounce emitter needs an earlier `bounce_feedback` consumer (`config.ts` `superRefine`). Render-time: an unsatisfied *optional* consume drops its `@@TOKEN@@`s and its `@@WHEN:<product>@@…@@END@@` clause (`productActiveFor` / `stripInactiveProductBlocks` in `core/step.ts`), so a work→review→pr belt never references evidence it didn't capture.
- **§9 — one engine effect per run-scoped signal.** `applySignal` (`src/core/signals.ts`) is the single implementation of `step-done`/`ask-human`/`bounce`/`capture-attempt`, called by BOTH the HTTP handler (`server/app.ts`, thin shells) and the CLI's in-process fallback (`cli/index.ts`, via `dispatchSignal`) — so the effect logic and the lock discipline (`withRunLock` for the fire-and-forget `step-done`, `withRunLockWaiting` for the rest, matching each descriptor's `lockDiscipline`) live in exactly one place instead of duplicated across two files with hand-picked locks. `capture-attempt` carries its explicit `step` arg; `evidence-upload` is scoped `product-outbox` + routed through the durable `evidence_publish` intent-ledger kind (the `evidence_uploads` table this originally named was dropped in v35); the `@@*_CMD@@` prompt tokens come from the registry (`signalCommand`). Seam covered by `test/reconcile.test.ts` ("applySignal — shared run-scoped agent signal effect").
- **§10 — `run_products` table (migration v18).** PR-watch state (`pr_number`/`resolver_active`/`last_thread_sig`) moved off `runs`; `countOccupying` joins it, so a `reviewing` run occupies a claim slot only while its resolver is active. `StepName` widened to an open `string`.
- **§5/§10 — generalized guard counters (migration v21).** `guard_counters(run, step, guard)` backs both caps — the bounce cap keyed `(run, targetStep, "bounce_cap")` and the evidence capture cap `(run, step, "capture_cap")` — so a second capped guard on one step no longer collides on the old single `capture_attempts` column. `GuardSpec.counterScope: "run+step+guard"` declares it (test-pinned). The old `run_steps.bounces`/`capture_attempts` columns are superseded (left unread, per the v2–v3 precedent). Store: `bumpGuardCounter`/`guardCounter`/`resetGuardCounter`; resume now resets per-guard, so it no longer touches a non-evidence step (the old unconditional `captureAttempts:0` leak).
- **§9 — `exclusive_resource` guard (the capture mutex).** The `evidence` descriptor declares `exclusive_resource("capture")`; its `@@CAPTURE_LOCK_ACQUIRE_CMD@@`/`@@CAPTURE_LOCK_RELEASE_CMD@@` tokens are injected only for a declaring step, with the resource name flowing from the guard (one source of truth, not a hardcoded CLI string + prose). The engine **backstop-releases** the lock when the run leaves the step (`releaseStepLocks` on advance/bounce), so a forgotten release frees the resource immediately instead of waiting its TTL. The `capture-lock` CLI is resource-parameterized (`capture-lock <action> <resource> [owner]`) and stays deliberately **machine-scoped / CLI-only** (never an HTTP signal — a worker on the same machine acts on the shared DB directly).
- **§11 — clean break.** `belt_type` and the `agents:` map are gone from config input; a belt is one ordered `steps[]`. `config.schema.json` regenerated (drift-tested in `test/config.test.ts`).
- **§12 — contract suites.** Per-descriptor (`test/step-descriptor-contract.test.ts`) + belt-composition + the w2pr byte-identical anchor (`test/config.test.ts`, "recreates work_to_pull_request byte-identically"). A dedicated render-gating suite: `test/step-prompt-dataflow.test.ts`.

**Diverged from the proposal**

- **§2 — `basePrompt` is optional (`basePrompt?`), not always-present.** `custom` ships no base prompt and the `enginePrompt === undefined` assembly branch in `core/step.ts` was **kept** (the proposal expected the placeholder to erase it).
- **§2 — no `tui?: StepFieldSpec` on `StepDescriptor`.** TUI step rows are still rendered by `tui/config-fields.ts`, not descriptor-driven.
- **§11 — a `beltType` value survives as a display-only label** on the resolved belt (`config.ts`; shown in CLI/TUI/server), derived from `watchPr` and never branched on by the reconciler. "Gone" holds for config *input*, not the derived label.

**Deferred (designed, not built)**

- **§9 — per-signal route/command *declarations* stay explicit** (each signal's zod body/response schema + a thin route + a thin CLI command owning its arg parsing / output formatting); those thin shells delegate to `applySignal` rather than being *generated* by iterating `SIGNAL_DESCRIPTORS`. The effect fan-out the design railed against is gone; the declaration boilerplate (irreducibly per-signal) is not looped away. `evidence-upload` stays a CLI-local `product-outbox` action, not an HTTP route.
- **§13 — plugin *loading* (discovery/sandboxing)** stays out of scope; the three registries are the seam.

---

## 0. The finding that reshapes the effort

An audit of all 119 coupling points across `reconcile`, `step`, `config`, `store`, `cli`, `server`,
`doctor`, `tui`, and `test` produced one dominant result:

> **The engine core is already belt-agnostic.** The only step-name literal in all of `src/core` is
> `branch.ts`'s Jira issue-type→prefix heuristic. `reconcile.ts` / `step.ts` already drive off
> `StepConfig` flags (`opensPr`, `gathersEvidence`, `canBounceTo`, `heartbeat`) and `belt.watchPr`.
> `config.ts:668` even carries a comment: *"bounce/evidence are belt-agnostic once resolved onto
> StepConfig, so custom belts can grow them later."*

So this is **~90% a `config.ts` + registry + signal-surface + tests change, and ~10% a reconciler
change.** The reconciler stops branching on booleans-that-only-w2pr-sets and starts branching on
**declarations that any belt can carry**. What changes most is *how a `StepConfig` is produced*,
not how it is consumed.

The audit also killed four assumptions in the naive "each step is a primitive" model — each is a
place the redesign would otherwise re-introduce the exact "second state machine" that the
codebase's own `WorkSourceSpec` idiom exists to prevent:

1. **The PR-watch resolver is an agent that lives *outside* `belt.steps`** (`watch.ts`, its own
   pane, its own `resolver_active` occupancy). A steps-only model has no home for it. → forces a
   **second registry** (product capabilities).
2. **`opensPr` (mid-pipeline PR adoption) and `watchPr` (terminal watch) are independent facets**
   of one `pull_request` product. Merging them breaks the "ours-vs-stale-CLOSED" guard that runs
   *before* the last step. → keep three facets separate.
3. **The agent-signal surface (CLI + HTTP + zod + OpenAPI + token + lock-discipline) is a 5–6 file
   hand fan-out with no registry.** "Plugins register via the same seam" is false at the boundary
   the agent actually calls. → forces a **third registry** (signal descriptors).
4. **Guards carry load-bearing per-guard lifecycle** (capture-cap resets on forward-entry but *not*
   crash-respawn; cumulative-vs-per-pass; auto-rescue-on-done). A flat set loses the reliability.

---

## 1. The model: three registries, mirroring `SourceDescriptor`

The codebase already has the exact idiom to copy — `sources/registry.ts` (one `SourceDescriptor`
per type, the single edit surface) + the declarative `WorkSourceSpec` *"consumed by doctor / TUI /
contract-suite ONLY — the reconciler never branches on it, so it can't drift into a second state
machine."* We mirror it three times.

| Registry | Unit | What it owns | Shipped entries |
|---|---|---|---|
| **`STEP_DESCRIPTORS`** | a step primitive | base prompt + declared `consumes`/`produces`/`controls`/`guards`/`effects`/`posture` | `work`, `evidence`, `review`, `pr` |
| **`PRODUCT_CAPABILITIES`** | a typed product | engine machinery a product switches on: tokens, durable outbox, PR-adoption identity, **the terminal watch + its resolver agent**, occupancy posture | `work_spec`, `commits`, `handoff`, `evidence`, `pull_request`, `close_reference`, … |
| **`SIGNAL_DESCRIPTORS`** | an agent→dispatcher signal | route + command + token + request/response schema + lock discipline + engine effect — auto-mounted into CLI, HTTP, and OpenAPI | `step-done`, `bounce`, `ask-human`, `capture-attempt`, `evidence-upload`, `capture-lock` |

The reconciler branches **only on declarations**, never on step name or a former `belt_type`.
`work_to_pull_request` becomes a **documented starter template** whose four step refs resolve —
through `descriptorFor(step.type)` — to a `StepConfig` array byte-identical to today's `PR_STEPS`.

### Import-cycle note
`config.ts`'s `superRefine` already imports `descriptorFor` for sources (`config.ts:283`), so the
step registry is importable from the same place for load-time validation. New registry machinery is
wrapped in `telemetrySpan` exactly like `instrumentObject` wraps source clients today, and any new
concurrency uses the shared Effect runtime — consistent with the existing resiliency/telemetry
posture.

---

## 2. A `StepDescriptor`

```ts
interface StepDescriptor {
  readonly name: string;                 // OPEN slug (StepName widened from a closed union)
  readonly basePrompt: PromptRef;        // { slug; perSourceOverride } — ALWAYS present.
                                         //   custom's is an empty/placeholder entry, so the
                                         //   enginePrompt===undefined assembly branch disappears.
  readonly consumes: readonly InputSpec[];   // { type: ProductType; required: boolean }
  readonly produces: readonly ProductType[];
  readonly controls: {
    // step_done + ask_human are ALWAYS available (never declared).
    bounce?: { toEarliestConsumerOf: "bounce_feedback"; targets?: string[] }; // emit side
    posture?: { readOnly?: boolean; requiresLayout?: boolean };
  };
  readonly guards: readonly GuardSpec[];     // each carries its own lifecycle (§5)
  readonly effects: readonly EffectSpec[];   // source-lifecycle transitions (§6)
  readonly tui?: StepFieldSpec;              // editor rows — mirrors SourceDescriptor.tui
}
```

### The `consumes` / `produces` type vocabulary (closed)

| Product | Produced by | Consumed by | Engine machinery it switches on |
|---|---|---|---|
| `work_spec` | **source** (`materialize` at belt_start) | first step | `materializeWork` + `src.client.workDoc` → `@@WORK_DOC@@`/`@@WORK_DOC_KIND@@`. *This is the reference pattern.* |
| `work_raw` | source (raw payload path) | per-source work prompts | `@@WORK_RAW@@` — replaces `ticket.json`/`issue.json`/`fields.comment` hardcoded in per-source prompts (they bypass the clean `workDoc` seam today). |
| `commits` | any code-writing step (`work`) | `evidence`, `review`, `pr` | makes the `heartbeat` guard meaningful; makes the per-attempt branch uid relevant; a `read_only` step must **not** produce it. |
| `handoff` | **every step — mandatory, always produced (may be empty)** | the nearest earlier producer | `@@HANDOFF_IN@@`/`@@HANDOFF_OUT@@` wired to the **nearest earlier producer** (not blind step N-1); the finish protocol always writes it + the prior pane/session pointer. |
| `evidence` | `evidence` (**optional** — step is skippable) | `review`, `pr` (both **optional** consumes) | S3 upload outbox + `@@EVIDENCE_DIR@@`/`@@EVIDENCE_UPLOAD_CMD@@`/`@@CAPTURE_ATTEMPT_CMD@@` + `capture_cap` guard + `capture-lock`. Upload is best-effort (the `evidence:` block is optional). |
| `pull_request` | `pr` | the terminal **watch** capability | PR adoption/identity (poll by branch → number, "ours-vs-stale-CLOSED" guard), per-attempt branch uid, and the `produce → in_review` effect — **decoupled from the watch**. |
| `bounce_feedback` | any step with `controls.bounce` | each earlier target step (must declare `consumes: bounce_feedback`) | `feedback-<toStep>.md` write + `@@BOUNCE_REASON_FILE@@`/`@@BOUNCE_CMD@@` + the "⚠ Rework requested" banner injection. |
| `human_reply` | source `replyChannel` (ask-human) | the asking step (universal) | `waiting_for_human` park + resume. Already generic (`human_questions` table). |
| `close_reference` | `github_issues` source | `pr` | `@@CLOSE_REFERENCE@@` for PR-body auto-close — replaces "grep a `Closing reference:` line out of the work doc". |

**`bounce_feedback` is a producer/consumer *pair*.** The *emit* direction is `controls.bounce`; the
*receive* direction is `consumes: bounce_feedback` (today the rework banner is gated purely on
`feedback-<step>.md` file existence, decoupled from any declaration). Load-time rule: every bounce
emitter must have an earlier step that declares `consumes: bounce_feedback`, and vice-versa.

**`handoff` is mandatory on every step.** Every `StepDescriptor` declares `produces: handoff` (the
contract suite asserts it) and the finish protocol always writes `handoff-<step>.md` — empty is
fine. This removes a whole class of edge case (a read-only side step that produces no handoff,
leaving the next step pointed at a note that never appears) and keeps the cross-step channel
uniform. `consumes: handoff` stays *optional* (a first step has no earlier producer — its clause is
simply dropped), so "always produced, optionally consumed" is the invariant.

---

## 3. The four shipped descriptors (the w2pr recreation)

```ts
// src/steps/work/descriptor.ts
{ name: "work",
  basePrompt: { slug: "work", perSourceOverride: true },       // prompts/work.md + prompts/<type>/work.md
  consumes: [{ work_spec, required: true }, { work_raw, required: false },
             { bounce_feedback, required: false }],
  produces: [ commits, handoff ],
  controls: { posture: {} },
  guards:   [ budget(develop_budget_seconds=5400),
              heartbeat({ requiresProduct: commits, window: stall_seconds }),
              layout_wait({ attachWhen: layoutTarget }) ],
  effects:  [ { trigger: "belt_start", to: "in_development" } ] }   // first-step effect

// src/steps/evidence/descriptor.ts
{ name: "evidence",
  basePrompt: { slug: "evidence", perSourceOverride: true },
  consumes: [{ work_spec, required: true }, { commits, required: true }, { handoff, required: false }],
  produces: [ evidence, handoff ],
  controls: { bounce: { toEarliestConsumerOf: bounce_feedback },   // → work
              posture: { readOnly: true, requiresLayout: true } }, // requiresLayout ⇒ opt-in (§4)
  guards:   [ budget(evidence_budget_seconds=2400),
              capture_cap(max_capture_attempts=5, { reset: "forward_entry", cumulative: false,
                          autoRescue: true, requiresProduct: evidence }),
              layout_wait ] }

// src/steps/review/descriptor.ts
{ name: "review",
  basePrompt: { slug: "review", perSourceOverride: true },
  consumes: [{ commits, required: true }, { handoff, required: false }, { evidence, required: false }],
  produces: [ handoff ],
  controls: { bounce: { toEarliestConsumerOf: bounce_feedback },   // → work
              posture: { readOnly: true } },                       // enforced (§7)
  guards:   [ budget(review_budget_seconds=1800), layout_wait ] }

// src/steps/pr/descriptor.ts
{ name: "pr",
  basePrompt: { slug: "pr", perSourceOverride: true },             // prompts/pr.md + prompts/<type>/pr.md
  consumes: [{ commits, required: true }, { handoff, required: false },
             { evidence, required: false }, { close_reference, required: false }],
  produces: [ pull_request, handoff ],
  controls: {},
  guards:   [ budget(pr_budget_seconds=3600),
              heartbeat({ requiresProduct: commits }), layout_wait ] }
```

And the recreated belt (clean-break config — `belt_type`/`agents:` are gone):

```yaml
belt:
  - name: jira-bugs-to-prs
    source: jira
    label: herdr-ready
    workspace_name: "{{semantic_work_prefix}}/{{work_id}}-{{work_full_slug}}"
    steps:
      - { type: work,     tab: work, pane: 0, prompt_file: prompts/work-extra.md, prompt_file_source: config, budget_seconds: 5400 }
      - { type: evidence, tab: work, pane: 1 }   # opt-in: requiresLayout ⇒ drop the tab/pane (or the whole entry) = work→review→pr
      - { type: review,   tab: work, pane: 2 }
      - { type: pr,       tab: work, pane: 3 }
    # watchPr, the bounce-cap, and the per-attempt branch uid are all DERIVED from what the steps declare.
```

**Derived, not written:** the belt gets the terminal PR-watch because a step *produces
`pull_request`* and the `pull_request` capability declares a watch; the bounce cap because a step
declares `controls.bounce`; the per-attempt branch uid because the belt contains a `pull_request`
producer.

---

## 4. `PRODUCT_CAPABILITIES` — where the resolver and PR-watch live

The critical structural fix: **the resolver is not a step.** It is an agent owned by the
`pull_request` product's *watch* capability.

```ts
// src/products/pull-request.ts
{ product: "pull_request",
  tokens: ["@@PR_NUMBER@@"],
  effectOnProduce: { to: "in_review" },        // decoupled from the watch (see §6)
  adoption: {                                  // the mid-step facet (today's opensPr)
    discover: ["by_branch", "by_number"],      // first sighting by branch, thereafter by number
    ownershipGuard: "closed_pr_ignored_unless_adopted", // the stale-reused-branch guard
    observedCompletion: ["MERGED"],            // folded into the step-done gate (rs.done || MERGED)
    perAttemptBranchUid: true },
  watch: {                                     // the terminal facet (today's watchPr + reviewing)
    subPhase: "reviewing",
    signalSource: "github_review_signature",   // batched PrSnapshot — keyed on capability, not phase name
    terminalStates: { MERGED: "teardown:merged", CLOSED: "park:pr_closed" },
    idleHoldsSlot: false,                       // dynamic occupancy
    resolver: {
      wakePrompt: { slug: "resolver", perSourceOverride: true, tokens: ["@@KEY@@","@@PR_NUMBER@@"] },
      // (runs on the work step's pane/agent since #88 — see watch.ts)
      spawn: "agent-agnostic" } },              // mirror dispatchToLayout, not hardcoded "claude"
  signals: [] }

// src/products/evidence.ts
{ product: "evidence",
  tokens: ["@@EVIDENCE_DIR@@","@@EVIDENCE_UPLOAD_CMD@@","@@CAPTURE_ATTEMPT_CMD@@"],
  outbox: "evidence_uploads",                   // enables the EXISTING durable S3 outbox (flush unchanged)
  signals: ["capture-attempt","evidence-upload"] }
```

This funnels the **three** independent PR-terminal-state observation sites today
(`reconcileStep` @1184-89, `reconcileReviewing` @1318-19, `reconcileAttention` @1408-10) through one
declared terminal-state table so they can't drift. It also pulls the resolver prompt — *the only
agent prompt in the system that is neither in `prompts/` nor `@@TOKEN@@`-substituted nor
source-overridable* (`watch.ts:6`) — into the prompt library as a first-class, tokenized entry.

---

## 5. Guards carry lifecycle (not a flat set)

```ts
interface GuardSpec {
  kind: "budget" | "heartbeat" | "capture_cap" | "bounce_cap" | "layout_wait" | "exclusive_resource";
  counterScope?: "run+step+guard";   // storage key — so two capped guards on one step don't collide
                                      //   on the single capture_attempts column (they do today)
  reset?: "forward_entry" | "never" | "resume";
  cumulative?: boolean;              // bounce_cap: true; capture_cap: false (per-pass)
  autoRescueOnDone: boolean;         // the union of these == STEP_WATCHDOG_ATTENTION
  escalationReason: string;          // "step_budget" | "capture_limit" | "step_stalled" | "layout_wait_timeout" | ...
  requiresProduct?: ProductType;     // heartbeat → commits; capture_cap → evidence
  attachWhen?: "layoutTarget";       // layout_wait attaches iff the step ref supplies tab/pane
}
```

- `STEP_WATCHDOG_ATTENTION` (today a hardcoded literal `Set` at `reconcile.ts:1023`) becomes
  **the union of guards whose `autoRescueOnDone` is true** — so a plugin guard that parks a run is
  auto-rescued on genuine `step-done` without editing a literal. `bounce_cap`, `pr_closed`,
  `source_item_stale`, human-loop, and config parks declare `autoRescueOnDone: false`.
- `capture_cap.reset: "forward_entry"` encodes the load-bearing "resets on a fresh forward pass but
  **not** on crash-respawn (a self-crash can't refill the cap)" rule as data.
- Guard-counter storage keys on `(run, step, guard)` — generalizing today's `run_steps.bounces` and
  `run_steps.capture_attempts` single-purpose columns.
- **Fixes a latent leak:** `resumeRun` resets `captureAttempts` unconditionally today
  (`reconcile.ts:1458`), even for non-evidence steps. Resume now routes through each guard's own
  reset rule.

---

## 6. `EFFECTS` — forward-only source transitions

```ts
interface EffectSpec {
  trigger: "belt_start" | { produce: ProductType } | { teardown: Outcome };
  to: WorkState;   // engine NOOPS if `to` <= the current source state (monotonicity)
}
```

Three declared triggers replace three hardcoded call sites:

| Today (hardcoded) | Declared as |
|---|---|
| `in_development` at claim (`reconcile.ts:690`) | `{ trigger: "belt_start", to: "in_development" }` on the first step |
| `in_review` inside `enterReviewing` (`:1299`) | `{ trigger: { produce: "pull_request" }, to: "in_review" }` — **decoupled from the watch**, so a PR-without-watch belt would correctly move to `in_review` |
| `outcomeToWorkState(outcome)` at teardown (`:1507`) | `{ trigger: { teardown }, to }` table; `outcomeToWorkState` stays the default |

**Monotonicity is now explicit.** The outbox guards per-run *enqueue order* but not *semantic
monotonicity*, so a bounce re-entry or a retried `belt_start` effect could enqueue `in_development`
after `in_review` and walk the source backward. Effects fire idempotently and only forward
(target ≤ current = noop).

The **abort-vs-park stale policy** (`reconcile.ts:537`) stops keying on the literal string
`"in_development"` + `run.prNumber == null`. It keys on *"was the stale transition this belt's
declared `belt_start` effect?"* AND *"has **any** durable product been produced?"* — so a belt that
renames its start effect or produces a durable non-PR artifact triages correctly.

---

## 7. `read_only` — declare **and** enforce

Today `read_only` is prose-only in `evidence.md`/`review.md` and nothing stops a commit. Under the
one-pass scope: `controls.posture.read_only` is declared **and** enforced — a `read_only` step must
not declare `produces: commits`, and the engine treats **HEAD movement during that step as a
violation** (refuse-to-advance / escalate). This is genuinely new behavior (not present today) that
you opted into.

---

## 8. Typed dataflow validation — the "as reliable as w2pr" payoff

Run in `config.ts` `superRefine` using the step registry (already importable there), surfaced as
zod issues so the TUI `save()` path renders them, and re-checked by `doctor` (which has **no**
belt/step visibility today):

- **Reject** a belt where a **required** consume is unsatisfied by the source or any earlier
  `produces` (e.g. `[review, work]` → review needs `commits`, nothing upstream produces them).
- **Accept** when an **optional** consume is unsatisfied — and **drop the corresponding prompt
  clause + token** rather than rejecting (this is what makes the skipped-evidence belt valid).
- **Reject** a watch capability with no upstream `pull_request` producer (replaces today's silent
  runtime fall-through where `enterReviewing` wedges with no PR).
- **Enforce step-name uniqueness for *all* belts** (today only custom belts are checked;
  `run_steps` keys on `(run_id, step)`).

**Honest scope:** this covers the **structural, config-sourced** graph only. `repo`-sourced
`prompt_file`s and any repo-sourced content don't exist until claim (worktree checkout), so they can
only fail at dispatch — the doc must not over-promise. And the single strongest current dataflow bug
(`pr.md`/`review.md` assert evidence exists when evidence was skipped) is fixed **only if base
prompts reference products via conditionally-injected tokens** instead of prose. So: base prompts
reference prior/next work through `@@HANDOFF_IN@@` + the engine-injected `@@STEPS@@` sequence and
capability tokens — **never literal neighbor names** ("the work agent has implemented…") which lie
when a primitive is composed into a differently-ordered belt.

---

## 9. `SIGNAL_DESCRIPTORS` — kill the 5-file fan-out

Adding a control today is a hand fan-out across `schemas.ts` (zod body) + `schemas.ts` (response) +
`app.ts` (`createRoute`) + `app.ts` (`openapi` handler) + `cli/index.ts` (command) + `step.ts`
(`@@*_CMD@@` token) — with the `withRunLock`-vs-`withRunLockWaiting` choice hand-coded and
prose-documented per handler, duplicated ~5×. And `evidence-upload`/`capture-lock` aren't HTTP
signals at all (silently absent from `/doc`); `capture-attempt` carries no `step` field.

```ts
interface SignalDescriptor {
  name: string;                                   // "step-done" | "bounce" | "capture-attempt" | ...
  args: ArgSpec[];                                // key, step, --source, --reason-file, ...
  bodySchema: ZodType; responseSchema: ZodType;   // HTTP + OpenAPI, generated
  scope: "run" | "machine" | "product-outbox";
  lockDiscipline: "fire-and-forget" | "waiting";  // DERIVED from whether the effect is non-monotonic
  token: string;                                  // @@STEP_DONE_CMD@@, injected only when the step supports it
  engineEffect: (deps, run, ...) => Promise<...>; // advance | bounce | park | attempts | phase
}
```

The server and CLI **iterate the registry** to auto-mount routes + commands + tokens, so `/doc` is
complete and lock discipline derives from monotonicity instead of being hand-chosen. Concrete
fixes folded in: `capture-attempt` gains an explicit **`step` field** validated against that step's
`produces: evidence` (a belt may legitimately have >1 evidence step); `capture-lock` becomes a
`guard: exclusive_resource(name)`; `evidence-upload` routes through a real serialized
`product-outbox` signal.

---

## 10. Database & state (one migration)

| Change | Why it can't be split out |
|---|---|
| New **`run_products`** table keyed `(run, product)` — move `runs.pr_number`, `runs.resolver_active`, `runs.last_thread_sig` here | `resolver_active` is read **directly in `countOccupying`'s SQL** — moving PR state off `runs` forces `countOccupying` to generalize in the *same* migration |
| Generalize **`countOccupying`** to a **declared occupancy-posture** predicate ("occupies unless in a declared idle-watch posture") | tied to the above; today it's `phase='reviewing' AND resolver_active` |
| Guard-counter storage keyed `(run, step, guard)` — generalize `run_steps.bounces` / `run_steps.capture_attempts` | two capped guards on one step collide on one column today |
| Widen **`StepName`** from a closed union to a branded slug | plugin/registry step names; **audit exhaustive switches** in telemetry `EventType` and the TUI that become latent bugs when names open |

`fetchPrSnapshots`'s `phase==='reviewing'||'attention'` filter (`:306`) is re-keyed to
"runs with a live `pull_request` watch" so a plugin watch in a differently-named sub-phase isn't
silently excluded. `applyPendingFocus`'s focusable panes become
`belt.steps panes ∪ product-owned agent panes` (so focus can follow a run into its resolver).

---

## 11. Config schema & the clean-break migration

- `configJsonSchema()` regenerates from the new `RepoConfigSchema` (ordered `steps[]` with a
  registry-generated `step.type` enum + per-descriptor allowed fields, exactly as
  `WorkSourceSchema` is assembled from `SOURCE_DESCRIPTORS`). The committed `config.schema.json` is
  asserted **byte-identical** in `test/config.test.ts:751` and the example repo's modeline resolves
  to it — so this **forces regenerating + committing** the schema (`npm run schema`) or that test
  fails.
- **Clean break:** `belt_type` and the `agents:` map are removed. Existing `config.yml`s are
  rewritten once (mechanical: the `agents` map's `fix`/`evidence`/`review`/`pr` entries → four
  `steps[]` entries typed `work`/`evidence`/`review`/`pr`;
  the four named `limits.*_budget_seconds` become per-step `budget_seconds`). `examples/example-repo/`
  and README/ARCHITECTURE.md are updated from source (not from the old prose).
- Prompt overrides are **namespaced** — `prompts/<plugin>/<sourceType>/<step>.md` — so two plugins
  registering a `review` descriptor don't collide.

---

## 12. Contract test suites (mirror the WorkSource charter INV-1..11)

**A) Per-descriptor** (run over every registered `StepDescriptor`): consumes/produces drawn only
from the closed vocabulary; **every descriptor produces `handoff` (mandatory)**; every declared
product maps to a real `ProductCapability`; `controls`
targets legal + `step_done`/`ask_human` always present; each guard attaches, fires, and honors its
declared lifecycle; effects reference canonical `WorkState`s and fire forward-only; **base prompt
renders with EVERY `@@TOKEN@@` substituted (a dangling token is a load-time error)** and includes
exactly the scaffold sections its controls imply; `read_only` enforced; every control's
`SignalDescriptor` round-trips (route mounts, command mounts, token built, lock discipline matches
monotonicity).

**B) Belt-composition** (the executable definition of "custom belts as reliable as w2pr"): reject a
belt with an unsatisfied **required** consume; **accept** an unsatisfied **optional** consume and
assert the clause/token is dropped; reject a watch with no upstream `pull_request` producer; enforce
step-name uniqueness for all belts; assert a bounce clears `done` for every intermediate step; and
the **regression anchor** — the shipped w2pr template composes to a `StepConfig` **byte-identical**
to today's `PR_STEPS` resolution.

---

## 13. Plugin seam (designed now, loading deferred)

Everything above *is* the seam. A plugin registers a `StepDescriptor` and/or a `ProductCapability`
+ its `SignalDescriptor`s into the three registries — the same way `SOURCE_DESCRIPTORS` works today.
The committed "adding a step primitive N+1" checklist (mirroring the source-registry header):
`src/steps/<name>/descriptor.ts` + base prompt(s) + one `STEP_DESCRIPTORS` entry + any new
`ProductCapability`/`SignalDescriptor` + `npm run schema` + a contract-suite harness. Actual
external module *loading* (discovery, sandboxing) is out of scope for this pass, but nothing here
assumes the registries are static.

---

## 14. File-by-file change map (one pass)

| File(s) | Change |
|---|---|
| `src/types.ts` | widen `StepName`; add `ProductType`, `InputSpec`, `GuardSpec`, `EffectSpec`, `SignalScope`, `run_products` types; audit `EventType`/exhaustive switches |
| **`src/steps/registry.ts`** + `src/steps/<name>/descriptor.ts` (×4) | new — `STEP_DESCRIPTORS`, `descriptorFor(name)`; base prompts as library refs |
| **`src/products/registry.ts`** + `src/products/*.ts` | new — `PRODUCT_CAPABILITIES`; `pull_request` (adoption + watch + resolver + effect), `evidence` (outbox + signals) |
| **`src/signals/registry.ts`** | new — `SIGNAL_DESCRIPTORS`; iterated by server + CLI |
| `src/config.ts` | remove `belt_type` union + `PrAgentsSchema` + `PR_STEPS`/`PR_CAN_BOUNCE_TO`/`PR_GATHERS_EVIDENCE`; belt = ordered `steps[]` via `descriptorFor(step.type)`; `superRefine` gains dataflow + all-belt uniqueness; derive `watchPr`/branch-uid |
| `src/core/step.ts` | uniform base-prompt assembly (drop `enginePrompt===undefined`); token map = universal ∪ capability tokens; scaffold sections gated on declarations; namespaced per-source overrides; base prompts stop naming neighbor steps |
| `src/prompts/` | rename `fix.md`→`work.md` (+ `jira/fix.md`, `github_issues/fix.md` → `…/work.md`); add `resolver.md` (the PR-watch wake prompt, now a tokenized library entry); namespace override paths per §11 |
| `src/core/reconcile.ts` | funnel 3 PR-terminal sites through the product table; effects fire from declarations (forward-only); `STEP_WATCHDOG_ATTENTION` = autoRescue union; guard counters `(run,step,guard)`; abort-vs-park keys on belt_start-effect + any-durable-product; `read_only` enforcement; resume via guard reset rules |
| `src/core/watch.ts` | resolver prompt → product watch capability (tokenized, source-overridable, agent-agnostic, runs on the work step's pane/agent) |
| `src/db/{store,migrate}.ts` | migration vNN: `run_products` (move PR state), generalize `countOccupying`, guard-counter table |
| `src/server/{schemas,app}.ts` + `src/cli/index.ts` | iterate `SIGNAL_DESCRIPTORS` to auto-mount routes/commands/OpenAPI/tokens; `capture-attempt` gains `step`; `evidence-upload` → serialized signal |
| `src/tui/{config-fields,config-editor}.ts` | render step rows from `STEP_DESCRIPTORS` (mirror the source half already data-driven); drop `belt_type`/`agents` hand-coding |
| `src/doctor.ts` | add belt-composition dataflow check; evidence check gates on an evidence-*producing step*, not just the config block |
| `src/core/branch.ts` | route `semantic_work_prefix` through the source descriptor; supply branch uid only when the belt has a `pull_request` producer *(adjacent source-primitive cleanup)* |
| `test/*` | new step-descriptor + belt-composition contract suites; w2pr byte-identical anchor; update `config.schema.json` + drift test; update `reconcile.test.ts` bounce/terminal locks |
| `docs/`, README, `examples/` | update from source (belt model, three registries) |

---

## 15. Locked decisions

Locked to the recommendations, per your go-ahead:

1. **Singleton products — locked.** A belt has **at most one producer of any given product**
   (`pull_request`, `evidence`, …), declared as a registry invariant and enforced at belt
   composition. This keeps `capture-attempt`'s step-binding and PR-adoption-by-single-run
   well-defined.
2. **Bounce product-invalidation — locked.** A bounce that clears intermediate steps also
   **abandons their durable products** (evidence re-captures under a fresh prefix — already the
   behavior; a PR from a post-PR bounce is abandoned/re-derived). For the w2pr template this is a
   no-op (bounces are pre-PR), so the byte-identical anchor is unaffected.
3. **`read_only` enforced — locked.** Declared *and* enforced via HEAD-movement detection on
   read-only steps (part of the one-pass scope).
4. **Plugin product config — locked (deferred build).** Per-product config lives under a namespaced
   `products:` map (e.g. `products.evidence`, `products.deploy`), not the single top-level
   `evidence:` block. Designed now; the actual `evidence:`→`products.evidence` move ships with
   plugin loading, so this pass leaves the `evidence:` block in place.
5. **Branch uid location — locked.** Belt-level: the uid is supplied when the belt contains a
   `pull_request` producer.

**Scope note on the `fix`→`work` rename.** "`fix`" as the **step/agent** is renamed to **`work`**
everywhere (the `work` descriptor, `prompts/work.md`, `type: work`, bounce targets). The git
**branch prefix** `fix|chore|feature` produced by `branch.ts`'s `prefixForType` (bug→`fix/`) is a
*branch-naming taxonomy* distinct from the step, and is **kept as-is** — renaming it would collapse
the bug/chore/feature distinction in branch names into a single `work/`. That cleanup is already
carved out as adjacent source-primitive territory (§14). Say the word if you want the branch prefix
renamed too.
