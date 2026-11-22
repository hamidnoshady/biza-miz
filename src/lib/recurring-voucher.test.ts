/**
 * Recurring voucher recurrence rules.
 *
 * The cases that matter most are the ones a Gregorian implementation gets
 * silently wrong: a Jalali month is 31 days for the first six months, 30 for
 * the next five and 29 or 30 for اسفند, so a monthly template anchored on day
 * 31 must not drift. Each expectation is built through `jalaliToIsoDate`, so a
 * reader can see the Jalali date being asserted rather than decode an ISO one.
 */
import { describe, expect, it } from "vitest";
import { isoDateToJalali, jalaliToIsoDate, isLeapJalaliYear } from "./jalali";
import {
  MONTH_END_POLICIES,
  RECURRENCE_FREQUENCIES,
  addDaysIso,
  compareIsoDate,
  firstOccurrenceOnOrAfter,
  nextOccurrenceAfter,
  occurrenceDateAt,
  occurrenceDatesBetween,
  occurrenceIsOverdue,
  recurringOccurrenceIdempotencyKey,
  recurringVoucherProblem,
  recurringVoucherTotals,
  upcomingOccurrenceDates,
  templateIsEditable,
  type RecurringSchedule,
  type RecurringVoucherLine,
} from "./recurring-voucher";

const iso = (jy: number, jm: number, jd: number) => jalaliToIsoDate(jy, jm, jd);

function schedule(overrides: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    frequency: "monthly",
    monthEndPolicy: "clamp",
    startDate: iso(1404, 6, 31),
    endDate: null,
    ...overrides,
  };
}

function balanced(debit = 1_000_000): RecurringVoucherLine[] {
  return [
    { accountId: "a", debit, credit: 0 },
    { accountId: "b", debit: 0, credit: debit },
  ];
}

describe("monthly recurrence in the Jalali calendar", () => {
  it("clamps day 31 into a 30-day month and back to 31 in a 31-day one", () => {
    const s = schedule();
    const second = nextOccurrenceAfter(s, s.startDate);
    expect(second).toBe(iso(1404, 7, 30));
    const third = nextOccurrenceAfter(s, second!);
    expect(third).toBe(iso(1404, 8, 30));
    const fourth = nextOccurrenceAfter(s, third!);
    // مهر to بهمن are 30-day months and اسفند ۱۴۰۴ is 29; the anchor day is 31,
    // so every one of them clamps — and فروردین ۱۴۰۵ restores day 31.
    expect(fourth).toBe(iso(1404, 9, 30));
    const esfand = nextOccurrenceAfter(s, iso(1404, 11, 30));
    expect(esfand).toBe(iso(1404, 12, 29));
    expect(nextOccurrenceAfter(s, esfand!)).toBe(iso(1405, 1, 31));
  });

  it("puts every occurrence on the last day under the last_day policy", () => {
    const s = schedule({ startDate: iso(1404, 6, 15), monthEndPolicy: "last_day" });
    expect(occurrenceDateAt(s, 0)).toBe(iso(1404, 6, 31));
    expect(occurrenceDateAt(s, 1)).toBe(iso(1404, 7, 30));
    expect(occurrenceDateAt(s, 2)).toBe(iso(1404, 8, 30));
    expect(occurrenceDateAt(s, 11)).toBe(iso(1405, 5, 31));
  });

  it("skips a short month entirely under the skip policy instead of sliding into the next one", () => {
    const s = schedule({ startDate: iso(1404, 11, 30), monthEndPolicy: "skip" });
    // اسفند ۱۴۰۴ has 29 days, so this occurrence has no date; فروردین ۱۴۰۵ does.
    expect(occurrenceDateAt(s, 1)).toBeNull();
    expect(nextOccurrenceAfter(s, s.startDate)).toBe(iso(1405, 1, 30));
  });

  it("treats اسفند ۳۰ as a real date only in a leap year", () => {
    expect(isLeapJalaliYear(1403)).toBe(true);
    expect(isLeapJalaliYear(1404)).toBe(false);
    const leap = schedule({ startDate: iso(1403, 11, 30) });
    expect(nextOccurrenceAfter(leap, leap.startDate)).toBe(iso(1403, 12, 30));
    expect(nextOccurrenceAfter(leap, iso(1403, 12, 30))).toBe(iso(1404, 1, 30));

    const common = schedule({ startDate: iso(1404, 11, 30) });
    // ۱۴۰۴/۱۲ has 29 days: clamped to its last day rather than skipped.
    expect(nextOccurrenceAfter(common, common.startDate)).toBe(iso(1404, 12, 29));
  });

  it("keeps quarterly and yearly steps on Jalali months, not Gregorian ones", () => {
    const quarterly = schedule({ frequency: "quarterly", startDate: iso(1404, 1, 31) });
    expect(nextOccurrenceAfter(quarterly, quarterly.startDate)).toBe(iso(1404, 4, 31));
    expect(nextOccurrenceAfter(quarterly, iso(1404, 4, 31))).toBe(iso(1404, 7, 30));

    const yearly = schedule({ frequency: "yearly", startDate: iso(1403, 12, 30) });
    expect(nextOccurrenceAfter(yearly, yearly.startDate)).toBe(iso(1404, 12, 29));
    expect(nextOccurrenceAfter(yearly, iso(1404, 12, 29))).toBe(iso(1405, 12, 29));
  });
});

describe("weekly recurrence", () => {
  it("steps exactly seven days and never changes month policy", () => {
    const s = schedule({
      frequency: "weekly",
      monthEndPolicy: "last_day",
      startDate: "2026-01-01",
    });
    expect(occurrenceDateAt(s, 0)).toBe("2026-01-01");
    expect(occurrenceDateAt(s, 1)).toBe("2026-01-08");
    expect(nextOccurrenceAfter(s, "2026-01-01")).toBe("2026-01-08");
    expect(addDaysIso("2026-01-01", 7)).toBe("2026-01-08");
  });
});

describe("boundaries", () => {
  it("includes a start date and an end date exactly on an occurrence", () => {
    const s = schedule({ startDate: iso(1404, 6, 31), endDate: iso(1404, 7, 30) });
    expect(occurrenceDatesBetween(s, iso(1404, 1, 1), iso(1404, 12, 29))).toEqual([
      iso(1404, 6, 31),
      iso(1404, 7, 30),
    ]);
  });

  it("returns null past the end date instead of inventing an occurrence", () => {
    const s = schedule({ endDate: iso(1404, 6, 31) });
    expect(nextOccurrenceAfter(s, iso(1404, 6, 31))).toBeNull();
  });

  it("finds the first occurrence on or after a day, before the anchor included", () => {
    const s = schedule();
    expect(firstOccurrenceOnOrAfter(s, iso(1403, 1, 1))).toBe(iso(1404, 6, 31));
    expect(firstOccurrenceOnOrAfter(s, iso(1404, 6, 31))).toBe(iso(1404, 6, 31));
    expect(firstOccurrenceOnOrAfter(s, iso(1404, 7, 1))).toBe(iso(1404, 7, 30));
  });

  it("bounds a catch-up slice and continues from where it stopped", () => {
    const s = schedule({ startDate: iso(1400, 1, 1) });
    const first = occurrenceDatesBetween(s, iso(1400, 1, 1), iso(1405, 12, 29), 3);
    expect(first).toHaveLength(3);
    const rest = occurrenceDatesBetween(s, addDaysIso(first[2], 1), iso(1405, 12, 29), 3);
    expect(rest[0]).toBe(iso(1400, 4, 1));
  });

  it("lists upcoming dates and stops at the end date", () => {
    const s = schedule({ startDate: iso(1404, 1, 1), endDate: iso(1404, 3, 1) });
    expect(upcomingOccurrenceDates(s, iso(1403, 12, 1), 10)).toEqual([
      iso(1404, 1, 1),
      iso(1404, 2, 1),
      iso(1404, 3, 1),
    ]);
  });
});

describe("idempotency identity", () => {
  it("is deterministic and unique per template and scheduled date", () => {
    const key = recurringOccurrenceIdempotencyKey("t1", "2026-01-01");
    expect(key).toBe(recurringOccurrenceIdempotencyKey("t1", "2026-01-01"));
    expect(key).not.toBe(recurringOccurrenceIdempotencyKey("t1", "2026-02-01"));
    expect(key).not.toBe(recurringOccurrenceIdempotencyKey("t2", "2026-01-01"));
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

describe("document rules", () => {
  it("uses exact integer Rial totals and refuses to call an unbalanced document balanced", () => {
    expect(recurringVoucherTotals(balanced(1_234_567_890_123))).toEqual({
      debit: 1_234_567_890_123,
      credit: 1_234_567_890_123,
      balanced: true,
    });
    const odd = recurringVoucherTotals([
      { accountId: "a", debit: 10, credit: 0 },
      { accountId: "b", debit: 0, credit: 9 },
    ]);
    expect(odd.balanced).toBe(false);
  });

  it("accepts a balanced two-account document", () => {
    expect(
      recurringVoucherProblem({
        name: "اجاره",
        description: null,
        memo: "اجارهٔ دفتر",
        frequency: "monthly",
        monthEndPolicy: "clamp",
        startDate: iso(1405, 1, 1),
        endDate: null,
        lines: balanced(),
      }),
    ).toBeNull();
  });

  it("rejects the shapes the ledger must never receive", () => {
    const base = {
      name: "اجاره",
      description: null,
      memo: "اجارهٔ دفتر",
      frequency: "monthly",
      monthEndPolicy: "clamp",
      startDate: iso(1405, 1, 1),
      endDate: null as string | null,
      lines: balanced(),
    };
    expect(recurringVoucherProblem({ ...base, name: " " })).toBe("invalid_name");
    expect(recurringVoucherProblem({ ...base, memo: "" })).toBe("invalid_memo");
    expect(recurringVoucherProblem({ ...base, frequency: "daily" })).toBe("invalid_frequency");
    expect(recurringVoucherProblem({ ...base, monthEndPolicy: "roll" })).toBe("invalid_month_end_policy");
    expect(recurringVoucherProblem({ ...base, startDate: "2026-02-31" })).toBe("invalid_start_date");
    expect(recurringVoucherProblem({ ...base, endDate: iso(1404, 12, 1) })).toBe("end_before_start");
    expect(
      recurringVoucherProblem({
        ...base,
        lines: [
          { accountId: "a", debit: 10, credit: 0 },
          { accountId: "b", debit: 0, credit: 9 },
        ],
      }),
    ).toBe("not_balanced");
    expect(
      recurringVoucherProblem({
        ...base,
        lines: [{ accountId: "a", debit: 10, credit: 0 }],
      }),
    ).toBe("too_few_lines");
    expect(
      recurringVoucherProblem({
        ...base,
        lines: [
          { accountId: "a", debit: 10, credit: 0 },
          { accountId: "a", debit: 0, credit: 10 },
        ],
      }),
    ).toBe("single_account_entry");
    expect(
      recurringVoucherProblem({
        ...base,
        lines: [
          { accountId: "a", debit: 1.5, credit: 0 },
          { accountId: "b", debit: 0, credit: 1.5 },
        ],
      }),
    ).toBe("invalid_amount");
    expect(
      recurringVoucherProblem({
        ...base,
        lines: [
          { accountId: "a", debit: 10, credit: 10 },
          { accountId: "b", debit: 0, credit: 0 },
        ],
      }),
    ).toBe("invalid_amount");
  });

  it("exports the four frequencies and three policies the schema accepts", () => {
    expect(RECURRENCE_FREQUENCIES).toEqual(["weekly", "monthly", "quarterly", "yearly"]);
    expect(MONTH_END_POLICIES).toEqual(["clamp", "last_day", "skip"]);
  });
});

describe("display/register helpers", () => {
  it("marks only a pending or failed past occurrence as overdue", () => {
    const past = "2026-01-01";
    const today = "2026-02-01";
    expect(occurrenceIsOverdue("pending", past, today)).toBe(true);
    expect(occurrenceIsOverdue("failed", past, today)).toBe(true);
    expect(occurrenceIsOverdue("draft", past, today)).toBe(false);
    expect(occurrenceIsOverdue("posted", past, today)).toBe(false);
    expect(occurrenceIsOverdue("skipped", past, today)).toBe(false);
    expect(occurrenceIsOverdue("pending", today, today)).toBe(false);
  });

  it("treats only active and paused templates as editable", () => {
    expect(templateIsEditable("active")).toBe(true);
    expect(templateIsEditable("paused")).toBe(true);
    expect(templateIsEditable("completed")).toBe(false);
    expect(templateIsEditable("cancelled")).toBe(false);
  });

  it("round-trips the ISO date it produces", () => {
    const s = schedule();
    expect(isoDateToJalali(s.startDate)).toEqual({ jy: 1404, jm: 6, jd: 31 });
    expect(compareIsoDate(iso(1404, 1, 1), iso(1404, 2, 1))).toBe(-1);
  });
});
