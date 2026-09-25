// A question nobody sees is a wedge nobody sees: `waiting_for_human` holds no slot, so the fleet looks
// healthy while the run sits. The factory has to TELL the operator — once when the question posts,
// again every `attention_renotify_seconds` while it's pending and never more often — and a run that
// ends with its question still open must not leave it `pending` forever (#111).
//
// Real lane on purpose: the notify is a `herdr notification show` argv, observed through the world's
// herdr wrapper. The renotify window is compressed to 5s so the throttle is observable in seconds.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

const WINDOW_S = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

scenario(
  {
    name: "ask-human-notify",
    briefs: { "unseen-question": "# Unseen question\n\nThe agent asks; nobody answers.\n" },
    config: (p) => ({
      limits: { attention_renotify_seconds: WINDOW_S, step_budget_seconds: 600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "asking", source: "briefs", workspace_name: "n/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { steps: { work: { signal: "ask-human", text: "Should the banner be blue or green?\nLonger context the notify must not carry." } } },
  },
  async (w) => {
    const key = "unseen-question";
    const asks = () => w.herdr.notifications().filter((n) => n.title.includes(key) && /asks a human/.test(n.title));
    const renotifies = () => w.herdr.calls().filter((c) => c.argv[0] === "notification" && c.argv[1] === "show" && /still waiting for a human/.test(c.argv[2] ?? "") && (c.argv[2] ?? "").includes(key));

    await w.waitFor(() => w.db.run(key)?.phase === "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 90_000 });

    // ── asking notifies once, with the question's first line only ──────────────────────────────
    await w.waitFor(() => asks().length > 0, { label: "posting the question notifies the operator" });
    expect(asks(), "exactly one ask notification").toHaveLength(1);
    expect(asks()[0]!.body).toContain("Should the banner be blue or green?");
    expect(asks()[0]!.body, "the body is the first line, not the whole question").not.toContain("Longer context");

    // ── pending past one window → exactly one renotify ─────────────────────────────────────────
    await w.waitFor(() => renotifies().length >= 1, { label: "an unanswered question renotifies after the window", timeoutMs: 30_000 });
    expect(renotifies(), "one window ⇒ one renotify").toHaveLength(1);

    // ── ticks inside the next window add none ──────────────────────────────────────────────────
    // The serve driver ticks every second; sit out most of the next window and count again.
    const first = renotifies()[0]!.ts;
    await sleep(Math.max(0, first + (WINDOW_S - 2) * 1000 - Date.now()));
    expect(renotifies(), "no renotify inside the throttle window").toHaveLength(1);

    // And across several windows the spacing never drops below one window (the engine clock is whole
    // seconds, so a window can be up to 1s short in wall-clock ms).
    await sleep(WINDOW_S * 2 * 1000);
    const ts = renotifies().map((c) => c.ts);
    expect(ts.length, "it keeps renotifying while pending").toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!, `renotify ${i} came inside the window`).toBeGreaterThanOrEqual((WINDOW_S - 1) * 1000);
    expect(asks(), "the ask notification is never repeated").toHaveLength(1);

    // ── ending the run leaves no pending question ──────────────────────────────────────────────
    const run = w.db.run(key)!;
    const teardown = w.factory.cli(["teardown", key]);
    expect(teardown.code, `teardown: ${teardown.stderr || teardown.stdout}`).toBe(0);
    await w.waitForEnd(key, "abandoned", { label: "the torn-down run ends", timeoutMs: 120_000 });

    const questions = w.db.humanQuestions(run.id);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.filter((q) => q.status === "pending"), "no question outlives its run").toHaveLength(0);
    expect(questions.some((q) => q.status === "abandoned"), "the open question is closed as abandoned").toBe(true);
    const livePolls = w.db.intents({ kind: "human_reply_poll", runId: run.id }).filter((i) => i.status === "waiting" || i.status === "pending");
    expect(livePolls, "its reply-poll clock is closed too").toHaveLength(0);
  },
);
