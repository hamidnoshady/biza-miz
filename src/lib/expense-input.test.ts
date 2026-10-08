import { describe, expect, it } from "vitest";
import {
  EXPENSE_LIST_DEFAULT_LIMIT,
  EXPENSE_LIST_MAX_LIMIT,
  MIN_EXPENSE_ISO_DATE,
  encodeExpenseCursor,
  expenseDateViolation,
  formatExpenseReference,
  inclusiveExpenseVatAmount,
  isExpenseVatWithinAmount,
  isValidIsoDate,
  parseExpenseAmount,
  parseExpenseCursor,
  parseExpenseListQuery,
  parseExpenseRegisterStatus,
  parseExpenseVatAmount,
} from "./expense-input";

describe("isValidIsoDate", () => {
  it("accepts a real ISO calendar date", () => {
    expect(isValidIsoDate("2025-04-15")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects a well-formed but impossible date", () => {
    // This is the case that used to reach Postgres as raw text and surface as
    // an unhandled 500 instead of a named validation error.
    expect(isValidIsoDate("2025-02-31")).toBe(false);
    expect(isValidIsoDate("2025-13-01")).toBe(false);
    expect(isValidIsoDate("2023-02-29")).toBe(false);
  });

  it("rejects anything that isn't YYYY-MM-DD", () => {
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate("1404-01-01T00:00:00Z")).toBe(false);
    expect(isValidIsoDate("15/04/2025")).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
    expect(isValidIsoDate(20250415)).toBe(false);
  });
});

function q(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe("parseExpenseListQuery", () => {
  it("defaults to no filters and the default window", () => {
    expect(parseExpenseListQuery(q(""))).toEqual({
      dateFrom: null,
      dateTo: null,
      accountId: null,
      paymentAccountId: null,
      locationId: null,
      status: null,
      q: null,
      limit: EXPENSE_LIST_DEFAULT_LIMIT,
      cursor: null,
    });
  });

  it("keeps valid dates and drops malformed ones rather than erroring", () => {
    const parsed = parseExpenseListQuery(q("dateFrom=2025-01-01&dateTo=not-a-date"));
    expect(parsed.dateFrom).toBe("2025-01-01");
    expect(parsed.dateTo).toBeNull();
  });

  it("swaps a reversed range — «از» after «تا» is a mis-click, not an empty list", () => {
    const parsed = parseExpenseListQuery(q("dateFrom=2025-06-01&dateTo=2025-01-01"));
    expect(parsed).toMatchObject({ dateFrom: "2025-01-01", dateTo: "2025-06-01" });
  });

  it("accepts account filters only when they look like ids", () => {
    const id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
    expect(parseExpenseListQuery(q(`accountId=${id}`)).accountId).toBe(id);
    expect(parseExpenseListQuery(q("accountId=5300")).accountId).toBeNull();
    expect(parseExpenseListQuery(q("paymentAccountId=' OR 1=1--")).paymentAccountId).toBeNull();
  });

  it("trims the search term and treats a blank one as absent", () => {
    expect(parseExpenseListQuery(q("q=%20%20")).q).toBeNull();
    expect(parseExpenseListQuery(q("q=%20rent%20")).q).toBe("rent");
  });

  it("clamps the limit and ignores nonsense", () => {
    expect(parseExpenseListQuery(q("limit=25")).limit).toBe(25);
    expect(parseExpenseListQuery(q("limit=100000")).limit).toBe(EXPENSE_LIST_MAX_LIMIT);
    expect(parseExpenseListQuery(q("limit=0")).limit).toBe(EXPENSE_LIST_DEFAULT_LIMIT);
    expect(parseExpenseListQuery(q("limit=-5")).limit).toBe(EXPENSE_LIST_DEFAULT_LIMIT);
    expect(parseExpenseListQuery(q("limit=abc")).limit).toBe(EXPENSE_LIST_DEFAULT_LIMIT);
  });
});

/*
 * Everything below is the part of the expense channel that the *browser* used to
 * own alone: the date rule (§5), and the pure maths the register and the import
 * adapter now share. A rule that only exists in a React component is a rule with
 * one door and four unlocked ones — API, import, autopilot and the AI tool.
 */

const ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

describe("expenseDateViolation", () => {
  it("refuses a future date on every channel, not only in the form", () => {
    expect(expenseDateViolation("2026-04-02", "2026-04-01")).toBe("expense_date_in_future");
    // Today is allowed — an expense recorded this morning is the normal case.
    expect(expenseDateViolation("2026-04-01", "2026-04-01")).toBeNull();
    // So is any earlier day: backdating is a fiscal-period question, answered by
    // the lock, not by this rule.
    expect(expenseDateViolation("2020-01-01", "2026-04-01")).toBeNull();
  });

  it("refuses a fake date before anything reaches the database", () => {
    expect(expenseDateViolation("2025-02-31", "2026-04-01")).toBe("invalid_expense_date");
    // A Jalali year typed into the Gregorian field is a *legal* proleptic date;
    // the floor is what refuses it instead of storing thirteen centuries of
    // backdating and letting the fiscal lock catch it by accident.
    expect(expenseDateViolation("1404-01-01", "2026-04-01")).toBe("invalid_expense_date");
    expect(isValidIsoDate(MIN_EXPENSE_ISO_DATE)).toBe(true);
    expect(isValidIsoDate("1799-12-31")).toBe(false);
    expect(expenseDateViolation("2026-4-1", "2026-04-01")).toBe("invalid_expense_date");
  });

  it("compares lexically only because both sides are YYYY-MM-DD", () => {
    // A missing "today" (a business row without a timezone resolved) must not turn
    // into "everything is in the future".
    expect(expenseDateViolation("1999-01-01", "")).toBeNull();
  });
});

describe("parseExpenseRegisterStatus", () => {
  it("accepts the three register states and nothing else", () => {
    for (const status of ["active", "reversed", "reversal"] as const) {
      expect(parseExpenseRegisterStatus(status)).toBe(status);
    }
    expect(parseExpenseRegisterStatus("none")).toBeNull();
    expect(parseExpenseRegisterStatus("ACTIVE")).toBeNull();
    expect(parseExpenseRegisterStatus(null)).toBeNull();
  });

  it("is what the list query's status filter resolves through", () => {
    expect(parseExpenseListQuery(q("status=reversal")).status).toBe("reversal");
    expect(parseExpenseListQuery(q("status=bogus")).status).toBeNull();
    expect(parseExpenseListQuery(q("status=")).status).toBeNull();
  });
});

describe("parseExpenseListQuery — branch and cursor", () => {
  it("keeps a shaped but foreign location id, so it matches nothing of the tenant", () => {
    // Dropping it would widen «فقط این شعبه» to «همهٔ شعب» — the one filter
    // failure that reads as a correct answer while reporting somebody else's
    // branches (issue #832 §6).
    const parsed = parseExpenseListQuery(q(`locationId=${ID}`));
    expect(parsed.locationId).toBe(ID);
    expect(parseExpenseListQuery(q("locationId=1")).locationId).toBeNull();
  });

  it("reads a cursor only in the register's own shape", () => {
    const parsed = parseExpenseListQuery(q(`cursor=2026-04-01|2026-04-01%2009:12:33.123456%2B00|${ID}`));
    expect(parsed.cursor).toEqual({ date: "2026-04-01", createdAt: "2026-04-01 09:12:33.123456+00", id: ID });
    expect(parseExpenseListQuery(q(`cursor=${ID}`)).cursor).toBeNull();
    expect(parseExpenseListQuery(q("cursor=2026-04-01|now|" + ID)).cursor).toBeNull();
    expect(parseExpenseListQuery(q("cursor=2026-04-01|2026-04-01T09:12:33Z|not-a-uuid")).cursor).toBeNull();
  });
});

describe("encodeExpenseCursor", () => {
  it("round-trips what the API hands back", () => {
    const cursor = { date: "2026-04-01", createdAt: "2026-04-01 09:12:33.123456+00", id: ID };
    expect(parseExpenseCursor(encodeExpenseCursor(cursor))).toEqual(cursor);
  });

  it("accepts the ISO spelling a driver or a proxy may render", () => {
    const encoded = `2026-04-01|2026-04-01T09:12:33.000Z|${ID}`;
    expect(parseExpenseCursor(encoded)?.createdAt).toBe("2026-04-01T09:12:33.000Z");
  });

  it("refuses a hand-edited date rather than paging from a guess", () => {
    expect(parseExpenseCursor(`2026-02-30|2026-04-01T09:12:33Z|${ID}`)).toBeNull();
  });
});

describe("parseExpenseVatAmount", () => {
  it("treats absent as zero, so every pre-VAT expense and form posts unchanged", () => {
    for (const value of [null, undefined, "", 0, "0"]) {
      expect(parseExpenseVatAmount(value)).toBe(0);
    }
  });

  it("accepts a string from a spreadsheet or a JSON body", () => {
    expect(parseExpenseVatAmount("1_200_000")).toBeNull(); // an underscore is not a number
    expect(parseExpenseVatAmount("1200000")).toBe(1200000);
    expect(parseExpenseVatAmount(1200000)).toBe(1200000);
  });

  it("refuses a fraction, a negative and anything over the safe-integer range", () => {
    expect(parseExpenseVatAmount(1200000.5)).toBeNull();
    expect(parseExpenseVatAmount(-1)).toBeNull();
    expect(parseExpenseVatAmount(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(parseExpenseVatAmount(Number.NaN)).toBeNull();
    expect(parseExpenseVatAmount(true)).toBeNull();
  });
});

describe("isExpenseVatWithinAmount", () => {
  it("keeps the net debit positive", () => {
    expect(isExpenseVatWithinAmount(0, 100)).toBe(true);
    expect(isExpenseVatWithinAmount(99, 100)).toBe(true);
    // VAT equal to the gross means a zero-net expense — the arithmetic the
    // migration's CHECK also refuses, so a direct writer cannot smuggle one in.
    expect(isExpenseVatWithinAmount(100, 100)).toBe(false);
    expect(isExpenseVatWithinAmount(101, 100)).toBe(false);
    expect(isExpenseVatWithinAmount(-1, 100)).toBe(false);
  });
});

describe("inclusiveExpenseVatAmount", () => {
  it("takes the VAT out of a VAT-inclusive gross without losing a rial", () => {
    const gross = 12_500_000;
    for (const rate of [9, 10, 12]) {
      const vat = inclusiveExpenseVatAmount(gross, rate);
      expect(Number.isSafeInteger(vat)).toBe(true);
      expect(gross - (vat as number) + (vat as number)).toBe(gross);
      expect(vat).toBeGreaterThan(0);
    }
    // 12.5m inclusive at 10% → 11,363,636 net (rounded), so 1,136,364 of VAT.
    expect(inclusiveExpenseVatAmount(12_500_000, 10)).toBe(1_136_364);
  });

  it("returns null instead of inventing a rate or a negative tax", () => {
    expect(inclusiveExpenseVatAmount(12_500_000, 0)).toBeNull();
    expect(inclusiveExpenseVatAmount(12_500_000, 100)).toBeNull();
    expect(inclusiveExpenseVatAmount(12_500_000, -9)).toBeNull();
    expect(inclusiveExpenseVatAmount(12_500_000, Number.NaN)).toBeNull();
    expect(inclusiveExpenseVatAmount(0, 10)).toBeNull();
    expect(inclusiveExpenseVatAmount(-100, 10)).toBeNull();
  });

  it("is null when the rounding leaves nothing to record", () => {
    // A gross so small that the net rounds back to it has no VAT line to post —
    // and a zero-value journal line is not a fact about the business.
    expect(inclusiveExpenseVatAmount(1, 9)).toBeNull();
    // One rial of VAT on ten is still a rial, so it is still recorded.
    expect(inclusiveExpenseVatAmount(10, 9)).toBe(1);
  });
});

describe("formatExpenseReference", () => {
  it("numbers the document in the Jalali year of the business date", () => {
    // 2026-04-01 CE is 1405-01-12 JE — the year an Iranian files against, taken
    // from `jalali.ts` rather than a second calendar.
    expect(formatExpenseReference("2026-04-01", 1)).toBe("EXP-1405-00001");
    expect(formatExpenseReference("2026-03-20", 1)).toBe("EXP-1404-00001");
    expect(formatExpenseReference("2026-04-01", 42)).toBe("EXP-1405-00042");
  });

  it("pads to five digits and keeps the separator count stable", () => {
    const long = formatExpenseReference("2026-04-01", 1234567);
    expect(long.split("-")).toHaveLength(3);
    expect(long.startsWith("EXP-1405-")).toBe(true);
  });
});

/*
 * The amount rule of this channel, in one function — and the reason `POST` no
 * longer truncates on the way in. These are the cases the old `Math.trunc` got
 * wrong: a fraction became a different number, a boolean became a rial.
 */
describe("parseExpenseAmount", () => {
  it("accepts a whole positive Rial", () => {
    expect(parseExpenseAmount(1_250_000)).toBe(1_250_000);
    expect(parseExpenseAmount(1)).toBe(1);
  });

  it("refuses a fraction instead of shortening it", () => {
    // The bug: 1500.75 reached the ledger as 1500 and nothing said so.
    expect(parseExpenseAmount(1_500.75)).toBeNull();
    expect(parseExpenseAmount(0.5)).toBeNull();
  });

  it("accepts a Toman figure whose ×10 landed on a float artefact", () => {
    // 150.7 تومان *is* 1507 rial; the fraction is in the arithmetic, not the money.
    expect(parseExpenseAmount(1507.0000000000002)).toBe(1507);
  });

  it("reads the shapes a real client sends, and only those", () => {
    expect(parseExpenseAmount("150000")).toBe(150000);
    expect(parseExpenseAmount("۱۵۰٬۰۰۰")).toBe(150000); // Persian digits and the Persian thousands comma
    expect(parseExpenseAmount("150_000")).toBe(150000);
    expect(parseExpenseAmount(" 150000 ")).toBe(150000);
    expect(parseExpenseAmount("1500.0")).toBeNull(); // a decimal point is out of contract
    expect(parseExpenseAmount("1e6")).toBeNull();
    expect(parseExpenseAmount("١٥٠٠٫٥")).toBeNull();
  });

  it("refuses every non-money", () => {
    for (const value of [0, -5, NaN, Infinity, -Infinity, true, false, null, undefined, {}, [], ["1500"]]) {
      expect(parseExpenseAmount(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("stops at the safe-integer ceiling the BIGINT column can hold as a JS number", () => {
    expect(parseExpenseAmount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseExpenseAmount(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(parseExpenseAmount("99999999999999999999")).toBeNull();
  });
});
