/**
 * Reservation timing logic — pure functions, framework-free.
 *
 * A reservation holds a table for a window [reserved_at, reserved_at + turn].
 * Two reservations on the SAME table conflict when their windows overlap.
 * Times are epoch-millisecond numbers here (the API converts to/from
 * timestamptz at the edge); durations are minutes.
 */

export interface ReservationWindow {
  /** distinguishes a row from itself when re-checking an edit; optional */
  id?: string;
  /** reservation start, epoch ms */
  startMs: number;
  durationMinutes: number;
}

/** Reservation statuses that still hold a table (and so can conflict). */
export const ACTIVE_RESERVATION_STATUSES = ["booked", "seated"] as const;

const MINUTE_MS = 60_000;

export function windowEndMs(w: ReservationWindow): number {
  return w.startMs + w.durationMinutes * MINUTE_MS;
}

/** Half-open interval overlap: touching end-to-start does NOT overlap. */
export function windowsOverlap(a: ReservationWindow, b: ReservationWindow): boolean {
  return a.startMs < windowEndMs(b) && b.startMs < windowEndMs(a);
}

/**
 * Returns every existing window whose interval overlaps `candidate`. A row
 * with the same `id` as the candidate is skipped (so editing a reservation
 * doesn't conflict with itself).
 */
export function findConflicts(
  candidate: ReservationWindow,
  existing: ReservationWindow[],
): ReservationWindow[] {
  return existing.filter((e) => e.id !== candidate.id && windowsOverlap(candidate, e));
}

/**
 * True once a booked reservation is `graceMinutes` past its start with nobody
 * seated — the UI uses this to flag likely no-shows. Auto-cancellation is not
 * performed; marking no-show stays a manual action.
 */
export const NO_SHOW_GRACE_MINUTES = 15;

export function isNoShowOverdue(startMs: number, nowMs: number, graceMinutes = NO_SHOW_GRACE_MINUTES): boolean {
  return nowMs >= startMs + graceMinutes * MINUTE_MS;
}

export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  booked: "رزرو شده",
  seated: "نشسته",
  completed: "تکمیل‌شده",
  cancelled: "لغوشده",
  no_show: "عدم حضور",
};

export const DEFAULT_BRANCH_TIMEZONE = "Asia/Tehran";

/**
 * Validate an IANA timezone identifier, falling back to `Asia/Tehran` if absent or invalid.
 */
export function normalizeTimeZone(timeZone?: string | null): string {
  const candidate = typeof timeZone === "string" ? timeZone.trim() : "";
  if (!candidate) return DEFAULT_BRANCH_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_BRANCH_TIMEZONE;
  }
}

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = Number(p.value);
    }
  }
  const hour = map.hour === 24 ? 0 : (map.hour ?? 0);
  const asUtc = Date.UTC(
    map.year ?? 1970,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    hour,
    map.minute ?? 0,
    map.second ?? 0,
    ((utcMs % 1000) + 1000) % 1000,
  );
  return asUtc - utcMs;
}

/**
 * Format an ISO timestamp as `"HH:MM"` in the active branch's `timeZone`.
 */
export function formatTimeInTimeZone(iso: string, timeZone?: string | null): string {
  const tz = normalizeTimeZone(timeZone);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "00:00";
  return d.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Return today's calendar date (`YYYY-MM-DD`) in the active branch's `timeZone`.
 */
export function todayIsoInTimeZone(timeZone?: string | null, now: Date = new Date()): string {
  const tz = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * Convert a wall-clock date (`YYYY-MM-DD`) and time (`HH:MM` or `HH:MM:SS`) in
 * `timeZone` into a canonical UTC ISO timestamp, handling DST and fractional
 * offsets accurately.
 */
export function zonedDateTimeToIso(
  dateStr: string,
  timeStr: string,
  timeZone?: string | null,
  ms = 0,
): string {
  const tz = normalizeTimeZone(timeZone);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr.trim());
  if (!dateMatch || !timeMatch) {
    return new Date(`${dateStr}T${timeStr}`).toISOString();
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? "0");

  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const offset1 = getTimeZoneOffsetMs(guessUtc, tz);
  const utc1 = guessUtc - offset1;
  const offset2 = getTimeZoneOffsetMs(utc1, tz);
  const utc2 = guessUtc - offset2;
  return new Date(utc2).toISOString();
}

/**
 * Compute the start (`00:00:00.000`) and end (`23:59:59.999`) UTC ISO strings
 * for a calendar date (`YYYY-MM-DD`) in `timeZone`.
 */
export function zonedDayBoundsIso(
  dateStr: string,
  timeZone?: string | null,
): { fromIso: string; toIso: string; startIso: string; endIso: string } {
  const fromIso = zonedDateTimeToIso(dateStr, "00:00:00", timeZone, 0);
  const toIso = zonedDateTimeToIso(dateStr, "23:59:59", timeZone, 999);
  return {
    fromIso,
    toIso,
    startIso: fromIso,
    endIso: toIso,
  };
}
