// One machine's factory API, behind one interface.
//
// The calls are the whole set a UI needs (status, eligible, timeline, obligations, health, claim,
// teardown, resume, retry-now, tick, reload) — so a caller that used to be hard-wired to the local
// server can be handed a `MachineClient` and stop caring where the run lives. That is what the TUI's
// Dashboard now reads and acts through, this machine included, rather than keeping a second
// single-machine client of its own.
// Reads answer `null` when the machine can't be reached; actions answer `{ ok: false, error }`.
// Nothing here throws for an unreachable machine: that is a fact the fleet view reports, not a
// failure that should take the command down.
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
} from "./shapes.ts";
import type { Machine } from "./machines.ts";
import type { MachineTransport } from "./transport.ts";

export interface MachineClient {
  readonly machine: Machine;
  health(): Promise<Health | null>;
  status(repo: string, detail?: boolean): Promise<RepoStatus | null>;
  eligible(repo: string): Promise<{ eligible: EligibleItem[] } | null>;
  timeline(repo: string, key: string): Promise<{ timeline: TimelineEvent[] } | null>;
  obligations(repo: string, key: string, source?: string): Promise<RunObligations | null>;
  tick(repo: string): Promise<ActionResult>;
  claim(repo: string, key: string, belt?: string): Promise<ActionResult>;
  teardown(repo: string, key: string, source?: string | null): Promise<ActionResult>;
  resume(repo: string, key: string, source?: string | null): Promise<Posted<ResumeOutcome>>;
  retryNow(repo: string, key?: string | null, source?: string | null): Promise<Posted<RetryNowOutcome>>;
  reload(): Promise<ReloadOutcome>;
  /** Why the transport could not reach this machine (ssh's own stderr), or null when it does not
   *  know. What the fleet view reports instead of a generic "could not reach its API". */
  failureDetail(): string | null;
}

/** Same generous POST budget as the TUI's: a claim or a retry-now does real work (a retry-now
 *  flushes uploads inline), and killing it at a read timeout would abandon it half-done. */
const ACTION_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 2500;

const r = (repo: string) => `/repos/${encodeURIComponent(repo)}`;

/** A `MachineClient` over HTTP, with the base URL resolved through the transport on every call.
 *  Resolving per call (rather than at construction) is what makes a machine that comes back during
 *  a long-lived TUI session start answering again without a reconnect dance. */
export function httpMachineClient(machine: Machine, transport: MachineTransport): MachineClient {
  async function get<T>(path: string, timeoutMs = READ_TIMEOUT_MS): Promise<T | null> {
    const base = await transport.endpoint(machine);
    if (!base) return null;
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async function postBody<T>(path: string, body?: unknown): Promise<Posted<T>> {
    const base = await transport.endpoint(machine);
    if (!base) return { ok: false, error: `${machine.name}: unreachable` };
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
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

  async function post(path: string, body?: unknown): Promise<ActionResult> {
    const posted = await postBody<unknown>(path, body);
    return posted.ok ? { ok: true } : posted;
  }

  return {
    machine,
    failureDetail: () => transport.failureDetail?.(machine) ?? null,
    health: () => get<Health>("/health", 500),
    status: (repo, detail = false) => get<RepoStatus>(`${r(repo)}/status${detail ? "?refresh=1" : "?quick=1"}`, detail ? 2500 : 500),
    eligible: (repo) => get<{ eligible: EligibleItem[] }>(`${r(repo)}/eligible`),
    timeline: (repo, key) => get<{ timeline: TimelineEvent[] }>(`${r(repo)}/timeline?key=${encodeURIComponent(key)}`),
    obligations: (repo, key, source) =>
      get<RunObligations>(`${r(repo)}/obligations?key=${encodeURIComponent(key)}${source ? `&source=${encodeURIComponent(source)}` : ""}`),
    tick: (repo) => post(`${r(repo)}/tick`),
    claim: (repo, key, belt) => post(`${r(repo)}/claim`, belt ? { key, belt } : { key }),
    teardown: (repo, key, source) => post(`${r(repo)}/teardown`, source ? { key, source } : { key }),
    resume: (repo, key, source) => postBody<ResumeOutcome>(`${r(repo)}/resume`, source ? { key, source } : { key }),
    retryNow: (repo, key, source) => postBody<RetryNowOutcome>(`${r(repo)}/retry-now`, key ? (source ? { key, source } : { key }) : {}),
    reload: async () => {
      const posted = await postBody<{ failures?: { name: string; error: string }[] }>("/reload");
      return posted.ok ? { reached: true, failures: posted.body.failures ?? [] } : { reached: false, failures: [] };
    },
  };
}
