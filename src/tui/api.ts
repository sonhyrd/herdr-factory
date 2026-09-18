// The TUI's hot-reload nudge for THIS machine's server, plus the API shapes its views are written
// against.
//
// This used to be the Dashboard's whole client. It isn't any more: the Dashboard reads and acts
// through a `MachineClient` (see `fleet/client.ts` and `tui/fleet-view.ts`), which speaks the same
// API against this machine *and* every other one — so the per-call readers here would have been a
// second, single-machine copy of the same thing, drifting from the one the fleet uses.
//
// What is left is the one call that is genuinely local: after the config editor saves this
// machine's `config.yml`, the resident server here is told to re-read it. Config lives on each
// host, so there is nothing to route.
//
// The response shapes live in `fleet/shapes.ts` (a zero-import leaf) and are re-exported here so
// the TUI's own imports stay `./api.ts`.
import { readFileSync } from "node:fs";
import { serverInfoPath } from "../config-paths.ts";
import type { ReloadOutcome } from "../fleet/shapes.ts";

export type {
  ActionResult,
  ActiveRun,
  EligibleItem,
  Health,
  Posted,
  ReloadOutcome,
  RepoStatus,
  ResumeOutcome,
  RetryNowOutcome,
  TimelineEvent,
} from "../fleet/shapes.ts";

interface ServerInfo {
  pid: number;
  port: number;
}

/** Read + validate server.json; null if absent/malformed (== "no server"). */
function readInfo(): ServerInfo | null {
  try {
    const o = JSON.parse(readFileSync(serverInfoPath(), "utf8")) as Partial<ServerInfo>;
    if (typeof o.pid !== "number" || typeof o.port !== "number") return null;
    process.kill(o.pid, 0);
    return { pid: o.pid, port: o.port };
  } catch {
    return null;
  }
}

/** Best-effort hot-reload nudge after a config save, so the running server re-reads config.yml
 *  without a restart. Silent when there's no server to reach — but per-repo LOAD failures are
 *  surfaced: a saved config that knocks a repo out of the tick loop must not read as success. */
export async function postReload(): Promise<ReloadOutcome> {
  const info = readInfo();
  if (!info) return { reached: false, failures: [] };
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/reload`, { method: "POST", signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { reached: false, failures: [] };
    const body = (await res.json().catch(() => ({}))) as { failures?: { name: string; error: string }[] };
    return { reached: true, failures: body.failures ?? [] };
  } catch {
    return { reached: false, failures: [] };
  }
}
