// Evidence belongs to a head (issue #84). A run in the PR watch vouches for its PR because evidence
// and review judged ONE commit. A code push after that — a resolver fixing a review thread — must not
// ship on the old verdict:
//
//   * a push touching src/** sends the run back through evidence → review → pr on the new head; the
//     rework note has the evidence step mark the PR body's old evidence superseded; the board says
//     "evidence stale", explain names both SHAs, and nobody is told "ready to merge";
//   * the re-run films a NEW evidence folder at the new head, the pr step relinks it in the PR body,
//     and only after the review verdict does the board flip to ready; and
//   * a push touching only *.md / locales/** keeps the verdict: it stays in the watch and is a new green.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const LAYOUT = {
  id: "with-evidence",
  tabs: ["work", "evidence", "review", "pr"].map((title) => ({ title, panes: [{ title: "agent", agent: "claude" }] })),
};

scenario(
  {
    name: "watch-rework-evidence",
    timeoutMs: 420_000,
    briefs: { "film-me": "# Film me\n\n## Acceptance criteria\n- the banner is blue\n" },
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
      steps: { evidence: { commit: false, evidence: true }, review: { commit: false }, pr: { commit: false } },
      // The re-film holds long enough for the scenario to read the board mid-rework.
      passes: { "evidence:2": { commit: false, evidence: true, preWorkMs: 15_000 }, "review:2": { commit: false, preWorkMs: 5_000 } },
    },
  },
  async (w) => {
    const key = "film-me";
    const ready = () => w.herdr.notifications().filter((n) => /ready to merge/i.test(n.title));
    type Status = { active: { ticketKey: string; prGreen?: boolean; evidenceStale?: { evidenceHead: string; prHead: string } }[] };
    const board = async () => (await w.factory.repoApi<Status>("GET", "status?quick=1")).active.find((r) => r.ticketKey === key);
    const explain = () => w.factory.cli(["explain", key, "--source", "briefs"]).stdout;
    const prefixes = () => w.db.intents({ kind: "evidence_publish" }).map((i) => (JSON.parse(i.payload) as { keyPrefix: string }).keyPrefix);

    // ── head A: filmed, reviewed, green ───────────────────────────────────────────────────────
    await w.waitForEvent(key, "pr_green", { label: "the first pass reaches a green PR", timeoutMs: 240_000 });
    const run = w.db.run(key)!;
    const pr = run.pr_number!;
    const wt = run.worktree_path!;
    const headA = w.gh.pr(pr)!.headRefOid!;
    expect(headA, "the PR head is the branch's real commit").toBe(w.git(["rev-parse", "HEAD"], wt));
    expect(w.gh.pr(pr)!.body, "the PR body records the SHA the evidence was filmed at").toContain(`filmed at ${headA}`);
    expect(ready().length).toBe(1);
    expect(explain(), "explain: the verdict covers the head").toContain(`judged the PR head ${headA.slice(0, 7)}`);
    const firstPrefix = prefixes()[0]!;
    expect(w.gh.pr(pr)!.body, "…and links the first evidence folder").toContain(firstPrefix);

    // ── a resolver pushes a code fix: head B ──────────────────────────────────────────────────
    write(wt, "src/feature.ts", "export const field = 'per-surface';\n");
    w.git(["add", "-A"], wt);
    w.git(["-c", "user.email=r@e2e", "-c", "user.name=resolver", "commit", "-q", "-m", "fix: per-surface field"], wt);
    w.git(["push", "-q", "origin", run.branch!], wt);
    const headB = w.git(["rev-parse", "HEAD"], wt);
    w.gh.push(pr, headB);

    await w.waitForEvent(key, "rework", { label: "the code push sends the run back through its gates", timeoutMs: 120_000 });
    const rework = w.db.event(key, "rework")!.data;
    expect(rework, "the PR watch (not an operator) rewound pr → evidence").toMatchObject({ by: "pr_watch", fromStep: "pr", toStep: "evidence" });
    await w.waitFor(async () => (await board())?.evidenceStale != null, { label: "the board shows the stale evidence", timeoutMs: 30_000 });
    expect((await board())!.evidenceStale, "stale since A, head B").toEqual({ evidenceHead: headA, prHead: headB });
    expect((await board())!.prGreen, "…and not green").toBe(false);
    const stale = explain();
    expect(stale, "explain names both SHAs").toContain(`judged ${headA.slice(0, 7)}; the PR head is ${headB.slice(0, 7)}`);
    expect(stale).toContain("src/feature.ts");
    // The rework note, while the re-film holds (it is archived under a pass-stamped name once done).
    const notePath = join(wt, ".memory/herdr-factory/feedback-evidence.md");
    const archived = join(wt, ".memory/herdr-factory/feedback-evidence-addressed-pass2.md");
    const note = readFileSync(existsSync(notePath) ? notePath : archived, "utf8");
    expect(note).toContain(headA);
    expect(note).toContain("src/feature.ts");
    expect(note, "the re-film is told why, and to mark the old evidence").toContain(`superseded by ${headB.slice(0, 7)}`);
    await w.waitFor(() => (w.gh.pr(pr)!.body ?? "").includes(`superseded by ${headB.slice(0, 7)} — re-filming`), { label: "the PR body marks the old evidence stale", timeoutMs: 60_000 });
    expect(ready().length, "no ready-to-merge while the evidence is stale").toBe(1);

    // ── re-filmed at B, reviewed, relinked — only then ready ──────────────────────────────────
    await w.waitFor(() => ready().length === 2, { label: "green again once the gates pass at B", timeoutMs: 180_000 });
    const id = run.id;
    expect(w.db.step(id, "evidence")!.pass).toBe(2);
    expect(w.db.step(id, "review")!.pass, "review re-ran too").toBe(2);
    const green = w.db.event(key, "pr_green")!;
    const reviewDone = w.db.events(key).filter((e) => e.type === "step_done" && JSON.parse(e.detail ?? "{}").step === "review").at(-1)!;
    expect(green.id, "ready only AFTER the review verdict at B").toBeGreaterThan(reviewDone.id);
    const secondPrefix = prefixes().find((p) => p !== firstPrefix)!;
    expect(secondPrefix, "a new evidence folder").toBeTruthy();
    const body = w.gh.pr(pr)!.body ?? "";
    expect(body, "the PR body links the new folder, filmed at B").toContain(`filmed at ${headB}`);
    expect(body).toContain(secondPrefix);
    expect(body, "…and the superseded line is gone").not.toContain("re-filming");
    expect((await board())!.evidenceStale, "the board no longer says stale").toBeUndefined();
    expect(explain()).toContain(`judged the PR head ${headB.slice(0, 7)}`);

    // ── a docs/translations-only push keeps the verdict ───────────────────────────────────────
    write(wt, "README.md", "# docs only\n");
    write(wt, "locales/en.json", '{"hello":"hi"}\n');
    w.git(["add", "-A"], wt);
    w.git(["-c", "user.email=r@e2e", "-c", "user.name=resolver", "commit", "-q", "-m", "docs: wording"], wt);
    w.git(["push", "-q", "origin", run.branch!], wt);
    const headC = w.git(["rev-parse", "HEAD"], wt);
    w.gh.push(pr, headC);
    await w.waitFor(() => ready().length === 3, { label: "a docs-only push is a new green, no rework", timeoutMs: 120_000 });
    expect(w.db.events(key).filter((e) => e.type === "rework").length, "no second rework").toBe(1);
    expect(w.db.run(key)!.phase).toBe("reviewing");
    expect(explain()).toContain("differs only in docs/translations");

    w.gh.merge(pr);
    await w.waitForEnd(key, "merged", { label: "the run merges and tears down", timeoutMs: 120_000 });
  },
);

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
