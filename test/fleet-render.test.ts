// `herdr-factory fleet` marks a machine whose build differs from this one — a box the updater has not
// reached (issue #35) is otherwise invisible from its own dashboard.
import { describe, expect, it } from "vitest";
import { renderFleet } from "../src/cli/fleet.ts";
import type { FleetMachine } from "../src/fleet/read.ts";

const machine = (over: Partial<FleetMachine>): FleetMachine => ({
  name: "m",
  sshTarget: null,
  local: false,
  state: "ok",
  version: "1.0.0+aaa",
  lastSeenAt: 0,
  repos: [],
  runs: [],
  problems: [],
  ...over,
});

describe("renderFleet — build drift", () => {
  it("flags a remote on another build, not one on the same build", () => {
    const out = renderFleet({
      readAt: 0,
      runs: [],
      machines: [
        machine({ name: "here", local: true }),
        machine({ name: "same", sshTarget: "same" }),
        machine({ name: "old", sshTarget: "old", version: "1.0.0+zzz" }),
      ],
    });
    expect(out).toMatch(/old \(old\) — v1\.0\.0\+zzz.*⚠ build differs from this machine \(v1\.0\.0\+aaa\)/);
    expect(out).not.toMatch(/same \(same\).*differs/);
  });
});
