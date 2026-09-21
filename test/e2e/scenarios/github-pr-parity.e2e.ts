// Source parity, GitHub edition — and the one thing no other source does: claim a PULL REQUEST.
//
// `github_issues.kind: pull_requests` turns the same source around: the belt's trigger label is read
// off the repo's open PRs instead of its issues, which is how a PR nobody filed a ticket for (one an
// outside agent opened) gets reviewed. What has to be true here and nowhere else:
//
//   * an opted-in source claims the labelled PR and NOT the labelled issue;
//   * a default source (`kind: issues`) on the SAME repo still skips every PR — while proving it is
//     alive by claiming its own issue, or "it claimed nothing" would be vacuously true;
//   * the claim really consumes the trigger label and the `herdr:*` state labels really land on the
//     PR (the lifecycle is projected onto the item itself — GitHub is the status of record); and
//   * **nothing closes the PR.** `close_on` is all-true here, so the issue belt's terminal write-back
//     really does close its issue — and the PR belt's, at the same terminal state, must not.
//
// This is also the scenario that pays off the `GITHUB_API_URL` seam: until the client resolved its
// API base, `github_issues` hardcoded api.github.com and could not be driven end to end at all.
import { expect } from "vitest";
import { GithubFake } from "../harness/sources/github-fake.ts";
import { scenario } from "../harness/index.ts";

const gh = new GithubFake({ repo: "acme/app" });

// The PR belt's first station. A review belt on a real repo runs `gh pr checkout <n>` here; the fake
// has no git PR head, and the point of THIS scenario is the source, so the station only has to exist,
// declare `commits` (or `review` refuses to load — it requires an upstream producer) and signal.
const CHECKOUT_PROMPT = [
  "# Check out pull request #@@KEY@@",
  "",
  "The work doc is @@WORK_DOC@@ (kind: @@WORK_DOC_KIND@@) — it carries the PR's head branch.",
  "On a real repo you would `gh pr checkout @@KEY@@` and then `set-branch`.",
  "",
  "When you are done: `@@STEP_DONE_CMD@@`",
  "",
].join("\n");

const PR_KEY = "101"; // labelled hf-review, a PULL REQUEST  → the review-gh belt must claim it
const PR_ISSUE_KEY = "202"; // labelled hf-review, an ISSUE  → nothing may claim it
const SHIP_PR_KEY = "303"; // labelled hf-ship,   a PULL REQUEST → the issues belt must skip it
const SHIP_KEY = "404"; // labelled hf-ship,   an ISSUE   → the issues belt claims it (the control)

scenario(
  {
    name: "github-pr-parity",
    timeoutMs: 360_000,
    beforeStart: async () => {
      await gh.listen();
      gh.seed({ number: Number(PR_KEY), kind: "pull_request", title: "Tidy the widget", body: "Refactor the widget.", labels: ["hf-review"], head: "grok/tidy-widget", base: "main", author: "grok-bot" });
      gh.seed({ number: Number(PR_ISSUE_KEY), kind: "issue", title: "An issue wearing the review label", labels: ["hf-review"] });
      gh.seed({ number: Number(SHIP_PR_KEY), kind: "pull_request", title: "A PR wearing the ship label", labels: ["hf-ship"], head: "contrib/ship-me" });
      gh.seed({ number: Number(SHIP_KEY), kind: "issue", title: "An ordinary issue to ship", labels: ["hf-ship"] });
    },
    afterStop: () => gh.close(),
    // The seam: no config key, an env key — the client resolves its API base from the repo's env
    // file, and a function form is evaluated after `beforeStart`, once the fake has a port.
    env: () => ({ GITHUB_TOKEN: "ghp_e2e", GITHUB_API_URL: gh.url }),
    configFiles: { "prompts/pr-checkout.md": CHECKOUT_PROMPT },
    config: () => ({
      work_sources: [
        {
          type: "github_issues",
          name: "gh-prs",
          poll_interval_seconds: 1,
          // close_on ALL true on BOTH sources: the strong form of "nothing closes the PR" — the
          // policy is switched on and the source still refuses to apply it to a pull request.
          github_issues: { repo: gh.repo, kind: "pull_requests", close_on: { merged: true, done: true, aborted: true } },
        },
        {
          type: "github_issues",
          name: "gh-issues",
          poll_interval_seconds: 1,
          github_issues: { repo: gh.repo, close_on: { merged: true, done: true, aborted: true } }, // kind defaults to `issues`
        },
      ],
      belt: [
        {
          name: "review-gh",
          source: "gh-prs",
          label: "hf-review",
          workspace_name: "review/{{work_id}}",
          // Without a `pr` step nothing PRODUCES a pull request, and `in_review` is the
          // produce(pull_request) effect — so a review belt has to ask for it explicitly, or its PR
          // never wears `herdr:in-review`. (The published review-gh example carries this too.)
          effects: [{ on: "enter", step: "review", to: "in_review" }],
          steps: [
            { type: "custom", name: "checkout", prompt_file: "prompts/pr-checkout.md", produces: ["commits"] },
            { type: "review" },
          ],
        },
        {
          name: "ship-gh",
          source: "gh-issues",
          label: "hf-ship",
          workspace_name: "ship/{{work_id}}",
          steps: [{ type: "work" }],
        },
      ],
    }),
    // The checkout station writes nothing; the review gate is read-only by charter.
    agent: { steps: { checkout: { commit: false }, review: { commit: false } } },
  },
  async (w) => {
    // ── 1. an opted-in source returns the labelled PR, and not the labelled issue ────────────────
    await w.waitFor(() => w.db.run(PR_KEY) !== undefined, { label: "the labelled PR is claimed", timeoutMs: 120_000 });
    expect(w.db.run(PR_KEY)!.belt, "the PR was claimed by the PR belt").toBe("review-gh");
    expect(w.db.run(PR_KEY)!.summary).toBe("Tidy the widget");

    // ── 2. …and the mirror image: a default source still skips every PR ──────────────────────────
    // The CONTROL first: the issues belt is alive and really polling, so "it claimed no PR" below is
    // a fact about the filter rather than about a belt that never ran.
    await w.waitFor(() => w.db.run(SHIP_KEY) !== undefined, { label: "the issues belt claims its own issue", timeoutMs: 120_000 });
    expect(w.db.run(SHIP_KEY)!.belt).toBe("ship-gh");
    expect(w.db.run(SHIP_PR_KEY), "a default `kind: issues` source never claims a PR").toBeUndefined();
    expect(w.db.run(PR_ISSUE_KEY), "…and a `kind: pull_requests` source never claims an issue").toBeUndefined();

    // ── 3. the claim consumed the trigger label; the state labels are on the PR itself ───────────
    // Asserted on the REQUEST LOG, not on the current labels: a state label is transient (the next
    // swap removes it, and this belt is fast), so "was it ever applied" is the durable question.
    const labelPosts = (n: string) => gh.requests(`POST /repos/${gh.repo}/issues/${n}/labels`).map((r) => r.body).join("\n");
    // The client percent-encodes a label name into the DELETE path (`herdr%3Ain-development`), so
    // compare decoded — an encoded-form literal here would be a silently-never-matching assertion.
    const labelRemoved = (n: string, label: string) =>
      gh.requests().some((r) => r.method === "DELETE" && decodeURIComponent(r.path) === `/repos/${gh.repo}/issues/${n}/labels/${label}`);
    await w.waitFor(() => labelPosts(PR_KEY).includes("herdr:in-development"), { label: "in_development lands on the PR", timeoutMs: 120_000 });
    await w.waitFor(() => labelRemoved(PR_KEY, "hf-review"), { label: "the trigger label is consumed", timeoutMs: 120_000 });
    expect(gh.labels(Number(PR_KEY)), "…so re-adding the trigger is the retry gesture").not.toContain("hf-review");
    // The engine created the state label on the repo on demand (a fresh repo needs no label setup).
    expect(gh.repoLabels.has("herdr:in-development")).toBe(true);
    // Neither untouched item was decorated.
    expect(gh.labels(Number(PR_ISSUE_KEY))).toEqual(["hf-review"]);
    expect(gh.labels(Number(SHIP_PR_KEY))).toEqual(["hf-ship"]);

    // The work doc really came from the PR: its head branch is in it (the `GET /pulls/{n}` read).
    const checkoutPrompt = w.renderedPrompt("checkout");
    expect(checkoutPrompt, "the checkout station was prompted").toBeTruthy();
    expect(checkoutPrompt!).toContain(`# Check out pull request #${PR_KEY}`);
    expect(checkoutPrompt!, "no token may reach an agent unrendered").not.toMatch(/@@[A-Z_]+@@/);
    expect(gh.requests(`GET /repos/${gh.repo}/pulls/${PR_KEY}`).length, "materialize read the PR's branches").toBeGreaterThan(0);

    // The review step's state label lands on the PR too — same swap as an issue.
    await w.waitFor(() => labelPosts(PR_KEY).includes("herdr:in-review"), { label: "in_review reaches the PR", timeoutMs: 180_000 });
    await w.waitFor(() => labelRemoved(PR_KEY, "herdr:in-development"), { label: "the swap removes the previous state label", timeoutMs: 120_000 });

    // ── 4. nothing closes the PR ─────────────────────────────────────────────────────────────────
    // No `pr` step on a review belt (the PR already exists), so the run ends `completed` at the last
    // step-done and the source is driven to its terminal write-back.
    await w.waitForEnd(PR_KEY, "completed", { label: "the review belt ends without a PR step", timeoutMs: 180_000 });
    await w.waitForEnd(SHIP_KEY, "completed", { label: "the issues belt ends too", timeoutMs: 180_000 });

    // The issue belt's terminal write-back DID close its issue — so `close_on` is demonstrably on,
    // and the PR's staying open is the source refusing to apply it, not the policy being off.
    await w.waitFor(() => gh.state(Number(SHIP_KEY)) === "closed", { label: "close_on.done closes the ISSUE", timeoutMs: 120_000 });
    expect(gh.stateReason(Number(SHIP_KEY))).toBe("completed");

    expect(gh.state(Number(PR_KEY)), "a PR run never closes the pull request — merging stays the operator's").toBe("open");
    expect(
      gh.closeAttempts().map((r) => `${r.method} ${r.path} ${r.body}`),
      "the engine must not even ATTEMPT to close the PR",
    ).toEqual([`PATCH /repos/${gh.repo}/issues/${SHIP_KEY} {"state":"closed","state_reason":"completed"}`]);

    // Terminal hygiene still ran on the PR: the in-flight state labels are stripped, and nothing
    // decorated it with the aborted label.
    expect(gh.labels(Number(PR_KEY))).not.toContain("herdr:in-review");
    expect(gh.labels(Number(PR_KEY))).not.toContain("herdr:aborted");
  },
);
