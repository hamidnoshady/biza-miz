import { describe, expect, it } from "vitest";
import { runLinesToCsv, runsToCsv } from "./commission-settlement-csv";

const LINE = {
  runNumber: 4,
  lineKind: "accrual" as const,
  saleDate: "2026-10-05",
  employeeName: "علی",
  employeeCode: "E-1",
  sourceLabel: "سفارش 101",
  orderNumber: "101",
  itemName: "رژ لب",
  basisAmount: "2000000",
  amount: "100000",
  ruleVersion: "abcdef0123456789",
  entryId: "entry-1",
};

describe("the lines export", () => {
  it("is a UTF-8 BOM and CRLF file, with the business unit in the headers", () => {
    const csv = runLinesToCsv([LINE], "toman");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const header = csv.slice(1).split("\r\n")[0];
    expect(header).toContain("مبنای محاسبه (تومان)");
    expect(header).toContain("پورسانت (تومان)");
  });

  it("writes amounts in the unit the screen shows, so the file agrees with it", () => {
    const toman = runLinesToCsv([LINE], "toman").split("\r\n")[1];
    expect(toman).toContain(",200000,");
    expect(toman).toContain(",10000,");
    const rial = runLinesToCsv([LINE], "rial");
    expect(rial.split("\r\n")[0]).toContain("پورسانت (ریال)");
    expect(rial.split("\r\n")[1]).toContain(",2000000,");
  });

  it("writes the Shamsi date and the carry-forward wording for a carried line", () => {
    const csv = runLinesToCsv(
      [{ ...LINE, lineKind: "carry_forward", saleDate: null, sourceLabel: "مانده دورهٔ شماره 2", orderNumber: null }],
      "rial",
    );
    const row = csv.split("\r\n")[1];
    expect(row).toContain("مانده دورهٔ قبل");
    expect(row.startsWith("4,,")).toBe(true);
  });

  it("neutralises a cell that a spreadsheet would read as a formula", () => {
    const csv = runLinesToCsv([{ ...LINE, employeeName: "=HYPERLINK(\"x\")" }], "rial");
    expect(csv).not.toContain(',=HYPERLINK');
  });
});

describe("the runs export", () => {
  it("lists status in words and the outstanding balance", () => {
    const csv = runsToCsv(
      [
        {
          runNumber: 7,
          title: null,
          periodFrom: "2026-10-01",
          periodTo: "2026-10-09",
          status: "partially_paid",
          lineCount: 3,
          employeeCount: 2,
          commissionTotal: "500000",
          paidTotal: "200000",
          outstandingTotal: "300000",
          createdAt: "2026-10-09T10:00:00.000Z",
        },
      ],
      "rial",
    );
    const [header, row] = csv.slice(1).split("\r\n");
    expect(header).toContain("باقی‌مانده (ریال)");
    expect(row).toContain("پرداخت بخشی");
    expect(row).toContain(",300000,");
  });
});
