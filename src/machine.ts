// Host-local admission limits: `<configDir>/machine.yml`. The config dir is often a git clone shared
// by several hosts, so per-host capacity can't live in repos/*/config.yml — this file is untracked
// (gitignore it) and bounds EVERY repo this host serves. Absent file / absent key = no machine gate.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { configDir } from "./config-paths.ts";

export const MachineConfigSchema = z
  .object({
    /** Machine-wide ceiling on occupying (working) runs across ALL repos — same count as the per-repo cap. */
    max_active_workspaces: z.number().int().min(0).optional(),
    /** Skip Phase B claims while available memory is below this many MB. */
    min_free_memory_mb: z.number().int().min(0).optional(),
  })
  .strict();

export interface MachineConfig {
  maxActiveWorkspaces?: number;
  minFreeMemoryMb?: number;
}

export function machineConfigPath(): string {
  return join(configDir(), "machine.yml");
}

/** Read + validate machine.yml. Absent (or empty) file ⇒ `{}`; invalid ⇒ throws a readable error. */
export function loadMachineConfig(path = machineConfigPath()): MachineConfig {
  if (!existsSync(path)) return {};
  const result = MachineConfigSchema.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid machine config (${path}):\n${detail}`);
  }
  return { maxActiveWorkspaces: result.data.max_active_workspaces, minFreeMemoryMb: result.data.min_free_memory_mb };
}

export function machineJsonSchema(): Record<string, unknown> {
  return { ...(z.toJSONSchema(MachineConfigSchema, { io: "input" }) as Record<string, unknown>), title: "herdr-factory host-local machine.yml" };
}

/** Memory the OS could hand a new agent without swapping, in MB. Linux: `MemAvailable`. macOS:
 *  `vm_stat` free + inactive + speculative pages — `os.freemem()` there counts only truly free pages
 *  (a few hundred MB on a healthy Mac), which would pause claims forever. Anything else, or a read
 *  failure: `os.freemem()`. */
export function availableMemoryMb(): number {
  try {
    if (process.platform === "linux") {
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
      if (m) return Math.floor(Number(m[1]) / 1024);
    } else if (process.platform === "darwin") {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 5000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
      const pages = (label: string) => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(out)?.[1]);
      const bytes = (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
      if (Number.isFinite(bytes)) return Math.floor(bytes / 1048576);
    }
  } catch {
    /* fall through */
  }
  return Math.floor(freemem() / 1048576);
}

export type MachineGate = { kind: "memory" | "capacity"; message: string };

/** The memory half of the gate (no lock needed — nothing to race). */
export function memoryGate(machine: MachineConfig, readMb: () => number): MachineGate | null {
  if (machine.minFreeMemoryMb === undefined) return null;
  const free = readMb();
  return free < machine.minFreeMemoryMb ? { kind: "memory", message: `low memory: ${free} MB < ${machine.minFreeMemoryMb} MB — not claiming` } : null;
}

/** The capacity half; `occupying` is the machine-wide count (store.countOccupyingAll()). */
export function capacityGate(machine: MachineConfig, occupying: number): MachineGate | null {
  if (machine.maxActiveWorkspaces === undefined || occupying < machine.maxActiveWorkspaces) return null;
  return { kind: "capacity", message: `machine at capacity (${occupying}/${machine.maxActiveWorkspaces})` };
}

/** Current gate for status surfaces (status / explain / doctor / TUI): memory first, then capacity. */
export function machineGate(machine: MachineConfig, occupying: number, readMb: () => number): MachineGate | null {
  return memoryGate(machine, readMb) ?? capacityGate(machine, occupying);
}

// Log once per state change, process-wide (several repos' ticks share one serve process).
let lastGateKind: MachineGate["kind"] | null = null;

export function noteMachineGate(log: (level: "info" | "warn", msg: string) => void, gate: MachineGate | null): void {
  if ((gate?.kind ?? null) === lastGateKind) return;
  if (gate) log("warn", gate.message);
  else log("info", "machine admission resumed — claiming again");
  lastGateKind = gate?.kind ?? null;
}

export function resetMachineGateLog(): void {
  lastGateKind = null;
}
