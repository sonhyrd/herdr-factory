import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraSource, type JiraSourceCfg } from "../src/clients/jira-source.ts";
import { JiraApiTokenAuth } from "../src/auth/jira-provider.ts";

const CFG: JiraSourceCfg = {
  baseUrl: "https://x.atlassian.net",
  project: "RWR",
  board: "254",
  statusTodo: "To Do",
  statusInDev: "In development",
  statusReview: "Ready for Code Review",
  statusExtra: {},
};
// The belt's pickup label — a per-belt arg to listEligible now, not source config.
const LABEL = "agent";

const tmps: string[] = [];
let fetchCalls: { url: string; method: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  // Stub fetch: every GET returns an issue already in "In development" (so a mapped transition
  // is a case-insensitive no-op after a single getIssue call); attachments are empty.
  globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
    const body = { key: "RWR-1", fields: { summary: "s", status: { name: "In development" }, issuetype: { name: "Bug" }, attachment: [] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

describe("JiraSource", () => {
  const src = () => new JiraSource(CFG, new JiraApiTokenAuth(CFG.baseUrl, "me@x.com", "tok"));

  // The single most load-bearing parity guarantee: unmapped canonical states (merged/aborted) —
  // which teardown writes for every run — must NOT touch the network, so teardown stays
  // Jira-silent exactly as it was before multi-source.
  it("transition(merged) and transition(aborted) make ZERO fetch calls and return noop", async () => {
    expect(await src().transition("RWR-1", "merged")).toEqual({ kind: "noop" });
    expect(await src().transition("RWR-1", "aborted")).toEqual({ kind: "noop" });
    expect(fetchCalls.length).toBe(0);
  });

  it("statusDone unset ⇒ merged/done are NOT in mappedStates (opt-in default)", () => {
    expect(src().spec.mappedStates).toEqual(["todo", "in_development", "in_review"]);
  });

  // Opt-in terminal: with `statusDone` configured, a merged PR (and a custom belt's success) moves
  // the ticket to that status at teardown; aborted stays untouched.
  describe("with statusDone configured (opt-in)", () => {
    const CFG_DONE: JiraSourceCfg = { ...CFG, statusDone: "Done" };
    const doneSrc = () => new JiraSource(CFG_DONE, new JiraApiTokenAuth(CFG_DONE.baseUrl, "me@x.com", "tok"));

    it("adds merged/done to mappedStates and reports the mapping in terminalAutomation", () => {
      expect(doneSrc().spec.mappedStates).toEqual(["todo", "in_development", "in_review", "merged", "done"]);
      expect(doneSrc().spec.terminalAutomation).toContain('"Done"');
    });

    for (const state of ["merged", "done"] as const) {
      it(`transition(${state}) maps to statusDone and POSTs the transition`, async () => {
        // Issue currently "In development"; statusDone "Done" → a real move.
        globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
          const u = String(url);
          const method = init?.method ?? "GET";
          fetchCalls.push({ url: u, method });
          if (u.includes("/transitions") && method === "GET") {
            return { ok: true, status: 200, text: async () => JSON.stringify(({ transitions: [{ id: "77", to: { name: "Done" } }] })), headers: new Headers() } as Response;
          }
          const body = { key: "RWR-1", fields: { summary: "s", status: { name: "In development" }, issuetype: { name: "Bug" }, attachment: [] } };
          return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
        }) as typeof fetch;
        expect(await doneSrc().transition("RWR-1", state)).toEqual({ kind: "applied" });
        expect(fetchCalls.some((c) => c.method === "POST" && c.url.includes("/transitions"))).toBe(true);
      });
    }

    it("transition(aborted) is STILL a zero-network noop even with statusDone set", async () => {
      expect(await doneSrc().transition("RWR-1", "aborted")).toEqual({ kind: "noop" });
      expect(fetchCalls.length).toBe(0);
    });
  });

  // Belt-effect custom status: transition's statusOverride resolves to a widened status.<key> entry
  // (INV-13) and moves the ticket there INSTEAD of the canonical mapping for `to`.
  describe("with a belt-effect custom status (statusExtra)", () => {
    const CFG_QA: JiraSourceCfg = { ...CFG, statusExtra: { qa: "QA Review" } };
    const qaSrc = () => new JiraSource(CFG_QA, new JiraApiTokenAuth(CFG_QA.baseUrl, "me@x.com", "tok"));

    it('statusOverride "qa" transitions the ticket to "QA Review" (ignoring the canonical mapping for `to`)', async () => {
      globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        fetchCalls.push({ url: u, method });
        if (u.includes("/transitions") && method === "GET") {
          return { ok: true, status: 200, text: async () => JSON.stringify({ transitions: [{ id: "9", to: { name: "QA Review" } }] }), headers: new Headers() } as Response;
        }
        const body = { key: "RWR-1", fields: { summary: "s", status: { name: "In development" }, issuetype: { name: "Bug" }, attachment: [] } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
      }) as typeof fetch;
      // `to` is the anchor (in_review) but the override moves to "QA Review", not the canonical "In Review".
      const result = await qaSrc().transition("RWR-1", "in_review", undefined, undefined, "qa");
      expect(result).toEqual({ kind: "applied" });
      const post = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
      expect(post).toBeDefined();
    });
  });

  it("transition(in_development) maps to the configured status and DOES hit the network", async () => {
    const result = await src().transition("RWR-1", "in_development");
    expect(result).toEqual({ kind: "noop" }); // already there (case-insensitive) → no POST, but it queried
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0]!.url).toContain("/rest/api/3/issue/RWR-1");
  });

  it("transition(in_review) maps to the configured status and POSTs when the status differs", async () => {
    // Issue currently "In development"; target maps to "Ready for Code Review" → a real move.
    globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: u, method });
      if (u.includes("/transitions") && method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify(({ transitions: [{ id: "42", to: { name: "Ready for Code Review" } }] })), headers: new Headers() } as Response;
      }
      const body = { key: "RWR-1", fields: { summary: "s", status: { name: "In development" }, issuetype: { name: "Bug" }, attachment: [] } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
    }) as typeof fetch;
    const result = await src().transition("RWR-1", "in_review");
    expect(result).toEqual({ kind: "applied" });
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.includes("/transitions"))).toBe(true);
  });

  it("workDoc names ticket.json without touching the network", async () => {
    expect(await src().workDoc()).toEqual({ path: "ticket.json", kind: "Jira ticket (JSON)" });
    expect(fetchCalls.length).toBe(0);
  });

  it("postNote posts a marker-tagged comment (INV-6 — never mistakable for a human reply)", async () => {
    let posted = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      posted = String(init?.body ?? "");
      return { ok: true, status: 201, text: async () => JSON.stringify(({ id: "10001", created: "2026-06-28T00:00:00.000+0000" })), headers: new Headers() } as Response;
    }) as typeof fetch;
    await src().postNote("RWR-1", "⚠ parked for attention");
    expect(posted).toContain("[herdr-factory]");
    expect(posted).toContain("parked for attention");
  });

  // The claim ledger (INV-10) must see an OLD claim comment on a busy ticket — one 100-comment page
  // would miss it, so listClaimComments pages the whole thread.
  it("listClaimComments pages past 100 comments (walks startAt until total)", async () => {
    const total = 250;
    const all = Array.from({ length: total }, (_, i) => ({ id: String(1000 + i), body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `c${i}` }] }] } }));
    globalThis.fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      fetchCalls.push({ url: u.pathname + u.search, method: "GET" });
      const startAt = Number(u.searchParams.get("startAt") ?? "0");
      const max = Number(u.searchParams.get("maxResults") ?? "100");
      const body = { startAt, maxResults: max, total, comments: all.slice(startAt, startAt + max) };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
    }) as typeof fetch;
    const comments = await src().listClaimComments("RWR-1");
    expect(comments.length).toBe(total);
    expect(comments[0]!.body).toBe("c0");
    expect(comments.at(-1)!.body).toBe("c249");
    expect(fetchCalls.map((c) => new URL(c.url, "https://x").searchParams.get("startAt"))).toEqual(["0", "100", "200"]);
  });

  it("describe maps a Jira issue to a Ticket", async () => {
    const t = await src().describe("RWR-1");
    expect(t).toEqual({ key: "RWR-1", summary: "s", type: "Bug" });
  });

  it("listEligible returns the jira match item (status + labels + raw fields)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/rest/agile/1.0/board/254/issue")) {
        const issues = [{ key: "RWR-9", fields: { summary: "Crash on save", issuetype: { name: "Bug" }, status: { name: "To Do" }, labels: ["agent", "p1"] } }];
        return { ok: true, status: 200, text: async () => JSON.stringify(({ issues })), headers: new Headers() } as Response;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(({})), headers: new Headers() } as Response;
    }) as typeof fetch;
    const items = await src().listEligible(LABEL);
    expect(items.length).toBe(1);
    expect(items[0]!).toMatchObject({ sourceType: "jira", key: "RWR-9", summary: "Crash on save", type: "Bug", status: "To Do", labels: ["agent", "p1"] });
  });

  it("materialize writes ticket.json (idempotent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jira-mat-"));
    tmps.push(dir);
    await src().materialize("RWR-1", dir, () => {});
    expect(existsSync(join(dir, "ticket.json"))).toBe(true);
    const after = fetchCalls.length;
    await src().materialize("RWR-1", dir, () => {}); // idempotent: ticket.json exists → no work
    expect(fetchCalls.length).toBe(after);
  });

  it("askHuman posts a marked Jira comment — after scanning for an earlier post (INV-5 idempotency)", async () => {
    let posted = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: String(url), method });
      if (method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ comments: [] }), headers: new Headers() } as Response;
      }
      posted = String(init?.body ?? "");
      return { ok: true, status: 201, text: async () => JSON.stringify(({ id: "10000", created: "2026-06-28T00:00:00.000+0000" })), headers: new Headers() } as Response;
    }) as typeof fetch;

    const res = await src().askHuman({ repo: "demo", runId: 7, questionId: 3, key: "RWR-1", step: "fix", question: "Which path should win?" });

    expect(res.externalId).toBe("10000");
    // Scan first (a lost response must not double-ask the human), then post.
    expect(fetchCalls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(fetchCalls[1]!.url).toBe("https://x.atlassian.net/rest/api/3/issue/RWR-1/comment");
    expect(posted).toContain("herdr-factory question: demo/7/3");
    expect(posted).toContain("Which path should win?");
  });

  it("askHuman finds its own earlier question instead of re-posting (lost-response recovery)", async () => {
    const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: String(url), method });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ comments: [{ id: "9999", created: "2026-06-28T00:00:00.000+0000", body: adf("[herdr-factory question: demo/7/3]\nWhich path should win?") }] }),
        headers: new Headers(),
      } as Response;
    }) as typeof fetch;

    const res = await src().askHuman({ repo: "demo", runId: 7, questionId: 3, key: "RWR-1", step: "fix", question: "Which path should win?" });

    expect(res.externalId).toBe("9999"); // the earlier post, found by its marker
    expect(fetchCalls.every((c) => c.method === "GET")).toBe(true); // nothing re-posted
  });

  it("pollHumanReply returns the first later non-question Jira comment", async () => {
    const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            comments: [
              { id: "q1", created: "2026-06-28T00:00:00.000+0000", body: adf("[herdr-factory question: demo/7/3]") },
              { id: "a1", created: "2026-06-28T00:01:00.000+0000", author: { displayName: "Pat" }, body: adf("Use the new behavior.") },
            ],
          }),
        headers: new Headers(),
      } as Response;
    }) as typeof fetch;

    const reply = await src().pollHumanReply({ key: "RWR-1", questionId: 3, externalId: "q1", externalCreatedAt: "2026-06-28T00:00:00.000+0000" });

    expect(reply).toMatchObject({ body: "Use the new behavior.", externalId: "a1", author: "Pat" });
  });

  it("pollHumanReply skips marker-tagged notes but accepts a quote-reply that embeds the question", async () => {
    const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            comments: [
              { id: "q1", created: "2026-06-28T00:00:00.000+0000", body: adf("[herdr-factory question: demo/7/3]") },
              // A marked attention note posted while the question was pending — must be skipped
              // (this is the reply-poisoning hazard the widened filter closes).
              { id: "n1", created: "2026-06-28T00:00:30.000+0000", body: adf("[herdr-factory] ⚠ parked for attention") },
              // A human reply that QUOTES the question (marker inside a blockquote) — must be accepted.
              { id: "a1", created: "2026-06-28T00:01:00.000+0000", author: { displayName: "Pat" }, body: adf("> [herdr-factory question: demo/7/3]\nGo with option B.") },
            ],
          }),
        headers: new Headers(),
      } as Response;
    }) as typeof fetch;

    const reply = await src().pollHumanReply({ key: "RWR-1", questionId: 3, externalId: "q1", externalCreatedAt: "2026-06-28T00:00:00.000+0000" });

    expect(reply).toMatchObject({ externalId: "a1", author: "Pat" });
    expect(reply!.body).toContain("Go with option B.");
  });

  // Issue #123: with human_reply.authors set, only an allowlisted author answers; the rest are reported once per poll.
  it("pollHumanReply with replyAuthors skips non-allowlisted authors and reports them via onIgnored", async () => {
    const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const comments = [
      { id: "q1", created: "2026-06-28T00:00:00.000+0000", body: adf("[herdr-factory question: demo/7/3]") },
      { id: "qa1", created: "2026-06-28T00:01:00.000+0000", author: { displayName: "QA Bot", accountId: "acc-qa" }, body: adf("Test Summary: PASS") },
    ];
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify({ comments }), headers: new Headers() }) as Response) as typeof fetch;
    const gated = new JiraSource({ ...CFG, replyAuthors: ["acc-op"] }, new JiraApiTokenAuth(CFG.baseUrl, "me@x.com", "tok"));
    const ignored: { externalId: string; author: string | null }[] = [];
    const poll = { key: "RWR-1", questionId: 3, externalId: "q1", externalCreatedAt: "2026-06-28T00:00:00.000+0000", onIgnored: (c: { externalId: string; author: string | null }) => ignored.push(c) };

    expect(await gated.pollHumanReply(poll)).toBeNull();
    expect(ignored).toEqual([{ externalId: "qa1", author: "QA Bot" }]);

    comments.push({ id: "a1", created: "2026-06-28T00:02:00.000+0000", author: { displayName: "Operator", accountId: "acc-op" }, body: adf("Go ahead.") });
    expect(await gated.pollHumanReply(poll)).toMatchObject({ externalId: "a1", body: "Go ahead.", author: "Operator" });
    // Display name matches too, case-insensitively.
    const byName = new JiraSource({ ...CFG, replyAuthors: ["operator"] }, new JiraApiTokenAuth(CFG.baseUrl, "me@x.com", "tok"));
    expect(await byName.pollHumanReply(poll)).toMatchObject({ externalId: "a1" });
    // Unset ⇒ anyone answers (today's behavior): the QA comment wins.
    expect(await src().pollHumanReply(poll)).toMatchObject({ externalId: "qa1" });
  });

  // Edit detection (issue #97): the description and every other rich-text field (acceptance criteria
  // is a per-site custom field), named by the `names` map; status/labels/rank never count.
  it("workContent returns the ADF fields by display name plus the updated time", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      fetchCalls.push({ url: String(url), method: "GET" });
      const doc = (t: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
      const body = {
        fields: { summary: "s", updated: "2026-09-24T10:45:00.000+0000", description: doc("Build it."), customfield_10050: doc("Shows 10 rows."), customfield_10019: "0|i00abc:", labels: ["agent"], status: { name: "To Do" } },
        names: { description: "Description", customfield_10050: "Acceptance criteria", customfield_10019: "Rank" },
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
    }) as typeof fetch;
    expect(await src().workContent("RWR-1")).toEqual({
      updated: "2026-09-24T10:45:00.000+0000",
      fields: { Description: "Build it.", "Acceptance criteria": "Shows 10 rows." },
    });
    expect(fetchCalls[0]!.url).toContain("fields=*all&expand=names");
  });
});
