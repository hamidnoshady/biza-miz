/**
 * Exponential backoff with jitter for the desktop's sync transport. Pure.
 *
 * A central server that is down, or a row it keeps refusing, used to be
 * retried every 30 seconds for as long as it failed. Each consecutive failure
 * now doubles the wait (30 s, 1 min, 2 min … capped at 15 min), randomised by
 * ±20% so a fleet of desktops that lost the server together does not come back
 * in lockstep. One success resets it.
 */

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

export function backoffDelayMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const exponent = Math.min(failures - 1, 20);
  const raw = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const jitter = 0.8 + 0.4 * Math.min(Math.max(random(), 0), 1);
  return Math.round(raw * jitter);
}

/** The instant the next attempt is allowed, or null when there is no failure to wait out. */
export function nextAttemptAt(failures: number, now: Date, random: () => number = Math.random): string | null {
  const delay = backoffDelayMs(failures, random);
  return delay > 0 ? new Date(now.getTime() + delay).toISOString() : null;
}

export function attemptDue(next: string | null | undefined, now: Date): boolean {
  if (!next) return true;
  const at = Date.parse(next);
  return !Number.isFinite(at) || at <= now.getTime();
}
