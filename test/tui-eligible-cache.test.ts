import { describe, expect, it } from "vitest";
import type { ActiveRun, EligibleItem } from "../src/tui/api.ts";
import type { MachineView } from "../src/tui/fleet-view.ts";
import { fleetClaimed, withoutClaimed } from "../src/tui/eligible-cache.ts";

const item = (over: Partial<EligibleItem> & { key: string }): EligibleItem => ({
  source: "markdown",
  belt: "work_to_main",
  summary: over.key,
  type: "task",
  ...over,
});

const run = (over: Partial<ActiveRun> & { ticketKey: string }): ActiveRun => ({
  id: 1,
  workSource: "markdown",
  belt: "work_to_main",
  issueType: null,
  worktreeName: null,
  branch: null,
  phase: "running",
  step: "work",
  prNumber: null,
  summary: null,
  outcome: null,
  attentionReason: null,
  worker: null,
  createdAt: null,
  steps: [],
  ...over,
});

const machine = (name: string, repos: { repo: string; active: ActiveRun[] }[]): MachineView =>
  ({
    name,
    local: false,
    sshTarget: null,
    state: "ok",
    version: null,
    uptimeSec: null,
    lastSeenAt: null,
    stale: false,
    repos: repos.map((r) => ({ repo: r.repo, eligible: [], status: { active: r.active } })),
  }) as unknown as MachineView;

/** One machine's runs as the claimed set — the same shape `dashboard.ts` builds, for one host. */
const claimedOn = (...runs: ActiveRun[]): Set<string> => fleetClaimed([machine("alpha", [{ repo: "r", active: runs }])]);

describe("withoutClaimed — drop eligible items already running", () => {
  it("drops an eligible item that now has an active run (same source+key)", () => {
    const eligible = [item({ key: "a" }), item({ key: "b" })];
    expect(withoutClaimed(eligible, claimedOn(run({ ticketKey: "a", workSource: "markdown" }))).map((i) => i.key)).toEqual(["b"]);
  });

  it("is source-scoped — same key under a different source is NOT dropped", () => {
    const eligible = [item({ key: "a", source: "jira" })];
    expect(withoutClaimed(eligible, claimedOn(run({ ticketKey: "a", workSource: "markdown" }))).map((i) => i.key)).toEqual(["a"]);
  });

  it("returns everything when there are no active runs", () => {
    const eligible = [item({ key: "a" }), item({ key: "b" })];
    expect(withoutClaimed(eligible, claimedOn())).toHaveLength(2);
  });
});

describe("fleetClaimed — a ticket is claimed once for the whole fleet", () => {
  it("drops machine A's eligible item when machine B has an active run for it", () => {
    const a = machine("alpha", [{ repo: "alpha-repo", active: [] }]);
    const b = machine("beta", [{ repo: "alpha-repo", active: [run({ ticketKey: "K-1", workSource: "jira" })] }]);
    const eligible = [item({ key: "K-1", source: "jira" }), item({ key: "K-2", source: "jira" })];
    expect(withoutClaimed(eligible, fleetClaimed([a, b])).map((i) => i.key)).toEqual(["K-2"]);
  });

  it("drops an item claimed by another REPO on the same machine (one source, two repo configs)", () => {
    const m = machine("alpha", [
      { repo: "alpha-repo", active: [] },
      { repo: "beta-repo", active: [run({ ticketKey: "K-1", workSource: "jira" })] },
    ]);
    expect(withoutClaimed([item({ key: "K-1", source: "jira" })], fleetClaimed([m]))).toEqual([]);
  });

  it("is still source-scoped across the fleet", () => {
    const m = machine("alpha", [{ repo: "r", active: [run({ ticketKey: "a", workSource: "markdown" })] }]);
    expect(withoutClaimed([item({ key: "a", source: "jira" })], fleetClaimed([m])).map((i) => i.key)).toEqual(["a"]);
  });
});
