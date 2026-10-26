/**
 * Issue #1077 — the WP/Woo queue retention policy, the pure half.
 *
 * Database-free on purpose: the queue screen imports these numbers for its
 * «history beyond retention» note, and a client component must not reach
 * `db.ts`. The sweep that applies them is `queue-retention.ts`.
 *
 *   - finished rows are kept 90 days: outbox `sent` / `skipped`, inbox
 *     `processed` / `duplicate`;
 *   - unresolved failures are kept 180 days: outbox `dead`, inbox `failed`;
 *   - `pending`, `processing`, `deferred`, `failed` (still retrying) and
 *     `needs_review` are never swept, whatever their age.
 */

export const QUEUE_DONE_RETENTION_DAYS = 90;
export const QUEUE_DEAD_RETENTION_DAYS = 180;
export const QUEUE_RETENTION_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionCutoffs {
  /** Finished rows last touched before this are deleted. */
  doneBefore: Date;
  /** Dead / failed rows last touched before this are deleted. */
  deadBefore: Date;
}

export function retentionCutoffs(now: Date = new Date()): RetentionCutoffs {
  return {
    doneBefore: new Date(now.getTime() - QUEUE_DONE_RETENTION_DAYS * DAY_MS),
    deadBefore: new Date(now.getTime() - QUEUE_DEAD_RETENTION_DAYS * DAY_MS),
  };
}

