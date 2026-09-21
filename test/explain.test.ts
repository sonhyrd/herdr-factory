// The plain-language narrative over runObligations (core/explain.ts) — the `explain <KEY>` CLI
// body and the TUI detail's "What's happening" section. Fabricated RunObligations fixtures: the
// renderer is pure, so every phase/park is a plain object away.
import { describe, expect, it } from "vitest";
import { explainRun, fmtDur } from "../src/core/explain.ts";
import type { RunObligations } from "../src/core/obligations.ts";

const NOW = 10_000; // epoch seconds — all fixture clocks are relative to this
const REPO = "proj";

function ob(overrides: {
  run?: Partial<RunObligations["run"]>;
  intents?: Partial<RunObligations["intents"]>;
  watches?: Partial<RunObligations["watches"]>;
}): RunObligations {
  return {
    run: {
      id: 7,
      key: "HF-1",
      phase: "running",
      step: "work",
      belt: "ship",
      workSource: "jira",
      prNumber: null,
      resolverActive: false,
      attentionReason: null,
      attentionReasonCode: null,
      ...overrides.run,
    },
    intents: {
      transitions: [],
      evidenceUploads: [],
      pendingSignal: null,
      humanQuestion: null,
      ledger: [],
      ...overrides.intents,
    },
    watches: { step: "work", guards: [], engine: [], bounceCaps: [], idleNudge: null, ...overrides.watches },
  };
}

const joined = (lines: string[]) => lines.join("\n");

describe("fmtDur", () => {
  it("renders coarse durations", () => {
    expect(fmtDur(42)).toBe("42s");
    expect(fmtDur(60)).toBe("1m");
    expect(fmtDur(3900)).toBe("1h 5m");
    expect(fmtDur(7200)).toBe("2h");
    expect(fmtDur(90 * 3600)).toBe("3d 18h");
  });
});

describe("explainRun — phases", () => {
  it("running: budget clock renders with its expiry and total", () => {
    const lines = explainRun({
      ob: ob({
        watches: {
          guards: [
            {
              kind: "budget",
              escalationReason: "step_budget",
              rescue: "terminal-signal",
              facts: { startedAt: NOW - 600, budgetSeconds: 1800, deadlineAt: NOW + 1200 },
            },
          ],
        },
      }),
      repoName: REPO,
      now: NOW,
    });
    expect(lines[0]).toBe("HF-1 — run #7 on belt ship (work step)");
    expect(joined(lines)).toContain("The work step is active.");
    expect(joined(lines)).toContain("budget expires in ~20m (30m total)");
  });

  it("running: an over-budget clock says the next tick parks it", () => {
    const lines = explainRun({
      ob: ob({
        watches: {
          guards: [
            { kind: "budget", escalationReason: "step_budget", rescue: "terminal-signal", facts: { startedAt: 0, budgetSeconds: 100, deadlineAt: NOW - 5 } },
          ],
        },
      }),
      repoName: REPO,
      now: NOW,
    });
    expect(joined(lines)).toContain("over its time budget — the next tick parks it");
  });

  it("running: an undispatched pass explains the dispatch retry and the layout wait window", () => {
    const lines = explainRun({
      ob: ob({
        watches: {
          engine: [{ kind: "pass_staleness", watches: "pass", rescue: "none", facts: { pass: 2, dispatchedAt: null } }],
          guards: [
            {
              kind: "layout_wait",
              escalationReason: "layout_wait_timeout",
              rescue: "respawn",
              facts: { waitingSince: NOW - 120, windowSeconds: 600, respawnsUsed: 1, respawnLimit: 3 },
            },
          ],
        },
      }),
      repoName: REPO,
      now: NOW,
    });
    const text = joined(lines);
    expect(text).toContain("has not reached an agent yet");
    expect(text).toContain("waiting 2m ago"); // the wait clock renders
    expect(text).toContain("re-armed 1 of 3 times");
  });

  it("waiting_for_human: poll cadence, posting state, and the not-a-trap rescue", () => {
    const lines = explainRun({
      ob: ob({
        run: { phase: "waiting_for_human", step: "work" },
        intents: { humanQuestion: { id: 3, step: "work", posted: true, pollAttempts: 4, pollErrors: 0, nextPollAt: NOW + 90 } },
      }),
      repoName: REPO,
      now: NOW,
    });
    const text = joined(lines);
    expect(text).toContain("waits for a human answer to the work step's question");
    expect(text).toContain("holds no workspace slot");
    expect(text).toContain("Reply checks so far: 4; the next check runs in ~1m");
    expect(text).toContain("The wait is not a trap");
    expect(text).toContain("Reply on the work item in a NEW comment");
  });

  it("waiting_for_human: failing polls surface with the escalation threshold", () => {
    const lines = explainRun({
      ob: ob({
        run: { phase: "waiting_for_human" },
        intents: { humanQuestion: { id: 3, step: "work", posted: false, pollAttempts: 9, pollErrors: 6, nextPollAt: NOW + 10 } },
      }),
      repoName: REPO,
      now: NOW,
    });
    const text = joined(lines);
    expect(text).toContain("still queued to post to the source");
    expect(text).toContain("6 reply checks in a row have FAILED");
  });

  it("reviewing: idle watch names the wake condition and the slot behavior", () => {
    const lines = explainRun({
      ob: ob({ run: { phase: "reviewing", step: null, prNumber: 812, resolverActive: false } }),
      repoName: REPO,
      now: NOW,
    });
    const text = joined(lines);
    expect(text).toContain("watches PR #812 until it merges or closes");
    expect(text).toContain("watch is idle and holds no workspace slot");
  });

  it("reviewing: an active resolver is reported instead", () => {
    const lines = explainRun({
      ob: ob({ run: { phase: "reviewing", step: null, prNumber: 812, resolverActive: true } }),
      repoName: REPO,
      now: NOW,
    });
    expect(joined(lines)).toContain("resolver agent is active in the worktree");
  });

  it("claiming: renders the first-step wait", () => {
    const lines = explainRun({
      ob: ob({
        run: { phase: "claiming", step: null },
        watches: {
          step: "work",
          guards: [
            {
              kind: "layout_wait",
              escalationReason: "layout_wait_timeout",
              rescue: "respawn",
              facts: { waitingSince: NOW - 60, windowSeconds: 600, respawnsUsed: 0, respawnLimit: 3 },
            },
          ],
        },
      }),
      repoName: REPO,
      now: NOW,
    });
    const text = joined(lines);
    expect(text).toContain("claiming: the first step (work) has not been dispatched yet");
    expect(text).toContain("this window expires in ~9m");
  });
});

describe("explainRun — attention parks", () => {
  const parked = (code: string, reason: string, extra: Parameters<typeof ob>[0] = {}) =>
    explainRun({
      ob: ob({
        ...extra,
        run: { phase: "attention", attentionReason: reason, attentionReasonCode: code, ...(extra.run ?? {}) },
      }),
      repoName: REPO,
      now: NOW,
    });

  it("step_budget: backstop prose + resume command", () => {
    const text = joined(parked("step_budget", "work step over budget (worker: idle)"));
    expect(text).toContain("ran past its time budget");
    expect(text).toContain("finished but never ran its step-done");
    expect(text).toContain(`herdr-factory --repo ${REPO} resume HF-1`);
  });

  // The fact that tells an operator this is a WEDGED agent, not a slow one: the engine already
  // sent it the idle nudge and it still never signalled (issue #54).
  it("step_budget/step_stalled: an already-nudged idle agent is named as wedged", () => {
    const nudged = { watches: { idleNudge: { idleSince: NOW - 900, nudgedAt: NOW - 600 } } };
    const budget = joined(parked("step_budget", "work step over budget (worker: idle)", nudged));
    expect(budget).toContain("already nudged this idle agent 10m ago");
    expect(budget).toContain("wedged agent, not a slow one");
    expect(budget).not.toContain("finished but never ran its step-done"); // the weaker guess is replaced
    const stalled = joined(parked("step_stalled", "work step stalled (worker: idle)", nudged));
    expect(stalled).toContain("already nudged this idle agent 10m ago");
    // No nudge yet (the window never elapsed) ⇒ no claim about one.
    expect(joined(parked("step_stalled", "work step stalled (worker: idle)", { watches: { idleNudge: { idleSince: NOW - 60, nudgedAt: null } } }))).not.toContain("already nudged");
  });

  it("layout_wait_timeout: reports the spent respawn budget and the plugin-link cause", () => {
    const text = joined(
      parked("layout_wait_timeout", "work: layout pane fix/work never became available", {
        watches: {
          guards: [
            {
              kind: "layout_wait",
              escalationReason: "layout_wait_timeout",
              rescue: "respawn",
              facts: { waitingSince: null, windowSeconds: 600, respawnsUsed: 3, respawnLimit: 3 },
            },
          ],
        },
      }),
    );
    expect(text).toContain("pane never became available");
    expect(text).toContain("3 of 3 respawn windows used");
    expect(text).toContain("herdr plugin link");
  });

  it("bounce_limit: shows the counters and both human options", () => {
    const text = joined(
      parked("bounce_limit", "bounced to work 6× (max 6)", {
        watches: { bounceCaps: [{ step: "work", count: 6, max: 6 }] },
      }),
    );
    expect(text).toContain("hit the bounce cap");
    expect(text).toContain("work ×6 of 6");
    expect(text).toContain("refunds the bounce budget belt-wide");
    expect(text).toContain(`teardown HF-1`);
    // the generic bounce footer must not duplicate the story's own counter line
    expect(text.match(/×6 of 6/g)).toHaveLength(1);
  });

  it("pr_closed: reopen-then-resume guidance", () => {
    const text = joined(parked("pr_closed", "PR #12 closed without merging", { run: { prNumber: 12 } }));
    expect(text).toContain("PR #12 was closed without merging");
    expect(text).toContain("Reopen the PR, then: ");
  });

  it("an unknown (plugin) code falls back to the reason text and the guard's rescue class", () => {
    const text = joined(
      parked("qa_gate_failed", "qa gate rejected the build", {
        watches: {
          guards: [{ kind: "qa_gate", escalationReason: "qa_gate_failed", rescue: "terminal-signal", facts: {} }],
        },
      }),
    );
    expect(text).toContain("qa gate rejected the build");
    expect(text).toContain("backstop, not a verdict");
  });

  it("an unknown code with no matching guard reads as human-only", () => {
    const text = joined(parked("mystery_code", "something odd"));
    expect(text).toContain("needs a human decision");
  });
});

describe("explainRun — the deliver lane (owed to the world)", () => {
  it("renders retrying transitions with attempts, next try, and the last error", () => {
    const lines = explainRun({
      ob: ob({
        intents: {
          transitions: [{ toState: "in_review", toStatus: "QA Review", attempts: 4, nextAttemptAt: NOW + 720, suspended: false, lastError: "HTTP 401 unauthorized", staleUnhandled: false }],
        },
      }),
      repoName: REPO,
      now: NOW,
    });
    const text = joined(lines);
    expect(text).toContain("Owed to the world");
    expect(text).toContain("status write-back → QA Review: attempt 4, next try in ~12m");
    expect(text).toContain("last error: HTTP 401 unauthorized");
  });

  it("an auth-failing evidence upload names the credential fix", () => {
    const text = joined(
      explainRun({
        ob: ob({
          intents: {
            evidenceUploads: [{ keyPrefix: "my-app", attempts: 3, nextAttemptAt: NOW + 480, suspended: false, errorKind: "auth", lastError: "expired SSO token" }],
          },
        }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("evidence upload (my-app): attempt 3, next try in ~8m");
    expect(text).toContain("refresh your credentials");
    expect(text).toContain("last error: expired SSO token");
  });

  it("a due-now retry says the next tick runs it", () => {
    const text = joined(
      explainRun({
        ob: ob({
          intents: {
            transitions: [{ toState: "in_development", toStatus: "", attempts: 2, nextAttemptAt: NOW - 30, suspended: false, lastError: null, staleUnhandled: false }],
          },
        }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("status write-back → in_development: attempt 2, next try due now (the next tick runs it)");
  });

  it("a stale write-back is called out instead of a retry clock", () => {
    const text = joined(
      explainRun({
        ob: ob({
          intents: { transitions: [{ toState: "in_review", toStatus: "", attempts: 9, nextAttemptAt: NOW + 1, suspended: false, lastError: null, staleUnhandled: true }] },
        }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("GONE at the source — the stale policy runs on the next pass");
  });

  it("an external_wait ledger row renders its deadline; narrated kinds are not duplicated", () => {
    const text = joined(
      explainRun({
        ob: ob({
          intents: {
            pendingSignal: { signal: "bounce", step: "review", toStep: "work", createdAt: NOW - 30 },
            ledger: [
              { id: 21, kind: "external_wait", status: "waiting", nextAttemptAt: NOW + 60, suspended: false, deadlineAt: NOW + 3600, handoffOwed: false, lastError: null },
              { id: 22, kind: "agent_signal", status: "pending", nextAttemptAt: NOW + 5, suspended: false, deadlineAt: null, handoffOwed: false, lastError: null },
            ],
          },
        }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("a bounce signal from the agent is recorded");
    expect(text).toContain("external_wait #21 (waiting): deadline in ~1h");
    expect(text).not.toContain("agent_signal #22"); // narrated by the pendingSignal line
  });

  it("a finished-but-unconsumed intent says the run applies it next pass", () => {
    const text = joined(
      explainRun({
        ob: ob({
          intents: {
            ledger: [{ id: 30, kind: "evidence_publish", status: "delivered", nextAttemptAt: NOW, suspended: false, deadlineAt: null, handoffOwed: true, lastError: null }],
          },
        }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("evidence_publish #30 finished — the run applies its result on the next pass");
  });
});

// The tree guard (issue #66): a step that never commits must start from — and finish on — the tree
// it was pinned to. Both halves surface here, because a refused step-done parks nothing: without
// this line an operator sees a running step that simply never finishes.
describe("explainRun — the tree guard", () => {
  it("running: a refused step-done says what is blocking the step and how to clear it", () => {
    const text = joined(
      explainRun({
        ob: ob({
          run: { step: "review" },
          watches: {
            step: "review",
            guards: [
              {
                kind: "read_only",
                escalationReason: "read_only_violation",
                rescue: "terminal-signal",
                facts: { baselineSig: "abc1234", frozenAt: NOW - 600, treeRefusedAt: NOW - 120, treeRefusedWhy: "the worktree has uncommitted changes" },
              },
            ],
          },
        }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("step-done was REFUSED 2m ago: the worktree has uncommitted changes");
    expect(text).toContain("commit or revert");
  });

  it("attention: a dirty_tree park names the step and points at the rework command", () => {
    const text = joined(
      explainRun({
        ob: ob({ run: { phase: "attention", step: "evidence", attentionReason: "evidence cannot start — the worktree has uncommitted changes", attentionReasonCode: "dirty_tree" } }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("the evidence step never commits");
    expect(text).toContain(`herdr-factory --repo ${REPO} rework HF-1 <step>`);
  });
});

describe("explainRun — shape", () => {
  it("heading:false drops the identity line for the TUI detail", () => {
    const lines = explainRun({ ob: ob({}), repoName: REPO, now: NOW, heading: false });
    expect(lines[0]).toBe("The work step is active.");
  });

  it("bounce counters render as a footer outside a bounce_limit park", () => {
    const text = joined(
      explainRun({
        ob: ob({ watches: { bounceCaps: [{ step: "work", count: 2, max: 6 }] } }),
        repoName: REPO,
        now: NOW,
      }),
    );
    expect(text).toContain("Rework bounces so far: work ×2 of 6.");
  });

  it("every known attention code renders without throwing and offers a next action", () => {
    const codes = [
      "step_budget",
      "step_stalled",
      "read_only_violation",
      "dirty_tree",
      "capture_limit",
      "layout_wait_timeout",
      "bounce_limit",
      "pr_closed",
      "source_item_stale",
      "belt_missing",
      "source_missing",
      "unknown_step",
      "human_reply_unknown_step",
      "human_wait_missing_question",
      "human_poll_failing",
      "external_wait_deadline",
    ];
    for (const code of codes) {
      const lines = explainRun({
        ob: ob({ run: { phase: "attention", attentionReason: `reason for ${code}`, attentionReasonCode: code } }),
        repoName: REPO,
        now: NOW,
      });
      expect(joined(lines)).toContain("Next:");
    }
  });
});
