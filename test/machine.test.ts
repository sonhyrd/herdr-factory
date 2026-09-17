import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableMemoryMb, loadMachineConfig, machineConfigPath, machineGate } from "../src/machine.ts";

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
  });

  it("reads a positive available-memory figure on this host", () => {
    expect(availableMemoryMb()).toBeGreaterThan(0);
  });
});
