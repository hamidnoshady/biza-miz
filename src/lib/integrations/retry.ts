/**
 * Phase 23 (issue #118) — outbox retry policy, the pure half.
 *
 * A failed WooCommerce push retries with exponential backoff; after a fixed
 * number of attempts it is dead-lettered so the panel can surface it and an
 * operator can reset it, rather than retrying forever in the background.
 */

export const OUTBOX_BASE_BACKOFF_MS = 5_000;
export const OUTBOX_MAX_BACKOFF_MS = 5 * 60_000;
/** REST drain attempt cap before a job is dead-lettered. */
export const OUTBOX_MAX_ATTEMPTS = 8;
/**
 * Plugin attempt cap before a leased job is dead-lettered. Lower than the
 * REST cap because a plugin run is a WP-Cron pass: six failed passes already
 * span hours of real time. The queue UI reports the cap of the connection's
 * actual mode (`maxAttempts` in the queue response), never a hardcoded one.
 */
export const PLUGIN_JOB_MAX_ATTEMPTS = 6;

/** Exponential backoff for attempt n (0-based): base·2^n, capped. */
export function backoffDelayMs(attempt: number, baseMs = OUTBOX_BASE_BACKOFF_MS, maxMs = OUTBOX_MAX_BACKOFF_MS): number {
  const n = Math.max(0, attempt);
  const factor = 2 ** Math.min(n, 20); // clamp the exponent before it overflows
  return Math.min(baseMs * factor, maxMs);
}

/** True once an event has been attempted the maximum number of times. */
export function isDeadAfterAttempts(attempts: number, maxAttempts = OUTBOX_MAX_ATTEMPTS): boolean {
  return attempts >= maxAttempts;
}
