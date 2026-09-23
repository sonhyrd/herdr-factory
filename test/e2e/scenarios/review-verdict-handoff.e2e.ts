// A factory review verdict on a factory-owned PR goes to the run watching it (issue #86). Two runs
// on one belt reach a green PR, then reviews land on their PRs as review BODIES (no threads):
//
//   * cap-me: `changes-requested` round 1 wakes the resolver with the findings (board + explain say
//     "fixing hf-review round 1"); its code push re-runs the gates over H..H2 only, and the review
//     step posts round 2 itself (markers round 2 / head H2) instead of bouncing. Round 2 still has a
//     must-fix: fix pass 2 of 2. Round 3 (told it is the last) posts `needs-human` — the operator is
//     notified, no third resolver, no "ready to merge".
//   * clean-me: `unchanged` and nits-only `clean` wake nothing; `clean` with a should-fix does. A
//     DOCS-only fix still self-checks, round 2 comes back clean, and only then is it ready to merge.
//   * PR #99, which no run watches, carries a verdict too — nothing touches it.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";
import type { World } from "../harness/world.ts";

const LAYOUT = {
  id: "with-evidence",
  tabs: ["work", "evidence", "review", "pr"].map((title) => ({ title, panes: [{ title: "agent", agent: "claude" }] })),
};
const MUST = "**must-fix** `src/a.ts:1` — the guard is inverted — flip it";
const SHOULD = "**should-fix** `src/b.ts:2` — duplicated helper — reuse the shared one";
const NIT = "**nit** `src/c.ts:3` — wording";

scenario(
  {
    name: "review-verdict-handoff",
    timeoutMs: 600_000,
    briefs: {
      "cap-me": "# Cap me\n\n## Acceptance criteria\n- the banner is blue\n",
      "clean-me": "# Clean me\n\n## Acceptance criteria\n- the banner is green\n",
    },
    config: (p) => ({
      evidence: { publisher: "local", key_prefix: "e2e", github_username: "harness" },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [LAYOUT],
      belt: [
        {
          name: "proving",
          source: "briefs",
          workspace_name: "e/{{work_id}}",
          default_layout: "with-evidence",
          steps: [
            { type: "work", tab: "work", pane: "agent" },
            { type: "evidence", tab: "evidence", pane: "agent" },
            { type: "review", tab: "review", pane: "agent" },
            { type: "pr", tab: "pr", pane: "agent" },
          ],
        },
      ],
    }),
    agent: {
      steps: {
        evidence: { commit: false, evidence: true },
        review: { commit: false },
        pr: { commit: false },
        // The scenario plays the resolver's push (like watch-rework-evidence); the agent only takes the turn.
        resolver: { commit: false, signal: "none" },
      },
      selfCheck: {
        "cap-me": { "2": { verdict: "changes-requested", findings: [MUST] }, "3": { verdict: "changes-requested", findings: [MUST] } },
        "clean-me": { "2": { verdict: "clean", findings: [NIT] } },
      },
    },
  },
  async (w) => {
    // PR #99: someone else's PR with a verdict on it. No run watches it.
    w.gh.patch((s) => {
      s.prs["99"] = {
        number: 99, state: "OPEN", url: `https://github.com/${s.repo}/pull/99`, isDraft: false, headRefName: "human/branch", headRefOid: "deadbeef00",
        title: "a human's PR", body: "", base: "main", labels: [], reviewers: [], assignees: [], threads: [], checks: [],
        reviews: [{ id: "PRR_99_1", body: verdict("changes-requested", 1, "deadbeef00", [MUST, SHOULD]) }],
      };
    });

    await Promise.all([capMe(w), cleanMe(w)]);

    // ── a PR no run watches is left to its author ─────────────────────────────────────────────
    expect(w.db.events().filter((e) => e.type === "review_handoff" && JSON.parse(e.detail ?? "{}").number === 99), "no hand-off for #99").toEqual([]);
    expect(w.gh.calls().filter((c) => c.argv.join(" ").match(/\bpr(99:|\s+(review|comment|edit)\s+99\b)/)), "the factory never queried or wrote #99").toEqual([]);
    expect(w.gh.pr(99)!.reviews!.length, "#99 carries only its own review").toBe(1);
  },
);

async function capMe(w: World): Promise<void> {
  const key = "cap-me";
  const t = tools(w, key);
  await w.waitForEvent(key, "pr_green", { label: `${key}: the first pass reaches a green PR`, timeoutMs: 300_000 });
  const { pr, wt, branch } = t.run();
  const h1 = w.gh.pr(pr)!.headRefOid!;
  expect(t.ready()).toBe(1);

  // ── round 1: changes-requested wakes the resolver with the findings — no thread ──────────
  w.gh.addReview(pr, verdict("changes-requested", 1, h1, [MUST, SHOULD]));
  await w.waitFor(() => t.handoffs() === 1, { label: `${key}: round 1 handed to the resolver`, timeoutMs: 60_000 });
  expect(w.gh.pr(pr)!.threads, "no inline thread was needed").toEqual([]);
  const brief = readFileSync(join(wt, ".memory/herdr-factory/prompt-resolver.md"), "utf8");
  expect(brief).toContain("Review findings to fix — round 1");
  expect(brief).toContain(MUST);
  expect(brief, "…and it maps findings to commits").toContain("maps each finding number to its commit SHA");
  expect(t.explain()).toContain(`PR #${pr}: fixing hf-review round 1 (2 findings)`);
  expect(await t.boardLine()).toBe("fixing hf-review round 1 (2 findings)");

  // ── the resolver pushes H2: the gates re-check H1..H2 and the review posts round 2 ──────
  const h2 = t.push(wt, branch, pr, "src/fix1.ts");
  await w.waitFor(() => t.reworks() === 1, { label: `${key}: the fix sends the run through its gates`, timeoutMs: 120_000 });
  await t.noteFor(wt, h2);
  expect(t.note(wt, "evidence"), "the self-check judges only the fix").toContain(`git diff ${h1}..${h2}`);
  const review2 = t.note(wt, "review");
  expect(review2).toContain(`git diff ${h1}..${h2}`);
  expect(review2).toContain("herdr-factory-review-round: 2");
  expect(review2).toContain(`herdr-factory-review-head: ${h2}`);
  expect(review2).toContain("instead of bouncing");
  expect(review2, "pass 1 of 2 is not the last").not.toContain("needs-human");

  // Round 2 (posted by the review step) still has a must-fix: fix pass 2 of 2.
  await w.waitFor(() => t.handoffs() === 2, { label: `${key}: round 2 handed to the resolver`, timeoutMs: 240_000 });
  const round2 = w.gh.pr(pr)!.reviews!.at(-1)!.body;
  expect(round2, "the review step posted round 2 on the fixed head").toContain(`herdr-factory-review-head: ${h2}`);
  expect(round2).toContain("herdr-factory-review-verdict: changes-requested");
  expect(w.db.events(key).some((e) => e.type === "bounced"), "the self-check posts, it does not bounce").toBe(false);
  expect(t.explain()).toContain(`PR #${pr}: fixing hf-review round 2 (1 finding) — fix pass 2 of 2.`);

  // ── H3: the last self-check posts needs-human; no third pass, no "ready" ────────────────
  const h3 = t.push(wt, branch, pr, "src/fix2.ts");
  await w.waitFor(() => t.reworks() === 2, { label: `${key}: fix 2 re-runs the gates`, timeoutMs: 120_000 });
  await t.noteFor(wt, h3);
  expect(t.note(wt, "review")).toContain(`git diff ${h2}..${h3}`);
  expect(t.note(wt, "review"), "the last round is told to hand over").toContain("herdr-factory-review-verdict: needs-human");
  await w.waitFor(() => w.herdr.notifications().some((n) => n.title.includes(`${key} review needs a human`)), {
    label: `${key}: round 3 goes to the operator`,
    timeoutMs: 240_000,
  });
  expect(w.gh.pr(pr)!.reviews!.at(-1)!.body).toContain("herdr-factory-review-verdict: needs-human");
  expect(t.handoffs(), "no third fix pass").toBe(2);
  expect(t.explain()).toContain(`PR #${pr}: hf-review round 3 needs a human`);
  expect(await t.boardLine()).toBe("hf-review round 3 needs a human");
  await new Promise((r) => setTimeout(r, 8_000)); // a few ticks: still no third wake, and still not ready
  expect(t.handoffs()).toBe(2);
  expect(t.ready(), "never ready to merge after round 1").toBe(1);

  w.gh.merge(pr);
  await w.waitForEnd(key, "merged", { label: `${key}: merges and tears down`, timeoutMs: 120_000 });
}

async function cleanMe(w: World): Promise<void> {
  const key = "clean-me";
  const t = tools(w, key);
  await w.waitForEvent(key, "pr_green", { label: `${key}: the first pass reaches a green PR`, timeoutMs: 300_000 });
  const { pr, wt, branch } = t.run();
  const h1 = w.gh.pr(pr)!.headRefOid!;

  // ── unchanged, and clean with nits only: recorded, nothing woken ─────────────────────────
  w.gh.addReview(pr, `hf-review-verdict: unchanged\nhf-review-head: ${h1}\n`);
  await w.waitFor(() => t.verdicts() === 1, { label: `${key}: unchanged recorded`, timeoutMs: 60_000 });
  w.gh.addReview(pr, verdict("clean", 1, h1, [NIT]));
  await w.waitFor(() => t.verdicts() === 2, { label: `${key}: nits-only clean recorded`, timeoutMs: 60_000 });
  expect(t.handoffs(), "neither wakes the resolver").toBe(0);
  expect(existsSync(join(wt, ".memory/herdr-factory/prompt-resolver.md")), "no resolver prompt").toBe(false);

  // ── clean with a should-fix wakes it ────────────────────────────────────────────────────
  w.gh.addReview(pr, verdict("clean", 1, h1, [SHOULD, NIT]));
  await w.waitFor(() => t.handoffs() === 1, { label: `${key}: clean with a should-fix is handed off`, timeoutMs: 60_000 });
  expect(t.explain()).toContain(`PR #${pr}: fixing hf-review round 1 (2 findings)`);
  const readyBefore = t.ready();

  // ── a DOCS-only fix still self-checks; round 2 comes back clean → only then ready ─────────
  const h2 = t.push(wt, branch, pr, "README.md");
  await w.waitFor(() => t.reworks() === 1, { label: `${key}: a docs-only fix still self-checks`, timeoutMs: 120_000 });
  await t.noteFor(wt, h2);
  expect(t.note(wt, "review")).toContain(`herdr-factory-review-head: ${h2}`);
  await w.waitFor(() => t.ready() === readyBefore + 1, { label: `${key}: ready once round 2 is clean`, timeoutMs: 240_000 });
  expect(await t.boardLine()).toBe("self-check round 2 clean");
  expect(t.explain()).toContain(`PR #${pr}: self-check round 2 clean`);
  const cleanAt = w.db.events(key).filter((e) => e.type === "review_verdict").at(-1)!;
  expect(JSON.parse(cleanAt.detail ?? "{}")).toMatchObject({ phase: "clean", round: 2, fixes: 1 });
  expect(w.db.event(key, "pr_green")!.id, "ready only after the clean round").toBeGreaterThan(cleanAt.id);
  expect(t.handoffs()).toBe(1);

  w.gh.merge(pr);
  await w.waitForEnd(key, "merged", { label: `${key}: merges and tears down`, timeoutMs: 120_000 });
}

function verdict(v: string, round: number, head: string, findings: string[]): string {
  return [`<!-- hf:review ${round} -->`, `hf-review-verdict: ${v}`, `hf-review-round: ${round}`, `hf-review-head: ${head}`, "", "## Findings", ...findings.map((f, i) => `- [ ] ${i + 1}. ${f}`), ""].join("\n");
}

function tools(w: World, key: string) {
  type Status = { active: { ticketKey: string; hfReview?: { phase: string; text: string } }[] };
  const count = (type: string) => w.db.events(key).filter((e) => e.type === type).length;
  return {
    run: () => {
      const r = w.db.run(key)!;
      return { pr: r.pr_number!, wt: r.worktree_path!, branch: r.branch! };
    },
    ready: () => w.herdr.notifications().filter((n) => n.title.includes(`${key} ready to merge`)).length,
    handoffs: () => count("review_handoff"),
    verdicts: () => count("review_verdict"),
    reworks: () => count("rework"),
    explain: () => w.factory.cli(["explain", key, "--source", "briefs"]).stdout,
    boardLine: async () => (await w.factory.repoApi<Status>("GET", "status?quick=1")).active.find((r) => r.ticketKey === key)?.hfReview?.text,
    /** A self-check note, live or already archived by its pass. */
    note: (wt: string, step: string) => {
      const dir = join(wt, ".memory/herdr-factory");
      const live = join(dir, `feedback-${step}.md`);
      if (existsSync(live)) return readFileSync(live, "utf8");
      const passes = [9, 8, 7, 6, 5, 4, 3, 2].map((n) => join(dir, `feedback-${step}-addressed-pass${n}.md`)).filter(existsSync);
      return passes.length ? readFileSync(passes[0]!, "utf8") : "";
    },
    /** The later gates' notes are written just after the `rework` event (the first gate's goes with it). */
    noteFor: (wt: string, head: string) =>
      w.waitFor(() => existsSync(join(wt, ".memory/herdr-factory/feedback-review.md")) && readFileSync(join(wt, ".memory/herdr-factory/feedback-review.md"), "utf8").includes(head), {
        label: `${key}: the review step's self-check note for ${head.slice(0, 7)}`,
        timeoutMs: 30_000,
      }),
    /** Play the resolver's fix: commit, push, move the fake PR head. */
    push: (wt: string, branch: string, pr: number, rel: string) => {
      const p = join(wt, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `// fix ${Date.now()}\n`);
      w.git(["add", "-A"], wt);
      w.git(["-c", "user.email=r@e2e", "-c", "user.name=resolver", "commit", "-q", "-m", `fix: ${rel}`], wt);
      w.git(["push", "-q", "origin", branch], wt);
      const head = w.git(["rev-parse", "HEAD"], wt);
      w.gh.push(pr, head);
      return head;
    },
  };
}
