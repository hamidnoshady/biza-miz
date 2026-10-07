/**
 * Pure input rules for «ثبت هزینه» (expense management).
 *
 * Kept out of `expense-service.ts` (which touches the DB and therefore has no
 * unit test, per repo convention) so the validation the form and the API both
 * depend on can be unit-tested: an expense date that is not a real calendar
 * date used to reach Postgres as raw text and blow up as an unhandled 500, and
 * the list endpoint had no filters at all while silently truncating at 200 rows.
 *
 * Everything here is importable from a client component — no `pg`, no `Buffer`,
 * no `process.env` — which is the point: the browser's refusal and the server's
 * are the same function, so no entry channel can be stricter or laxer than
 * another (issue #832 §5).
 */
import { toJalali } from "./jalali";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The earliest expense date the register accepts. A Jalali year typed into a
 * Gregorian field — `1405-01-01`, which the picker's own output format makes
 * look legal — is a real proleptic-Gregorian date and would be stored as one:
 * thirteen and a half centuries of backdating, accepted silently, only to be
 * refused by the fiscal-period lock as a coincidence. Nothing legitimate is
 * near this floor, so the shape check refuses it instead.
 */
export const MIN_EXPENSE_ISO_DATE = "1800-01-01";

/** A well-formed *and* real ISO calendar date (rejects 2025-02-31, 2025-13-01, …). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  if (value < MIN_EXPENSE_ISO_DATE) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** Rial amounts are stored in a BIGINT column but calculated as JS numbers. */
export const MAX_EXPENSE_AMOUNT_RIAL = Number.MAX_SAFE_INTEGER;

/**
 * The one expense-date rule, shared by the form, `recordExpense()`, the import
 * adapter and the AI executor (issue #832 §5).
 *
 * The browser used to refuse «تاریخ هزینه نمی‌تواند در آینده باشد.» while
 * `recordExpense()` only checked that the string was a date, so the same
 * future-dated expense a person could not type was one `curl`, one spreadsheet
 * row or one autopilot action away. A back-dated expense is a legitimate
 * accounting act — the fiscal-period lock is what forbids it, per period, per
 * role — and the Jalali calendar means «today» is a business-timezone fact
 * rather than a UTC one, so the caller passes the day it read from
 * `todayIsoDate(businessTimezone)`.
 *
 * Returns an error code, never a sentence: who renders the message is the
 * caller's business.
 */
export type ExpenseDateViolation = "invalid_expense_date" | "expense_date_in_future";

export function expenseDateViolation(expenseDate: string, businessToday: string): ExpenseDateViolation | null {
  if (!isValidIsoDate(expenseDate)) return "invalid_expense_date";
  // Both sides are `YYYY-MM-DD`, so a lexical comparison *is* a chronological
  // one — the only reason comparing date strings is ever acceptable.
  if (businessToday && expenseDate > businessToday) return "expense_date_in_future";
  return null;
}

/**
 * Input VAT recorded against an operating expense (issue #832 §11). `amount`
 * stays the *gross* money that left the payment account and `vatAmount` is the
 * part of it that is recoverable VAT, so the net debit is `amount - vatAmount`
 * — which must stay positive. Absent means zero, so every pre-existing
 * expense and every non-VAT entry keeps posting exactly as before.
 */
export function parseExpenseVatAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** True when `vatAmount` is a valid input-VAT part of a gross `amount`. */
export function isExpenseVatWithinAmount(vatAmount: number, amount: number): boolean {
  return Number.isSafeInteger(vatAmount) && vatAmount >= 0 && vatAmount < amount;
}

/**
 * The VAT part of a *VAT-inclusive* gross, at a percentage rate — the arithmetic
 * behind «استخراج مالیات از مبلغ کل». It is deliberately the only tax maths in
 * this channel: the rate comes from the business's own platform tax setting
 * (`/api/ledger/settings`), never a constant, and the result is a suggestion the
 * operator can still overwrite, because an invoice's ۹٪ and a ledger's exact
 * Rial are different things when a rounding difference lands somewhere.
 *
 * `net = round(gross / (1 + rate/100))`, `vat = gross - net` — so the two parts
 * always add back to the gross exactly, with no lost rial.
 */
export function inclusiveExpenseVatAmount(gross: number, ratePercent: number): number | null {
  if (!Number.isSafeInteger(gross) || gross <= 0) return null;
  if (!Number.isFinite(ratePercent) || ratePercent <= 0 || ratePercent >= 100) return null;
  const net = Math.round(gross / (1 + ratePercent / 100));
  const vat = gross - net;
  return vat > 0 ? vat : null;
}

/**
 * The per-business document number of an expense (issue #832 §21):
 * `EXP-<Jalali year>-<5 digits>`. The Jalali year of the *business date* —
 * the same year an Iranian accountant files against — from the pure converter
 * `jalali.ts` already provides, so no second calendar arithmetic exists here.
 */
export function formatExpenseReference(businessDate: string, sequence: number): string {
  const [y, m, d] = businessDate.split("-").map(Number);
  const { jy } = toJalali(y, m, d);
  return `EXP-${jy}-${String(sequence).padStart(5, "0")}`;
}

export type ExpenseRegisterStatus = "active" | "reversed" | "reversal";

/** The register's three states — see `expense-service.ts`'s reversal model. */
export const EXPENSE_REGISTER_STATUSES: readonly ExpenseRegisterStatus[] = ["active", "reversed", "reversal"];

export function parseExpenseRegisterStatus(value: unknown): ExpenseRegisterStatus | null {
  return EXPENSE_REGISTER_STATUSES.includes(value as ExpenseRegisterStatus)
    ? (value as ExpenseRegisterStatus)
    : null;
}

export interface ExpenseListFilters {
  dateFrom: string | null;
  dateTo: string | null;
  accountId: string | null;
  paymentAccountId: string | null;
  /** Branch filter. A uuid-shaped but foreign id is kept and simply matches nothing. */
  locationId: string | null;
  /** One of the three register states, or null for all of them. */
  status: ExpenseRegisterStatus | null;
  q: string | null;
  limit: number;
  /** Keyset position to read *after* — the next page, never an offset. */
  cursor: ExpenseCursor | null;
}

export const EXPENSE_LIST_DEFAULT_LIMIT = 100;
export const EXPENSE_LIST_MAX_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A keyset position in the register's own total order — `expense_date DESC,
 * created_at DESC, id DESC`.
 *
 * It is a plain `date|created_at|id` triple rather than an encrypted token
 * because it carries no secret: the tenant is still taken from the session, so
 * a hand-written cursor can only ever walk somebody through their own rows —
 * and `parseExpenseCursor` refuses anything that is not exactly that shape.
 */
export interface ExpenseCursor {
  date: string;
  createdAt: string;
  id: string;
}

export function encodeExpenseCursor(cursor: ExpenseCursor): string {
  return `${cursor.date}|${cursor.createdAt}|${cursor.id}`;
}

/** A `timestamptz` as Postgres renders it (`2026-04-01 09:12:33.123456+00`) or an ISO one. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?$/;

/**
 * Would `Date.parse` read this timestamp? Postgres' own text form of a
 * `timestamptz` — which is what `SELECT_EXPENSE` returns, because the register's
 * cursor is built from `created_at::text` rather than from a driver-parsed Date —
 * uses an offset of `+00`/`+0430`, and ECMAScript only accepts `+00:00`. Without
 * this widening the cursor the *server* hands out is refused by the server's own
 * parser a page later, and «نمایش بیشتر» silently never loads: both spellings are
 * normalized here, and the value that goes back into the query is the one that
 * came in, which Postgres reads either way.
 */
function isParseableTimestamp(value: string): boolean {
  const iso = value.replace(" ", "T");
  if (!Number.isNaN(Date.parse(iso))) return true;
  const widened = iso
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
    .replace(/([+-]\d{2})$/, "$1:00");
  return !Number.isNaN(Date.parse(widened));
}

export function parseExpenseCursor(value: unknown): ExpenseCursor | null {
  if (typeof value !== "string") return null;
  const [date, createdAt, id] = value.trim().split("|");
  if (!isValidIsoDate(date) || !TIMESTAMP_RE.test(createdAt ?? "") || !UUID_RE.test(id ?? "")) return null;
  if (!isParseableTimestamp(createdAt)) return null;
  return { date, createdAt, id };
}

/**
 * Normalise the list query. Everything is optional; anything malformed is
 * dropped rather than rejected, because a filter bar should narrow a list, not
 * error it out. Dates that arrive reversed are swapped — «از» after «تا» is a
 * mis-click, not an empty result. A *shaped* but foreign `locationId` is kept
 * on purpose: it belongs in the WHERE clause, where it matches nothing of this
 * business's rows, rather than being silently dropped into "all branches".
 */
export function parseExpenseListQuery(params: URLSearchParams): ExpenseListFilters {
  const iso = (key: string) => {
    const value = params.get(key);
    return isValidIsoDate(value) ? value : null;
  };
  let dateFrom = iso("dateFrom");
  let dateTo = iso("dateTo");
  if (dateFrom && dateTo && dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];

  const uuid = (key: string) => {
    const value = params.get(key)?.trim() ?? "";
    return UUID_RE.test(value) ? value : null;
  };

  const requested = Number(params.get("limit"));
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, EXPENSE_LIST_MAX_LIMIT)
      : EXPENSE_LIST_DEFAULT_LIMIT;

  return {
    dateFrom,
    dateTo,
    accountId: uuid("accountId"),
    paymentAccountId: uuid("paymentAccountId"),
    locationId: uuid("locationId"),
    status: parseExpenseRegisterStatus(params.get("status")?.trim() || null),
    q: params.get("q")?.trim() || null,
    limit,
    cursor: parseExpenseCursor(params.get("cursor")),
  };
}
