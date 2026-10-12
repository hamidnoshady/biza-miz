/**
 * Issue #829 completion — «خروجی دریافت‌ها / پرداخت‌ها».
 *
 * The export's contract, stated as tests: one row per voucher, amounts in
 * the business's display unit (labelled with it) that Excel can sum, Shamsi
 * dates, the same Persian method/status words the register shows, and the
 * audit columns (branch, recorder, id) that make a register export worth
 * reconciling — streamed whole, never capped.
 */
import { describe, expect, it } from "vitest";
import {
  buildPaymentsExportTable,
  buildReceiptsExportTable,
  streamVoucherExportCsv,
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
    const table = buildReceiptsExportTable([receipt()], "rial");
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
    const table = buildPaymentsExportTable([payment()], "rial");
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
    const csv = rowsToCsv(buildReceiptsExportTable([receipt({ amount: 1_800_000 })], "rial"));
    expect(csv).toContain(",1800000,");
    // A negative amount is still a number, never a formula-guarded string.
    const negative = rowsToCsv(buildReceiptsExportTable([receipt({ amount: -50_000 })], "rial"));
    expect(negative).toContain(",-50000,");
  });

  it("leaves formula-looking memo text to the codec's guard, not the table", () => {
    const table = buildReceiptsExportTable([receipt({ memo: "=1+1" })], "rial");
    expect(table.rows[0].memo).toBe("=1+1");
    expect(rowsToCsv(table)).toContain("'=1+1");
  });

  it("carries Toman cells under a Toman header for a Toman business", () => {
    const table = buildReceiptsExportTable([receipt({ amount: 1_234_560 })], "toman");
    expect(table.columns.map((c) => c.label)[5]).toBe("مبلغ (تومان)");
    expect(table.rows[0].amount).toBe(123_456);
    expect(typeof table.rows[0].amount).toBe("number");
    // …and a spreadsheet still sums the column.
    expect(rowsToCsv(table)).toContain(",123456,");
  });

  it("converts sub-Toman Rial exactly the way the screen's inputs do", () => {
    // Rial is exact by construction; Toman drops the single Rial digit
    // (`moneyToInput` truncation, the same call the money inputs make), so
    // an odd-Rial amount reads 180000 rather than 180000.5.
    expect(buildReceiptsExportTable([receipt({ amount: 1_800_005 })], "rial").rows[0].amount).toBe(1_800_005);
    expect(buildReceiptsExportTable([receipt({ amount: 1_800_005 })], "toman").rows[0].amount).toBe(180_000);
    expect(buildReceiptsExportTable([receipt({ amount: -50_000 })], "toman").rows[0].amount).toBe(-5_000);
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

describe("voucher export streaming", () => {
  async function* chunks<T>(...pages: T[][]): AsyncGenerator<T[]> {
    for (const page of pages) yield page;
  }

  function streamOf(
    firstChunk: Parameters<typeof streamVoucherExportCsv>[0]["firstChunk"],
    rest: AsyncGenerator<readonly import("./voucher-export").VoucherExportRow[]>,
  ) {
    return streamVoucherExportCsv({
      businessId: "biz-1",
      locationId: null,
      userId: null,
      unit: "rial",
      kind: "receipts",
      firstChunk,
      rest,
    });
  }

  // `.text()` would swallow the BOM on decode; the bytes are the file.
  async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    return Buffer.from(await new Response(stream).arrayBuffer());
  }

  it("emits the header and every chunk's rows in order", async () => {
    const second = receipt({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", voucherNumber: 6 });
    const buf = await streamBytes(streamOf([receipt()], chunks([second])));
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const lines = buf.subarray(3).toString("utf8").split("\r\n");
    expect(lines[0]).toBe("شماره سند,تاریخ,مشتری,روش,شماره پیگیری,مبلغ (ریال),شرح,شعبه,ثبت‌کننده,وضعیت,شناسه");
    expect(lines[1]).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(lines[2]).toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(lines[3]).toBe("");
  });

  it("still ships a valid header-only file when the filter matches nothing", async () => {
    const buf = await streamBytes(streamOf([], chunks<never>()));
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(buf.subarray(3).toString("utf8")).toBe("شماره سند,تاریخ,مشتری,روش,شماره پیگیری,مبلغ (ریال),شرح,شعبه,ثبت‌کننده,وضعیت,شناسه\r\n");
  });

  it("fails the download loudly instead of landing a short file", async () => {
    async function* failing(): AsyncGenerator<readonly import("./voucher-export").VoucherExportRow[]> {
      throw new Error("connection reset");
      yield [];
    }
    await expect(new Response(streamOf([], failing())).text()).rejects.toThrow("connection reset");
  });
});
