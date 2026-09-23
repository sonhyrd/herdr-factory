// Turns a repo config.yml (as a live `yaml` Document) into a flat, ordered list of field
// descriptors that config-editor.ts renders as browsable rows. The config tab shows these across
// four numbered panels (see `ConfigSection`): the singletons (repo/limits/evidence), work_sources,
// layouts, and belts — each built by passing the matching `section` here. Array-of-object items
// (work_sources, belts, steps) are emitted as collapsible `group` rows — collapsed by default,
// labeled by their name/id — and their inner fields are only emitted when expanded. Collapse state
// is tracked by the caller in a WeakSet keyed by the item's yaml node (stable across rebuilds +
// index shifts).
//
// Structural edits (add/remove, type switch) mutate the Document surgically — setIn/addIn/deleteIn
// (+ createNode for new nodes) preserve comments on untouched nodes — then call `rebuild`.
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { Document } from "yaml";
import { SOURCE_DESCRIPTORS, descriptorFor } from "../sources/registry.ts";
import { STEP_DESCRIPTORS, stepDescriptorFor } from "../steps/registry.ts";
import { HERDR_AGENT_KINDS, type SourceType } from "../types.ts";
import { layoutTargets, renameLayoutId, renamePaneTitle, renameSummary, renameTabTitle } from "./layout-refs.ts";
import type { ChooseFn, ConfirmFn } from "./types.ts";

export type Path = (string | number)[];

/** Shell wiring the field builder needs beyond the draft: modal helpers plus the loaded repo's
 *  config folder (for the referenced-file assist) and the IO callbacks the editor owns. */
export interface FieldCtx {
  confirm: ConfirmFn;
  choose: ChooseFn;
  /** The loaded repo's config folder — lets the referenced-file assist resolve a `config`-sourced
   *  prompt_file / match and check whether it exists yet. Absent (tests, no repo) ⇒ no assist. */
  repoDir?: string | null;
  /** Write a referenced-file stub to an absolute path, then rebuild. IO is owned by the editor. */
  writeStub?: (absPath: string, content: string) => void;
  /** Open the guidelines-prompt.md multiline editor (owned by the editor — it holds the modal). */
  editGuidelines?: () => void;
}

/** Which slice of a repo config a `buildDescriptors` call emits — one per numbered config panel.
 *  `general` = the singleton blocks (repo, limits, evidence); `work_sources`, `layouts`, and `belt`
 *  = the three array sections that were split out so a dense config stays scannable. */
export type ConfigSection = "general" | "work_sources" | "layouts" | "belt";

export type FieldDesc =
  | { kind: "header"; label: string; level: 1 | 2; indent?: number }
  | { kind: "group"; label: string; node: object; expanded: boolean; indent?: number; moveUp?: () => void; moveDown?: () => void }
  // `clearable`: blanking the field DELETES its key (vs. the default, which skips empties so a
  // required field can't be accidentally lost) — the only way to unset an optional scalar in place.
  // `renameRefs`: this field holds a NAME other config rows reference (a layout id, a tab/pane
  // title). When the typed value differs from what's in the draft, the flush hands the (from, to)
  // pair here so every belt/step reference is repointed in the same edit; returns a status line, or
  // null when nothing referenced the old name. See layout-refs.ts.
  | { kind: "text"; label: string; path?: Path; env?: string; masked?: boolean; placeholder?: string; numeric?: boolean; clearable?: boolean; indent?: number; renameRefs?: (from: string, to: string) => string | null }
  | { kind: "enum"; label: string; value: string; choices: string[]; apply: (next: string) => void; indent?: number }
  | { kind: "bool"; label: string; value: boolean; apply: (next: boolean) => void; indent?: number }
  | { kind: "ref"; label: string; value: string; choices: string[]; apply: (next: string) => void; indent?: number }
  | { kind: "action"; label: string; run: () => void; indent?: number };

// ── defaults for newly-created nodes ────────────────────────────────────────────────────────────
// Source-type blocks come from the registry (descriptor.tui.defaultBlock); belts stay local.
const SOURCE_TYPE_CHOICES = SOURCE_DESCRIPTORS.map((d) => d.type);
// Belt steps reference a registered step primitive by `type` (mirrors the source-type choices above,
// registry-driven so a new/plugin primitive appears without editing this file).
const STEP_TYPE_CHOICES = STEP_DESCRIPTORS.map((d) => d.name);
// A layout pane's split direction (mirrors PaneSplitSchema in config.ts). vertical/right → a pane to
// the RIGHT of the previous one; horizontal/down → BELOW it. Ignored on a tab's first pane.
const SPLIT_CHOICES = ["vertical", "horizontal", "right", "down"];
const sourceNode = (type: SourceType, name?: unknown, pollInterval?: unknown, maxActive?: unknown) => ({
  type,
  ...(name != null ? { name } : {}),
  ...(pollInterval != null ? { poll_interval_seconds: pollInterval } : {}),
  ...(maxActive != null ? { max_active_workspaces: maxActive } : {}),
  [type]: descriptorFor(type).tui.defaultBlock(),
});
// Evidence publisher choices (mirrors the EvidenceBlockSchema union in config.ts). A switch preserves
// the shared key_prefix/github_username and resets the type-specific fields to their empty defaults.
const EVIDENCE_PUBLISHER_CHOICES = ["s3", "local", "command"];
const evidenceNode = (publisher: string, keyPrefix?: unknown, githubUsername?: unknown) => ({
  publisher,
  ...(publisher === "s3" ? { bucket: "", region: "", cloudfront_domain: "" } : {}),
  ...(publisher === "command" ? { command: "" } : {}),
  ...(keyPrefix != null ? { key_prefix: keyPrefix } : {}),
  ...(githubUsername != null ? { github_username: githubUsername } : {}),
});
// A newly-added step defaults to the `work` primitive (implements + commits; needs no prompt_file),
// the most common building block — the `type` field is editable to any registered primitive. A
// brand-new belt likewise starts with one valid `work` step, which the user extends.
const defaultStep = (name: string) => ({ type: "work", name });

// Per-step budgets moved onto the step primitives (clean break), so the four *_budget_seconds limits
// are gone from the schema and this list.
const LIMITS: [string, string][] = [
  ["max_active_workspaces", "3"],
  ["attention_renotify_seconds", "3600"],
  ["stall_seconds", "2700"],
  ["idle_nudge_seconds", "300"],
  ["max_bounces", "6"],
  ["max_capture_attempts", "5"],
  ["step_budget_seconds", "3600"],
  ["tick_interval_seconds", "60"],
  ["source_poll_interval_seconds", "= tick_interval_seconds"],
  ["reconcile_concurrency", "8"],
  ["max_claims_per_tick", "10"],
  ["layout_wait_seconds", "600"],
];

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export function buildDescriptors(draft: Document, rebuild: () => void, ctx: FieldCtx, expanded: WeakSet<object>, section: ConfigSection): FieldDesc[] {
  const cfg = (draft.toJS() ?? {}) as Record<string, any>;
  const d: FieldDesc[] = [];
  const node = (path: Path) => draft.getIn(path) as object; // stable yaml node — the collapse key
  const isOpen = (path: Path) => expanded.has(node(path));
  const open = (path: Path) => { const n = node(path); if (n) expanded.add(n); };
  // Reorder an array item by swapping the parent YAMLSeq's item nodes (preserves comments + node
  // identity, so collapse state follows the moved item).
  const swap = (arrayPath: Path, i: number, j: number) => {
    const seq = draft.getIn(arrayPath) as { items?: unknown[] } | undefined;
    if (!seq?.items) return;
    const it = seq.items;
    [it[i], it[j]] = [it[j], it[i]];
    rebuild();
  };
  const mover = (arrayPath: Path, i: number, count: number) => ({
    moveUp: i > 0 ? () => swap(arrayPath, i, i - 1) : undefined,
    moveDown: i < count - 1 ? () => swap(arrayPath, i, i + 1) : undefined,
  });
  // Append to a possibly-absent array (layouts / a belt's layout_matching are optional, so the YAML
  // key may not exist yet). addIn needs an existing collection; setIn creates the sequence first.
  const addToArray = (arrayPath: Path, item: unknown) => {
    if (draft.getIn(arrayPath) == null) draft.setIn(arrayPath, draft.createNode([item]));
    else draft.addIn(arrayPath, draft.createNode(item));
  };

  // ── Referenced-file assist ──────────────────────────────────────────────────────────────────
  // A `config`-sourced prompt_file / match names a file the loader existence-checks at save. When it
  // doesn't exist yet, offer an action row that drops a commented stub in place, so the save the TUI
  // itself set up never fails on a missing file. Only viable when the editor wired repoDir + writeStub
  // (a repo is loaded); resolved relative to the repo's config folder, matching loadConfig's resolveFile.
  const configFileMissing = (rel: string): boolean => {
    if (!ctx.repoDir || !ctx.writeStub || !rel.trim()) return false;
    const abs = isAbsolute(rel) ? rel : join(ctx.repoDir, rel);
    return !existsSync(abs);
  };
  const createStubAction = (rel: string, content: string, indent: number): FieldDesc => ({
    kind: "action",
    label: `+ create ${rel} (stub)`,
    indent,
    run: () => ctx.writeStub!(isAbsolute(rel) ? rel : join(ctx.repoDir!, rel), content),
  });
  // Stubs carry NO `@@TOKEN@@`/`@@WHEN@@` markers of their own — a prompt stub is contract-validated at
  // load, so a literal token would (rightly) be rejected; the token reference is left to docs/PROMPTS.md.
  const promptStub = (rel: string, wholeBody: boolean): string =>
    `<!-- ${basename(rel)} — herdr-factory prompt file.\n` +
    (wholeBody
      ? `     This is the ENTIRE body of this custom step; the engine adds only a handover scaffold.\n`
      : `     This text is appended to the engine's built-in prompt for this step.\n`) +
    `     Prompt-token reference and the product-gated clause syntax: see docs/PROMPTS.md.\n` +
    `     Replace this comment with your guidance. -->\n`;
  const matchStub = (rel: string): string =>
    `// ${basename(rel)} — herdr-factory belt match predicate.\n` +
    `// Return true to claim a work item onto this belt (first matching belt by priority wins).\n` +
    `// ctx = { item, source: { name, type } }; item carries labels + source-native routing fields.\n` +
    `// See the README "Multiple belts" section.\n` +
    `export default (ctx) => true;\n`;

  // Source names are needed by both the work_sources section (dedup on add) and the belt section
  // (the `source` ref choices + which pickup label a belt shows), so compute them regardless.
  const sources: any[] = Array.isArray(cfg.work_sources) ? cfg.work_sources : [];
  const sourceNames = sources.map((s, i) => String(s?.name ?? s?.type ?? `source${i}`));

  // ── general: the singleton blocks (repo / limits / evidence) that share panel [2] ──
  if (section === "general") {
    // repo (a singleton object — always shown, not collapsible)
    d.push({ kind: "header", label: "repo", level: 1 });
    d.push({ kind: "text", label: "path", path: ["repo", "path"], placeholder: "~/dev/my-repo", indent: 1 });
    d.push({ kind: "text", label: "base_ref", path: ["repo", "base_ref"], placeholder: "origin/main", indent: 1 });
    d.push({ kind: "text", label: "github", path: ["repo", "github"], placeholder: "owner/name (optional)", indent: 1 });

    // limits
    d.push({ kind: "header", label: "limits", level: 1 });
    for (const [k, ph] of LIMITS) d.push({ kind: "text", label: k, path: ["limits", k], placeholder: ph, numeric: true, indent: 1 });

    // evidence (optional top-level block — where the evidence step PUBLISHES captured media). A
    // discriminated union on `publisher` (s3 | local | command); a block with no `publisher:` key is
    // `s3`. Non-secret pointers only; S3 creds come from the ambient AWS credential chain (no secret
    // rows). Modelled as an add/remove optional block (like a work source): when absent, an "add"
    // action per publisher creates it; when present, the publisher enum + its fields + the shared
    // key_prefix/github_username + a "remove" action are shown (flushInputs never deletes keys, so an
    // optional block needs the explicit remove to be clearable).
    d.push({ kind: "header", label: "evidence (optional — publish captures: s3 | local | command)", level: 1 });
    if (cfg.evidence == null) {
      d.push({ kind: "action", label: "+ add evidence: s3 (S3 + CloudFront)", indent: 1, run: () => { draft.setIn(["evidence"], draft.createNode({ publisher: "s3", bucket: "", region: "", cloudfront_domain: "" })); rebuild(); } });
      d.push({ kind: "action", label: "+ add evidence: local (served by this server)", indent: 1, run: () => { draft.setIn(["evidence"], draft.createNode({ publisher: "local" })); rebuild(); } });
      d.push({ kind: "action", label: "+ add evidence: command (custom uploader)", indent: 1, run: () => { draft.setIn(["evidence"], draft.createNode({ publisher: "command", command: "" })); rebuild(); } });
    } else {
      const publisher = String((cfg.evidence as any)?.publisher ?? "s3");
      d.push({
        kind: "enum",
        label: "publisher",
        value: publisher,
        choices: EVIDENCE_PUBLISHER_CHOICES,
        indent: 1,
        apply: (next) => {
          if (next === publisher) return;
          // Preserve the shared fields across a publisher switch; reset the type-specific ones.
          const keyPrefix = draft.getIn(["evidence", "key_prefix"]);
          const githubUsername = draft.getIn(["evidence", "github_username"]);
          draft.setIn(["evidence"], draft.createNode(evidenceNode(next, keyPrefix, githubUsername)));
          rebuild();
        },
      });
      if (publisher === "s3") {
        d.push({ kind: "text", label: "bucket", path: ["evidence", "bucket"], placeholder: "my-evidence-bucket", indent: 1 });
        d.push({ kind: "text", label: "region", path: ["evidence", "region"], placeholder: "us-east-1", indent: 1 });
        d.push({ kind: "text", label: "cloudfront_domain", path: ["evidence", "cloudfront_domain"], placeholder: "d123abc.cloudfront.net", indent: 1 });
        d.push({ kind: "text", label: "profile", path: ["evidence", "profile"], placeholder: "(optional AWS CLI profile)", indent: 1 });
      } else if (publisher === "local") {
        d.push({ kind: "text", label: "public_base_url", path: ["evidence", "public_base_url"], placeholder: "(optional; default http://127.0.0.1:<port>)", indent: 1 });
      } else if (publisher === "command") {
        // command is z.union([string, array(string).min(1)]) (config.ts:102) — a bare executable
        // name/path, OR a full argv array (executable + fixed flags). Render whichever shape is
        // already on disk: a list (the agent_args idiom) when it's an array, else a plain text field.
        // A generic text field would stringify an array on render and overwrite it with that string on
        // the next flush; unlike agent_args, a non-empty string still satisfies this union's string
        // branch, so save would SILENTLY SUCCEED — evidence publish then fails at runtime (ENOENT
        // trying to execute the literal stringified array) with no signal at config-save time.
        const cmdPath: Path = ["evidence", "command"];
        const cmdNode = draft.getIn(cmdPath) as { items?: unknown[] } | undefined;
        if (Array.isArray(cmdNode?.items)) {
          const count = cmdNode.items!.length;
          d.push({ kind: "header", label: "command (argv)", level: 2, indent: 1 });
          for (let a = 0; a < count; a++) {
            d.push({ kind: "text", label: `[${a}]`, path: [...cmdPath, a], placeholder: a === 0 ? "./publish-evidence.sh" : "--flag", indent: 2 });
            d.push({ kind: "action", label: "‹ remove ›", indent: 2, run: () => { draft.deleteIn([...cmdPath, a]); rebuild(); } });
          }
          d.push({ kind: "action", label: "+ add command arg", indent: 2, run: () => { addToArray(cmdPath, ""); rebuild(); } });
        } else {
          d.push({ kind: "text", label: "command", path: cmdPath, placeholder: "./publish-evidence.sh", indent: 1 });
        }
        d.push({ kind: "text", label: "timeout_seconds", path: ["evidence", "timeout_seconds"], placeholder: "300", numeric: true, clearable: true, indent: 1 });
        d.push({ kind: "text", label: "public_base_url", path: ["evidence", "public_base_url"], placeholder: "(optional; set ⇒ predicted URLs + background upload)", indent: 1 });
      }
      // Shared across every publisher (uniform key layout).
      d.push({ kind: "text", label: "github_username", path: ["evidence", "github_username"], placeholder: "(optional; default = gh login)", indent: 1 });
      d.push({ kind: "text", label: "key_prefix", path: ["evidence", "key_prefix"], placeholder: "(optional; after herdr-factory/<user>/)", indent: 1 });
      d.push({ kind: "action", label: "‹ remove evidence config ›", indent: 1, run: () => { void ctx.confirm("Remove the evidence publish config?").then((ok) => { if (ok) { draft.deleteIn(["evidence"]); rebuild(); } }); } });
    }

    // guidelines-prompt.md — an optional sibling file (NOT part of config.yml) appended to every step
    // prompt of every belt. Surfaced here as an editable multiline buffer via the editor's text modal.
    if (ctx.editGuidelines) {
      d.push({ kind: "header", label: "guidelines (optional — appended to every step prompt)", level: 1 });
      const exists = ctx.repoDir ? existsSync(join(ctx.repoDir, "guidelines-prompt.md")) : false;
      d.push({ kind: "action", label: exists ? "‹ edit guidelines-prompt.md ›" : "+ create & edit guidelines-prompt.md", indent: 1, run: ctx.editGuidelines });
    }
    return d;
  }

  // ── work_sources (array of objects → collapsible) — panel [3]. The panel border/title labels the
  // section, so no top-level header row here. ──
  if (section === "work_sources") {
    sources.forEach((s, i) => {
      const type = String(s?.type ?? "jira");
      d.push({ kind: "group", label: `${sourceNames[i]} (${type})`, node: node(["work_sources", i]), expanded: isOpen(["work_sources", i]), indent: 0, ...mover(["work_sources"], i, sources.length) });
      if (!isOpen(["work_sources", i])) return;
      d.push({ kind: "text", label: "name", path: ["work_sources", i, "name"], placeholder: type, indent: 1 });
      // Common (type-agnostic) source field: how often to poll THIS source for new work. Optional —
      // clearable back to the repo-wide default (limits.source_poll_interval_seconds, itself the tick).
      d.push({ kind: "text", label: "poll_interval_seconds", path: ["work_sources", i, "poll_interval_seconds"], placeholder: "= source_poll_interval_seconds", numeric: true, clearable: true, indent: 1 });
      // Common (type-agnostic) source field: per-source concurrency cap (worked workspaces across
      // every belt on this source). Clearable back to the default of 2.
      d.push({ kind: "text", label: "max_active_workspaces", path: ["work_sources", i, "max_active_workspaces"], placeholder: "2", numeric: true, clearable: true, indent: 1 });
      d.push({
        kind: "enum",
        label: "type",
        value: type,
        choices: SOURCE_TYPE_CHOICES,
        indent: 1,
        apply: (next) => {
          if (next === type) return;
          const name = draft.getIn(["work_sources", i, "name"]);
          const poll = draft.getIn(["work_sources", i, "poll_interval_seconds"]); // common field survives the type switch
          const maxActive = draft.getIn(["work_sources", i, "max_active_workspaces"]); // common field survives the type switch
          draft.setIn(["work_sources", i], draft.createNode(sourceNode(next as SourceType, name, poll, maxActive)));
          open(["work_sources", i]); // keep expanded after switching type
          rebuild();
        },
      });
      // The type block's fields come from the type's descriptor (an unknown type — hand-edited
      // YAML — falls back to no fields; the schema validation on save reports it properly).
      const descriptor = SOURCE_DESCRIPTORS.find((x) => x.type === type);
      for (const f of descriptor?.tui.fields ?? []) {
        const full: Path = ["work_sources", i, ...f.path];
        if (f.list) {
          // A list of scalar strings (e.g. sentry projects/environment): a header + one editable text
          // row per element + a per-element remove + an add action — the same add/remove idiom the
          // nested arrays (panes/steps) use, since a value can't be cleared safely mid-flush.
          const seq = draft.getIn(full) as { items?: unknown[] } | undefined;
          const count = Array.isArray(seq?.items) ? seq.items.length : 0;
          d.push({ kind: "header", label: f.label, level: 2, indent: 1 });
          for (let k = 0; k < count; k++) {
            d.push({ kind: "text", label: `[${k}]`, path: [...full, k], placeholder: f.placeholder, indent: 2 });
            d.push({ kind: "action", label: "‹ remove ›", indent: 2, run: () => { draft.deleteIn([...full, k]); rebuild(); } });
          }
          d.push({ kind: "action", label: `+ add ${f.label}`, indent: 2, run: () => { addToArray(full, ""); rebuild(); } });
        } else if (f.choices) {
          // A pick-list field (e.g. auth.method): read the current value, default to enumDefault when
          // unset, and setIn on change (creates intermediate maps like auth:{} as needed).
          const cur = draft.getIn(full);
          const value = cur == null ? (f.enumDefault ?? f.choices[0]!) : String(cur);
          d.push({ kind: "enum", label: f.label, value, choices: [...f.choices], indent: 1, apply: (next) => { if (next !== value) { draft.setIn(full, next); rebuild(); } } });
        } else {
          d.push({ kind: "text", label: f.label, path: full, placeholder: f.placeholder, numeric: f.numeric, indent: 1 });
        }
      }
      d.push({ kind: "action", label: "‹ remove source ›", indent: 1, run: () => { void ctx.confirm(`Remove work source "${sourceNames[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["work_sources", i]); rebuild(); } }); } });
    });
    d.push({
      kind: "action",
      label: "+ add work source",
      indent: 0,
      run: () => {
        const type = SOURCE_TYPE_CHOICES[0]!; // jira first (the registry's canonical order)
        draft.addIn(["work_sources"], draft.createNode({ ...sourceNode(type), name: uniqueName(type, sourceNames) }));
        open(["work_sources", sources.length]);
        rebuild();
      },
    });
    return d;
  }

  // Defined layout ids — needed by BOTH the layouts section (dedup/label) and the belt section
  // (default_layout / layout_matching reference them), so compute regardless of `section`.
  const layouts: any[] = Array.isArray(cfg.layouts) ? cfg.layouts : [];
  const layoutIds = layouts.map((l, i) => String(l?.id ?? `layout${i}`));

  // ── layouts (array of objects → collapsible) — panel [4]. A repo-level library of herdr tab/pane
  // arrangements the factory BUILDS into a worktree on creation; belts point at one via
  // default_layout / layout_matching (in the belt section). Nested two levels deep: layout → tabs →
  // panes. The panel border/title labels the section, so no top-level header row here. ──
  if (section === "layouts") {
    // Renaming a layout id / tab title / pane title REPOINTS every belt + step that referenced the
    // old name (see layout-refs.ts), so the belts panel never has to be hand-synced against this one.
    // The layout id and tab title are re-read from the draft when the rename runs (not captured at
    // build time): the flush applies every typed edit before propagating, so renaming a layout AND
    // one of its tabs in a single pass resolves against the names the draft now holds.
    const layoutIdAt = (i: number) => String(draft.getIn(["layouts", i, "id"]) ?? "");
    const tabTitleAt = (i: number, j: number) => String(draft.getIn(["layouts", i, "tabs", j, "title"]) ?? "");
    layouts.forEach((l, i) => {
      const tabs: any[] = Array.isArray(l?.tabs) ? l.tabs : [];
      d.push({ kind: "group", label: `${layoutIds[i]} [${tabs.length} tab${tabs.length === 1 ? "" : "s"}]`, node: node(["layouts", i]), expanded: isOpen(["layouts", i]), indent: 0, ...mover(["layouts"], i, layouts.length) });
      if (!isOpen(["layouts", i])) return;
      d.push({
        kind: "text",
        label: "id",
        path: ["layouts", i, "id"],
        placeholder: "app-dev",
        indent: 1,
        renameRefs: (from, to) => renameSummary("layout", from, to, renameLayoutId(draft, from, to)),
      });

      // setup — an OPTIONAL layout-level command run once in the single `setup: true` pane before the
      // rest of the tabs spawn. Modelled as an add/remove block (flushInputs never deletes keys, so a
      // bare optional text field would be unclearable).
      if (l?.setup == null) {
        d.push({ kind: "action", label: "+ add setup command", indent: 1, run: () => { draft.setIn(["layouts", i, "setup"], draft.createNode({ command: "", blocking: false })); rebuild(); } });
      } else {
        d.push({ kind: "text", label: "setup.command", path: ["layouts", i, "setup", "command"], placeholder: "mise run setup", indent: 1 });
        d.push({ kind: "bool", label: "setup.blocking", value: l?.setup?.blocking === true, indent: 1, apply: (next) => { draft.setIn(["layouts", i, "setup", "blocking"], next); rebuild(); } });
        d.push({ kind: "action", label: "‹ remove setup ›", indent: 1, run: () => { draft.deleteIn(["layouts", i, "setup"]); rebuild(); } });
      }

      // tabs[] — each a herdr tab (its `title` is what a step's `tab` matches) holding ≥1 pane.
      const tabTitles = tabs.map((t, j) => String(t?.title ?? `tab${j}`));
      tabs.forEach((t, j) => {
        const panes: any[] = Array.isArray(t?.panes) ? t.panes : [];
        d.push({ kind: "group", label: `${tabTitles[j]} (${panes.length} pane${panes.length === 1 ? "" : "s"})`, node: node(["layouts", i, "tabs", j]), expanded: isOpen(["layouts", i, "tabs", j]), indent: 1, ...mover(["layouts", i, "tabs"], j, tabs.length) });
        if (!isOpen(["layouts", i, "tabs", j])) return;
        d.push({
          kind: "text",
          label: "title",
          path: ["layouts", i, "tabs", j, "title"],
          placeholder: "work (a step's `tab` matches this)",
          clearable: true,
          indent: 2,
          renameRefs: (from, to) => renameSummary("tab", from, to, renameTabTitle(draft, layoutIdAt(i), from, to)),
        });

        // panes[] — each a herdr pane. The `title` is what a step's `pane` matches; a pane with an
        // `agent` KIND is the one a step's prompt gets delivered to (herdr starts that agent as part
        // of the build). `command` is for everything else — dev servers, editors, tails.
        const paneTitles = panes.map((p, k) => String(p?.title ?? `pane${k}`));
        panes.forEach((p, k) => {
          const base: Path = ["layouts", i, "tabs", j, "panes", k];
          d.push({ kind: "group", label: paneTitles[k]!, node: node(base), expanded: isOpen(base), indent: 2, ...mover(["layouts", i, "tabs", j, "panes"], k, panes.length) });
          if (!isOpen(base)) return;
          d.push({
            kind: "text",
            label: "title",
            path: [...base, "title"],
            placeholder: "agent (a step's `pane` matches this)",
            clearable: true,
            indent: 3,
            renameRefs: (from, to) => renameSummary("pane", from, to, renamePaneTitle(draft, layoutIdAt(i), tabTitleAt(i, j), from, to)),
          });
          // agent / command are mutually exclusive (an agent is started INTO the pane's shell, so a
          // command occupying it would collide), so the editor offers exactly one: picking an agent
          // kind drops any command and hides its row, rather than letting the user compose a config
          // that won't load. The agent's companion keys only appear once a kind is chosen.
          const agentKind = typeof p?.agent === "string" ? p.agent : "(none)";
          d.push({
            kind: "enum",
            label: "agent",
            value: agentKind,
            choices: ["(none)", ...HERDR_AGENT_KINDS],
            indent: 3,
            apply: (next) => {
              if (next === "(none)") {
                for (const k2 of ["agent", "agent_name", "agent_args", "prompt", "agent_timeout_ms", "prompt_timeout_ms"]) draft.deleteIn([...base, k2]);
              } else {
                draft.setIn([...base, "agent"], next);
                draft.deleteIn([...base, "command"]);
                draft.deleteIn([...base, "persist"]);
              }
              rebuild();
            },
          });
          if (agentKind === "(none)") {
            d.push({ kind: "text", label: "command", path: [...base, "command"], placeholder: "mise run dev (an agent pane picks an `agent` instead)", clearable: true, indent: 3 });
          } else {
            // agent_args is a z.array(...) (config.ts:241) — one editable row per element (the same
            // list idiom used for work_sources' scalar-array fields above), not a single text field.
            // A generic text field here would stringify the array on render and, on the very next
            // flush (any navigation, not just an edit), overwrite it with that string — failing the
            // schema's `expected array, received string` check without the user ever touching it.
            const argsPath: Path = [...base, "agent_args"];
            const argsSeq = draft.getIn(argsPath) as { items?: unknown[] } | undefined;
            const argCount = Array.isArray(argsSeq?.items) ? argsSeq.items.length : 0;
            d.push({ kind: "header", label: "agent_args", level: 2, indent: 3 });
            for (let a = 0; a < argCount; a++) {
              d.push({ kind: "text", label: `[${a}]`, path: [...argsPath, a], placeholder: "--dangerously-skip-permissions", indent: 4 });
              d.push({ kind: "action", label: "‹ remove ›", indent: 4, run: () => { draft.deleteIn([...argsPath, a]); rebuild(); } });
            }
            d.push({ kind: "action", label: "+ add agent_args", indent: 4, run: () => { addToArray(argsPath, ""); rebuild(); } });
            d.push({ kind: "text", label: "agent_name", path: [...base, "agent_name"], placeholder: "lowercase, unique — derived when empty", clearable: true, indent: 3 });
          }
          d.push({ kind: "bool", label: "setup", value: p?.setup === true, indent: 3, apply: (next) => { draft.setIn([...base, "setup"], next); rebuild(); } });
          // split — optional; a leading "(unset)" clears it (a tab's first pane ignores split anyway).
          const splitCur = p?.split == null ? "(unset)" : String(p.split);
          d.push({ kind: "enum", label: "split", value: splitCur, choices: ["(unset)", ...SPLIT_CHOICES], indent: 3, apply: (next) => { if (next === "(unset)") draft.deleteIn([...base, "split"]); else draft.setIn([...base, "split"], next); rebuild(); } });
          // size is PaneSizeSchema (config.ts:212) — a percentage STRING ("40%") or a bare NUMBER (a
          // 0<n<1 fraction or a ≥1 cell count), with no coercion on the number branch. `numeric: true`
          // makes the flush write an actual number for "0.4"/"3" (Number(t) is finite) while leaving a
          // "40%" string alone (Number("40%") is NaN) — without it, a bare-number size would get
          // reflushed as a plain string on the next navigation and fail `expected number, received
          // string`, the same corruption class fixed for agent_args above.
          d.push({ kind: "text", label: "size", path: [...base, "size"], placeholder: '"40%", a 0<n<1 fraction, or cells', clearable: true, numeric: true, indent: 3 });
          d.push({ kind: "action", label: "‹ remove pane ›", indent: 3, run: () => { void ctx.confirm(`Remove pane "${paneTitles[k]}"?`).then((ok) => { if (ok) { draft.deleteIn(base); rebuild(); } }); } });
        });
        d.push({ kind: "action", label: "+ add pane", indent: 2, run: () => { draft.addIn(["layouts", i, "tabs", j, "panes"], draft.createNode({ title: uniqueName("pane", paneTitles), agent: "claude" })); open(["layouts", i, "tabs", j, "panes", panes.length]); rebuild(); } });
        d.push({ kind: "action", label: "‹ remove tab ›", indent: 2, run: () => { void ctx.confirm(`Remove tab "${tabTitles[j]}"?`).then((ok) => { if (ok) { draft.deleteIn(["layouts", i, "tabs", j]); rebuild(); } }); } });
      });
      d.push({ kind: "action", label: "+ add tab", indent: 1, run: () => { draft.addIn(["layouts", i, "tabs"], draft.createNode({ title: uniqueName("tab", tabTitles), panes: [{ title: "agent", agent: "claude" }] })); open(["layouts", i, "tabs", tabs.length]); rebuild(); } });
      d.push({ kind: "action", label: "‹ remove layout ›", indent: 1, run: () => { void ctx.confirm(`Remove layout "${layoutIds[i]}"?`).then((ok) => { if (ok) { draft.deleteIn(["layouts", i]); rebuild(); } }); } });
    });
    d.push({
      kind: "action",
      label: "+ add layout",
      indent: 0,
      run: () => {
        addToArray(["layouts"], { id: uniqueName("layout", layoutIds), tabs: [{ title: "work", panes: [{ title: "agent", agent: "claude" }] }] });
        open(["layouts", layouts.length]);
        rebuild();
      },
    });
    return d;
  }

  // ── belts (array of objects → collapsible) — panel [5]. The panel border/title labels the
  // section, so no top-level header row here. ──
  const belts: any[] = Array.isArray(cfg.belt) ? cfg.belt : [];
  const beltNames = belts.map((b, i) => String(b?.name ?? `belt${i}`));
  // Which pickup-label noun (if any) each source name uses — drives whether a belt on it shows a
  // `label` field. Falls back to no-label for hand-edited/unknown source types.
  const sourceTypeByName = new Map(sources.map((s, i) => [sourceNames[i]!, String(s?.type ?? "")]));
  belts.forEach((b, i) => {
    const steps: any[] = Array.isArray(b?.steps) ? b.steps : [];
    // Group label shows the step pipeline (there is no belt_type anymore — the lifecycle is derived
    // from what the steps produce; a belt with a `pr` step gets the terminal PR watch).
    const pipeline = steps.map((s) => String(s?.type ?? "?")).join("→") || "empty";
    d.push({ kind: "group", label: `${beltNames[i]} [${pipeline}]`, node: node(["belt", i]), expanded: isOpen(["belt", i]), indent: 0, ...mover(["belt"], i, belts.length) });
    if (!isOpen(["belt", i])) return;
    d.push({ kind: "text", label: "name", path: ["belt", i, "name"], placeholder: "my_belt", indent: 1 });
    d.push({ kind: "ref", label: "source", value: String(b?.source ?? ""), choices: sourceNames.length ? sourceNames : [""], indent: 1, apply: (next) => { draft.setIn(["belt", i, "source"], next); rebuild(); } });
    d.push({ kind: "text", label: "priority", path: ["belt", i, "priority"], placeholder: "100", numeric: true, indent: 1 });
    // active (default true): an inactive belt takes on no new work; its in-flight runs keep going.
    d.push({ kind: "bool", label: "active", value: b?.active !== false, indent: 1, apply: (next) => { if (next) draft.deleteIn(["belt", i, "active"]); else draft.setIn(["belt", i, "active"], false); rebuild(); } });
    // The per-belt pickup label — shown only for a label-driven source (jira/github_issues), where
    // it's REQUIRED; a source with no label concept (local_markdown) has none, so it's hidden.
    const pickup = SOURCE_DESCRIPTORS.find((x) => x.type === sourceTypeByName.get(String(b?.source ?? "")))?.pickupLabel;
    if (pickup) d.push({ kind: "text", label: "label", path: ["belt", i, "label"], placeholder: `${pickup.noun} — required (no default)`, indent: 1 });
    d.push({ kind: "text", label: "workspace_name", path: ["belt", i, "workspace_name"], placeholder: "{{work_id}}-{{work_slug}}", clearable: true, indent: 1 });
    d.push({ kind: "text", label: "match", path: ["belt", i, "match"], placeholder: "match.ts (optional)", clearable: true, indent: 1 });
    // Referenced-file assist: a `match` predicate is existence-checked on save; offer to stub it.
    const matchRel = b?.match ? String(b.match) : "";
    if (matchRel && configFileMissing(matchRel)) d.push(createStubAction(matchRel, matchStub(matchRel), 1));

    // Layout selection — which `layouts:` entry (section 4) the factory builds into this belt's
    // worktrees. default_layout is the fallback; a layout_matching rule picks a different one per
    // branch (first matching glob wins). Both reference a layout id; "(unset)" clears default_layout.
    const dlCur = b?.default_layout == null ? "(unset)" : String(b.default_layout);
    d.push({ kind: "enum", label: "default_layout", value: dlCur, choices: ["(unset)", ...layoutIds], indent: 1, apply: (next) => { if (next === "(unset)") draft.deleteIn(["belt", i, "default_layout"]); else draft.setIn(["belt", i, "default_layout"], next); rebuild(); } });
    const rules: any[] = Array.isArray(b?.layout_matching) ? b.layout_matching : [];
    rules.forEach((r, k) => {
      d.push({ kind: "group", label: `match ${String(r?.worktree_pattern ?? "?")} → ${String(r?.layout ?? "?")}`, node: node(["belt", i, "layout_matching", k]), expanded: isOpen(["belt", i, "layout_matching", k]), indent: 1, ...mover(["belt", i, "layout_matching"], k, rules.length) });
      if (!isOpen(["belt", i, "layout_matching", k])) return;
      d.push({ kind: "text", label: "worktree_pattern", path: ["belt", i, "layout_matching", k, "worktree_pattern"], placeholder: "hotfix/*", indent: 2 });
      d.push({ kind: "enum", label: "layout", value: String(r?.layout ?? (layoutIds[0] ?? "")), choices: layoutIds.length ? layoutIds : [""], indent: 2, apply: (next) => { draft.setIn(["belt", i, "layout_matching", k, "layout"], next); rebuild(); } });
      d.push({ kind: "action", label: "‹ remove rule ›", indent: 2, run: () => { void ctx.confirm("Remove this layout_matching rule?").then((ok) => { if (ok) { draft.deleteIn(["belt", i, "layout_matching", k]); rebuild(); } }); } });
    });
    d.push({ kind: "action", label: "+ add layout_matching rule", indent: 1, run: () => { addToArray(["belt", i, "layout_matching"], { worktree_pattern: "", layout: layoutIds[0] ?? "" }); open(["belt", i, "layout_matching", rules.length]); rebuild(); } });

    // Step→pane allocation choices. A step's tab/pane must name a LABELED pane of the belt's
    // `default_layout` — the layout every factory-claimed worktree gets, and the one the loader
    // validates each step's target against — so once a default_layout is picked, `tab` and `pane`
    // below become pick-lists over that layout's real tabs/panes (choose a tab, then one of ITS
    // panes) and allocating a step never needs a trip to the layouts panel [4]. With no
    // default_layout there is nothing to enumerate (those panes come from outside the factory — a
    // hand-built workspace, or a layout_matching layout the loader deliberately exempts), so the
    // rows stay free text.
    const beltLayout = b?.default_layout == null ? undefined : layouts.find((l) => String(l?.id ?? "") === String(b.default_layout));
    const targets = layoutTargets(beltLayout);

    // steps[] — an ordered list of step-primitive references. `type` picks the primitive; a `custom`
    // step's prompt_file is its whole body (required), an engine-prompted step's is an optional augment.
    const stepNames = steps.map((s, j) => String(s?.name ?? s?.type ?? `step${j}`));
    steps.forEach((st, j) => {
      const stType = String(st?.type ?? "custom");
      d.push({ kind: "group", label: `${stepNames[j]} (${stType})`, node: node(["belt", i, "steps", j]), expanded: isOpen(["belt", i, "steps", j]), indent: 1, ...mover(["belt", i, "steps"], j, steps.length) });
      if (!isOpen(["belt", i, "steps", j])) return;
      d.push({ kind: "enum", label: "type", value: stType, choices: STEP_TYPE_CHOICES, indent: 2, apply: (next) => { if (next !== stType) { draft.setIn(["belt", i, "steps", j, "type"], next); rebuild(); } } });
      d.push({ kind: "text", label: "name", path: ["belt", i, "steps", j, "name"], placeholder: `${stType} (defaults to type)`, indent: 2 });
      // tab/pane — the layout pane this step is dispatched to (both-or-neither). A requiresLayout
      // step (evidence) is SKIPPED entirely without one, which is easy to do by accident — say so.
      const requiresLayout = stepDescriptorFor(stType)?.controls.posture?.requiresLayout === true;
      const tabCur = st?.tab == null ? null : String(st.tab);
      const paneCur = st?.pane == null ? null : String(st.pane);
      if (requiresLayout && !(tabCur && paneCur)) {
        d.push({ kind: "header", label: `↳ no tab/pane ⇒ this ${stType} step is SKIPPED (it only runs in a layout pane)`, level: 2, indent: 2 });
      }
      // The first SURVIVING step of a `default_layout` belt must carry a target: its dedicated pane
      // would be a new tab, which stops the layout from ever being built, so config-load refuses the
      // belt. Say it here, beside the pick-lists that fix it, rather than letting `^S` fail.
      const firstKeptIdx = steps.findIndex((s) => {
        const d2 = stepDescriptorFor(String(s?.type ?? "custom"));
        return !(d2?.controls.posture?.requiresLayout === true && !(s?.tab && s?.pane));
      });
      if (b?.default_layout != null && j === firstKeptIdx && !(tabCur && paneCur)) {
        d.push({
          kind: "header",
          label: `↳ the first step of a layout belt MUST name a pane — without one its own pane's tab stops "${String(b.default_layout)}" from being built`,
          level: 2,
          indent: 2,
        });
      }
      if (targets.length > 0) {
        // Move both keys together, so the both-or-neither invariant can't be broken from here.
        const setTarget = (tab: string | null, pane: string | null) => {
          for (const [key, v] of [["tab", tab], ["pane", pane]] as const) {
            if (v == null) draft.deleteIn(["belt", i, "steps", j, key]);
            else draft.setIn(["belt", i, "steps", j, key], v);
          }
          rebuild();
        };
        // A value the layout doesn't define (a hand-edit, or a default_layout switch) stays in the
        // list, so it's visible as the current value and can be cycled away from deliberately.
        const withCur = (choices: string[], cur: string | null) => (cur == null || choices.includes(cur) ? choices : [cur, ...choices]);
        const panesOf = (title: string | null) => targets.find((t) => t.tab === title)?.panes ?? [];
        // Panes this belt's OTHER steps already sit in — the loader rejects two steps sharing one
        // (the first dispatch relabels the pane), so the auto-pick below steps around them.
        const claimed = new Set(steps.filter((_, k) => k !== j).map((s) => `${String(s?.tab ?? "")}\0${String(s?.pane ?? "")}`));
        d.push({
          kind: "enum",
          label: "tab",
          value: tabCur ?? "(unset)",
          choices: withCur(["(unset)", ...targets.map((t) => t.tab)], tabCur),
          indent: 2,
          apply: (next) => {
            if (next === "(unset)") return setTarget(null, null); // clears the pair
            // Keep the pane when the chosen tab has one by that title; else land on its first
            // unclaimed pane, so a single pick leaves a complete target the loader accepts.
            const panes = panesOf(next);
            const free = panes.find((p) => !claimed.has(`${next}\0${p}`));
            setTarget(next, paneCur && panes.includes(paneCur) ? paneCur : (free ?? panes[0] ?? paneCur));
          },
        });
        d.push({
          kind: "enum",
          label: "pane",
          value: paneCur ?? "(unset)",
          choices: withCur(["(unset)", ...panesOf(tabCur)], paneCur), // the SELECTED tab's panes
          indent: 2,
          apply: (next) => (next === "(unset)" ? setTarget(null, null) : setTarget(tabCur, next)),
        });
      } else {
        // Free text: no default_layout, or one whose tabs/panes are untitled — herdr addresses a pane
        // by title, so an untitled one is unreachable and there is nothing to offer.
        const layoutHint = beltLayout
          ? `layout "${String(b.default_layout)}" has no titled panes — title a tab + pane in [4]`
          : requiresLayout
            ? "(runs only if tab+pane set; else skipped)"
            : "(optional; set with the other)";
        d.push({ kind: "text", label: "tab", path: ["belt", i, "steps", j, "tab"], placeholder: layoutHint, clearable: true, indent: 2 });
        d.push({ kind: "text", label: "pane", path: ["belt", i, "steps", j, "pane"], placeholder: layoutHint, clearable: true, indent: 2 });
      }
      d.push({ kind: "text", label: "prompt_file", path: ["belt", i, "steps", j, "prompt_file"], placeholder: stType === "custom" ? "prompts/step.md (required)" : "(optional augment)", clearable: true, indent: 2 });
      d.push(optionalSource(["belt", i, "steps", j, "prompt_file_source"], st?.prompt_file_source, draft, rebuild, 2));
      // Referenced-file assist: a `config`-sourced prompt_file is existence-checked on save. Offer to
      // stub it (a `repo`-sourced one lives in the target checkout, so it can't be created from here).
      const pfRel = st?.prompt_file ? String(st.prompt_file) : "";
      const pfSource = st?.prompt_file_source == null ? "config" : String(st.prompt_file_source);
      if (pfRel && pfSource === "config" && configFileMissing(pfRel)) d.push(createStubAction(pfRel, promptStub(pfRel, stType === "custom"), 2));
      // prompt_mode: how a prompt_file relates to the shipped base — augment (default) | replace (own
      // the body). Only meaningful for an engine-prompted step; a `custom` step's prompt IS the body.
      if (stType !== "custom") {
        d.push({
          kind: "enum",
          label: "prompt_mode",
          value: st?.prompt_mode == null ? "(unset)" : String(st.prompt_mode),
          choices: ["(unset)", "augment", "replace"],
          indent: 2,
          // augment is the default — drop the key when it or (unset) is chosen; write only `replace`.
          apply: (next) => {
            if (next === "replace") draft.setIn(["belt", i, "steps", j, "prompt_mode"], next);
            else draft.deleteIn(["belt", i, "steps", j, "prompt_mode"]);
            rebuild();
          },
        });
      }
      d.push({ kind: "text", label: "budget_seconds", path: ["belt", i, "steps", j, "budget_seconds"], placeholder: "(optional; default per type)", numeric: true, clearable: true, indent: 2 });
      d.push({ kind: "bool", label: "heartbeat", value: st?.heartbeat === true, indent: 2, apply: (next) => { draft.setIn(["belt", i, "steps", j, "heartbeat"], next); rebuild(); } });
      d.push({ kind: "action", label: "‹ remove step ›", indent: 2, run: () => { void ctx.confirm(`Remove step "${stepNames[j]}"?`).then((ok) => { if (ok) { draft.deleteIn(["belt", i, "steps", j]); rebuild(); } }); } });
    });
    d.push({ kind: "action", label: "+ add step", indent: 1, run: () => { draft.addIn(["belt", i, "steps"], draft.createNode(defaultStep(uniqueName("step", stepNames)))); open(["belt", i, "steps", steps.length]); rebuild(); } });
    // On save the delete is guarded (refused if the belt has work in progress) and, when it goes
    // through, the belt's finished-run rows are purged + any leftover worktrees cleaned (its event
    // timeline is kept). The confirm just removes it from the draft; save does the cleanup.
    d.push({ kind: "action", label: "‹ remove belt ›", indent: 1, run: () => { void ctx.confirm(`Remove belt "${beltNames[i]}"? On save its finished-run data is purged (blocked if work is in progress).`).then((ok) => { if (ok) { draft.deleteIn(["belt", i]); rebuild(); } }); } });
  });
  d.push({
    kind: "action",
    label: "+ add belt",
    indent: 0,
    run: () => {
      const source = sourceNames[0] ?? "";
      const name = uniqueName("belt", beltNames);
      const addBelt = (preset: "ticket_pr" | "custom") => {
        if (preset === "ticket_pr") {
          // The ticket → PR pipeline: work → review → pr. A label-driven source (jira/github_issues)
          // needs a pickup label (required, no default), so seed the conventional `agent` — the preset
          // then validates as-is. A label-less source (local_markdown/sentry) must NOT carry a label.
          const pickup = SOURCE_DESCRIPTORS.find((x) => x.type === sourceTypeByName.get(source))?.pickupLabel;
          const belt: Record<string, unknown> = { name, source };
          if (pickup) belt.label = "agent";
          belt.steps = [{ type: "work" }, { type: "review" }, { type: "pr" }];
          draft.addIn(["belt"], draft.createNode(belt));
        } else {
          // A custom pipeline: one valid `work` step the user extends (the historical add-belt seed).
          draft.addIn(["belt"], draft.createNode({ name, source, priority: 100, steps: [{ type: "work", name: "work" }] }));
        }
        open(["belt", belts.length]);
        rebuild();
      };
      void ctx.choose("New belt — pipeline preset", [
        { label: "ticket → PR pipeline (work → review → pr)", value: "ticket_pr" },
        { label: "custom pipeline…", value: "custom" },
      ]).then((preset) => { if (preset === "ticket_pr" || preset === "custom") addBelt(preset); });
    },
  });

  return d;
}

/** An optional enum (e.g. a w2pr agent's prompt_file_source): a `(unset)` choice deletes the key. */
function optionalSource(path: Path, current: unknown, draft: Document, rebuild: () => void, indent: number): FieldDesc {
  return {
    kind: "enum",
    label: "prompt_file_source",
    value: current == null ? "(unset)" : String(current),
    choices: ["(unset)", "config", "repo"],
    indent,
    apply: (next) => {
      if (next === "(unset)") draft.deleteIn(path);
      else draft.setIn(path, next);
      rebuild();
    },
  };
}
