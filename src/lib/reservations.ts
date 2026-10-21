export interface ReservationWindow {
  id?: string;
  startMs: number;
  durationMinutes: number;
}

export const ACTIVE_RESERVATION_STATUSES = ["booked", "seated"] as const;
const MINUTE_MS = 60_000;

export function windowEndMs(w: ReservationWindow): number {
  return w.startMs + w.durationMinutes * MINUTE_MS;
}

export function windowsOverlap(a: ReservationWindow, b: ReservationWindow): boolean {
  return a.startMs < windowEndMs(b) && b.startMs < windowEndMs(a);
}

export function findConflicts(
  candidate: ReservationWindow,
  existing: ReservationWindow[],
): ReservationWindow[] {
  return existing.filter((e) => e.id !== candidate.id && windowsOverlap(candidate, e));
}

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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const hour = map.hour === 24 ? 0 : (map.hour ?? 0);
  return (
    Date.UTC(
      map.year ?? 1970,
      (map.month ?? 1) - 1,
      map.day ?? 1,
      hour,
      map.minute ?? 0,
      map.second ?? 0,
      ((utcMs % 1000) + 1000) % 1000,
    ) - utcMs
  );
}

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

export function zonedDateTimeToIso(
  dateStr: string,
  timeStr: string,
  timeZone?: string | null,
  ms = 0,
): string {
  const tz = normalizeTimeZone(timeZone);
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr.trim());
  if (!dm || !tm) return new Date(`${dateStr}T${timeStr}`).toISOString();
  const guessUtc = Date.UTC(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
    Number(tm[3] ?? "0"),
    ms,
  );
  const utc1 = guessUtc - getTimeZoneOffsetMs(guessUtc, tz);
  return new Date(guessUtc - getTimeZoneOffsetMs(utc1, tz)).toISOString();
}

export function zonedDayBoundsIso(
  dateStr: string,
  timeZone?: string | null,
): { fromIso: string; toIso: string; startIso: string; endIso: string } {
  const fromIso = zonedDateTimeToIso(dateStr, "00:00:00", timeZone, 0);
  const toIso = zonedDateTimeToIso(dateStr, "23:59:59", timeZone, 999);
  return { fromIso, toIso, startIso: fromIso, endIso: toIso };
}
