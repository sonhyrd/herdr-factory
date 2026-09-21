// THE PROMPT CONTRACT — the public API a user `prompt_file` writes against, plus the render-time
// dataflow gating the engine uses to honour it. This is the single source of truth for:
//   1. which `@@TOKEN@@`s the engine substitutes into a step's prompt, and WHEN (their scope),
//   2. the `@@WHEN:<product>@@ … @@END@@` product-gated clause syntax,
//   3. validating a user-supplied prompt against both (so a typo'd or out-of-scope token is caught
//      at config-load / render instead of silently reaching the agent unrendered),
//   4. the docs/PROMPTS.md reference (a test guards that doc against this catalog).
//
// It is a near-leaf: it imports only `types` and the product-capability registry, so both the config
// loader (load-time validation) and the step renderer (render-time gating + validation) can depend on
// it without a cycle. `SOURCE_PRODUCTS`, `productActiveFor` and `stripInactiveProductBlocks` live here
// (not in config.ts / step.ts) for the same reason — they ARE the dataflow contract this file defines.
import type { GuardKind, ProductType, SourceType } from "../types.ts";
import type { StepConfig } from "../config.ts";
import { PRODUCT_CAPABILITIES } from "../products/registry.ts";

// ── The dataflow roots: what each source materializes at belt_start ─────────────────────────────
// The roots of the product graph the loader validates each step's `consumes` against, and the base
// case for `productActiveFor`. Only `work_spec` is ever a REQUIRED consume; `work_raw` /
// `close_reference` are optional, so this only needs to be right for required edges.
export const SOURCE_PRODUCTS: Record<SourceType, ProductType[]> = {
  jira: ["work_spec", "work_raw", "human_reply"],
  local_markdown: ["work_spec", "human_reply"],
  github_issues: ["work_spec", "work_raw", "human_reply", "close_reference"],
  // sentry: materializes task.md (work_spec) + issue.json (work_raw); ask-human via Sentry notes.
  // No close_reference — Sentry issues have no PR-body auto-close keyword.
  sentry: ["work_spec", "work_raw", "human_reply"],
};

// ── Product-active gating (design §8) ───────────────────────────────────────────────────────────

/** Predicate: is `product` ACTIVE for `step`'s prompt in this belt? True when the step produces it,
 *  or consumes it AND it's produced upstream (an earlier step or the source's roots). An inactive
 *  optional consume gets no @@TOKEN@@ injected and its @@WHEN:<product>@@…@@END@@ clauses stripped. */
export function productActiveFor(
  steps: readonly Pick<StepConfig, "name" | "produces" | "consumes">[],
  step: Pick<StepConfig, "name" | "produces" | "consumes">,
  sourceType: SourceType,
): (product: ProductType) => boolean {
  const idx = steps.findIndex((s) => s.name === step.name);
  const upstream = idx >= 0 ? steps.slice(0, idx) : [];
  const available = new Set<ProductType>([
    ...(SOURCE_PRODUCTS[sourceType] ?? []),
    ...upstream.flatMap((s) => s.produces),
    ...step.produces,
  ]);
  return (product) =>
    available.has(product) && (step.produces.includes(product) || step.consumes.some((c) => c.type === product));
}

/** Strip product-gated blocks: `@@WHEN:<product>@@ … @@END@@` is kept (delimiters removed) when the
 *  product is active, else the whole block — prose AND any @@TOKEN@@s inside — is removed, so an
 *  unsatisfied optional consume leaves no dangling token and no orphaned clause. Non-nesting. */
export function stripInactiveProductBlocks(body: string, isActive: (product: ProductType) => boolean): string {
  return body.replace(/@@WHEN:([a-z_]+)@@([\s\S]*?)@@END@@/g, (_m, product: string, inner: string) =>
    isActive(product as ProductType) ? inner : "",
  );
}

// ── The token catalog ───────────────────────────────────────────────────────────────────────────

/** WHEN the engine substitutes a token into a step's prompt:
 *  - `universal` — always (every step, every belt).
 *  - `product`   — only when that product is ACTIVE for the step (`productActiveFor`): the step
 *                  produces it, or consumes it and an upstream step / the source produces it.
 *  - `guard`     — only when the step declares that guard (exclusive_resource → the capture mutex). */
export type TokenScope =
  | { readonly kind: "universal" }
  | { readonly kind: "product"; readonly product: ProductType }
  | { readonly kind: "guard"; readonly guard: GuardKind };

export interface PromptTokenSpec {
  /** The literal token as written in a prompt, e.g. `@@KEY@@`. */
  readonly token: string;
  readonly scope: TokenScope;
  /** One-line description — the documentation source of truth (surfaced in docs/PROMPTS.md). */
  readonly summary: string;
}

// Universal tokens: always substituted (step.ts builds these unconditionally into `sub`). Keep this
// list in lock-step with that object — a test asserts every token here appears (quoted) in step.ts.
const UNIVERSAL: readonly PromptTokenSpec[] = [
  { token: "@@KEY@@", scope: { kind: "universal" }, summary: "the work item's key/id (Jira key, GitHub issue number, markdown stem, Sentry short-id)" },
  { token: "@@REPO@@", scope: { kind: "universal" }, summary: "the repo config name (what you pass to `--repo`)" },
  { token: "@@BELT@@", scope: { kind: "universal" }, summary: "the belt this run is on" },
  { token: "@@STEPS@@", scope: { kind: "universal" }, summary: "the belt's full ordered step sequence (step names joined by ` → `)" },
  { token: "@@STEP@@", scope: { kind: "universal" }, summary: "this step's name" },
  { token: "@@TYPE@@", scope: { kind: "universal" }, summary: "the work item's type (feature/bug/chore/…); may be empty" },
  { token: "@@SUMMARY@@", scope: { kind: "universal" }, summary: "the work item's summary/title" },
  { token: "@@BRANCH@@", scope: { kind: "universal" }, summary: "the branch the run's worktree is currently on (tracked — an agent may rename it with @@SET_BRANCH_CMD@@)" },
  { token: "@@WORKTREE@@", scope: { kind: "universal" }, summary: "absolute path to the run's worktree" },
  { token: "@@MEMORY_DIR@@", scope: { kind: "universal" }, summary: "the per-run working dir (`.memory/herdr-factory`), relative to the worktree" },
  { token: "@@WORK_DOC@@", scope: { kind: "universal" }, summary: "path to the materialized work doc (ticket.json / task.md / task/)" },
  { token: "@@WORK_DOC_KIND@@", scope: { kind: "universal" }, summary: "a human label for the work doc's shape (e.g. \"Jira ticket (JSON)\", \"markdown file\")" },
  { token: "@@HANDOFF_IN@@", scope: { kind: "universal" }, summary: "path to the prior step's handoff note (\"(none — first step)\" on the first step)" },
  { token: "@@HANDOFF_OUT@@", scope: { kind: "universal" }, summary: "path this step must write its own handoff note to" },
  { token: "@@PRIOR_PANE@@", scope: { kind: "universal" }, summary: "the prior step's herdr pane id, for on-demand queries (\"(none)\" if none)" },
  { token: "@@PRIOR_SESSION@@", scope: { kind: "universal" }, summary: "the prior step's agent session id (\"(none)\" if none)" },
  { token: "@@STEP_DONE_CMD@@", scope: { kind: "universal" }, summary: "the exact command to signal this step complete" },
  { token: "@@ASK_HUMAN_CMD@@", scope: { kind: "universal" }, summary: "the exact command to ask a human and park the run" },
  { token: "@@SET_BRANCH_CMD@@", scope: { kind: "universal" }, summary: "the exact command to put this run's worktree on another branch name (the repo's branch convention) — rename BEFORE pushing; refused once the PR is open" },
  { token: "@@BOUNCE_CMD@@", scope: { kind: "universal" }, summary: "command to send the work back to the earlier step (empty when this step can't bounce)" },
  { token: "@@BOUNCE_TARGET@@", scope: { kind: "universal" }, summary: "the step name a bounce returns to (empty when this step can't bounce)" },
  { token: "@@BOUNCE_REASON_FILE@@", scope: { kind: "universal" }, summary: "path to write bounce findings to (empty when this step can't bounce)" },
  { token: "@@CLI@@", scope: { kind: "universal" }, summary: "absolute path to the herdr-factory CLI binary" },
  { token: "@@PASS@@", scope: { kind: "universal" }, summary: "which entry into this step this is (1 on the first; 2+ after a bounce or an operator rework) — a step reuses its own prior pass's work rather than redoing it" },
  { token: "@@GATE_CMD@@", scope: { kind: "universal" }, summary: "wrapper that runs one verification command (test/typecheck/lint) and records a RECEIPT against the run — renders with `<gate-name>` and `<command>` placeholders the agent replaces" },
  { token: "@@GATE_RECEIPTS_CMD@@", scope: { kind: "universal" }, summary: "the command that lists this run's gate receipts (which gates already ran, at which commit, with what result) so a later step trusts them instead of re-running them" },
  { token: "@@COMMIT_CONVENTIONS@@", scope: { kind: "universal" }, summary: "the repo's commit-message conventions from `conventions.commits` (empty — and leaves no trace — when that key is unset)" },
];

// Capability-scoped tokens for the `pull_request` product — substituted only when pull_request is
// ACTIVE for the step (the step produces the PR, i.e. the `pr` step). @@PR_TEMPLATE@@ carries the
// target repo's OWN pull-request template (read from the worktree at render time), so the PR follows
// the team's shape rather than the factory's baked default. Empty when the repo ships no template —
// the base summary+testing-notes wording then applies unchanged. `@@PR_NUMBER@@` stays OUT of this
// catalog on purpose (it belongs to the resolver wake-prompt — see the PROMPT_TOKENS note below).
const PULL_REQUEST: readonly PromptTokenSpec[] = [
  {
    token: "@@PR_TEMPLATE@@",
    scope: { kind: "product", product: "pull_request" },
    summary: "the target repo's own PR template (`.github/PULL_REQUEST_TEMPLATE.md` and the other standard locations), reproduced for the agent to fill faithfully; empty when the repo ships none",
  },
  {
    token: "@@PR_OPTIONS@@",
    scope: { kind: "product", product: "pull_request" },
    summary: "the belt's PR opening policy from its `pr:` block (draft / title template / labels / reviewers / assignees) as `gh pr create` instructions; empty when the belt sets no `pr:` block",
  },
  {
    token: "@@PR_AUTOMATED_ROUND@@",
    scope: { kind: "product", product: "pull_request" },
    summary: "the pr step's automated-round (CI/bot polling) instructions, sized by the belt's `pr.automated_round_minutes` (default ~10 min; 0 = skip the round entirely)",
  },
];

// Capability-scoped tokens for the `evidence` product — substituted only when evidence is ACTIVE for
// the step (it captures evidence, or a work→evidence→review→pr belt puts an upstream evidence step
// before a consumer). The token NAMES are owned by the product-capability registry; a test asserts
// this set equals PRODUCT_CAPABILITIES' `evidence` tokens so the two can't drift.
const EVIDENCE: readonly PromptTokenSpec[] = [
  { token: "@@EVIDENCE_DIR@@", scope: { kind: "product", product: "evidence" }, summary: "directory to write captured screenshots/video into" },
  { token: "@@EVIDENCE_UPLOAD_CMD@@", scope: { kind: "product", product: "evidence" }, summary: "command that publishes @@EVIDENCE_DIR@@ to S3/CloudFront (a no-op when `evidence:` is unconfigured)" },
  { token: "@@CAPTURE_ATTEMPT_CMD@@", scope: { kind: "product", product: "evidence" }, summary: "command that signals a capture attempt so the engine can cap flaky-capture loops" },
];

// Guard-scoped tokens for the exclusive_resource (capture-mutex) guard — substituted only for a step
// that declares it (today only `evidence`). The lock name comes from the guard, so it lives in one
// place (the descriptor), not hardcoded here.
const CAPTURE_LOCK: readonly PromptTokenSpec[] = [
  { token: "@@CAPTURE_LOCK_ACQUIRE_CMD@@", scope: { kind: "guard", guard: "exclusive_resource" }, summary: "acquire the machine-global capture mutex before driving the app" },
  { token: "@@CAPTURE_LOCK_RELEASE_CMD@@", scope: { kind: "guard", guard: "exclusive_resource" }, summary: "release the capture mutex when done" },
];

/** Every token a user `prompt_file` may reference, with its scope + description. NOTE this is
 *  deliberately NOT "every token PRODUCT_CAPABILITIES declares": `@@PR_NUMBER@@` (and the reserved
 *  `@@WORK_RAW@@` / `@@CLOSE_REFERENCE@@`) belong to the resolver wake-prompt or are not yet wired
 *  into step prompts, so a `prompt_file` referencing them would reach the agent unrendered — the
 *  validator rejects them on purpose. This catalog is exactly the set step.ts substitutes into a
 *  belt step's prompt. */
export const PROMPT_TOKENS: readonly PromptTokenSpec[] = [...UNIVERSAL, ...PULL_REQUEST, ...EVIDENCE, ...CAPTURE_LOCK];

/** Every product name the engine knows (the closed ProductType set), for validating `@@WHEN:<x>@@`. */
export const KNOWN_PRODUCTS: ReadonlySet<ProductType> = new Set(PRODUCT_CAPABILITIES.map((p) => p.product));

/** A step's token-availability context: is a product active in this belt's dataflow, and which
 *  guards does the step declare. Together they determine exactly which tokens the engine substitutes. */
export interface PromptStepContext {
  readonly isActive: (product: ProductType) => boolean;
  readonly guardKinds: ReadonlySet<GuardKind>;
}

/** The tokens the engine WILL substitute into this step's prompt: universal ∪ active-product ∪
 *  declared-guard. Everything else, if referenced, would reach the agent literally. */
export function availablePromptTokens(ctx: PromptStepContext): Set<string> {
  const out = new Set<string>();
  for (const t of PROMPT_TOKENS) {
    if (t.scope.kind === "universal") out.add(t.token);
    else if (t.scope.kind === "product" && ctx.isActive(t.scope.product)) out.add(t.token);
    else if (t.scope.kind === "guard" && ctx.guardKinds.has(t.scope.guard)) out.add(t.token);
  }
  return out;
}

/** Human hint for WHY a known-but-unavailable token isn't substituted here (used in error messages). */
function scopeHint(token: string): string {
  const spec = PROMPT_TOKENS.find((t) => t.token === token);
  if (!spec) return "it is not part of the prompt contract";
  if (spec.scope.kind === "product") return `the \`${spec.scope.product}\` product is active for this step (produced by it or an upstream step)`;
  if (spec.scope.kind === "guard") return `this step declares the \`${spec.scope.guard}\` guard`;
  return "always"; // universal — never unavailable
}

// ── User-prompt validation ──────────────────────────────────────────────────────────────────────

/**
 * Validate a user-supplied prompt body against the contract for a specific step, returning a list of
 * human-readable problems (empty ⇒ the prompt is contract-clean). It replicates the engine's own
 * render — strip inactive `@@WHEN@@` blocks, then check the surviving `@@TOKEN@@`s — so it flags
 * EXACTLY the tokens that would reach the agent unrendered, and nothing that the engine would have
 * stripped or substituted.
 *
 * Checks:
 *   - `@@WHEN:<product>@@ … @@END@@` clauses are well-formed (`@@WHEN:<known-product>@@`), balanced,
 *     and non-nested (the engine strips non-nesting; a nested clause wouldn't behave as written).
 *   - After stripping the clauses that this belt's dataflow would drop, every remaining `@@TOKEN@@`
 *     is one the engine substitutes for this step (universal, or an active product / declared guard).
 */
export function validatePromptBody(body: string, ctx: PromptStepContext): string[] {
  const structural = validateWhenClauses(body);
  // If the clause structure is broken, the strip below would misbehave (leftover markers read as
  // bogus tokens); report the structural problems alone so the message stays actionable.
  if (structural.length) return structural;

  const available = availablePromptTokens(ctx);
  const stripped = stripInactiveProductBlocks(body, ctx.isActive);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of stripped.matchAll(/@@[A-Z][A-Z0-9_]*@@/g)) {
    const tok = m[0];
    if (available.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    if (PROMPT_TOKENS.some((t) => t.token === tok)) {
      problems.push(`${tok} is only substituted when ${scopeHint(tok)} — as written it would reach the agent unrendered (wrap it in @@WHEN:<product>@@ … @@END@@, or use a belt where it applies)`);
    } else {
      problems.push(`${tok} is not a known prompt token — it would reach the agent literally (see docs/PROMPTS.md for the token reference)`);
    }
  }
  return problems;
}

/** Structural check of the `@@WHEN:<product>@@ … @@END@@` clauses: shape, known product, balance, no
 *  nesting. Separated out so a broken clause is reported before the token scan (which would otherwise
 *  trip over leftover markers). */
function validateWhenClauses(body: string): string[] {
  const problems: string[] = [];
  // Shape + known-product: any `@@WHEN…@@` marker must be exactly `@@WHEN:<lowercase-product>@@`.
  for (const m of body.matchAll(/@@WHEN\b[^@]*@@/g)) {
    const full = m[0];
    const shaped = /^@@WHEN:([a-z_]+)@@$/.exec(full);
    if (!shaped) {
      problems.push(`malformed clause "${full}" — a product gate is written @@WHEN:<product>@@ … @@END@@`);
      continue;
    }
    if (!KNOWN_PRODUCTS.has(shaped[1] as ProductType)) {
      problems.push(`@@WHEN:${shaped[1]}@@ names an unknown product "${shaped[1]}" (known products: ${[...KNOWN_PRODUCTS].sort().join(", ")})`);
    }
  }
  // Balance + nesting: walk the WHEN/END markers left-to-right (the engine's strip is non-nesting).
  let open = false;
  for (const m of body.matchAll(/@@WHEN:[a-z_]+@@|@@END@@/g)) {
    if (m[0] === "@@END@@") {
      if (!open) problems.push("@@END@@ without a matching @@WHEN:<product>@@ before it");
      open = false;
    } else {
      if (open) problems.push("nested @@WHEN@@ is not supported — close the previous clause with @@END@@ first");
      open = true;
    }
  }
  if (open) problems.push("a @@WHEN:<product>@@ clause is missing its closing @@END@@");
  return problems;
}
