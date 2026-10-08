/**
 * «تطبیق بانکی و صندوق» — the framework-free half.
 *
 * What a reconciliation *means*, with no database and no React: which
 * accounts are reconcilable at all, which statement dates are acceptable, how
 * a cleared line signs into the running total, what «مغایرت» is, and what
 * shape a request has to arrive in before any of it is believed. The
 * DB-touching half (`reconciliation-service.ts`) consults this before it
 * writes anything, the API routes hand their raw JSON to it before they coerce
 * a single field, and the screen (`reconciliation-section.tsx`) uses the same
 * functions to decide what to show — so the number under «مغایرت» and the
 * number the server refuses to complete on are computed by one piece of code,
 * not two that agree by accident.
 *
 * Split out for the reason `cheques.ts` was split out of `cheques-service.ts`:
 * per this repo's convention a DB-touching module has no direct unit test, so
 * the rules worth asserting have to live somewhere a unit test can reach. Its
 * tests are `bank-reconciliation.test.ts`.
 *
 * Nothing here may reach `./db` — the reconciliation screen imports it, and a
 * client component that pulled in the pool would fail the client-bundle
 * boundary test. `coa-template.ts` is plain data, which is why the
 * reconcilable-account table can live here too.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { isValidIsoDate } from "./iso-date";

/**
 * The settlement accounts «تطبیق بانکی و صندوق» can reconcile.
 *
 * They live here rather than in `reconciliation-service.ts` (which re-exports
 * them for its existing callers) because three consumers need the same list
 * and only one of them may touch a database: the service, the API routes'
 * request parsing, and the deterministic accounting audit
 * (`accounting-review-service.ts`). While the list was a private constant of
 * the service, that audit kept its own copy and it went stale — it counted
 * unreconciled lines on صندوق and کارت‌خوان only, so a business whose cheque
 * money was sitting unclaimed on بانک ۱۱۱۰ read as perfectly reconciled.
 */
export type ReconcilableAccount = "cash" | "bank" | "bankClearing";

export const RECONCILABLE_ACCOUNTS: readonly ReconcilableAccount[] = ["cash", "bank", "bankClearing"];

/** key → well-known code, from the one chart-of-accounts source of truth. */
export const RECONCILABLE_ACCOUNT_CODES: Record<ReconcilableAccount, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bank,
  bankClearing: WELL_KNOWN_CODES.bankClearing,
};

/*
 * Known limitation, deliberately not solved here (issue #830, item 13): these
 * are the three *global* well-known settlement accounts, so a business with two
 * bank accounts, several card terminals or a till per branch still reconciles
 * them as one. Making the set configurable means a per-business mapping of
 * settlement accounts (and terminals) rather than three constants, plus a
 * screen to maintain it and a migration for the businesses already reconciling
 * — a feature, not a constant swap. What this file guarantees meanwhile is
 * that there is exactly one list, so widening it is a one-file change and every
 * consumer (service, routes, screen, accounting audit, assistant) follows.
 */

/** Is this one of the three keys, as opposed to a string somebody sent us? */
export function isReconcilableAccount(value: unknown): value is ReconcilableAccount {
  return typeof value === "string" && (RECONCILABLE_ACCOUNTS as readonly string[]).includes(value);
}

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
 * Does this statement date lie after `todayIso` (Tehran's calendar day)?
 *
 * The screen only ever *warned* about a future date and the server accepted
 * anything up to the year 2200, which let one typo poison the whole chain:
 * completions are ordered by `statement_date`, so a reconciliation locked for
 * a date that hasn't happened yet makes every later real statement look
 * backdated, and `createReconciliation` refuses a statement dated into an
 * already-locked period. The business would then be unable to reconcile the
 * month it was actually living in until somebody deleted the future row by
 * hand. Refused at the boundary instead — a statement you are holding is
 * never dated next week.
 *
 * `todayIso` is a parameter rather than a clock read so the rule is testable
 * without freezing time; callers pass `todayIsoDate()` from `jalali.ts`, which
 * is Tehran's day, not UTC's (see the note there about 00:00–03:30).
 */
export function isStatementDateInFuture(value: string, todayIso: string): boolean {
  return value.trim() > todayIso;
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

/**
 * How many candidate lines one page of the reconciliation screen carries.
 *
 * A bank-clearing account on a busy shop runs to thousands of postings over a
 * year, and the endpoint used to return every unreconciled one from the
 * beginning of time — all of them in one JSON body, all of them rendered. The
 * list is a keyset-paged window now (`nextCursor`), so the page size is what
 * decides how heavy one request is rather than how long the business has
 * existed.
 */
export const MAX_RECONCILIATION_LINES_PAGE = 200;

/**
 * The wire shape of the reconciliation endpoints, checked before coercion.
 *
 * TypeScript's `interface CreateBody` describes what the *caller meant to
 * send*, and erased at runtime it validated nothing: `statementDate: 1717000000`
 * reached `.trim()` and answered 500, `cleared: "false"` coerced to `true`
 * through `Boolean()`, and a batch of `[12, null, "34"]` was silently filtered
 * down to the one string it happened to contain — a request that meant three
 * lines changed one, and reported success. Every field is type-checked here,
 * once, in a place a unit test can reach; the routes only translate `error`
 * into a 400 and the service still owns the domain answers (does this line
 * exist, is it inside the window).
 */
export type ParsedRequest<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CreateReconciliationRequest {
  accountCode: ReconcilableAccount;
  statementDate: string;
  statementBalance: number;
}

/**
 * `POST /api/ledger/reconciliations`.
 *
 * `statementBalance` must arrive as a JSON number: `Number(body.statementBalance)`
 * also accepts `null` (→ 0), `true` (→ 1) and `"12 000"` (→ NaN), and a
 * statement balance of zero is a perfectly legal value that no downstream
 * check would catch.
 */
export function parseCreateReconciliationRequest(
  body: unknown,
  options: { todayIso: string },
): ParsedRequest<CreateReconciliationRequest> {
  if (!isRecord(body)) return { ok: false, error: "bad_request" };
  if (!isReconcilableAccount(body.accountCode)) return { ok: false, error: "invalid_account" };

  if (typeof body.statementDate !== "string" || body.statementDate.trim() === "") {
    return { ok: false, error: "statement_date_required" };
  }
  const statementDate = body.statementDate.trim();
  if (!isPlausibleStatementDate(statementDate)) return { ok: false, error: "invalid_statement_date" };
  if (isStatementDateInFuture(statementDate, options.todayIso)) {
    return { ok: false, error: "statement_date_in_future" };
  }

  if (typeof body.statementBalance !== "number" || !Number.isSafeInteger(body.statementBalance)) {
    return { ok: false, error: "invalid_amount" };
  }

  return {
    ok: true,
    value: { accountCode: body.accountCode, statementDate, statementBalance: body.statementBalance },
  };
}

/**
 * `PATCH /api/ledger/reconciliations/[id]/lines` — one line, or a selection.
 *
 * `cleared` is required to *be* a boolean. It used to be `Boolean(body.cleared)`,
 * which reads `"false"` as `true` and an omitted field as `false` — so a client
 * that forgot the flag un-cleared the line it was trying to tick, and one that
 * sent the string cleared a line it was trying to release. Both are silent
 * money-moving mistakes, so both are 400s now.
 *
 * A batch is refused whole if any element is not a string: dropping the bad
 * ones would report `ok` for a partial write the caller cannot see.
 */
export type LineClearanceRequest =
  | { kind: "single"; journalLineId: string; cleared: boolean }
  | { kind: "batch"; journalLineIds: string[]; cleared: boolean };

export function parseLineClearanceRequest(body: unknown): ParsedRequest<LineClearanceRequest> {
  if (!isRecord(body)) return { ok: false, error: "bad_request" };
  if (typeof body.cleared !== "boolean") return { ok: false, error: "bad_request" };
  const cleared = body.cleared;

  // The batch form wins whenever the caller sent a list, so a single-line
  // PATCH keeps travelling the exact path it always did.
  if (body.journalLineIds !== undefined) {
    if (!Array.isArray(body.journalLineIds)) return { ok: false, error: "bad_request" };
    const ids: string[] = [];
    for (const entry of body.journalLineIds) {
      if (typeof entry !== "string" || entry.trim() === "") return { ok: false, error: "bad_request" };
      ids.push(entry.trim());
    }
    if (ids.length === 0) return { ok: false, error: "journal_line_required" };
    if (ids.length > MAX_RECONCILIATION_LINE_BATCH) return { ok: false, error: "too_many_lines" };
    return { ok: true, value: { kind: "batch", journalLineIds: ids, cleared } };
  }

  if (typeof body.journalLineId !== "string" || body.journalLineId.trim() === "") {
    return { ok: false, error: "journal_line_required" };
  }
  return { ok: true, value: { kind: "single", journalLineId: body.journalLineId.trim(), cleared } };
}
