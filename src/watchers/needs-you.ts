// The needs-you notifier: a `herdr notification show` the moment something ENTERS the fleet's
// needs-you set — the dashboard's top section, read the same way, so the notification and the board
// can never disagree about what is waiting on a human.
//
// Opt-in per machine (`machine.yml` `notify_needs_you`), because the watch is fleet-wide: every host
// that turned it on would announce the same item to the same operator. It runs inside `serve`, reads
// only the fleet's quick (status) phase, and remembers what it announced on disk, so a restart does
// not re-announce everything already waiting.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { needsYouNotifiedPath } from "../config-paths.ts";
import { LOCAL_MACHINE } from "../fleet/machines.ts";
import { loadMachineConfig } from "../machine.ts";
import { createFleetSource, needsYou, quickView, type FleetSource, type FleetView, type NeedsYouItem } from "../tui/fleet-view.ts";

const execFileP = promisify(execFile);

/** How often the fleet is read for new arrivals. */
export const NEEDS_YOU_POLL_MS = 30_000;

/** An item's identity across polls: where it is and which run — not WHY, so a parked run whose reason
 *  text changes, or a green PR that is also parked, is one item and is announced once. */
export const needsYouId = (i: NeedsYouItem): string => `${i.machine}|${i.repo}|${i.key ?? ""}`;

/**
 * What entered the set since `notified`, and the set to remember next. A machine-level entry (a box
 * that stopped answering) is not an item and is never announced. An id whose machine could not be
 * read this time is KEPT: a silent box has not shown its items leaving, and forgetting them would
 * re-announce every one of them the moment it answers again.
 */
export function diffNeedsYou(notified: Set<string>, view: FleetView): { enter: NeedsYouItem[]; next: Set<string> } {
  const now = new Map(needsYou(view.machines).filter((i) => i.repo).map((i) => [needsYouId(i), i]));
  const silent = new Set(view.machines.filter((m) => m.state !== "ok").map((m) => m.name));
  const next = new Set(now.keys());
  for (const id of notified) if (silent.has(id.slice(0, id.indexOf("|")))) next.add(id);
  return { enter: [...now].filter(([id]) => !notified.has(id)).map(([, i]) => i), next };
}

/** `nuxt-app MAMAS-9996` / `parked — budget exhausted · on build-box`. */
export function needsYouNotification(i: NeedsYouItem): { title: string; body: string } {
  return { title: i.key ? `${i.repo} ${i.key}` : i.repo, body: `${i.reason} · on ${i.machine === LOCAL_MACHINE ? "this machine" : i.machine}` };
}

/** Shell-free, same argv as HerdrClient.notify. A headless herdr answers `{"shown": false, "reason":
 *  "disabled"}` with exit 0 — that is success; only a failed spawn/exit throws. */
async function herdrNotify(title: string, body: string): Promise<void> {
  const bin = process.env.HERDR_BIN_PATH?.trim() || "herdr";
  await execFileP(bin, ["notification", "show", title, "--body", body, "--sound", "request"], { timeout: 30_000 });
}

function readNotified(path: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeNotified(path: string, ids: Set<string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify([...ids].sort()));
  renameSync(tmp, path);
}

function notifyEnabled(): boolean {
  try {
    return loadMachineConfig().notifyNeedsYou === true;
  } catch {
    return false; // an invalid machine.yml is reported by doctor and the reload, not here
  }
}

export interface NeedsYouNotifierOpts {
  log: (level: "info" | "warn", msg: string) => void;
  /** Read per poll, so a `machine.yml` edit takes effect without a restart. */
  enabled?: () => boolean;
  notify?: (title: string, body: string) => Promise<void>;
  source?: FleetSource;
  statePath?: string;
}

export interface NeedsYouNotifier {
  poll(): Promise<void>;
  stop(): void;
}

export function needsYouNotifier(opts: NeedsYouNotifierOpts): NeedsYouNotifier {
  const enabled = opts.enabled ?? notifyEnabled;
  const notify = opts.notify ?? herdrNotify;
  const path = opts.statePath ?? needsYouNotifiedPath();
  // Built on the first ENABLED poll: a machine that never opts in never dials its fleet.
  let source = opts.source ?? null;
  let polling = false;
  return {
    async poll() {
      if (polling || !enabled()) return;
      polling = true;
      try {
        source ??= createFleetSource();
        const view = await quickView(source);
        if (!view) return;
        const notified = readNotified(path);
        const { enter, next } = diffNeedsYou(notified, view);
        for (const item of enter) {
          const { title, body } = needsYouNotification(item);
          try {
            await notify(title, body);
            opts.log("info", `needs-you: notified ${title} — ${body}`);
          } catch (e) {
            // Not remembered, so the next poll tries again.
            next.delete(needsYouId(item));
            opts.log("warn", `needs-you: could not notify ${title} — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if ([...next].sort().join("\n") !== [...notified].sort().join("\n")) writeNotified(path, next);
      } catch (e) {
        opts.log("warn", `needs-you: poll failed — ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        polling = false;
      }
    },
    stop() {
      source?.close();
    },
  };
}
