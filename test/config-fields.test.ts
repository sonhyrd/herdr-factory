// The TUI config editor's field builder — specifically that a source's descriptor `tui.fields`
// render, including the new enum (pick-list) support that surfaces jira's auth.method.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument, type Document } from "yaml";
import { buildDescriptors, type FieldCtx, type FieldDesc } from "../src/tui/config-fields.ts";
import { RepoConfigSchema } from "../src/config.ts";
import { validatePromptBody } from "../src/prompts/contract.ts";

/** A default field-builder ctx for tests: modal helpers stubbed, no repo dir / assist wiring.
 *  Override per test (e.g. a `choose` that picks a preset, or a `repoDir` + `writeStub` for the
 *  referenced-file assist). */
const ctx = (over: Partial<FieldCtx> = {}): FieldCtx => ({ confirm: async () => true, choose: async () => null, ...over });

/** Flush the microtask + timer queue so an async action (a `void choose().then(...)`) has settled. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// Real temp config dirs for the referenced-file assist (existsSync is real IO), cleaned per test.
const tmps: string[] = [];
afterEach(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); tmps.length = 0; });
const tmpRepoDir = (): string => { const d = mkdtempSync(join(tmpdir(), "cfg-fields-")); tmps.push(d); return d; };
const actionRun = (fields: FieldDesc[], label: string): void => {
  const a = fields.find((f) => f.kind === "action" && f.label === label);
  if (a?.kind !== "action") throw new Error(`expected the "${label}" action`);
  a.run();
};

/** Build the field list with the given source expanded (its inner fields only render when open). */
function fieldsFor(doc: Document): FieldDesc[] {
  const expanded = new WeakSet<object>();
  const src = doc.getIn(["work_sources", 0]) as object;
  if (src) expanded.add(src);
  return buildDescriptors(doc, () => {}, ctx(), expanded, "work_sources");
}

const jiraDoc = () =>
  parseDocument(`work_sources:
  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: P
      board: "1"
belt: []
`);

describe("config-fields: source poll_interval_seconds", () => {
  it("renders a clearable numeric poll_interval_seconds row for every source (common field)", () => {
    const f = fieldsFor(jiraDoc()).find(
      (x) => x.kind === "text" && x.label === "poll_interval_seconds" && "path" in x && (x.path as (string | number)[])?.[2] === "poll_interval_seconds",
    );
    if (f?.kind !== "text") throw new Error("expected the poll_interval_seconds text field");
    expect(f.numeric).toBe(true);
    expect(f.clearable).toBe(true); // blank ⇒ falls back to the repo default, not written
    expect(f.path).toEqual(["work_sources", 0, "poll_interval_seconds"]);
  });

  it("surfaces source_poll_interval_seconds in the limits panel", () => {
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const general = buildDescriptors(doc, () => {}, ctx(), new WeakSet(), "general");
    const lim = general.find((x) => x.kind === "text" && x.label === "source_poll_interval_seconds");
    expect(lim).toBeTruthy();
    if (lim?.kind === "text") expect(lim.path).toEqual(["limits", "source_poll_interval_seconds"]);
  });
});

describe("config-fields: jira board (api_token only — no auth field)", () => {
  it("renders a jira.board text field bound to the board path", () => {
    const board = fieldsFor(jiraDoc()).find((f) => f.kind === "text" && f.label === "jira.board");
    expect(board?.kind).toBe("text");
    if (board?.kind === "text") expect(board.path).toEqual(["work_sources", 0, "jira", "board"]);
  });

  it("no longer offers an auth.method field (Jira is api_token only)", () => {
    expect(fieldsFor(jiraDoc()).some((f) => f.kind === "enum" && f.label === "auth.method")).toBe(false);
  });
});

/** Build the belt-section fields with belt 0 and its step 0 expanded (inner fields render only when open). */
function beltStepFields(doc: Document, stepIndex = 0): FieldDesc[] {
  const expanded = new WeakSet<object>();
  const belt = doc.getIn(["belt", 0]) as object;
  const step = doc.getIn(["belt", 0, "steps", stepIndex]) as object;
  if (belt) expanded.add(belt);
  if (step) expanded.add(step);
  return buildDescriptors(doc, () => {}, ctx(), expanded, "belt");
}

const beltWithPromptDoc = () =>
  parseDocument(`work_sources: []
belt:
  - name: b
    source: s
    steps:
      - type: custom
        name: do_thing
        prompt_file: prompts/step.md
        prompt_file_source: config
`);

describe("config-fields: clearable optional scalars (unset-in-place regression)", () => {
  // Repro of the reported bug: a step that HAD a prompt_file can't be saved after clearing it,
  // because a non-clearable text field skips empties on flush and the stale value survives. These
  // optional scalars must be `clearable` so blanking them deletes the key.
  it.each(["prompt_file", "tab", "pane", "budget_seconds"])(
    "marks the belt step's %s field clearable",
    (label) => {
      const f = beltStepFields(beltWithPromptDoc()).find((x) => x.kind === "text" && x.label === label);
      if (f?.kind !== "text") throw new Error(`expected a text field for ${label}`);
      expect(f.clearable).toBe(true);
    },
  );

  it.each(["workspace_name", "match"])("marks the belt's %s field clearable", (label) => {
    const f = beltStepFields(beltWithPromptDoc()).find((x) => x.kind === "text" && x.label === label);
    if (f?.kind !== "text") throw new Error(`expected a text field for ${label}`);
    expect(f.clearable).toBe(true);
  });

  it("leaves a required scalar (belt name) non-clearable so a blank can't silently drop it", () => {
    const f = beltStepFields(beltWithPromptDoc()).find((x) => x.kind === "text" && x.label === "name" && "path" in x && (x.path as (string | number)[])?.[2] === "name");
    if (f?.kind !== "text") throw new Error("expected the belt name text field");
    expect(f.clearable).toBeUndefined();
  });
});

// ── section 4: layouts (the repo-level herdr tab/pane library the factory builds into worktrees) ──
function layoutFields(doc: Document, openPaths: (string | number)[][] = []): FieldDesc[] {
  const expanded = new WeakSet<object>();
  for (const p of openPaths) {
    const n = doc.getIn(p) as object;
    if (n) expanded.add(n);
  }
  return buildDescriptors(doc, () => {}, ctx(), expanded, "layouts");
}

const layoutDoc = () =>
  parseDocument(`work_sources: []
belt: []
layouts:
  - id: app-dev
    tabs:
      - title: work
        panes:
          - { title: agent, command: claude }
          - { title: server, command: mise run dev, split: right, size: "40%" }
`);

describe("config-fields: layouts section", () => {
  it("lists each layout as a collapsible group labelled by id + tab count", () => {
    const g = layoutFields(layoutDoc()).find((f) => f.kind === "group");
    if (g?.kind !== "group") throw new Error("expected a layout group row");
    expect(g.label).toBe("app-dev [1 tab]");
  });

  it("+ add layout creates a `layouts` array even when the key is absent (optional block)", () => {
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const add = layoutFields(doc).find((f) => f.kind === "action" && f.label === "+ add layout");
    if (add?.kind !== "action") throw new Error("expected the add-layout action");
    add.run();
    expect(doc.getIn(["layouts", 0, "id"])).toBe("layout");
    // The seeded pane is an AGENT pane (`agent: claude`), not a `command: claude` one — herdr
    // starts the targeting step's own configured harness there.
    expect(doc.getIn(["layouts", 0, "tabs", 0, "panes", 0, "agent"])).toBe("claude");
    expect(doc.getIn(["layouts", 0, "tabs", 0, "panes", 0, "command"])).toBeUndefined();
  });

  it("exposes a pane's split as an enum with an (unset) clear option", () => {
    const paths = [["layouts", 0], ["layouts", 0, "tabs", 0], ["layouts", 0, "tabs", 0, "panes", 1]];
    const split = layoutFields(layoutDoc(), paths).find((f) => f.kind === "enum" && f.label === "split");
    if (split?.kind !== "enum") throw new Error("expected the pane split enum");
    expect(split.value).toBe("right");
    expect(split.choices).toEqual(["(unset)", "vertical", "horizontal", "right", "down"]);
    split.apply("(unset)");
  });

  it("marks pane title/command/size clearable so they can be unset in place", () => {
    const paths = [["layouts", 0], ["layouts", 0, "tabs", 0], ["layouts", 0, "tabs", 0, "panes", 0]];
    const fields = layoutFields(layoutDoc(), paths);
    for (const label of ["command", "size"]) {
      const f = fields.find((x) => x.kind === "text" && x.label === label);
      if (f?.kind !== "text") throw new Error(`expected a text field for ${label}`);
      expect(f.clearable).toBe(true);
    }
  });

  // Regression: agent_args is a z.array(...) (config.ts:241). A single stringified text field would
  // clobber it into a scalar on the very next flush (any navigation), which then fails
  // RepoConfigSchema with "expected array, received string" even though the on-disk value was
  // never touched by the user.
  it("renders agent_args as a list (header + one row per element + add), not a single text field", () => {
    const doc = parseDocument(`work_sources: []
belt: []
layouts:
  - id: app-dev
    tabs:
      - title: work
        panes:
          - { title: agent, agent: claude, agent_args: ["--dangerously-skip-permissions"] }
`);
    const paths = [["layouts", 0], ["layouts", 0, "tabs", 0], ["layouts", 0, "tabs", 0, "panes", 0]];
    const fields = layoutFields(doc, paths);
    expect(fields.some((f) => f.kind === "header" && f.label === "agent_args")).toBe(true);
    expect(fields.some((f) => f.kind === "text" && f.label === "agent_args")).toBe(false);
    const elem = fields.find((f) => f.kind === "text" && f.label === "[0]");
    if (elem?.kind !== "text") throw new Error("expected an agent_args[0] row");
    expect(elem.path).toEqual(["layouts", 0, "tabs", 0, "panes", 0, "agent_args", 0]);
    expect(fields.some((f) => f.kind === "action" && f.label === "+ add agent_args")).toBe(true);
    expect((doc.toJS() as any).layouts[0].tabs[0].panes[0].agent_args).toEqual(["--dangerously-skip-permissions"]);
  });

  // Regression: PaneSizeSchema (config.ts:212) accepts a percentage STRING ("40%") or a bare NUMBER
  // (a fraction or cell count) with NO coercion on the number branch. Without `numeric: true`, the
  // editor's flush (config-editor.ts flushInputs) always writes back a plain string — so a config
  // that already had a numeric size (e.g. `size: 3`) would get silently rewritten to the string "3"
  // on the next navigation and then fail `expected number, received string`, the same corruption
  // class as the agent_args bug above.
  it("marks size numeric so a bare-number size (fraction/cells) round-trips as a number, not a string", () => {
    const paths = [["layouts", 0], ["layouts", 0, "tabs", 0], ["layouts", 0, "tabs", 0, "panes", 0]];
    const size = layoutFields(layoutDoc(), paths).find((f) => f.kind === "text" && f.label === "size");
    if (size?.kind !== "text") throw new Error("expected a text field for size");
    expect(size.numeric).toBe(true);
  });
});

// Regression: evidence.command is z.union([string, array(string).min(1)]) (config.ts:102) — a bare
// executable, or a full argv array. Both fully validate, so a generic text field stringifying the
// array on render and clobbering it back into a string scalar on the next flush wouldn't even fail
// save — it would silently corrupt the config, and evidence publish would fail at runtime instead.
describe("config-fields: evidence.command (string executable vs argv array)", () => {
  const generalFields = (doc: Document): FieldDesc[] => buildDescriptors(doc, () => {}, ctx(), new WeakSet(), "general");

  it("renders a plain text field when command is a bare string", () => {
    const doc = parseDocument(`work_sources: []\nbelt: []\nevidence: { publisher: command, command: "./publish-evidence.sh" }\n`);
    const fields = generalFields(doc);
    const cmd = fields.find((f) => f.kind === "text" && f.label === "command");
    if (cmd?.kind !== "text") throw new Error("expected a text field for command");
    expect(cmd.path).toEqual(["evidence", "command"]);
    expect(fields.some((f) => f.kind === "header" && f.label === "command (argv)")).toBe(false);
  });

  it("renders a list (header + one row per arg + add), not a single text field, when command is an array", () => {
    const doc = parseDocument(`work_sources: []\nbelt: []\nevidence: { publisher: command, command: ["node", "scripts/publish.js", "--flag"] }\n`);
    const fields = generalFields(doc);
    expect(fields.some((f) => f.kind === "header" && f.label === "command (argv)")).toBe(true);
    expect(fields.some((f) => f.kind === "text" && f.label === "command")).toBe(false);
    const elems = fields.filter((f) => f.kind === "text" && "path" in f && (f.path as (string | number)[])?.[0] === "evidence" && (f.path as (string | number)[])?.[1] === "command");
    expect(elems.map((f) => (f as Extract<FieldDesc, { kind: "text" }>).path)).toEqual([
      ["evidence", "command", 0],
      ["evidence", "command", 1],
      ["evidence", "command", 2],
    ]);
    expect(fields.some((f) => f.kind === "action" && f.label === "+ add command arg")).toBe(true);
    expect((doc.toJS() as any).evidence.command).toEqual(["node", "scripts/publish.js", "--flag"]);
  });

  it("+ add command arg appends an empty element to the argv array", () => {
    const doc = parseDocument(`work_sources: []\nbelt: []\nevidence: { publisher: command, command: ["node"] }\n`);
    actionRun(generalFields(doc), "+ add command arg");
    expect((doc.toJS() as any).evidence.command).toEqual(["node", ""]);
  });
});

describe("config-fields: belt references a layout", () => {
  const doc = () =>
    parseDocument(`work_sources: []
belt:
  - name: b
    source: s
    steps: [{ type: work }]
layouts:
  - id: app-dev
    tabs: [{ title: work, panes: [{ title: agent, command: claude }] }]
`);

  it("offers default_layout as an enum over the defined layout ids (+ an (unset) option)", () => {
    const d = doc();
    const expanded = new WeakSet<object>();
    expanded.add(d.getIn(["belt", 0]) as object);
    const dl = buildDescriptors(d, () => {}, ctx(), expanded, "belt").find((f) => f.kind === "enum" && f.label === "default_layout");
    if (dl?.kind !== "enum") throw new Error("expected the default_layout enum");
    expect(dl.choices).toEqual(["(unset)", "app-dev"]);
    dl.apply("app-dev");
    expect(d.getIn(["belt", 0, "default_layout"])).toBe("app-dev");
  });
});

// ── step → layout-pane allocation: with a default_layout picked, a step's tab/pane are pick-lists
// over THAT layout's real tabs/panes (and the pane list follows the chosen tab), so allocating a step
// never means flipping back to the layouts panel to recall a title. ──
describe("config-fields: step tab/pane pick from the belt's default_layout", () => {
  const allocDoc = (step = "{ type: work, tab: work, pane: agent }") =>
    parseDocument(`work_sources: []
belt:
  - name: b
    source: s
    default_layout: app-dev
    steps: [${step}]
layouts:
  - id: app-dev
    tabs:
      - title: work
        panes: [{ title: agent, command: claude }, { title: server, command: mise run dev }]
      - title: review
        panes: [{ title: agent, command: claude }]
      - title: logs
        panes: [{ command: tail -f log }]
`);
  /** The step's tab/pane rows (belt + step 0 expanded), by label. */
  const rowFor = (d: Document, label: "tab" | "pane"): FieldDesc => {
    const f = beltStepFields(d).find((x) => x.label === label);
    if (!f) throw new Error(`expected a ${label} row`);
    return f;
  };
  const enumFor = (d: Document, label: "tab" | "pane"): Extract<FieldDesc, { kind: "enum" }> => {
    const f = rowFor(d, label);
    if (f.kind !== "enum") throw new Error(`expected the ${label} row to be a pick-list, got ${f.kind}`);
    return f;
  };

  it("offers the layout's titled tabs (an untitled-pane tab is unaddressable, so it's not offered)", () => {
    expect(enumFor(allocDoc(), "tab").choices).toEqual(["(unset)", "work", "review"]);
  });

  it("offers only the SELECTED tab's panes", () => {
    expect(enumFor(allocDoc(), "pane").choices).toEqual(["(unset)", "agent", "server"]);
    expect(enumFor(allocDoc("{ type: work, tab: review, pane: agent }"), "pane").choices).toEqual(["(unset)", "agent"]);
  });

  it("picking a tab keeps a pane that tab has", () => {
    const d = allocDoc("{ type: work, tab: work, pane: agent }");
    enumFor(d, "tab").apply("review");
    expect(d.getIn(["belt", 0, "steps", 0, "tab"])).toBe("review");
    expect(d.getIn(["belt", 0, "steps", 0, "pane"])).toBe("agent");
  });

  it("picking a tab lands on its first pane when the current one isn't in it (target stays complete)", () => {
    const d = allocDoc("{ type: work, tab: work, pane: server }");
    enumFor(d, "tab").apply("review");
    expect(d.getIn(["belt", 0, "steps", 0, "pane"])).toBe("agent");
    // …and the loader's step→pane allocation check has nothing to complain about.
    const issues = RepoConfigSchema.safeParse(d.toJS()).error?.issues ?? [];
    expect(issues.filter((i) => i.path.includes("pane"))).toEqual([]);
  });

  it("steps around a pane a sibling step already claims (one agent pane per step)", () => {
    // step 0 sits in work/agent, so allocating step 1 to the `work` tab lands it on work/server.
    const d = allocDoc("{ type: work, tab: work, pane: agent }, { type: review }");
    const expanded = new WeakSet<object>();
    expanded.add(d.getIn(["belt", 0]) as object);
    expanded.add(d.getIn(["belt", 0, "steps", 1]) as object);
    const tab = buildDescriptors(d, () => {}, ctx(), expanded, "belt").find((f) => f.kind === "enum" && f.label === "tab");
    if (tab?.kind !== "enum") throw new Error("expected the tab pick-list");
    tab.apply("work");
    expect(d.getIn(["belt", 0, "steps", 1, "pane"])).toBe("server");
  });

  it("(unset) on either row clears the pair (tab/pane are both-or-neither)", () => {
    for (const label of ["tab", "pane"] as const) {
      const d = allocDoc();
      enumFor(d, label).apply("(unset)");
      expect(d.getIn(["belt", 0, "steps", 0, "tab"])).toBeUndefined();
      expect(d.getIn(["belt", 0, "steps", 0, "pane"])).toBeUndefined();
    }
  });

  it("picking a pane leaves the tab alone", () => {
    const d = allocDoc();
    enumFor(d, "pane").apply("server");
    expect(d.getIn(["belt", 0, "steps", 0, "tab"])).toBe("work");
    expect(d.getIn(["belt", 0, "steps", 0, "pane"])).toBe("server");
  });

  it("keeps a target the layout no longer defines as the current value, so it can be cycled away from", () => {
    const d = allocDoc("{ type: work, tab: gone, pane: ghost }");
    expect(enumFor(d, "tab").choices).toEqual(["gone", "(unset)", "work", "review"]);
    expect(enumFor(d, "tab").value).toBe("gone");
    expect(enumFor(d, "pane").choices).toEqual(["ghost", "(unset)"]); // no tab match ⇒ no pane list
  });

  it("falls back to free text with no default_layout (the panes come from outside the factory)", () => {
    const d = parseDocument(`work_sources: []
belt: [{ name: b, source: s, steps: [{ type: work }] }]
layouts: [{ id: app-dev, tabs: [{ title: work, panes: [{ title: agent }] }] }]
`);
    for (const label of ["tab", "pane"] as const) {
      const f = rowFor(d, label);
      if (f.kind !== "text") throw new Error(`expected a free-text ${label} row`);
      expect(f.clearable).toBe(true);
    }
  });

  it("falls back to free text when the belt's layout has no titled panes at all", () => {
    const d = parseDocument(`work_sources: []
belt: [{ name: b, source: s, default_layout: bare, steps: [{ type: work }] }]
layouts: [{ id: bare, tabs: [{ panes: [{ command: claude }] }] }]
`);
    const f = rowFor(d, "tab");
    if (f.kind !== "text") throw new Error("expected a free-text tab row");
    expect(f.placeholder).toContain("no titled panes");
  });

  it("warns that a requiresLayout step (evidence) is skipped while its tab/pane are unset", () => {
    const skipped = beltStepFields(allocDoc("{ type: evidence }")).find((f) => f.kind === "header" && f.label.includes("SKIPPED"));
    expect(skipped).toBeDefined();
    const allocated = beltStepFields(allocDoc("{ type: evidence, tab: work, pane: agent }")).find((f) => f.kind === "header" && f.label.includes("SKIPPED"));
    expect(allocated).toBeUndefined();
  });

  // Load REFUSES a default_layout belt whose first surviving step has no target, so the editor says so
  // beside the pick-lists that fix it rather than letting ^S fail with a message about a step index.
  const firstStepWarning = (step: string, expand = 0): boolean =>
    beltStepFields(allocDoc(step), expand).some((f) => f.kind === "header" && f.label.includes("MUST name a pane"));

  it("warns when the FIRST step of a default_layout belt has no tab/pane (config-load would refuse it)", () => {
    expect(firstStepWarning("{ type: work }")).toBe(true);
    expect(firstStepWarning("{ type: work, tab: work, pane: agent }")).toBe(false);
  });

  it("…and points at the first SURVIVING step — a skipped evidence step ahead of it is not the one", () => {
    // `{ type: evidence }` is dropped at load, so the `work` step behind it is what dispatches first:
    // the warning belongs to it, and disappears once IT is targeted.
    // (expand index 1 — a collapsed step renders no rows of its own, so the warning lives with it.)
    expect(firstStepWarning("{ type: evidence }, { type: work }", 1)).toBe(true);
    expect(firstStepWarning("{ type: evidence }, { type: work, tab: work, pane: agent }", 1)).toBe(false);
    // …and the skipped evidence step itself never carries it, even expanded.
    expect(firstStepWarning("{ type: evidence }, { type: work }", 0)).toBe(false);
  });
});

// ── renaming a layout id / tab title / pane title repoints every belt + step that referenced the old
// name, so section [5] never has to be hand-synced against section [4]. ──
describe("config-fields: a layout rename repoints its belt references", () => {
  const doc = () =>
    parseDocument(`work_sources: []
belt:
  - name: b
    source: s
    default_layout: app-dev
    layout_matching: [{ worktree_pattern: "hotfix/*", layout: app-dev }]
    steps:
      - { type: work, tab: work, pane: agent }
      - { type: review, tab: work, pane: reviewer }
      - { type: pr }
layouts:
  - id: app-dev
    tabs:
      - title: work
        panes: [{ title: agent, command: claude }, { title: reviewer, command: claude }]
`);
  /** A layouts-section `title`/`id` text row, identified by its exact path. */
  const nameRow = (d: Document, path: (string | number)[]): Extract<FieldDesc, { kind: "text" }> => {
    const open = [["layouts", 0], ["layouts", 0, "tabs", 0], ["layouts", 0, "tabs", 0, "panes", 0], ["layouts", 0, "tabs", 0, "panes", 1]];
    const f = layoutFields(d, open).find((x) => x.kind === "text" && JSON.stringify(x.path) === JSON.stringify(path));
    if (f?.kind !== "text") throw new Error(`expected a text row at ${path.join(".")}`);
    return f;
  };
  const steps = (d: Document) => (d.toJS() as any).belt[0].steps;

  it("renaming a layout id repoints default_layout AND every layout_matching rule", () => {
    const d = doc();
    const msg = nameRow(d, ["layouts", 0, "id"]).renameRefs!("app-dev", "web");
    expect(d.getIn(["belt", 0, "default_layout"])).toBe("web");
    expect(d.getIn(["belt", 0, "layout_matching", 0, "layout"])).toBe("web");
    expect(msg).toContain("repointed 2 references");
  });

  it("renaming a tab title repoints every step allocated to that tab", () => {
    const d = doc();
    const msg = nameRow(d, ["layouts", 0, "tabs", 0, "title"]).renameRefs!("work", "code");
    expect(steps(d).map((s: any) => s.tab)).toEqual(["code", "code", undefined]);
    expect(msg).toContain("repointed 2 references");
  });

  it("renaming a pane title repoints only the steps aimed at THAT pane", () => {
    const d = doc();
    nameRow(d, ["layouts", 0, "tabs", 0, "panes", 1, "title"]).renameRefs!("reviewer", "review-agent");
    expect(steps(d).map((s: any) => s.pane)).toEqual(["agent", "review-agent", undefined]);
  });

  it("resolves a tab/pane rename against the layout's CURRENT id (both renamed in one pass)", () => {
    const d = doc();
    // The flush applies typed values before propagating, so the id row's own value has already moved.
    d.setIn(["layouts", 0, "id"], "web");
    nameRow(d, ["layouts", 0, "id"]).renameRefs!("app-dev", "web");
    nameRow(d, ["layouts", 0, "tabs", 0, "title"]).renameRefs!("work", "code");
    expect(d.getIn(["belt", 0, "default_layout"])).toBe("web");
    expect(steps(d)[0].tab).toBe("code");
  });

  it("keeps a renamed tab's step targets loadable (the whole point: an unsynced rename fails to save)", () => {
    const d = parseDocument(`repo: { path: /tmp/x, base_ref: origin/main }
work_sources: [{ type: local_markdown, name: s, local_markdown: { folder: /tmp/briefs } }]
belt: [{ name: b, source: s, default_layout: app-dev, steps: [{ type: work, tab: work, pane: agent }] }]
layouts: [{ id: app-dev, tabs: [{ title: work, panes: [{ title: agent, command: claude }] }] }]
`);
    expect(RepoConfigSchema.safeParse(d.toJS()).success).toBe(true);
    // The rename alone (what a flush writes) leaves the step aimed at a pane the layout no longer
    // defines — the loader's allocation check rejects it…
    d.setIn(["layouts", 0, "tabs", 0, "title"], "code");
    expect(RepoConfigSchema.safeParse(d.toJS()).success).toBe(false);
    // …and the propagation the flush queues alongside it puts the config back in a loadable state.
    nameRow(d, ["layouts", 0, "tabs", 0, "title"]).renameRefs!("work", "code");
    expect(RepoConfigSchema.safeParse(d.toJS()).success).toBe(true);
  });

  it("reports nothing when no belt referenced the old name", () => {
    const d = doc();
    expect(nameRow(d, ["layouts", 0, "tabs", 0, "panes", 0, "title"]).renameRefs!("agent", "worker")).toContain("repointed 1");
    // A second layout nobody points at: renaming its tab moves nothing, so there's no status line.
    const other = parseDocument("work_sources: []\nbelt: []\nlayouts: [{ id: solo, tabs: [{ title: t, panes: [{ title: p }] }] }]\n");
    expect(nameRow(other, ["layouts", 0, "tabs", 0, "title"]).renameRefs!("t", "t2")).toBeNull();
  });

  it("leaves an AMBIGUOUS step reference alone (another layout the belt uses defines the same target)", () => {
    const d = doc();
    // The belt also matches `hotfix/*` onto a second layout that defines work/agent — which layout
    // step 0 meant can't be known, so the rename skips it (and says so) rather than guessing.
    d.setIn(["belt", 0, "layout_matching", 0, "layout"], "hotfix");
    d.addIn(["layouts"], d.createNode({ id: "hotfix", tabs: [{ title: "work", panes: [{ title: "agent" }] }] }));
    const msg = nameRow(d, ["layouts", 0, "tabs", 0, "title"]).renameRefs!("work", "code");
    expect(steps(d).map((s: any) => s.tab)).toEqual(["work", "code", undefined]); // step 1 (work/reviewer) is unique to app-dev
    expect(msg).toContain("repointed 1 reference");
    expect(msg).toContain("1 left alone");
  });
});

const sentryDoc = () =>
  parseDocument(`work_sources:
  - type: sentry
    sentry:
      organization: acme
      projects: [backend, web]
      environment: [production]
belt: []
`);

describe("config-fields: sentry list fields (projects/environment)", () => {
  it("renders a header + one editable text row per element (pointing at the array indices) + an add action", () => {
    const fields = fieldsFor(sentryDoc());
    expect(fields.some((f) => f.kind === "header" && f.label === "sentry.projects")).toBe(true);
    const elems = fields.filter((f) => f.kind === "text" && "path" in f && (f.path as (string | number)[])?.[3] === "projects");
    expect(elems.map((f) => (f as Extract<FieldDesc, { kind: "text" }>).path)).toEqual([
      ["work_sources", 0, "sentry", "projects", 0],
      ["work_sources", 0, "sentry", "projects", 1],
    ]);
    expect(fields.some((f) => f.kind === "action" && f.label === "+ add sentry.projects")).toBe(true);
    expect(fields.some((f) => f.kind === "action" && f.label === "+ add sentry.environment")).toBe(true);
  });

  it("+ add appends an empty element to the YAML array", () => {
    const doc = sentryDoc();
    const add = fieldsFor(doc).find((f) => f.kind === "action" && f.label === "+ add sentry.environment");
    if (add?.kind === "action") add.run();
    expect((doc.toJS() as { work_sources: { sentry: { environment: string[] } }[] }).work_sources[0]!.sentry.environment).toEqual(["production", ""]);
  });

  it("+ add creates the array when the key is absent", () => {
    const doc = parseDocument("work_sources:\n  - type: sentry\n    sentry: { organization: acme }\nbelt: []\n");
    const add = fieldsFor(doc).find((f) => f.kind === "action" && f.label === "+ add sentry.projects");
    if (add?.kind === "action") add.run();
    expect((doc.toJS() as { work_sources: { sentry: { projects: string[] } }[] }).work_sources[0]!.sentry.projects).toEqual([""]);
  });

  it("the first ‹ remove › deletes projects[0]", () => {
    const doc = sentryDoc();
    const remove = fieldsFor(doc).find((f) => f.kind === "action" && f.label === "‹ remove ›"); // projects render first
    if (remove?.kind === "action") remove.run();
    expect((doc.toJS() as { work_sources: { sentry: { projects: string[] } }[] }).work_sources[0]!.sentry.projects).toEqual(["web"]);
  });
});

// ── belt presets ("+ add belt" offers a pipeline preset via the choose modal) ──
const jiraSourceDoc = () =>
  parseDocument(`repo:\n  path: /tmp/repo\nwork_sources:\n  - { type: jira, name: jira, jira: { base_url: "https://x.atlassian.net", project: P, board: "1" } }\nbelt: []\n`);
const mdSourceDoc = () =>
  parseDocument(`repo:\n  path: /tmp/repo\nwork_sources:\n  - { type: local_markdown, name: briefs, local_markdown: { folder: "~/x" } }\nbelt: []\n`);
const addBelt = async (doc: Document, preset: "ticket_pr" | "custom"): Promise<Record<string, any>> => {
  actionRun(buildDescriptors(doc, () => {}, ctx({ choose: async () => preset }), new WeakSet(), "belt"), "+ add belt");
  await flush();
  return (doc.toJS() as { belt: Record<string, any>[] }).belt[0]!;
};

describe("config-fields: + add belt presets", () => {
  it("ticket → PR preset seeds a work→review→pr belt WITH a label for a label-driven source", async () => {
    const b = await addBelt(jiraSourceDoc(), "ticket_pr");
    expect(b.source).toBe("jira");
    expect(b.label).toBe("agent");
    expect(b.steps.map((s: any) => s.type)).toEqual(["work", "review", "pr"]);
  });

  it("ticket → PR preset omits the label for a label-less source (local_markdown)", async () => {
    const b = await addBelt(mdSourceDoc(), "ticket_pr");
    expect(b.source).toBe("briefs");
    expect("label" in b).toBe(false);
    expect(b.steps.map((s: any) => s.type)).toEqual(["work", "review", "pr"]);
  });

  it("custom preset seeds the historical single-work-step belt (no label)", async () => {
    const b = await addBelt(jiraSourceDoc(), "custom");
    expect(b.steps.map((s: any) => s.type)).toEqual(["work"]);
    expect("label" in b).toBe(false);
  });

  it("a dismissed preset picker (choose → null) adds no belt", async () => {
    const doc = jiraSourceDoc();
    actionRun(buildDescriptors(doc, () => {}, ctx({ choose: async () => null }), new WeakSet(), "belt"), "+ add belt");
    await flush();
    expect((doc.toJS() as { belt: unknown[] }).belt).toEqual([]);
  });

  it("the presets produce belts that pass RepoConfigSchema", async () => {
    // The curated ticket → PR preset validates on either source kind; the custom preset validates on
    // a label-less source (on a label-driven one it needs the required label filled — as it always did).
    for (const [docFn, preset] of [[jiraSourceDoc, "ticket_pr"], [mdSourceDoc, "ticket_pr"], [mdSourceDoc, "custom"]] as const) {
      const doc = docFn();
      await addBelt(doc, preset);
      const res = RepoConfigSchema.safeParse(doc.toJS());
      expect(res.success, `${docFn.name}/${preset}: ${res.success ? "" : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });
});

describe("config-fields: + add step defaults to work", () => {
  it("seeds a `work` step (not `custom`)", () => {
    const doc = parseDocument(`work_sources: []\nbelt:\n  - name: b\n    source: s\n    steps: [{ type: work }]\n`);
    const expanded = new WeakSet<object>();
    expanded.add(doc.getIn(["belt", 0]) as object);
    actionRun(buildDescriptors(doc, () => {}, ctx(), expanded, "belt"), "+ add step");
    const steps = (doc.toJS() as { belt: { steps: { type: string }[] }[] }).belt[0]!.steps;
    expect(steps[steps.length - 1]!.type).toBe("work");
  });
});

// ── referenced-file assist: offer to create a missing config-sourced prompt_file / match ──
const stepDoc = (source: "config" | "repo") =>
  parseDocument(`work_sources: []\nbelt:\n  - name: b\n    source: s\n    steps:\n      - { type: custom, name: do, prompt_file: prompts/step.md, prompt_file_source: ${source} }\n`);
const openBeltStep = (doc: Document): WeakSet<object> => {
  const e = new WeakSet<object>();
  e.add(doc.getIn(["belt", 0]) as object);
  e.add(doc.getIn(["belt", 0, "steps", 0]) as object);
  return e;
};

describe("config-fields: referenced-file assist", () => {
  it("offers to create a missing config-sourced prompt_file, writing a contract-valid stub", () => {
    const repoDir = tmpRepoDir();
    const doc = stepDoc("config");
    let wrote: { abs: string; content: string } | null = null;
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: (abs, content) => { wrote = { abs, content }; } }), openBeltStep(doc), "belt");
    actionRun(fields, "+ create prompts/step.md (stub)");
    const w = wrote as { abs: string; content: string } | null;
    expect(w).not.toBeNull();
    expect(w!.abs).toBe(join(repoDir, "prompts/step.md"));
    // The stub must pass the prompt contract (no unrendered @@TOKEN@@ / malformed @@WHEN@@ of its own).
    expect(validatePromptBody(w!.content, { isActive: () => false, guardKinds: new Set() })).toEqual([]);
  });

  it("does NOT offer to create a prompt_file that already exists", () => {
    const repoDir = tmpRepoDir();
    mkdirSync(join(repoDir, "prompts"), { recursive: true });
    writeFileSync(join(repoDir, "prompts", "step.md"), "hi\n");
    const doc = stepDoc("config");
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: () => {} }), openBeltStep(doc), "belt");
    expect(fields.some((f) => f.kind === "action" && f.label.startsWith("+ create"))).toBe(false);
  });

  it("does NOT offer to create a repo-sourced prompt_file (it lives in the target checkout)", () => {
    const repoDir = tmpRepoDir();
    const doc = stepDoc("repo");
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: () => {} }), openBeltStep(doc), "belt");
    expect(fields.some((f) => f.kind === "action" && f.label.startsWith("+ create"))).toBe(false);
  });

  it("offers to create a missing match predicate with an `export default` stub", () => {
    const repoDir = tmpRepoDir();
    const doc = parseDocument(`work_sources: []\nbelt:\n  - name: b\n    source: s\n    match: match.ts\n    steps: [{ type: work }]\n`);
    const e = new WeakSet<object>();
    e.add(doc.getIn(["belt", 0]) as object);
    let wrote: { abs: string; content: string } | null = null;
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, writeStub: (abs, content) => { wrote = { abs, content }; } }), e, "belt");
    actionRun(fields, "+ create match.ts (stub)");
    const w = wrote as { abs: string; content: string } | null;
    expect(w!.abs).toBe(join(repoDir, "match.ts"));
    expect(w!.content).toContain("export default");
  });

  it("makes no offer without a repoDir (no repo loaded)", () => {
    const doc = stepDoc("config");
    const fields = buildDescriptors(doc, () => {}, ctx(), openBeltStep(doc), "belt");
    expect(fields.some((f) => f.kind === "action" && f.label.startsWith("+ create"))).toBe(false);
  });
});

describe("config-fields: guidelines-prompt.md buffer", () => {
  it("offers a create action when the file is absent and editGuidelines is wired", () => {
    const repoDir = tmpRepoDir();
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    let opened = 0;
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, editGuidelines: () => { opened++; } }), new WeakSet(), "general");
    actionRun(fields, "+ create & edit guidelines-prompt.md");
    expect(opened).toBe(1);
  });

  it("shows an edit action when the file already exists", () => {
    const repoDir = tmpRepoDir();
    writeFileSync(join(repoDir, "guidelines-prompt.md"), "guidance\n");
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const fields = buildDescriptors(doc, () => {}, ctx({ repoDir, editGuidelines: () => {} }), new WeakSet(), "general");
    expect(fields.some((f) => f.kind === "action" && f.label === "‹ edit guidelines-prompt.md ›")).toBe(true);
  });

  it("omits the guidelines section entirely without editGuidelines wiring", () => {
    const doc = parseDocument("work_sources: []\nbelt: []\n");
    const fields = buildDescriptors(doc, () => {}, ctx(), new WeakSet(), "general");
    expect(fields.some((f) => f.kind === "header" && f.label.startsWith("guidelines"))).toBe(false);
  });
});
