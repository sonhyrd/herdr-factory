// The deliver-lane scheduling SPINE: the retry/notify arithmetic every durable-intent mechanism
// shares, defined once. The outbox family (the source write-backs, the evidence publishes) and the
// human-question reply poll all retry on the same flat interval, and four notify throttles
// re-implemented the same "fire when never-notified or past the window" check against the one
// `attention_renotify_seconds` knob — this module is where that shape lives now.
//
// The curve is deliberately FLAT: a fixed 30s interval, capped at 10 attempts. The old exponential
// backoff (60s doubling to an hour) made a broken cause look like a wedged factory — by the time an
// operator noticed, the next retry could be an hour out, and nothing said "give up". Now a failure
// retries predictably every 30s, and at MAX_RETRY_ATTEMPTS the row SUSPENDS: it stops retrying,
// flags loudly, and waits for an operator (`s` on the TUI board / `retry-now`) or an automatic
// cause-recovery probe to clear it.
//
// A pure LEAF (no imports) so db/, core/ and watchers/ can all depend on it without a cycle.
// Deliberately arithmetic-only: each mechanism keeps its own table, columns, terminal-state
// vocabulary, ordering rules (per-run FIFO, supersede-on-enqueue) and reset semantics — those
// divergences are per-mechanism POLICY (see docs/ARCHITECTURE.md §6/§7), not duplication. Only the
// shared numbers belong here.

/** Flat delay between retry attempts (seconds) — every attempt waits exactly this long. Also the
 *  human-reply poll cadence (a miss is not a failure, but the clock is the same). */
export const RETRY_INTERVAL_SECONDS = 30;

/** Failed attempts before a pending intent SUSPENDS (stops retrying and flags the operator).
 *  10 × 30s ≈ five minutes of trying — enough to ride out a blip, short enough that a real
 *  breakage surfaces while the operator still remembers what changed. */
export const MAX_RETRY_ATTEMPTS = 10;

/**
 * The shared notify throttle: fire when never notified (`lastNotifiedAt` null/undefined — a null
 * must always fire, never be read as "notified at epoch 0"), or when the throttle window has
 * elapsed since the last notification. Unit-agnostic — pass all three arguments in the same unit
 * (the engine's throttles are epoch seconds against `limits.attention_renotify_seconds`; the
 * updater's dirty-checkout throttle is epoch milliseconds against its own 6h constant).
 */
export function notifyDue(lastNotifiedAt: number | null | undefined, throttle: number, now: number): boolean {
  return lastNotifiedAt == null || now - lastNotifiedAt >= throttle;
}
