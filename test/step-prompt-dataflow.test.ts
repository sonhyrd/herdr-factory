import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findPrTemplate, prAutomatedRoundBlock, prOptionsBlock, productActiveFor, stripInactiveProductBlocks } from "../src/core/step.ts";
import type { BeltRuntime } from "../src/core/deps.ts";
import type { Run } from "../src/types.ts";
import type { ProductType } from "../src/types.ts";

// The render-time half of design §8: an OPTIONAL consume unsatisfied by the belt is DROPPED — no
// @@TOKEN@@ injected, no orphaned clause — so a work→review→pr belt never points the reviewer/PR
// step at evidence that was never captured.

const prompt = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/prompts/${rel}`, import.meta.url)), "utf8");
// Copies of pr.md / github_issues/pr.md written as they were BEFORE the belt-level `pr:` block —
// literal step 2, no @@PR_OPTIONS@@ — the trustworthy ground truth for the byte-identity check
// below. Their prose tracks the shipped prompts; only the pr: tokenization is held back.
const legacyPrompt = (rel: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), "utf8");

const step = (name: string, produces: ProductType[], consumes: ProductType[] = []) => ({
  name,
  produces,
  consumes: consumes.map((type) => ({ type, required: false })),
});

const WORK = step("work", ["commits", "handoff"]);
const EVIDENCE = step("evidence", ["evidence", "handoff"], ["commits"]);
const REVIEW = step("review", ["handoff"], ["commits", "evidence"]);
const PR = step("pr", ["pull_request", "handoff"], ["commits", "evidence", "close_reference"]);

describe("productActiveFor — belt dataflow gating", () => {
  it("evidence is INACTIVE for a consumer when no upstream step produces it (work→review→pr)", () => {
    const steps = [WORK, REVIEW, PR];
    expect(productActiveFor(steps, REVIEW, "jira")("evidence")).toBe(false);
    expect(productActiveFor(steps, PR, "jira")("evidence")).toBe(false);
  });

  it("evidence is ACTIVE for a consumer when an upstream step produces it (work→evidence→review→pr)", () => {
    const steps = [WORK, EVIDENCE, REVIEW, PR];
    expect(productActiveFor(steps, REVIEW, "jira")("evidence")).toBe(true);
    expect(productActiveFor(steps, PR, "jira")("evidence")).toBe(true);
  });

  it("the evidence producer itself is always active for evidence (its own produce)", () => {
    expect(productActiveFor([WORK, EVIDENCE], EVIDENCE, "jira")("evidence")).toBe(true);
  });

  it("a required upstream product (commits) is active; an unproduced one is not", () => {
    const active = productActiveFor([WORK, REVIEW, PR], REVIEW, "jira");
    expect(active("commits")).toBe(true); // work produced it
    expect(active("pull_request")).toBe(false); // only PR (downstream) produces it
  });

  it("close_reference is active only for the source that produces it (github_issues, not jira)", () => {
    const steps = [WORK, PR];
    expect(productActiveFor(steps, PR, "github_issues")("close_reference")).toBe(true);
    expect(productActiveFor(steps, PR, "jira")("close_reference")).toBe(false);
  });

  it("pull_request is ACTIVE only for the step that produces the PR (the pr step) — this gates @@PR_TEMPLATE@@", () => {
    const steps = [WORK, REVIEW, PR];
    expect(productActiveFor(steps, PR, "jira")("pull_request")).toBe(true);
    expect(productActiveFor(steps, WORK, "jira")("pull_request")).toBe(false);
    expect(productActiveFor(steps, REVIEW, "jira")("pull_request")).toBe(false);
  });
});

describe("stripInactiveProductBlocks — @@WHEN:product@@ … @@END@@", () => {
  it("drops the whole block (prose + tokens) when inactive, keeps inner (minus markers) when active", () => {
    const body = "keep A.@@WHEN:evidence@@ read @@EVIDENCE_DIR@@@@END@@ keep B.";
    expect(stripInactiveProductBlocks(body, () => false)).toBe("keep A. keep B.");
    expect(stripInactiveProductBlocks(body, () => true)).toBe("keep A. read @@EVIDENCE_DIR@@ keep B.");
  });

  it("handles multiple independent blocks", () => {
    const body = "@@WHEN:evidence@@X@@END@@-@@WHEN:commits@@Y@@END@@";
    expect(stripInactiveProductBlocks(body, (p) => p === "commits")).toBe("-Y");
  });

  it("returns a body with no blocks unchanged", () => {
    expect(stripInactiveProductBlocks("plain @@KEY@@ body", () => false)).toBe("plain @@KEY@@ body");
  });
});

describe("findPrTemplate — the target repo's own PR template (@@PR_TEMPLATE@@)", () => {
  const tmps: string[] = [];
  const wt = () => {
    const d = mkdtempSync(join(tmpdir(), "prtpl-"));
    tmps.push(d);
    return d;
  };
  const write = (dir: string, rel: string, body: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  afterEach(() => {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("returns null when the repo ships no template", () => {
    expect(findPrTemplate(wt())).toBeNull();
  });

  it("finds the canonical .github/PULL_REQUEST_TEMPLATE.md", () => {
    const dir = wt();
    write(dir, ".github/PULL_REQUEST_TEMPLATE.md", "## Summary\n<!-- what -->\n");
    expect(findPrTemplate(dir)).toContain("## Summary");
  });

  it("finds the lowercase and root/docs spellings GitHub also honours", () => {
    const root = wt();
    write(root, "pull_request_template.md", "ROOT TEMPLATE");
    expect(findPrTemplate(root)).toBe("ROOT TEMPLATE");
    const docs = wt();
    write(docs, "docs/PULL_REQUEST_TEMPLATE.md", "DOCS TEMPLATE");
    expect(findPrTemplate(docs)).toBe("DOCS TEMPLATE");
  });

  it("prefers .github/ over the root over docs/ (discovery precedence)", () => {
    const dir = wt();
    write(dir, ".github/PULL_REQUEST_TEMPLATE.md", "GITHUB WINS");
    write(dir, "PULL_REQUEST_TEMPLATE.md", "root");
    write(dir, "docs/PULL_REQUEST_TEMPLATE.md", "docs");
    expect(findPrTemplate(dir)).toBe("GITHUB WINS");
  });

  it("picks the default/first *.md from a .github/PULL_REQUEST_TEMPLATE/ directory (v1: no selection)", () => {
    const dir = wt();
    write(dir, ".github/PULL_REQUEST_TEMPLATE/bug.md", "BUG");
    write(dir, ".github/PULL_REQUEST_TEMPLATE/aardvark.md", "FIRST");
    expect(findPrTemplate(dir)).toBe("FIRST"); // alphabetical
  });

  it("ignores an empty/whitespace-only template file", () => {
    const dir = wt();
    write(dir, ".github/PULL_REQUEST_TEMPLATE.md", "   \n\n");
    expect(findPrTemplate(dir)).toBeNull();
  });
});

describe("shipped pr prompts gate @@PR_TEMPLATE@@ + the pr: behavior tokens behind pull_request", () => {
  const PR_TOKENS = /@@PR_TEMPLATE@@|@@PR_OPTIONS@@|@@PR_AUTOMATED_ROUND@@/;
  for (const rel of ["pr.md", "github_issues/pr.md"]) {
    it(`${rel}: a belt with no pr step (pull_request inactive) drops every pr token with no leftover markers`, () => {
      const dropped = stripInactiveProductBlocks(prompt(rel), () => false);
      expect(dropped).not.toMatch(PR_TOKENS); // @@PR_TEMPLATE@@/@@PR_OPTIONS@@/@@PR_AUTOMATED_ROUND@@ all gone
      expect(dropped).not.toMatch(/@@WHEN:|@@END@@/);
    });

    it(`${rel}: the pr step (pull_request active) retains all three pr tokens and strips the markers cleanly`, () => {
      const kept = stripInactiveProductBlocks(prompt(rel), (p) => p === "pull_request");
      expect(kept).toContain("@@PR_TEMPLATE@@");
      expect(kept).toContain("@@PR_OPTIONS@@");
      expect(kept).toContain("@@PR_AUTOMATED_ROUND@@");
      expect(kept).not.toMatch(/@@WHEN:|@@END@@/); // evidence clause dropped, pull_request markers removed
    });
  }
});

// ISSUE #68 item 2: an evidence pass 2 re-filmed all five unchanged desktop criteria (243 s) and
// then lost the narrow-viewport videos to a shared Playwright --output dir (another 63 s). Both
// fixes live entirely in the shipped prompt, so the prompt IS the unit under test.
describe("the shipped evidence prompt does not re-film what has not changed", () => {
  const body = prompt("evidence.md");

  it("tells a pass 2+ agent to diff against its own last handoff's sha and re-film only what moved", () => {
    expect(body).toContain("@@PASS@@"); // the pass is rendered in, so "on pass 2+" is a fact not a guess
    expect(body).toContain("git diff --name-only");
    expect(body).toMatch(/Re-film only the criteria that could have changed/);
    expect(body).toMatch(/carry the previous row/i); // untouched criteria keep their asset + URL
  });

  it("requires one output directory per capture invocation, and says why", () => {
    expect(body).toContain("One output directory per capture invocation");
    expect(body).toContain("clears its output directory at the start of a run");
  });

  it("ships the capture-spec skeleton rather than leaving the boilerplate to be hand-written", () => {
    expect(body).toContain("```ts");
    expect(body).toContain("test.use({"); // viewport + video belong in `use`, not per-describe
    expect(body).toContain("@playwright/test");
  });
});

describe("shipped pr prompts carry the assumptions sections on every belt", () => {
  // The worktree (and the handoff notes in it) is deleted at teardown, so the PR body is the only
  // durable record of what the work step guessed — the sections must survive an evidence-less belt.
  for (const rel of ["pr.md", "github_issues/pr.md"]) {
    for (const [what, evidence] of [["work\u2192pr (no evidence)", false], ["a belt with evidence", true]] as const) {
      it(`${rel}: ${what} still asks for ## Assumptions and ## Not proven by any check`, () => {
        const body = stripInactiveProductBlocks(prompt(rel), () => evidence);
        expect(body).toContain("## Assumptions");
        expect(body).toContain("## Not proven by any check");
        expect(body).toContain("Omit the heading entirely when there are none");
      });
    }
  }
});

describe("belt-level pr: block — absent block renders byte-identical to before it existed", () => {
  // Replicate the pr-step render for a default work→review→pr belt with NO `pr:` block: pull_request
  // active, evidence inactive, no PR template, no commit conventions — strip the @@WHEN@@ clauses then
  // substitute the pr tokens to their absent-block defaults. The current (tokenized) prompt must
  // render identically to the legacy fixture (literal step 2, no @@PR_OPTIONS@@/@@PR_AUTOMATED_ROUND@@).
  const noPrBelt = { pr: undefined } as unknown as BeltRuntime;
  const run = { ticketKey: "K", issueType: "", summary: "" } as unknown as Run;
  const renderDefault = (body: string) =>
    stripInactiveProductBlocks(body, (p) => p === "pull_request")
      .replaceAll("@@PR_OPTIONS@@", prOptionsBlock(noPrBelt, run))
      .replaceAll("@@PR_AUTOMATED_ROUND@@", prAutomatedRoundBlock(noPrBelt))
      .replaceAll("@@PR_TEMPLATE@@", "")
      .replaceAll("@@COMMIT_CONVENTIONS@@", "");
  for (const [cur, leg] of [
    ["pr.md", "pr-prompt.legacy.md"],
    ["github_issues/pr.md", "github-issues-pr-prompt.legacy.md"],
  ] as const) {
    it(`${cur}: identical to the pre-block prompt`, () => {
      expect(renderDefault(prompt(cur))).toBe(renderDefault(legacyPrompt(leg)));
    });
  }

  it("the unset automated-round default is exactly the historical ~10 min instruction", () => {
    // Pin the default text against the legacy fixture's literal step-2 (no retyping-drift risk).
    const legacy = legacyPrompt("pr-prompt.legacy.md");
    const step2 = legacy.slice(legacy.indexOf("2. **Wait"), legacy.indexOf("afterwards.") + "afterwards.".length);
    expect(prAutomatedRoundBlock(noPrBelt)).toBe(step2);
  });
});

describe("belt-level pr: block — @@PR_OPTIONS@@ / @@PR_AUTOMATED_ROUND@@ render the policy", () => {
  const run = { ticketKey: "RWR-9", issueType: "Bug", summary: "Fix the thing" } as unknown as Run;
  const belt = (pr: BeltRuntime["pr"]) => ({ pr } as unknown as BeltRuntime);

  it("draft / title (templated) / labels / reviewers / assignees each surface as gh instructions", () => {
    const out = prOptionsBlock(
      belt({ draft: true, title: "[{{semantic_work_prefix}}] {{work_id}} {{work_slug}}", labels: ["needs-review", "auto"], reviewers: ["octocat"], assignees: ["me"] }),
      run,
    );
    expect(out).toContain("--draft");
    expect(out).toContain("[fix] RWR-9 fix-the-thing"); // {{...}} interpolated via the workspace_name vars
    expect(out).toContain("--label");
    expect(out).toContain("`needs-review`, `auto`");
    expect(out).toContain("--reviewer");
    expect(out).toContain("`octocat`");
    expect(out).toContain("--assignee");
  });

  it("an empty/absent pr block (or one with no fields set) renders nothing", () => {
    expect(prOptionsBlock(belt(undefined), run)).toBe("");
    expect(prOptionsBlock(belt({}), run)).toBe("");
  });

  it("automated_round_minutes: a positive N sets a ~N min window", () => {
    expect(prAutomatedRoundBlock(belt({ automatedRoundMinutes: 30 }))).toContain("(~30 min)");
  });

  it("automated_round_minutes: 0 removes the CI-wait instructions entirely", () => {
    const out = prAutomatedRoundBlock(belt({ automatedRoundMinutes: 0 }));
    expect(out).not.toContain("Wait for the automated round");
    expect(out).not.toContain("poll CI");
    expect(out).toContain("No automated round");
  });
});

describe("shipped consumer prompts gate every evidence reference", () => {
  for (const rel of ["review.md", "pr.md", "github_issues/pr.md"]) {
    it(`${rel}: dropping evidence leaves no dangling evidence token and no leftover markers`, () => {
      const dropped = stripInactiveProductBlocks(prompt(rel), () => false);
      expect(dropped).not.toMatch(/@@EVIDENCE_DIR@@|@@EVIDENCE_UPLOAD_CMD@@|@@CAPTURE_ATTEMPT_CMD@@/);
      expect(dropped).not.toMatch(/@@WHEN:|@@END@@/);
    });

    it(`${rel}: keeping evidence retains the evidence reference and strips only the markers`, () => {
      const kept = stripInactiveProductBlocks(prompt(rel), () => true);
      expect(kept).toContain("@@EVIDENCE_DIR@@");
      expect(kept).not.toMatch(/@@WHEN:|@@END@@/);
    });
  }
});
