// The TUI's fleet layer: what the Dashboard reads, what it keeps when a machine goes quiet, and
// where an action is allowed to land.
//
// Faked at the TRANSPORT, like test/fleet.test.ts: each machine is a real loopback server, so the
// client that will one day talk to a box over an SSH forward is the one under test, and every
// request it makes is recorded — which is how "the action reached that machine and no other" is
// asserted rather than assumed.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { httpMachineClient } from "../src/fleet/client.ts";
import { localMachine, type Machine } from "../src/fleet/machines.ts";
import { memoryLastSeenStore } from "../src/fleet/read.ts";
import type { MachineTransport } from "../src/fleet/transport.ts";
import type { ActiveRun, EligibleItem, RepoStatus } from "../src/fleet/shapes.ts";
import {
  createFleetSource,
  filterMachines,
  fleetStatusLine,
  hostLines,
  idleLine,
  isIdleRepo,
  machineHeader,
  needsYou,
  sharedProblems,
  shortProblem,
  staleRunLine,
  versionDrift,
  type FleetView,
  type MachineView,
} from "../src/tui/fleet-view.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function activeRun(over: Partial<ActiveRun> = {}): ActiveRun {
  return {
    id: 1,
    ticketKey: "HF-1",
    workSource: "issues",
    belt: "ship",
    issueType: "Feature",
    worktreeName: null,
    branch: null,
    phase: "running",
    step: "work",
    prNumber: null,
    summary: "a thing",
    outcome: null,
    attentionReason: null,
    worker: null,
    createdAt: 1000,
    steps: [],
    ...over,
  };
}

function repoStatus(repo: string, active: ActiveRun[], over: Partial<RepoStatus> = {}): RepoStatus {
  return { repo, limits: { maxActiveWorkspaces: 3 }, sources: [], belts: [], active, finished: [], ...over };
}

function eligibleItem(key: string): EligibleItem {
  return { source: "issues", belt: "ship", key, summary: "unclaimed", type: "Feature" };
}

interface FakeMachine {
  machine: Machine;
  baseUrl: string;
  calls: { method: string; path: string; body: unknown }[];
  /** Stop answering, the way a stopped server or a dead forward does. */
  down(): void;
  /** Make the eligible query alone fail — the slow, flaky half of a poll. */
  eligibleDown: boolean;
  eligible: EligibleItem[];
}

async function fakeMachine(opts: { name: string; local?: boolean; version?: string; repos: Record<string, RepoStatus>; eligible?: EligibleItem[] }): Promise<FakeMachine> {
  const state = { down: false };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const self = { eligibleDown: false, eligible: opts.eligible ?? [] } as FakeMachine;

  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    calls.push({ method: req.method ?? "GET", path, body: raw ? JSON.parse(raw) : undefined });
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/health") {
      reply(200, { ok: true, version: opts.version ?? "9.9.9", pid: 1, uptimeSec: 120, repos: Object.keys(opts.repos).map((name) => ({ name, active: 0 })) });
      return;
    }
    if (path.includes("/eligible")) {
      if (self.eligibleDown) {
        req.socket.destroy();
        return;
      }
      reply(200, { eligible: self.eligible });
      return;
    }
    const status = Object.entries(opts.repos).find(([name]) => path.startsWith(`/repos/${name}/status`));
    if (status) {
      reply(200, status[1]);
      return;
    }
    reply(200, { ok: true });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

  Object.assign(self, {
    machine: opts.local ? localMachine : { name: opts.name, sshTarget: `user@${opts.name}`, session: null, local: false },
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    down: () => {
      state.down = true;
    },
  });
  return self;
}

/** A source over the given fake machines: herdr's profile list and the transport are both injected,
 *  so no herdr and no SSH are involved. */
function sourceOver(machines: FakeMachine[], now?: () => number) {
  const transport: MachineTransport = {
    endpoint: async (m) => machines.find((f) => f.machine.name === m.name)?.baseUrl ?? null,
    close: () => undefined,
  };
  return createFleetSource({
    transport,
    readProfiles: async () => machines.filter((m) => !m.machine.local).map((m) => ({ label: m.machine.name, target: m.machine.sshTarget, enabled: true })),
    lastSeen: memoryLastSeenStore(),
    timeoutMs: 2000,
    now,
  });
}

/** Poll once and answer the LAST view painted (the one with eligible work folded in). */
async function pollOnce(source: ReturnType<typeof sourceOver>): Promise<FleetView> {
  const views: FleetView[] = [];
  await source.poll((v) => void views.push(v));
  expect(views.length, "a poll paints twice: quick, then eligible folded in").toBe(2);
  return views[views.length - 1]!;
}

function machineView(over: Partial<MachineView> = {}): MachineView {
  return { name: "local", local: true, sshTarget: null, state: "ok", version: "1.0.0", uptimeSec: 60, lastSeenAt: 1000, repos: [], stale: false, ...over };
}

describe("the fleet as the dashboard reads it", () => {
  it("merges every machine's repos, runs and eligible work, each tagged with its machine", async () => {
    const here = await fakeMachine({ name: "local", local: true, version: "1.0.0", repos: { app: repoStatus("app", [activeRun({ ticketKey: "HF-1" })]) }, eligible: [eligibleItem("HF-9")] });
    const there = await fakeMachine({ name: "build-box", version: "1.0.0", repos: { api: repoStatus("api", [activeRun({ id: 2, ticketKey: "HF-2" })]) } });

    const view = await pollOnce(sourceOver([here, there]));

    expect(view.machines.map((m) => [m.name, m.state, m.local])).toEqual([
      ["local", "ok", true],
      ["build-box", "ok", false],
    ]);
    expect(view.machines.map((m) => m.repos.map((r) => r.repo))).toEqual([["app"], ["api"]]);
    expect(view.machines[0]!.repos[0]!.status!.active.map((r) => r.ticketKey)).toEqual(["HF-1"]);
    expect(view.machines[0]!.repos[0]!.eligible.map((e) => e.key)).toEqual(["HF-9"]);
    expect(view.machines[1]!.repos[0]!.status!.active.map((r) => r.ticketKey)).toEqual(["HF-2"]);
  });

  it("keeps an unverifiable machine's last known rows rather than reading as a machine with no work", async () => {
    const here = await fakeMachine({ name: "local", local: true, repos: { app: repoStatus("app", [activeRun()]) } });
    const there = await fakeMachine({ name: "build-box", repos: { api: repoStatus("api", [activeRun({ id: 2, ticketKey: "HF-2" })]) } });
    let now = 1000;
    const source = sourceOver([here, there], () => now);

    await pollOnce(source);
    there.down();
    now = 1300;
    const after = await pollOnce(source);

    const blind = after.machines[1]!;
    expect(blind.state).toBe("unverifiable");
    expect(blind.stale, "its rows are last-known, and say so").toBe(true);
    expect(blind.lastSeenAt, "carrying when it last answered").toBe(1000);
    expect(blind.repos.flatMap((r) => r.status?.active.map((a) => a.ticketKey) ?? []), "its runs are still on screen").toEqual(["HF-2"]);
    // And the machine that IS answering is untouched.
    expect(after.machines[0]!).toMatchObject({ state: "ok", stale: false });
  });

  it("carries the last good eligible items across a failed source query", async () => {
    const here = await fakeMachine({ name: "local", local: true, repos: { app: repoStatus("app", []) }, eligible: [eligibleItem("HF-9")] });
    const source = sourceOver([here]);

    expect((await pollOnce(source)).machines[0]!.repos[0]!.eligible.map((e) => e.key)).toEqual(["HF-9"]);
    here.eligibleDown = true;
    expect((await pollOnce(source)).machines[0]!.repos[0]!.eligible.map((e) => e.key), "a failed eligible query keeps the rows on screen").toEqual(["HF-9"]);
  });

  it("sends an action to the machine that owns the run, and to no other", async () => {
    const here = await fakeMachine({ name: "local", local: true, repos: { app: repoStatus("app", [activeRun({ ticketKey: "HF-1" })]) } });
    const there = await fakeMachine({ name: "build-box", repos: { app: repoStatus("app", [activeRun({ id: 2, ticketKey: "HF-2" })]) } });
    const source = sourceOver([here, there]);
    await pollOnce(source);

    here.calls.length = 0;
    there.calls.length = 0;
    expect(await source.clientFor("build-box")!.teardown("app", "HF-2", "issues")).toEqual({ ok: true });

    expect(there.calls).toEqual([{ method: "POST", path: "/repos/app/teardown", body: { key: "HF-2", source: "issues" } }]);
    expect(here.calls, "the same key on this machine was never touched").toEqual([]);
  });
});

describe("what the operator reads", () => {
  it("a reachable machine's header carries its version, load and host gate", () => {
    const m = machineView({
      name: "build-box",
      local: false,
      sshTarget: "user@build",
      version: "1.2.3",
      lastSeenAt: 940,
      machineLine: "machine: cap 2/4 working across all repos · memory ok",
      repos: [{ repo: "api", status: repoStatus("api", [activeRun(), activeRun({ id: 2 })]), eligible: [] }],
    });
    const [head, load, gate] = machineHeader(m, 1000);
    expect(head!.tone).toBe("accent");
    expect(head!.text).toContain("✓ build-box (user@build)");
    expect(head!.text).toContain("v1.2.3");
    expect(head!.text).toContain("2 running");
    expect(load!.text).toContain("1 repo");
    expect(load!.text).toContain("read 1m ago");
    // The host gate gets its own line: on the head it would be the part a narrow pane clips.
    expect(gate!.text).toContain("cap 2/4 working across all repos");
    for (const line of [head!, load!]) expect(line.text.length, `"${line.text}" fits a narrow pane`).toBeLessThan(50);
  });

  it("an unverifiable machine's header leads with how long it has been silent, and says its runs are not gone", () => {
    const m = machineView({
      name: "build-box",
      local: false,
      sshTarget: "user@build",
      state: "unverifiable",
      detail: "no answer within 2000ms",
      lastSeenAt: 700,
      stale: true,
      repos: [{ repo: "api", status: repoStatus("api", [activeRun()]), eligible: [] }],
    });
    const [head, seen, why] = machineHeader(m, 1000);
    expect(head!.tone).toBe("bad");
    expect(head!.text).toContain("unverifiable");
    expect(seen!.text).toContain("last seen 5m ago");
    expect(seen!.text, "the half an operator must not miss").toContain("NOT known to be gone");
    expect(why!.text).toContain("no answer within 2000ms");
    // A herdr pane is routinely ~50 columns; a fact that falls off the right edge is not reported.
    for (const line of machineHeader(m, 1000)) expect(line.text.length, `"${line.text}" fits a narrow pane`).toBeLessThan(50);
  });

  it("a machine that has never answered says so instead of claiming a last-seen time", () => {
    expect(machineHeader(machineView({ state: "unverifiable", lastSeenAt: null }), 1000)[1]!.text).toContain("never seen");
  });

  it("a last-known run renders as a line that admits what it is, not as a live card", () => {
    expect(staleRunLine({ ticketKey: "HF-2", belt: "ship", step: "review", phase: "running" })).toBe("HF-2   ship/review   unverifiable");
  });

  it("one machine's status line reads exactly as it always has", () => {
    const view: FleetView = { readAt: 1000, machines: [machineView({ uptimeSec: 3720 })] };
    expect(fleetStatusLine(view, null)).toEqual({ text: "● server up · v1.0.0 · uptime 1h 2m", tone: "good" });
    expect(fleetStatusLine(view, "last update failed")).toEqual({ text: "● server up · v1.0.0 · uptime 1h 2m · ⚠ last update failed", tone: "warn" });
  });

  it("one machine with no server keeps today's start-the-server hint", () => {
    const view: FleetView = { readAt: 1000, machines: [machineView({ state: "unverifiable", version: null })] };
    expect(fleetStatusLine(view, null)).toMatchObject({ text: "⚠ server not running — start it with `herdr-factory serve`", tone: "warn" });
  });

  it("a fleet's status line counts the machines that answered and names the ones that did not", () => {
    const view: FleetView = {
      readAt: 1000,
      machines: [machineView(), machineView({ name: "build-box", local: false, state: "unverifiable", version: null, lastSeenAt: 880 })],
    };
    const line = fleetStatusLine(view, null);
    expect(line.text).toContain("fleet 1/2 machines");
    expect(line.text).toContain("build-box unverifiable (last seen 2m ago)");
    expect(line.tone).toBe("warn");
  });

  it("a remote on another version is part of the update warning — this machine's own checks cannot see it", () => {
    const view: FleetView = { readAt: 1000, machines: [machineView(), machineView({ name: "build-box", local: false, version: "0.9.0" })] };
    expect(versionDrift(view)).toEqual(["build-box on v0.9.0 (this machine v1.0.0)"]);
    expect(fleetStatusLine(view, null).text).toContain("build-box on v0.9.0");
  });

  it("the machine filter narrows to one machine, and a machine that left the fleet falls back to all", () => {
    const view: FleetView = { readAt: 1000, machines: [machineView(), machineView({ name: "build-box", local: false })] };
    expect(filterMachines(view, null).map((m) => m.name)).toEqual(["local", "build-box"]);
    expect(filterMachines(view, "build-box").map((m) => m.name)).toEqual(["build-box"]);
    expect(filterMachines(view, "retired").map((m) => m.name), "an empty board would read as no work").toEqual(["local", "build-box"]);
  });
});

// ── the redesign: lead with what needs a human, say a host-wide fact once, collapse the rest ──────
describe("what the board leads with", () => {
  const withRuns = (repo: string, active: ActiveRun[], over: Partial<RepoStatus> = {}) => ({ repo, status: repoStatus(repo, active, over), eligible: [] });

  it("lists a green PR, an attention park and a waiting run — the three things that need a person", () => {
    const m = machineView({
      repos: [
        withRuns("app", [
          activeRun({ ticketKey: "HF-1", prNumber: 12, prGreen: true, phase: "reviewing" }),
          activeRun({ id: 2, ticketKey: "HF-2", phase: "attention", attentionReason: "the work step bounced twice" }),
          activeRun({ id: 3, ticketKey: "HF-3", phase: "waiting_for_human" }),
          activeRun({ id: 4, ticketKey: "HF-4", phase: "running" }),
        ]),
      ],
    });
    const items = needsYou([m]);
    expect(items.map((i) => i.key), "green first, then parked, then asking — a healthy run is not listed").toEqual(["HF-1", "HF-2", "HF-3"]);
    expect(items[0]!.text).toContain("PR #12 is green — ready to merge");
    expect(items[1]!.text).toContain("the work step bounced twice");
    expect(items[2]!.text).toContain("waiting for a human reply");
    expect(items.map((i) => [i.machine, i.repo])).toEqual([["local", "app"], ["local", "app"], ["local", "app"]]);
  });

  it("a PR whose head moved past its evidence with code says stale, never ready to merge (issue #84)", () => {
    const m = machineView({
      repos: [withRuns("app", [activeRun({ ticketKey: "HF-5", prNumber: 13, phase: "running", evidenceStale: { evidenceHead: "aaaaaaa111", prHead: "bbbbbbb222" } })])],
    });
    const [item] = needsYou([m]);
    expect(item!.text).toContain("PR #13 evidence stale since aaaaaaa (head bbbbbbb) — re-running");
    expect(item!.text).not.toContain("ready to merge");
  });

  it("names an unverifiable machine, and is empty — so not drawn — when nothing is blocked", () => {
    expect(needsYou([machineView({ repos: [withRuns("app", [activeRun()])] })])).toEqual([]);
    const blind = needsYou([machineView(), machineView({ name: "build-box", local: false, state: "unverifiable", detail: "no answer within 2000ms", stale: true })]);
    expect(blind).toHaveLength(1);
    expect(blind[0]!.text).toContain("build-box unverifiable — no answer within 2000ms");
    expect(blind[0]!.key, "a machine entry points at no run").toBeUndefined();
    expect(
      needsYou([machineView({ state: "unverifiable" })]),
      "on an install of one, a silent machine is just the status line's `server not running`",
    ).toEqual([]);
  });

  it("a repo whose config stopped loading is listed — it claims nothing until fixed (issue #95)", () => {
    const config = { kind: "config", detail: "config invalid: evidence: Unrecognized key — claims paused until the file loads" };
    const items = needsYou([machineView({ repos: [withRuns("app", [], { problems: [config, { kind: "auth", detail: "gh auth" }] })] })]);
    expect(items.map((i) => [i.repo, i.text, i.key])).toEqual([["app", `✗ app  ${config.detail}`, undefined]]);
  });

  it("a run on a silent machine is still listed, and marked as un-actionable", () => {
    const items = needsYou([
      machineView({ name: "build-box", local: false, state: "unverifiable", stale: true, repos: [withRuns("api", [activeRun({ phase: "attention" })])] }),
    ]);
    expect(items.map((i) => [i.key, i.stale])).toContainEqual(["HF-1", true]);
  });

  it("a problem several repos share is hoisted to the host header; one repo's own stays its own", () => {
    const auth = { kind: "auth", detail: "issues: gh auth — run `gh auth login`" };
    const m = machineView({
      machineLine: "machine: cap 1/4 working across all repos",
      repos: [
        { repo: "app", status: repoStatus("app", [], { problems: [auth] }), eligible: [] },
        { repo: "api", status: repoStatus("api", [], { problems: [auth] }), eligible: [] },
        { repo: "site", status: repoStatus("site", [], { problems: [{ kind: "git", detail: "site: not a git checkout" }] }), eligible: [] },
      ],
    });
    expect([...sharedProblems(m)]).toEqual([auth.detail]);
    const hoisted = machineHeader(m, 1000).at(-1)!;
    expect(hoisted.tone).toBe("bad");
    expect(hoisted.text).toContain("⚠ issues: gh auth — on several repos");
    // Same two facts, unindented, for the board that has no header to put them under.
    expect(hostLines(m).map((l) => [l.text, l.tone])).toEqual([
      ["cap 1/4 working across all repos", "accent"],
      ["⚠ issues: gh auth — on several repos", "bad"],
    ]);
  });

  it("a machine with no gate and no shared cause contributes no host lines at all", () => {
    expect(hostLines(machineView()), "nothing to say ⇒ nothing drawn").toEqual([]);
    expect(
      hostLines(machineView({ repos: [{ repo: "app", status: repoStatus("app", [], { problems: [{ kind: "auth", detail: "app only" }] }), eligible: [] }] })),
      "a cause only one repo reports stays on that repo's row",
    ).toEqual([]);
  });

  it("a problem reads as its cause, not as a count and a keypress", () => {
    expect(shortProblem("issues: gh auth — run `gh auth login`")).toBe("issues: gh auth");
    expect(shortProblem("x".repeat(80)).length, "it rides at the end of a repo row").toBeLessThanOrEqual(64);
  });

  it("only a repo with no run, no eligible work and no problem is idle", () => {
    expect(isIdleRepo({ repo: "a", status: repoStatus("a", []), eligible: [] })).toBe(true);
    expect(isIdleRepo({ repo: "a", status: repoStatus("a", [activeRun()]), eligible: [] })).toBe(false);
    expect(isIdleRepo({ repo: "a", status: repoStatus("a", []), eligible: [eligibleItem("HF-9")] }), "unclaimed work is not idle").toBe(false);
    expect(isIdleRepo({ repo: "a", status: repoStatus("a", [], { problems: [{ kind: "auth", detail: "gh auth" }] }), eligible: [] })).toBe(false);
    expect(isIdleRepo({ repo: "a", status: null, eligible: [] }), "a repo that failed to load is news").toBe(false);
  });

  it("collapsed rows on a silent machine read as unverified, never as idle", () => {
    expect(idleLine(["a", "b"], false)).toBe("  idle · a · b");
    expect(idleLine(["a", "b"], true)).toBe("  unverified · a · b");
  });
});
