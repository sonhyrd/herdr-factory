import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { hostname } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  DEFAULT_AGENT_CONFIG,
  EFFECT_PRODUCE_PRODUCTS,
  HERDR_AGENT_KINDS,
  type AgentConfig,
  type BeltEffect,
  type EffectSpec,
  type GuardSpec,
  type InputSpec,
  type ProductType,
  type SourceType,
  type StepPosture,
  type WorkState,
} from "./types.ts";
import { type BranchTaxonomy, DEFAULT_BRANCH_TAXONOMY } from "./core/branch.ts";
import { expandHome } from "./paths.ts";
import { SOURCE_DESCRIPTORS, descriptorFor } from "./sources/registry.ts";
import { HEARTBEAT_GUARD, READ_ONLY_GUARD, STEP_DESCRIPTORS, stepDescriptorFor, type StepDescriptor } from "./steps/registry.ts";
import { productCapabilityFor } from "./products/registry.ts";
import { SOURCE_PRODUCTS, productActiveFor, validatePromptBody } from "./prompts/contract.ts";
import { CONFIG_PACK_SUBDIR, SHIPPED_PROMPTS_DIR, resolvePromptFile } from "./prompt-packs.ts";
import { configDir, listConfiguredRepos, repoConfigDir, serverInfoPath, stateRoot } from "./config-paths.ts";

// SOURCE_PRODUCTS + the dataflow-gating helpers live in the leaf prompt-contract module (so the
// renderer and this loader share one definition without a cycle); re-exported here because it has
// long been part of config.ts's surface.
export { SOURCE_PRODUCTS } from "./prompts/contract.ts";

export { listConfiguredRepos, repoConfigDir, serverInfoPath } from "./config-paths.ts";

// ── Work sources: where to poll work from (no agents/pipeline here anymore — that's a belt). ──
// Each type's block schema + resolution lives on its descriptor (src/sources/<type>/descriptor.ts);
// this file only joins them into the discriminated union and drives the generic resolve loop.

// ── Evidence publisher: where the `evidence` step publishes captured screenshots/video. A discriminated
// union on `publisher` (same idiom as the source types), default `s3` so today's block — written with no
// `publisher:` key — is byte-identical. Optional overall: a repo that omits the block still gets an
// evidence step (capture + assess + bounce), it just publishes nothing.
//   - `s3`      — S3 + CloudFront (unchanged). Non-secret pointers ONLY; AWS creds come from the ambient
//                 chain (~/.aws / AWS_* env / SSO / the named `profile`), never stored or handed to an agent.
//   - `local`   — copy captures into a directory the resident server serves; URLs point at that server
//                 (`/evidence/<prefix>/<file>`). Zero cloud setup — same-machine/tailnet reviewers + the dashboard.
//   - `command` — a user executable receives the capture dir + key prefix and prints public URLs to stdout
//                 (bring-your-own backend: GCS, Azure, an internal artifact store).
// `key_prefix` (optional, slashes trimmed) and `github_username` (optional per-user folder; else the gh
// login at upload time) are shared: every publisher lays evidence under the SAME key layout
// `herdr-factory/<github_username>/<key_prefix>/<work_key>/<run>-<timestamp>/<file>`, so the URL stays
// "prefix + filename" regardless of backend.
const evidenceKeyPrefixField = z
  .string()
  .trim()
  .default("")
  .transform((s) => s.replace(/^\/+|\/+$/g, ""));
const evidenceGithubUsernameField = z.string().trim().min(1).optional();

const S3EvidenceSchema = z
  .object({
    publisher: z.literal("s3").default("s3"),
    bucket: z.string().trim().min(1),
    region: z.string().trim().min(1),
    // Accept a bare host or a full URL; normalize to a bare host used to build https:// asset URLs.
    cloudfront_domain: z
      .string()
      .trim()
      .min(1)
      .transform((s) => s.replace(/^https?:\/\//, "").replace(/\/+$/, "")),
    key_prefix: evidenceKeyPrefixField,
    // Optional AWS CLI named profile (else the default credential chain).
    profile: z.string().trim().min(1).optional(),
    github_username: evidenceGithubUsernameField,
  })
  .strict();

const LocalEvidenceSchema = z
  .object({
    publisher: z.literal("local"),
    // Public origin the served captures are reachable at (no trailing slash), used to build the links.
    // Default `http://127.0.0.1:<server port>` (same-machine); a tailnet reviewer sets this to the
    // machine's reachable origin. The resident server must be running for the URLs to resolve.
    public_base_url: z
      .string()
      .trim()
      .min(1)
      .transform((s) => s.replace(/\/+$/, ""))
      .optional(),
    key_prefix: evidenceKeyPrefixField,
    github_username: evidenceGithubUsernameField,
  })
  .strict();

const CommandEvidenceSchema = z
  .object({
    publisher: z.literal("command"),
    // The executable (a bare path/name) or a full argv array (executable + fixed flags). The capture
    // directory and the key prefix are appended as the final two args at publish time; the command
    // uploads the bytes and prints one public URL per file to stdout (each ending in that file's path,
    // so the "prefix + filename" shape holds). Run with no shell (argv, execFile).
    command: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]).transform((c) => (typeof c === "string" ? [c] : c)),
    // Seconds before the publish command is killed (a hung backend must not wedge the outbox flush).
    timeout_seconds: z.coerce.number().int().positive().default(300),
    key_prefix: evidenceKeyPrefixField,
    github_username: evidenceGithubUsernameField,
  })
  .strict();

const EvidenceBlockSchema = z.preprocess(
  // Default the discriminant to `s3` so a block written the old way (no `publisher:` key) is unchanged.
  (v) => (v && typeof v === "object" && !Array.isArray(v) && !("publisher" in v) ? { ...v, publisher: "s3" } : v),
  z.discriminatedUnion("publisher", [S3EvidenceSchema, LocalEvidenceSchema, CommandEvidenceSchema]),
);

/** The S3 key prefix for one evidence capture:
 *  `herdr-factory / <github_username> / <key_prefix> / <ticketKey> / <runId>-<timestamp>`.
 *  Empty segments (unset username or key_prefix) are dropped, so the base is always `herdr-factory/`. */
export function evidenceKeyPrefix(opts: {
  githubUsername?: string;
  keyPrefix?: string;
  ticketKey: string;
  runId: number | string;
  stamp: string;
}): string {
  return ["herdr-factory", opts.githubUsername, opts.keyPrefix, opts.ticketKey, `${opts.runId}-${opts.stamp}`]
    .filter(Boolean)
    .join("/");
}

/** Parsed evidence block (the discriminated-union output of `EvidenceBlockSchema`). */
type ParsedEvidence = z.infer<typeof EvidenceBlockSchema>;

/** snake_case parsed evidence block → the camelCase resolved variant carried on `Config.evidence`. */
function resolveEvidence(ev: ParsedEvidence | undefined): Config["evidence"] {
  if (!ev) return undefined;
  switch (ev.publisher) {
    case "s3":
      return {
        publisher: "s3",
        bucket: ev.bucket,
        region: ev.region,
        cloudfrontDomain: ev.cloudfront_domain,
        keyPrefix: ev.key_prefix,
        githubUsername: ev.github_username,
        profile: ev.profile,
      };
    case "local":
      return { publisher: "local", publicBaseUrl: ev.public_base_url, keyPrefix: ev.key_prefix, githubUsername: ev.github_username };
    case "command":
      return { publisher: "command", command: ev.command, timeoutSeconds: ev.timeout_seconds, keyPrefix: ev.key_prefix, githubUsername: ev.github_username };
  }
}

// A work source is just identity + a type-specific backend block. The OPTIONAL `name` (default =
// type, unique within the repo) is what a belt's `source:` references and what each run records on
// its `work_source` column.
// `.strict()` on the union members (each descriptor's configSchema): an unknown key (a typo, or
// the wrong type's block) is rejected at parse time with a clear "Unrecognized key" rather than
// being silently dropped. The union is assembled from the registry so a new source type never
// edits this file.
/** The minimal shape every parsed source object shares; the type-specific block rides along as
 *  unknown keys and is interpreted by its descriptor's resolveConfig. */
interface ParsedWorkSource {
  type: SourceType;
  name?: string;
  [key: string]: unknown;
}
const WorkSourceSchema = z.discriminatedUnion(
  "type",
  SOURCE_DESCRIPTORS.map((d) => d.configSchema) as unknown as Parameters<typeof z.discriminatedUnion>[1],
) as unknown as z.ZodType<ParsedWorkSource>;

// ── Belts: a (source + ordered steps) pairing. The belt is the unit of work flow. ──

// A step's herdr layout target. OPTIONAL, both-or-neither: when tab+pane are set the dispatcher
// waits for the user's layout to bring that pane up (with an idle agent) and delivers the prompt
// there — it never spawns its own. When omitted, it spawns a dedicated pane itself.
const layoutFields = { tab: z.string().optional(), pane: z.string().optional() };
const bothOrNeither = (a: { tab?: string; pane?: string }) => (a.tab == null) === (a.pane == null);
const layoutRefine = {
  message: "tab and pane must be set together (or both omitted to spawn a dedicated pane)",
  path: ["pane"] as string[],
};

// ── Layouts: a herdr tab/pane arrangement the factory BUILDS into a worktree right after it is
// created (absorbed from the workspace-manager plugin). A repo-level `layouts:` library of named
// arrangements; each belt selects one per worktree — the first of its `layout_matching` globs that
// matches the branch, else its `default_layout`. Building the layout is what brings up the panes a
// step's `tab`/`pane` (above) then targets, so the factory no longer waits on a hand-built layout. ──

// A layout-level setup command, run once in the single `setup: true` pane before that pane's own
// command or agent. `blocking: true` makes the builder wait for it to finish before spawning any
// later tab; an agent on the setup pane always waits for it either way (herdr can only start an agent
// in a pane that is back at its shell prompt).
const LayoutSetupSchema = z.object({ command: z.string().trim().min(1), blocking: z.boolean().default(false) }).strict();

// Environment for a pane's process — layout-level (every pane) and pane-level (that pane only, and it
// wins on conflict). Values are stringified so `PORT: 3000` needs no quoting.
const LayoutEnvSchema = z.record(z.string().trim().min(1), z.union([z.string(), z.number(), z.boolean()]).transform(String));

// A positive whole number of milliseconds (an agent/prompt timeout).
const MillisSchema = z.coerce.number().int().positive();

// herdr's own constraint on an agent name: it must be unique among LIVE agents and match this shape
// (`herdr agent start` answers `invalid_agent_name` otherwise). Enforced here so a bad name is a load
// error rather than a layout that half-builds.
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// A pane's extent along the split axis. A "30%" string (or a fraction 0<n<1) is a percentage of the
// parent; an integer ≥1 is a fixed cell count. Collapsed to {percent}|{cells} at load (normalizeSize).
const PaneSizeSchema = z.union([
  z.string().trim().regex(/^\d+(\.\d+)?%$/, 'size must be a percentage like "30%"'),
  z.number().positive(),
]);

// Split direction. vertical/right → a new pane to the RIGHT; horizontal/down → BELOW. Normalized to
// "right"|"down" at load (matches herdr's `pane split --direction`).
const PaneSplitSchema = z.enum(["vertical", "horizontal", "right", "down"]);

// The agent-only pane keys. Named here so a pane carrying one WITHOUT `agent:` can be rejected: that
// is almost always a typo or a half-finished edit, and ignoring it silently leaves the user staring at
// a pane that never starts an agent.
const AGENT_PANE_KEYS = ["agent_name", "agent_args", "prompt", "agent_timeout_ms", "prompt_timeout_ms"] as const;

const LayoutPaneSchema = z
  .object({
    title: z.string().trim().min(1).optional(), // herdr pane label (what a step's `pane` matches)
    // A shell command, run as the pane's PROCESS (not typed into its shell) inside your interactive
    // login shell — so .zshrc/.bash_profile PATH setup (mise, asdf, nvm) applies exactly as it did
    // when it was typed. When it exits the pane is handed back to a shell prompt unless
    // `persist: false`. Mutually exclusive with `agent`.
    command: z.string().trim().min(1).optional(),
    persist: z.boolean().optional(), // default true; only meaningful with `command`
    // An agent pane: the herdr agent KIND to start here (`agent: claude`). herdr starts it with
    // `agent start --kind --pane`, which returns only once it has DETECTED the agent and marked it
    // ready for input — so the layout knows it actually came up, and a step's first prompt can't land
    // in a shell that isn't listening yet. This is what a step-targeted pane should use.
    agent: z.enum(HERDR_AGENT_KINDS as [string, ...string[]]).optional(),
    agent_name: z.string().trim().min(1).optional(), // stable herdr agent alias; derived when unset
    agent_args: z.array(z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional(),
    // An opening prompt submitted once the agent is ready. For a pane a STEP targets, leave this
    // unset — the reconciler dispatches that step's own prompt (rejected at load, see LayoutSchema).
    prompt: z.string().trim().min(1).optional(),
    agent_timeout_ms: MillisSchema.optional(), // how long to wait for the agent to become ready
    prompt_timeout_ms: MillisSchema.optional(), // set ⇒ wait for the agent to settle after prompting
    env: LayoutEnvSchema.optional(), // this pane's environment (wins over the layout's)
    setup: z.boolean().default(false), // THIS is the pane the layout-level setup command runs in
    split: PaneSplitSchema.optional(), // how this pane splits off the previous one (ignored on pane 0)
    ratio: z.number().gt(0).lt(1).optional(), // legacy: the fraction the PREVIOUS pane keeps
    size: PaneSizeSchema.optional(), // this pane's extent (mutually exclusive with ratio)
  })
  .strict()
  .refine((p) => !(p.ratio != null && p.size != null), { message: "set either ratio or size, not both", path: ["size"] })
  // An agent is started INTO the pane's shell, so a command occupying that shell would collide with it.
  .refine((p) => !(p.agent && p.command), { message: "set either `agent` or `command`, not both (an agent pane starts its agent itself)", path: ["agent"] })
  .refine((p) => !(p.persist != null && p.command == null), { message: "`persist` only applies to a pane with a `command`", path: ["persist"] })
  .refine((p) => p.agent != null || AGENT_PANE_KEYS.every((k) => p[k] == null), {
    message: `these keys need an \`agent:\` on the same pane: ${AGENT_PANE_KEYS.join(", ")}`,
    path: ["agent"],
  })
  .refine((p) => p.agent_name == null || AGENT_NAME_RE.test(p.agent_name), {
    message: "agent_name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 chars) — herdr's own rule",
    path: ["agent_name"],
  });

const LayoutTabSchema = z
  .object({
    title: z.string().trim().min(1).optional(), // herdr tab label (what a step's `tab` matches)
    panes: z.array(LayoutPaneSchema).min(1, "a tab needs at least one pane"),
  })
  .strict();

const LayoutSchema = z
  .object({
    id: z.string().trim().min(1),
    setup: LayoutSetupSchema.optional(),
    env: LayoutEnvSchema.optional(), // environment for every pane in this layout
    tabs: z.array(LayoutTabSchema).min(1, "a layout needs at least one tab"),
  })
  .strict()
  // At most one setup pane per layout (the setup command runs exactly once), and a layout that
  // declares a setup block must have a pane to run it in.
  .refine((l) => l.tabs.flatMap((t) => t.panes).filter((p) => p.setup).length <= 1, {
    message: "at most one pane in a layout may set `setup: true`",
    path: ["tabs"],
  })
  .refine((l) => !l.setup || l.tabs.some((t) => t.panes.some((p) => p.setup)), {
    message: "a layout with a `setup` block needs one pane marked `setup: true` to run it in",
    path: ["setup"],
  })
  // herdr requires agent names to be unique among LIVE agents; a layout that reuses one would fail
  // partway through its own build.
  .refine(
    (l) => {
      const names = l.tabs.flatMap((t) => t.panes).map((p) => p.agent_name).filter((n): n is string => n != null);
      return new Set(names).size === names.length;
    },
    { message: "two panes in this layout share an `agent_name` — herdr agent names must be unique", path: ["tabs"] },
  );

// A per-belt branch→layout rule: the first rule whose glob matches the worktree's branch wins (see
// resolveBeltLayout). `*` matches any run of chars (incl "/"), `?` a single char. `title` is docs.
const LayoutMatchRuleSchema = z
  .object({
    title: z.string().optional(),
    worktree_pattern: z.string().trim().min(1),
    layout: z.string().trim().min(1),
  })
  .strict();

// Where a `prompt_file` is resolved from: `config` = relative to this repo's config folder
// (repos/<name>/); `repo` = relative to the target repo checkout, read from the run's WORKTREE at
// render time (so the prompt can live version-controlled in the codebase).
const PromptSourceSchema = z.enum(["repo", "config"]);
// How a `prompt_file` relates to an engine-prompted step's shipped base. `augment` (the default)
// appends the file BELOW the base as extra repo-specific instructions; `replace` makes the file
// OWN the step body outright — the shipped prose is dropped, though the engine still wraps the body
// with the handover scaffold, repo guidelines, and token substitution (so a replacement prompt can
// still use @@…@@ tokens). Only meaningful for an engine-prompted step (work/evidence/review/pr)
// WITH a prompt_file: a `custom` step's prompt_file is already the whole body, and `replace` with no
// prompt_file has nothing to replace with — both are rejected at load (see superRefine).
const PromptModeSchema = z.enum(["augment", "replace"]);
// `prompt_file_source` defaults to `config` (the repo's config folder — where custom-step prompts
// live, and the location existence-checked at load), so a step that sets a `prompt_file` no longer
// has to repeat it. Set `repo` to read the prompt from the run's worktree (the target checkout) at
// render time instead. The default is inert on a step with no `prompt_file` (dropped at resolve).
const promptFileFields = { prompt_file: z.string().optional(), prompt_file_source: PromptSourceSchema.default("config"), prompt_mode: PromptModeSchema.default("augment") };

// Belt steps are references to registered step primitives (src/steps/registry.ts) — see
// BeltStepSchema below. There is no belt_type / agents map (clean break): a belt is one ordered
// steps[] list, and its lifecycle is derived from what the steps produce/declare.

// Step names are used in file paths (prompt-<name>.md / handoff-<name>.md), pane labels, and the
// step-done CLI arg — so keep them to a git/path-safe lowercase slug.
const StepNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "step name must be a lowercase slug ([a-z0-9_-], starting alphanumeric)");

// A belt step: a reference to a registered step primitive by `type` (work/evidence/review/pr/custom
// today). `name` defaults to `type` and must be unique within the belt (step names key run_steps
// rows, pane labels, prompt files). `prompt_file` is the WHOLE body for a `custom` step (required)
// and an OPTIONAL augment for an engine-prompted one; `prompt_file_source` says where to read it,
// and `prompt_mode: replace` makes the file OWN an engine-prompted step's body instead of augmenting.
// Optional per-step budget (else the descriptor default, else limits.step_budget_seconds) and
// commit-stall heartbeat (a `custom` step opts in; work/pr already have one).

// The config-declared capability allow-list for a `custom` step ref — how a user builds their own
// gates/stations without forking the registry. Only a step whose descriptor sets `refCapabilities`
// (custom) may carry these; a descriptor-declared step is rejected in superRefine (its capabilities
// are fixed). The product allow-list is deliberately TIGHT: `commits` is the only product a custom
// step may consume/produce — `pull_request`/`evidence` drag heavy engine machinery and stay
// descriptor/plugin territory (the enum rejects them at parse time). All four are still checked by
// the load-time dataflow rules (a required consume needs an upstream producer; a bounce emitter
// needs an upstream `bounce_feedback` consumer; `read_only` + producing `commits` is contradictory).
const CustomProductSchema = z.enum(["commits"]);
const capabilityFields = {
  consumes: z.array(CustomProductSchema).optional(),
  produces: z.array(CustomProductSchema).optional(),
  read_only: z.boolean().optional(),
  bounce: z.boolean().optional(),
};
const StepTypeSchema = z.enum(STEP_DESCRIPTORS.map((d) => d.name) as [string, ...string[]]);

// The agent-harness block: which binary + flags a factory-SPAWNED pane launches. Repo-level,
// overridable per belt AND per step ref. Threaded through StepConfig → the spawn argv (step.ts) and
// the PR-watch resolver (watch.ts). Both fields optional; the WHOLE block resolves as a unit at the
// nearest level that sets one (NOT field-by-field), because `flags` are command-specific — a belt
// that switches `command` to opencode must not inherit the repo's claude `--dangerously-skip-
// permissions`. ABSENT everywhere ⇒ the historical `claude --dangerously-skip-permissions`
// (DEFAULT_AGENT_CONFIG), so a spawned pane's argv is byte-identical to before. See resolveAgent.
const AgentBlockSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    flags: z.array(z.string()).optional(),
    // The herdr agent KIND to adopt this harness as (`herdr agent start --kind`). Needed ONLY when
    // `command` isn't itself a bare kind name — a wrapper script or an absolute path. Set it and the
    // pane is adopted (herdr blocks until the agent is ready for input); omit it for such a command
    // and the argv is typed into the pane instead, which works but has no readiness handshake.
    kind: z.enum(HERDR_AGENT_KINDS as [string, ...string[]]).optional(),
  })
  .strict();
type ParsedAgentBlock = z.infer<typeof AgentBlockSchema>;

const BeltStepSchema = z
  .object({
    type: StepTypeSchema,
    name: StepNameSchema.optional(),
    ...layoutFields,
    ...promptFileFields,
    ...capabilityFields,
    budget_seconds: z.coerce.number().int().positive().optional(),
    heartbeat: z.boolean().default(false),
    // Per-step override of the agent harness this step's SPAWNED pane launches (a step targeting a
    // layout pane drives whatever that pane runs, so this only bites a no-tab/pane step). Resolved
    // step over belt over repo over DEFAULT_AGENT_CONFIG — see resolveAgent.
    agent: AgentBlockSchema.optional(),
  })
  .strict()
  .refine(bothOrNeither, layoutRefine);

/** The fields a step ref may carry from the custom-step capability allow-list (all optional, and
 *  legal only on a `refCapabilities` step — enforced in superRefine). */
type CapabilityRef = { consumes?: readonly string[]; produces?: readonly string[]; read_only?: boolean; bounce?: boolean };

// The belt-level PR behavior block: how this belt's `pr` step opens the pull request, as POLICY
// (config) rather than a forked prompt. All fields optional — an ABSENT block leaves the rendered pr
// prompt byte-identical to before. `draft` opens the PR as a draft; `title` is a template using the
// same `{{work_id}}` / `{{work_slug}}` / … vars as `workspace_name` (rendered verbatim, no git
// sanitisation — see renderWorkVars); `labels`/`reviewers`/`assignees` are applied via `gh` at PR
// creation; `automated_round_minutes` sets the CI/bot polling window the pr agent runs (0 = skip the
// round entirely — open the PR and hand straight off to the dispatcher's review watch). Delivered as
// prompt tokens/clauses so the agent stays the actor (see src/core/step.ts + src/prompts/pr.md).
const PrBlockSchema = z
  .object({
    draft: z.boolean().optional(),
    title: z.string().trim().min(1).optional(),
    labels: z.array(z.string().trim().min(1)).optional(),
    reviewers: z.array(z.string().trim().min(1)).optional(),
    assignees: z.array(z.string().trim().min(1)).optional(),
    automated_round_minutes: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

// A per-belt branch-name template (the worktree + workspace derive from it). Must include
// {{work_id}} so the branch is identifiable by ticket; a short unique suffix is appended
// automatically (see branchName) so each claim — including a RE-claim of a previously-merged
// ticket — gets a distinct branch. Vars: {{work_id}} {{work_slug}} (<=slug_max) {{work_full_slug}}
// (<=full_slug_max) {{work_type}} {{semantic_work_prefix}} (from the `branch:` taxonomy below).
const WorkspaceNameSchema = z
  .string()
  .refine((s) => /\{\{\s*work_id\s*\}\}/.test(s), {
    message: "workspace_name must include {{work_id}} so each item gets a unique branch",
  })
  .optional();

// The branch-naming taxonomy: how a work-item type maps to `{{semantic_work_prefix}}` and the length
// caps for the slug vars. Repo-level, overridable per belt (see beltBase), each field resolved belt
// over repo over the historical defaults (resolveBranchTaxonomy). ABSENT everywhere ⇒ the historical
// fix|chore|feature taxonomy + 20/50 caps, so branch names are byte-identical to before.
//   `prefixes` maps a work TYPE to a prefix; a type matches a key case-insensitively by SUBSTRING (so
//     "Dev bug" → the "bug" rule, matching today's behavior), keys tried in declaration order. A
//     reserved `default` key is the fallback for an unmatched type (omitted ⇒ "feature").
//   `slug_max` / `full_slug_max` cap `{{work_slug}}` / `{{work_full_slug}}`.
// A belt's block resolves field-by-field: its `prefixes` (if set) REPLACES the repo's whole map, and
// each slug cap overrides independently — every field falling back to repo, then the default.
const BranchBlockSchema = z
  .object({
    prefixes: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
    slug_max: z.coerce.number().int().positive().optional(),
    full_slug_max: z.coerce.number().int().positive().optional(),
  })
  .strict();
type ParsedBranchBlock = z.infer<typeof BranchBlockSchema>;

/** Resolve a belt's effective {@link BranchTaxonomy}: each field is belt ?? repo ?? built-in default.
 *  A `prefixes` map fully REPLACES (not merges) at its level; the reserved `default` key is split out
 *  as the fallback prefix (absent ⇒ the built-in "feature"). Lives alongside workspace_name so branch
 *  naming is resolved in one place. */
function resolveBranchTaxonomy(repo: ParsedBranchBlock | undefined, belt: ParsedBranchBlock | undefined): BranchTaxonomy {
  const prefixesRaw = belt?.prefixes ?? repo?.prefixes;
  let prefixes = DEFAULT_BRANCH_TAXONOMY.prefixes;
  let defaultPrefix = DEFAULT_BRANCH_TAXONOMY.default;
  if (prefixesRaw) {
    const { default: d, ...rest } = prefixesRaw;
    prefixes = rest;
    defaultPrefix = d ?? DEFAULT_BRANCH_TAXONOMY.default;
  }
  return {
    prefixes,
    default: defaultPrefix,
    slugMax: belt?.slug_max ?? repo?.slug_max ?? DEFAULT_BRANCH_TAXONOMY.slugMax,
    fullSlugMax: belt?.full_slug_max ?? repo?.full_slug_max ?? DEFAULT_BRANCH_TAXONOMY.fullSlugMax,
  };
}

/** Resolve the effective {@link AgentConfig} for a spawned pane: the NEAREST level that sets an
 *  `agent:` block wins WHOLE (step over belt over repo) — within it, `command` defaults to
 *  {@link DEFAULT_AGENT_CONFIG}'s `claude` and `flags` to `[]` (you own the flags once you name a
 *  block, so opencode never inherits claude's). No block at any level ⇒ DEFAULT_AGENT_CONFIG, keeping
 *  today's `claude --dangerously-skip-permissions` byte-identical. */
function resolveAgent(repo: ParsedAgentBlock | undefined, belt: ParsedAgentBlock | undefined, step: ParsedAgentBlock | undefined): AgentConfig {
  const block = step ?? belt ?? repo;
  if (!block) return DEFAULT_AGENT_CONFIG;
  return { command: block.command ?? DEFAULT_AGENT_CONFIG.command, flags: block.flags ?? [], kind: block.kind };
}

// The canonical WorkState vocabulary + run outcomes, as config enums for the belt-effects block.
// These stay the engine's fixed spine; a belt effect's `to` names one of these (a canonical target)
// OR a source-native custom status key resolved at the source layer (see BeltEffect / INV-13).
const WORK_STATES = ["todo", "in_development", "in_review", "merged", "aborted", "done"] as const;
const OUTCOMES = ["merged", "closed", "abandoned", "timeout", "completed"] as const;

// Optional per-belt `effects:` block — configurable task progression onto source statuses. Each
// entry maps a TRIGGER (entering a step / producing a product / tearing down with an outcome) to a
// target status `to`. `to` is either a canonical WorkState (works on any source) or a source-native
// custom status key (a widened jira `status.<key>` / github `state_labels.<key>` entry); a custom
// `to` requires an `anchor` (a canonical WorkState) that fixes its monotonicity rank — the custom
// status sits just before that anchor stage. A belt with no `effects` behaves as the engine
// defaults. Cross-field validity (trigger targets exist, `to`/`anchor` coherence, source declares a
// custom status, no duplicate triggers) is enforced in superRefine, which knows the belt's steps +
// its source.
const BeltEffectSchema = z
  .discriminatedUnion("on", [
    z.object({ on: z.literal("enter"), step: z.string().trim().min(1) }).strict().extend({
      to: z.string().trim().min(1),
      anchor: z.enum(WORK_STATES).optional(),
    }),
    z.object({ on: z.literal("produce"), product: z.enum(EFFECT_PRODUCE_PRODUCTS) }).strict().extend({
      to: z.string().trim().min(1),
      anchor: z.enum(WORK_STATES).optional(),
    }),
    z.object({ on: z.literal("teardown"), outcome: z.enum(OUTCOMES) }).strict().extend({
      to: z.string().trim().min(1),
      anchor: z.enum(WORK_STATES).optional(),
    }),
  ]);

/** Resolve a belt effect's `to`/`anchor` into a canonical anchor WorkState + optional source-native
 *  status key. Returns null when `to` is a custom key with no anchor (a config error surfaced in
 *  superRefine — this is only reached after validation, so callers can assume non-null). */
function resolveEffectTarget(to: string, anchor?: WorkState): { to: WorkState; status?: string } | null {
  if ((WORK_STATES as readonly string[]).includes(to)) return { to: to as WorkState }; // canonical
  if (!anchor) return null; // custom status needs an explicit anchor
  return { to: anchor, status: to };
}

// Fields every belt shares. `source` references a work_source by name (validated below). `match`
// is an OPTIONAL path to a `.ts` module (default export = predicate); when omitted the belt
// accepts anything from its source. Lower `priority` = matched first (first matching belt claims).
const beltBase = {
  name: z.string().trim().min(1),
  source: z.string().trim().min(1),
  priority: z.coerce.number().int().default(100),
  // Active/inactive toggle: an inactive belt is skipped when claiming new work (Phase B) but its
  // in-flight runs progress exactly as usual — the status only gates taking on NEW work, letting
  // you temporarily pause a belt without deleting it. Default true (a belt with no `active` runs).
  active: z.boolean().default(true),
  workspace_name: WorkspaceNameSchema,
  match: z.string().optional(),
  // The label this belt picks up work by — the tag on a source item that flags it for this belt.
  // NO DEFAULT (deliberate: you name the label explicitly). REQUIRED for a belt whose source picks
  // up by label (jira, github_issues), FORBIDDEN for one whose source has no label concept
  // (local_markdown) — both enforced in superRefine, which knows each belt's source type. It's
  // threaded into the source's listEligible/transition/health, so it filters SERVER-SIDE (jira JQL,
  // GitHub's label query), not after the fact. Two belts may share a source only via DISTINCT
  // labels — the same (source, label) in two belts is contention (also rejected below).
  label: z.string().trim().min(1).optional(),
  // Optional per-belt override of the repo-wide max_bounces safety cap (the loop-safety backstop for
  // the fix↔evidence/review rework loop). Unset ⇒ falls back to limits.max_bounces.
  max_bounces: z.coerce.number().int().nonnegative().optional(),
  // Layout selection (absorbed from workspace-manager). The layout the factory builds into a fresh
  // worktree for this belt: the first `layout_matching` rule whose glob matches the branch, else
  // `default_layout`. Both reference an id in the repo-level `layouts:` library (checked in superRefine).
  // Unset ⇒ the factory builds nothing; steps spawn their own panes as before.
  default_layout: z.string().trim().min(1).optional(),
  layout_matching: z.array(LayoutMatchRuleSchema).default([]),
  // Optional belt-level PR behavior (draft / title template / labels / reviewers / assignees /
  // automated-round window). Rendered into the pr step's prompt as policy; only meaningful on a belt
  // that has a `pr` step (checked in superRefine). Absent ⇒ today's behavior, unchanged.
  pr: PrBlockSchema.optional(),
  // Optional per-belt override of the repo-level `branch:` taxonomy (prefix map + slug caps). Each
  // field resolves belt over repo over the historical defaults — see resolveBranchTaxonomy. Absent
  // (both here and at repo level) ⇒ today's fix|chore|feature naming, unchanged.
  branch: BranchBlockSchema.optional(),
  // Optional per-belt override of the repo-level `agent:` harness (command + flags a SPAWNED pane
  // launches). Resolved as a whole unit belt over repo over DEFAULT_AGENT_CONFIG — see resolveAgent.
  // A step ref may override it further. Absent everywhere ⇒ today's claude harness, unchanged.
  agent: AgentBlockSchema.optional(),
  // Optional configurable task progression (see BeltEffectSchema). Empty ⇒ engine defaults only.
  effects: z.array(BeltEffectSchema).default([]),
};

// A belt is a (source + ordered steps) pairing. `.strict()` rejects typos AND the removed
// belt_type/agents keys (clean break — no alias). Lifecycle (the terminal PR watch, the bounce cap,
// source transitions) is DERIVED at load from what the steps produce/declare, never from a belt_type.
const BeltSchema = z.object({ ...beltBase, steps: z.array(BeltStepSchema).min(1, "a belt needs at least one step") }).strict();

/** A step ref is SKIPPED when its descriptor requires a layout pane (requiresLayout — the evidence
 *  opt-in, generalized) but the ref supplies no tab/pane. Skipped steps don't run and don't
 *  contribute products. */
function stepSkipped(d: StepDescriptor, ref: { tab?: string; pane?: string }): boolean {
  return !!d.controls.posture?.requiresLayout && !(ref.tab && ref.pane);
}

/** Whether a step ref may extend its descriptor's declarations from the capability allow-list. Only
 *  a `refCapabilities` descriptor (custom) does — so a `read_only`/`bounce`/etc. on any other type
 *  is inert here (and rejected outright in superRefine). Centralizing the gate keeps the effective-
 *  declaration helpers below byte-identical to the descriptor's for every non-custom step. */
function refExtends(d: StepDescriptor): boolean {
  return d.refCapabilities === true;
}

/** The products a step ref actually produces: the descriptor's, plus `commits` when a step opts into
 *  a commit-stall heartbeat (heartbeat tracks commit HEAD movement, so it implies commits) or a
 *  custom step declares `produces: [commits]` (a code-writing station). */
function stepProduces(d: StepDescriptor, ref: { heartbeat?: boolean } & CapabilityRef): ProductType[] {
  const p = [...d.produces];
  const producesCommits = ref.heartbeat || (refExtends(d) && !!ref.produces?.includes("commits"));
  if (producesCommits && !p.includes("commits")) p.push("commits");
  return p;
}

/** The typed inputs a step ref actually consumes: the descriptor's, plus any custom-step
 *  `consumes: […]` opt-ins (a REQUIRED consume, so the load-time dataflow rule demands an upstream
 *  producer). Byte-identical to `d.consumes` for a non-custom step. */
function stepConsumes(d: StepDescriptor, ref: CapabilityRef): InputSpec[] {
  const consumes: InputSpec[] = d.consumes.map((c) => ({ ...c }));
  if (refExtends(d) && ref.consumes) {
    for (const type of ref.consumes) {
      if (!consumes.some((c) => c.type === type)) consumes.push({ type: type as ProductType, required: true });
    }
  }
  return consumes;
}

/** Whether a step EMITS a bounce: the descriptor declares it (evidence/review), or a custom step
 *  opts in with `bounce: true`. The target is resolved (to the earliest earlier `bounce_feedback`
 *  consumer) the same way for both. */
function stepBounces(d: StepDescriptor, ref: CapabilityRef): boolean {
  return !!d.controls.bounce || (refExtends(d) && ref.bounce === true);
}

/** The effective posture: the descriptor's, plus a custom step's `read_only` opt-in. For any
 *  non-custom step this is exactly `d.controls.posture` (so StepConfig stays byte-identical). */
function stepPosture(d: StepDescriptor, ref: CapabilityRef): StepPosture {
  const base = d.controls.posture ?? {};
  if (refExtends(d) && ref.read_only === true && !base.readOnly) return { ...base, readOnly: true };
  return base;
}

/** Resolve a bounce emitter's targets to the earliest earlier NON-SKIPPED step that consumes
 *  bounce_feedback (the receive side of the pair). [] ⇒ no valid target (a load error). */
function resolveBounceTargets(kept: { type: string; name?: string }[], index: number): string[] {
  for (let j = 0; j < index; j++) {
    const jd = stepDescriptorFor(kept[j]!.type);
    if (jd?.consumes.some((c) => c.type === "bounce_feedback")) return [kept[j]!.name ?? kept[j]!.type];
  }
  return [];
}

export const RepoConfigSchema = z
  .object({
    repo: z.object(
      {
        // Required-field errors are worded as directives (they read correctly whether the field is
        // missing or the wrong type) — the raw zod "expected string, received undefined" is opaque to
        // someone hand-writing their first config.
        path: z.string({ error: "set `repo.path` to your project's MAIN (non-linked) checkout — the clone worktrees fork from" }),
        base_ref: z.string().default("origin/main"),
        github: z.string().optional(),
      },
      { error: "add a `repo` section pointing at your project's main checkout (at least `repo.path`)" },
    ),
    limits: z
      .object({
        // Cap on concurrently WORKED workspaces (one worktree per run). A slot is held by a run
        // being actively worked — claiming/running/tearing_down, and a `reviewing` run ONLY while
        // its resolver is actively addressing review comments. Runs that keep their worktree but do
        // no work hold no slot: the parks (attention, waiting_for_human) and an idle PR-watch. So
        // neither human-blocked runs nor long-lived PRs-in-review starve the belt of new claims.
        // NOT a cap on total worktrees on disk (parked/watching runs add to that) nor on agents (a
        // run spawns one pane per step). The PR watch has no time limit — see reviewing occupancy.
        max_active_workspaces: z.coerce.number().int().positive().default(3),
        // Re-notify the operator about a run parked in `attention` every this-many seconds (the
        // escalation notify is easy to miss; a parked run should never go silently stale).
        attention_renotify_seconds: z.coerce.number().int().positive().default(3600),
        // Per-step budgets moved onto the step primitives (StepDescriptor.defaultBudgetSeconds) —
        // clean break. A belt step ref overrides with `budget_seconds`; a step whose descriptor
        // declares no default (custom) falls back to step_budget_seconds below.
        stall_seconds: z.coerce.number().int().positive().default(2700),
        // SAFETY BACKSTOP for the fix↔evidence/review rework loop — not the intended terminator. The
        // loop is meant to end when evidence/review pass (aligned) or the fix agent asks a human; this
        // cap only catches genuine oscillation. Max times a run may bounce back to any ONE earlier step
        // before escalating to attention. 0 disables bouncing (first bounce escalates). Per-belt
        // `max_bounces` overrides this.
        max_bounces: z.coerce.number().int().nonnegative().default(6),
        // SAFETY BACKSTOP for the evidence step's capture loop — not the intended terminator. The
        // evidence prompt's cooperative guidance is "re-record a flaky take, then ask a human"; this
        // cap catches an agent stuck re-capturing a nondeterministic app. Max capture attempts the
        // evidence agent may SIGNAL (via `capture-attempt`) in one pass before escalating to
        // attention. Reset per fresh pass into the step (unlike max_bounces, which is cumulative). 0
        // parks on the first attempt (effectively disables capture) — leave the default unless you
        // mean that.
        max_capture_attempts: z.coerce.number().int().nonnegative().default(5),
        // Default budget for a custom belt's step when it sets no `budget_seconds` of its own.
        step_budget_seconds: z.coerce.number().int().positive().default(3600),
        tick_interval_seconds: z.coerce.number().int().positive().default(60),
        // How many active runs Phase A reconciles concurrently. Most of a run's reconcile is
        // subprocess/network wait, so parallelism keeps tick wall-clock roughly flat as the
        // active-run count grows; each run still holds its own run lock.
        reconcile_concurrency: z.coerce.number().int().positive().default(8),
        // Max NEW claims per tick (each claim ≈ worktree checkout + materialize + ~5 source
        // calls). Smooths a big-backlog cold start over successive ticks instead of one
        // source-hammering mega-tick; remaining slots fill on the next passes.
        max_claims_per_tick: z.coerce.number().int().positive().default(10),
        // How often each work source is polled for new work (the `listEligible` call in Phase B).
        // Defaults to tick_interval_seconds — poll every tick, unchanged. Raise it to spare a
        // rate-limited source (a Jira board / GitHub issues); a per-source `poll_interval_seconds`
        // overrides this. A value <= tick_interval is a no-op (a source can't be polled faster than
        // the tick fires). Drain semantics: between polls a source contributes NO new claims, so its
        // backlog drains at max_claims_per_tick per POLL WINDOW, not per tick. Optional (not
        // defaulted) because the fallback is another limits field — resolved in loadConfig.
        source_poll_interval_seconds: z.coerce.number().int().positive().optional(),
        // How long to wait for a step's configured tab/pane to come up (with an idle agent)
        // before flagging the item for attention. Generous by default to allow the user's
        // layout setup + dev-server startup to finish; only applies to steps with a tab/pane.
        layout_wait_seconds: z.coerce.number().int().positive().default(600),
      })
      .prefault({}),
    // Backends this repo can pull work from (≥1). Each just names a type + its backend block;
    // the pipeline/agents live on a belt now.
    work_sources: z
      .array(WorkSourceSchema, { error: "add a `work_sources` list — at least one source to pull work from (jira, github_issues, local_markdown, or sentry)" })
      .min(1, "work_sources must list at least one source (jira, github_issues, local_markdown, or sentry)"),
    // Belts (≥1): each pairs a source with an ordered pipeline. At claim time belts are walked in
    // priority order and the first whose `match` accepts an item claims it (first match wins).
    belt: z
      .array(BeltSchema, { error: "add a `belt` list — at least one belt pairing a source with an ordered `steps` pipeline" })
      .min(1, "belt must list at least one belt (a source paired with an ordered `steps` pipeline)"),
    // Named herdr tab/pane arrangements this repo's belts build into a worktree on claim (referenced
    // by a belt's default_layout / layout_matching). Empty ⇒ the factory builds nothing.
    layouts: z.array(LayoutSchema).default([]),
    // Optional: where the evidence step publishes captured media (S3 + CloudFront). Repo-wide.
    evidence: EvidenceBlockSchema.optional(),
    // Optional repo-wide conventions injected into agent prompts. `commits` is short free text OR a
    // file pointer (absolute, or relative to the repo's config folder) whose contents are used — it
    // surfaces as @@COMMIT_CONVENTIONS@@ in the work/pr prompts; unset ⇒ the token renders empty and
    // leaves those prompts unchanged. (v1: the config key IS the convention — no commitlint auto-detect.)
    conventions: z.object({ commits: z.string().trim().min(1).optional() }).strict().optional(),
    // Optional repo-wide branch-naming taxonomy (prefix map + slug caps) feeding {{semantic_work_prefix}}
    // and the slug vars. Overridable per belt (belt.branch); resolved belt over repo over the historical
    // defaults. Absent ⇒ today's fix|chore|feature naming + 20/50 caps, unchanged.
    branch: BranchBlockSchema.optional(),
    // Optional repo-wide agent harness for factory-SPAWNED panes: `command` (the binary) + `flags`.
    // Overridable per belt and per step (belt.agent / step.agent); resolved step over belt over repo
    // over DEFAULT_AGENT_CONFIG. Absent everywhere ⇒ today's `claude --dangerously-skip-permissions`,
    // so a spawned pane's argv is byte-identical to before. (Panes YOUR layout provides are unaffected
    // — the step drives whatever that pane already runs.)
    agent: AgentBlockSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    // Work source names unique on the RESOLVED name (name ?? type), so two unnamed jira sources
    // correctly collide on "jira" rather than both passing as undefined. Keep the name→type map so
    // the belt loop below can look up each source's descriptor (label-driven or not).
    const sourceNames = new Set<string>();
    const sourceTypeByName = new Map<string, SourceType>();
    cfg.work_sources.forEach((s, i) => {
      const name = s.name ?? s.type;
      if (sourceNames.has(name)) {
        ctx.addIssue({ code: "custom", message: `duplicate work source name "${name}" — give each source a unique name`, path: ["work_sources", i, "name"] });
      }
      sourceNames.add(name);
      sourceTypeByName.set(name, s.type);
    });
    // Layout ids unique — belts reference layouts by id, so a collision would make selection ambiguous.
    const layoutIds = new Set<string>();
    cfg.layouts.forEach((l, i) => {
      if (layoutIds.has(l.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate layout id "${l.id}" — layout ids must be unique`, path: ["layouts", i, "id"] });
      }
      layoutIds.add(l.id);
    });
    // Each layout's LABELED (tab, pane) targets — what a belt step's `tab`/`pane` resolves against
    // at dispatch (herdr labels come from the titles). Untitled tabs/panes are unaddressable by
    // label, so they contribute nothing here.
    const layoutPaneTargets = new Map<string, Set<string>>(); // layout id → "tab\0pane"
    // …and which of those panes actually bring an AGENT up: an `agent:` kind (herdr starts the
    // configured harness) or a `command` (the pane runs one itself, the pre-`agent:` idiom). A step
    // targeting a pane in neither set would wait for an agent that never appears.
    const layoutAgentPanes = new Map<string, Set<string>>();
    // …and which carry their own opening `prompt:`, which collides with a step's dispatch.
    const layoutPromptPanes = new Map<string, Set<string>>();
    for (const l of cfg.layouts) {
      const targets = new Set<string>();
      const agentPanes = new Set<string>();
      const promptPanes = new Set<string>();
      for (const t of l.tabs) {
        if (!t.title) continue;
        for (const p of t.panes) {
          if (!p.title) continue;
          const key = `${t.title}\0${p.title}`;
          targets.add(key);
          if (p.agent || p.command) agentPanes.add(key);
          if (p.prompt) promptPanes.add(key);
        }
      }
      layoutPaneTargets.set(l.id, targets);
      layoutAgentPanes.set(l.id, agentPanes);
      layoutPromptPanes.set(l.id, promptPanes);
    }
    // Belt names unique; each belt.source references a configured work source; custom step names
    // unique within their belt; the per-belt pickup `label` matches its source's label semantics
    // and is unique per (source, label).
    const beltNames = new Set<string>();
    const sourceLabelPairs = new Map<string, string>(); // "source\0label" -> first belt using it
    cfg.belt.forEach((b, i) => {
      if (beltNames.has(b.name)) {
        ctx.addIssue({ code: "custom", message: `duplicate belt name "${b.name}" — give each belt a unique name`, path: ["belt", i, "name"] });
      }
      beltNames.add(b.name);
      if (!sourceNames.has(b.source)) {
        ctx.addIssue({ code: "custom", message: `belt "${b.name}" references unknown work source "${b.source}" (configured: ${[...sourceNames].join(", ") || "none"})`, path: ["belt", i, "source"] });
      }
      // Per-belt pickup label: required exactly when the belt's source picks up by label. The
      // descriptor.pickupLabel manifest is the single source of truth for which types those are.
      const sourceType = sourceTypeByName.get(b.source);
      const pickup = sourceType ? descriptorFor(sourceType).pickupLabel : undefined;
      if (sourceType) {
        if (pickup && b.label == null) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}": source "${b.source}" (${sourceType}) picks up work by a ${pickup.noun} — set the belt's \`label\` (there is no default)`, path: ["belt", i, "label"] });
        } else if (!pickup && b.label != null) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}": source "${b.source}" (${sourceType}) has no label concept — remove \`label\``, path: ["belt", i, "label"] });
        }
      }
      // A belt is fed the items its source lists for (source, label); two belts on the SAME pair
      // would contend for the very same items (first-match-wins arbitrarily starves the other) —
      // split one source across belts with DISTINCT labels instead.
      if (b.label != null) {
        const key = `${b.source}\0${b.label}`;
        const first = sourceLabelPairs.get(key);
        if (first) {
          ctx.addIssue({ code: "custom", message: `belts "${first}" and "${b.name}" both pick up "${b.source}" work by label "${b.label}" — they'd contend for the same items; give each belt a distinct label`, path: ["belt", i, "label"] });
        } else {
          sourceLabelPairs.set(key, b.name);
        }
      }
      // Layout references resolve to a defined layout id (default_layout + every layout_matching rule).
      if (b.default_layout != null && !layoutIds.has(b.default_layout)) {
        ctx.addIssue({ code: "custom", message: `belt "${b.name}" default_layout "${b.default_layout}" is not a defined layout (defined: ${[...layoutIds].join(", ") || "none"})`, path: ["belt", i, "default_layout"] });
      }
      b.layout_matching.forEach((r, j) => {
        if (!layoutIds.has(r.layout)) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}" layout_matching[${j}] references unknown layout "${r.layout}" (defined: ${[...layoutIds].join(", ") || "none"})`, path: ["belt", i, "layout_matching", j, "layout"] });
        }
      });
      // Steps are ALLOCATED TO LAYOUT PANES AT LOAD: a step's tab/pane target must exist — as a
      // labeled tab title + pane title — in the belt's `default_layout`, the layout every
      // factory-claimed worktree gets (unless a matching rule intercepts). A target missing from
      // the built layout is otherwise only discovered at runtime, as a layout-wait park after
      // (1 + autoRespawnLimit) full wait windows — a misconfiguration should fail HERE, at
      // save/reload, with the layout's actual panes in the message. Deliberately scoped:
      //  - a belt with NO default_layout is skipped — its panes are provided outside the factory
      //    (hand-built workspaces), which load-time validation can't prove either way;
      //  - `layout_matching` targets are exempt — those rules commonly serve HAND-created
      //    worktrees (branch patterns a factory claim never produces), whose layouts legitimately
      //    omit the belt's step panes.
      const defaultLayoutTargets = b.default_layout != null ? layoutPaneTargets.get(b.default_layout) : undefined;
      if (defaultLayoutTargets) {
        b.steps.forEach((s, j) => {
          if (s.tab == null || s.pane == null) return;
          if (defaultLayoutTargets.has(`${s.tab}\0${s.pane}`)) return;
          const available = [...defaultLayoutTargets].map((k) => k.replace("\0", "/")).join(", ") || "(no labeled panes)";
          ctx.addIssue({
            code: "custom",
            message: `belt "${b.name}" step "${s.name ?? s.type}" targets pane ${s.tab}/${s.pane}, but layout "${b.default_layout}" does not define it — its labeled panes are: ${available}. Fix the step's tab/pane, or add a pane titled "${s.pane}" to a tab titled "${s.tab}" in the layout.`,
            path: ["belt", i, "steps", j, "pane"],
          });
        });
        // The pane exists — but does anything start an agent IN it? A step only ever prompts an agent
        // it finds already running in its target pane; a pane that starts none makes the step wait out
        // its whole layout-wait budget and park. Same reasoning as the target check above: catch it at
        // save/reload, not as a runtime park.
        const agentPanes = b.default_layout != null ? layoutAgentPanes.get(b.default_layout) : undefined;
        const promptPanes = b.default_layout != null ? layoutPromptPanes.get(b.default_layout) : undefined;
        if (agentPanes) {
          b.steps.forEach((s, j) => {
            if (s.tab == null || s.pane == null) return;
            const key = `${s.tab}\0${s.pane}`;
            if (!defaultLayoutTargets.has(key)) return; // already reported above
            if (!agentPanes.has(key)) {
              ctx.addIssue({
                code: "custom",
                message: `belt "${b.name}" step "${s.name ?? s.type}" targets pane ${s.tab}/${s.pane} in layout "${b.default_layout}", but that pane starts no agent — set an \`agent:\` kind on it (herdr starts that agent as part of the build) or give it a \`command\` that launches one.`,
                path: ["belt", i, "steps", j, "pane"],
              });
            }
            // A layout `prompt:` is submitted as soon as the agent is ready; the step's own prompt is
            // dispatched by the reconciler. Both would land in the same agent, racing each other.
            if (promptPanes?.has(key)) {
              ctx.addIssue({
                code: "custom",
                message: `layout "${b.default_layout}" pane ${s.tab}/${s.pane} sets a \`prompt\`, but belt "${b.name}" step "${s.name ?? s.type}" targets that pane — remove the pane's \`prompt\` (the step's own prompt is dispatched there).`,
                path: ["belt", i, "steps", j, "pane"],
              });
            }
          });
        }
      }
      // Step validation for EVERY belt (previously custom-only). Each step references a registered
      // primitive; resolve its descriptor and run the structural checks the reconciler relies on.
      const kept = b.steps.filter((s) => {
        const d = stepDescriptorFor(s.type);
        return d ? !stepSkipped(d, s) : true;
      });
      // The FIRST step decides whether this belt's layout is ever BUILT. A claim creates the worktree
      // and dispatches the first step in the same reconcile flow; a step with no tab/pane spawns a
      // DEDICATED pane, and that is a new herdr TAB (`herdr tab create`) — one CLI round-trip from the
      // already-running engine. The layout is built by an out-of-process plugin hook that must boot
      // Node, load this config and query herdr before it can even look (~300-400ms measured), so its
      // freshness gate then sees two tabs and declines
      // (`workspace <id> is not a fresh 1-tab/1-pane workspace; skipping`). Nothing coordinates the two:
      // the engine never waits on the hook, the hook never learns why it lost, and the decline reaches
      // no event and no log — only herdr's plugin log. Every later layout-targeted step then burns its
      // whole layout-wait budget and parks asking whether herdr's layout is running, which points at
      // herdr for a belt-ordering mistake. The reverse order is fine (once the layout exists, a later
      // dedicated pane is harmless), so this is a shape to refuse at save/reload, not a race to lose.
      // `kept` — not b.steps — because a requiresLayout step with no pane is dropped above, and the
      // step that DISPATCHES first is the first surviving one.
      // Deliberately scoped to `default_layout`, like every other layout-target check: a
      // `layout_matching` rule commonly serves HAND-created worktrees, whose ordering the factory
      // doesn't control. The same hazard exists for a matching rule that intercepts a factory claim —
      // documented in skills/herdr-factory/references/layouts.md, not enforceable here.
      if (b.default_layout != null && kept.length > 0 && !(kept[0]!.tab && kept[0]!.pane)) {
        const f = kept[0]!;
        const at = Math.max(0, b.steps.indexOf(f));
        ctx.addIssue({
          code: "custom",
          message:
            `belt "${b.name}" sets default_layout "${b.default_layout}", but its first step "${f.name ?? f.type}" has no \`tab\`/\`pane\` — ` +
            `that step spawns a dedicated pane, whose new tab makes the layout hook skip the build ("not a fresh 1-tab/1-pane workspace"), ` +
            `and every later layout-targeted step then parks with \`layout_wait_timeout\`. ` +
            `Give the first step a tab/pane in "${b.default_layout}", reorder so a layout-targeted step runs first, or remove default_layout from this belt.`,
          path: ["belt", i, "steps", at, "pane"],
        });
      }
      // A belt-level `pr:` block only does anything on a belt that opens a PR. Reject it on a belt
      // with no pull_request-producing step (a `pr` step) so the policy can't silently no-op — the
      // same "keep the composition honest" stance as the dataflow checks below.
      if (b.pr && !kept.some((s) => stepDescriptorFor(s.type)?.produces.includes("pull_request"))) {
        ctx.addIssue({ code: "custom", message: `belt "${b.name}" sets a \`pr:\` behavior block but has no step that opens a pull request — add a \`pr\` step or remove the block`, path: ["belt", i, "pr"] });
      }
      const stepNames = new Set<string>();
      const paneTargets = new Map<string, string>(); // "tab\0pane" → first claiming step name
      b.steps.forEach((s, j) => {
        const d = stepDescriptorFor(s.type);
        if (!d) return; // the schema enum already rejected an unknown type
        const name = s.name ?? s.type;
        if (stepNames.has(name)) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}" has duplicate step name "${name}" (name defaults to type — give one an explicit unique name)`, path: ["belt", i, "steps", j, "name"] });
        }
        stepNames.add(name);
        // Two steps of one belt must not target the same layout pane: they would share ONE agent, so
        // the second step's prompt would land in a conversation still carrying the first step's
        // context — and the dispatcher would defer it for as long as that agent stays `working`,
        // burning the layout-wait budget and parking the run. One agent pane per step.
        if (s.tab && s.pane && !stepSkipped(d, s)) {
          const paneKey = `${s.tab}\0${s.pane}`;
          const owner = paneTargets.get(paneKey);
          if (owner) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" steps "${owner}" and "${name}" target the same layout pane (tab "${s.tab}", pane "${s.pane}") — each step needs its own agent pane`, path: ["belt", i, "steps", j, "pane"] });
          } else {
            paneTargets.set(paneKey, name);
          }
        }
        if (d.promptFileRequired && !s.prompt_file) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}" step "${name}" (type ${s.type}) needs a prompt_file — it has no built-in prompt`, path: ["belt", i, "steps", j, "prompt_file"] });
        }
        // Capability opt-ins (consumes/produces/read_only/bounce) are legal ONLY on a step whose
        // descriptor allows them (custom). A descriptor-declared step's capabilities are fixed —
        // reject the field rather than silently applying the descriptor's own value.
        if (!refExtends(d)) {
          for (const field of ["consumes", "produces", "read_only", "bounce"] as const) {
            if (s[field] != null) {
              ctx.addIssue({ code: "custom", message: `belt "${b.name}" step "${name}" (type ${s.type}) cannot declare \`${field}\` — capability opt-ins are only for \`custom\` steps (a ${s.type} step's capabilities are fixed by its primitive)`, path: ["belt", i, "steps", j, field] });
            }
          }
        }
        // `prompt_mode: replace` only makes sense for an engine-prompted step WITH a prompt_file to
        // replace its shipped base — reject the two degenerate cases with a clear message.
        if (s.prompt_mode === "replace") {
          if (!s.prompt_file) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" step "${name}" sets prompt_mode: replace but has no prompt_file — there is nothing to replace the built-in prompt with`, path: ["belt", i, "steps", j, "prompt_file"] });
          } else if (!d.basePrompt) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" step "${name}" (type ${s.type}) has no built-in prompt to replace — its prompt_file is already the whole body; drop prompt_mode`, path: ["belt", i, "steps", j, "prompt_mode"] });
          }
        }
        // A read-only step must never produce commits — the two are contradictory (a gate that
        // commits isn't a gate). Fires for a custom `read_only` + `produces: [commits]`/`heartbeat`,
        // and for a stray `heartbeat` on the read-only descriptors (evidence/review).
        if ((stepPosture(d, s).readOnly ?? false) && stepProduces(d, s).includes("commits")) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}" step "${name}" (type ${s.type}) is read-only and cannot produce commits — drop \`read_only\`, or remove \`produces: [commits]\`/\`heartbeat\``, path: ["belt", i, "steps", j, "read_only"] });
        }
      });
      // Dataflow over the KEPT steps in order: a REQUIRED consume must be produced by the source or
      // an earlier step; a bounce emitter needs an earlier bounce_feedback consumer.
      const available = new Set<ProductType>(sourceType ? SOURCE_PRODUCTS[sourceType] : []);
      kept.forEach((s, ki) => {
        const d = stepDescriptorFor(s.type)!;
        const name = s.name ?? s.type;
        const beltIdx = b.steps.indexOf(s);
        for (const c of stepConsumes(d, s)) {
          if (c.required && !available.has(c.type)) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" step "${name}" requires "${c.type}" but neither the source nor an earlier step produces it`, path: ["belt", i, "steps", beltIdx] });
          }
        }
        if (stepBounces(d, s) && resolveBounceTargets(kept, ki).length === 0) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}" step "${name}" declares a bounce but no earlier step consumes bounce_feedback`, path: ["belt", i, "steps", beltIdx] });
        }
        for (const p of stepProduces(d, s)) available.add(p);
      });

      // Belt effects (configurable task progression). Validate each against the belt's steps + its
      // source. A custom (non-canonical) `to` needs an anchor and a source that declares it; an
      // internal-ledger source rejects custom statuses entirely (canonical-only in v1).
      if (b.effects.length) {
        const producedByStep = new Set<ProductType>();
        for (const s of kept) for (const p of stepProduces(stepDescriptorFor(s.type)!, s)) producedByStep.add(p);
        const desc = sourceType ? descriptorFor(sourceType) : undefined;
        // Resolve the source's declared custom-status keys once (only when needed).
        const parsedSource = cfg.work_sources.find((s) => (s.name ?? s.type) === b.source);
        const declaredCustom = new Set<string>(desc && parsedSource ? desc.customStatusKeys(desc.resolveConfig(parsedSource as Record<string, unknown>)) : []);
        const seenTriggers = new Set<string>();
        b.effects.forEach((e, k) => {
          const at = (field?: string) => (field ? ["belt", i, "effects", k, field] : ["belt", i, "effects", k]);
          // 1) The trigger's target must exist in the belt.
          if (e.on === "enter" && !stepNames.has(e.step)) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" effect on entering step "${e.step}" — no such step in the belt (steps: ${[...stepNames].join(", ")})`, path: at("step") });
          }
          if (e.on === "produce" && !producedByStep.has(e.product as ProductType)) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" effect on producing "${e.product}" — no step in the belt produces it`, path: at("product") });
          }
          // 2) One target per trigger (a trigger fires exactly one transition).
          const triggerKey = e.on === "enter" ? `enter\0${e.step}` : e.on === "produce" ? `produce\0${e.product}` : `teardown\0${e.outcome}`;
          if (seenTriggers.has(triggerKey)) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" has two effects on the same trigger (${triggerKey.replace("\0", " ")}) — a trigger maps to exactly one status`, path: at() });
          }
          seenTriggers.add(triggerKey);
          // 3) Resolve `to`/`anchor`. Canonical works everywhere; a custom key needs an anchor + a
          //    source that maps it.
          const target = resolveEffectTarget(e.to, e.anchor);
          if (!target) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" effect target "${e.to}" is not a canonical state (${WORK_STATES.join(", ")}); as a custom source status it needs an \`anchor\` (a canonical WorkState fixing its lifecycle rank)`, path: at("to") });
            return;
          }
          if (target.status && desc) {
            if (!desc.supportsCustomStatuses) {
              ctx.addIssue({ code: "custom", message: `belt "${b.name}" effect targets custom status "${target.status}" but source "${b.source}" (${sourceType}) is internal-ledger — it supports canonical states only (a custom state needs a work_items CHECK migration, out of scope for v1). Target a canonical state (${WORK_STATES.join(", ")}).`, path: at("to") });
            } else if (!declaredCustom.has(target.status)) {
              ctx.addIssue({ code: "custom", message: `belt "${b.name}" effect targets custom status "${target.status}" but source "${b.source}" declares no such status (declared: ${[...declaredCustom].join(", ") || "none"}) — add it under the source's ${sourceType === "jira" ? "`status`" : "`state_labels`"} map, or target a canonical state`, path: at("to") });
            }
          }
        });
      }
    });
  });

function resolveClaimGuard(g: { enabled: boolean; host?: string; settle_ms: number } | undefined): WorkSourceConfig["claimGuard"] {
  if (!g?.enabled) return undefined;
  // A hostname can carry characters the marker can't (rare); fold them to '-'.
  return { host: g.host ?? hostname().replace(/[^A-Za-z0-9._-]/g, "-"), settleMs: g.settle_ms };
}

export type BeltType = "work_to_pull_request" | "custom";

/** One configured work source: identity + its resolved type-specific block. `cfg` is opaque to
 *  everything except the type's own descriptor (whose create() gets it back, typed). */
export interface WorkSourceConfig {
  name: string;
  type: SourceType;
  /** How often this source is polled for new work (Phase B `listEligible`), in seconds. Resolved =
   *  the source's own `poll_interval_seconds` ?? `limits.source_poll_interval_seconds` ?? tick. */
  pollIntervalSeconds: number;
  /** Per-source concurrency cap: the most WORKED workspaces this source may hold in flight at once,
   *  summed across every belt that pulls from it. Phase B stops claiming from the source once it hits
   *  this; the repo-wide `limits.maxActiveWorkspaces` still caps the total. Defaults to 2. */
  maxActiveWorkspaces: number;
  /** The cross-host claim ledger (INV-10); undefined ⇒ disabled. Only jira/github_issues accept it. */
  claimGuard?: { host: string; settleMs: number };
  cfg: unknown;
}

/** One resolved belt step: a registered primitive (`type`) resolved against a belt step ref. The
 *  body is assembled at RENDER time (step.ts): the `enginePrompt` base (from the descriptor's
 *  basePrompt slug; undefined for a `custom` step) PLUS, if `promptFile` is set, the user prompt —
 *  augmenting the base (`promptMode` "augment"), REPLACING it ("replace"), or being the whole body
 *  when there is no base (custom). The legacy flags
 *  (`heartbeat`/`opensPr`/`gathersEvidence`/`canBounceTo`/`readOnly`) are DERIVED from the
 *  declaration below so the reconciler keeps driving off them; the declaration fields
 *  (`consumes`/`produces`/`guards`/`effects`/`posture`) drive the new machinery. */
export interface StepConfig {
  name: string;
  type: string; // the registered step primitive this step is (descriptor name)
  tab?: string;
  pane?: string;
  enginePrompt?: string; // engine base resolved at LOAD (config-folder pack ?? shipped); undefined for custom
  basePromptSlug?: string; // the base's slug — lets render layer a repo-checkout pack on top; undefined for custom
  basePromptPerSourceOverride?: boolean; // whether a per-sourceType pack variant is honored for this base
  promptFile?: string; // user prompt path as written in config (optional augment, or whole body for custom)
  promptFileSource?: "config" | "repo"; // present iff promptFile is
  promptMode?: "augment" | "replace"; // how promptFile relates to enginePrompt: augment (append, default) | replace (own the body). Inert without a promptFile / for a custom step.
  budgetSeconds: number;
  heartbeat: boolean; // commit-HEAD stall heartbeat applies to this step (derived: has a heartbeat guard)
  opensPr: boolean; // derived: produces includes pull_request
  gathersEvidence: boolean; // derived: produces includes evidence
  canBounceTo: string[]; // derived: earlier bounce_feedback consumer(s) this step may bounce to
  readOnly: boolean; // derived: posture.readOnly (never edits/commits — enforced)
  requiresLayout: boolean; // derived: posture.requiresLayout (materialize only with a layout pane)
  consumes: InputSpec[]; // declared typed inputs
  produces: ProductType[]; // declared typed products (always includes handoff)
  guards: GuardSpec[]; // resolved watchdogs that actually attach to this step
  effects: EffectSpec[]; // declared source-lifecycle transitions
  posture: StepPosture; // read_only / requiresLayout flags
  /** The agent harness a SPAWNED pane for this step launches (command + flags), resolved step over
   *  belt over repo over DEFAULT_AGENT_CONFIG. loadConfig always sets it; optional so terse test
   *  literals fall back to DEFAULT_AGENT_CONFIG at the spawn site (step.ts). */
  agent?: AgentConfig;
}

/** A pane's normalized extent along its split axis: a percentage of the parent, or a fixed cell
 *  count. Config accepts "30%" / 0.3 / 40; normalizeSize collapses those to this. */
export type LayoutSize = { percent: number } | { cells: number };

/** A resolved agent pane: which herdr agent to start there, and how. */
export interface LayoutAgent {
  /** The herdr agent kind (`claude`, `opencode`, …) — `agent start --kind`. */
  kind: string;
  /** herdr agent alias; derived from the kind + workspace when unset (see deriveAgentName). */
  name?: string;
  /** Args passed through to the agent's own command line. */
  args: string[];
  /** An opening prompt submitted once herdr reports the agent ready. */
  prompt?: string;
  startTimeoutMs?: number;
  /** Set ⇒ wait for the agent to settle after prompting; unset ⇒ submit and move on. */
  promptTimeoutMs?: number;
}

/** One resolved layout pane. `split` is normalized to right|down; `size` to LayoutSize. */
export interface LayoutPane {
  title?: string;
  command?: string;
  /** Keep the pane at a shell prompt after `command` exits (default true). */
  persist: boolean;
  /** Set ⇒ this pane hosts an agent, started as part of the build. */
  agent?: LayoutAgent;
  /** Environment for this pane's process (layout env merged first, so these win). */
  env: Record<string, string>;
  setup: boolean;
  split?: "right" | "down";
  ratio?: number;
  size?: LayoutSize;
}
export interface LayoutTab {
  title?: string;
  panes: LayoutPane[];
}
export interface LayoutSetup {
  command: string;
  blocking: boolean;
}
/** A named herdr tab/pane arrangement the factory builds into a worktree on claim (absorbed from the
 *  workspace-manager plugin). Referenced by a belt's defaultLayout / layoutMatching. */
export interface LayoutConfig {
  id: string;
  setup?: LayoutSetup;
  tabs: LayoutTab[];
}
/** A belt's branch→layout rule: the first rule whose glob matches the branch wins (resolveBeltLayout). */
export interface LayoutMatchRule {
  worktreePattern: string;
  layout: string;
}

/** One resolved belt: a (source + ordered steps) pairing with its lifecycle. `watchPr` true means
 *  the engine runs the token-free PR-watch (reviewing phase) after the last step. `matchFile` is
 *  the resolved path to the belt's `.ts` predicate (the predicate fn itself is loaded in buildDeps,
 *  which is async); undefined ⇒ the belt accepts anything from its source. */
export interface BeltConfig {
  name: string;
  beltType: BeltType;
  source: string; // work_source name
  priority: number;
  /** Whether the belt takes on new work. false ⇒ Phase B skips it (no polling, no claims); its
   *  in-flight runs still reconcile normally. Defaults to true at parse. */
  active: boolean;
  workspaceName?: string;
  /** The resolved branch-naming taxonomy (prefix map + slug caps) feeding {{semantic_work_prefix}}
   *  and the slug vars — belt over repo over the historical defaults (resolveBranchTaxonomy).
   *  loadConfig always sets it; optional so terse test literals fall back to DEFAULT_BRANCH_TAXONOMY
   *  via branchName's default param. */
  branch?: BranchTaxonomy;
  matchFile?: string;
  /** The label this belt picks up work by, threaded into its source's listEligible/transition/
   *  health. Set for belts on a label-driven source (jira, github_issues); undefined for one whose
   *  source has no label concept (local_markdown). Enforced at parse time (see superRefine). */
  label?: string;
  steps: StepConfig[];
  watchPr: boolean;
  /** Per-belt override of the repo-wide bounce safety cap; undefined ⇒ use limits.maxBounces. */
  maxBounces?: number;
  /** Layout selection (absorbed from workspace-manager). `defaultLayout` is the layout built into a
   *  fresh worktree for this belt when no `layoutMatching` rule matches the branch; both reference an
   *  id in Config.layouts. undefined defaultLayout + empty/undefined layoutMatching ⇒ nothing built.
   *  (loadConfig always sets layoutMatching, defaulting to []; optional for terse test literals.) */
  defaultLayout?: string;
  layoutMatching?: LayoutMatchRule[];
  /** Belt-level PR behavior policy, rendered into the `pr` step's prompt (draft / title template /
   *  labels / reviewers / assignees / automated-round window). undefined ⇒ today's behavior; only set
   *  on a belt with a `pr` step (enforced at parse). `title` is a `{{work_id}}`/… template. */
  pr?: {
    draft?: boolean;
    title?: string;
    labels?: string[];
    reviewers?: string[];
    assignees?: string[];
    /** CI/bot polling window the pr agent runs after opening the PR, in minutes; 0 = skip it. */
    automatedRoundMinutes?: number;
  };
  /** Configurable task progression: source transitions this belt fires at trigger points (entering a
   *  step, producing a product, tearing down), beyond the engine defaults. Empty ⇒ defaults only.
   *  Each carries a canonical anchor `to` + optional source-native `status` (see BeltEffect).
   *  (loadConfig always sets it, defaulting to []; optional for terse test literals — like layoutMatching.) */
  effects?: BeltEffect[];
}

export interface Config {
  repoName: string;
  repo: { path: string; baseRef: string; github?: string };
  limits: {
    maxActiveWorkspaces: number;
    attentionRenotifySeconds: number;
    stallSeconds: number;
    maxBounces: number;
    maxCaptureAttempts: number;
    stepBudgetSeconds: number;
    tickIntervalSeconds: number;
    reconcileConcurrency: number;
    maxClaimsPerTick: number;
    layoutWaitSeconds: number;
  };
  sources: WorkSourceConfig[];
  belts: BeltConfig[]; // sorted by priority asc (ties: config order)
  /** Named tab/pane arrangements belts build into worktrees (resolved from the `layouts:` block). */
  layouts: LayoutConfig[];
  /** Where the evidence step publishes captured media, discriminated by `publisher` (default `s3`).
   *  Undefined ⇒ no upload (the step still captures + can bounce). The delivery logic lives behind the
   *  publisher interface in `clients/evidence.ts`; every variant shares `keyPrefix` + `githubUsername`
   *  so the key layout — and the "prefix + filename" URL shape — is backend-independent. */
  evidence?:
    | { publisher: "s3"; bucket: string; region: string; cloudfrontDomain: string; keyPrefix: string; githubUsername?: string; profile?: string }
    | { publisher: "local"; publicBaseUrl?: string; keyPrefix: string; githubUsername?: string }
    | { publisher: "command"; command: string[]; timeoutSeconds: number; keyPrefix: string; githubUsername?: string };
  guidance?: string;
  /** Repo-wide conventions injected into agent prompts. `commits` is free text or a file pointer
   *  (resolved at render time in step.ts); surfaced as @@COMMIT_CONVENTIONS@@. */
  conventions?: { commits?: string };
  /** The repo-level agent harness (command + flags a SPAWNED pane launches), resolved repo over
   *  DEFAULT_AGENT_CONFIG. Per-belt/per-step overrides live on each StepConfig.agent; this is the
   *  fallback the PR-watch resolver uses when it can't resolve a belt's pr step (watch.ts). Always
   *  set by loadConfig (DEFAULT_AGENT_CONFIG when no `agent:` block). */
  agent: AgentConfig;
  paths: {
    configDir: string;
    repoDir: string;
    stateRoot: string;
    stateDir: string;
    dbPath: string;
    logsDir: string;
  };
}

export interface Loaded {
  config: Config;
  /** The per-repo env file as a raw key/value map. Which keys matter is declared by each source
   *  descriptor's secrets manifest — the engine never interprets them. */
  env: Record<string, string>;
}

// expandHome lives in the import-free leaf src/paths.ts (descriptors need it, and anything a
// descriptor imports must never lead back into this module — see paths.ts's header on the cycle).
export { expandHome };

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** herdr can't create worktrees from a linked worktree — require the MAIN checkout. */
export function assertMainCheckout(repoPath: string): void {
  const gitPath = join(repoPath, ".git");
  if (!existsSync(gitPath)) {
    throw new Error(`repo.path "${repoPath}" is not a git checkout (no .git)`);
  }
  if (!statSync(gitPath).isDirectory()) {
    throw new Error(
      `repo.path "${repoPath}" looks like a linked worktree (.git is a file); herdr needs the MAIN checkout`,
    );
  }
}

/** Path to the one global DB (repo-agnostic commands like capture-lock need it). */
export function globalDbPath(): string {
  return join(stateRoot(), "herdr-factory.db");
}

/** Machine-global file recording an absolute path to a verified Node >=24 binary. The CLI
 *  self-bakes `process.execPath` here on every run (it only ever runs under >=24); the
 *  `bin/herdr-factory` launcher falls back to it when the caller's active node is older — so the
 *  CLI always runs on its own Node 24 regardless of the caller's cwd, with no version-manager
 *  dependency at runtime. */
export function nodePathFile(): string {
  return join(stateRoot(), "node-path");
}

// ── Vendored Node runtime (managed installs only — a plain dev checkout uses the ambient node). ──
// A `curl | install.sh` install downloads the pinned official Node (see .node-version) into
// `<state>/runtime/<version>/` and points a STABLE `current` symlink at it. Everything that spawns
// node (the launchers, the launchd/systemd service, the supervisor's spawnServe) invokes node
// through that symlink, so re-provisioning a bumped Node is one atomic symlink flip — no service
// rewrite. `provisionNode()` (src/watchers/provision.ts) creates/flips it; the self-updater calls
// it whenever `.node-version` changes.

/** Root of the vendored Node runtimes: `<state>/runtime`. */
export function runtimeRoot(): string {
  return join(stateRoot(), "runtime");
}
/** A specific vendored Node version dir: `<state>/runtime/<version>`. */
export function runtimeVersionDir(version: string): string {
  return join(runtimeRoot(), version);
}
/** Stable symlink pointing at the active vendored Node version dir: `<state>/runtime/current`. */
export function runtimeCurrentLink(): string {
  return join(runtimeRoot(), "current");
}
/** Stable path to the vendored `node` binary, through the `current` symlink. This is what the
 *  node-path file / service point at, so a Node bump only moves the symlink. */
export function managedNodePath(): string {
  return join(runtimeCurrentLink(), "bin", "node");
}
/** Is the given node binary the vendored one (i.e. living under `<state>/runtime`)? Used to decide
 *  whether to bake the stable symlink path vs the concrete execPath. */
export function isManagedNode(execPath: string): boolean {
  const root = runtimeRoot();
  return execPath === root || execPath.startsWith(root + sep);
}
/** The node binary to (re)spawn/schedule with: the baked node-path if it resolves to a real binary
 *  (the vendored `runtime/current/bin/node` in a managed install — so a Node bump that flips the
 *  symlink propagates without rewriting anything), else the caller's own execPath (dev checkout).
 *  Falls back to execPath if the baked path is missing/stale so we never spawn a vanished node. */
export function resolvedNodePath(fallback: string): string {
  try {
    const baked = readFileSync(nodePathFile(), "utf8").trim();
    if (baked && existsSync(baked)) return baked;
  } catch {
    /* no baked path yet */
  }
  return fallback;
}

/** TCP port the server binds on 127.0.0.1 (override with HERDR_FACTORY_PORT). The bind itself
 *  is the single-instance guard — a second `serve` fails with EADDRINUSE and exits. */
export function serverPort(): number {
  const p = Number(process.env.HERDR_FACTORY_PORT);
  return Number.isInteger(p) && p > 0 ? p : 8765;
}

/** Server-wide (not per-repo) log dir — the supervisor's launchd stdout/err land here. */
export function serverLogsDir(): string {
  return join(stateRoot(), "logs");
}

/** Load a repo's env file (auth secrets etc.) as a raw map. Strictly PER-REPO — read only from
 *  `<configDir>/repos/<name>/env`. There is no shared/global secrets file. Same file + keys as the
 *  old Jira-shaped loader (JIRA_EMAIL/JIRA_API_TOKEN keep working verbatim); which keys a source
 *  needs is declared on its descriptor's secrets manifest. */
export function loadEnvMap(repoDir: string): Record<string, string> {
  return parseEnvFile(join(repoDir, "env"));
}

/** Merge key/values into `<repoDir>/env` (chmod 600). Only the keys provided are updated (a
 *  `undefined` value leaves the existing entry alone); others in the file are preserved.
 *  Counterpart to loadEnvMap, used by the TUI config editor so credentials don't have to be
 *  hand-created. */
export function saveEnvValues(repoDir: string, values: Record<string, string | undefined>): void {
  mkdirSync(repoDir, { recursive: true });
  const path = join(repoDir, "env");
  const env = parseEnvFile(path);
  for (const [k, v] of Object.entries(values)) if (v !== undefined) env[k] = v;
  const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // ensure 600 even if the file already existed
}

/** The config.yml JSON Schema — derived from `RepoConfigSchema` (single source of truth) so editors
 *  (e.g. the YAML language server) give autocomplete + inline validation. Generated from the INPUT
 *  side (what the user writes); `.strict()` becomes `additionalProperties: false`, so unknown keys
 *  (the classic `agents`-on-a-`custom`-belt mixup, or a typo) are flagged live. Cross-field rules
 *  JSON Schema can't express — belt.source references, unique names, layout both-or-neither,
 *  workspace_name must contain {{work_id}}, match/prompt_file existence — are still enforced by
 *  loadConfig (with readable errors). */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(RepoConfigSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    ...schema,
    title: "herdr-factory repo config (config.yml)",
    description:
      "Structural schema for a per-repo config.yml. Cross-field rules (belt.source refs, unique names, layout both-or-neither, workspace_name {{work_id}}, file existence) are validated at load time, not here.",
  };
}

/** Where the editor-facing JSON Schema is written. Each config.yml points at it relative to itself
 *  with a first-line modeline: `# yaml-language-server: $schema=../../config.schema.json`
 *  (repos/<name>/config.yml is two levels below this configDir file). */
export function configSchemaPath(): string {
  return join(configDir(), "config.schema.json");
}

/** Generate + write the config JSON Schema to configSchemaPath(); returns the path. */
export function writeConfigSchema(): string {
  const path = configSchemaPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  return path;
}

/** Normalize a parsed pane `size` (a "30%" string, or a number) into a LayoutSize, or throw a
 *  readable error. Mirrors the workspace-manager plugin: a "%" string or a fraction 0<n<1 is a
 *  percentage; an integer ≥1 is a fixed cell count. The Zod schema already guarantees the string
 *  shape and number>0, so this only enforces the range/whole-number rules. */
function normalizeSize(raw: string | number, where: string): LayoutSize {
  if (typeof raw === "string") {
    const pct = Number(raw.replace(/%$/, "").trim());
    if (!(pct > 0 && pct < 100)) throw new Error(`${where}: size "${raw}" must be a percentage between 0% and 100%`);
    return { percent: pct };
  }
  if (raw < 1) return { percent: raw * 100 };
  if (!Number.isInteger(raw)) throw new Error(`${where}: a fixed pane size (${raw}) must be a whole number of cells`);
  return { cells: raw };
}

/** vertical/right → a new pane to the right; horizontal/down → below (herdr's split directions). */
function normalizeSplit(raw: "vertical" | "horizontal" | "right" | "down"): "right" | "down" {
  return raw === "horizontal" || raw === "down" ? "down" : "right";
}

export function loadConfig(repoName: string): Loaded {
  const cfgDir = configDir();
  const repoDir = join(cfgDir, "repos", repoName);
  const ymlPath = join(repoDir, "config.yml");
  if (!existsSync(ymlPath)) {
    throw new Error(`no config for repo "${repoName}" at ${ymlPath}`);
  }

  // safeParse + format the issues into a readable message — a raw ZodError stringifies to an
  // unreadable JSON dump (and the CLI just prints `e.message`). Path "belt.0.steps" etc.
  const result = RepoConfigSchema.safeParse(parseYaml(readFileSync(ymlPath, "utf8")));
  if (!result.success) {
    const detail = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid config for repo "${repoName}" (${ymlPath}):\n${detail}`);
  }
  const parsed = result.data;
  const repoPath = expandHome(parsed.repo.path);
  assertMainCheckout(repoPath);

  const guidancePath = join(repoDir, "guidelines-prompt.md");
  const guidance = existsSync(guidancePath) ? readFileSync(guidancePath, "utf8") : undefined;

  // The per-source poll interval falls back to the repo-wide limit, which itself falls back to the
  // tick interval — so an unset field everywhere keeps today's "poll every tick" behavior.
  const defaultPollInterval = parsed.limits.source_poll_interval_seconds ?? parsed.limits.tick_interval_seconds;
  const sources: WorkSourceConfig[] = parsed.work_sources.map((s) => ({
    name: s.name ?? s.type,
    type: s.type,
    pollIntervalSeconds: (s.poll_interval_seconds as number | undefined) ?? defaultPollInterval,
    maxActiveWorkspaces: (s.max_active_workspaces as number | undefined) ?? 2,
    claimGuard: resolveClaimGuard((s as { claim_guard?: { enabled: boolean; host?: string; settle_ms: number } }).claim_guard),
    cfg: descriptorFor(s.type).resolveConfig(s),
  }));
  const sourceTypeByName = new Map(sources.map((s) => [s.name, s.type]));

  // The engine base prompt for a (sourceType, slug), resolved through the load-time reach of the
  // prompt-pack chain (src/prompt-packs.ts): the repo's config-folder pack (repos/<name>/prompts/)
  // overrides the shipped prompts/<type>/<slug>.md (else the shared prompts/<slug>.md). The
  // repo-checkout layer lives in a run's worktree and is layered on at RENDER time (step.ts), so it
  // isn't reachable here. Shipped is the always-present fallback, so this never returns undefined.
  const configPackDir = join(repoDir, CONFIG_PACK_SUBDIR);
  const basePrompt = (sourceType: SourceType, slug: string, perSourceOverride: boolean): string =>
    resolvePromptFile([configPackDir, SHIPPED_PROMPTS_DIR], sourceType, slug, perSourceOverride)!.body;
  // Resolve a belt-relative file (prompt_file / match) to an absolute path, asserting it exists.
  const resolveFile = (belt: string, what: string, p: string): string => {
    const abs = isAbsolute(p) ? p : join(repoDir, p);
    if (!existsSync(abs)) throw new Error(`belt "${belt}": ${what} not found: ${abs}`);
    return abs;
  };
  // Existence check for a `config`-sourced prompt_file (resolved against the config folder). A
  // `repo`-sourced prompt is read from the run's worktree at render time, so it can't be checked
  // here — a missing one surfaces (with a clear error) when the step is dispatched.
  const checkConfigPromptFile = (belt: string, label: string, source: "config" | "repo", promptFile: string): void => {
    if (source === "config") resolveFile(belt, label, promptFile);
  };

  // Resolve one belt step ref → StepConfig via its registered descriptor. `kept` is the belt's
  // post-skip step list (evidence-opt-in removed); `index` is this step's position within it.
  const resolveStep = (
    beltName: string,
    sourceType: SourceType,
    ref: { type: string; name?: string; tab?: string; pane?: string; prompt_file?: string; prompt_file_source?: "config" | "repo"; prompt_mode?: "augment" | "replace"; budget_seconds?: number; heartbeat: boolean; agent?: ParsedAgentBlock } & CapabilityRef,
    kept: { type: string; name?: string }[],
    index: number,
    beltAgent: ParsedAgentBlock | undefined,
  ): StepConfig => {
    const d = stepDescriptorFor(ref.type)!; // existence guaranteed by the schema step-type enum
    const name = ref.name ?? ref.type;
    if (ref.prompt_file) checkConfigPromptFile(beltName, `step "${name}" prompt_file`, ref.prompt_file_source!, ref.prompt_file);
    // Effective declarations: the descriptor's, plus any custom-step capability opt-ins (byte-
    // identical to the descriptor for a non-custom step). The reconciler drives off the RESOLVED
    // StepConfig below, so a declared gate is the same machinery as w2pr's evidence/review.
    const produces = stepProduces(d, ref);
    const posture = stepPosture(d, ref);
    // Guards that actually attach: descriptor guards whose conditions hold (layout_wait needs a
    // tab/pane; heartbeat/capture_cap need their product) + a heartbeat guard if the ref opted in.
    const guards: GuardSpec[] = [];
    for (const g of d.guards) {
      if (g.attachWhen === "layoutTarget" && !(ref.tab && ref.pane)) continue;
      if (g.requiresProduct && !produces.includes(g.requiresProduct)) continue;
      guards.push(g);
    }
    // unshift, not push: the harness is first-trip-wins in guard order, and on a double-trip the
    // stall diagnosis must win over the budget (see guards.ts) — mirrors the descriptors' order.
    if (ref.heartbeat && !guards.some((g) => g.kind === "heartbeat")) guards.unshift(HEARTBEAT_GUARD);
    // A read-only posture ALWAYS carries the read_only guard: descriptor-declared postures
    // (evidence/review) bring it via d.guards above; a custom ref's `read_only: true` opt-in adds
    // it here — so the watchdog rescue routing (STEP_WATCHDOG_ATTENTION) is fully registry-derived.
    if ((posture.readOnly ?? false) && !guards.some((g) => g.kind === "read_only")) guards.push(READ_ONLY_GUARD);
    return {
      name,
      type: ref.type,
      tab: ref.tab,
      pane: ref.pane,
      enginePrompt: d.basePrompt ? basePrompt(sourceType, d.basePrompt.slug, d.basePrompt.perSourceOverride) : undefined,
      // The base's slug + per-source flag so the render step can layer a repo-checkout pack override
      // on top of `enginePrompt` (the config/shipped resolution). Undefined for a `custom` step.
      basePromptSlug: d.basePrompt?.slug,
      basePromptPerSourceOverride: d.basePrompt?.perSourceOverride,
      promptFile: ref.prompt_file,
      // Kept present iff there's a prompt_file — the `config`/`augment` defaults are inert without one.
      promptFileSource: ref.prompt_file ? ref.prompt_file_source : undefined,
      promptMode: ref.prompt_file ? ref.prompt_mode : undefined,
      budgetSeconds: ref.budget_seconds ?? d.defaultBudgetSeconds ?? parsed.limits.step_budget_seconds,
      heartbeat: guards.some((g) => g.kind === "heartbeat"),
      opensPr: produces.includes("pull_request"),
      gathersEvidence: produces.includes("evidence"),
      canBounceTo: stepBounces(d, ref) ? resolveBounceTargets(kept, index) : [],
      readOnly: posture.readOnly ?? false,
      requiresLayout: posture.requiresLayout ?? false,
      consumes: stepConsumes(d, ref),
      produces,
      guards,
      effects: [...d.effects],
      posture,
      // The harness a SPAWNED pane for this step launches — step over belt over repo over the
      // default. Inert for a step that targets a layout pane (it drives that pane's own agent).
      agent: resolveAgent(parsed.agent, beltAgent, ref.agent),
    };
  };

  const belts: BeltConfig[] = parsed.belt.map((b) => {
    const sourceType = sourceTypeByName.get(b.source)!; // existence guaranteed by superRefine
    // Apply the evidence-opt-in skip (a requiresLayout step with no tab/pane), then resolve each.
    const kept = b.steps.filter((s) => !stepSkipped(stepDescriptorFor(s.type)!, s));
    const steps: StepConfig[] = kept.map((ref, i) => resolveStep(b.name, sourceType, ref, kept, i, b.agent));
    // Validate each `config`-sourced user prompt's tokens + @@WHEN@@ clauses against the contract for
    // its step (existence was already asserted in resolveStep). A `repo`-sourced prompt is read from
    // the worktree at render time, so it's validated there instead. productActiveFor is the same
    // gating the renderer uses, so what's rejected here is exactly what would reach the agent unrendered.
    for (const step of steps) {
      if (!step.promptFile || step.promptFileSource !== "config") continue;
      const abs = isAbsolute(step.promptFile) ? step.promptFile : join(repoDir, step.promptFile);
      const problems = validatePromptBody(readFileSync(abs, "utf8"), {
        isActive: productActiveFor(steps, step, sourceType),
        guardKinds: new Set(step.guards.map((g) => g.kind)),
      });
      if (problems.length) {
        throw new Error(
          `belt "${b.name}" step "${step.name}" prompt_file (${abs}) violates the prompt contract:\n  - ${problems.join("\n  - ")}\n(see docs/PROMPTS.md for the token reference)`,
        );
      }
    }
    // Lifecycle is DERIVED, not written: a step producing pull_request (whose product carries a
    // watch) gives the belt the terminal PR-watch. beltType is a display label only now.
    const watchPr = steps.some((s) => s.produces.includes("pull_request") && productCapabilityFor("pull_request").watch != null);
    const beltType: BeltType = watchPr ? "work_to_pull_request" : "custom";
    return {
      name: b.name,
      beltType,
      source: b.source,
      priority: b.priority,
      active: b.active,
      workspaceName: b.workspace_name,
      branch: resolveBranchTaxonomy(parsed.branch, b.branch),
      matchFile: b.match ? resolveFile(b.name, "match", b.match) : undefined,
      label: b.label,
      steps,
      watchPr,
      maxBounces: b.max_bounces,
      defaultLayout: b.default_layout,
      layoutMatching: b.layout_matching.map((r) => ({ worktreePattern: r.worktree_pattern, layout: r.layout })),
      pr: b.pr
        ? {
            draft: b.pr.draft,
            title: b.pr.title,
            labels: b.pr.labels,
            reviewers: b.pr.reviewers,
            assignees: b.pr.assignees,
            automatedRoundMinutes: b.pr.automated_round_minutes,
          }
        : undefined,
      effects: b.effects.map((e): BeltEffect => {
        const target = resolveEffectTarget(e.to, e.anchor)!; // validated in superRefine → non-null
        const trigger =
          e.on === "enter"
            ? ({ on: "enter", step: e.step } as const)
            : e.on === "produce"
              ? ({ on: "produce", product: e.product as ProductType } as const)
              : ({ on: "teardown", outcome: e.outcome } as const);
        return { trigger, to: target.to, status: target.status };
      }),
    };
  });
  // Stable sort: equal priorities keep config order (V8 Array.sort is stable on Node >=24).
  belts.sort((a, b) => a.priority - b.priority);

  // Normalize the layout library: collapse each pane's `size`/`split` to their runtime forms.
  const layouts: LayoutConfig[] = parsed.layouts.map((l) => ({
    id: l.id,
    setup: l.setup ? { command: l.setup.command, blocking: l.setup.blocking } : undefined,
    tabs: l.tabs.map((t) => ({
      title: t.title,
      panes: t.panes.map((p) => ({
        title: p.title,
        command: p.command,
        persist: p.persist ?? true,
        agent: p.agent
          ? {
              kind: p.agent,
              name: p.agent_name,
              args: p.agent_args ?? [],
              prompt: p.prompt,
              startTimeoutMs: p.agent_timeout_ms,
              promptTimeoutMs: p.prompt_timeout_ms,
            }
          : undefined,
        // Layout env first so a pane's own entries win on conflict.
        env: { ...(l.env ?? {}), ...(p.env ?? {}) },
        setup: p.setup,
        split: p.split ? normalizeSplit(p.split) : undefined,
        ratio: p.ratio,
        size: p.size != null ? normalizeSize(p.size, `layout "${l.id}"`) : undefined,
      })),
    })),
  }));

  const root = stateRoot();
  const stateDir = join(root, repoName);

  const config: Config = {
    repoName,
    repo: { path: repoPath, baseRef: parsed.repo.base_ref, github: parsed.repo.github },
    limits: {
      maxActiveWorkspaces: parsed.limits.max_active_workspaces,
      attentionRenotifySeconds: parsed.limits.attention_renotify_seconds,
      stallSeconds: parsed.limits.stall_seconds,
      maxBounces: parsed.limits.max_bounces,
      maxCaptureAttempts: parsed.limits.max_capture_attempts,
      stepBudgetSeconds: parsed.limits.step_budget_seconds,
      tickIntervalSeconds: parsed.limits.tick_interval_seconds,
      reconcileConcurrency: parsed.limits.reconcile_concurrency,
      maxClaimsPerTick: parsed.limits.max_claims_per_tick,
      layoutWaitSeconds: parsed.limits.layout_wait_seconds,
    },
    sources,
    belts,
    layouts,
    evidence: resolveEvidence(parsed.evidence),
    guidance,
    conventions: parsed.conventions,
    // Repo-level resolved harness (repo over the default). Per-belt/per-step overrides live on each
    // StepConfig.agent; this is the resolver's fallback (watch.ts) when no belt pr step resolves.
    agent: resolveAgent(parsed.agent, undefined, undefined),
    paths: {
      configDir: cfgDir,
      repoDir,
      stateRoot: root,
      stateDir,
      dbPath: join(root, "herdr-factory.db"),
      logsDir: join(stateDir, "logs"),
    },
  };

  return { config, env: loadEnvMap(repoDir) };
}
