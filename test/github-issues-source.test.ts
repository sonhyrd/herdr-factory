import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeGithub, makeSource, makeWired, type FakeGithub } from "./helpers/github-fake.ts";
import { TokenBucket } from "../src/clients/http.ts";
import { githubCallCounts } from "../src/clients/github-budget.ts";
import { isSourceRateLimited, type SourceRateLimitedError } from "../src/core/rate-limit-gate.ts";
import { isGithubIssuesItem, StaleItemError } from "../src/types.ts";
import { GithubIssuesClient, resolveGithubApiBase } from "../src/clients/github-issues.ts";

let fake: FakeGithub | undefined;
const tmps: string[] = [];
afterEach(() => {
  fake?.restore();
  fake = undefined;
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

const mem = () => {
  const d = mkdtempSync(join(tmpdir(), "gh-mat-"));
  tmps.push(d);
  return d;
};

describe("GithubIssuesSource — eligibility", () => {
  it("lists open trigger-labeled issues oldest-first as rich match items", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { title: "Crash on save", labels: ["herdr", "bug"], assignees: [{ login: "pat" }] });
    fake.addIssue(3, { title: "Older first", labels: ["herdr"] });
    fake.addIssue(9, { title: "No trigger", labels: ["bug"] }); // not trigger-labeled
    const items = await makeSource(fake).listEligible();
    expect(items.map((i) => i.key)).toEqual(["3", "7"]); // oldest (lowest number) first
    const item = items[1]!;
    expect(item.sourceType).toBe("github_issues");
    if (!isGithubIssuesItem(item)) throw new Error("unreachable");
    expect(item).toMatchObject({ key: "7", displayKey: "#7", number: 7, summary: "Crash on save", type: "Bug", repo: "acme/tracker", state: "open" });
    expect(item.labels).toContain("herdr");
    expect(item.assignees).toEqual(["pat"]);
    expect(item.url).toContain("/issues/7");
  });

  it("excludes PRs (the issues list interleaves them) and items carrying in-flight state labels", async () => {
    fake = makeFakeGithub();
    fake.addIssue(1, { labels: ["herdr"], pull_request: {} }); // actually a PR
    fake.addIssue(2, { labels: ["herdr", "herdr:in-development"] }); // partial claim / hand-edit
    fake.addIssue(3, { labels: ["herdr", "herdr:in-review"] });
    fake.addIssue(4, { labels: ["herdr", "herdr:aborted"] }); // aborted does NOT gate — retry affordance
    fake.addIssue(5, { labels: ["herdr"] });
    const items = await makeSource(fake).listEligible();
    expect(items.map((i) => i.key)).toEqual(["4", "5"]);
  });

  it("issue type: native issue type wins, then type_labels, then default_type", async () => {
    fake = makeFakeGithub();
    fake.addIssue(1, { labels: ["herdr", "bug"], type: { name: "Task" } }); // native wins over the bug label
    fake.addIssue(2, { labels: ["herdr", "defect"] }); // type_labels: defect → Bug
    fake.addIssue(3, { labels: ["herdr"] }); // default
    const items = await makeSource(fake).listEligible();
    expect(items.map((i) => i.type)).toEqual(["Task", "Bug", "Feature"]);
  });
});

describe("GithubIssuesSource — describe", () => {
  it("returns the canonical bare-number key even for a '#123' spelling (INV-11)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(12, { title: "T12", labels: ["herdr", "bug"] });
    const t = await makeSource(fake).describe("#12");
    expect(t).toMatchObject({ key: "12", displayKey: "#12", summary: "T12", type: "Bug" });
  });

  it("throws for an unknown number, a non-number, and a PR", async () => {
    fake = makeFakeGithub();
    fake.addIssue(5, { pull_request: {} });
    const src = makeSource(fake);
    await expect(src.describe("999")).rejects.toThrow();
    await expect(src.describe("not-a-number")).rejects.toThrow("not an issue number");
    await expect(src.describe("5")).rejects.toThrow("pull request");
  });
});

describe("GithubIssuesSource — transitions (GET → diff → apply)", () => {
  it("in_development: adds the state label, consumes the trigger label LAST; idempotent re-delivery is a noop", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const src = makeSource(fake);
    expect(await src.transition("7", "in_development")).toEqual({ kind: "applied" });
    const labels = fake.issues.get(7)!.labels;
    expect(labels.has("herdr:in-development")).toBe(true);
    expect(labels.has("herdr")).toBe(false); // trigger consumed → drops out of listEligible (INV-1)
    expect(await src.transition("7", "in_development")).toEqual({ kind: "noop" }); // outbox retry
    // The add-then-remove ordering: the label POST must come before the trigger DELETE.
    const mutating = fake.calls.filter((c) => c.method === "POST" || c.method === "DELETE").map((c) => `${c.method} ${c.path}`);
    expect(mutating.indexOf("POST /repos/acme/tracker/issues/7/labels")).toBeLessThan(mutating.indexOf("DELETE /repos/acme/tracker/issues/7/labels/herdr"));
  });

  it("creates missing state labels lazily (and tolerates a 422 already-exists race)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    expect(fake.repoLabels.has("herdr:in-development")).toBe(false);
    await makeSource(fake).transition("7", "in_development");
    expect(fake.repoLabels.has("herdr:in-development")).toBe(true);
  });

  it("belt-effect custom status: statusOverride swaps in the custom label, strips other state labels, keeps the issue open", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr:in-development"] });
    const src = makeSource(fake, { stateLabelsExtra: { qa: "herdr:qa" } });
    // `to` is the anchor (in_review); the override swaps to the "herdr:qa" label instead.
    expect(await src.transition("7", "in_review", undefined, undefined, "qa")).toEqual({ kind: "applied" });
    const labels = fake.issues.get(7)!.labels;
    expect(labels.has("herdr:qa")).toBe(true);
    expect(labels.has("herdr:in-development")).toBe(false); // prior in-flight label removed
    expect(fake.issues.get(7)!.state).toBe("open"); // a custom (pre-terminal) status never closes
    // Idempotent re-delivery (the outbox retries) is a noop once the label is present.
    expect(await src.transition("7", "in_review", undefined, undefined, "qa")).toEqual({ kind: "noop" });
  });

  it("in_review: swaps the state labels; merged: strips labels + closes as completed", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr:in-development"] });
    const src = makeSource(fake);
    expect(await src.transition("7", "in_review")).toEqual({ kind: "applied" });
    expect([...fake.issues.get(7)!.labels]).toEqual(["herdr:in-review"]);
    expect(await src.transition("7", "merged")).toEqual({ kind: "applied" });
    const issue = fake.issues.get(7)!;
    expect(issue.state).toBe("closed");
    expect(issue.state_reason).toBe("completed");
    expect(issue.labels.size).toBe(0);
  });

  it("merged on an already-closed issue (auto-close won the race) is a noop — and never reopens", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { state: "closed", state_reason: "completed", labels: [] });
    expect(await makeSource(fake).transition("7", "merged")).toEqual({ kind: "noop" });
    expect(fake.issues.get(7)!.state).toBe("closed");
  });

  it("aborted: strips in-flight labels, adds the aborted artifact label, issue stays OPEN by default", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr:in-development"] });
    expect(await makeSource(fake).transition("7", "aborted")).toEqual({ kind: "applied" });
    const issue = fake.issues.get(7)!;
    expect(issue.state).toBe("open"); // visible, retriageable failure artifact
    expect([...issue.labels]).toEqual(["herdr:aborted"]);
  });

  it("close_on.aborted: true closes as not_planned", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr:in-development"] });
    await makeSource(fake, { closeOn: { merged: true, done: true, aborted: true } }).transition("7", "aborted");
    const issue = fake.issues.get(7)!;
    expect(issue.state).toBe("closed");
    expect(issue.state_reason).toBe("not_planned");
  });

  it("unmapped state (todo) is a noop with ZERO network (INV-3)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    expect(await makeSource(fake).transition("7", "todo")).toEqual({ kind: "noop" });
    expect(fake.calls.length).toBe(0);
  });

  it("an issue closed by a human BEFORE the claim/review write-back is stale (cancel signal)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { state: "closed", state_reason: "not_planned" });
    const src = makeSource(fake);
    expect((await src.transition("7", "in_development")).kind).toBe("stale");
    expect((await src.transition("7", "in_review")).kind).toBe("stale");
  });

  it("in_review on an issue closed as COMPLETED is a noop — auto-close racing a fast merge, not a cancel", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { state: "closed", state_reason: "completed" });
    const src = makeSource(fake);
    expect((await src.transition("7", "in_review")).kind).toBe("noop"); // PR watch owns the real signal
    expect((await src.transition("7", "in_development")).kind).toBe("stale"); // at claim time it's still a cancel
  });

  it("410 (deleted), 301 (transferred), 404 (inaccessible) → stale with ZERO mutations issued", async () => {
    fake = makeFakeGithub();
    const src = makeSource(fake);
    for (const [n, status, why] of [[1, 410, "deleted"], [2, 301, "transferred"], [3, 404, "not found"]] as const) {
      fake.addIssue(n, { labels: ["herdr:in-development"] });
      fake.gone.set(n, status);
      const res = await src.transition(String(n), "merged");
      expect(res.kind).toBe("stale");
      expect(res.detail).toContain(why);
    }
    expect(fake.mutations()).toBe(0); // the stale probe is the GET; nothing was written anywhere
  });

  it("DELETE of an already-absent label (documented 404) is tolerated, not an error", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr", "herdr:in-review"] }); // in-dev label already absent
    // in_review wants to remove in-development (absent) — must not throw, and land applied for
    // the trigger/label work that DID happen.
    expect((await makeSource(fake).transition("7", "in_review")).kind).toBe("noop"); // already in review + nothing else to do
  });
});

describe("GithubIssuesSource — materialize", () => {
  it("renders task.md (header + closing reference + body + human comments), writes issue.json, idempotent", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { title: "Crash on save", body: "It crashes.\n\n<!-- hidden instruction -->Steps included.", labels: ["herdr", "bug"] });
    fake.addComment(7, "[herdr-factory] ⚠ an old bot note"); // must be excluded
    fake.addComment(7, "Repro: click save twice.", "helpful-human");
    const src = makeSource(fake);
    const dir = mem();
    await src.materialize("7", dir, () => {});
    const task = readFileSync(join(dir, "task.md"), "utf8");
    expect(task).toContain("# Issue #7: Crash on save");
    expect(task).toContain("- Closing reference: Fixes #7"); // same-repo → docs-guaranteed short form
    expect(task).toContain("It crashes.");
    expect(task).not.toContain("hidden instruction"); // HTML comments sanitized out of prompt text
    expect(task).toContain("Repro: click save twice.");
    expect(task).not.toContain("an old bot note");
    expect(existsSync(join(dir, "issue.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, "issue.json"), "utf8"));
    expect(raw.issue.body).toContain("hidden instruction"); // the raw payload keeps everything

    const before = fake.calls.length;
    await src.materialize("7", dir, () => {}); // idempotent — no refetch
    expect(fake.calls.length).toBe(before);
  });

  it("uses the qualified closing reference when the issues repo differs from the PR repo", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const src = makeSource(fake, {}, "acme/product"); // PRs open on acme/product; issues live on acme/tracker
    const dir = mem();
    await src.materialize("7", dir, () => {});
    expect(readFileSync(join(dir, "task.md"), "utf8")).toContain("- Closing reference: Fixes acme/tracker#7");
  });

  it("logs and returns (no task.md) when the issue can't be fetched — the next tick retries", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    fake.gone.set(7, 404);
    const warnings: string[] = [];
    const dir = mem();
    await makeSource(fake).materialize("7", dir, (_l, m) => warnings.push(m));
    expect(existsSync(join(dir, "task.md"))).toBe(false);
    expect(warnings.length).toBe(1);
  });
});

describe("GithubIssuesSource — human loop", () => {
  it("askHuman posts a marked question once and is idempotent per questionId (INV-5)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const src = makeSource(fake);
    const input = { repo: "demo", runId: 4, questionId: 9, key: "7", step: "fix", question: "Which flag wins?" };
    const first = await src.askHuman(input);
    expect(first.externalId).toBeTruthy();
    const again = await src.askHuman(input); // response lost → re-invoked; must find, not re-post
    expect(again.externalId).toBe(first.externalId);
    expect(fake.issues.get(7)!.comments.length).toBe(1);
    expect(fake.issues.get(7)!.comments[0]!.body).toContain("[herdr-factory question: demo/4/9]");
  });

  it("pollHumanReply skips herdr artifacts + pre-question comments, accepts quote-replies, and never author-filters", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    fake.addComment(7, "an OLD human comment before the question"); // created before → excluded
    const src = makeSource(fake);
    const q = await src.askHuman({ repo: "demo", runId: 4, questionId: 9, key: "7", step: "fix", question: "Which flag wins?" });
    const input = { key: "7", questionId: 9, externalId: q.externalId, externalCreatedAt: q.externalCreatedAt };
    expect(await src.pollHumanReply(input)).toBeNull();
    await src.postNote("7", "⚠ parked for attention"); // marked note — must not read as a reply
    expect(await src.pollHumanReply(input)).toBeNull();
    // The reply arrives as a QUOTE-REPLY (GitHub UI) that embeds the question's marker — and from
    // the SAME login the bot posts under (shared gh-CLI identity): both must be accepted.
    fake.addComment(7, "> [herdr-factory question: demo/4/9]\n\nUse the new flag.", "operator");
    const reply = await src.pollHumanReply(input);
    expect(reply).not.toBeNull();
    expect(reply!.body).toContain("Use the new flag.");
    expect(reply!.author).toBe("operator");
  });

  it("askHuman/pollHumanReply on a gone issue throw StaleItemError (escalates instead of polling forever)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    fake.gone.set(7, 410);
    const src = makeSource(fake);
    await expect(src.askHuman({ repo: "demo", runId: 4, questionId: 9, key: "7", step: "fix", question: "?" })).rejects.toThrow(StaleItemError);
    await expect(src.pollHumanReply({ key: "7", questionId: 9, externalId: "1", externalCreatedAt: null })).rejects.toThrow(StaleItemError);
  });
});

describe("GithubIssuesSource — health", () => {
  it("passes on a healthy repo; fails actionably on disabled issues, no push, or a missing trigger label", async () => {
    fake = makeFakeGithub();
    const src = makeSource(fake);
    await expect(src.health()).resolves.toBeUndefined();
    fake.repoLabels.delete("herdr");
    await expect(src.health()).rejects.toThrow('trigger label "herdr" does not exist');
    fake.repoLabels.add("herdr");
    fake.push = false;
    await expect(src.health()).rejects.toThrow("no push/write access");
    fake.push = true;
    fake.hasIssues = false;
    await expect(src.health()).rejects.toThrow("issues are disabled");
  });
});

describe("GithubIssuesSource — workDoc", () => {
  it("names task.md without touching the network", async () => {
    fake = makeFakeGithub();
    const wd = await makeSource(fake).workDoc();
    expect(wd.path).toBe("task.md");
    expect(fake.calls.length).toBe(0);
  });
});

describe("GithubIssuesSource — pagination", () => {
  it("max_pages caps the listing; a short page ends it; oldest-first survives paging", async () => {
    fake = makeFakeGithub();
    for (let n = 1; n <= 150; n++) fake.addIssue(n);
    expect((await makeSource(fake, { maxPages: 1 }).listEligible()).length).toBe(100);
    fake.calls.length = 0;
    const all = await makeSource(fake, { maxPages: 2 }).listEligible();
    expect(all.length).toBe(150);
    expect(all[0]!.key).toBe("1");
    expect(all.at(-1)!.key).toBe("150");
    expect(fake.calls.filter((c) => c.path.endsWith("/issues")).length).toBe(2); // exactly 2 list calls
  });
});

describe("GithubIssuesSource — ensureLabel race", () => {
  it("tolerates the create race: GET says missing, POST answers 422 already-exists — transition still lands", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    fake.repoLabels.add("herdr:in-development"); // it DOES exist…
    fake.denyLabelGetOnce.add("herdr:in-development"); // …but the existence probe lies once (concurrent creator)
    expect((await makeSource(fake).transition("7", "in_development")).kind).toBe("applied");
    expect(fake.issues.get(7)!.labels.has("herdr:in-development")).toBe(true);
  });
});

describe("GithubIssuesSource — materialize media pipeline", () => {
  const UUID = "aaaabbbbccccdddd0000";
  const RAW = `https://github.com/user-attachments/assets/${UUID}`;
  const SIGNED = `https://private-user-images.githubusercontent.com/1/999-${UUID}.png?jwt=tok`;

  it("downloads via body_html's signed URL, rewrites BOTH url forms, and never false-footnotes", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, {
      body: `See the screenshot: ![img](${RAW})`,
      body_html: `<p>See the screenshot: <img src="${SIGNED}"></p>`,
    });
    fake.assets.set(SIGNED, Buffer.from("png-bytes")); // the raw form 404s under a PAT, like real life
    const dir = mem();
    await makeSource(fake).materialize("7", dir, () => {});
    const task = readFileSync(join(dir, "task.md"), "utf8");
    expect(task).toContain("attachments/attachment-1.png");
    expect(task).not.toContain(RAW); // the raw form was rewritten via the shared asset id
    expect(task).not.toContain("could not be downloaded"); // one asset, one download, no false failure
    expect(readFileSync(join(dir, "attachments", "attachment-1.png"), "utf8")).toBe("png-bytes");
    // The 404-under-PAT raw URL was never fetched — the signed download satisfied the asset id.
    expect(fake.fetchedUrls.filter((u) => u === RAW).length).toBe(0);
  });

  it("never fetches lookalike hosts — the allowlist is a parsed-hostname check, not a substring match", async () => {
    fake = makeFakeGithub();
    const EVIL_SUBDOMAIN = "https://camo.githubusercontent.com.evil.net/x.png";
    const EVIL_PATH = "https://evil.net/a/github.com/user-attachments/x.png";
    const EVIL_QUERY = "https://internal.corp:8080/x?user-images.githubusercontent.com";
    fake.addIssue(7, { body: `![a](${EVIL_SUBDOMAIN}) ![b](${EVIL_PATH}) ![c](${EVIL_QUERY})` });
    const dir = mem();
    await makeSource(fake).materialize("7", dir, () => {});
    const task = readFileSync(join(dir, "task.md"), "utf8");
    // Links left untouched, and — the load-bearing part — no fetch ever left for those hosts.
    expect(task).toContain(EVIL_SUBDOMAIN);
    const offHost = fake.fetchedUrls.filter((u) => u.includes("evil") || u.includes("internal.corp"));
    expect(offHost).toEqual([]);
  });

  it("caps downloads at 12 attachments and footnotes what was skipped", async () => {
    fake = makeFakeGithub();
    const urls = Array.from({ length: 13 }, (_, i) => `https://user-images.githubusercontent.com/1/${i}.png`);
    for (const u of urls) fake.assets.set(u, Buffer.from(`bytes-${u}`));
    fake.addIssue(7, { body: urls.map((u) => `![x](${u})`).join(" ") });
    const dir = mem();
    await makeSource(fake).materialize("7", dir, () => {});
    const task = readFileSync(join(dir, "task.md"), "utf8");
    expect(task).toContain("attachment-12"); // 12 downloaded…
    expect(task).toContain("1 attachment(s) could not be downloaded"); // …the 13th footnoted
  });
});

describe("GithubIssuesSource — edited-old-comment trap", () => {
  it("a pre-question comment edited AFTER the question re-enters the since window but is NOT a reply", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const oldId = fake.addComment(7, "an old pre-question comment", "human");
    const src = makeSource(fake);
    const q = await src.askHuman({ repo: "demo", runId: 4, questionId: 9, key: "7", step: "fix", question: "Which flag wins?" });
    fake.editComment(7, oldId, "edited long after the question"); // updated_at now > question created_at
    const reply = await src.pollHumanReply({ key: "7", questionId: 9, externalId: q.externalId, externalCreatedAt: q.externalCreatedAt });
    expect(reply).toBeNull(); // created_at guard holds — hence "reply in a NEW comment"
  });
});

describe("GithubIssuesClient — rate limits + auth", () => {
  it("a 401 with a gh-CLI token refreshes the token exactly once and succeeds", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const { src, tokenCalls } = makeWired(fake);
    fake.failNext.push({ status: 401 });
    const t = await src.describe("7");
    expect(t.key).toBe("7");
    expect(tokenCalls.n).toBe(2); // bootstrap + one refresh
  });

  it("a 401 with an env-provided GITHUB_TOKEN is NOT refreshed (the env token is authoritative)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const { src, tokenCalls } = makeWired(fake, {}, undefined, { envToken: "pat-from-env" });
    fake.failNext.push({ status: 401 });
    await expect(src.describe("7")).rejects.toThrow();
    expect(tokenCalls.n).toBe(0);
  });

  it("a secondary-limit 403 with a short Retry-After is retried and succeeds", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const { src } = makeWired(fake);
    fake.failNext.push({ status: 403, retryAfter: 0, remaining: "30" });
    const t = await src.describe("7");
    expect(t.key).toBe("7");
  });

  it("PRIMARY exhaustion (remaining: 0, reset far away) fails fast as the typed backoff signal, naming the reset", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const { src } = makeWired(fake);
    const farReset = Math.floor(Date.now() / 1000) + 1800; // 30 min out
    fake.failNext.push({ status: 403, remaining: "0", reset: farReset });
    const started = Date.now();
    const e = await src.describe("7").then(
      () => null,
      (x: unknown) => x,
    );
    expect(isSourceRateLimited(e)).toBe(true); // the reconciler holds the SOURCE, not just this call
    const limited = e as SourceRateLimitedError;
    expect(limited.exhausted).toBe(true);
    expect(Math.round(limited.resetAtMs / 1000)).toBe(farReset); // the backend's own reset, not a guess
    expect(limited.detail).toContain("GITHUB_TOKEN"); // …and the account-sharing remedy
    expect(Date.now() - started).toBeLessThan(2_000); // failed fast, not 60s-per-attempt sleeps
    expect(fake.calls.filter((c) => c.path.endsWith("/issues/7")).length).toBe(1); // exactly one attempt
  });

  it("a secondary-limit 403 that OUTLASTS the retries becomes the backoff signal too (Retry-After, budget intact)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const { src } = makeWired(fake);
    for (let i = 0; i < 3; i++) fake.failNext.push({ status: 403, retryAfter: 0, remaining: "30" }); // every attempt
    const e = await src.describe("7").then(
      () => null,
      (x: unknown) => x,
    );
    expect(isSourceRateLimited(e)).toBe(true);
    expect((e as SourceRateLimitedError).exhausted).toBe(false); // a secondary limit, not an empty budget
  });

  it("a 403 with budget left and no Retry-After stays an ordinary error — that is a permission problem, not a limit", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const { src } = makeWired(fake);
    fake.failNext.push({ status: 403, remaining: "4000" });
    const e = await src.describe("7").then(
      () => null,
      (x: unknown) => x,
    );
    expect(isSourceRateLimited(e)).toBe(false); // holding the source would hide a bad scope behind a wait
    expect(String(e)).toMatch(/403/);
  });

  it("counts every REST attempt against the shared account budget — retries included", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const { src } = makeWired(fake);
    const before = githubCallCounts().rest;
    fake.failNext.push({ status: 500 }); // one retry, so the request costs two calls
    await src.describe("7");
    expect(githubCallCounts().rest - before).toBe(2);
  });

  it("mutations acquire EVERY chained budget bucket — the hourly cap blocks even when the minute cap is open", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr", "herdr:in-development"] });
    // Minute bucket wide open; "hourly" bucket pre-drained with ~25/s refill → every mutation
    // must WAIT ≈40ms for a token instead of sailing through the open minute bucket.
    const hourly = new TokenBucket(25, 1);
    hourly.tryTake(); // drain the initial burst token
    const buckets = { read: [new TokenBucket(10_000, 10_000)], mutation: [new TokenBucket(10_000, 10_000), hourly] };
    const { src } = makeWired(fake, {}, undefined, { buckets });
    const started = Date.now();
    expect((await src.transition("7", "in_review")).kind).toBe("applied");
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });
});

describe("GithubIssuesSource — kind: pull_requests", () => {
  const PR_CFG = { kind: "pull_requests" } as const;

  it("an opted-in source claims labelled PRs and skips issues; a default source is the mirror image", async () => {
    fake = makeFakeGithub();
    fake.addIssue(1, { labels: ["herdr"] });
    fake.addPull(2, { labels: ["herdr"], title: "Grok: tidy the widget" });
    fake.addPull(3, { labels: ["other"] }); // not trigger-labeled
    fake.addPull(4, { labels: ["herdr", "herdr:in-development"] }); // in-flight gate still applies
    const prs = await makeSource(fake, PR_CFG).listEligible();
    expect(prs.map((i) => i.key)).toEqual(["2"]);
    const item = prs[0]!;
    if (!isGithubIssuesItem(item)) throw new Error("unreachable");
    expect(item).toMatchObject({ sourceType: "github_issues", key: "2", displayKey: "#2", number: 2, summary: "Grok: tidy the widget", state: "open" });
    expect(item.url).toContain("/pull/2");
    // Unchanged for everyone else: a default source still skips every PR.
    expect((await makeSource(fake).listEligible()).map((i) => i.key)).toEqual(["1"]);
  });

  it("describe accepts a PR and rejects an issue (and the reverse on a default source)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(1, { title: "An issue" });
    fake.addPull(2, { title: "A PR" });
    const prs = makeSource(fake, PR_CFG);
    expect(await prs.describe("#2")).toMatchObject({ key: "2", displayKey: "#2", summary: "A PR" });
    await expect(prs.describe("1")).rejects.toThrow("is an issue, not a pull request");
    await expect(makeSource(fake).describe("2")).rejects.toThrow("is a pull request, not an issue");
  });

  it("claim consumes the trigger label and applies the state labels to the PR", async () => {
    fake = makeFakeGithub();
    fake.addPull(7);
    const src = makeSource(fake, PR_CFG);
    expect(await src.transition("7", "in_development")).toEqual({ kind: "applied" });
    expect(fake.issues.get(7)!.labels.has("herdr:in-development")).toBe(true);
    expect(fake.issues.get(7)!.labels.has("herdr")).toBe(false); // trigger consumed
    expect(await src.transition("7", "in_review")).toEqual({ kind: "applied" });
    expect(fake.issues.get(7)!.labels.has("herdr:in-review")).toBe(true);
    expect(fake.issues.get(7)!.labels.has("herdr:in-development")).toBe(false);
    expect(fake.issues.get(7)!.state).toBe("open");
  });

  it("never closes the PR — close_on does not apply to a pull request", async () => {
    for (const to of ["merged", "done", "aborted"] as const) {
      fake?.restore();
      fake = makeFakeGithub();
      fake.addPull(7, { labels: ["herdr:in-review"] });
      // close_on ALL true — the PR must still be left open; merging stays the operator's.
      const src = makeSource(fake, { ...PR_CFG, closeOn: { merged: true, done: true, aborted: true } });
      await src.transition("7", to);
      expect(fake.issues.get(7)!.state).toBe("open");
      expect(fake.issues.get(7)!.labels.has("herdr:in-review")).toBe(false); // state labels still stripped
      expect(fake.calls.some((c) => c.method === "PATCH")).toBe(false); // nothing even tried
    }
  });

  it("materializes a PR work doc: head/base branch instead of a closing reference", async () => {
    fake = makeFakeGithub();
    fake.addPull(7, { title: "Tidy the widget", body: "Refactor.", head: "grok/tidy-widget", base: "develop" });
    fake.addComment(7, "Please also bump the version.", "reviewer");
    const dir = mem();
    await makeSource(fake, PR_CFG).materialize("7", dir, () => {});
    const task = readFileSync(join(dir, "task.md"), "utf8");
    expect(task).toContain("# Pull request #7: Tidy the widget");
    expect(task).toContain("- Head branch: grok/tidy-widget");
    expect(task).toContain("- Base branch: develop");
    expect(task).toContain("- Checkout: `gh pr checkout 7`");
    expect(task).not.toContain("Closing reference"); // "Fixes #<pr>" would be nonsense
    expect(task).toContain("Please also bump the version.");
    expect(existsSync(join(dir, "issue.json"))).toBe(true);
  });

  it("health does not require the issues tab, and workDoc says pull request", async () => {
    fake = makeFakeGithub();
    const src = makeSource(fake, PR_CFG);
    fake.hasIssues = false; // a PR-polling source does not care
    await expect(src.health()).resolves.toBeUndefined();
    fake.repoLabels.delete("herdr");
    await expect(src.health()).rejects.toThrow("pull requests you want worked");
    expect((await src.workDoc()).kind).toContain("pull request");
  });
});

describe("GithubIssuesClient — GITHUB_API_URL seam", () => {
  it("defaults to api.github.com, trims a trailing slash, and allows a loopback fake", () => {
    expect(resolveGithubApiBase(undefined)).toBe("https://api.github.com");
    expect(resolveGithubApiBase("   ")).toBe("https://api.github.com");
    expect(resolveGithubApiBase("https://ghe.example.com/api/v3/")).toBe("https://ghe.example.com/api/v3");
    expect(resolveGithubApiBase("http://127.0.0.1:8123")).toBe("http://127.0.0.1:8123"); // the e2e fake
  });

  it("refuses a non-URL and a non-loopback plaintext base — the token is sent to it", () => {
    expect(() => resolveGithubApiBase("ghe.example.com")).toThrow(/not a URL/);
    expect(() => resolveGithubApiBase("http://ghe.example.com/api/v3")).toThrow(/must be https/);
  });

  it("every call goes to the configured base, not api.github.com", async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify({ has_issues: true }), headers: new Headers() } as Response;
    }) as typeof fetch;
    try {
      await new GithubIssuesClient("acme/tracker", "tok", undefined, { read: [new TokenBucket(100, 100)], mutation: [new TokenBucket(100, 100)] }, () => {}, "http://127.0.0.1:9/api/v3").getRepo();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual(["http://127.0.0.1:9/api/v3/repos/acme/tracker"]);
  });
});
