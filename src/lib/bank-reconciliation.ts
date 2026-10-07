/**
 * «تطبیق بانکی و صندوق» — the framework-free half.
 *
 * What a reconciliation *means*, with no database and no React: which
 * statement dates are acceptable, how a cleared line signs into the running
 * total, and what «مغایرت» is. The DB-touching half
 * (`reconciliation-service.ts`) consults this before it writes anything, and
 * the screen (`reconciliation-section.tsx`) uses the same functions to decide
 * what to show — so the number under «مغایرت» and the number the server
 * refuses to complete on are computed by one piece of code, not two that
 * agree by accident.
 *
 * Split out for the reason `cheques.ts` was split out of `cheques-service.ts`:
 * per this repo's convention a DB-touching module has no direct unit test, so
 * the rules worth asserting have to live somewhere a unit test can reach. Its
 * tests are `bank-reconciliation.test.ts`.
 */
import { isValidIsoDate } from "./iso-date";

/**
 * A ledger line's signed effect on a settlement account's balance.
 *
 * Every reconcilable account (صندوق، بانک، کارت‌خوان در راه) is an asset, so a
 * debit raises the balance and a credit lowers it. Stated once here because
 * the service's SQL-side total, the screen's optimistic total and the
 * «جمع اقلام تطبیق‌شده» read-out must not each re-derive the sign.
 */
export function lineDelta(line: { debit: number; credit: number }): number {
  return line.debit - line.credit;
}

/** The signed total of the lines a person has ticked. */
export function clearedTotalOf(lines: readonly { debit: number; credit: number; cleared: boolean }[]): number {
  return lines.reduce((sum, line) => (line.cleared ? sum + lineDelta(line) : sum), 0);
}

/**
 * The balance the books say the account should be at: everything an earlier
 * completed reconciliation already accounted for, plus what this one clears.
 */
export function computedBalanceOf(openingBalance: number, clearedTotal: number): number {
  return openingBalance + clearedTotal;
}

/**
 * «مغایرت» — statement minus books. Zero, and only zero, may be locked.
 *
 * The sign is meaningful and is surfaced as such: a positive difference means
 * the statement shows more money than the ticked lines explain (a deposit not
 * yet in the books), a negative one means the books show more (a payment the
 * bank has not applied). The screen used to print a bare number with no way to
 * tell those two apart.
 */
export function differenceOf(statementBalance: number, computedBalance: number): number {
  return statementBalance - computedBalance;
}

/** Everything a reconciliation's header needs, from its parts. */
export function reconciliationTotals(params: {
  openingBalance: number;
  statementBalance: number;
  lines: readonly { debit: number; credit: number; cleared: boolean }[];
}): { clearedTotal: number; computedBalance: number; difference: number } {
  const clearedTotal = clearedTotalOf(params.lines);
  const computedBalance = computedBalanceOf(params.openingBalance, clearedTotal);
  return {
    clearedTotal,
    computedBalance,
    difference: differenceOf(params.statementBalance, computedBalance),
  };
}

/** A reconciliation may only be locked when its cleared lines exactly explain the statement. */
export function canComplete(params: { status: string; difference: number }): boolean {
  return params.status === "in_progress" && params.difference === 0;
}

/**
 * Is this a real Gregorian calendar date, spelled `YYYY-MM-DD`?
 *
 * The wire format is ISO/Gregorian everywhere in this codebase (the user only
 * ever *sees* Jalali — `JalaliDatePicker` converts at the boundary), so this is
 * the shape the API must insist on. It exists because the reconciliation
 * endpoint used to pass whatever string arrived straight into a `date` column:
 * `"not-a-date"` came back as a 500 and «خطای غیرمنتظره», and a Jalali-looking
 * `"1404-04-09"` was accepted as a *Gregorian* year 1404 — a reconciliation
 * six centuries in the past that could never match a single posting.
 *
 * The rule itself is `iso-date.ts` now — the repo already had that module,
 * and A/R aging, A/P aging and this one each still carried a private copy;
 * the A/R and A/P copies accepted whatever `Date.parse` accepted, which reads
 * `2026-02-31` as March. Re-exported under the name the reconciliation
 * service and its tests already import.
 */
export { isValidIsoDate };

/**
 * The Gregorian years a statement date may fall in.
 *
 * A reconciliation is dated by the *statement* a person is holding, so the
 * bound is deliberately loose — a business catching up on last year's books is
 * ordinary. It exists only to reject the two mistakes that are never a
 * statement: a Jalali year typed into a Gregorian field (`1404-…`, which the
 * endpoint used to accept silently) and a typo'd century (`20025-…`).
 */
export const STATEMENT_DATE_MIN_YEAR = 1900;
export const STATEMENT_DATE_MAX_YEAR = 2200;

/** A plausible statement date: a real ISO date inside the sane-year window. */
export function isPlausibleStatementDate(value: unknown): value is string {
  if (!isValidIsoDate(value)) return false;
  const year = Number(value.trim().slice(0, 4));
  return year >= STATEMENT_DATE_MIN_YEAR && year <= STATEMENT_DATE_MAX_YEAR;
}

/**
 * Is a candidate line inside a reconciliation's window?
 *
 * A reconciliation answers for the period ending on its statement date, so a
 * line posted *after* that date is not its business. This is the client-side
 * spelling of the service's `entry_date <= statementDate`, and it exists
 * because the two had drifted apart: the API listed only in-window lines, but
 * `PATCH …/lines` accepted *any* line on the account, so a line dated after
 * the statement could be claimed — locked to a reconciliation that then would
 * not display it, and permanently invisible to every later one.
 */
export function isLineWithinStatementWindow(entryDate: string, statementDate: string): boolean {
  return entryDate <= statementDate;
}

/**
 * How many lines one «انتخاب همه» may claim in a single request.
 *
 * Ticking lines one request at a time is the honest reading of the original
 * contract, but a month of card settlements is several hundred lines and that
 * turned «انتخاب همه» into a burst of hundreds of round-trips — slow enough to
 * look broken, and each one its own chance to fail half-way and leave the
 * reconciliation part-ticked. The batch endpoint exists for that case; the cap
 * keeps a single request from pinning a connection for an unbounded time.
 */
export const MAX_RECONCILIATION_LINE_BATCH = 500;
