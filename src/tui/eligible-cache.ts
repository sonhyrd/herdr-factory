// One rule about the dashboard's eligible-work rows: an item that has since been CLAIMED must not
// render as both a running card and a ready one.
//
// It can, because the refresh paints in two phases — a quick status-only paint, then the slower
// per-machine eligible queries folding in (`tui/fleet-view.ts`) — and the quick paint carries the
// last successful eligible result forward rather than blanking it. That carry-forward is what keeps
// the rows from blinking out for a frame, and it is also how a stale item survives long enough to
// collide with the run that claimed it.
//
// (The carry-forward itself lives in `fleet-view.ts`, keyed per machine AND repo, since it also has
// to drop the entries of a repo a reachable machine no longer serves.)
import type { ActiveRun, EligibleItem } from "./api.ts";

/** Source+key identity of a work item — the (work_source, ticket_key) pair the engine dedups on. */
const idOf = (source: string | null, key: string) => `${source ?? ""}|${key}`;

/**
 * Drop eligible items that already appear as an active run (same source+key). A carried-forward
 * eligible item can collide with a run that claimed it since the last successful fold-in — without
 * this it would render as BOTH a running row and an eligible row for a frame.
 */
export function withoutClaimed(eligible: EligibleItem[], active: ActiveRun[]): EligibleItem[] {
  const claimed = new Set(active.map((r) => idOf(r.workSource, r.ticketKey)));
  return eligible.filter((i) => !claimed.has(idOf(i.source, i.key)));
}
