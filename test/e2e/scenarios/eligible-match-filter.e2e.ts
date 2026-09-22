// What the board is allowed to call READY. A `match` predicate used to run only at the CLAIM: the
// tick cached the source's raw answer, and `GET /repos/<r>/eligible` served it unfiltered. On a host
// running two repo configs over ONE Jira query — the same JQL, the same pickup label, different
// `match` files — each repo therefore advertised the other's tickets as ready, forever, because
// nothing on that repo would ever claim them and make them go away.
//
// This is a two-repo host on one source, which is the only shape the defect has. Everything is read
// through the real HTTP route on a resident server (and the CLI beside it), because `lastEligible`
// being right is not the claim — the claim is that what an operator SEES is what this repo would
// claim.
import { expect } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JiraFake } from "../harness/sources/jira-fake.ts";
import { scenario } from "../harness/index.ts";

const jira = new JiraFake({ project: "APP", boardId: 42 });

/** The board-issue endpoint the pickup poll uses — `listEligible` and nothing else. */
const POLL = "/rest/agile/";
/** Dashboard refreshes standing in for a TUI left open (3s cadence ⇒ ~1 minute). */
const REFRESHES = 20;
/** The second repo config on this same host, over the same Jira query. */
const BETA = "beta-repo";

/** Repo `alpha` claims the `[alpha]` tickets — and cannot classify a `[boom]` one, loudly. */
const MATCH_ALPHA = `export default ({ item }) => {
  if (item.summary.includes("[boom]")) throw new Error("alpha cannot classify this item");
  return item.summary.includes("[alpha]");
};
`;
/** Repo `beta` claims the `[beta]` tickets, and is merely uninterested in everything else. */
const MATCH_BETA = `export default ({ item }) => item.summary.includes("[beta]");
`;

interface EligibleBody {
  eligible: { source: string; belt: string; key: string; summary: string; type: string; polledAt?: number }[];
}

const jiraSource = () => ({
  type: "jira",
  name: "board",
  jira: {
    base_url: jira.url,
    project: "APP",
    board: 42,
    status: { todo: "To Do", in_development: "In Progress", review: "In Review" },
  },
});

/** Both repos are the same config but for their `match` file — which is the whole point: the only
 *  thing telling these two apart is the predicate, and it has to be enough. */
const repoConfig = (belt: string) => () => ({
  limits: {
    // Every pass after boot is one this scenario drove, so a per-pass call count means something.
    tick_interval_seconds: 3600,
    source_poll_interval_seconds: 3600,
    // One slot per repo: the belt claims its first accepted ticket and the second stays READY, which
    // is the row this scenario is about.
    max_active_workspaces: 1,
    // The claimed agent sits still for the whole scenario; no watchdog may park it mid-run.
    step_budget_seconds: 3600,
    stall_seconds: 3600,
  },
  work_sources: [jiraSource()],
  // `match.ts` is resolved against this repo's OWN config folder, so each repo gets its own.
  belt: [{ name: belt, source: "board", label: "agent", match: "match.ts", workspace_name: `${belt}/{{work_id}}`, steps: [{ type: "work" }] }],
});

scenario(
  {
    name: "eligible-match-filter",
    // Nothing here needs a real pane: each repo claims one agent, which then sits still.
    lane: "fake",
    timeoutMs: 300_000,
    extraRepos: { [BETA]: { config: repoConfig("beta") } },
    config: repoConfig("alpha"),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "token" },
    beforeStart: async (p) => {
      await jira.listen();
      // Two for each repo, plus one neither can place. All carry the SAME pickup label and come back
      // on the SAME query — the source cannot tell these repos apart, only `match` can.
      jira.seed({ key: "APP-1", summary: "[alpha] Fix the login banner", type: "Bug", status: "To Do", labels: ["agent"] });
      jira.seed({ key: "APP-2", summary: "[alpha] Tidy the settings page", type: "Task", status: "To Do", labels: ["agent"] });
      jira.seed({ key: "APP-3", summary: "[beta] Widget spacing", type: "Bug", status: "To Do", labels: ["agent"] });
      jira.seed({ key: "APP-4", summary: "[beta] Widget copy", type: "Task", status: "To Do", labels: ["agent"] });
      jira.seed({ key: "APP-5", summary: "[boom] Unclassifiable", type: "Task", status: "To Do", labels: ["agent"] });

      const alphaDir = p.repoConfigDir;
      const betaDir = join(p.configDir, "repos", BETA);
      writeFileSync(join(alphaDir, "match.ts"), MATCH_ALPHA);
      writeFileSync(join(betaDir, "match.ts"), MATCH_BETA);
      // An extra repo gets no `env` from the harness, and a source with no credentials is PAUSED
      // before it ever polls — which would make every assertion below vacuously true.
      const envFile = join(betaDir, "env");
      writeFileSync(envFile, "JIRA_EMAIL=bot@example.test\nJIRA_API_TOKEN=token\n");
      chmodSync(envFile, 0o600);
    },
    afterStop: () => jira.close(),
    agent: { default: { hangMs: "forever" } },
  },
  async (w) => {
    const eligible = (repo: string) => w.factory.api<EligibleBody>("GET", `/repos/${repo}/eligible`);
    const keysOf = async (repo: string) => (await eligible(repo)).eligible.map((i) => i.key);
    /** The CLI's live read, which is the other half of "the board and the CLI agree". Spawned
     *  asynchronously: this command really dials the source, and the source is this very process. */
    const cliKeys = async (repo: string): Promise<string[]> => {
      const r = await w.factory.cliAsync(["--repo", repo, "eligible"], { repoScoped: false, timeoutMs: 60_000 });
      expect(r.code, `eligible --repo ${repo}: ${r.stderr || r.stdout}`).toBe(0);
      return (JSON.parse(r.stdout) as { key: string }[]).map((i) => i.key);
    };

    // Each repo claims the FIRST ticket its own predicate accepts; the second stays ready. Waiting on
    // both claims is also what pins the poll: after this, every repo is at its cap, so Phase B skips
    // the poll entirely and the snapshots below are stable.
    //
    // Wait for each claim's write-back to LAND, not just for the run row: the claim's own Jira
    // traffic (materialize, the `in_development` transition) is settled work, and measuring the
    // dashboard's cost while it is still in flight would count it against the refreshes below.
    await w.waitFor(
      async () => {
        const beta = await w.factory.api<{ active: { ticketKey: string }[] }>("GET", `/repos/${BETA}/status`);
        return (
          w.db.run("APP-1")?.phase === "running" &&
          beta.active.some((r) => r.ticketKey === "APP-3") &&
          jira.status("APP-1") === "In Progress" &&
          jira.status("APP-3") === "In Progress"
        );
      },
      { label: "each repo claims the first ticket its own match accepts, and its write-back lands", timeoutMs: 180_000, tickEveryMs: 1000 },
    );

    // ── AC1: each repo lists ONLY what its own belts' match accepts ────────────────────────────
    const alphaReady = await keysOf(w.repoName);
    const betaReady = await keysOf(BETA);
    expect(alphaReady, `alpha is ready for its own second ticket and nothing else (saw ${alphaReady.join(", ")})`).toEqual(["APP-2"]);
    expect(betaReady, `beta likewise (saw ${betaReady.join(", ")})`).toEqual(["APP-4"]);
    // Said the other way round, because this is the report the operator filed: neither repo shows a
    // single one of the other's tickets, on a query that returned all of them to both.
    for (const key of ["APP-3", "APP-4"]) expect(alphaReady, `${key} is beta's — alpha would never claim it`).not.toContain(key);
    for (const key of ["APP-1", "APP-2"]) expect(betaReady, `${key} is alpha's — beta would never claim it`).not.toContain(key);
    expect((await eligible(w.repoName)).eligible[0]).toMatchObject({ source: "board", belt: "alpha", summary: "[alpha] Tidy the settings page" });

    // ── AC2: a throwing predicate drops the item, on both repos, for different reasons ─────────
    expect(alphaReady, "alpha's match THREW on APP-5 — a predicate that cannot answer never means yes").not.toContain("APP-5");
    expect(betaReady, "beta's match merely said no").not.toContain("APP-5");
    const boomLines = () => w.factory.repoLog(8000).split("match predicate threw for APP-5").length - 1;
    const boomAfterBoot = boomLines();
    expect(boomAfterBoot, "the drop is on the record, in the claim path's own words").toBeGreaterThan(0);

    // ── AC5: the match runs in the POLL — a dashboard left open still costs the source nothing ─
    jira.reset();
    for (let i = 0; i < REFRESHES; i++) {
      expect(await keysOf(w.repoName), `alpha refresh ${i + 1} serves the same snapshot`).toEqual(alphaReady);
      expect(await keysOf(BETA), `beta refresh ${i + 1} serves the same snapshot`).toEqual(betaReady);
    }
    const polls = jira.requests(POLL).length;
    const anyCall = jira.requests().length;
    w.recordMetrics({ refreshes: REFRESHES, repos: 2, boardPolls: polls, jiraRequests: anyCall });
    expect(polls, `${REFRESHES} refreshes across two repos cost ${polls} board polls`).toBe(0);
    expect(anyCall, `…and ${anyCall} Jira requests of any kind: ${jira.requests().map((r) => `${r.method} ${r.path}`).join(", ")}`).toBe(0);

    // ── AC4: the CLI and the dashboard agree, in the same world, over the same items ───────────
    // The CLI asks the source LIVE and filters it the same way; the route replays the tick's poll.
    // They are two different reads that must not be able to disagree — that disagreement is how the
    // defect was spotted in the first place.
    expect(await cliKeys(w.repoName), "alpha: `eligible` === GET /eligible").toEqual(alphaReady);
    expect(await cliKeys(BETA), "beta: `eligible` === GET /eligible").toEqual(betaReady);

    // ── AC2 (the "once" half): one poll logs the drop ONCE, not once per belt pass ─────────────
    // Free alpha's slot so Phase B really polls again (at the cap it skips the poll altogether).
    const teardown = w.factory.cli(["teardown", "APP-1"]);
    expect(teardown.code, `teardown: ${teardown.stderr || teardown.stdout}`).toBe(0);
    await w.waitForEnd("APP-1", undefined, { label: "alpha's slot is freed", timeoutMs: 120_000, tickEveryMs: 1000 });
    const before = boomLines();
    await w.tick();
    await w.waitFor(() => boomLines() > before, { label: "the fresh poll sees APP-5 again", timeoutMs: 60_000, tickEveryMs: 500 });
    expect(boomLines() - before, "one poll ⇒ one line: the snapshot filter and the claim share one verdict").toBe(1);
  },
);
