// Issue #72: the machine claim lock must not starve a repo. On a host with `machine.yml`
// `max_active_workspaces`, every repo's Phase B runs its machine count + claims under the
// host-wide `machine:claim` lock — and `serve` starts every repo's tick loop in one pass, on one
// cadence, in one order. With a try-lock that meant the same repo hit the same mid-hold instant
// every tick, skipped its whole claim section, and never claimed again: four hours of
// `machine claim lock held (another repo is claiming)` on one repo while its neighbours claimed.
//
// The unit test proves the wait with `Promise.all(reconcileRepo)`. This proves it where the bug
// lived: a RESIDENT serve fanning out per-repo ticks on one timer, four repos, one state root, one
// DB — and the deferral counter read back by a SEPARATE process, which is the whole reason the
// column is durable rather than in-memory.
//
// Fake-herdr lane: this is about factory claiming, not PTYs or layouts.
import { expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import type { World } from "../harness/index.ts";

const TICK_SECONDS = 2;
/** The host cap, high enough that it only ever reports occupancy — the LOCK is what's under test,
 *  not the capacity gate (a repo refused for capacity would prove nothing about fairness). */
const MACHINE_CAP = 8;
/** The main repo plus the extra repos on this same server: four repos ticking in lockstep. */
const MAIN = "app";
const EXTRA = ["repo-b", "repo-c", "repo-d"] as const;
/** repo → the brief every repo starts with. */
const FIRST: Record<string, string> = { [MAIN]: "a-1", "repo-b": "b-1", "repo-c": "c-1", "repo-d": "d-1" };
/** The repo whose second brief lands while the lock is held by somebody else. */
const STARVED = "repo-d";
const DEFERRED_KEY = "d-2";
/** Phase B waits half a tick interval, floor 10s — so at this tick a deferring repo spends ~10s
 *  of every tick on the wait before giving up, and two deferrals take ~20s. */
const DEFER_WAIT_MS = 150_000;
/** Criterion 1's bound: three tick intervals for the fan-out, plus slack for four real worktree
 *  checkouts. NOT "eventually" — the point of the fix is that no repo has to wait for a later tick. */
const CLAIM_BOUND_MS = 3 * TICK_SECONDS * 1000 + 40_000;

const briefBody = (key: string) => `# ${key}\n\nOne brief for the lockstep claim.\n`;

/** Every repo on this host is the same shape: one markdown source, one one-step belt. */
const repoConfig = (p: { briefs: string }) => ({
  limits: { tick_interval_seconds: TICK_SECONDS, max_active_workspaces: 4 },
  work_sources: [{ type: "local_markdown", name: "briefs", max_active_workspaces: 4, local_markdown: { folder: p.briefs } }],
  belt: [{ name: "ship", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
});

/** The world DB, opened for the ONE write this scenario makes (the harness `Db` is SELECT-only by
 *  discipline). Holding `machine:claim` from outside is how a repo is made to lose the race on
 *  demand — the same thing the unit test does with `store.acquireLock`, here against a live serve. */
function machineClaimLock(w: World, op: "hold" | "release"): void {
  const db = new DatabaseSync(w.db.path);
  try {
    db.exec("PRAGMA busy_timeout=10000;");
    if (op === "release") {
      db.prepare("DELETE FROM locks WHERE name = 'machine:claim' AND owner = 'e2e-other-repo'").run();
      return;
    }
    // `expires_at` is epoch SECONDS (src/types.ts systemClock). Far longer than Phase B's wait, so
    // the repo really does spend the whole wait and defer, rather than winning on a lapse.
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO locks (name, owner, acquired_at, expires_at) VALUES ('machine:claim', 'e2e-other-repo', ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at",
    ).run(now, now + 600);
  } finally {
    db.close();
  }
}

scenario(
  {
    name: "machine-claim-lock",
    lane: "fake",
    timeoutMs: 300_000,
    repoName: MAIN,
    briefs: { [FIRST[MAIN]!]: briefBody(FIRST[MAIN]!) },
    config: repoConfig,
    // Three more repos on THIS server: one process, one DB, four tick loops on one cadence. That is
    // the host shape the starvation needs; fleet machines are other servers and cannot stand in.
    extraRepos: Object.fromEntries(EXTRA.map((r) => [r, { briefs: { [FIRST[r]!]: briefBody(FIRST[r]!) } }])),
    // The agents never signal, so every claimed run keeps occupying its slot and the later ticks
    // still have to get past the machine gate.
    agent: { default: { hangMs: "forever" } },
    beforeStart: (p) => {
      // LOAD-BEARING: Phase B only takes `machine:claim` when machine.yml sets max_active_workspaces.
      // Without this file the lock is never taken and the whole scenario is vacuous.
      mkdirSync(p.configDir, { recursive: true });
      writeFileSync(join(p.configDir, "machine.yml"), `max_active_workspaces: ${MACHINE_CAP}\nmin_free_memory_mb: 1\n`);
    },
  },
  async (w) => {
    const claimed = (repo: string, key: string): boolean =>
      w.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE repo = ? AND ticket_key = ? AND ended_at IS NULL", repo, key)[0]?.n === 1;
    const deferrals = (repo: string): number =>
      w.db.all<{ claim_deferrals: number }>("SELECT claim_deferrals FROM repos WHERE name = ?", repo)[0]?.claim_deferrals ?? 0;
    const cli = (repo: string, args: string[]) => w.factory.cli(["--repo", repo, ...args], { repoScoped: false });
    const DEFERRAL_LINE = /claims deferred (\d+) ticks? \(machine claim lock\)/;

    // ── criterion 1: N repos ticking in lockstep all reach claimNewWork ───────────────────────────
    const started = Date.now();
    await w.waitFor(() => Object.entries(FIRST).every(([repo, key]) => claimed(repo, key)), {
      label: `all ${Object.keys(FIRST).length} repos claim their brief within ${CLAIM_BOUND_MS}ms`,
      timeoutMs: CLAIM_BOUND_MS,
      pollMs: 200,
    });
    const fanOutMs = Date.now() - started;
    // …and none of them got there by losing turns first: a repo that had to skip a tick would carry
    // the count. This is the fairness assertion; the wall-clock bound above is the liveness one.
    for (const repo of Object.keys(FIRST)) {
      expect(deferrals(repo), `${repo} never had to defer its claims`).toBe(0);
      expect(cli(repo, ["status"]).stdout, `${repo}'s status is quiet about deferrals`).not.toMatch(DEFERRAL_LINE);
    }

    // ── criterion 2: a repo that keeps losing says so, in another process ─────────────────────────
    // Somebody else holds the lock for longer than Phase B is willing to wait, and fresh work lands
    // for one repo. Every tick of it now defers — which is exactly the state that used to be silent.
    machineClaimLock(w, "hold");
    writeFileSync(join(w.repoPaths(STARVED).briefs, `${DEFERRED_KEY}.md`), briefBody(DEFERRED_KEY));
    await w.waitFor(() => deferrals(STARVED) >= 2, {
      label: `${STARVED} defers its claims for at least two ticks while the lock is held`,
      timeoutMs: DEFER_WAIT_MS,
      pollMs: 500,
    });
    expect(claimed(STARVED, DEFERRED_KEY), "the new brief is not claimed while the lock is held").toBe(false);

    // The CLI is a separate process from serve — it reads the durable counter, which is the reason
    // the count lives in the DB and not in the tick loop's memory.
    const status = cli(STARVED, ["status"]);
    expect(status.code, status.stderr).toBe(0);
    const line = DEFERRAL_LINE.exec(status.stdout);
    expect(line, `status reports the deferral:\n${status.stdout}`).not.toBeNull();
    expect(Number(line![1]), "the reported count is the real one").toBeGreaterThanOrEqual(2);
    expect(status.stdout, "and it is reported under the host gate, not instead of it").toContain("machine: cap ");

    const explain = cli(STARVED, ["explain", DEFERRED_KEY]);
    expect(explain.code, explain.stderr).toBe(0);
    expect(explain.stdout).toContain("no run recorded");
    expect(explain.stdout).toMatch(/note: this repo is losing the race for the machine claim lock — claims deferred \d+ ticks? \(machine claim lock\)/);

    // ── and it clears itself: the count is CONSECUTIVE, not cumulative ────────────────────────────
    machineClaimLock(w, "release");
    // Both facts, in one wait: the claim lands DURING the lock section and the counter is cleared
    // when that section returns, so polling for the run alone races the reset by milliseconds.
    await w.waitFor(() => claimed(STARVED, DEFERRED_KEY) && deferrals(STARVED) === 0, {
      label: `${STARVED} claims the deferred brief once the lock is free, and its counter clears`,
      timeoutMs: 60_000,
      pollMs: 250,
    });
    expect(cli(STARVED, ["status"]).stdout, "and status stops reporting it").not.toMatch(DEFERRAL_LINE);

    w.recordMetrics({ repos: Object.keys(FIRST).length, tickSeconds: TICK_SECONDS, claimFanOutMs: fanOutMs });
  },
);
