import { describe, expect, it } from "vitest";
import {
  canComplete,
  clearedTotalOf,
  computedBalanceOf,
  differenceOf,
  isPlausibleStatementDate,
  isReconcilableAccount,
  isStatementDateInFuture,
  isValidIsoDate,
  lineDelta,
  MAX_RECONCILIATION_LINE_BATCH,
  MAX_RECONCILIATION_LINES_PAGE,
  parseCreateReconciliationRequest,
  parseLineClearanceRequest,
  RECONCILABLE_ACCOUNTS,
  RECONCILABLE_ACCOUNT_CODES,
  STATEMENT_DATE_MAX_YEAR,
  STATEMENT_DATE_MIN_YEAR,
} from "./bank-reconciliation";

describe("lineDelta", () => {
  it("treats a debit as an increase and a credit as a decrease (every reconcilable account is an asset)", () => {
    expect(lineDelta({ debit: 100_000, credit: 0 })).toBe(100_000);
    expect(lineDelta({ debit: 0, credit: 100_000 })).toBe(-100_000);
  });
});

describe("clearedTotalOf", () => {
  it("counts only the ticked lines", () => {
    const lines = [
      { debit: 500_000, credit: 0, cleared: true },
      { debit: 300_000, credit: 0, cleared: false },
      { debit: 0, credit: 200_000, cleared: true },
    ];
    expect(clearedTotalOf(lines)).toBe(300_000);
  });

  it("is zero for no lines and for nothing ticked", () => {
    expect(clearedTotalOf([])).toBe(0);
    expect(clearedTotalOf([{ debit: 900, credit: 0, cleared: false }])).toBe(0);
  });
});

describe("computedBalanceOf / differenceOf", () => {
  it("adds the carried-forward opening balance to what this reconciliation clears", () => {
    expect(computedBalanceOf(100_000, 40_000)).toBe(140_000);
  });

  it("reports the difference as statement minus books, signed", () => {
    // The statement shows more than the books explain — a deposit not yet recorded.
    expect(differenceOf(140_000, 100_000)).toBe(40_000);
    // The books show more than the statement — a payment the bank hasn't applied.
    expect(differenceOf(100_000, 140_000)).toBe(-40_000);
    expect(differenceOf(140_000, 140_000)).toBe(0);
  });
});

describe("canComplete", () => {
  it("allows locking only an in-progress reconciliation that balances exactly", () => {
    expect(canComplete({ status: "in_progress", difference: 0 })).toBe(true);
    expect(canComplete({ status: "in_progress", difference: 1 })).toBe(false);
    expect(canComplete({ status: "in_progress", difference: -1 })).toBe(false);
    expect(canComplete({ status: "completed", difference: 0 })).toBe(false);
  });
});

describe("isValidIsoDate", () => {
  it("accepts a real Gregorian calendar date", () => {
    expect(isValidIsoDate("2025-06-30")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects the inputs that used to reach the date column and 500", () => {
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate("2025-6-3")).toBe(false);
    expect(isValidIsoDate("2025-13-01")).toBe(false);
    expect(isValidIsoDate("2025-02-30")).toBe(false);
    expect(isValidIsoDate("2023-02-29")).toBe(false); // not a leap year
    expect(isValidIsoDate(undefined)).toBe(false);
    expect(isValidIsoDate(20250630)).toBe(false);
  });
});

describe("isPlausibleStatementDate", () => {
  it("accepts ordinary statement dates, including catching up on an old period", () => {
    expect(isPlausibleStatementDate("2025-06-30")).toBe(true);
    expect(isPlausibleStatementDate(`${STATEMENT_DATE_MIN_YEAR}-01-01`)).toBe(true);
    expect(isPlausibleStatementDate(`${STATEMENT_DATE_MAX_YEAR}-12-31`)).toBe(true);
  });

  it("rejects a Jalali year typed into the Gregorian wire field", () => {
    // The screen sends ISO (JalaliDatePicker converts), so «۱۴۰۴/۰۴/۰۹» arriving
    // as 1404-04-09 means something bypassed that conversion: a reconciliation
    // six centuries back that could never match a posting.
    expect(isPlausibleStatementDate("1404-04-09")).toBe(false);
    expect(isPlausibleStatementDate("1403-12-29")).toBe(false);
  });

  it("rejects a typo'd century", () => {
    expect(isPlausibleStatementDate("0025-06-30")).toBe(false);
    expect(isPlausibleStatementDate("9999-06-30")).toBe(false);
  });
});

describe("MAX_RECONCILIATION_LINE_BATCH", () => {
  it("caps a single «انتخاب همه» at a value a month of settlements fits under", () => {
    // Hundreds of card settlements in a month is ordinary; thousands in one
    // request is not, and would pin a connection for an unbounded time.
    expect(MAX_RECONCILIATION_LINE_BATCH).toBeGreaterThanOrEqual(300);
    expect(Number.isSafeInteger(MAX_RECONCILIATION_LINE_BATCH)).toBe(true);
  });
});

describe("isStatementDateInFuture", () => {
  it("refuses a statement dated after today, which would wedge every later one", () => {
    // A completed reconciliation dated into the future makes each real
    // statement after it look backdated, and a statement dated into an
    // already-locked period is refused — so one typo here blocks the account.
    expect(isStatementDateInFuture("2026-10-08", "2026-10-07")).toBe(true);
  });

  it("accepts today and anything before it", () => {
    expect(isStatementDateInFuture("2026-10-07", "2026-10-07")).toBe(false);
    expect(isStatementDateInFuture("2025-04-30", "2026-10-07")).toBe(false);
  });
});

describe("parseCreateReconciliationRequest", () => {
  const today = { todayIso: "2026-10-07" };
  const valid = { accountCode: "bank", statementDate: "2026-09-30", statementBalance: 1_250_000 };

  it("accepts a well-formed request and trims the date", () => {
    const parsed = parseCreateReconciliationRequest({ ...valid, statementDate: " 2026-09-30 " }, today);
    expect(parsed).toEqual({ ok: true, value: valid });
  });

  it("answers a numeric statementDate instead of letting it reach .trim()", () => {
    // Was: `body.statementDate?.trim()` on a number → TypeError → 500.
    expect(
      parseCreateReconciliationRequest({ ...valid, statementDate: 1759190400 }, today),
    ).toEqual({ ok: false, error: "statement_date_required" });
    expect(parseCreateReconciliationRequest({ ...valid, statementDate: null }, today)).toEqual({
      ok: false,
      error: "statement_date_required",
    });
  });

  it("refuses a statementBalance that is not a JSON number", () => {
    // `Number(null)` is 0 and `Number(true)` is 1, and a statement balance of
    // zero is legal — nothing downstream would have caught either.
    for (const statementBalance of [null, "1250000", true, 12.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseCreateReconciliationRequest({ ...valid, statementBalance }, today)).toEqual({
        ok: false,
        error: "invalid_amount",
      });
    }
  });

  it("accepts a negative balance for the bank and passes the rest to the service", () => {
    // Whether a minus is legal is per-account and already the service's rule;
    // the parser's job is only that it arrived as a number.
    expect(parseCreateReconciliationRequest({ ...valid, statementBalance: -250_000 }, today)).toEqual({
      ok: true,
      value: { ...valid, statementBalance: -250_000 },
    });
  });

  it("names an unknown account, a bad date and a future date separately", () => {
    expect(parseCreateReconciliationRequest({ ...valid, accountCode: "petty_cash" }, today)).toEqual({
      ok: false,
      error: "invalid_account",
    });
    expect(parseCreateReconciliationRequest({ ...valid, statementDate: "1404-04-09" }, today)).toEqual({
      ok: false,
      error: "invalid_statement_date",
    });
    expect(parseCreateReconciliationRequest({ ...valid, statementDate: "2026-10-08" }, today)).toEqual({
      ok: false,
      error: "statement_date_in_future",
    });
  });

  it("refuses a body that is not an object", () => {
    // `await request.json()` happily returns `null`, `"5"` or `[1]`; reading
    // `.accountCode` off the first of those is a TypeError, not a 400.
    for (const body of [null, undefined, "body", 5, []]) {
      expect(parseCreateReconciliationRequest(body, today)).toEqual({ ok: false, error: "bad_request" });
    }
  });
});

describe("parseLineClearanceRequest", () => {
  it("accepts the single-line form", () => {
    expect(parseLineClearanceRequest({ journalLineId: " 12 ", cleared: true })).toEqual({
      ok: true,
      value: { kind: "single", journalLineId: "12", cleared: true },
    });
  });

  it("accepts the batch form, and prefers it when both arrive", () => {
    expect(parseLineClearanceRequest({ journalLineIds: ["1", "2"], cleared: false })).toEqual({
      ok: true,
      value: { kind: "batch", journalLineIds: ["1", "2"], cleared: false },
    });
    expect(
      parseLineClearanceRequest({ journalLineId: "1", journalLineIds: ["2"], cleared: true }),
    ).toEqual({ ok: true, value: { kind: "batch", journalLineIds: ["2"], cleared: true } });
  });

  it("requires cleared to actually be a boolean", () => {
    // `Boolean("false")` is true and `Boolean(undefined)` is false: the first
    // cleared a line the caller meant to release, the second released one it
    // meant to clear. Both are silent money-moving mistakes.
    for (const cleared of ["false", "true", 0, 1, null, undefined]) {
      expect(parseLineClearanceRequest({ journalLineId: "1", cleared })).toEqual({
        ok: false,
        error: "bad_request",
      });
    }
    expect(parseLineClearanceRequest({ journalLineId: "1" })).toEqual({
      ok: false,
      error: "bad_request",
    });
  });

  it("refuses a whole batch containing a non-string, rather than dropping it", () => {
    // Was: `.filter(typeof value === "string")` — three ids asked for, one
    // written, and `ok` returned for the difference.
    expect(parseLineClearanceRequest({ journalLineIds: ["1", 2, "3"], cleared: true })).toEqual({
      ok: false,
      error: "bad_request",
    });
    expect(parseLineClearanceRequest({ journalLineIds: ["1", ""], cleared: true })).toEqual({
      ok: false,
      error: "bad_request",
    });
    expect(parseLineClearanceRequest({ journalLineIds: "1", cleared: true })).toEqual({
      ok: false,
      error: "bad_request",
    });
  });

  it("answers an empty selection and an oversized one with their own codes", () => {
    expect(parseLineClearanceRequest({ journalLineIds: [], cleared: true })).toEqual({
      ok: false,
      error: "journal_line_required",
    });
    const tooMany = Array.from({ length: MAX_RECONCILIATION_LINE_BATCH + 1 }, (_, i) => String(i + 1));
    expect(parseLineClearanceRequest({ journalLineIds: tooMany, cleared: true })).toEqual({
      ok: false,
      error: "too_many_lines",
    });
    expect(parseLineClearanceRequest({ cleared: true })).toEqual({
      ok: false,
      error: "journal_line_required",
    });
  });
});

describe("MAX_RECONCILIATION_LINES_PAGE", () => {
  it("is a page, not the whole ledger — and fits inside one batch request", () => {
    expect(MAX_RECONCILIATION_LINES_PAGE).toBeGreaterThan(0);
    // «تطبیق همهٔ نمایان» on a single page must be sendable in one request.
    expect(MAX_RECONCILIATION_LINES_PAGE).toBeLessThanOrEqual(MAX_RECONCILIATION_LINE_BATCH);
  });
});

describe("RECONCILABLE_ACCOUNTS", () => {
  it("names the three settlement accounts and resolves each to its own code", () => {
    expect([...RECONCILABLE_ACCOUNTS]).toEqual(["cash", "bank", "bankClearing"]);
    expect(isReconcilableAccount("bank")).toBe(true);
    expect(isReconcilableAccount("petty_cash")).toBe(false);
    expect(isReconcilableAccount(1110)).toBe(false);
    expect(new Set(RECONCILABLE_ACCOUNTS.map((key) => RECONCILABLE_ACCOUNT_CODES[key])).size).toBe(
      RECONCILABLE_ACCOUNTS.length,
    );
  });
});
