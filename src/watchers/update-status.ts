// Update-status model + pure readers, split out of updater.ts. This module is deliberately
// telemetry-free (node builtins + config-paths only) so surfaces that merely READ the last update
// attempt — the TUI dashboard banner, the `doctor` check — can pull `updateWarning`/`readUpdateStatus`
// WITHOUT dragging the whole update-execution path (git/provision) and its Effect + OpenTelemetry
// stack into their import graph. That accidental pull put ~2s of eager module load on the TUI's
// startup path (the dashboard is the one eagerly-built tab). updater.ts re-exports everything here,
// so existing importers keep working.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { updateStatusPath } from "../config-paths.ts";

/** Auto-update is ON by default; set HERDR_FACTORY_AUTO_UPDATE to 0/false/no/off to disable it. */
export function autoUpdateEnabled(): boolean {
  const v = (process.env.HERDR_FACTORY_AUTO_UPDATE ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

/** Which commit the updater lands on. `main` = the branch upstream tip (today's behavior); `stable`
 *  = the newest release tag, so a broken main commit can't reach the box. Like the auto-update flag,
 *  it's captured into the service environment at INSTALL time — re-run `herdr-factory install` (with
 *  HERDR_CHANNEL set) to change it. Anything but `stable` (incl. unset/typo) resolves to `main`. */
export type UpdateChannel = "main" | "stable";
export function updateChannel(): UpdateChannel {
  return (process.env.HERDR_CHANNEL ?? "").trim().toLowerCase() === "stable" ? "stable" : "main";
}

/** How long a dirty checkout stays quiet after we've notified about a skipped reset, before we
 *  re-notify (the "once, throttled" backstop — the common case notifies exactly once, on the tick
 *  the checkout first goes dirty-and-behind). */
export const DIRTY_RENOTIFY_MS = 6 * 60 * 60 * 1000; // 6h

/** How old the last recorded attempt may get before the updater counts as STALLED. Every `ensure-up`
 *  tick (60s) records one, so 30 missed ticks means nothing is running it — no scheduler, or a
 *  scheduler stuck on a hung tick (issue #35) — and the box is silently falling behind. */
export const UPDATE_STALL_MS = 30 * 60_000;

/** A compact "3m ago" / "2h ago" / "5d ago" for an epoch-ms timestamp (relative to `now`). */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** The last attempt is older than {@link UPDATE_STALL_MS} while auto-update is on. */
export function updateStalled(status: UpdateStatus, now = Date.now()): boolean {
  return autoUpdateEnabled() && now - status.at > UPDATE_STALL_MS;
}

export interface UpdateResult {
  updated: boolean;
  reason?: string; // why it didn't update (when updated === false)
  from?: string;
  to?: string;
}

/** The outcome of the LAST update attempt, persisted to {@link updateStatusPath} each tick so it can
 *  be surfaced outside the supervisor log. `behind` = the checkout is NOT on its channel target
 *  (a dirty skip, a failed reset, or a stable box with no tag yet) — what `doctor`/TUI paint amber. */
export interface UpdateStatus {
  channel: UpdateChannel;
  at: number; // epoch ms of this attempt
  outcome: "updated" | "up_to_date" | "skipped" | "failed";
  reason?: string; // skip/failure reason (absent on updated/up_to_date)
  head?: string; // HEAD sha after this tick
  target?: string; // the channel target's sha (upstream tip / newest-tag commit), when resolved
  targetRef?: string; // human ref for the target: "origin/main" (main) or the tag name (stable)
  behind: boolean; // head !== target — the box isn't running what its channel says it should
  dirtySkip?: boolean; // the reset was skipped because the checkout had uncommitted changes
  warning?: string; // reset landed but a post-step (Node provision / dep install) failed — degraded
  notifiedAt?: number; // last time we notified about a dirty skip (throttle bookkeeping)
}

/** Read the last recorded update attempt (or null if none / malformed — treated as "no attempt"). */
export function readUpdateStatus(): UpdateStatus | null {
  return readUpdateStatusAt(updateStatusPath());
}
export function readUpdateStatusAt(path: string): UpdateStatus | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateStatus>;
    if (typeof o.at === "number" && typeof o.outcome === "string") return o as UpdateStatus;
    return null;
  } catch {
    return null;
  }
}

/** A short amber note for a warn-worthy last update — the box failed to update, skipped a reset over
 *  a dirty checkout, is behind its channel target, has STALLED (no attempt recorded for
 *  {@link UPDATE_STALL_MS}), or updated but a post-step (deps/Node) failed —
 *  or null when the last attempt is clean or unrecorded. Shared by the `doctor` check and the TUI
 *  dashboard banner so both agree on when the update state wants attention. */
export function updateWarning(status: UpdateStatus | null = readUpdateStatus()): string | null {
  if (!status) return null;
  const target = status.targetRef ?? (status.channel === "stable" ? "the latest tag" : "upstream");
  if (status.outcome === "failed") return `auto-update failed (${status.channel}): ${status.reason ?? "unknown"}`;
  if (status.dirtySkip) return `auto-update skipped (${status.channel}): checkout has uncommitted changes`;
  if (status.behind) return `${status.channel} channel behind ${target}`;
  if (updateStalled(status)) return `auto-update stalled — last check ${ago(status.at)}`;
  if (status.warning) return `updated (${status.channel}) but ${status.warning}`;
  return null;
}

/** Persist the attempt outcome. Best-effort — a write failure must never break the tick. */
export function writeUpdateStatus(status: UpdateStatus, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    /* the state file is a convenience surface, not load-bearing — ignore */
  }
}
