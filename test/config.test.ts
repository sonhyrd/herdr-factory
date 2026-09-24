import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { hostname, tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig, assertMainCheckout, expandHome, configJsonSchema, evidenceKeyPrefix, RepoConfigSchema } from "../src/config.ts";
import { DEFAULT_BRANCH_TAXONOMY, branchName } from "../src/core/branch.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/types.ts";
import type { JiraSourceCfg } from "../src/clients/jira-source.ts";
import type { SentrySourceCfg } from "../src/clients/sentry-source.ts";
import type { GithubIssuesSourceCfg } from "../src/clients/github-issues-source.ts";
import type { LocalMarkdownSourceCfg } from "../src/sources/local-markdown/descriptor.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups) f();
  cleanups.length = 0;
  delete process.env.HERDR_FACTORY_CONFIG_DIR;
  delete process.env.HERDR_FACTORY_STATE_ROOT;
});

// Reusable config fragments (already list-item indented).
const JIRA_SRC = `  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
const LM_SRC = `  - type: local_markdown
    name: ideas
    local_markdown: { folder: ~/work }
`;
const SENTRY_SRC = `  - type: sentry
    sentry: { organization: acme, projects: [backend], environment: [production], query: "is:unresolved level:error" }
`;
// A belt is one ordered steps[] list referencing registered step primitives by `type` (the engine
// ships their prompts). `label` is the per-belt pickup label — REQUIRED for a belt on a label-driven
// source (jira here). No evidence step here ⇒ work → review → pr.
const SHIP_BELT = `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`;

/** Assemble a full config.yml from a `work_sources` body + a `belt` body (both list-item indented). */
function cfg(workSources: string, belts: string, head = "repo:\n  path: __REPO__\n"): string {
  return `${head}work_sources:\n${workSources}belt:\n${belts}`;
}

function setup(yml: string, opts?: { guidance?: string; prompts?: Record<string, string> }) {
  const base = mkdtempSync(join(tmpdir(), "cats-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const repoPath = join(base, "repo");
  mkdirSync(join(repoPath, ".git"), { recursive: true }); // main checkout: .git is a dir
  const repoDir = join(base, "cfg", "repos", "demo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "config.yml"), yml.replaceAll("__REPO__", repoPath));
  if (opts?.guidance) writeFileSync(join(repoDir, "guidelines-prompt.md"), opts.guidance);
  for (const [name, body] of Object.entries(opts?.prompts ?? {})) {
    mkdirSync(dirname(join(repoDir, name)), { recursive: true }); // support nested paths (e.g. a prompt pack)
    writeFileSync(join(repoDir, name), body);
  }
  // Jira auth (email + token) is strictly per-repo, in repos/<name>/env.
  writeFileSync(join(repoDir, "env"), "JIRA_EMAIL=me@x.com\nJIRA_API_TOKEN=tok\n");
  process.env.HERDR_FACTORY_CONFIG_DIR = join(base, "cfg");
  process.env.HERDR_FACTORY_STATE_ROOT = join(base, "state");
  return { repoPath, repoDir };
}

describe("loadConfig — work sources + belts", () => {
  it("maps a jira source + a belt + applies defaults + strips trailing slash", () => {
    const { repoPath } = setup(
      cfg(`  - type: jira
    jira:
      base_url: https://x.atlassian.net/
      project: RWR
      board: 254
      status:
        todo: To Do
        in_development: In development
        review: Ready for Code Review
`, SHIP_BELT),
      { guidance: "- use the X skill" },
    );
    const { config, env } = loadConfig("demo");
    expect(config.repo.path).toBe(repoPath);
    expect(config.sources.length).toBe(1);
    const s = config.sources[0]!;
    expect(s.name).toBe("jira"); // default name = type
    expect(s.type).toBe("jira");
    const jira = s.cfg as JiraSourceCfg; // resolved by the jira descriptor
    expect(jira.baseUrl).toBe("https://x.atlassian.net"); // trailing slash stripped
    expect(jira.project).toBe("RWR");
    expect(jira.board).toBe("254"); // the required Agile board id pickup pulls from (coerced to string)
    expect((jira as unknown as Record<string, unknown>).label).toBeUndefined(); // label is per-belt now, not on the source
    expect(jira.statusInDev).toBe("In development");
    expect(jira.statusDone).toBeUndefined(); // opt-in: no `status.done` ⇒ terminal stays unmapped
    expect(config.limits.stallSeconds).toBe(2700); // default
    expect(config.limits.maxActiveWorkspaces).toBe(3); // default
    expect(config.limits.stepBudgetSeconds).toBe(3600); // default
    expect(config.guidance).toContain("use the X skill");
    expect(env.JIRA_EMAIL).toBe("me@x.com"); // auth still per-repo env
    expect(config.paths.dbPath).toContain("herdr-factory.db");

    const belt = config.belts[0]!;
    expect(belt.name).toBe("ship");
    expect(belt.beltType).toBe("work_to_pull_request"); // DERIVED display label (a pr step ⇒ PR watch)
    expect(belt.source).toBe("jira");
    expect(belt.label).toBe("agent"); // per-belt pickup label (no default — set in SHIP_BELT)
    expect(belt.priority).toBe(100); // default
    expect(belt.active).toBe(true); // default — a belt takes on new work unless explicitly paused
    expect(belt.watchPr).toBe(true); // derived: a step produces pull_request
  });

  it("honors an explicit belt active: false", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT.replace("    source: jira", "    source: jira\n    active: false")));
    expect(loadConfig("demo").config.belts[0]!.active).toBe(false);
  });

  it("resolves an opt-in status.done to statusDone (trimmed)", () => {
    setup(
      cfg(
        `  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: RWR
      board: 254
      status:
        done: "  Done  "
`,
        SHIP_BELT,
      ),
    );
    const jira = loadConfig("demo").config.sources[0]!.cfg as JiraSourceCfg;
    expect(jira.statusDone).toBe("Done"); // .trim().min(1)
  });

  describe("belt effects (configurable task progression)", () => {
    // A jira source that declares an extra status.qa the belt can target, + a belt with effects.
    const JIRA_QA = `  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: RWR
      board: 254
      status: { qa: QA Review }
`;
    const beltWithEffects = (effects: string, steps = `      - { type: work, tab: work, pane: agent }\n      - { type: review, tab: review, pane: agent }\n      - { type: pr, tab: pr, pane: agent }`) =>
      `  - name: ship\n    source: jira\n    label: agent\n    effects:\n${effects}    steps:\n${steps}\n`;

    it("resolves a custom-status effect (anchor + source-native status) and a canonical effect", () => {
      setup(cfg(JIRA_QA, beltWithEffects("      - { on: produce, product: pull_request, to: qa, anchor: in_review }\n      - { on: teardown, outcome: merged, to: done }\n")));
      const jira = loadConfig("demo").config.sources[0]!.cfg as JiraSourceCfg;
      expect(jira.statusExtra).toEqual({ qa: "QA Review" }); // widened status map
      const effects = loadConfig("demo").config.belts[0]!.effects!;
      expect(effects).toContainEqual({ trigger: { on: "produce", product: "pull_request" }, to: "in_review", status: "qa" });
      // A canonical `to` resolves with no source-native status override.
      expect(effects).toContainEqual({ trigger: { on: "teardown", outcome: "merged" }, to: "done", status: undefined });
    });

    it("a belt with no effects resolves to [] (defaults unchanged)", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT));
      expect(loadConfig("demo").config.belts[0]!.effects).toEqual([]);
    });

    it("rejects a custom status on an INTERNAL-LEDGER source (canonical-only in v1)", () => {
      const LM_BELT = `  - name: spikes\n    source: ideas\n    effects:\n      - { on: produce, product: pull_request, to: qa, anchor: in_review }\n    steps:\n      - { type: work, tab: work, pane: agent }\n      - { type: review, tab: review, pane: agent }\n      - { type: pr, tab: pr, pane: agent }\n`;
      setup(cfg(LM_SRC, LM_BELT));
      expect(() => loadConfig("demo")).toThrow(/internal-ledger|canonical states only|work_items CHECK/);
    });

    it("rejects a custom status the source does not declare", () => {
      setup(cfg(JIRA_SRC, beltWithEffects("      - { on: produce, product: pull_request, to: staging, anchor: in_review }\n")));
      expect(() => loadConfig("demo")).toThrow(/declares no such status|custom status "staging"/);
    });

    it("rejects a custom `to` with no anchor (needs an explicit rank)", () => {
      setup(cfg(JIRA_QA, beltWithEffects("      - { on: produce, product: pull_request, to: qa }\n")));
      expect(() => loadConfig("demo")).toThrow(/needs an `anchor`|not a canonical state/);
    });

    it("rejects an effect on a step the belt doesn't have", () => {
      setup(cfg(JIRA_QA, beltWithEffects("      - { on: enter, step: qa, to: qa, anchor: in_review }\n")));
      expect(() => loadConfig("demo")).toThrow(/no such step/);
    });

    it("rejects an effect on a product no step produces", () => {
      // work → review → pr produces no evidence; an on: produce evidence effect is unsatisfiable.
      setup(cfg(JIRA_QA, beltWithEffects("      - { on: produce, product: evidence, to: qa, anchor: in_review }\n")));
      expect(() => loadConfig("demo")).toThrow(/no step in the belt produces it/);
    });

    it("rejects two effects on the same trigger", () => {
      setup(cfg(JIRA_QA, beltWithEffects("      - { on: produce, product: pull_request, to: qa, anchor: in_review }\n      - { on: produce, product: pull_request, to: in_review }\n")));
      expect(() => loadConfig("demo")).toThrow(/two effects on the same trigger/);
    });
  });

  it("requires the Agile board (no default) and coerces a numeric id to a string", () => {
    setup(cfg(`  - type: jira\n    jira: { base_url: https://x.atlassian.net, project: RWR }\n`, SHIP_BELT));
    expect(() => loadConfig("demo")).toThrow(/board/); // required, no default

    setup(cfg(`  - type: jira\n    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }\n`, SHIP_BELT));
    expect((loadConfig("demo").config.sources[0]!.cfg as JiraSourceCfg).board).toBe("254");
  });

  it("rejects an unknown key in the jira block (the strict block — e.g. a stray `auth` or typo)", () => {
    setup(cfg(`  - type: jira\n    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254, auth: { method: oauth } }\n`, SHIP_BELT));
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized|auth/);
  });

  // Onboarding friction: the fields a new user hits first must fail with an actionable directive, not
  // zod's opaque "expected string, received undefined" (or a bare "Invalid input" from a union).
  describe("required-field errors are actionable", () => {
    it("names what to put in `repo.path`", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT, "repo: {}\n"));
      expect(() => loadConfig("demo")).toThrow(/repo\.path.*checkout/s);
    });
    it("directs you to add a `repo` section when it's missing entirely", () => {
      setup(`work_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}`);
      expect(() => loadConfig("demo")).toThrow(/`repo` section/);
    });
    it("directs you to add a work source when `work_sources` is missing", () => {
      setup(`repo:\n  path: __REPO__\nbelt:\n${SHIP_BELT}`);
      expect(() => loadConfig("demo")).toThrow(/work_sources.*pull work from/s);
    });
    it("directs you to add a belt when `belt` is missing", () => {
      setup(`repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}`);
      expect(() => loadConfig("demo")).toThrow(/belt.*steps.*pipeline/s);
    });
    it("names the Agile board id for a missing jira.board (not a bare union error)", () => {
      setup(cfg(`  - type: jira\n    jira: { base_url: https://x.atlassian.net, project: RWR }\n`, SHIP_BELT));
      expect(() => loadConfig("demo")).toThrow(/jira\.board.*Agile board id/s);
    });
    it("names the Atlassian site for a missing jira.base_url", () => {
      setup(cfg(`  - type: jira\n    jira: { project: RWR, board: 254 }\n`, SHIP_BELT));
      expect(() => loadConfig("demo")).toThrow(/base_url.*Atlassian site/s);
    });
    it("names the folder for a missing local_markdown.folder", () => {
      setup(
        cfg(`  - type: local_markdown\n    name: ideas\n    local_markdown: {}\n`, `  - name: gen\n    source: ideas\n    steps: [{ type: custom, name: r, prompt_file: r.md }]\n`),
        { prompts: { "r.md": "x\n" } },
      );
      expect(() => loadConfig("demo")).toThrow(/local_markdown\.folder.*task briefs/s);
    });
    it("names the org for a missing sentry.organization", () => {
      setup(cfg(`  - type: sentry\n    sentry: { projects: [backend] }\n`, `  - name: err\n    source: sentry\n    steps: [{ type: work }, { type: review }, { type: pr }]\n`));
      expect(() => loadConfig("demo")).toThrow(/sentry\.organization.*org slug/s);
    });
  });

  it("maps a github_issues source with defaults (labels, close_on, type map) and camelCase resolution", () => {
    setup(
      cfg(
        `  - type: github_issues
    name: gh
    github_issues: { repo: acme/tracker }
`,
        `  - name: ship
    source: gh
    label: factory
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`,
      ),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    const s = config.sources[0]!;
    expect(s.name).toBe("gh");
    expect(s.type).toBe("github_issues");
    const gh = s.cfg as GithubIssuesSourceCfg;
    expect(gh.repo).toBe("acme/tracker");
    expect((gh as unknown as Record<string, unknown>).triggerLabel).toBeUndefined(); // trigger label is per-belt now
    expect(gh.stateLabels).toEqual({ inDevelopment: "herdr:in-development", inReview: "herdr:in-review", aborted: "herdr:aborted" });
    expect(gh.closeOn).toEqual({ merged: true, done: true, aborted: false });
    expect(gh.typeLabels.bug).toBe("Bug");
    expect(gh.defaultType).toBe("Feature");
    expect(gh.maxPages).toBe(1);
    expect(gh.kind).toBe("issues"); // default — a source still skips PRs unless it opts in
    expect(config.belts[0]!.source).toBe("gh");
    expect(config.belts[0]!.label).toBe("factory"); // the belt's trigger/pickup label
  });

  it("github_issues: the documented `review-gh` shape loads — kind: pull_requests + a checkout step", () => {
    setup(
      cfg(
        `  - type: github_issues
    name: gh-prs
    github_issues:
      repo: my-org/my-app
      kind: pull_requests
`,
        `  - name: review-gh
    source: gh-prs
    label: hf-review
    effects: [{ on: enter, step: review, to: in_review }]
    steps:
      - type: custom
        name: checkout
        prompt_file: prompts/pr-checkout.md
        produces: [commits]
      - { type: review }
`,
      ),
      { prompts: { "prompts/pr-checkout.md": "gh pr checkout @@KEY@@" } },
    );
    const { config } = loadConfig("demo");
    expect((config.sources[0]!.cfg as GithubIssuesSourceCfg).kind).toBe("pull_requests");
    expect(config.belts[0]!.label).toBe("hf-review");
    expect(config.belts[0]!.watchPr).toBe(false); // no pr step — the PR already exists; nothing merges it
    // `in_review` is the produce(pull_request) effect, so a belt with no pr step must ask for it.
    expect(config.belts[0]!.effects).toEqual([{ trigger: { on: "enter", step: "review" }, to: "in_review", status: undefined }]);
  });

  it("github_issues: an unknown `kind` is a load error", () => {
    setup(
      cfg(
        `  - type: github_issues
    github_issues: { repo: acme/tracker, kind: pulls }
`,
        SHIP_BELT.replace("source: jira", "source: github_issues"),
      ),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/kind/);
  });

  describe("poll interval resolution", () => {
    it("defaults each source's poll interval to the tick interval (poll every tick)", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT));
      const { config } = loadConfig("demo");
      expect(config.limits.tickIntervalSeconds).toBe(60); // default
      expect(config.sources[0]!.pollIntervalSeconds).toBe(60); // == tick ⇒ unchanged behavior
    });

    it("follows a custom tick interval when neither poll field is set", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT, "repo:\n  path: __REPO__\nlimits: { tick_interval_seconds: 30 }\n"));
      expect(loadConfig("demo").config.sources[0]!.pollIntervalSeconds).toBe(30);
    });

    it("limits.source_poll_interval_seconds is the repo-wide default for every source", () => {
      setup(cfg(`${JIRA_SRC}${LM_SRC}`, SHIP_BELT, "repo:\n  path: __REPO__\nlimits: { source_poll_interval_seconds: 300 }\n"));
      const { config } = loadConfig("demo");
      expect(config.sources.map((s) => s.pollIntervalSeconds)).toEqual([300, 300]);
    });

    it("a per-source poll_interval_seconds overrides the repo default", () => {
      const jiraSlow = `  - type: jira
    poll_interval_seconds: 600
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
      setup(cfg(`${jiraSlow}${LM_SRC}`, SHIP_BELT, "repo:\n  path: __REPO__\nlimits: { source_poll_interval_seconds: 120 }\n"));
      const { config } = loadConfig("demo");
      // jira gets its own 600; the unqualified local_markdown falls back to the repo default 120.
      expect(config.sources.find((s) => s.type === "jira")!.pollIntervalSeconds).toBe(600);
      expect(config.sources.find((s) => s.type === "local_markdown")!.pollIntervalSeconds).toBe(120);
    });

    it("rejects a non-positive poll_interval_seconds", () => {
      const bad = `  - type: jira
    poll_interval_seconds: 0
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
      setup(cfg(bad, SHIP_BELT));
      expect(() => loadConfig("demo")).toThrow();
    });

    it("defaults each source's max_active_workspaces to 2", () => {
      setup(cfg(`${JIRA_SRC}${LM_SRC}`, SHIP_BELT));
      const { config } = loadConfig("demo");
      expect(config.sources.map((s) => s.maxActiveWorkspaces)).toEqual([2, 2]);
    });

    it("a per-source max_active_workspaces overrides the default", () => {
      const jiraWide = `  - type: jira
    max_active_workspaces: 5
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
      setup(cfg(`${jiraWide}${LM_SRC}`, SHIP_BELT));
      const { config } = loadConfig("demo");
      expect(config.sources.find((s) => s.type === "jira")!.maxActiveWorkspaces).toBe(5);
      expect(config.sources.find((s) => s.type === "local_markdown")!.maxActiveWorkspaces).toBe(2);
    });

    it("claim_guard: off by default; enabled resolves host (default hostname) + settle_ms; other source types reject it", () => {
      setup(cfg(`${JIRA_SRC}${LM_SRC}`, SHIP_BELT));
      expect(loadConfig("demo").config.sources.map((s) => s.claimGuard)).toEqual([undefined, undefined]);
      const guarded = `  - type: jira
    claim_guard: { enabled: true, host: contabo }
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
      setup(cfg(`${guarded}${LM_SRC}`, SHIP_BELT));
      // `host` overrides ⇒ this machine's own hostname becomes a read-only alias (legacy ledger lines).
      expect(loadConfig("demo").config.sources[0]!.claimGuard).toEqual({ host: "contabo", settleMs: 2000, hostAliases: [hostname().replace(/[^A-Za-z0-9._-]/g, "-")] });
      setup(cfg(guarded.replace("host: contabo", "settle_ms: 500"), SHIP_BELT));
      expect(loadConfig("demo").config.sources[0]!.claimGuard).toMatchObject({ settleMs: 500, host: expect.stringMatching(/^[A-Za-z0-9._-]+$/) });
      setup(cfg(guarded.replace("host: contabo", "host: 'bad host]'"), SHIP_BELT));
      expect(() => loadConfig("demo")).toThrow(/claim_guard/);
      setup(cfg(`${JIRA_SRC}${LM_SRC.replace("type: local_markdown", "type: local_markdown\n    claim_guard: { enabled: true }")}`, SHIP_BELT));
      expect(() => loadConfig("demo")).toThrow();
    });

    it("source_comments.brand defaults to herdr-factory and rejects marker-breaking values (issue #70)", () => {
      setup(cfg(`${JIRA_SRC}${LM_SRC}`, SHIP_BELT));
      expect(loadConfig("demo").config.sourceComments).toEqual({ brand: "herdr-factory" });
      setup(cfg(`${JIRA_SRC}${LM_SRC}`, SHIP_BELT, "repo:\n  path: __REPO__\nsource_comments: { brand: hf }\n"));
      expect(loadConfig("demo").config.sourceComments).toEqual({ brand: "hf" });
      setup(cfg(`${JIRA_SRC}${LM_SRC}`, SHIP_BELT, "repo:\n  path: __REPO__\nsource_comments: { brand: 'bad brand]' }\n"));
      expect(() => loadConfig("demo")).toThrow(/source_comments\.brand/);
    });

    it("rejects a non-positive max_active_workspaces", () => {
      const bad = `  - type: jira
    max_active_workspaces: 0
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
      setup(cfg(bad, SHIP_BELT));
      expect(() => loadConfig("demo")).toThrow();
    });
  });

  it("github_issues: repo may be omitted (defaults to the PR repo at build time); bad shapes rejected", () => {
    setup(
      cfg(
        `  - type: github_issues
    github_issues: {}
`,
        `  - name: ship
    source: github_issues
    label: herdr
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`,
      ),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect((config.sources[0]!.cfg as GithubIssuesSourceCfg).repo).toBeUndefined();

    setup(
      cfg(
        `  - type: github_issues
    github_issues: { repo: not-a-repo }
`,
        SHIP_BELT.replace("source: jira", "source: github_issues"),
      ),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/owner\/name/);
  });

  it("github_issues: unknown keys in the block are rejected (strict)", () => {
    setup(
      cfg(
        `  - type: github_issues
    github_issues: { repo: acme/tracker, labels: nope }
`,
        SHIP_BELT.replace("source: jira", "source: github_issues"),
      ),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized/);
  });

  it("loads secrets strictly from the per-repo env (a shared global env is ignored)", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} }); // setup writes repos/demo/env: me@x.com / tok
    // A global <configDir>/env must NOT be consulted — secrets are per-repo only.
    writeFileSync(join(process.env.HERDR_FACTORY_CONFIG_DIR!, "env"), "JIRA_EMAIL=global@x.com\nJIRA_API_TOKEN=global-tok\n");
    const { env } = loadConfig("demo");
    expect(env.JIRA_EMAIL).toBe("me@x.com"); // per-repo, not the global
    expect(env.JIRA_API_TOKEN).toBe("tok");
  });

  it("recreates work_to_pull_request byte-identically from primitives (work/evidence/review/pr)", () => {
    // The anchor: the shipped primitives resolve to the historical PR_STEPS shape (fix→work rename).
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,     tab: work,     pane: agent }
      - { type: evidence, tab: evidence, pane: agent }
      - { type: review,   tab: review,   pane: agent }
      - { type: pr,       tab: pr,       pane: agent }
`),
      { prompts: {} },
    );
    const belt = loadConfig("demo").config.belts[0]!;
    expect(belt.watchPr).toBe(true);
    expect(belt.beltType).toBe("work_to_pull_request");
    expect(belt.steps.map((s) => s.name)).toEqual(["work", "evidence", "review", "pr"]);
    expect(belt.steps.map((s) => s.budgetSeconds)).toEqual([5400, 2400, 1800, 3600]);
    expect(belt.steps.map((s) => s.heartbeat)).toEqual([true, false, false, true]);
    expect(belt.steps.map((s) => s.opensPr)).toEqual([false, false, false, true]);
    expect(belt.steps.map((s) => s.gathersEvidence)).toEqual([false, true, false, false]);
    expect(belt.steps.map((s) => s.canBounceTo)).toEqual([[], ["work"], ["work"], []]);
  });

  it("SKIPS the evidence step when it has no tab/pane (work → review → pr) — evidence never self-spawns", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} }); // SHIP_BELT configures no evidence step
    const belt = loadConfig("demo").config.belts[0]!;
    const steps = belt.steps;
    expect(steps.map((s) => s.name)).toEqual(["work", "review", "pr"]); // no evidence step
    const [work, review, pr] = steps;
    expect(work!.tab).toBe("work");
    expect(work!.pane).toBe("agent");
    expect(work!.enginePrompt).toContain("ticket.json"); // shipped jira work prompt (src/prompts/jira/work.md)
    expect(work!.heartbeat).toBe(true);
    expect(work!.opensPr).toBe(false);
    expect(work!.budgetSeconds).toBe(5400); // work descriptor default
    expect(work!.canBounceTo).toEqual([]);
    expect(review!.enginePrompt).toContain("fresh-eyes");
    expect(review!.heartbeat).toBe(false);
    expect(review!.budgetSeconds).toBe(1800);
    expect(review!.canBounceTo).toEqual(["work"]); // review bounces back to work
    expect(pr!.enginePrompt).toContain("push"); // shipped pr prompt
    expect(pr!.opensPr).toBe(true); // only the pr step watches GitHub
    expect(pr!.budgetSeconds).toBe(3600);
    expect(belt.maxBounces).toBeUndefined(); // no per-belt override → falls back to limits.maxBounces
  });

  it("INCLUDES the evidence step only when its tab/pane are set (work → evidence → review → pr)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,     tab: work,     pane: agent }
      - { type: evidence, tab: evidence, pane: agent }
      - { type: review,   tab: review,   pane: agent }
      - { type: pr,       tab: pr,       pane: agent }
`),
      { prompts: {} },
    );
    const steps = loadConfig("demo").config.belts[0]!.steps;
    expect(steps.map((s) => s.name)).toEqual(["work", "evidence", "review", "pr"]);
    const evidence = steps.find((s) => s.name === "evidence")!;
    expect(evidence.tab).toBe("evidence"); // delivers to that pane's existing agent (no self-spawn)
    expect(evidence.pane).toBe("agent");
    expect(evidence.enginePrompt).toContain("Evidence agent"); // src/prompts/evidence.md
    expect(evidence.heartbeat).toBe(false);
    expect(evidence.opensPr).toBe(false);
    expect(evidence.budgetSeconds).toBe(2400); // evidence descriptor default
    expect(evidence.gathersEvidence).toBe(true);
    expect(evidence.readOnly).toBe(true);
    expect(evidence.canBounceTo).toEqual(["work"]);
  });

  it("max_bounces defaults to 6 and a per-belt max_bounces overrides the repo limit", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    max_bounces: 2
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect(config.limits.maxBounces).toBe(6); // raised safety-backstop default
    expect(config.belts[0]!.maxBounces).toBe(2); // per-belt override
  });

  it("a belt on a local_markdown source uses the neutral shared work prompt (no Jira wording)", () => {
    setup(
      cfg(LM_SRC, `  - name: lm-ship
    source: ideas
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    expect(config.sources[0]!.type).toBe("local_markdown");
    expect((config.sources[0]!.cfg as LocalMarkdownSourceCfg).folder).toBe(join(homedir(), "work"));
    const work = config.belts[0]!.steps.find((s) => s.name === "work")!;
    // local_markdown has no per-type work override — the neutral SHARED work prompt (WORK_DOC-based,
    // no Jira wording) covers it, and carries the rework/ask-human guidance.
    expect(work.enginePrompt).toContain("@@WORK_DOC@@");
    expect(work.enginePrompt).not.toContain("Jira");
    expect(work.enginePrompt).toContain("ask-human");
    // review has no per-type override → shared engine prompt
    expect(config.belts[0]!.steps.find((s) => s.name === "review")!.enginePrompt).toContain("fresh-eyes");
  });

  it("a belt on a github_issues source uses the per-type work + pr prompts", () => {
    setup(
      cfg(
        `  - type: github_issues
    github_issues: { repo: acme/tracker }
`,
        `  - name: gh-ship
    source: github_issues
    label: herdr
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`,
      ),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    const steps = config.belts[0]!.steps;
    const work = steps.find((s) => s.name === "work")!;
    expect(work.enginePrompt).toContain("GitHub issue");
    expect(work.enginePrompt).toContain("issue.json");
    const pr = steps.find((s) => s.name === "pr")!;
    expect(pr.enginePrompt).toContain("Closing reference"); // the auto-close linkage mandate
    // review has no per-type override → shared engine prompt
    expect(steps.find((s) => s.name === "review")!.enginePrompt).toContain("fresh-eyes");
  });

  it("a jira belt keeps the Jira-flavored work prompt (under prompts/jira/)", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
    const work = loadConfig("demo").config.belts[0]!.steps.find((s) => s.name === "work")!;
    expect(work.enginePrompt).toContain("Jira ticket");
    expect(work.enginePrompt).toContain("ticket.json");
  });

  it("a config-folder prompt pack (prompts/<slug>.md) overrides the shipped engine base at load", () => {
    // A shared override replaces the shipped review base; a per-source-typed override wins for jira.
    setup(cfg(JIRA_SRC, SHIP_BELT), {
      prompts: { "prompts/review.md": "PACKED review base", "prompts/jira/work.md": "PACKED jira work base" },
    });
    const steps = loadConfig("demo").config.belts[0]!.steps;
    const review = steps.find((s) => s.name === "review")!;
    const work = steps.find((s) => s.name === "work")!;
    expect(review.enginePrompt).toBe("PACKED review base"); // config pack beats shipped
    expect(review.enginePrompt).not.toContain("fresh-eyes"); // the shipped review base is gone
    expect(work.enginePrompt).toBe("PACKED jira work base"); // typed pack beats the shipped jira/work.md
    // pr has no pack file → still the shipped base
    expect(steps.find((s) => s.name === "pr")!.enginePrompt).toContain("push");
  });

  it("resolves a custom belt's user-defined steps (prompt_file body, budget, heartbeat, no PR)", () => {
    setup(
      cfg(LM_SRC, `  - name: work_generation
    source: ideas
    workspace_name: "research/{{work_id}}-{{work_slug}}"
    steps:
      - { type: custom, name: research, tab: research, pane: agent, prompt_file: research.md, prompt_file_source: config }
      - { type: custom, name: create_jira_ticket, prompt_file: create.md, prompt_file_source: repo, budget_seconds: 1200, heartbeat: true }
`),
      { prompts: { "research.md": "Do the research\n" } },
    );
    const belt = loadConfig("demo").config.belts[0]!;
    expect(belt.beltType).toBe("custom"); // no pr step ⇒ display label "custom"
    expect(belt.watchPr).toBe(false);
    expect(belt.workspaceName).toBe("research/{{work_id}}-{{work_slug}}");
    expect(belt.steps.map((s) => s.name)).toEqual(["research", "create_jira_ticket"]);
    const [research, create] = belt.steps;
    // The body is read at RENDER time now — config carries the file reference + source, not the text.
    expect(research!.promptFile).toBe("research.md");
    expect(research!.promptFileSource).toBe("config");
    expect(research!.enginePrompt).toBeUndefined(); // custom steps have no engine base
    expect(research!.tab).toBe("research");
    expect(research!.budgetSeconds).toBe(3600); // default step_budget_seconds (no descriptor default)
    expect(research!.heartbeat).toBe(false); // default off for custom
    expect(research!.opensPr).toBe(false);
    expect(create!.promptFile).toBe("create.md");
    expect(create!.promptFileSource).toBe("repo"); // repo-sourced: not existence-checked at load
    expect(create!.budgetSeconds).toBe(1200); // per-step override
    expect(create!.heartbeat).toBe(true); // opted in
    expect(create!.tab).toBeUndefined(); // no layout → spawns its own pane
  });

  // ── Config-declared capabilities for custom steps (build your own gates). ──
  describe("custom-step capability opt-ins", () => {
    // The acceptance belt: a bespoke read-only + bounce gate wired between work and pr.
    const GATE_BELT = `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work, tab: work, pane: agent }
      - { type: custom, name: security-review, read_only: true, bounce: true, tab: sec, pane: agent, prompt_file: sec.md }
      - { type: pr, tab: pr, pane: agent }
`;

    it("a custom read_only + bounce step resolves to a bespoke review gate (read-only, bounces to work)", () => {
      setup(cfg(JIRA_SRC, GATE_BELT), { prompts: { "sec.md": "Audit @@KEY@@; bounce with @@BOUNCE_CMD@@ if unsafe.\n" } });
      const belt = loadConfig("demo").config.belts[0]!;
      const gate = belt.steps.find((s) => s.name === "security-review")!;
      expect(gate.type).toBe("custom");
      expect(gate.readOnly).toBe(true); // enforced exactly like review/evidence (HEAD movement parks)
      expect(gate.canBounceTo).toEqual(["work"]); // earliest earlier bounce_feedback consumer
      expect(gate.opensPr).toBe(false);
      expect(gate.gathersEvidence).toBe(false);
      expect(gate.enginePrompt).toBeUndefined(); // custom: the prompt_file is the whole body
      expect(gate.posture.readOnly).toBe(true); // posture stays consistent with the derived flag
      expect(belt.watchPr).toBe(true); // the pr step still gives the belt its terminal PR watch
    });

    it("a custom `consumes: [commits]` step is a required consume satisfied by an upstream producer", () => {
      const belt = `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work, tab: work, pane: agent }
      - { type: custom, name: audit, consumes: [commits], read_only: true, tab: a, pane: agent, prompt_file: a.md }
      - { type: pr, tab: pr, pane: agent }
`;
      setup(cfg(JIRA_SRC, belt), { prompts: { "a.md": "Audit the diff.@@WHEN:commits@@ Commits exist.@@END@@\n" } });
      const audit = loadConfig("demo").config.belts[0]!.steps.find((s) => s.name === "audit")!;
      expect(audit.consumes.some((c) => c.type === "commits" && c.required)).toBe(true);
    });

    it("rejects a custom `consumes: [commits]` step with nothing upstream producing commits", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: audit, consumes: [commits], prompt_file: a.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "a.md": "Audit.\n" } });
      expect(() => loadConfig("demo")).toThrow(/requires "commits"/);
    });

    it("a custom `produces: [commits]` step is a code-writing station (produces commits; no PR/evidence; no auto-heartbeat)", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: scaffold, produces: [commits], prompt_file: s.md }
      - { type: custom, name: check, consumes: [commits], read_only: true, prompt_file: c.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "s.md": "Scaffold.\n", "c.md": "Check.\n" } });
      const steps = loadConfig("demo").config.belts[0]!.steps;
      const scaffold = steps.find((s) => s.name === "scaffold")!;
      expect(scaffold.produces).toContain("commits");
      expect(scaffold.opensPr).toBe(false);
      expect(scaffold.gathersEvidence).toBe(false);
      expect(scaffold.heartbeat).toBe(false); // produces:[commits] is NOT the heartbeat opt-in
      // the downstream consume is satisfied by the upstream producer (no dataflow error)
      expect(steps.find((s) => s.name === "check")!.consumes.some((c) => c.type === "commits" && c.required)).toBe(true);
    });

    it("a custom `heartbeat: true` step also produces commits AND attaches the heartbeat guard", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: build, heartbeat: true, prompt_file: b.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "b.md": "Build.\n" } });
      const build = loadConfig("demo").config.belts[0]!.steps[0]!;
      expect(build.produces).toContain("commits");
      expect(build.heartbeat).toBe(true);
      expect(build.guards.some((g) => g.kind === "heartbeat")).toBe(true);
    });

    it("rejects a custom step that is read_only AND produces commits (contradictory)", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: bad, read_only: true, produces: [commits], prompt_file: b.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "b.md": "x\n" } });
      expect(() => loadConfig("demo")).toThrow(/read-only and cannot produce commits/);
    });

    it("rejects a custom read_only step that also opts into heartbeat (heartbeat ⇒ commits)", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: bad, read_only: true, heartbeat: true, prompt_file: b.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "b.md": "x\n" } });
      expect(() => loadConfig("demo")).toThrow(/read-only and cannot produce commits/);
    });

    it("rejects a custom `bounce: true` step with no earlier bounce_feedback consumer", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: gate, bounce: true, prompt_file: g.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "g.md": "x\n" } });
      expect(() => loadConfig("demo")).toThrow(/declares a bounce but no earlier step consumes bounce_feedback/);
    });

    it("a custom `bounce: true` step bounces to an earlier custom step (custom always consumes bounce_feedback)", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: draft, prompt_file: d.md }
      - { type: custom, name: gate, bounce: true, prompt_file: g.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "d.md": "Draft.\n", "g.md": "Gate.\n" } });
      const gate = loadConfig("demo").config.belts[0]!.steps.find((s) => s.name === "gate")!;
      expect(gate.canBounceTo).toEqual(["draft"]);
    });

    it("rejects capability opt-ins on a non-custom step (its capabilities are fixed by the primitive)", () => {
      const belt = `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work, tab: work, pane: agent, read_only: true }
      - { type: review, tab: review, pane: agent }
      - { type: pr, tab: pr, pane: agent }
`;
      setup(cfg(JIRA_SRC, belt), { prompts: {} });
      expect(() => loadConfig("demo")).toThrow(/capability opt-ins are only for/);
    });

    it("rejects a `produces: [pull_request]` opt-in at parse time (allow-list is commits only)", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: opener, produces: [pull_request], prompt_file: o.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "o.md": "x\n" } });
      expect(() => loadConfig("demo")).toThrow();
    });
  });

  describe("belt-level pr: behavior block", () => {
    const PR_BELT = `  - name: ship
    source: jira
    label: agent
    pr:
      draft: true
      title: "[{{semantic_work_prefix}}] {{work_id}} {{work_slug}}"
      labels: [needs-review, auto]
      reviewers: [octocat]
      assignees: [me]
      automated_round_minutes: 20
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`;

    it("parses + resolves onto BeltConfig.pr (camelCased) on a belt with a pr step", () => {
      setup(cfg(JIRA_SRC, PR_BELT), { prompts: {} });
      const pr = loadConfig("demo").config.belts[0]!.pr!;
      expect(pr.draft).toBe(true);
      expect(pr.title).toBe("[{{semantic_work_prefix}}] {{work_id}} {{work_slug}}");
      expect(pr.labels).toEqual(["needs-review", "auto"]);
      expect(pr.reviewers).toEqual(["octocat"]);
      expect(pr.assignees).toEqual(["me"]);
      expect(pr.automatedRoundMinutes).toBe(20);
    });

    it("is undefined when the belt sets no pr: block (default = today's behavior)", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
      expect(loadConfig("demo").config.belts[0]!.pr).toBeUndefined();
    });

    it("accepts automated_round_minutes: 0 (skip the round)", () => {
      const belt = `  - name: ship
    source: jira
    label: agent
    pr: { automated_round_minutes: 0 }
    steps: [{ type: work, tab: w, pane: a }, { type: review, tab: r, pane: a }, { type: pr, tab: p, pane: a }]
`;
      setup(cfg(JIRA_SRC, belt), { prompts: {} });
      expect(loadConfig("demo").config.belts[0]!.pr!.automatedRoundMinutes).toBe(0);
    });

    it("rejects a pr: block on a belt with no pr step (it would silently no-op)", () => {
      const belt = `  - name: gen
    source: ideas
    pr: { draft: true }
    steps:
      - { type: custom, name: research, prompt_file: r.md }
`;
      setup(cfg(LM_SRC, belt), { prompts: { "r.md": "Research.\n" } });
      expect(() => loadConfig("demo")).toThrow(/sets a `pr:` behavior block but has no step that opens a pull request/);
    });

    it("rejects a negative automated_round_minutes at parse (schema)", () => {
      const belt = `  - name: ship
    source: jira
    label: agent
    pr: { automated_round_minutes: -5 }
    steps: [{ type: work, tab: w, pane: a }, { type: review, tab: r, pane: a }, { type: pr, tab: p, pane: a }]
`;
      setup(cfg(JIRA_SRC, belt), { prompts: {} });
      expect(() => loadConfig("demo")).toThrow();
    });
  });

  it("defaults a step's name to its type when omitted", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
    const names = loadConfig("demo").config.belts[0]!.steps.map((s) => s.name);
    expect(names).toEqual(["work", "review", "pr"]); // names default to the step `type`
  });

  it("defaults prompt_file_source to `config` when a step sets a prompt_file without one (onboarding friction)", () => {
    setup(
      cfg(LM_SRC, `  - name: work_generation
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: research.md }
`),
      { prompts: { "research.md": "Do the research\n" } },
    );
    const research = loadConfig("demo").config.belts[0]!.steps[0]!;
    expect(research.promptFile).toBe("research.md");
    expect(research.promptFileSource).toBe("config"); // defaulted — no longer has to be spelled out
  });

  it("leaves promptFileSource undefined on a step with no prompt_file (the `config` default is inert)", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
    const work = loadConfig("demo").config.belts[0]!.steps[0]!;
    expect(work.promptFile).toBeUndefined();
    expect(work.promptFileSource).toBeUndefined(); // present iff there's a prompt_file
    expect(work.promptMode).toBeUndefined(); // ditto — `augment` default is inert without a prompt_file
  });

  it("resolves prompt_mode: replace on an engine-prompted step with a prompt_file", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,   tab: work,   pane: agent, prompt_file: work.md, prompt_mode: replace }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: { "work.md": "OWN THE WHOLE WORK BODY\n" } },
    );
    const work = loadConfig("demo").config.belts[0]!.steps[0]!;
    expect(work.promptFile).toBe("work.md");
    expect(work.promptMode).toBe("replace");
    expect(work.enginePrompt).toBeDefined(); // the base is still carried; step.ts drops it at render
  });

  it("defaults prompt_mode to `augment` when a step sets a prompt_file without one", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,   tab: work,   pane: agent, prompt_file: work.md }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: { "work.md": "extra instructions\n" } },
    );
    const work = loadConfig("demo").config.belts[0]!.steps[0]!;
    expect(work.promptMode).toBe("augment");
  });

  // ── Prompt-contract validation of a config-sourced prompt_file (see docs/PROMPTS.md). ──
  describe("prompt_file contract validation at load", () => {
    const CUSTOM_BELT = (prompt = "research.md") => `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: ${prompt} }
`;
    // A work step whose prompt_file augments the engine base, in a work→review→pr belt (no evidence).
    const WORK_AUGMENT = `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,   tab: work,   pane: agent, prompt_file: notes.md }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`;

    it("accepts a config-sourced prompt using only universal tokens", () => {
      setup(cfg(LM_SRC, CUSTOM_BELT()), { prompts: { "research.md": "Work @@KEY@@ on @@BRANCH@@; write @@HANDOFF_OUT@@.\n" } });
      expect(() => loadConfig("demo")).not.toThrow();
    });

    it("rejects an unknown token, naming the belt/step/file", () => {
      setup(cfg(LM_SRC, CUSTOM_BELT()), { prompts: { "research.md": "Do @@NONSENSE@@.\n" } });
      expect(() => loadConfig("demo")).toThrow(/prompt contract/);
      expect(() => loadConfig("demo")).toThrow(/@@NONSENSE@@/);
      expect(() => loadConfig("demo")).toThrow(/belt "gen" step "research"/);
    });

    it("rejects an evidence token in a belt where evidence is inactive (out of scope)", () => {
      setup(cfg(LM_SRC, CUSTOM_BELT()), { prompts: { "research.md": "See @@EVIDENCE_DIR@@.\n" } });
      expect(() => loadConfig("demo")).toThrow(/@@EVIDENCE_DIR@@/);
    });

    it("rejects a malformed @@WHEN@@ clause", () => {
      setup(cfg(LM_SRC, CUSTOM_BELT()), { prompts: { "research.md": "@@WHEN@@ x @@END@@\n" } });
      expect(() => loadConfig("demo")).toThrow(/malformed|prompt contract/);
    });

    it("validates a work step's augment against the engine base's belt dataflow", () => {
      setup(cfg(JIRA_SRC, WORK_AUGMENT), { prompts: { "notes.md": "Extra: reconcile @@EVIDENCE_DIR@@.\n" } });
      expect(() => loadConfig("demo")).toThrow(/@@EVIDENCE_DIR@@/); // no evidence step ⇒ token out of scope
    });

    it("accepts an evidence token wrapped in @@WHEN:evidence@@ even in a no-evidence belt (clause is dropped)", () => {
      setup(cfg(LM_SRC, CUSTOM_BELT()), { prompts: { "research.md": "Impl.@@WHEN:evidence@@ See @@EVIDENCE_DIR@@.@@END@@\n" } });
      expect(() => loadConfig("demo")).not.toThrow();
    });

    it("does NOT validate a repo-sourced prompt at load (read from the worktree at render time)", () => {
      const belt = `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: research.md, prompt_file_source: repo }
`;
      // A repo-sourced prompt isn't read (or existence-checked) at load, so even a bogus token loads —
      // it's validated when the step is dispatched from the worktree.
      setup(cfg(LM_SRC, belt), { prompts: {} });
      expect(() => loadConfig("demo")).not.toThrow();
    });
  });

  it("loads a belt's match file path (existence verified, fn loaded later in buildDeps)", () => {
    const { repoDir } = setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    match: match.ts
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: { "match.ts": "export default () => true;\n" } },
    );
    expect(loadConfig("demo").config.belts[0]!.matchFile).toBe(join(repoDir, "match.ts"));
  });

  it("throws when a belt's match file is missing on disk", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    match: nope.ts
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/match not found/);
  });

  it("sorts belts by priority (ties keep config order)", () => {
    setup(
      cfg(`${JIRA_SRC}${LM_SRC}`, `  - name: low
    source: ideas
    priority: 5
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
  - name: high
    source: jira
    label: agent
    priority: 1
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    const belts = loadConfig("demo").config.belts;
    expect(belts.map((b) => b.name)).toEqual(["high", "low"]); // priority 1 before 5
    expect(belts[0]!.priority).toBe(1);
  });

  it("rejects duplicate (resolved) source names — two unnamed jira sources collide on 'jira'", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, project: A, board: 1 }
  - type: jira
    jira: { base_url: https://y.atlassian.net, project: B, board: 2 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate work source name/);
  });

  it("rejects a blank source name", () => {
    setup(
      cfg(`  - type: jira
    name: ""
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a belt referencing an unknown work source", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: nonexistent
    steps:
      - { type: work,   tab: work,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/unknown work source/);
  });

  it("rejects duplicate belt names", () => {
    setup(
      cfg(JIRA_SRC, `  - name: dup
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
  - name: dup
    source: jira
    label: agent2
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate belt name/);
  });

  it("rejects a belt on a label-driven source that sets no label (there is no default)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/there is no default/);
  });

  it("rejects a `label` on a belt whose source has no label concept (local_markdown)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    label: whatever
    steps:
      - { type: custom, name: research, prompt_file: r.md, prompt_file_source: config }
`),
      { prompts: { "r.md": "r\n" } },
    );
    expect(() => loadConfig("demo")).toThrow(/no label concept/);
  });

  it("loads a sentry source — no pickup label (belts route by match/priority) — with resolved defaults", () => {
    setup(
      cfg(SENTRY_SRC, `  - name: fix-errors
    source: sentry
    steps: [{ type: work }, { type: review }, { type: pr }]
`),
      { prompts: {} },
    );
    const { config } = loadConfig("demo");
    const src = config.sources[0]!;
    expect(src.type).toBe("sentry");
    expect(src.name).toBe("sentry"); // default name = type
    const scfg = src.cfg as SentrySourceCfg;
    expect(scfg.organization).toBe("acme");
    expect(scfg.projects).toEqual(["backend"]);
    expect(scfg.environment).toEqual(["production"]); // single string normalized to a list
    expect(scfg.query).toBe("is:unresolved level:error");
    expect(scfg.baseUrl).toBe("https://sentry.io"); // default
    expect(scfg.statsPeriod).toBe("14d"); // default
    expect(scfg.onMerge).toBe("comment"); // default
    expect(config.belts[0]!.label).toBeUndefined(); // label-less, like local_markdown
  });

  it("rejects a `label` on a belt whose source is sentry (no label concept)", () => {
    setup(
      cfg(SENTRY_SRC, `  - name: fix-errors
    source: sentry
    label: nope
    steps: [{ type: work }, { type: review }, { type: pr }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/no label concept/);
  });

  it("rejects two belts that pick up the same source by the same label (contention)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: a
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
  - name: b
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/contend for the same items/);
  });

  it("allows ONE source split across belts by DISTINCT labels", () => {
    setup(
      cfg(JIRA_SRC, `  - name: bugs
    source: jira
    label: agent-bug
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
  - name: chores
    source: jira
    label: agent-chore
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.belts.map((b) => b.label)).toEqual(["agent-bug", "agent-chore"]);
  });

  it("rejects two steps of one belt targeting the same layout pane (the first dispatch renames it away)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: work, pane: agent }, { type: pr }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/target the same layout pane/);
  });

  it("allows two belts to reuse the same tab/pane labels (each run gets its own workspace)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: bugs
    source: jira
    label: agent-bug
    steps: [{ type: work, tab: work, pane: agent }, { type: pr }]
  - name: chores
    source: jira
    label: agent-chore
    steps: [{ type: work, tab: work, pane: agent }, { type: pr }]
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.belts.length).toBe(2);
  });

  it("rejects a belt with duplicate step names (name defaults to type — collide on two customs)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: a.md, prompt_file_source: config }
      - { type: custom, name: research, prompt_file: b.md, prompt_file_source: config }
`),
      { prompts: { "a.md": "a\n", "b.md": "b\n" } },
    );
    expect(() => loadConfig("demo")).toThrow(/duplicate step name/);
  });

  it("rejects a belt step with an invalid (non-slug) name", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: "Bad Name", prompt_file: a.md, prompt_file_source: config }
`),
      { prompts: { "a.md": "a\n" } },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a belt step referencing an unknown step type", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: teleport, tab: t, pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a custom step with no prompt_file (it has no built-in prompt)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/needs a prompt_file/);
  });

  it("rejects prompt_mode: replace with no prompt_file (nothing to replace with)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work,   tab: work,   pane: agent, prompt_mode: replace }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/prompt_mode: replace but has no prompt_file/);
  });

  it("rejects prompt_mode: replace on a custom step (no built-in prompt to replace)", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: research.md, prompt_mode: replace }
`),
      { prompts: { "research.md": "the whole body\n" } },
    );
    expect(() => loadConfig("demo")).toThrow(/has no built-in prompt to replace/);
  });

  it("rejects a belt whose required dataflow is unsatisfied (review with no upstream commits)", () => {
    // review requires `commits`; with no earlier work/pr step nothing produces them.
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: review, tab: review, pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/requires "commits"/);
  });

  it("throws when a custom belt step's prompt_file is missing on disk", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps:
      - { type: custom, name: research, prompt_file: missing.md, prompt_file_source: config }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/prompt_file.*not found/);
  });

  it("rejects a belt with no steps", () => {
    setup(
      cfg(LM_SRC, `  - name: gen
    source: ideas
    steps: []
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a belt with no steps key at all", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a stray `belt_type` key (removed in the clean break)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    belt_type: work_to_pull_request
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized|belt_type/i);
  });

  it("rejects a stray `agents` block (removed in the clean break)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
    agents: { fix: { tab: fix, pane: agent } }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized|agents/i);
  });

  it("rejects a step with tab but no pane (must be set together)", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work, tab: work }
      - { type: review, tab: review, pane: agent }
      - { type: pr, tab: pr, pane: agent }
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects an empty work_sources list", () => {
    setup("repo:\n  path: __REPO__\nwork_sources: []\nbelt: []\n", { prompts: {} });
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects an empty belt list", () => {
    setup(`repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt: []\n`, { prompts: {} });
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a jira source missing project", () => {
    setup(
      cfg(`  - type: jira
    jira: { base_url: https://x.atlassian.net, board: 1 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a jira source missing base_url", () => {
    setup(
      cfg(`  - type: jira
    jira: { project: RWR, board: 254 }
`, SHIP_BELT),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a local_markdown source missing its folder", () => {
    setup(
      cfg(`  - type: local_markdown
    name: ideas
    local_markdown: {}
`, `  - name: ship
    source: ideas
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a missing repo config", () => {
    setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
    expect(() => loadConfig("nope")).toThrow(/no config for repo/);
  });

  it("resolves the evidence block incl. the optional github_username override (+ trims key_prefix, normalizes cloudfront)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  bucket: my-bucket
  region: us-east-1
  cloudfront_domain: https://d1.cloudfront.net/
  key_prefix: /sub/
  github_username: alice
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    expect(ev.publisher).toBe("s3"); // default discriminant — a block with no `publisher:` key is s3
    if (ev.publisher !== "s3") throw new Error("expected s3 publisher");
    expect(ev.bucket).toBe("my-bucket");
    expect(ev.cloudfrontDomain).toBe("d1.cloudfront.net"); // scheme + trailing slash stripped
    expect(ev.keyPrefix).toBe("sub"); // leading/trailing slashes trimmed
    expect(ev.githubUsername).toBe("alice");
  });

  it("leaves githubUsername undefined when the evidence block omits it (derived from gh at upload time)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  bucket: my-bucket
  region: us-east-1
  cloudfront_domain: d1.cloudfront.net
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    expect(ev.githubUsername).toBeUndefined();
    expect(ev.keyPrefix).toBe(""); // default
  });

  it("resolves a `local` publisher (public_base_url trimmed; shared key_prefix/github_username)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  publisher: local
  public_base_url: http://box.tailnet.ts.net:8765/
  key_prefix: /app/
  github_username: alice
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    expect(ev.publisher).toBe("local");
    if (ev.publisher !== "local") throw new Error("expected local");
    expect(ev.publicBaseUrl).toBe("http://box.tailnet.ts.net:8765"); // trailing slash stripped
    expect(ev.keyPrefix).toBe("app");
    expect(ev.githubUsername).toBe("alice");
  });

  it("resolves a `command` publisher (string → argv; timeout default)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  publisher: command
  command: ./publish-evidence.sh
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    expect(ev.publisher).toBe("command");
    if (ev.publisher !== "command") throw new Error("expected command");
    expect(ev.command).toEqual(["./publish-evidence.sh"]); // string normalized to a one-element argv
    expect(ev.timeoutSeconds).toBe(300); // default
    expect(ev.publicBaseUrl).toBeUndefined(); // unset ⇒ inline publish, URLs from stdout (unchanged)
  });

  it("resolves a `command` publisher's optional public_base_url (the background-upload opt-in)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  publisher: command
  command: ./publish-evidence.sh
  public_base_url: https://evidence.example.test/
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    if (ev.publisher !== "command") throw new Error("expected command");
    expect(ev.publicBaseUrl).toBe("https://evidence.example.test"); // trailing slash stripped
  });

  it("resolves a `command` publisher with an argv array + explicit timeout", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  publisher: command
  command: [gcs-upload, --bucket, evidence]
  timeout_seconds: 120
`,
      { prompts: {} },
    );
    const ev = loadConfig("demo").config.evidence!;
    if (ev.publisher !== "command") throw new Error("expected command");
    expect(ev.command).toEqual(["gcs-upload", "--bucket", "evidence"]);
    expect(ev.timeoutSeconds).toBe(120);
  });

  it("rejects an s3-only field on a `local` block (discriminated-union strictness)", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  publisher: local
  bucket: nope
`,
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("rejects a `command` block with no command", () => {
    setup(
      `repo:\n  path: __REPO__\nwork_sources:\n${JIRA_SRC}belt:\n${SHIP_BELT}evidence:
  publisher: command
`,
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow();
  });

  it("maps a per-belt workspace_name through", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    workspace_name: "fix/{{work_id}}-{{work_slug}}"
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(loadConfig("demo").config.belts[0]!.workspaceName).toBe("fix/{{work_id}}-{{work_slug}}");
  });

  it("rejects a workspace_name template missing {{work_id}}", () => {
    setup(
      cfg(JIRA_SRC, `  - name: ship
    source: jira
    label: agent
    workspace_name: "fix/{{work_slug}}"
    steps: [{ type: work, tab: work, pane: agent }, { type: review, tab: review, pane: agent }, { type: pr, tab: pr, pane: agent }]
`),
      { prompts: {} },
    );
    expect(() => loadConfig("demo")).toThrow(/work_id/);
  });

  describe("branch: taxonomy block", () => {
    // A repo-level branch block goes in the config `head` (before work_sources/belt).
    const headWithBranch = (body: string) => `repo:\n  path: __REPO__\nbranch:\n${body}`;

    it("resolves a repo-level prefix map + slug caps onto BeltConfig.branch (default key split out)", () => {
      const head = headWithBranch("  prefixes: { story: feat, default: chore }\n  slug_max: 30\n  full_slug_max: 80\n");
      setup(cfg(JIRA_SRC, SHIP_BELT, head), { prompts: {} });
      const branch = loadConfig("demo").config.belts[0]!.branch!;
      expect(branch.prefixes).toEqual({ story: "feat" }); // `default` split out of the map
      expect(branch.default).toBe("chore");
      expect(branch.slugMax).toBe(30);
      expect(branch.fullSlugMax).toBe(80);
    });

    it("defaults to the historical taxonomy when no branch block is set anywhere", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
      expect(loadConfig("demo").config.belts[0]!.branch).toEqual(DEFAULT_BRANCH_TAXONOMY);
    });

    it("an omitted `default` key falls back to the built-in default prefix", () => {
      const head = headWithBranch("  prefixes: { story: feat }\n");
      setup(cfg(JIRA_SRC, SHIP_BELT, head), { prompts: {} });
      const branch = loadConfig("demo").config.belts[0]!.branch!;
      expect(branch.prefixes).toEqual({ story: "feat" });
      expect(branch.default).toBe("feature"); // built-in fallback
    });

    it("resolves field-by-field: a belt's prefixes REPLACE the repo's; each slug cap overrides independently", () => {
      const head = headWithBranch("  prefixes: { story: feat }\n  slug_max: 30\n  full_slug_max: 80\n");
      const belt = `  - name: ship
    source: jira
    label: agent
    branch:
      prefixes: { bug: hotfix }
      slug_max: 10
    steps: [{ type: work, tab: w, pane: a }, { type: review, tab: r, pane: a }, { type: pr, tab: p, pane: a }]
`;
      setup(cfg(JIRA_SRC, belt, head), { prompts: {} });
      const branch = loadConfig("demo").config.belts[0]!.branch!;
      expect(branch.prefixes).toEqual({ bug: "hotfix" }); // belt map fully replaces the repo's
      expect(branch.default).toBe("feature"); // belt map has no `default` → built-in
      expect(branch.slugMax).toBe(10); // belt override
      expect(branch.fullSlugMax).toBe(80); // repo value survives (field-level resolution)
    });

    it("acceptance: a repo `story → feat` mapping yields feat/… branch names; unmapped types use the default", () => {
      const head = headWithBranch("  prefixes: { story: feat, default: chore }\n");
      setup(cfg(JIRA_SRC, SHIP_BELT, head), { prompts: {} });
      const belt = loadConfig("demo").config.belts[0]!;
      // Wire the resolved taxonomy through branchName exactly as reconcile.claimImpl does.
      expect(branchName("RWR-5", "Story", "add a thing", belt.workspaceName, undefined, belt.branch)).toBe("feat/RWR-5-add-a-thing");
      expect(branchName("RWR-6", "Bug", "boom", belt.workspaceName, undefined, belt.branch)).toBe("chore/RWR-6-boom");
    });

    it("rejects a non-positive slug cap", () => {
      const head = headWithBranch("  slug_max: 0\n");
      setup(cfg(JIRA_SRC, SHIP_BELT, head), { prompts: {} });
      expect(() => loadConfig("demo")).toThrow();
    });

    it("rejects an unknown key in the branch block (strict)", () => {
      const head = headWithBranch("  nope: true\n");
      setup(cfg(JIRA_SRC, SHIP_BELT, head), { prompts: {} });
      expect(() => loadConfig("demo")).toThrow();
    });
  });

  describe("agent: harness block", () => {
    // A repo-level agent block goes in the config `head` (before work_sources/belt).
    const headWithAgent = (body: string) => `repo:\n  path: __REPO__\nagent:\n${body}`;

    it("defaults every step + the repo to DEFAULT_AGENT_CONFIG when no agent block is set anywhere", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT), { prompts: {} });
      const { config } = loadConfig("demo");
      expect(config.agent).toEqual(DEFAULT_AGENT_CONFIG); // claude --dangerously-skip-permissions
      for (const step of config.belts[0]!.steps) expect(step.agent).toEqual(DEFAULT_AGENT_CONFIG);
    });

    it("resolves a repo-level command onto config.agent and every step (flags default to [])", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT, headWithAgent("  command: opencode\n")), { prompts: {} });
      const { config } = loadConfig("demo");
      // A new command drops the historical claude flags — flags are command-specific.
      expect(config.agent).toEqual({ command: "opencode", flags: [] });
      for (const step of config.belts[0]!.steps) expect(step.agent).toEqual({ command: "opencode", flags: [] });
    });

    it("keeps command=claude but lets flags be overridden at the repo level", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT, headWithAgent("  flags: [--verbose]\n")), { prompts: {} });
      // command omitted ⇒ defaults to claude; flags come from the block verbatim.
      expect(loadConfig("demo").config.agent).toEqual({ command: "claude", flags: ["--verbose"] });
    });

    it("resolves a belt-level agent over the repo (whole-unit, not merged)", () => {
      const head = headWithAgent("  command: opencode\n  flags: [--sandbox]\n");
      const belt = `  - name: ship
    source: jira
    label: agent
    agent: { command: codex }
    steps: [{ type: work, tab: w, pane: a }, { type: review, tab: r, pane: a }, { type: pr, tab: p, pane: a }]
`;
      setup(cfg(JIRA_SRC, belt, head), { prompts: {} });
      const { config } = loadConfig("demo");
      // The belt block replaces the repo's WHOLE agent — codex does NOT inherit --sandbox.
      for (const step of config.belts[0]!.steps) expect(step.agent).toEqual({ command: "codex", flags: [] });
      // The repo-level fallback (config.agent) still reflects the repo block.
      expect(config.agent).toEqual({ command: "opencode", flags: ["--sandbox"] });
    });

    it("resolves a step-level agent over the belt and repo", () => {
      const head = headWithAgent("  command: opencode\n");
      const belt = `  - name: ship
    source: jira
    label: agent
    agent: { command: codex }
    steps:
      - { type: work, tab: w, pane: a, agent: { command: pi, flags: [--fast] } }
      - { type: review, tab: r, pane: a }
      - { type: pr, tab: p, pane: a }
`;
      setup(cfg(JIRA_SRC, belt, head), { prompts: {} });
      const steps = loadConfig("demo").config.belts[0]!.steps;
      expect(steps.find((s) => s.name === "work")!.agent).toEqual({ command: "pi", flags: ["--fast"] }); // step wins
      expect(steps.find((s) => s.name === "review")!.agent).toEqual({ command: "codex", flags: [] }); // belt wins
      expect(steps.find((s) => s.name === "pr")!.agent).toEqual({ command: "codex", flags: [] }); // belt wins
    });

    it("rejects an unknown key in the agent block (strict)", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT, headWithAgent("  nope: true\n")), { prompts: {} });
      expect(() => loadConfig("demo")).toThrow(/[Uu]nrecognized/);
    });

    it("rejects an empty command (min length)", () => {
      setup(cfg(JIRA_SRC, SHIP_BELT, headWithAgent('  command: ""\n')), { prompts: {} });
      expect(() => loadConfig("demo")).toThrow();
    });
  });
});

describe("configJsonSchema", () => {
  it("generates a JSON Schema for config.yml editor validation, derived from the zod schema", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const js = configJsonSchema() as any;
    expect(String(js.$schema)).toContain("json-schema.org");
    expect(js.required).toEqual(expect.arrayContaining(["repo", "work_sources", "belt"]));
    // A belt is now one ordered steps[] list (no belt_type discriminated union). The step `type`
    // enum is generated from the step-primitive registry.
    const step = js.properties.belt.items.properties.steps.items;
    expect([...step.properties.type.enum].sort()).toEqual(["custom", "evidence", "pr", "review", "work"]);
    // the step-name slug regex survives into the schema
    expect(step.properties.name.pattern).toBeTruthy();
    // .strict() → additionalProperties:false, so editors flag unknown keys (a stray step key, or the
    // removed belt_type/agents on a belt).
    expect(step.additionalProperties).toBe(false);
    expect(js.properties.belt.items.additionalProperties).toBe(false);
  });

  it("the committed repo-root config.schema.json is in sync (the example's modeline resolves to it)", () => {
    // examples/example-repo/config.yml's `# yaml-language-server: $schema=../../config.schema.json`
    // resolves to <repo>/config.schema.json when edited in-repo — so it must be committed + current.
    const repoRoot = fileURLToPath(new URL("../", import.meta.url)); // test/ → repo root
    const committed = JSON.parse(readFileSync(join(repoRoot, "config.schema.json"), "utf8"));
    expect(committed, "config.schema.json is stale — regenerate with `npm run schema`").toEqual(configJsonSchema());
  });
});

describe("evidenceKeyPrefix", () => {
  it("builds herdr-factory / user / key_prefix / ticket / run-stamp, dropping empty segments", () => {
    expect(evidenceKeyPrefix({ githubUsername: "alice", keyPrefix: "proj", ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/alice/proj/RWR-1/5-T");
    expect(evidenceKeyPrefix({ keyPrefix: "proj", ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/proj/RWR-1/5-T"); // no username
    expect(evidenceKeyPrefix({ githubUsername: "alice", ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/alice/RWR-1/5-T"); // no key_prefix
    expect(evidenceKeyPrefix({ ticketKey: "RWR-1", runId: 5, stamp: "T" })).toBe("herdr-factory/RWR-1/5-T"); // neither → base only
  });
});

describe("expandHome", () => {
  it("expands leading ~ and $HOME, leaves absolute paths untouched", () => {
    const home = homedir();
    expect(expandHome("~/dev/x")).toBe(join(home, "dev/x"));
    expect(expandHome("~")).toBe(home);
    expect(expandHome("$HOME/dev/x")).toBe(`${home}/dev/x`);
    expect(expandHome("${HOME}/dev/x")).toBe(`${home}/dev/x`);
    expect(expandHome("/already/absolute")).toBe("/already/absolute");
    expect(expandHome("$HOMEWORK/x")).toBe("$HOMEWORK/x"); // not a HOME match
  });
});

describe("loadConfig — layouts (workspace-manager port)", () => {
  const WS = `  - type: jira
    jira: { base_url: https://x.atlassian.net, project: RWR, board: 254 }
`;
  // A belt that selects layouts: hotfix/* → hot, else the web default.
  const BELT = `  - name: ship
    source: jira
    label: agent
    default_layout: web
    layout_matching:
      - { worktree_pattern: "hotfix/*", layout: hot }
    steps:
      - { type: work,   tab: main,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`;
  // A belt referencing only the `web` layout (for tests whose layout library omits `hot`).
  const BELT_WEB_ONLY = `  - name: ship
    source: jira
    label: agent
    default_layout: web
    steps:
      - { type: work,   tab: main,   pane: agent }
      - { type: review, tab: review, pane: agent }
      - { type: pr,     tab: pr,     pane: agent }
`;
  // A belt whose steps target NO panes — for layout-SCHEMA tests whose deliberately-broken layouts
  // would otherwise also trip the step→pane allocation check and drown the assertion. It must NOT
  // declare `default_layout`: such a belt is itself rejected at load (its first step's dedicated pane
  // would stop the layout from ever being built), and that refusal is a superRefine issue — which
  // aborts before the resolution stage where sizes/splits are normalized, masking these assertions.
  const BELT_NO_PANES = `  - name: ship
    source: jira
    label: agent
    steps:
      - { type: work }
      - { type: review }
      - { type: pr }
`;
  // The `web` layout provides every pane the BELT's steps target (the load-time allocation check
  // rejects a config whose default layout doesn't); `hot` is a deliberately-minimal layout for
  // hand-created hotfix worktrees — layout_matching targets are exempt from the allocation check.
  const LAYOUTS = `  - id: web
    setup: { command: pnpm i, blocking: true }
    tabs:
      - title: main
        panes:
          - { title: agent,  command: claude,  setup: true }
          - { title: editor, command: nvim, split: vertical, size: "30%" }
      - title: review
        panes:
          - { title: agent, command: claude }
      - title: pr
        panes:
          - { title: agent, command: claude }
      - title: dev
        panes:
          - { title: server, command: pnpm dev, size: 0.5 }
          - { title: logs, split: horizontal, size: 40 }
  - id: hot
    tabs:
      - panes:
          - { command: claude }
`;
  const full = (belt = BELT, layouts = LAYOUTS) =>
    `repo:\n  path: __REPO__\nwork_sources:\n${WS}belt:\n${belt}layouts:\n${layouts}`;

  it("parses + normalizes the layout library and per-belt selection", () => {
    setup(full());
    const { config } = loadConfig("demo");
    expect(config.layouts.map((l) => l.id)).toEqual(["web", "hot"]);
    const web = config.layouts[0]!;
    expect(web.setup).toEqual({ command: "pnpm i", blocking: true });
    // vertical → right; "30%" → { percent: 30 }
    expect(web.tabs[0]!.panes[1]!.split).toBe("right");
    expect(web.tabs[0]!.panes[1]!.size).toEqual({ percent: 30 });
    // 0.5 fraction → percent 50; horizontal → down; 40 → cells (the `dev` tab — index 3 after the
    // review/pr tabs the allocation check requires the fixture to define)
    expect(web.tabs[3]!.panes[0]!.size).toEqual({ percent: 50 });
    expect(web.tabs[3]!.panes[1]!.split).toBe("down");
    expect(web.tabs[3]!.panes[1]!.size).toEqual({ cells: 40 });
    const belt = config.belts[0]!;
    expect(belt.defaultLayout).toBe("web");
    expect(belt.layoutMatching).toEqual([{ worktreePattern: "hotfix/*", layout: "hot" }]);
  });

  it("rejects duplicate layout ids", () => {
    setup(full(BELT, `${LAYOUTS}  - id: web\n    tabs:\n      - panes:\n          - { command: x }\n`));
    expect(() => loadConfig("demo")).toThrow(/duplicate layout id "web"/);
  });

  it("rejects a belt default_layout that isn't a defined layout", () => {
    setup(full(BELT.replace("default_layout: web", "default_layout: ghost")));
    expect(() => loadConfig("demo")).toThrow(/default_layout "ghost" is not a defined layout/);
  });

  it("rejects a layout_matching rule referencing an unknown layout", () => {
    setup(full(BELT.replace("layout: hot", "layout: ghost")));
    expect(() => loadConfig("demo")).toThrow(/references unknown layout "ghost"/);
  });

  it("rejects a pane that sets both ratio and size", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { command: a }\n          - { split: right, ratio: 0.5, size: "30%" }\n`;
    setup(full(BELT_NO_PANES, bad));
    expect(() => loadConfig("demo")).toThrow(/either ratio or size/);
  });

  it("rejects more than one setup pane in a layout", () => {
    const bad = `  - id: web\n    setup: { command: x }\n    tabs:\n      - panes:\n          - { command: a, setup: true }\n          - { command: b, setup: true, split: right }\n`;
    setup(full(BELT_NO_PANES, bad));
    expect(() => loadConfig("demo")).toThrow(/at most one pane/);
  });

  it("rejects an out-of-range percentage size", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { command: a }\n          - { split: right, size: "150%" }\n`;
    setup(full(BELT_NO_PANES, bad));
    expect(() => loadConfig("demo")).toThrow(/between 0% and 100%/);
  });

  // ── step → layout-pane allocation (validated at load, not discovered as a runtime park) ──
  it("rejects a step targeting a pane its belt's default layout does not define, naming the available panes", () => {
    // The staging-cherry-pick incident: `pane: work` where the layout defines `agent` — this used
    // to surface only at runtime, as a layout-wait park after four full wait windows.
    setup(full(BELT_WEB_ONLY.replace("tab: main,   pane: agent", "tab: main,   pane: work")));
    expect(() => loadConfig("demo")).toThrow(/step "work" targets pane main\/work, but layout "web" does not define it — its labeled panes are: main\/agent, main\/editor, review\/agent/);
  });

  it("a layout_matching rule's layout is EXEMPT from the allocation check (it may serve hand-made worktrees)", () => {
    // BELT routes hotfix/* to the minimal `hot` layout, which defines none of the step panes —
    // that must stay legal (factory claims never produce hotfix/* branches; humans do).
    setup(full());
    expect(() => loadConfig("demo")).not.toThrow();
  });

  // ── the FIRST step decides whether the layout is ever built ────────────────────────────────────
  it("rejects a default_layout belt whose FIRST step has no tab/pane (its dedicated pane's tab kills the layout build)", () => {
    // Measured, not theorised: the dedicated spawn is one socket call from the running engine, the
    // layout hook is an out-of-process command that needs ~300-400ms to boot, so the hook's freshness
    // gate always sees 2 tabs and declines — after which every layout-targeted step parks.
    setup(full(BELT_WEB_ONLY.replace("      - { type: work,   tab: main,   pane: agent }\n", "      - { type: work }\n")));
    expect(() => loadConfig("demo")).toThrow(
      /belt "ship" sets default_layout "web", but its first step "work" has no `tab`\/`pane`.*not a fresh 1-tab\/1-pane workspace.*layout_wait_timeout/s,
    );
  });

  it("accepts a LATER step with no tab/pane — once the layout exists, a dedicated pane is harmless", () => {
    setup(full(BELT_WEB_ONLY.replace("      - { type: review, tab: review, pane: agent }\n", "      - { type: review }\n")));
    expect(() => loadConfig("demo")).not.toThrow();
  });

  it("looks at the first SURVIVING step: a skipped evidence step ahead of a targeted one is fine", () => {
    // A requiresLayout step with no tab/pane is dropped at load, so it is not the step that dispatches
    // first — rejecting on it would refuse a belt that works.
    setup(full(BELT_WEB_ONLY.replace("    steps:\n", "    steps:\n      - { type: evidence }\n")));
    expect(() => loadConfig("demo")).not.toThrow();
  });

  it("…and names the first surviving step when THAT one is untargeted", () => {
    const belt = BELT_WEB_ONLY.replace("    steps:\n", "    steps:\n      - { type: evidence }\n").replace(
      "      - { type: work,   tab: main,   pane: agent }\n",
      "      - { type: work }\n",
    );
    setup(full(belt));
    expect(() => loadConfig("demo")).toThrow(/its first step "work" has no `tab`\/`pane`/);
  });

  it("a belt with no default_layout skips the allocation check (panes provided outside the factory)", () => {
    setup(full(BELT_WEB_ONLY.replace("    default_layout: web\n", "")));
    expect(() => loadConfig("demo")).not.toThrow();
  });

  it("an untitled pane cannot satisfy a step target (labels are what dispatch resolves)", () => {
    // Tab `main` exists but its only pane is untitled — the step's main/agent target must fail.
    const untitled = `  - id: web\n    tabs:\n      - title: main\n        panes:\n          - { command: claude }\n      - title: review\n        panes:\n          - { title: agent, command: claude }\n      - title: pr\n        panes:\n          - { title: agent, command: claude }\n`;
    setup(full(BELT_WEB_ONLY, untitled));
    expect(() => loadConfig("demo")).toThrow(/step "work" targets pane main\/agent, but layout "web" does not define it/);
  });

  it("rejects a step whose target pane starts no agent at all", () => {
    // The pane EXISTS but nothing brings an agent up in it, so the step would wait out its whole
    // layout-wait budget and park. An `agent:` kind (or a `command` that launches one) is the fix.
    const noAgent = LAYOUTS.replace("- { title: agent,  command: claude,  setup: true }", "- { title: agent,  setup: true }");
    setup(full(BELT_WEB_ONLY, noAgent));
    expect(() => loadConfig("demo")).toThrow(/step "work" targets pane main\/agent in layout "web", but that pane starts no agent — set an `agent:` kind/);
  });

  it("an `agent:` pane satisfies the check — herdr starts that agent as part of the build", () => {
    const declared = LAYOUTS.replace(
      "- { title: agent,  command: claude,  setup: true }",
      "- { title: agent,  agent: claude,  agent_args: [--dangerously-skip-permissions],  setup: true }",
    );
    setup(full(BELT_WEB_ONLY, declared));
    expect(() => loadConfig("demo")).not.toThrow();
    expect(loadConfig("demo").config.layouts[0]!.tabs[0]!.panes[0]!.agent).toEqual({
      kind: "claude",
      name: undefined,
      args: ["--dangerously-skip-permissions"],
      prompt: undefined,
      startTimeoutMs: undefined,
      promptTimeoutMs: undefined,
    });
  });

  it("rejects a pane that sets both `agent` and a `command` (they race for the same shell)", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { agent: claude, command: nvim }\n`;
    setup(full(BELT_NO_PANES, bad));
    expect(() => loadConfig("demo")).toThrow(/either `agent` or `command`, not both/);
  });

  it("rejects an agent kind herdr doesn't support", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { agent: notanagent }\n`;
    setup(full(BELT_NO_PANES, bad));
    expect(() => loadConfig("demo")).toThrow(/agent/);
  });

  it("rejects agent-only keys on a pane with no `agent:` (a typo would silently never start one)", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { title: a, prompt: do the thing }\n`;
    setup(full(BELT_NO_PANES, bad));
    expect(() => loadConfig("demo")).toThrow(/need an `agent:` on the same pane/);
  });

  it("rejects an agent_name herdr would reject, and a layout that reuses one", () => {
    const badName = `  - id: web\n    tabs:\n      - panes:\n          - { agent: claude, agent_name: "Fix:K-1" }\n`;
    setup(full(BELT_NO_PANES, badName));
    expect(() => loadConfig("demo")).toThrow(/agent_name must start with a lowercase letter/);

    const dupe = `  - id: web\n    tabs:\n      - panes:\n          - { agent: claude, agent_name: main }\n          - { agent: claude, agent_name: main, split: right }\n`;
    setup(full(BELT_NO_PANES, dupe));
    expect(() => loadConfig("demo")).toThrow(/share an `agent_name`/);
  });

  it("rejects a layout `prompt` on a pane a step targets (two prompts would race in one agent)", () => {
    const withPrompt = LAYOUTS.replace(
      "- { title: agent,  command: claude,  setup: true }",
      "- { title: agent,  agent: claude,  prompt: start now,  setup: true }",
    );
    setup(full(BELT_WEB_ONLY, withPrompt));
    expect(() => loadConfig("demo")).toThrow(/sets a `prompt`, but belt "ship" step "work" targets that pane/);
  });

  it("allows a `prompt` on an agent pane NO step targets", () => {
    const helper = LAYOUTS.replace(
      "- { title: logs, split: horizontal, size: 40 }",
      "- { title: logs, agent: claude, prompt: watch the logs, split: horizontal, size: 40 }",
    );
    setup(full(BELT_WEB_ONLY, helper));
    expect(() => loadConfig("demo")).not.toThrow();
  });

  it("rejects `persist` on a pane with no command (there is nothing to persist past)", () => {
    const bad = `  - id: web\n    tabs:\n      - panes:\n          - { title: a, persist: false }\n`;
    setup(full(BELT_NO_PANES, bad));
    expect(() => loadConfig("demo")).toThrow(/`persist` only applies to a pane with a `command`/);
  });

  it("merges layout env under pane env (the pane wins) and stringifies scalars", () => {
    const envs = `  - id: web\n    env: { SHARED: layout, ONLY_LAYOUT: yes }\n    tabs:\n      - panes:\n          - { title: a, env: { SHARED: pane, PORT: 3000 } }\n`;
    setup(full(BELT_NO_PANES, envs));
    expect(loadConfig("demo").config.layouts[0]!.tabs[0]!.panes[0]!.env).toEqual({ SHARED: "pane", ONLY_LAYOUT: "yes", PORT: "3000" });
  });

  it("the shipped example config parses against the schema (guards example drift)", () => {
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const raw = readFileSync(join(repoRoot, "examples/example-repo/config.yml"), "utf8");
    const r = RepoConfigSchema.safeParse(parseYaml(raw));
    const detail = r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    expect(r.success, detail).toBe(true);
  });

  // Every WHOLE config we print in the docs must actually load. A published example that the loader
  // refuses is worse than no example — a reader copies it, gets a rejection, and stops trusting the
  // docs. This found a real one: the evidence-step scaffold in the setup interview had an agent-less
  // target pane, so it had never loaded, and a new first-step rule would have been blamed for it.
  // Only fences that are a complete config are checked (repo + work_sources + belt); fragments that
  // illustrate one block can't be validated as a whole and are skipped.
  it("every complete config example in the docs parses against the schema", () => {
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const files = execSync("git ls-files '*.md' '*.yml'", { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const failures: string[] = [];
    let checked = 0;
    for (const rel of files) {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      const fences: { body: string; line: number }[] = [];
      if (rel.endsWith(".yml")) {
        fences.push({ body: text, line: 1 });
      } else {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!/^```ya?ml\s*$/.test(lines[i]!)) continue;
          let j = i + 1;
          while (j < lines.length && !/^```\s*$/.test(lines[j]!)) j++;
          fences.push({ body: lines.slice(i + 1, j).join("\n"), line: i + 2 });
          i = j;
        }
      }
      for (const fence of fences) {
        if (!/^repo:/m.test(fence.body) || !/^belt:/m.test(fence.body) || !/^work_sources:/m.test(fence.body)) continue;
        checked++;
        let doc: unknown;
        try {
          doc = parseYaml(fence.body.replaceAll("__REPO__", "/tmp"));
        } catch (e) {
          failures.push(`${rel}:${fence.line} — invalid YAML: ${String(e).slice(0, 200)}`);
          continue;
        }
        const r = RepoConfigSchema.safeParse(doc);
        if (!r.success) {
          failures.push(`${rel}:${fence.line} — ${r.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join(" | ").slice(0, 500)}`);
        }
      }
    }
    expect(checked, "found no complete config examples to check — the fence detection probably broke").toBeGreaterThan(2);
    expect(failures.join("\n"), "a config example in the docs no longer loads").toBe("");
  });
});

describe("assertMainCheckout", () => {
  it("accepts a .git directory, rejects a .git file (linked worktree)", () => {
    const base = mkdtempSync(join(tmpdir(), "cats-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const main = join(base, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    const linked = join(base, "linked");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), "gitdir: /elsewhere");
    expect(() => assertMainCheckout(main)).not.toThrow();
    expect(() => assertMainCheckout(linked)).toThrow(/linked worktree/);
  });
});
