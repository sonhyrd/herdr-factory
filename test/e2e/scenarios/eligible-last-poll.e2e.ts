// The read budget of the dashboard. `GET /repos/<r>/eligible` is the TUI's hot path — it refreshes
// every few seconds, on every machine, for every repo — and it used to answer by calling the source
// LIVE for each active belt, outside the poll-interval window and outside the rate-limit gate the
// tick honours. One open dashboard therefore spent the whole (account-wide) GitHub budget and
// delayed the factory's own claims on every host.
//
// So the endpoint now serves the TICK's last successful poll and never dials a source. That is a
// budget property, and a budget decays silently: nothing breaks when a well-meaning change puts the
// live call back, it just costs rate limit again. This counts real HTTP requests reaching a stateful
// Jira over an exact number of dashboard-shaped GETs, which is deterministic in a way a stopwatch
// on a real TUI is not. `driver` is deliberately the default `serve`: `/eligible` has to be the real
// HTTP route on a resident server, not an in-process handler.
import { expect } from "vitest";
import { JiraFake } from "../harness/sources/jira-fake.ts";
import { scenario } from "../harness/index.ts";

const jira = new JiraFake({ project: "APP", boardId: 42 });

/** The board-issue endpoint the pickup poll uses — `listEligible` and nothing else. */
const POLL = "/rest/agile/";
/** How many dashboard refreshes to stand in for a TUI left open (3s cadence ⇒ ~1 minute). */
const REFRESHES = 20;

interface EligibleBody {
  eligible: { source: string; belt: string; key: string; summary: string; type: string; polledAt?: number }[];
}

scenario(
  {
    name: "eligible-last-poll",
    // Nothing here needs a real pane: one agent is claimed and then sits still, holding the only slot.
    lane: "fake",
    timeoutMs: 300_000,
    beforeStart: async () => {
      await jira.listen();
      jira.seed({ key: "APP-1", summary: "Fix the login banner", type: "Bug", status: "To Do", labels: ["agent"] });
      jira.seed({ key: "APP-2", summary: "Tidy the settings page", type: "Task", status: "To Do", labels: ["agent"] });
      // `serve` ticks once as it comes up. Fail that poll so the server starts with NOTHING cached —
      // which is the only way to observe the before-any-successful-tick state from outside.
      jira.failWith = 500;
    },
    afterStop: () => jira.close(),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "token" },
    config: () => ({
      limits: {
        // The server is up, but every pass after boot is one this scenario drove — that is what makes
        // a per-pass call count mean anything. The poll interval matches the tick, so the poll-window
        // gate stays disengaged and each driven pass really does poll.
        tick_interval_seconds: 3600,
        source_poll_interval_seconds: 3600,
        // One slot: APP-1 becomes the active run, APP-2 stays eligible with nowhere to go.
        max_active_workspaces: 1,
        // The claimed agent sits still for the whole scenario; don't let a watchdog park it mid-run.
        step_budget_seconds: 3600,
        stall_seconds: 3600,
      },
      work_sources: [
        {
          type: "jira",
          name: "board",
          jira: {
            base_url: jira.url,
            project: "APP",
            board: 42,
            status: { todo: "To Do", in_development: "In Progress", review: "In Review" },
          },
        },
      ],
      belt: [{ name: "tickets", source: "board", label: "agent", workspace_name: "w/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { default: { hangMs: "forever" } },
  },
  async (w) => {
    const eligible = () => w.factory.repoApi<EligibleBody>("GET", "eligible");
    const failedPolls = () => w.factory.repoLog(5000).split("eligible query failed").length - 1;

    // ── nothing cached yet ────────────────────────────────────────────────────────────────────────
    // Boot's own pass polled the board and got a 500, so there is no snapshot. An endpoint that
    // queried live would happily list both tickets here.
    expect(jira.requests(POLL).length, "the boot pass really did try to poll").toBeGreaterThan(0);
    expect((await eligible()).eligible, "no successful poll yet ⇒ nothing to serve").toEqual([]);
    const bootFailures = failedPolls();

    // ── one successful pass ───────────────────────────────────────────────────────────────────────
    jira.failWith = null;
    // Wait for the claim's write-back to LAND, not just for the run row: the claim's own Jira traffic
    // (materialize, the `in_development` transition) is settled work, and measuring the dashboard's
    // cost while it is still in flight would count it against the refreshes below.
    await w.waitFor(() => w.db.run("APP-1") !== undefined && jira.status("APP-1") === "In Progress", {
      label: "the recovered poll claims the first ticket and the write-back lands",
      timeoutMs: 120_000,
      tickEveryMs: 1000,
    });

    const listed = (await eligible()).eligible;
    expect(listed.map((i) => i.key), "APP-1 holds the only slot, so it is a RUN — only APP-2 is still eligible").toEqual(["APP-2"]);
    expect(listed[0]).toMatchObject({ source: "board", belt: "tickets", summary: "Tidy the settings page", type: "Task" });
    // The poll time rides along so a UI can show the list's age.
    expect(typeof listed[0]!.polledAt, "each item carries the time its poll was taken").toBe("number");
    expect(listed[0]!.polledAt).toBeGreaterThan(0);

    // ── the budget: a dashboard left open costs the source NOTHING ────────────────────────────────
    jira.reset();
    for (let i = 0; i < REFRESHES; i++) {
      expect((await eligible()).eligible, `refresh ${i + 1} serves the same snapshot`).toEqual(listed);
    }
    const polls = jira.requests(POLL).length;
    const anyCall = jira.requests().length;
    w.recordMetrics({ refreshes: REFRESHES, boardPolls: polls, jiraRequests: anyCall });

    expect(polls, `${REFRESHES} dashboard refreshes cost ${polls} board polls`).toBe(0);
    expect(anyCall, `…and ${anyCall} Jira requests of any kind: ${jira.requests().map((r) => `${r.method} ${r.path}`).join(", ")}`).toBe(0);
    // The old shape logged a warn per failed live query; that is the line that appeared ~2,800 times
    // per host per 10 minutes with one TUI open.
    expect(failedPolls(), "no refresh produced an `eligible query failed`").toBe(bootFailures);

    // ── a poll that FAILS leaves the last good list standing ──────────────────────────────────────
    // The slot has to be freed first: while the cap is full Phase B skips the poll altogether, so
    // nothing would fail. (That skip is the gated case, and it is what the 20 refreshes above ran
    // against — zero polls, list intact.)
    const teardown = w.factory.cli(["teardown", "APP-1"]);
    expect(teardown.code, `teardown: ${teardown.stderr || teardown.stdout}`).toBe(0);
    await w.waitForEnd("APP-1", undefined, { label: "the slot is freed", timeoutMs: 120_000, tickEveryMs: 1000 });

    const lastGood = (await eligible()).eligible; // the freshest snapshot, taken by a healthy poll
    const before = failedPolls();
    jira.failWith = 500;
    await w.tick();
    expect(failedPolls(), "that pass really did try, and fail, its poll").toBeGreaterThan(before);
    expect((await eligible()).eligible, "a blip must not blank the board").toEqual(lastGood);
  },
);
