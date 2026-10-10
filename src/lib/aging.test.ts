import { describe, expect, it } from "vitest";
import {
  AGING_BUCKET_MAX_AGE_DAYS,
  ageOpenItems,
  agingBucketCaseSql,
  bucketForAge,
  summarizeAging,
  unappliedCredit,
  UNKNOWN_CUSTOMER_KEY,
  UNKNOWN_SUPPLIER_KEY,
} from "./aging";

describe("bucketForAge", () => {
  it("buckets in 30-day steps, current through 90+", () => {
    expect(bucketForAge(0)).toBe("current");
    expect(bucketForAge(30)).toBe("current");
    expect(bucketForAge(31)).toBe("d31_60");
    expect(bucketForAge(60)).toBe("d31_60");
    expect(bucketForAge(61)).toBe("d61_90");
    expect(bucketForAge(90)).toBe("d61_90");
    expect(bucketForAge(91)).toBe("over90");
    expect(bucketForAge(400)).toBe("over90");
  });
});

describe("agingBucketCaseSql", () => {
  it("generates the same boundaries bucketForAge applies, from one definition", () => {
    // The A/R and A/P aging reports aggregate in SQL now. If the SQL had its
    // own transcribed «<= 30 / <= 60 / <= 90», moving a boundary in
    // `bucketForAge` would silently stop applying to the reports an accountant
    // actually reads. Building the CASE from the same table is what keeps the
    // two one implementation.
    const sql = agingBucketCaseSql("($3::date - entry_date)");
    expect(AGING_BUCKET_MAX_AGE_DAYS.current).toBe(30);
    expect(sql).toBe(
      "CASE WHEN ($3::date - entry_date) <= 30 THEN 'current' WHEN ($3::date - entry_date) <= 60 THEN 'd31_60' WHEN ($3::date - entry_date) <= 90 THEN 'd61_90' ELSE 'over90' END",
    );
    // Every bucket bucketForAge can return has a branch, and only the
    // open-ended one is the ELSE.
    for (const bucket of ["current", "d31_60", "d61_90"] as const) {
      expect(sql).toContain(`THEN '${bucket}'`);
    }
    expect(sql).toContain("ELSE 'over90'");
  });

  it("keeps the open-ended bucket out of the numbered branches", () => {
    // `over90` is Infinity in the definition table: emitting `<= Infinity`
    // would be the kind of SQL that parses and then never matches.
    expect(agingBucketCaseSql("age")).not.toContain("Infinity");
  });
});

describe("ageOpenItems", () => {
  it("returns a fully-unpaid invoice untouched, aged from its own date", () => {
    const aged = ageOpenItems([{ id: "i1", date: "2025-01-01", amount: 100_000 }], [], "2025-02-15");
    expect(aged).toHaveLength(1);
    expect(aged[0].outstanding).toBe(100_000);
    expect(aged[0].ageDays).toBe(45);
    expect(aged[0].bucket).toBe("d31_60");
  });

  it("drops an invoice fully paid off by receipts", () => {
    const aged = ageOpenItems(
      [{ id: "i1", date: "2025-01-01", amount: 100_000 }],
      [{ id: "r1", date: "2025-01-10", amount: 100_000 }],
      "2025-02-01",
    );
    expect(aged).toHaveLength(0);
  });

  it("applies receipts FIFO across multiple invoices, oldest first", () => {
    const invoices = [
      { id: "i1", date: "2025-01-01", amount: 100_000 },
      { id: "i2", date: "2025-01-15", amount: 100_000 },
    ];
    const receipts = [{ id: "r1", date: "2025-01-20", amount: 150_000 }];
    const aged = ageOpenItems(invoices, receipts, "2025-02-01");
    // i1 (oldest) fully paid; i2 partially paid, 50,000 left outstanding.
    expect(aged).toHaveLength(1);
    expect(aged[0].id).toBe("i2");
    expect(aged[0].outstanding).toBe(50_000);
  });

  it("uses a stable id tie-breaker for same-date FIFO items regardless of input order", () => {
    const aged = ageOpenItems(
      [
        { id: "z-line", date: "2025-01-01", amount: 100_000 },
        { id: "a-line", date: "2025-01-01", amount: 100_000 },
      ],
      [{ id: "r1", date: "2025-01-02", amount: 150_000 }],
      "2025-01-10",
    );
    expect(aged).toEqual([
      { id: "z-line", date: "2025-01-01", amount: 100_000, outstanding: 50_000, ageDays: 9, bucket: "current" },
    ]);
  });

  it("returns same-date open items in stable id order", () => {
    const aged = ageOpenItems(
      [
        { id: "z-line", date: "2025-01-01", amount: 10_000 },
        { id: "a-line", date: "2025-01-01", amount: 20_000 },
      ],
      [],
      "2025-01-10",
    );
    expect(aged.map((item) => item.id)).toEqual(["a-line", "z-line"]);
  });

  it("leaves everything outstanding when there are no receipts", () => {
    const invoices = [
      { id: "i1", date: "2025-01-01", amount: 40_000 },
      { id: "i2", date: "2025-01-15", amount: 60_000 },
    ];
    const aged = ageOpenItems(invoices, [], "2025-01-16");
    expect(aged.map((a) => a.outstanding)).toEqual([40_000, 60_000]);
  });

  it("ignores unapplied excess receipts beyond total invoiced", () => {
    const aged = ageOpenItems(
      [{ id: "i1", date: "2025-01-01", amount: 50_000 }],
      [{ id: "r1", date: "2025-01-05", amount: 200_000 }],
      "2025-01-10",
    );
    expect(aged).toHaveLength(0);
  });
});

describe("summarizeAging", () => {
  it("sums outstanding amounts per bucket and overall", () => {
    const summary = summarizeAging([
      { id: "i1", date: "2025-01-01", amount: 10_000, outstanding: 10_000, ageDays: 5, bucket: "current" },
      { id: "i2", date: "2025-01-01", amount: 20_000, outstanding: 20_000, ageDays: 45, bucket: "d31_60" },
      { id: "i3", date: "2025-01-01", amount: 5_000, outstanding: 5_000, ageDays: 45, bucket: "d31_60" },
      { id: "i4", date: "2025-01-01", amount: 7_000, outstanding: 7_000, ageDays: 120, bucket: "over90" },
    ]);
    expect(summary).toEqual({ current: 10_000, d31_60: 25_000, d61_90: 0, over90: 7_000, total: 42_000 });
  });

  it("returns all zeros for no aged invoices", () => {
    expect(summarizeAging([])).toEqual({ current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 });
  });
});

describe("unappliedCredit", () => {
  it("is zero when payments exactly cover the open items", () => {
    expect(
      unappliedCredit(
        [{ id: "i1", date: "2025-01-01", amount: 100_000 }],
        [{ id: "r1", date: "2025-01-05", amount: 100_000 }],
      ),
    ).toBe(0);
  });

  it("is zero when the party still owes more than they paid", () => {
    expect(
      unappliedCredit(
        [{ id: "i1", date: "2025-01-01", amount: 100_000 }],
        [{ id: "r1", date: "2025-01-05", amount: 60_000 }],
      ),
    ).toBe(0);
  });

  it("returns the overpayment when a receipt exceeds everything owed", () => {
    expect(
      unappliedCredit(
        [{ id: "i1", date: "2025-01-01", amount: 50_000 }],
        [{ id: "r1", date: "2025-01-05", amount: 200_000 }],
      ),
    ).toBe(150_000);
  });

  it("returns the whole advance when nothing was ever invoiced", () => {
    expect(unappliedCredit([], [{ id: "r1", date: "2025-01-05", amount: 300_000 }])).toBe(300_000);
    expect(unappliedCredit([], [])).toBe(0);
  });
});

/*
 * The two sentinel group keys — one per subledger — must stay the shared
 * spelling "unknown": the services group unattributed lines under it, the
 * screens hide their action/link for it, and `isUuid` must reject it (a
 * non-uuid id can never match a party row). Both live here, in the pure
 * module, precisely so client components can import them without `pg`.
 */
describe("unknown-party sentinel keys", () => {
  it("uses one stable spelling for both subledgers", () => {
    expect(UNKNOWN_CUSTOMER_KEY).toBe("unknown");
    expect(UNKNOWN_SUPPLIER_KEY).toBe("unknown");
  });
});
