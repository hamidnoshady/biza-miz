/**
 * `rowsToCsv` is a thin projection over the platform's one CSV writer
 * (`data-transfer/codecs.ts`) since the data transfer engine consolidated the
 * three copies that existed before it. Two consequences are pinned below:
 *
 *  - the document ends with a line terminator, as the shared writer (and
 *    RFC 4180) has always produced — this file's deleted private copy omitted
 *    it, which is precisely the kind of silent divergence the consolidation
 *    removes;
 *  - a cell beginning `=`, `+`, `-` or `@` is neutralised, which this export
 *    did NOT do before. A report cell is attacker-influenced far more often
 *    than it looks (a customer name, an item name), and Excel executes such a
 *    cell on open.
 *
 * Since issue #819 a reporting view's `date` column — which PostgreSQL sends as
 * `YYYY-MM-DD` text, not a JS Date, so the codec could not recognise it — is
 * written in Shamsi like the screen and like every other export in the product
 * (integration/data-transfer.integration.test.ts pins the rule for the data
 * transfer engine). The screen and all three files therefore carry the same
 * date label.
 */
import { describe, expect, it } from "vitest";
import { customReportTable, moneyColumnLabel, moneyExportCell, rowsToCsv, type ReportTable } from "./report-export";

describe("rowsToCsv", () => {
  it("emits a UTF-8 BOM followed by a header row and data rows", () => {
    const table: ReportTable = {
      columns: [
        { key: "day", label: "روز" },
        { key: "total", label: "جمع" },
      ],
      rows: [
        { day: "2026-01-01", total: 220000 },
        { day: "2026-01-02", total: 150000 },
      ],
    };
    const csv = rowsToCsv(table);
    expect(csv.startsWith("﻿")).toBe(true);
    // Trailing terminator dropped before comparing the rows themselves.
    const lines = csv.slice(1).replace(/\r\n$/, "").split("\r\n");
    expect(lines).toEqual([
      "روز,جمع",
      "۱۴۰۴/۱۰/۱۱,220000",
      "۱۴۰۴/۱۰/۱۲,150000",
    ]);
  });

  it("writes a date-column value in Shamsi, matching the screen", () => {
    // Issue #819: the same row read «۱۴۰۴/۱۰/۱۱» on screen and
    // «2026-01-01» in every file. A date that is only text never reached the
    // codec's Date branch, so it is recognised here.
    const table: ReportTable = {
      columns: [{ key: "day", label: "روز" }],
      rows: [{ day: "2026-01-01" }],
    };
    expect(rowsToCsv(table)).toContain("۱۴۰۴/۱۰/۱۱");
  });

  it("quotes cells containing commas, quotes, or newlines", () => {
    const table: ReportTable = {
      columns: [{ key: "name", label: "نام" }],
      rows: [{ name: 'a, "b"\nc' }],
    };
    const csv = rowsToCsv(table);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toBe('"a, ""b""\nc"');
  });

  it("renders null/undefined cells as empty strings", () => {
    const table: ReportTable = {
      columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      rows: [{ a: null, b: undefined }],
    };
    const csv = rowsToCsv(table);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toBe(",");
  });

  it("produces just the header for an empty table", () => {
    const table: ReportTable = { columns: [{ key: "a", label: "A" }], rows: [] };
    expect(rowsToCsv(table).slice(1)).toBe("A\r\n");
  });

  it("neutralises a formula so Excel does not execute it on open", () => {
    // This export had no such guard before the codec consolidation: a report
    // grouped by customer name would happily emit `=HYPERLINK(...)` as a live
    // formula into a file somebody double-clicks.
    const table: ReportTable = {
      columns: [{ key: "name", label: "نام" }],
      rows: [{ name: "=HYPERLINK(\"http://evil\")" }],
    };
    const dataLine = rowsToCsv(table).slice(1).split("\r\n")[1];
    // The apostrophe is what makes it inert; the surrounding quotes are the
    // ordinary CSV escaping of a cell that also contains a double quote.
    expect(dataLine).toContain("'=HYPERLINK");
    expect(dataLine.replace(/^"/, "").startsWith("'=")).toBe(true);
  });

  it("keeps a negative amount numeric instead of neutralising it as a formula", () => {
    // A balance-sheet overdraft used to export as `'-1800000` — text a
    // spreadsheet will not add up.
    const table: ReportTable = { columns: [{ key: "amount", label: "مبلغ (تومان)" }], rows: [{ amount: -1_800_000 }] };
    expect(rowsToCsv(table).slice(1).split("\r\n")[1]).toBe("-1800000");
  });
});

describe("money in a report export", () => {
  it("names the unit in a money column's header", () => {
    expect(moneyColumnLabel("فروش خالص", "toman")).toBe("فروش خالص (تومان)");
    expect(moneyColumnLabel("فروش خالص", "rial")).toBe("فروش خالص (ریال)");
  });

  it("converts integer Rial to the selected unit for a spreadsheet and formats it for a PDF", () => {
    expect(moneyExportCell(2_550_000, "toman", "csv")).toBe(255_000);
    expect(moneyExportCell("2550000", "toman", "excel")).toBe(255_000);
    expect(moneyExportCell("1234.6", "rial", "excel")).toBe(1235);
    expect(moneyExportCell(2_550_000, "rial", "csv")).toBe(2_550_000);
    expect(moneyExportCell(2_550_000, "toman", "pdf")).toBe("۲۵۵٬۰۰۰ تومان");
    expect(moneyExportCell(null, "toman", "csv")).toBe("");
  });

  it("exports a money metric in the selected unit, and a count as a number rather than text", () => {
    const money = customReportTable(
      [{ dim: "اسپرسو", value: "2550000" }],
      { dimensionLabel: "کالا", metricLabel: "جمع فروش" },
      { isMoney: true, unit: "toman", format: "csv" },
    );
    expect(money.columns[1].label).toBe("جمع فروش (تومان)");
    expect(money.rows[0].value).toBe(255_000);
    expect(rowsToCsv(money).slice(1).split("\r\n")[1]).toBe("اسپرسو,255000");

    const count = customReportTable(
      [{ dim: "اسپرسو", value: "12" }],
      { dimensionLabel: "کالا", metricLabel: "تعداد" },
      { isMoney: false, unit: "toman", format: "excel" },
    );
    expect(count.columns[1].label).toBe("تعداد");
    expect(count.rows[0].value).toBe(12);
  });
});
