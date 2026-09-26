import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableMemoryMb, claimDeferralNote, describeMachine, loadMachineConfig, machineConfigPath, machineGate, machineHostAlias } from "../src/machine.ts";

const dirs: string[] = [];
const saved = process.env.HERDR_FACTORY_CONFIG_DIR;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.HERDR_FACTORY_CONFIG_DIR;
  else process.env.HERDR_FACTORY_CONFIG_DIR = saved;
});
const configDir = () => {
  const d = mkdtempSync(join(tmpdir(), "hf-machine-"));
  dirs.push(d);
  process.env.HERDR_FACTORY_CONFIG_DIR = d;
  return d;
};

describe("machine.yml", () => {
  it("absent or empty file ⇒ no limits", () => {
    configDir();
    expect(loadMachineConfig()).toEqual({});
    writeFileSync(machineConfigPath(), "");
    expect(loadMachineConfig()).toEqual({});
  });

  it("re-reads on every load (what `reload` → buildDeps relies on)", () => {
    configDir();
    writeFileSync(machineConfigPath(), "max_active_workspaces: 2\n");
    expect(loadMachineConfig()).toEqual({ maxActiveWorkspaces: 2, minFreeMemoryMb: undefined });
    writeFileSync(machineConfigPath(), "max_active_workspaces: 1\nmin_free_memory_mb: 2048\n");
    expect(loadMachineConfig()).toEqual({ maxActiveWorkspaces: 1, minFreeMemoryMb: 2048 });
  });

  it("carries the layout hook's ignored pane labels (host-local: which plugins this host runs)", () => {
    configDir();
    writeFileSync(machineConfigPath(), "layout_hook:\n  ignore_pane_labels: [Sidebar, Files]\n");
    expect(loadMachineConfig().layoutHookIgnorePaneLabels).toEqual(["Sidebar", "Files"]);
    writeFileSync(machineConfigPath(), "layout_hook:\n  ignore_pane_labels: []\n");
    expect(loadMachineConfig().layoutHookIgnorePaneLabels).toEqual([]); // explicitly ignore none
    writeFileSync(machineConfigPath(), "layout_hook:\n  ignore_panes: [Sidebar]\n");
    expect(() => loadMachineConfig()).toThrow(/layout_hook:.*Unrecognized key/s);
  });

  it("host_alias names this host in the claim ledger, and never breaks the marker (issue #70)", () => {
    configDir();
    expect(machineHostAlias()).toBeUndefined(); // absent ⇒ os.hostname() still wins
    writeFileSync(machineConfigPath(), "host_alias: contabo\n");
    expect(loadMachineConfig().hostAlias).toBe("contabo");
    expect(machineHostAlias()).toBe("contabo");
    writeFileSync(machineConfigPath(), "host_alias: 'bad host]'\n");
    expect(() => loadMachineConfig()).toThrow(/host_alias/);
    expect(machineHostAlias()).toBeUndefined(); // tolerant: a broken machine.yml fails in doctor, not every config load
  });

  it("notify_needs_you opts this host into fleet-wide needs-you notifications (issue #130)", () => {
    configDir();
    expect(loadMachineConfig().notifyNeedsYou).toBeUndefined();
    writeFileSync(machineConfigPath(), "notify_needs_you: true\n");
    expect(loadMachineConfig().notifyNeedsYou).toBe(true);
    writeFileSync(machineConfigPath(), "notify_needs_you: yes please\n");
    expect(() => loadMachineConfig()).toThrow(/notify_needs_you/);
  });

  it("rejects unknown keys and bad values with a readable error", () => {
    configDir();
    writeFileSync(machineConfigPath(), "max_active_workspace: 2\n");
    expect(() => loadMachineConfig()).toThrow(/invalid machine config .*machine\.yml[\s\S]*Unrecognized key/);
    writeFileSync(machineConfigPath(), "min_free_memory_mb: -1\n");
    expect(() => loadMachineConfig()).toThrow(/min_free_memory_mb:/);
    writeFileSync(machineConfigPath(), "max_active_workspaces: two\n");
    expect(() => loadMachineConfig()).toThrow(/max_active_workspaces:/);
  });

  it("gate: memory first, then capacity, else none", () => {
    const m = { maxActiveWorkspaces: 2, minFreeMemoryMb: 500 };
    expect(machineGate(m, 2, () => 100)?.kind).toBe("memory");
    expect(machineGate(m, 2, () => 900)).toEqual({ kind: "capacity", message: "machine at capacity (2/2)" });
    expect(machineGate(m, 1, () => 900)).toBeNull();
    expect(machineGate({}, 99, () => 0)).toBeNull();
    expect(describeMachine({}, 3, () => 0)).toBeNull();
    expect(describeMachine(m, 2, () => 900)?.line).toBe("machine: cap 2/2 working across all repos · memory 900 MB available (floor 500 MB) — machine at capacity (2/2)");
  });

  it("claim-deferral note: silent at zero, singular at one", () => {
    expect(claimDeferralNote(0)).toBeNull();
    expect(claimDeferralNote(1)).toBe("claims deferred 1 tick (machine claim lock)");
    expect(claimDeferralNote(7)).toBe("claims deferred 7 ticks (machine claim lock)");
  });

  it("reads a positive available-memory figure on this host", () => {
    expect(availableMemoryMb()).toBeGreaterThan(0);
  });
});
