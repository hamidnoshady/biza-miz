/**
 * The one fa-IR date-time formatter for the assistant's dashboard surfaces.
 *
 * Five screens used to spell their own `Intl.DateTimeFormat("fa-IR", …)`
 * (the history sidebar, the coworker panels, the autopilot activity feed,
 * the knowledge index and the usage report) — the same two formats, copied
 * five times. They live here now, so the assistant's timestamps can never
 * drift between its own screens. `fa-IR` resolves to the Persian/Shamsi
 * calendar, which is the repo's Shamsi-only display rule (AGENTS.md); the
 * value on the wire stays an ISO/Gregorian timestamp.
 */

/** «۱۵ فروردین ۱۴۰۳، ۱۴:۳۰» — the chat surfaces' list timestamps. `null` renders «—». */
export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

/** «۱۴۰۳/۰۱/۰۱، ۱۴:۳۰» — the compact form for dense management tables. */
export function formatShortDateTime(value: string): string {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

export type ConversationDateBucket = "today" | "yesterday" | "earlier";

export const CONVERSATION_BUCKET_LABELS: Record<ConversationDateBucket, string> = {
  today: "امروز",
  yesterday: "دیروز",
  earlier: "پیش‌تر",
};

const PERSIAN_DAY_FMT = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Classifies an ISO timestamp into Today («امروز»), Yesterday («دیروز»), or
 * Earlier («پیش‌تر») in the Persian/Shamsi calendar.
 */
export function conversationDateBucket(
  value: string,
  now: Date = new Date(),
): ConversationDateBucket {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "earlier";
  const todayKey = PERSIAN_DAY_FMT.format(now);
  if (PERSIAN_DAY_FMT.format(date) === todayKey) return "today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = PERSIAN_DAY_FMT.format(yesterday);
  if (PERSIAN_DAY_FMT.format(date) === yesterdayKey) return "yesterday";
  return "earlier";
}
