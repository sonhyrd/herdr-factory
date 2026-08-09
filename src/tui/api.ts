// Read-only client for the resident server, used by the Dashboard. Deliberately tiny: it reads the
// server's advertised port from server.json (serverInfoPath) and hits the JSON API with plain
// `fetch` — no Effect/telemetry machinery (that's the engine's server/client.ts; this is just a
// UI). Every call returns null when the server can't be reached, so the Dashboard degrades to
// "server not running" instead of throwing.
import { readFileSync } from "node:fs";
import { serverInfoPath } from "../config-paths.ts";
import type { RunObligations } from "../core/obligations-shape.ts";

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

/** One active run as returned by GET /repos/{repo}/status. */
export interface ActiveRun {
  id: number;
  ticketKey: string;
  workSource: string | null;
  belt: string | null;
  issueType: string | null;
  branch: string | null;
  phase: string;
  step: string | null;
  prNumber: number | null;
  summary: string | null;
  outcome: string | null;
  attentionReason: string | null;
  worker: string | null;
  createdAt: number | null; // epoch seconds
  steps: { step: string; done: boolean; startedAt: number | null; doneAt: number | null; pass: number }[];
  /** A background problem the step columns can't show — e.g. the evidence step reads "done" (URLs
   *  emitted) but its media upload is still stuck retrying. Absent when the run is healthy. */
  problem?: { kind: "evidence-upload"; detail: string };
}

export interface RepoStatus {
  repo: string;
  limits: { maxActiveWorkspaces: number };
  /** Per-source auth light (same vocab as evidenceSso): "down" = the source can't authenticate (its
   *  claims + write-backs are paused, auto-resuming on re-auth); "na" = the source needs no auth. */
  sources: { name: string; type: string; auth?: { state: "ok" | "down" | "na"; detail?: string; account?: string } }[];
  belts: {
    name: string;
    beltType: string;
    source: string;
    priority: number;
    active?: boolean;
    label?: string;
    steps: string[];
    diagnostic?: { state: "ok" | "down"; detail?: string };
  }[];
  active: ActiveRun[];
  finished: { id: number; ticketKey: string; phase: string; outcome: string | null; prNumber: number | null }[];
  /** Evidence-upload credential (AWS SSO) health for the dashboard light. "na" = no evidence config. */
  evidenceSso?: { state: "ok" | "down" | "na"; detail?: string };
}

export interface Health {
  ok: boolean;
  version: string;
  pid: number;
  uptimeSec: number;
  repos: { name: string; active: number }[];
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

export interface EligibleItem {
  source: string;
  belt: string;
  key: string;
  summary: string;
  type: string;
}

export function fetchEligible(repo: string): Promise<{ eligible: EligibleItem[] } | null> {
  return getJson<{ eligible: EligibleItem[] }>(`/repos/${encodeURIComponent(repo)}/eligible`);
}

export interface TimelineEvent {
  ts: number;
  type: string;
  detail: string | null;
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

/** Result of a mutating action: ok, or a reason to show the user. */
export type ActionResult = { ok: true } | { ok: false; error: string };

async function post(path: string, body?: unknown): Promise<ActionResult> {
  const info = readInfo();
  if (!info) return { ok: false, error: "server not running" };
  try {
    // Claim/tick can do real work, so allow a generous timeout (the UI stays responsive — the await
    // doesn't block the event loop, and the banner shows progress).
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) return { ok: false, error: typeof json.error === "string" ? json.error : `server returned ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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

export interface ReloadOutcome {
  reached: boolean; // a server answered at all
  failures: { name: string; error: string }[]; // repos the server could NOT load after the reload
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
