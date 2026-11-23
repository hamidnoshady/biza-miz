/**
 * «اسناد دوره‌ای» — the recurrence contract, as pure functions.
 *
 * A recurring voucher template is a *schedule plus a frozen document*, not a
 * second posting engine. This module owns the schedule arithmetic and the
 * document rules; `recurring-voucher-service.ts` owns the database and the
 * draft it hands to the existing manual-journal workflow.
 *
 * ## Why the calendar is Jalali
 *
 * A Persian business's rent, insurance and subscription commitments fall due on
 * a Jalali month boundary, not a Gregorian one: «پنجم هر ماه» means the fifth
 * of فروردین … اسفند. Computing a monthly series by adding 30 days (or by
 * letting JavaScript roll a Gregorian month) drifts against the fiscal periods
 * those entries must land in — a «monthly» rent entry would eventually post
 * twice into one Jalali period and skip another. So monthly, quarterly and
 * yearly recurrence step through the **Jalali** calendar via `jalali.ts`, and
 * only weekly recurrence is plain day arithmetic. The stored dates stay ISO /
 * Gregorian, as every date in this codebase does.
 *
 * ## Short months
 *
 * Jalali months are 31 (فروردین–شهریور), 30 (مهر–بهمن) and 29 or 30 (اسفند).
 * A template anchored on day 31 therefore has three documented policies:
 *
 *  - `clamp` (the default): the occurrence falls on the anchor day, or the last
 *    day of a shorter month. Day 31 → 30 مهر, day 31 → 29/30 اسفند.
 *  - `last_day`: every occurrence is the last day of its month, whatever the
 *    anchor day says. This is the "rent due at month end" reading.
 *  - `skip`: a month with no such day has no occurrence at all. Day 30 in a
 *    29-day اسفند simply does not run; it does not slide into the next month.
 *
 * The policy is stored per template, so a business can state which reading it
 * means instead of the platform guessing.
 */
import {
  isoDateToJalali,
  isValidIsoDate,
  jalaliMonthLength,
  jalaliToIsoDate,
  type JalaliDate,
} from "./jalali";
import { manualDocumentProblem } from "./manual-journal";
import type { LineDimensions } from "./accounting-dimensions";

export const RECURRENCE_FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const MONTH_END_POLICIES = ["clamp", "last_day", "skip"] as const;
export type MonthEndPolicy = (typeof MONTH_END_POLICIES)[number];

export const RECURRING_TEMPLATE_STATUSES = ["active", "paused", "completed", "cancelled"] as const;
export type RecurringTemplateStatus = (typeof RECURRING_TEMPLATE_STATUSES)[number];

/**
 * An occurrence's own lifecycle. `pending` exists for crash recovery: the
 * scheduled date was claimed under the template lock but the draft was not
 * written yet, so the next tick (or a retry) finishes it. `overdue` is not a
 * stored state — it is `scheduled_date < today` on a pending/failed row, so a
 * clock that moves cannot leave a stale badge behind.
 */
export const RECURRING_OCCURRENCE_STATUSES = [
  "pending",
  "draft",
  "posted",
  "skipped",
  "failed",
] as const;
export type RecurringOccurrenceStatus = (typeof RECURRING_OCCURRENCE_STATUSES)[number];

export const RECURRING_NAME_MAX = 120;
export const RECURRING_DESCRIPTION_MAX = 1000;
export const RECURRING_LINE_DESCRIPTION_MAX = 300;
export const RECURRING_LINES_MAX = 200;
/** One tick generates at most this many occurrences per template; the rest wait for the next tick. */
export const RECURRING_CATCH_UP_LIMIT = 36;
/** Automatic attempts for a `pending` occurrence left behind by a crash, before it needs a human. */
export const RECURRING_MAX_ATTEMPTS = 3;

export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  weekly: "هفتگی",
  monthly: "ماهانه",
  quarterly: "فصلی",
  yearly: "سالانه",
};

export const MONTH_END_POLICY_LABELS: Record<MonthEndPolicy, string> = {
  clamp: "روز مقرر، و در ماه کوتاه آخرین روز ماه",
  last_day: "همیشه آخرین روز ماه",
  skip: "ماه کوتاه بدون رخداد",
};

export const RECURRING_TEMPLATE_STATUS_LABELS: Record<RecurringTemplateStatus, string> = {
  active: "فعال",
  paused: "موقتاً متوقف",
  completed: "پایان‌یافته",
  cancelled: "لغوشده",
};

export const RECURRING_OCCURRENCE_STATUS_LABELS: Record<RecurringOccurrenceStatus, string> = {
  pending: "در انتظار ساخت پیش‌نویس",
  draft: "پیش‌نویس در انتظار تأیید",
  posted: "ثبت‌شده در دفتر",
  skipped: "ردشده",
  failed: "متوقف با خطا",
};

/** The schedule half of a template. `endDate` is inclusive, and may be null (open-ended). */
export interface RecurringSchedule {
  frequency: RecurrenceFrequency;
  monthEndPolicy: MonthEndPolicy;
  /** ISO date. The first occurrence, and the anchor day for monthly-family schedules. */
  startDate: string;
  endDate: string | null;
}

/** One proposed journal line. Integer Rial, debit XOR credit, exactly as manual journals. */
export interface RecurringVoucherLine {
  accountId: string;
  debit: number;
  credit: number;
  partyId?: string | null;
  description?: string | null;
  dimensions?: LineDimensions | null;
}

const DAY_MS = 86_400_000;
const STEP_MONTHS: Record<Exclude<RecurrenceFrequency, "weekly">, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};
const MAX_SCAN = 1600;

function isoToUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function utcToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function compareIsoDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDaysIso(iso: string, days: number): string {
  return utcToIso(isoToUtc(iso) + days * DAY_MS);
}

export function daysBetweenIso(from: string, to: string): number {
  return Math.round((isoToUtc(to) - isoToUtc(from)) / DAY_MS);
}

/** Total months from the Jalali epoch — the integer a monthly step adds to. */
function jalaliMonthIndex(date: JalaliDate): number {
  return date.jy * 12 + (date.jm - 1);
}

function monthFromIndex(index: number): { jy: number; jm: number } {
  return { jy: Math.floor(index / 12), jm: (index % 12) + 1 };
}

/**
 * The template's date at 0-based recurrence `index`, or null when the policy
 * skips that period (`skip` on a short month).
 */
export function occurrenceDateAt(schedule: RecurringSchedule, index: number): string | null {
  if (!Number.isInteger(index) || index < 0) return null;
  if (schedule.frequency === "weekly") {
    return addDaysIso(schedule.startDate, index * 7);
  }
  const anchor = isoDateToJalali(schedule.startDate);
  if (!anchor) return null;
  const step = STEP_MONTHS[schedule.frequency];
  const { jy, jm } = monthFromIndex(jalaliMonthIndex(anchor) + index * step);
  const length = jalaliMonthLength(jy, jm);
  if (schedule.monthEndPolicy === "skip" && anchor.jd > length) return null;
  const day =
    schedule.monthEndPolicy === "last_day"
      ? length
      : Math.min(anchor.jd, length);
  return jalaliToIsoDate(jy, jm, day);
}

/** A lower-bound guess at the index of `day`, so a schedule anchored years ago does not scan from zero. */
function estimateIndex(schedule: RecurringSchedule, day: string): number {
  if (schedule.frequency === "weekly") {
    return Math.max(0, Math.floor(daysBetweenIso(schedule.startDate, day) / 7) - 1);
  }
  const anchor = isoDateToJalali(schedule.startDate);
  const target = isoDateToJalali(day);
  if (!anchor || !target) return 0;
  const months = jalaliMonthIndex(target) - jalaliMonthIndex(anchor);
  return Math.max(0, Math.floor(months / STEP_MONTHS[schedule.frequency]) - 1);
}

function endExcluded(schedule: RecurringSchedule, occurrence: string): boolean {
  return schedule.endDate !== null && compareIsoDate(occurrence, schedule.endDate) > 0;
}

/**
 * The first occurrence strictly after `afterIso` (or the anchor itself when
 * `afterIso` is before it), bounded by the template's end date.
 */
export function nextOccurrenceAfter(
  schedule: RecurringSchedule,
  afterIso: string,
): string | null {
  if (!isValidIsoDate(schedule.startDate)) return null;
  /* `skip` can return null for a period, so the scan cannot stop at the first null. */
  let index = estimateIndex(schedule, afterIso);
  for (let scanned = 0; scanned < MAX_SCAN; scanned++, index++) {
    const candidate = occurrenceDateAt(schedule, index);
    if (!candidate) continue;
    if (endExcluded(schedule, candidate)) return null;
    if (compareIsoDate(candidate, afterIso) > 0) return candidate;
  }
  return null;
}

/** The first occurrence on or after `dayIso`, bounded by the template's end date. */
export function firstOccurrenceOnOrAfter(
  schedule: RecurringSchedule,
  dayIso: string,
): string | null {
  if (!isValidIsoDate(schedule.startDate)) return null;
  if (compareIsoDate(schedule.startDate, dayIso) >= 0) {
    return endExcluded(schedule, schedule.startDate) ? null : schedule.startDate;
  }
  return nextOccurrenceAfter(schedule, addDaysIso(dayIso, -1));
}

/**
 * Every occurrence in `[fromIso, toIso]`, at most `limit` of them.
 *
 * The limit is the catch-up bound: after downtime a monthly template a year
 * behind must not create twelve drafts in one transaction, so a tick takes a
 * bounded slice and the next tick continues from where it stopped.
 */
export function occurrenceDatesBetween(
  schedule: RecurringSchedule,
  fromIso: string,
  toIso: string,
  limit = RECURRING_CATCH_UP_LIMIT,
): string[] {
  const out: string[] = [];
  if (limit <= 0 || compareIsoDate(fromIso, toIso) > 0) return out;
  let cursor: string | null = firstOccurrenceOnOrAfter(schedule, fromIso);
  while (cursor && compareIsoDate(cursor, toIso) <= 0 && out.length < limit) {
    out.push(cursor);
    cursor = nextOccurrenceAfter(schedule, cursor);
  }
  return out;
}

/** The next `count` occurrences from `fromIso` — what the «رخدادهای پیش‌رو» panel shows. */
export function upcomingOccurrenceDates(
  schedule: RecurringSchedule,
  fromIso: string,
  count: number,
): string[] {
  const out: string[] = [];
  if (count <= 0) return out;
  let cursor: string | null = firstOccurrenceOnOrAfter(schedule, fromIso);
  let guard = 0;
  while (cursor && out.length < count && guard++ < MAX_SCAN) {
    out.push(cursor);
    cursor = nextOccurrenceAfter(schedule, cursor);
  }
  return out;
}

/**
 * The deterministic idempotency key for one occurrence.
 *
 * Tenant + template + scheduled date is the whole identity of an occurrence,
 * so two workers, a retried job, a restarted server and an offline replay all
 * compute the same string. It is also the draft's idempotency key, so the
 * existing `journal_entry_drafts (business_id, idempotency_key)` unique index —
 * not a read-then-write — is what makes the journal effect exactly-once.
 */
export function recurringOccurrenceIdempotencyKey(
  templateId: string,
  scheduledDate: string,
): string {
  return `recurring:${templateId}:${scheduledDate}`;
}

/** Debit/credit totals of the document, as exact integer Rial. */
export function recurringVoucherTotals(lines: readonly RecurringVoucherLine[]): {
  debit: number;
  credit: number;
  balanced: boolean;
} {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += Number.isSafeInteger(line.debit) ? line.debit : 0;
    credit += Number.isSafeInteger(line.credit) ? line.credit : 0;
  }
  return { debit, credit, balanced: debit === credit };
}

export type RecurringVoucherProblem =
  | "invalid_name"
  | "invalid_description"
  | "invalid_memo"
  | "invalid_frequency"
  | "invalid_month_end_policy"
  | "invalid_start_date"
  | "invalid_end_date"
  | "end_before_start"
  | "too_many_lines"
  | "invalid_line"
  | "invalid_account_id"
  | "invalid_party_id"
  | "invalid_amount"
  | "invalid_line_description"
  | "no_lines"
  | "too_few_lines"
  | "single_account_entry"
  | "not_balanced";

export interface RecurringVoucherDraft {
  name: string;
  description: string | null;
  memo: string;
  frequency: string;
  monthEndPolicy: string;
  startDate: string;
  endDate: string | null;
  lines: RecurringVoucherLine[];
}

/**
 * The one rule for "is this template postable at all", shared by the API, the
 * service and the browser preview.
 *
 * The balance half is `manualDocumentProblem` — the same function the manual
 * journal screen runs before enabling «ثبت پیش‌نویس» — so a recurring template
 * can never be balanced on one screen and refused on another. Everything above
 * it is template-specific: a name, a memo, a real ISO date pair, and an
 * end date that does not precede the start.
 */
export function recurringVoucherProblem(
  draft: RecurringVoucherDraft,
): RecurringVoucherProblem | null {
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name || name.length > RECURRING_NAME_MAX) return "invalid_name";
  if (
    draft.description !== null &&
    (typeof draft.description !== "string" ||
      draft.description.length > RECURRING_DESCRIPTION_MAX)
  ) {
    return "invalid_description";
  }
  const memo = typeof draft.memo === "string" ? draft.memo.trim() : "";
  if (!memo || memo.length > 500) return "invalid_memo";
  if (!(RECURRENCE_FREQUENCIES as readonly string[]).includes(draft.frequency)) {
    return "invalid_frequency";
  }
  if (!(MONTH_END_POLICIES as readonly string[]).includes(draft.monthEndPolicy)) {
    return "invalid_month_end_policy";
  }
  if (!isValidIsoDate(draft.startDate)) return "invalid_start_date";
  if (draft.endDate !== null && !isValidIsoDate(draft.endDate)) return "invalid_end_date";
  if (draft.endDate !== null && compareIsoDate(draft.endDate, draft.startDate) < 0) {
    return "end_before_start";
  }
  if (!Array.isArray(draft.lines) || draft.lines.length > RECURRING_LINES_MAX) {
    return "too_many_lines";
  }
  for (const line of draft.lines) {
    if (!line || typeof line !== "object") return "invalid_line";
    if (typeof line.accountId !== "string" || line.accountId.trim() === "") {
      return "invalid_account_id";
    }
    if (line.partyId !== undefined && line.partyId !== null && typeof line.partyId !== "string") {
      return "invalid_party_id";
    }
    if (
      !Number.isSafeInteger(line.debit) ||
      !Number.isSafeInteger(line.credit) ||
      line.debit < 0 ||
      line.credit < 0 ||
      (line.debit === 0) === (line.credit === 0)
    ) {
      return "invalid_amount";
    }
    if (
      line.description !== undefined &&
      line.description !== null &&
      (typeof line.description !== "string" ||
        line.description.length > RECURRING_LINE_DESCRIPTION_MAX)
    ) {
      return "invalid_line_description";
    }
  }
  return manualDocumentProblem(draft.lines) as RecurringVoucherProblem | null;
}

/**
 * Whether an occurrence should be shown as overdue.
 *
 * Derived, never stored: «سررسید گذشته» is a fact about today's date and the
 * scheduled date, and a stored flag would still read overdue after a clock
 * correction or after the occurrence was finally drafted.
 */
export function occurrenceIsOverdue(
  status: RecurringOccurrenceStatus,
  scheduledDate: string,
  todayIso: string,
): boolean {
  return (
    (status === "pending" || status === "failed") &&
    compareIsoDate(scheduledDate, todayIso) < 0
  );
}

/** Whether a template may still be edited — a completed or cancelled one is history. */
export function templateIsEditable(status: RecurringTemplateStatus): boolean {
  return status === "active" || status === "paused";
}
