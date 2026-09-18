import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { httpMachineClient } from "../src/fleet/client.ts";
import { listMachines, localMachine, parseMachineList, type Machine } from "../src/fleet/machines.ts";
import { memoryLastSeenStore, readFleet, routeRun } from "../src/fleet/read.ts";
import type { MachineTransport } from "../src/fleet/transport.ts";
import type { ActiveRun, RepoStatus } from "../src/fleet/shapes.ts";

// ── a fake machine: a real loopback server behind a transport that knows its URL ────────────────
//
// The transport is the seam the whole fleet is written against, so faking THERE (rather than faking
// the client) keeps `httpMachineClient` — the thing that will actually talk to a remote box — under
// test, while no SSH is involved. Every request is recorded, which is how "an action hit only that
// machine" is asserted.

interface FakeMachine {
  machine: Machine;
  baseUrl: string;
  calls: { method: string; path: string; body: unknown }[];
  /** Make this machine stop answering (a stopped server / a forward that died). */
  down(): void;
  /** Make every read hang, so the per-machine timeout is what decides. */
  hangMs: number;
}

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

async function fakeMachine(opts: {
  name: string;
  local?: boolean;
  version?: string;
  repos: Record<string, RepoStatus>;
}): Promise<FakeMachine> {
  const state = { down: false };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const self = {} as FakeMachine;

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
    if (self.hangMs) await new Promise((r) => setTimeout(r, self.hangMs));
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/health") {
      reply(200, {
        ok: true,
        version: opts.version ?? "9.9.9",
        pid: 1,
        uptimeSec: 1,
        repos: Object.keys(opts.repos).map((name) => ({ name, active: opts.repos[name]!.active.length })),
      });
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
    hangMs: 0,
    down: () => {
      state.down = true;
    },
  });
  return self;
}

function fakeTransport(machines: FakeMachine[], failureDetail?: (machine: Machine) => string | null): MachineTransport {
  return {
    endpoint: async (machine) => machines.find((m) => m.machine.name === machine.name)?.baseUrl ?? null,
    close: () => undefined,
    failureDetail,
  };
}

function clientsFor(machines: FakeMachine[]) {
  const transport = fakeTransport(machines);
  return machines.map((m) => httpMachineClient(m.machine, transport));
}

// ── discovery ──────────────────────────────────────────────────────────────────────────────────

describe("machine discovery", () => {
  it("keeps enabled saved machines and drops disabled ones", () => {
    const parsed = parseMachineList([
      { label: "build-box", target: "user@build", enabled: true },
      { label: "retired", target: "user@retired", enabled: false },
      { label: "implicit", target: "user@implicit" },
    ]);
    expect(parsed.map((m) => m.name)).toEqual(["build-box", "implicit"]);
    expect(parsed[0]).toMatchObject({ sshTarget: "user@build", local: false });
  });

  it("drops entries with nothing to name or dial, and never lets one shadow the local machine", () => {
    expect(parseMachineList([{ target: "user@nameless" }, { label: "no-target" }, { label: "local", target: "user@x" }, "nope", null])).toEqual([]);
  });

  it("accepts herdr's alternative field spellings and its object envelope", () => {
    const parsed = parseMachineList({ machines: [{ name: "alt", ssh_target: "user@alt", remote_session: "work" }] });
    expect(parsed).toEqual([{ name: "alt", sshTarget: "user@alt", session: "work", local: false }]);
  });

  it("a machine with no herdr machines is the local machine alone", async () => {
    expect(await listMachines({ readProfiles: async () => [] })).toEqual([localMachine]);
  });

  it("a herdr that cannot be asked degrades to the local machine and says why", async () => {
    const warnings: string[] = [];
    const machines = await listMachines({
      readProfiles: async () => {
        throw new Error("herdr: no server");
      },
      onWarn: (m) => warnings.push(m),
    });
    expect(machines).toEqual([localMachine]);
    expect(warnings[0]).toContain("herdr: no server");
  });
});

// ── the merged view ────────────────────────────────────────────────────────────────────────────

describe("readFleet", () => {
  it("merges the runs of two machines, tagged with the machine that owns each", async () => {
    const here = await fakeMachine({ name: "local", local: true, version: "1.0.0", repos: { app: repoStatus("app", [activeRun({ ticketKey: "HF-1" })]) } });
    const there = await fakeMachine({
      name: "build-box",
      version: "1.0.1",
      repos: { api: repoStatus("api", [activeRun({ id: 2, ticketKey: "HF-2", belt: "review", step: "pr", createdAt: 900 })]) },
    });

    const snapshot = await readFleet(clientsFor([here, there]), { now: () => 1600, lastSeen: memoryLastSeenStore() });

    expect(snapshot.machines.map((m) => [m.name, m.state, m.version])).toEqual([
      ["local", "ok", "1.0.0"],
      ["build-box", "ok", "1.0.1"],
    ]);
    expect(snapshot.runs).toEqual([
      expect.objectContaining({ machine: "local", repo: "app", key: "HF-1", belt: "ship", step: "work", phase: "running", ageSeconds: 600 }),
      expect.objectContaining({ machine: "build-box", repo: "api", key: "HF-2", belt: "review", step: "pr", ageSeconds: 700 }),
    ]);
  });

  it("carries each machine's host-local gate line and each repo's problems", async () => {
    const here = await fakeMachine({
      name: "local",
      local: true,
      repos: {
        app: repoStatus("app", [activeRun({ phase: "attention", step: null, attentionReason: "budget_exhausted" })], {
          machine: "machine: cap 2/4 working across all repos · memory 900 MB available (floor 1000 MB) — low memory",
          problems: [{ kind: "attention", detail: "HF-1 is parked" }],
        }),
      },
    });

    const snapshot = await readFleet(clientsFor([here]), { lastSeen: memoryLastSeenStore() });

    expect(snapshot.machines[0]!.machineLine).toContain("cap 2/4");
    expect(snapshot.machines[0]!.problems).toEqual([{ repo: "app", kind: "attention", detail: "HF-1 is parked" }]);
    expect(snapshot.runs[0]!.problems).toEqual(["attention: budget_exhausted"]);
  });

  it("narrows to one repo when asked, and ignores a repo a machine does not serve", async () => {
    const here = await fakeMachine({
      name: "local",
      local: true,
      repos: { app: repoStatus("app", [activeRun({ ticketKey: "HF-1" })]), api: repoStatus("api", [activeRun({ id: 2, ticketKey: "HF-2" })]) },
    });
    const there = await fakeMachine({ name: "build-box", repos: { api: repoStatus("api", [activeRun({ id: 3, ticketKey: "HF-3" })]) } });

    const snapshot = await readFleet(clientsFor([here, there]), { repos: ["app"], lastSeen: memoryLastSeenStore() });

    expect(snapshot.runs.map((r) => r.key)).toEqual(["HF-1"]);
    expect(snapshot.machines[1]!).toMatchObject({ name: "build-box", state: "ok", repos: [], runs: [] });
  });

  it("reports an unreachable machine as unverifiable with its last successful read — never as empty", async () => {
    const here = await fakeMachine({ name: "local", local: true, repos: { app: repoStatus("app", [activeRun()]) } });
    const there = await fakeMachine({ name: "build-box", repos: { api: repoStatus("api", [activeRun({ id: 2, ticketKey: "HF-2" })]) } });
    const lastSeen = memoryLastSeenStore();

    // First read sees both, and remembers when.
    await readFleet(clientsFor([here, there]), { now: () => 1000, lastSeen });
    there.down();
    const snapshot = await readFleet(clientsFor([here, there]), { now: () => 1300, lastSeen });

    const blind = snapshot.machines[1]!;
    expect(blind).toMatchObject({ name: "build-box", state: "unverifiable", version: null, lastSeenAt: 1000, runs: [] });
    expect(blind.detail).toBeTruthy();
    // The reachable machine is unaffected: one silent box never costs the rest of the view.
    expect(snapshot.runs.map((r) => r.key)).toEqual(["HF-1"]);
  });

  it("reports what the transport knows about an unreachable machine, not a generic reason", async () => {
    const there = await fakeMachine({ name: "build-box", repos: {} });
    there.down();
    const transport = fakeTransport([], () => "ssh: connect to host build-box port 22: Connection refused");
    const snapshot = await readFleet([httpMachineClient(there.machine, transport)], { lastSeen: memoryLastSeenStore() });

    expect(snapshot.machines[0]!).toMatchObject({ state: "unverifiable", detail: "ssh: connect to host build-box port 22: Connection refused" });
  });

  it("a machine that has never answered is unverifiable with no last-seen time", async () => {
    const there = await fakeMachine({ name: "build-box", repos: {} });
    there.down();
    const snapshot = await readFleet(clientsFor([there]), { lastSeen: memoryLastSeenStore() });
    expect(snapshot.machines[0]!).toMatchObject({ state: "unverifiable", lastSeenAt: null });
  });

  // ── the fast, reasonless failure (#34) ───────────────────────────────────────────────────────
  //
  // A forward came up and the remote API answered — just not inside the 500ms budget written for a
  // server on 127.0.0.1. The machine read `unverifiable: could not reach its API`, a sentence that
  // names neither the call nor the budget it missed, while `curl` through the same forward worked.

  it("does not hold a remote machine to a loopback read budget", async () => {
    const there = await fakeMachine({ name: "build-box", repos: { api: repoStatus("api", [activeRun({ id: 2, ticketKey: "HF-2" })]) } });
    there.hangMs = 900; // a wide-area round trip: way over 500ms, nowhere near a hung box

    const snapshot = await readFleet(clientsFor([there]), { now: () => 1000, lastSeen: memoryLastSeenStore() });

    expect(snapshot.machines[0]!).toMatchObject({ name: "build-box", state: "ok" });
    expect(snapshot.runs.map((r) => r.key)).toEqual(["HF-2"]);
  });

  it("names the HTTP failure when the transport had an endpoint and the API is what did not answer", async () => {
    const there = await fakeMachine({ name: "build-box", repos: {} });
    there.down(); // the forward is fine; the server behind it drops the connection
    const snapshot = await readFleet(clientsFor([there]), { lastSeen: memoryLastSeenStore() });

    const detail = snapshot.machines[0]!.detail!;
    expect(detail).toContain("/health");
    expect(detail).not.toContain("could not reach its API");
  });

  it("times a slow machine out on its own budget without holding up the others", async () => {
    const here = await fakeMachine({ name: "local", local: true, repos: { app: repoStatus("app", [activeRun()]) } });
    const slow = await fakeMachine({ name: "build-box", repos: { api: repoStatus("api", []) } });
    slow.hangMs = 5000;

    const startedAt = Date.now();
    const snapshot = await readFleet(clientsFor([here, slow]), { timeoutMs: 250, now: () => 1000, lastSeen: memoryLastSeenStore() });
    const elapsed = Date.now() - startedAt;

    expect(snapshot.machines.map((m) => m.state)).toEqual(["ok", "unverifiable"]);
    expect(snapshot.machines[1]!.detail).toContain("250ms");
    expect(snapshot.runs.map((r) => r.key)).toEqual(["HF-1"]);
    expect(elapsed).toBeLessThan(4000); // i.e. the slow machine's 5s hang was never waited out
  });
});

// ── action routing ────────────────────────────────────────────────────────────────────────────

describe("action routing", () => {
  it("sends an action on a remote run to that machine and to no other", async () => {
    const here = await fakeMachine({ name: "local", local: true, repos: { app: repoStatus("app", [activeRun({ ticketKey: "HF-1" })]) } });
    const there = await fakeMachine({ name: "build-box", repos: { api: repoStatus("api", [activeRun({ id: 2, ticketKey: "HF-2" })]) } });
    const clients = clientsFor([here, there]);

    const snapshot = await readFleet(clients, { lastSeen: memoryLastSeenStore() });
    const route = routeRun(snapshot, "HF-2");
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.machine.name).toBe("build-box");

    here.calls.length = 0;
    there.calls.length = 0;
    const client = clients.find((c) => c.machine.name === route.machine.name)!;
    expect(await client.teardown(route.run.repo, route.run.key, route.run.source)).toEqual({ ok: true });

    expect(there.calls).toEqual([{ method: "POST", path: "/repos/api/teardown", body: { key: "HF-2", source: "issues" } }]);
    expect(here.calls).toEqual([]);
  });

  it("refuses a key that is active on two machines rather than guessing which one to act on", async () => {
    const here = await fakeMachine({ name: "local", local: true, repos: { app: repoStatus("app", [activeRun({ ticketKey: "HF-9" })]) } });
    const there = await fakeMachine({ name: "build-box", repos: { app: repoStatus("app", [activeRun({ id: 2, ticketKey: "HF-9" })]) } });

    const snapshot = await readFleet(clientsFor([here, there]), { lastSeen: memoryLastSeenStore() });

    const ambiguous = routeRun(snapshot, "HF-9");
    expect(ambiguous).toMatchObject({ ok: false });
    if (!ambiguous.ok) expect(ambiguous.error).toContain("more than one machine");
    // Naming the machine resolves it.
    expect(routeRun(snapshot, "HF-9", { machine: "build-box" })).toMatchObject({ ok: true, machine: { name: "build-box" } });
  });

  it("says a missing key may be on a machine this read could not verify", async () => {
    const there = await fakeMachine({ name: "build-box", repos: {} });
    there.down();
    const snapshot = await readFleet(clientsFor([there]), { lastSeen: memoryLastSeenStore() });
    const route = routeRun(snapshot, "HF-1");
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.error).toContain("build-box was unverifiable");
  });
});
