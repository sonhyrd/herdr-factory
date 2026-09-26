// The needs-you notifier: one `herdr notification show` per ENTRY into the fleet's needs-you set —
// not per poll, not again while it stays, again after it leaves and comes back, never when the
// machine has not opted in, and not re-sent after a server restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveRun, RepoStatus } from "../src/fleet/shapes.ts";
import type { FleetSource, FleetView, MachineView } from "../src/tui/fleet-view.ts";
import { needsYouNotifier } from "../src/watchers/needs-you.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (ticketKey: string, over: Partial<ActiveRun> = {}): ActiveRun =>
  ({ id: 1, ticketKey, workSource: "issues", belt: "ship", phase: "attention", attentionReason: "budget exhausted", prNumber: null, step: null, steps: [], createdAt: 1, ...over }) as ActiveRun;

const machine = (name: string, active: ActiveRun[], over: Partial<MachineView> = {}): MachineView => ({
  name,
  local: name === "local",
  sshTarget: null,
  state: "ok",
  version: "1",
  uptimeSec: 1,
  lastSeenAt: 1,
  stale: false,
  repos: [{ repo: "app", status: { repo: "app", active } as unknown as RepoStatus, eligible: [] }],
  ...over,
});

/** A fleet whose next read is whatever the test last set. */
function fakeFleet() {
  let machines: MachineView[] = [];
  const source: FleetSource = {
    poll: async (onView) => onView({ readAt: 1, machines } satisfies FleetView),
    clientFor: () => undefined,
    warnings: () => [],
    close: () => undefined,
  };
  return { source, set: (m: MachineView[]) => void (machines = m) };
}

function setup(opts: { enabled?: boolean; statePath?: string } = {}) {
  const statePath = opts.statePath ?? join((dirs.push(mkdtempSync(join(tmpdir(), "hf-needs-you-"))), dirs.at(-1)!), "notified.json");
  const fleet = fakeFleet();
  const sent: { title: string; body: string }[] = [];
  const make = () =>
    needsYouNotifier({
      log: () => undefined,
      enabled: () => opts.enabled ?? true,
      notify: async (title, body) => void sent.push({ title, body }),
      source: fleet.source,
      statePath,
    });
  return { fleet, sent, notifier: make(), restart: make, statePath };
}

describe("needs-you notifications", () => {
  it("notifies once on entry, not while it stays, and again after it leaves and returns", async () => {
    const { fleet, sent, notifier } = setup();
    fleet.set([machine("local", [run("HF-1")])]);
    await notifier.poll();
    expect(sent).toEqual([{ title: "app HF-1", body: "parked — budget exhausted · on this machine" }]);

    await notifier.poll();
    await notifier.poll();
    expect(sent, "no repeat while it stays in the set").toHaveLength(1);

    fleet.set([machine("local", [run("HF-1", { phase: "running", attentionReason: null })])]);
    await notifier.poll();
    fleet.set([machine("local", [run("HF-1", { phase: "waiting_for_human", attentionReason: null })])]);
    await notifier.poll();
    expect(sent.map((s) => s.body)).toEqual(["parked — budget exhausted · on this machine", "waiting for a human reply · on this machine"]);
  });

  it("names the machine a remote item is on", async () => {
    const { fleet, sent, notifier } = setup();
    fleet.set([machine("local", []), machine("build-box", [run("HF-7", { phase: "running", attentionReason: null, prGreen: true, prNumber: 12 })])]);
    await notifier.poll();
    expect(sent).toEqual([{ title: "app HF-7", body: "PR #12 is green — ready to merge · on build-box" }]);
  });

  it("is never called when the machine has not opted in", async () => {
    const { fleet, sent, notifier } = setup({ enabled: false });
    fleet.set([machine("local", [run("HF-1")])]);
    await notifier.poll();
    expect(sent).toEqual([]);
  });

  it("a restart does not re-notify what was already notified", async () => {
    const first = setup();
    first.fleet.set([machine("local", [run("HF-1")])]);
    await first.notifier.poll();
    const again = setup({ statePath: first.statePath });
    again.fleet.set([machine("local", [run("HF-1")]), machine("build-box", [run("HF-2")])]);
    await again.notifier.poll();
    expect(first.sent).toHaveLength(1);
    expect(again.sent.map((s) => s.title), "only the new arrival").toEqual(["app HF-2"]);
  });

  it("a machine that goes silent does not make its items leave — no re-notify when it answers again", async () => {
    const { fleet, sent, notifier } = setup();
    fleet.set([machine("local", []), machine("build-box", [run("HF-2")])]);
    await notifier.poll();
    fleet.set([machine("local", []), machine("build-box", [], { state: "unverifiable", repos: [] })]);
    await notifier.poll();
    fleet.set([machine("local", []), machine("build-box", [run("HF-2")])]);
    await notifier.poll();
    expect(sent.map((s) => s.title), "the unverifiable machine itself is not an item either").toEqual(["app HF-2"]);
  });

  it("a notify that fails is retried on the next poll", async () => {
    const { fleet, sent, statePath } = setup();
    let fail = true;
    const notifier = needsYouNotifier({
      log: () => undefined,
      enabled: () => true,
      notify: async (title, body) => {
        if (fail) throw new Error("no herdr");
        sent.push({ title, body });
      },
      source: fleet.source,
      statePath,
    });
    fleet.set([machine("local", [run("HF-1")])]);
    await notifier.poll();
    fail = false;
    await notifier.poll();
    expect(sent.map((s) => s.title)).toEqual(["app HF-1"]);
  });
});
