// Read-only client for the resident server, used by the Dashboard. Deliberately tiny: it reads the
// server's advertised port from server.json (serverInfoPath) and hits the JSON API with plain
// `fetch` — no Effect/telemetry machinery (that's the engine's server/client.ts; this is just a
// UI). Every call returns null when the server can't be reached, so the Dashboard degrades to
// "server not running" instead of throwing.
//
// The response shapes live in `fleet/shapes.ts` (a zero-import leaf) because the fleet's
// `MachineClient` speaks the same API against OTHER machines, and the two readers must not drift.
// They are re-exported here so the TUI's own imports stay `./api.ts`.
import { readFileSync } from "node:fs";
import { serverInfoPath } from "../config-paths.ts";
import type {
  ActionResult,
  EligibleItem,
  Health,
  Posted,
  ReloadOutcome,
  RepoStatus,
  ResumeOutcome,
  RetryNowOutcome,
  RunObligations,
  TimelineEvent,
} from "../fleet/shapes.ts";

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
  version: string;
  startedAt: number;
}

/** Read + validate server.json; null if absent/malformed (== "no server"). */
function readInfo(): ServerInfo | null {
  try {
    const o = JSON.parse(readFileSync(serverInfoPath(), "utf8")) as Partial<ServerInfo>;
    if (typeof o.pid !== "number" || typeof o.port !== "number") return null;
    try {
      process.kill(o.pid, 0);
    } catch {
      return null;
    }
    return { pid: o.pid, port: o.port, version: o.version ?? "?", startedAt: o.startedAt ?? 0 };
  } catch {
    return null;
  }
}

/** The resident server's advertised port, or null when no server is running. */
export function serverPort(): number | null {
  return readInfo()?.port ?? null;
}

async function getJson<T>(path: string, timeoutMs = 2500): Promise<T | null> {
  const info = readInfo();
  if (!info) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchHealth(): Promise<Health | null> {
  return getJson<Health>("/health", 500);
}

export function fetchStatus(repo: string, detail = false): Promise<RepoStatus | null> {
  return getJson<RepoStatus>(`/repos/${encodeURIComponent(repo)}/status${detail ? "?refresh=1" : "?quick=1"}`, detail ? 2500 : 500);
}

export function fetchEligible(repo: string): Promise<{ eligible: EligibleItem[] } | null> {
  return getJson<{ eligible: EligibleItem[] }>(`/repos/${encodeURIComponent(repo)}/eligible`);
}

export function fetchTimeline(repo: string, key: string): Promise<{ timeline: TimelineEvent[] } | null> {
  return getJson<{ timeline: TimelineEvent[] }>(`/repos/${encodeURIComponent(repo)}/timeline?key=${encodeURIComponent(key)}`);
}

/** The engine's "why is this run waiting and what would move it" answer (GET /obligations).
 *  null when there is no server, no active run for the key, or the fetch fails — the detail view
 *  simply omits its narrative section then. The shape import is a zero-import leaf, so this module
 *  stays out of the engine graph. */
export function fetchObligations(repo: string, key: string, source?: string): Promise<RunObligations | null> {
  const q = `key=${encodeURIComponent(key)}${source ? `&source=${encodeURIComponent(source)}` : ""}`;
  return getJson<RunObligations>(`/repos/${encodeURIComponent(repo)}/obligations?${q}`);
}

async function postBody<T>(path: string, body?: unknown): Promise<Posted<T>> {
  const info = readInfo();
  if (!info) return { ok: false, error: "server not running" };
  try {
    // Claim/tick/retry-now can do real work (a retry-now flushes uploads inline), so allow a generous
    // timeout — the UI stays responsive, since the await doesn't block the event loop and the action
    // line shows progress.
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) return { ok: false, error: typeof json.error === "string" ? json.error : `server returned ${res.status}` };
    return { ok: true, body: json as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** POST where only "did it work" matters — the body is discarded. */
async function post(path: string, body?: unknown): Promise<ActionResult> {
  const r = await postBody<unknown>(path, body);
  return r.ok ? { ok: true } : r;
}

export function postTick(repo: string): Promise<ActionResult> {
  return post(`/repos/${encodeURIComponent(repo)}/tick`);
}
export function postClaim(repo: string, key: string, belt?: string): Promise<ActionResult> {
  return post(`/repos/${encodeURIComponent(repo)}/claim`, belt ? { key, belt } : { key });
}
export function postTeardown(repo: string, key: string, source?: string | null): Promise<ActionResult> {
  return post(`/repos/${encodeURIComponent(repo)}/teardown`, source ? { key, source } : { key });
}

export function postResume(repo: string, key: string, source?: string | null): Promise<Posted<ResumeOutcome>> {
  return postBody<ResumeOutcome>(`/repos/${encodeURIComponent(repo)}/resume`, source ? { key, source } : { key });
}

export function postRetryNow(repo: string, key?: string | null, source?: string | null): Promise<Posted<RetryNowOutcome>> {
  const body = key ? (source ? { key, source } : { key }) : {};
  return postBody<RetryNowOutcome>(`/repos/${encodeURIComponent(repo)}/retry-now`, body);
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
