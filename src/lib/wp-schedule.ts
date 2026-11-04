/**
 * Scheduling a WordPress post or page (issue #1215, P2‑5): the wall clock the
 * owner sees, the instant WordPress stores, and the naive GMT string the two
 * transports carry.
 *
 * Three calendars meet here, so each boundary is explicit:
 *
 *  - **The owner** picks a Jalali day and a Tehran time. `JalaliDatePicker`
 *    hands back a Gregorian `YYYY-MM-DD` date string; the time comes from a
 *    clock field. Together they are a *wall clock*, not an instant.
 *  - **The instant** is what the app sends and compares: ISO-8601 UTC.
 *  - **WordPress** stores `post_date_gmt` as `YYYY-MM-DD HH:MM:SS` in UTC, and
 *    its REST API wants `date_gmt` in the same shape but with a `T`.
 *
 * Iran has observed no daylight saving since 2022, but the offset is still read
 * from the zone database rather than assumed, so a historical date or a future
 * policy change cannot silently shift a schedule by an hour.
 */
export const WP_SCHEDULE_ZONE = "Asia/Tehran";

/** The clock the editor offers when scheduling a fresh post. */
export const DEFAULT_SCHEDULE_TIME = "09:00";

/** Minutes east of UTC for `instant`, read from the zone database. */
export function zoneOffsetMinutes(instant: Date, timeZone: string = WP_SCHEDULE_ZONE): number {
  if (!Number.isFinite(instant.getTime())) return 0;
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((entry) => entry.type === "timeZoneName")?.value;
  // "GMT", "GMT+03:30", "GMT-05:00" — "GMT" alone means UTC.
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part ?? "");
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/**
 * A Tehran wall clock ("2026-11-10" + "09:00") as an ISO-8601 UTC instant.
 * Returns null for anything that is not a real date and time — a calendar
 * field must never turn 31 Esfand into a silent roll-over.
 */
export function tehranWallClockToIso(date: string, time: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const clock = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!day || !clock) return null;
  const year = Number(day[1]);
  const month = Number(day[2]);
  const dayOfMonth = Number(day[3]);
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31 || hour > 23 || minute > 59) return null;

  const naive = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const roundTrip = new Date(naive);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }

  let instant = naive - zoneOffsetMinutes(new Date(naive)) * 60_000;
  // The offset is read at the instant, which can differ from the offset at the
  // naive value across a transition; one more pass settles it.
  const offset = zoneOffsetMinutes(new Date(instant));
  if (naive - offset * 60_000 !== instant) instant = naive - offset * 60_000;
  return new Date(instant).toISOString();
}

/** An ISO instant as the Tehran wall clock the editor shows back to the owner. */
export function isoToTehranWallClock(iso: string): { date: string; time: string } | null {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: WP_SCHEDULE_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${hour}:${get("minute")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  return { date, time };
}

/**
 * An ISO instant as WordPress's `date_gmt`: UTC, `YYYY-MM-DDTHH:MM:SS`, no
 * zone suffix. Both transports carry this one shape, so the plugin and the REST
 * path can never disagree about what a schedule means.
 */
export function toWordPressGmt(iso: string): string | null {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return null;
  return instant.toISOString().slice(0, 19);
}

/**
 * A stored `date_gmt` back as a canonical ISO instant. WordPress sends
 * `2026-11-10T05:30:00` (UTC, no suffix), a REST `date` carries an offset, and
 * an older mirror may hold a MySQL `2026-11-10 05:30:00`.
 */
export function parseWordPressGmt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const instant = new Date(normalized);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

/** A schedule is only a schedule while it is still ahead of us. */
export function isFutureSchedule(iso: string | null | undefined, now: number = Date.now()): boolean {
  if (!iso) return false;
  const instant = Date.parse(iso);
  return Number.isFinite(instant) && instant > now;
}
