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
import type { EligibleItem } from "./api.ts";
import type { MachineView } from "./fleet-view.ts";

/** Source+key identity of a work item — the (work_source, ticket_key) pair the engine dedups on. */
const idOf = (source: string | null, key: string) => `${source ?? ""}|${key}`;

/** The (source, key) identities of every active run in the view — across EVERY machine and repo.
 *  A ticket is claimed once for the whole fleet: a run on grok-bot means the same ticket is not
 *  "ready" on contabo, nor under the other repo config polling the same source. A server only knows
 *  its own runs, so this fleet-wide set is the only place that collision can be seen. Stale
 *  machines count: their rows are last-known, and last-known-claimed still beats showing it ready. */
export function fleetClaimed(machines: MachineView[]): Set<string> {
  const claimed = new Set<string>();
  for (const m of machines) {
    for (const r of m.repos) {
      for (const run of r.status?.active ?? []) claimed.add(idOf(run.workSource, run.ticketKey));
    }
  }
  return claimed;
}

/**
 * Drop eligible items that already appear as an active run (same source+key), given `fleetClaimed`'s
 * set. A carried-forward eligible item can collide with a run that claimed it since the last
 * successful fold-in — without this it would render as BOTH a running row and an eligible row for a
 * frame.
 */
export function withoutClaimed(eligible: EligibleItem[], claimed: ReadonlySet<string>): EligibleItem[] {
  return eligible.filter((i) => !claimed.has(idOf(i.source, i.key)));
}
