import { describe, expect, it, vi } from "vitest";
import { createApp, type RepoRuntime, type ServerContext } from "../src/server/app.ts";

interface StatusBody {
  sources: { name: string; type: string; auth?: { state: string } }[];
  belts: { name: string; diagnostic?: { state: string } }[];
  evidenceSso?: { state: string };
  active: { worker: string | null }[];
  problems: { kind: string; detail: string }[];
}

describe("dashboard server payloads", () => {
  it("keeps quick status probe-free and identifies an eligible item's belt", async () => {
    const paneState = vi.fn(async () => "working");
    const authStatus = vi.fn(async () => ({ state: "ok" as const }));
    const health = vi.fn(async () => undefined);
    const listEligible = vi.fn(async () => [{ key: "HF-1", summary: "Fast dashboard", type: "Task" }]);
    const pausedEligible = vi.fn(async () => [{ key: "HF-9", summary: "Paused work", type: "Task" }]);
    const run = {
      id: 1,
      ticketKey: "HF-2",
      workSource: "jira",
      belt: "ship",
      phase: "running",
      step: "work",
      prNumber: null,
      summary: "Active item",
      outcome: null,
      paneId: "pane-1",
      endedAt: null,
    };
    const source = { name: "jira", type: "jira", client: { authStatus, health, listEligible } };
    const pausedSource = { name: "paused-jira", type: "jira", client: { authStatus, health, listEligible: pausedEligible } };
    const runtime = {
      ticking: false,
      deps: {
        config: {
          repoName: "demo",
          limits: { maxActiveWorkspaces: 2 },
          sources: [{ name: "jira", type: "jira" }],
          belts: [{ name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, label: "pickup", steps: [{ name: "work" }] }],
        },
        // An inactive belt must be invisible to the eligible payload (mirrors Phase B) so the
        // dashboard never shows never-claimable rows — the source of the flicker.
        belts: [
          { name: "ship", source: "jira", label: "pickup", active: true },
          { name: "paused", source: "paused-jira", label: "pickup", active: false },
        ],
        store: {
          activeRuns: () => [run],
          listRuns: () => [],
          runStepsFor: () => [],
          getSourceAuth: () => undefined,
          authStuckIntents: () => false,
          listIntents: () => [],
          suspendedIntents: () => [],
          listProblems: () => [],
          reportProblem: () => {},
          clearProblem: () => false,
        },
        herdr: { paneState },
        resolveSource: (name: string) => (name === "paused-jira" ? pausedSource : source),
        now: () => 1,
        log: vi.fn(),
      },
    } as unknown as RepoRuntime;
    const context = {
      getRepo: (name: string) => (name === "demo" ? runtime : undefined),
    } as unknown as ServerContext;
    const app = createApp(context);

    const quickResponse = await app.request("/repos/demo/status?quick=1");
    expect(quickResponse.status).toBe(200);
    const quick = (await quickResponse.json()) as StatusBody;
    expect(quick.sources).toEqual([{ name: "jira", type: "jira" }]);
    expect(quick.belts).toEqual([expect.objectContaining({ name: "ship", steps: ["work"] })]);
    expect(quick.belts[0]?.diagnostic).toBeUndefined();
    expect(quick.evidenceSso).toBeUndefined();
    expect(quick.active).toEqual([expect.objectContaining({ worker: null })]);
    // Repo-level problems ride the quick path too (cheap reads, no probes) — empty when healthy.
    expect(quick.problems).toEqual([]);
    expect(authStatus).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(paneState).not.toHaveBeenCalled();

    const diagnosticsResponse = await app.request("/repos/demo/status?refresh=1");
    expect(diagnosticsResponse.status).toBe(200);
    const diagnostics = (await diagnosticsResponse.json()) as StatusBody;
    expect(diagnostics.sources).toEqual([{ name: "jira", type: "jira", auth: { state: "ok" } }]);
    expect(diagnostics.belts[0]?.diagnostic).toEqual({ state: "ok" });
    expect(diagnostics.evidenceSso).toEqual({ state: "na" });
    expect(diagnostics.active).toEqual([expect.objectContaining({ worker: "working" })]);
    expect(authStatus).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledWith(["pickup"]);
    expect(paneState).toHaveBeenCalledOnce();

    const eligibleResponse = await app.request("/repos/demo/eligible");
    expect(eligibleResponse.status).toBe(200);
    expect(await eligibleResponse.json()).toEqual({
      eligible: [{ source: "jira", belt: "ship", key: "HF-1", summary: "Fast dashboard", type: "Task" }],
    });
    // The inactive belt's source is never polled, so its items never reach the dashboard.
    expect(pausedEligible).not.toHaveBeenCalled();
  });

  it("recorded problems (the v37 problem ledger) light the repo on the QUICK path — nothing is re-checked on load", async () => {
    const authStatus = vi.fn();
    const runtime = {
      ticking: false,
      deps: {
        config: {
          repoName: "demo",
          limits: { maxActiveWorkspaces: 2 },
          sources: [{ name: "jira", type: "jira" }],
          belts: [],
          evidence: { publisher: "s3", profile: "dev" },
        },
        belts: [],
        store: {
          activeRuns: () => [],
          listRuns: () => [],
          runStepsFor: () => [],
          getSourceAuth: () => undefined,
          authStuckIntents: () => false,
          listIntents: () => [],
          suspendedIntents: () => [],
          // What the machinery recorded when it observed the failures — the quick path only reads.
          listProblems: () => [
            { repo: "demo", key: "publisher:s3", kind: "auth", detail: "evidence uploads blocked on AWS creds (expired) — run `aws sso login`", createdAt: 1, updatedAt: 1 },
            { repo: "demo", key: "source:jira", kind: "auth", detail: "jira: JIRA_API_TOKEN missing", createdAt: 1, updatedAt: 1 },
          ],
        },
        herdr: {},
        resolveSource: (name: string) => (name === "jira" ? { name: "jira", type: "jira", client: { authStatus } } : undefined),
        now: () => 1,
        log: vi.fn(),
      },
    } as unknown as RepoRuntime;
    const context = { getRepo: (name: string) => (name === "demo" ? runtime : undefined) } as unknown as ServerContext;
    const app = createApp(context);
    const res = await app.request("/repos/demo/status?quick=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.problems).toEqual([
      { kind: "auth", detail: expect.stringContaining("evidence uploads blocked on AWS creds") },
      { kind: "auth", detail: "jira: JIRA_API_TOKEN missing" },
    ]);
    expect(authStatus).not.toHaveBeenCalled(); // read-only: the quick path never probes
  });

  it("a run parked for attention surfaces as a repo-level problem (the dashboard's red repo light)", async () => {
    const parked = {
      id: 2,
      ticketKey: "HF-9",
      workSource: "jira",
      belt: "ship",
      phase: "attention",
      step: "work",
      prNumber: null,
      summary: "Stuck item",
      outcome: null,
      paneId: null,
      endedAt: null,
    };
    const runtime = {
      ticking: false,
      deps: {
        config: { repoName: "demo", limits: { maxActiveWorkspaces: 2 }, sources: [], belts: [] },
        belts: [],
        store: {
          activeRuns: () => [parked],
          listRuns: () => [],
          runStepsFor: () => [],
          getSourceAuth: () => undefined,
          authStuckIntents: () => false,
          listIntents: () => [],
          suspendedIntents: () => [],
          listProblems: () => [],
        },
        herdr: {},
        resolveSource: () => undefined,
        now: () => 1,
        log: vi.fn(),
      },
    } as unknown as RepoRuntime;
    const context = { getRepo: (name: string) => (name === "demo" ? runtime : undefined) } as unknown as ServerContext;
    const app = createApp(context);
    const res = await app.request("/repos/demo/status?quick=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.problems).toEqual([{ kind: "attention", detail: expect.stringContaining("1 run parked for attention (HF-9)") }]);
  });

  it("belt-apply route validates the body and delegates to ctx.applyBeltChanges", async () => {
    const applyBeltChanges = vi.fn(async () => ({ ok: true, runsMoved: 3, runsPurged: 1, worktreesCleaned: 0, blocked: [], failures: [] }));
    const context = {
      getRepo: (name: string) => (name === "demo" ? ({} as RepoRuntime) : undefined),
      knownRepos: () => ["demo"],
      applyBeltChanges,
    } as unknown as ServerContext;
    const app = createApp(context);

    const res = await app.request("/repos/demo/belt-apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ renames: [{ from: "old", to: "new" }], deletes: ["gone"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runsMoved: 3, runsPurged: 1, worktreesCleaned: 0, blocked: [], failures: [] });
    expect(applyBeltChanges).toHaveBeenCalledWith("demo", { renames: [{ from: "old", to: "new" }], deletes: ["gone"] });

    // unknown repo → 404, never touches the ctx method
    const missing = await app.request("/repos/nope/belt-apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ renames: [], deletes: [] }),
    });
    expect(missing.status).toBe(404);
  });
});
