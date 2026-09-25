// Issue #123: on a shared tracker QA, PMs and bots comment on tickets too. With the source's
// `human_reply.authors` set, only a listed author answers a parked question — anyone else's comment
// is skipped, recorded ONCE as `human_reply_ignored` (however many polls re-read it), and counted by
// `explain`. The listed author's comment then resumes the run as usual.
import { expect } from "vitest";
import { JiraFake } from "../harness/sources/jira-fake.ts";
import { scenario } from "../harness/index.ts";

const jira = new JiraFake({ project: "APP", boardId: 254 });

scenario(
  {
    name: "jira-reply-authors",
    timeoutMs: 300_000,
    beforeStart: async () => {
      await jira.listen();
      jira.seed({ key: "APP-12", summary: "Parked on a dependency", type: "Task", status: "To Do", labels: ["agent"] });
    },
    afterStop: () => jira.close(),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "token" },
    config: () => ({
      work_sources: [
        {
          type: "jira",
          name: "board",
          human_reply: { authors: ["Pat Operator"] },
          jira: { base_url: jira.url, project: "APP", board: 254, status: { todo: "To Do", in_development: "In Progress", review: "In Review" } },
        },
      ],
      belt: [{ name: "tickets", source: "board", label: "agent", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { steps: { work: { signal: "ask-human", text: "Reply once the upstream change is deployed." } } },
  },
  async (w) => {
    const key = "APP-12";
    await w.waitFor(() => w.db.run(key)?.phase === "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 240_000 });
    await w.waitFor(() => jira.comments(key).length > 0, { label: "the question is posted to Jira", timeoutMs: 60_000 });

    // ── QA posts a routine summary: not a reply author ─────────────────────────────────────────
    w.setAgentScript({ steps: { work: { signal: "step-done" } } });
    jira.addComment(key, "Test Summary: PASS for the earlier PR.", "Quinn QA");
    const polls = () => jira.requests("/comment").length;
    for (let i = 0; i < 3; i++) {
      const before = polls();
      w.db.dueNow("human_reply_poll", w.db.run(key)!.id);
      await w.waitFor(() => polls() > before, { label: `reply poll ${i + 1} reads the QA comment`, timeoutMs: 90_000 });
    }
    await w.waitForEvent(key, "human_reply_ignored", { timeoutMs: 60_000 });
    expect(w.db.run(key)!.phase, "a non-author comment does not resume the run").toBe("waiting_for_human");

    const timeline = await w.factory.cliAsync(["timeline", key]);
    expect(timeline.stdout.match(/human_reply_ignored/g), "one event per ignored comment, across repeated polls").toHaveLength(1);
    expect(timeline.stdout).toContain("Quinn QA");
    expect((await w.factory.cliAsync(["explain", key])).stdout).toContain("1 comment ignored (not a reply author");

    // ── the listed operator answers ───────────────────────────────────────────────────────────
    jira.addComment(key, "Deployed — go ahead.", "Pat Operator");
    w.db.dueNow("human_reply_poll", w.db.run(key)!.id);
    await w.waitFor(() => w.db.run(key)?.phase === "running", { label: "the operator's reply resumes the step", timeoutMs: 120_000 });
    expect(w.db.eventTypes(key)).toContain("human_reply");
    await w.waitForEnd(key, undefined, { label: "and the run finishes", timeoutMs: 120_000 });
  },
);
