import { describe, expect, it } from "vitest";
import {
  emptyAccountingSnapshot,
  filterFindings,
  RECONCILABLE_ACCOUNT_NAMES,
  reviewAccounting,
  summarizeFindings,
  type AccountingReviewSnapshot,
} from "./accounting-review";

function snapshot(overrides: Partial<AccountingReviewSnapshot> = {}): AccountingReviewSnapshot {
  return { ...emptyAccountingSnapshot("2026-08-23"), ...overrides };
}

function codes(s: AccountingReviewSnapshot): string[] {
  return reviewAccounting(s).map((finding) => finding.code);
}

describe("a clean set of books", () => {
  it("produces no findings at all", () => {
    expect(reviewAccounting(snapshot())).toEqual([]);
    expect(summarizeFindings([])).toContain("اشکالی پیدا نشد");
  });
});

describe("the rules that mean a report is lying", () => {
  it("flags an unbalanced entry and totals the gap", () => {
    const findings = reviewAccounting(
      snapshot({
        unbalancedEntries: [
          { id: "e1", entryDate: "2026-08-01", memo: "سند", debitRial: 1_000_000, creditRial: 900_000 },
          { id: "e2", entryDate: "2026-08-02", memo: "سند", debitRial: 500_000, creditRial: 700_000 },
        ],
      }),
    );
    expect(findings[0].code).toBe("unbalanced_entry");
    expect(findings[0].severity).toBe("high");
    expect(findings[0].amountRial).toBe(300_000);
    expect(findings[0].count).toBe(2);
  });

  it("flags stock that moved without reaching the ledger", () => {
    expect(
      codes(
        snapshot({
          unpostedInventoryEvents: [
            { id: "i1", eventType: "waste", occurredAt: "2026-08-20T10:00:00Z", status: "pending" },
          ],
        }),
      ),
    ).toContain("unposted_inventory_event");
  });

  // The service now filters `reversed` out in SQL, but the rule is what an
  // owner reads: if a reversed event ever reaches the snapshot again, the
  // finding it produces would tell them to re-post a correction they already
  // made — so the sample text has to keep naming the status it was given.
  it("names the posting status on each sample, so a reversal can never pass as unposted", () => {
    const finding = reviewAccounting(
      snapshot({
        unpostedInventoryEvents: [
          { id: "i1", eventType: "sale_consumption", occurredAt: "2026-08-20T10:00:00Z", status: "failed" },
        ],
      }),
    ).find((row) => row.code === "unposted_inventory_event");
    expect(finding?.samples[0].label).toContain("failed");
    // Jalali, not the raw ISO date — this renders on a Persian-first screen.
    expect(finding?.samples[0].label).not.toContain("2026-08-20");
    expect(finding?.samples[0].label).toContain("۱۴۰۵");
  });

  it("flags a settled sale with no entry, and totals the money that is missing from the books", () => {
    const findings = reviewAccounting(
      snapshot({
        closedOrdersWithoutEntry: [
          { id: "o1", reference: "۱۲۰۱", closedAt: "2026-08-20T20:00:00Z", totalRial: 2_400_000 },
        ],
      }),
    );
    const finding = findings.find((row) => row.code === "closed_order_without_entry");
    expect(finding?.severity).toBe("high");
    expect(finding?.amountRial).toBe(2_400_000);
  });

  it("flags an account the product needs and this chart does not have", () => {
    const findings = reviewAccounting(
      snapshot({ missingAccountCodes: [{ code: "5200", name: "حقوق و دستمزد" }] }),
    );
    const finding = findings.find((row) => row.code === "missing_account_code");
    expect(finding?.severity).toBe("high");
    expect(finding?.detail).toContain("5200");
  });
});

describe("the rules with a threshold — they must not cry wolf", () => {
  it("ignores a draft that is younger than the staleness floor", () => {
    const fresh = snapshot({
      pendingDrafts: [{ id: "d1", memo: "سند", createdAt: "2026-08-22", ageDays: 2, amountRial: 100_000 }],
      staleDraftAfterDays: 7,
    });
    expect(codes(fresh)).not.toContain("stale_journal_draft");

    const stale = snapshot({
      pendingDrafts: [{ id: "d1", memo: "سند", createdAt: "2026-08-01", ageDays: 20, amountRial: 100_000 }],
      staleDraftAfterDays: 7,
    });
    expect(codes(stale)).toContain("stale_journal_draft");
  });

  it("ignores a small drawer difference and reports a real one", () => {
    const variance = (rial: number) =>
      snapshot({
        shiftVariances: [{ shiftId: "s1", employeeName: "علی", endedAt: "2026-08-22", varianceRial: rial }],
        varianceThresholdRial: 500_000,
      });
    expect(codes(variance(-100_000))).not.toContain("shift_cash_variance");
    expect(codes(variance(-900_000))).toContain("shift_cash_variance");
  });

  it("nets shortages against surpluses but reports the absolute size", () => {
    const findings = reviewAccounting(
      snapshot({
        shiftVariances: [
          { shiftId: "s1", employeeName: "علی", endedAt: "2026-08-21", varianceRial: -900_000 },
          { shiftId: "s2", employeeName: "رضا", endedAt: "2026-08-22", varianceRial: -600_000 },
        ],
        varianceThresholdRial: 500_000,
      }),
    );
    const finding = findings.find((row) => row.code === "shift_cash_variance");
    expect(finding?.count).toBe(2);
    expect(finding?.amountRial).toBe(1_500_000);
  });

  it("escalates unreconciled bank lines only once there are a lot of them", () => {
    const few = snapshot({ unreconciledBankLines: { count: 3, oldestAgeDays: 5, amountRial: 10_000 } });
    const many = snapshot({ unreconciledBankLines: { count: 40, oldestAgeDays: 90, amountRial: 10_000 } });
    expect(reviewAccounting(few)[0].severity).toBe("low");
    expect(reviewAccounting(many)[0].severity).toBe("medium");
  });

  it("ignores a purchase draft still inside its grace period", () => {
    const s = snapshot({
      staleDraftPurchases: [{ id: "p1", supplierName: "نانوایی", createdAt: "2026-08-20", ageDays: 3 }],
      staleDraftPurchaseAfterDays: 14,
    });
    expect(codes(s)).not.toContain("stale_draft_purchase");
  });
});

describe("ordering and filtering", () => {
  const busy = snapshot({
    unbalancedEntries: [{ id: "e1", entryDate: "2026-08-01", memo: "", debitRial: 10, creditRial: 5 }],
    unreconciledBankLines: { count: 2, oldestAgeDays: 3, amountRial: 100 },
    negativeStock: [{ id: "n1", name: "شیر", quantity: "-2", unit: "لیتر" }],
  });

  it("puts what makes a report lie above what merely leaves it behind", () => {
    const severities = reviewAccounting(busy).map((finding) => finding.severity);
    expect(severities).toEqual(["high", "medium", "low"]);
  });

  it("filters by the owner's chosen floor", () => {
    const findings = reviewAccounting(busy);
    expect(filterFindings(findings, "low")).toHaveLength(3);
    expect(filterFindings(findings, "medium")).toHaveLength(2);
    expect(filterFindings(findings, "high")).toHaveLength(1);
  });

  it("summarizes by severity", () => {
    const summary = summarizeFindings(reviewAccounting(busy));
    expect(summary).toContain("بحرانی");
    expect(summary).toContain("مهم");
  });
});

describe("every finding is actionable", () => {
  it("carries a severity, a count and a suggestion — a finding with no next step is noise", () => {
    const everything = snapshot({
      unbalancedEntries: [{ id: "e1", entryDate: "2026-08-01", memo: "", debitRial: 10, creditRial: 5 }],
      unpostedInventoryEvents: [{ id: "i1", eventType: "waste", occurredAt: "2026-08-01", status: "pending" }],
      pendingDrafts: [{ id: "d1", memo: "m", createdAt: "2026-08-01", ageDays: 30, amountRial: 1 }],
      shiftVariances: [{ shiftId: "s1", employeeName: "a", endedAt: "2026-08-01", varianceRial: -9_000_000 }],
      missingAccountCodes: [{ code: "5200", name: "حقوق" }],
      negativeStock: [{ id: "n1", name: "شیر", quantity: "-2", unit: "لیتر" }],
      unreconciledBankLines: { count: 1, oldestAgeDays: 1, amountRial: 1 },
      closedOrdersWithoutEntry: [{ id: "o1", reference: "1", closedAt: "2026-08-01", totalRial: 1 }],
      agedReceivables: [{ customerId: "c1", customerName: "x", amountRial: 1, ageDays: 90 }],
      overdueCheques: [
        { id: "q1", serialNumber: "1", dueDate: "2026-08-01", amountRial: 1, direction: "received", status: "in_hand" },
      ],
      staleDraftPurchases: [{ id: "p1", supplierName: null, createdAt: "2026-08-01", ageDays: 30 }],
      unlockedPastPeriods: [{ id: "f1", label: "1405-04", endsOn: "2026-07-22" }],
      uncoveredFiscalEntries: { count: 1, earliest: "2026-08-01", latest: "2026-08-01", fiscalYearCount: 0 },
    });

    const findings = reviewAccounting(everything);
    expect(findings.length).toBe(13);
    for (const finding of findings) {
      expect(finding.count, finding.code).toBeGreaterThan(0);
      expect(finding.title.length, finding.code).toBeGreaterThan(0);
      expect(finding.suggestion.length, finding.code).toBeGreaterThan(0);
    }
    // Every code is distinct, so two rules can never quietly overwrite one card.
    expect(new Set(findings.map((finding) => finding.code)).size).toBe(findings.length);
  });
});

describe("how a finding reads on a Persian phone", () => {
  it("writes money grouped and in Persian digits, never as a bare integer", () => {
    const finding = reviewAccounting(
      snapshot({
        unbalancedEntries: [
          { id: "e1", entryDate: "2026-08-01", memo: "سند", debitRial: 619_224_620, creditRial: 0 },
        ],
      }),
    )[0];
    expect(finding.detail).toContain("۶۱۹٬۲۲۴٬۶۲۰ ریال");
    expect(finding.detail).not.toContain("619224620");
    // The machine-readable amount stays an integer Rial — only the prose shifts.
    expect(finding.amountRial).toBe(619_224_620);
  });

  it("counts in Persian digits too", () => {
    const finding = reviewAccounting(
      snapshot({
        negativeStock: [
          { id: "n1", name: "شیر", quantity: "-2.50", unit: "لیتر" },
          { id: "n2", name: "نان", quantity: "-1", unit: "عدد" },
        ],
      }),
    )[0];
    expect(finding.detail.startsWith("۲ کالا")).toBe(true);
    expect(finding.samples[0].label).toContain("-۲٫۵ لیتر");
  });
});

describe("entries outside every fiscal period (audit F08)", () => {
  it("reports them with a Shamsi range and says nothing is rejected or moved", () => {
    const [finding] = reviewAccounting(
      snapshot({
        uncoveredFiscalEntries: { count: 7, earliest: "2026-03-21", latest: "2026-08-22", fiscalYearCount: 0 },
      }),
    );
    expect(finding.code).toBe("uncovered_fiscal_dates");
    expect(finding.severity).toBe("medium");
    expect(finding.count).toBe(7);
    expect(finding.title).toBe("سال مالی تعریف نشده");
    expect(finding.detail).toContain("۱۴۰۵/۰۱/۰۱");
    expect(finding.detail).not.toContain("2026");
    expect(finding.detail).toContain("رد یا جابه‌جا نمی‌شوند");
    expect(finding.href).toBe("/accounting/fiscal-periods");
  });

  it("stays silent when every entry is covered", () => {
    expect(
      codes(snapshot({ uncoveredFiscalEntries: { count: 0, earliest: null, latest: null, fiscalYearCount: 1 } })),
    ).toEqual([]);
  });
});

describe("a rule can never be the thing that breaks the review", () => {
  it("falls back to the raw date rather than throwing on a malformed one", () => {
    const finding = reviewAccounting(
      snapshot({
        unlockedPastPeriods: [{ id: "f1", label: "۱۴۰۵-۰۴", endsOn: "not-a-date" }],
      }),
    )[0];
    expect(finding.samples[0].label).toContain("not-a-dat");
  });
});

describe("a count the service had to cap", () => {
  it("says so, so «۵۰ مورد» is not read as a total", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `n${index}`,
      name: "شیر",
      quantity: "-1",
      unit: "لیتر",
    }));
    const capped = reviewAccounting(snapshot({ negativeStock: rows, truncatedChecks: ["negative_stock"] }))[0];
    expect(capped.detail).toContain("بیشتر باشد");

    const exact = reviewAccounting(snapshot({ negativeStock: rows }))[0];
    expect(exact.detail).not.toContain("بیشتر باشد");
  });
});

describe("a review that could not run every check", () => {
  it("never reports clean books when a check was unavailable", () => {
    const summary = summarizeFindings([], ["negative stock", "overdue cheques"]);
    expect(summary).toContain("کامل نیست");
    // The clean-books sentence is exactly what must not be said here.
    expect(summary.startsWith("در بازبینی حساب‌ها اشکالی پیدا نشد")).toBe(false);
  });

  it("still says nothing was found when every check ran", () => {
    expect(summarizeFindings([])).toBe("در بازبینی حساب‌ها اشکالی پیدا نشد.");
  });

  it("appends the caveat to a summary that does have findings", () => {
    const findings = reviewAccounting(
      snapshot({ unreconciledBankLines: { count: 2, oldestAgeDays: 3, amountRial: 100 } }),
    );
    expect(summarizeFindings(findings, ["negative stock"])).toContain("کامل نیست");
  });
});

/**
 * Issue #830: the deterministic audit's unreconciled-lines check and its copy
 * both used to name two of the three accounts the reconciliation itself covers.
 * The count came from a query built on the canonical list; the sentence was
 * typed by hand and said «صندوق یا کارت‌خوان» while a cheque-taking business's
 * money sat unclaimed on بانک ۱۱۱۰.
 */
describe("the unreconciled-lines finding names every reconcilable account", () => {
  it("lists صندوق, بانک and کارت‌خوان, derived from the canonical list", () => {
    const finding = reviewAccounting(
      snapshot({ unreconciledBankLines: { count: 4, oldestAgeDays: 12, amountRial: 900_000 } }),
    ).find((candidate) => candidate.code === "unreconciled_bank_lines");

    expect(finding).toBeTruthy();
    expect(RECONCILABLE_ACCOUNT_NAMES).toEqual(["صندوق", "بانک", "کارت‌خوان (در راه)"]);
    for (const name of RECONCILABLE_ACCOUNT_NAMES) {
      expect(finding!.detail, name).toContain(name);
    }
    // The stale two-account sentence, which is what let ۱۱۱۰ go unmentioned.
    expect(finding!.detail).not.toContain("ردیف صندوق یا کارت‌خوان");
  });
});
