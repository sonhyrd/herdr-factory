// The per-source RATE-LIMIT GATE: the typed "the backend told us to stop" signal, plus the
// process-local record of which work sources are currently backing off and until when.
//
// Why a gate and not just a retry: GitHub's primary limit is per ACCOUNT, not per process. Several
// hosts sharing one `gh` login (or one PAT) spend the same 5,000/hr, so once a poll answers 403 /
// 429 with `x-ratelimit-remaining: 0`, every further call from every belt on every host is both
// futile and part of the problem. Re-polling on the next tick is the failure mode this closes: the
// source is held until the reset stamp the backend itself named, then resumes on its own.
//
// Deliberately IN-MEMORY, mirroring the auth gate (src/auth/gate.ts): the resident `serve` process
// runs both the tick loop that OBSERVES the limit and the routes that SURFACE it, and a gate that
// re-derives on the next failed call loses nothing across a restart. What operators read out of
// band (`status`, `explain`, run in their own process) comes from the problem ledger instead, which
// reconcile writes alongside this record.
//
// A pure leaf (no imports) so clients/, core/ and server/ can all depend on it without a cycle.

export interface SourceRateLimitedInit {
  /** Epoch MILLISECONDS the backend's budget resets (Retry-After, or x-ratelimit-reset). */
  resetAtMs: number;
  /** Actionable detail shown to the operator — which call hit it, and what the headers said. */
  detail: string;
  /** True when the backend reported an exhausted budget (`x-ratelimit-remaining: 0`) rather than
   *  only a Retry-After — i.e. the account-wide primary limit, not a per-endpoint secondary one. */
  exhausted: boolean;
  cause?: unknown;
}

/** A work source is rate-limited and named when it will be usable again. Distinct from a generic
 *  backend error so the reconciler can hold the source instead of retrying it, and distinct from
 *  SourceUnauthenticatedError because no credential change fixes it — only time. */
export class SourceRateLimitedError extends Error {
  readonly resetAtMs: number;
  readonly detail: string;
  readonly exhausted: boolean;
  sourceName?: string;
  constructor(init: SourceRateLimitedInit) {
    super(init.detail, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "SourceRateLimitedError";
    this.resetAtMs = init.resetAtMs;
    this.detail = init.detail;
    this.exhausted = init.exhausted;
  }
}

export function isSourceRateLimited(e: unknown): e is SourceRateLimitedError {
  return e instanceof SourceRateLimitedError;
}

export interface SourceRateLimit {
  /** Epoch SECONDS the source may be called again (deps.now()'s clock). */
  until: number;
  detail: string;
  exhausted: boolean;
  /** Epoch seconds the limit was FIRST observed (preserved across re-observations). */
  since: number;
  /** Epoch seconds the operator was last notified — the re-notify throttle. null = never. */
  notifiedAt: number | null;
}

const limited = new Map<string, SourceRateLimit>();

// NUL delimiter (written as the `\0` escape so the SOURCE stays ASCII / grep-safe — repo
// convention): (repo, source) are both free-form, so a printable separator could collide.
function keyOf(repo: string, source: string): string {
  return `${repo}\0${source}`;
}

/** Hold a source until `until` (epoch seconds). An existing hold is EXTENDED, never shortened — a
 *  later call that raced past the gate and hit a nearer reset must not release the source early —
 *  and keeps its original `since`/`notifiedAt` so the throttle survives repeated observations. */
export function recordRateLimited(repo: string, source: string, f: { until: number; detail: string; exhausted: boolean; now: number }): void {
  const existing = limited.get(keyOf(repo, source));
  if (existing) {
    existing.until = Math.max(existing.until, f.until);
    existing.detail = f.detail;
    existing.exhausted = f.exhausted || existing.exhausted;
    return;
  }
  limited.set(keyOf(repo, source), { until: f.until, detail: f.detail, exhausted: f.exhausted, since: f.now, notifiedAt: null });
}

/** The live hold on a source, or undefined when it is free to call. An ELAPSED hold is dropped
 *  here rather than by a sweeper, so the reset stamp is the only clock that matters. */
export function getRateLimit(repo: string, source: string, now: number): SourceRateLimit | undefined {
  const f = limited.get(keyOf(repo, source));
  if (!f) return undefined;
  if (now >= f.until) {
    limited.delete(keyOf(repo, source));
    return undefined;
  }
  return f;
}

/** Clear a source's hold after a successful call. Returns true iff it WAS held (i.e. this is a
 *  recovery — the caller then logs the resume and clears the problem row). */
export function clearRateLimit(repo: string, source: string): boolean {
  return limited.delete(keyOf(repo, source));
}

export function markRateLimitNotified(repo: string, source: string, now: number): void {
  const f = limited.get(keyOf(repo, source));
  if (f) f.notifiedAt = now;
}

/** Test seam: forget every hold (the Map is process-global). */
export function resetRateLimitGate(): void {
  limited.clear();
}
