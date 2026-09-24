# herdr-factory — The prompt contract

Every belt step runs a real agent, and every agent is driven by a **prompt** the engine
renders into the run's worktree (`.memory/herdr-factory/prompt-<step>.md`) and delivers to
the step's pane. You shape that prompt with a **`prompt_file`** — the factory's public
authoring surface. This document is the contract that `prompt_file` writes against: how a
step prompt is assembled, the `@@TOKEN@@`s the engine substitutes (and exactly when), the
`@@WHEN:<product>@@ … @@END@@` product-gated clause syntax, and how a prompt is validated.

The contract is defined in one place — [`src/prompts/contract.ts`](../src/prompts/contract.ts)
— which is also what validates your prompts and what this document is checked against (a test
fails if a token here and there ever drift apart). See also the [README's Prompts
section](../README.md#prompts) for the short version and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
for the surrounding engine.

## How a step prompt is assembled

At render time the engine builds each step's prompt in this order:

1. **The body.**
   - For a **`work` / `evidence` / `review` / `pr`** step the engine ships a built-in base
     prompt for its primitive (per source type, under [`src/prompts/`](../src/prompts/)); your
     `prompt_file`, if any, is appended under a *"Additional repo-specific instructions for
     this step"* heading — it **augments** the base.
   - For a **`custom`** step there is no base prompt, so your `prompt_file` **is** the whole
     body (and is therefore required).
2. **Product-gated clauses** (`@@WHEN:<product>@@ … @@END@@`) are resolved against the belt's
   actual dataflow — kept (markers removed) when the product is active for the step, else the
   whole clause is dropped.
3. **Token substitution** replaces every `@@TOKEN@@` (see the reference below).
4. Your repo's **`guidelines-prompt.md`** (if present) is appended under a *"Repo-specific
   guidance"* heading — it applies to every step of every belt.
5. The engine's **handover scaffold** is appended: which belt and step this is and the full
   step sequence, how to read the prior step's handoff and query its agent on demand,
   the keep-going / never-destroy rule (don't pause for confirmation; stop only via ask-human; no force-push, no deleting what you didn't create, nothing outside the worktree), the ask-human protocol, the bounce protocol (where applicable), and the finish protocol (write
   your handoff — opening with the `sha:` it covers — then run `step-done`).
6. If the run was **bounced back** to this step — by a later step, or by the operator's
   `rework` — a *"⚠ Rework requested — READ THIS FIRST"* banner is prepended, pointing at the
   feedback note.

The scaffold (5) and the finish/ask-human/bounce wiring are the engine's job — your
`prompt_file` should describe *the work*, not restate the plumbing. Base prompts never name
their neighbour steps directly; they refer to prior/next work only through `@@HANDOFF_IN@@` /
`@@HANDOFF_OUT@@` and the `@@STEPS@@` sequence, so a step reads correctly in any belt order.
Write your own prompts the same way.

## Repo guidance vs. the prompt — the precedence rule

The shipped base prompts (and the scaffold, so every `custom` step too) tell the agent to find the
**target repo's own** instructions — `CLAUDE.md` / `AGENTS.md` including nested ones, agent skills
and commands under `.claude/`, `CONTRIBUTING.md`, runbooks under `docs/` — and prefer them over the
prompt's own generic advice, falling back to the prompt where the repo is silent. That deference
covers *how the work is done*: bootstrap and dev-server commands, patterns and code style, test
layout and the lint/type-check/test commands, review standards, capture tooling and viewport, test
personas, PR description shape.

It stops at the **flow**. A repo document never overrides a read-only step's posture, incremental
commits (the heartbeat depends on them), the handoff note, `step-done` / ask-human / bounce, who
owns the work item's status, `conventions.commits`, or the belt's `pr:` policy — the scaffold says
so explicitly, and an agent that hits a genuine conflict is told to follow the prompt and record it
in its handoff. Write your own `prompt_file` the same way: defer on craft, keep the engine's
protocol authoritative.

## `prompt_file` and `prompt_file_source`

A step's `prompt_file` is a path to a Markdown file. `prompt_file_source` says where it is
read from:

| `prompt_file_source` | Resolved against | Read | Existence checked |
| --- | --- | --- | --- |
| `config` *(default)* | the repo's config folder (`repos/<name>/`) | at config-load | at config-load |
| `repo` | the **target repo checkout** | from the run's **worktree at render time** | at render time (a missing file surfaces when the step is dispatched) |

`config` is the default because that is where custom-step prompts usually live; use `repo` to
keep a prompt version-controlled next to the code it drives. Absolute paths are used as-is.

## Token reference

A token is written `@@NAME@@`. Its **scope** determines *when* the engine substitutes it:

- **universal** — always substituted, on every step of every belt.
- **product** — substituted only when that product is **active** for the step: the step
  produces it, or it consumes it *and* an upstream step (or the source) produces it. In a
  `work → review → pr` belt, for example, `evidence` is inactive, so the evidence tokens are
  not injected (and any `@@WHEN:evidence@@` clause is dropped).
- **guard** — substituted only when the step declares that guard (today: the `exclusive_resource`
  capture mutex, declared only by the `evidence` step).

A token you reference outside its scope is **not** substituted — it would reach the agent
literally — so the validator rejects it (see [Validation](#validation)). Wrap a scoped token
in a matching `@@WHEN:<product>@@` clause to reference it portably.

### Universal tokens

| Token | Meaning |
| --- | --- |
| `@@KEY@@` | the work item's key/id (Jira key, GitHub issue number, markdown stem, Sentry short-id) |
| `@@REPO@@` | the repo config name (what you pass to `--repo`) |
| `@@BELT@@` | the belt this run is on |
| `@@STEPS@@` | the belt's full ordered step sequence (step names joined by ` → `) |
| `@@STEP@@` | this step's name |
| `@@TYPE@@` | the work item's type (feature/bug/chore/…); may be empty |
| `@@SUMMARY@@` | the work item's summary/title |
| `@@BRANCH@@` | the branch the run's worktree is currently on (tracked — an agent may rename it with `@@SET_BRANCH_CMD@@`) |
| `@@WORKTREE@@` | absolute path to the run's worktree |
| `@@MEMORY_DIR@@` | the per-run working dir (`.memory/herdr-factory`), relative to the worktree |
| `@@WORK_DOC@@` | path to the materialized work doc (`ticket.json` / `task.md` / `task/`) |
| `@@WORK_DOC_KIND@@` | a human label for the work doc's shape (e.g. "Jira ticket (JSON)", "markdown file") |
| `@@HANDOFF_IN@@` | path to the prior step's handoff note ("(none — first step)" on the first step) |
| `@@HANDOFF_OUT@@` | path this step must write its own handoff note to |
| `@@PRIOR_PANE@@` | the prior step's herdr pane id, for on-demand queries ("(none)" if none) |
| `@@PRIOR_SESSION@@` | the prior step's agent session id ("(none)" if none) |
| `@@STEP_DONE_CMD@@` | the exact command to signal this step complete |
| `@@ASK_HUMAN_CMD@@` | the exact command to ask a human and park the run |
| `@@SET_BRANCH_CMD@@` | the exact command to put this run's worktree on another branch name (the repo's branch convention) — rename BEFORE pushing; refused once the PR is open |
| `@@BOUNCE_CMD@@` | command to send the work back to the earlier step (empty when this step can't bounce) |
| `@@BOUNCE_TARGET@@` | the step name a bounce returns to (empty when this step can't bounce) |
| `@@BOUNCE_REASON_FILE@@` | path to write bounce findings to (empty when this step can't bounce) |
| `@@CLI@@` | absolute path to the herdr-factory CLI binary |
| `@@PASS@@` | which entry into this step this is (1 on the first; 2+ after a bounce or an operator `rework`) |
| `@@GATE_CMD@@` | wrapper that runs one verification command and records a **gate receipt** against the run (renders with `<gate-name>` / `<command>` placeholders) |
| `@@GATE_RECEIPTS_CMD@@` | the command that lists this run's gate receipts — which gates already ran, at which commit, with what result |
| `@@COMMIT_CONVENTIONS@@` | the repo's commit-message conventions (from `conventions.commits`); empty when that key is unset |

### Gate receipts — `@@GATE_CMD@@` / `@@GATE_RECEIPTS_CMD@@` / `@@PASS@@`

A **gate** is one verification command — lint, type-check, a test suite. `@@GATE_CMD@@` is a
transparent wrapper around it: the factory runs the command in the run's worktree, streams its
output through unchanged, exits with the command's own exit code, and records a **receipt** —
command, the worktree HEAD it ran at, exit code, duration and a short output tail — against the run.

The receipt's identity is `(run, gate name, HEAD)`, so re-running a gate at the same commit replaces
its receipt rather than adding one. A later step lists them with `@@GATE_RECEIPTS_CMD@@`, which
marks each one **CURRENT** (taken at the branch's present HEAD on a clean tree, so it covers exactly the tree that
step is looking at), **STALE**, or **DIRTY** (uncommitted work at that SHA), and its prompt tells it to re-run a gate only when the receipt is
missing, stale, dirty, or it has a concrete suspicion about that specific check. Before this, every step
re-derived the same fact by paying for it again: one observed run spent 12 minutes re-running spec,
unit and typecheck suites that had already passed on an unchanged SHA.

`@@PASS@@` is the step's pass number (see `run_steps.pass`). It is what lets a *re-entered* step
reuse its own prior work — the evidence prompt uses it to re-film only the acceptance criteria whose
files moved since the sha its previous handoff recorded (or everything, if a shared file moved), instead of re-shooting the whole plan.

`@@SET_BRANCH_CMD@@` renders with a `<new-branch-name>` placeholder the agent replaces. The run's
identity is its **worktree**, not its branch: the factory names the branch at claim time from what
the work source knows, and a project whose branching/CI convention needs another name (a ticket key
the agent only obtains mid-run, a required prefix) renames it with this command. The engine then
tracks the new name for prompts, PR discovery, and branch cleanup. It refuses a name that isn't a
valid ref, one that already exists, a protected branch (the base ref / the main checkout's branch),
and any rename once the run's PR is open — the message says which. A rename made without the command
(a bare `git branch -m`) is picked up on the next reconcile pass anyway; the command exists to fail
loudly instead of silently at the wrong moment.

The three `@@BOUNCE_*@@` tokens are universal but render **empty** on a step that cannot bounce
(a step with no earlier `bounce_feedback` consumer), so they are always safe to reference.
`@@COMMIT_CONVENTIONS@@` is likewise universal-but-empty: it renders the repo's
[`conventions.commits`](../README.md#conventions-optional) value when set (short free text, or a
file pointer resolved against the repo's config folder), and **nothing** when unset — so referencing
it leaves a prompt byte-identical to today until a repo opts in.

### Product-scoped tokens — `pull_request`

Active only for a step that **produces** the pull request (the `pr` step), so a belt with no `pr`
step never carries this token:

| Token | Meaning |
| --- | --- |
| `@@PR_TEMPLATE@@` | the target repo's own PR template — its `.github/PULL_REQUEST_TEMPLATE.md` (or the root / `docs/` variants, or the first file in a `.github/PULL_REQUEST_TEMPLATE/` directory), read from the worktree at render time and reproduced for the agent to fill faithfully. Empty when the repo ships no template — the base summary+testing-notes wording then applies unchanged. |
| `@@PR_OPTIONS@@` | the belt's [`pr:` behavior block](../README.md#belt--1) opening policy — `draft`, `title` (a `{{work_id}}`/… template), `labels`, `reviewers`, `assignees` — rendered as the `gh pr create` flags to pass. Empty when the belt sets no `pr:` block (so an absent block leaves the pr prompt byte-identical to before). |
| `@@PR_AUTOMATED_ROUND@@` | the pr step's automated-round (CI/bot polling) instructions, sized by the belt's `pr.automated_round_minutes` — the ~10 min default when unset, `~N min` when set, or a "skip the round, hand straight off" instruction when `0`. |

Template discovery is **best-effort**: a missing or unreadable template drops the clause, it is
never an error. The multi-template directory is v1-simple — the default/first `*.md` is used; there
is no per-PR template selection.

`@@PR_OPTIONS@@` and `@@PR_AUTOMATED_ROUND@@` render the belt-level **PR behavior block** as policy:
`draft`, a `title` template, `labels`/`reviewers`/`assignees`, and the `automated_round_minutes`
window are delivered as prompt instructions the agent applies via `gh` — the agent stays the actor,
the config is the policy. An **absent** `pr:` block leaves both tokens at their pre-block defaults, so
the rendered pr prompt is byte-identical to before.

### Product-scoped tokens — `evidence`

Active when an upstream `evidence` step (or the step itself) produces evidence for this belt:

| Token | Meaning |
| --- | --- |
| `@@EVIDENCE_DIR@@` | directory to write captured screenshots/video into |
| `@@EVIDENCE_UPLOAD_CMD@@` | command that publishes `@@EVIDENCE_DIR@@` to S3/CloudFront (a no-op when `evidence:` is unconfigured) |
| `@@CAPTURE_ATTEMPT_CMD@@` | command that signals a capture attempt so the engine can cap flaky-capture loops |

### Guard-scoped tokens — the capture mutex (`exclusive_resource`)

Injected only for a step that declares the `exclusive_resource` guard (today: `evidence`):

| Token | Meaning |
| --- | --- |
| `@@CAPTURE_LOCK_ACQUIRE_CMD@@` | acquire the machine-global capture mutex before driving the app |
| `@@CAPTURE_LOCK_RELEASE_CMD@@` | release the capture mutex when done |

### Tokens that are *not* part of the `prompt_file` contract

Some tokens the engine uses elsewhere are **not** substituted into a step's `prompt_file` and
so must not be referenced from one (the validator will reject them):

- `@@PR_NUMBER@@` — belongs to the **resolver wake prompt**, an engine-internal prompt woken
  during the PR-review watch (overridable per source under `src/prompts/<type>/resolver.md`,
  but not via a belt step's `prompt_file`). There is no PR number while the belt's steps run.
- `@@WORK_RAW@@`, `@@CLOSE_REFERENCE@@` — reserved product tokens not currently wired into step
  prompts. Read the raw source payload from the work-doc sidecar via `@@WORK_DOC@@`'s directory
  instead.

## Product-gated clauses — `@@WHEN:<product>@@ … @@END@@`

A product gate keeps a span of prose (and any tokens inside it) only when a product is active
for the step; otherwise the **whole** span — prose *and* tokens — is removed. This is how a
prompt can reference evidence conditionally without ever dangling a token in a belt that never
captured it:

```
Implement the change and commit it.@@WHEN:evidence@@ An earlier step captured visual proof in
`@@EVIDENCE_DIR@@` — reconcile your change against it.@@END@@
```

- In a `work → evidence → review → pr` belt the reviewer step sees the sentence (with
  `@@EVIDENCE_DIR@@` substituted).
- In a `work → review → pr` belt the whole clause is dropped — no orphaned sentence, no
  dangling `@@EVIDENCE_DIR@@`.

Rules (enforced by validation):

- The product must be a real one (`work_spec`, `work_raw`, `commits`, `handoff`, `evidence`,
  `pull_request`, `bounce_feedback`, `human_reply`, `close_reference`). A typo like
  `@@WHEN:evidnce@@` is rejected.
- Every `@@WHEN:<product>@@` must be closed by an `@@END@@`.
- Clauses **do not nest** — close one before opening the next.
- Referencing a product that can never be active for the step is *not* an error: the clause
  is simply always dropped, which is what lets one prompt stay portable across belts.

## Validation

A `prompt_file` is validated against this contract, for the specific step it is attached to:

- **`config`-sourced prompts** are validated at **config load** — by `doctor`, `reload`, the
  TUI config editor's save, and every server start — so a mistake is caught before any run
  begins, with an actionable error naming the belt, step, file, and problem.
- **`repo`-sourced prompts** are validated at **render time** (they are read from the worktree
  then); a violation surfaces the same way a missing file does — the step fails to dispatch
  with a clear error, and the run parks for attention.

Both paths run the **same** validator, gated by the same dataflow rules the renderer uses, so
what is rejected is exactly what would otherwise reach the agent unrendered. It flags:

- an **unknown token** — `@@NOPE@@` that isn't in the contract at all;
- a **known token used out of scope** — e.g. `@@EVIDENCE_DIR@@` in a `work → review → pr` belt
  (evidence inactive), or a guard token on a step that doesn't declare the guard;
- a **malformed, unbalanced, or nested** `@@WHEN@@`/`@@END@@` clause, or one naming an unknown
  product.

Tokens inside a `@@WHEN:<product>@@` clause are checked against that product being active, so a
correctly-gated scoped token passes even in a belt where the product happens to be inactive
(the clause is dropped in that belt).
