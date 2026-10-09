/**
 * Issue #829 completion — «خروجی دریافت‌ها / پرداخت‌ها».
 *
 * The export's contract, stated as tests: one row per voucher, exact Rial
 * integer amounts Excel can sum, Shamsi dates, the same Persian
 * method/status words the register shows, and the audit columns (branch,
 * recorder, id) that make a register export worth reconciling.
 */
import { describe, expect, it } from "vitest";
import {
  buildPaymentsExportTable,
  buildReceiptsExportTable,
  voucherExportFilename,
  voucherMethodCell,
  voucherStatusLabel,
} from "./voucher-export";
import { rowsToCsv } from "./report-export";
import type { PaymentListRow, ReceiptListRow } from "./installments-service";

function receipt(overrides: Partial<ReceiptListRow> = {}): ReceiptListRow {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    date: "2026-10-04",
    method: "bank",
    amount: 3_000_000,
    memo: "بابت فاکتور ۱۲",
    partyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    partyName: "علی رضایی",
    voucherNumber: 7,
    locationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    locationName: "شعبهٔ مرکزی",
    createdAt: "2026-10-04T08:00:00.000Z",
    createdByName: "حسابدار",
    cashAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    bankReference: "1404-777",
    cashAccount: { code: "1119", name: "بانک ملت" },
    entryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    reversedAt: null,
    reversalEntryId: null,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentListRow> = {}): PaymentListRow {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    date: "2026-10-04",
    method: "cash",
    amount: 500_000,
    memo: null,
    supplierId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    supplierPartyId: null,
    partyName: "فروشگاه بهار",
    voucherNumber: 3,
    locationId: null,
    locationName: null,
    createdAt: "2026-10-04T08:00:00.000Z",
    createdByName: null,
    cashAccountId: null,
    bankReference: null,
    cashAccount: null,
    entryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    reversedAt: "2026-10-05T08:00:00.000Z",
    reversalEntryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    reversalDate: "2026-10-05",
    ...overrides,
  };
}

describe("voucher export tables", () => {
  it("renders one receipt row with Shamsi date, Rial amount and the register's words", () => {
    const table = buildReceiptsExportTable([receipt()]);
    expect(table.columns.map((c) => c.label)).toEqual([
      "شماره سند",
      "تاریخ",
      "مشتری",
      "روش",
      "شماره پیگیری",
      "مبلغ (ریال)",
      "شرح",
      "شعبه",
      "ثبت‌کننده",
      "وضعیت",
      "شناسه",
    ]);
    expect(table.rows).toEqual([
      {
        voucherNumber: 7,
        date: "۱۴۰۵/۰۷/۱۲",
        party: "علی رضایی",
        method: "بانکی · بانک ملت",
        bankReference: "1404-777",
        amount: 3_000_000,
        memo: "بابت فاکتور ۱۲",
        location: "شعبهٔ مرکزی",
        createdBy: "حسابدار",
        status: "فعال",
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ]);
  });

  it("names the counterparty column per side and degrades empty cells to blank", () => {
    const table = buildPaymentsExportTable([payment()]);
    expect(table.columns.map((c) => c.label)[2]).toBe("تأمین‌کننده");
    expect(table.rows[0]).toMatchObject({
      method: "نقدی",
      memo: "",
      location: "",
      createdBy: "",
      status: "باطل‌شده",
    });
  });

  it("keeps the amount a number so the spreadsheet column sums", () => {
    const csv = rowsToCsv(buildReceiptsExportTable([receipt({ amount: 1_800_000 })]));
    expect(csv).toContain(",1800000,");
    // A negative amount is still a number, never a formula-guarded string.
    const negative = rowsToCsv(buildReceiptsExportTable([receipt({ amount: -50_000 })]));
    expect(negative).toContain(",-50000,");
  });

  it("leaves formula-looking memo text to the codec's guard, not the table", () => {
    const table = buildReceiptsExportTable([receipt({ memo: "=1+1" })]);
    expect(table.rows[0].memo).toBe("=1+1");
    expect(rowsToCsv(table)).toContain("'=1+1");
  });
});

describe("voucher export cells", () => {
  it("status matches the register's two words", () => {
    expect(voucherStatusLabel({ reversedAt: null })).toBe("فعال");
    expect(voucherStatusLabel({ reversedAt: "2026-10-05" })).toBe("باطل‌شده");
  });

  it("method names the account only when the voucher named one", () => {
    expect(voucherMethodCell(receipt())).toBe("بانکی · بانک ملت");
    expect(voucherMethodCell(payment())).toBe("نقدی");
  });

  it("filenames are ASCII", () => {
    expect(voucherExportFilename("receipts")).toBe("receipts.csv");
    expect(voucherExportFilename("payments")).toBe("payments.csv");
  });
});
