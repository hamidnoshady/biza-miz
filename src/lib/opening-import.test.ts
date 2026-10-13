/**
 * Issue #867 — opening balances file import, the pure part: one codec layer,
 * the exact-money primitive, and a problem per row the accountant must fix.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  OPENING_IMPORT_ALIASES,
  openingImportTableFromBuffer,
  parseOpeningImportTable,
} from "./opening-import";

const headersFa = ["کد حساب", "نام", "بدهکار", "بستانکار", "مرجع", "توضیح"];
const headersEn = ["code", "name", "debit", "credit", "reference", "note"];

describe("parseOpeningImportTable — headers", () => {
  it("maps the Persian header set", () => {
    const out = parseOpeningImportTable(headersFa, [
      ["1000", "نقد", "۵٬۰۰۰٬۰۰۰", "", "", "افتتاحیه"],
    ], "toman");
    expect(out.problems).toEqual([]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatchObject({
      code: "1000",
      name: "نقد",
      debit: "50000000", // toman → Rial: ×10
      credit: "0",
      reference: null,
      note: "افتتاحیه",
    });
  });

  it("maps the English header set", () => {
    const out = parseOpeningImportTable(headersEn, [
      ["1200", "AR", "1000", "2000", "ref-1", ""],
    ], "rial");
    expect(out.problems).toEqual([]);
    expect(out.lines[0]).toMatchObject({ code: "1200", debit: "1000", credit: "2000", reference: "ref-1" });
  });

  it("folds Arabic-locase spellings (كد → کد) through the codec normaliser", () => {
    const out = parseOpeningImportTable(["كد", "بدهکار", "بستانکار"], [["1000", "500", ""]], "rial");
    expect(out.problems).toEqual([]);
    expect(out.lines[0].code).toBe("1000");
  });

  it("refuses a file with no account column and one with no amount columns", () => {
    const noAccount = parseOpeningImportTable(["debit", "credit"], [["1", "2"]], "rial");
    expect(noAccount.problems.map((p) => p.problem)).toContain("missing_account_column");
    expect(noAccount.problems.map((p) => p.problem)).toContain("unrecognised_headers");
    expect(noAccount.lines).toEqual([]);

    const noAmount = parseOpeningImportTable(["code", "name"], [["1000", "نقد"]], "rial");
    expect(noAmount.problems.map((p) => p.problem)).toContain("missing_amount_columns");
  });
});

describe("parseOpeningImportTable — amounts in the selected unit", () => {
  it("reads a Toman file as Toman (×10 Rial) and a Rial file as Rial", () => {
    const toman = parseOpeningImportTable(headersFa, [["1000", "", "125000", "", "", ""]], "toman");
    expect(toman.lines[0].debit).toBe("1250000");

    const rial = parseOpeningImportTable(headersFa, [["1000", "", "125000", "", "", ""]], "rial");
    expect(rial.lines[0].debit).toBe("125000");
  });

  it("accepts Persian digits and thousands separators", () => {
    const out = parseOpeningImportTable(headersFa, [["1000", "", "۱٬۲۵۰٬۰۰۰", "", "", ""]], "rial");
    expect(out.problems).toEqual([]);
    expect(out.lines[0].debit).toBe("1250000");
  });

  it("rejects decimals, signs and garbage as row problems — never a silent 0", () => {
    const out = parseOpeningImportTable(
      headersFa,
      [
        ["1000", "کسری", "1234.5", "", "", ""],
        ["1001", "منفی", "-5000", "", "", ""],
        ["1002", "زباله", "پانزده", "", "", ""],
        ["1003", "درست", "", "7500", "", ""],
      ],
      "rial",
    );
    const bad = out.problems.filter((p) => p.problem === "invalid_amount");
    expect(bad).toHaveLength(3);
    expect(bad.map((p) => p.rowIndex)).toEqual([2, 3, 4]);
    expect(out.lines).toHaveLength(1); // only the good row survives
    expect(out.lines[0].credit).toBe("7500");
  });

  it("caps the line count", () => {
    const rows = Array.from({ length: 501 }, (_, i) => [String(1000 + i), "", "1", "", "", ""]);
    const out = parseOpeningImportTable(headersFa, rows, "rial");
    expect(out.problems.map((p) => p.problem)).toContain("too_many_rows");
  });

  it("keeps the alias table in sync with the documented columns", () => {
    expect(Object.keys(OPENING_IMPORT_ALIASES).sort()).toEqual(
      ["code", "credit", "debit", "name", "note", "reference"].sort(),
    );
  });
});

describe("openingImportTableFromBuffer — the one codec layer", () => {
  it("parses a BOM'd, semicolon-delimited CSV with a quoted comma", async () => {
    const csv = "\uFEFFکد;بدهکار;بستانکار\n\"1000\";\"شرکت الف، شعبهٔ ۲\";100\n;50;200\n";
    const table = await openingImportTableFromBuffer("balance.csv", Buffer.from(csv, "utf8"));
    if ("problem" in table) throw new Error(`unexpected problem: ${table.problem.problem}`);
    expect(table.headers).toEqual(["کد", "بدهکار", "بستانکار"]);
    expect(table.rows).toEqual([
      ["1000", "شرکت الف، شعبهٔ ۲", "100"],
      ["", "50", "200"],
    ]);
  });

  it("parses an XLSX workbook's first sheet through the shared reader", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("ترازات");
    sheet.addRow(["code", "name", "debit", "credit"]);
    sheet.addRow(["1000", "نقد", 5000000, 0]);
    sheet.addRow(["2100", "A/P", 0, 2500000]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const table = await openingImportTableFromBuffer("balance.xlsx", buffer);
    if ("problem" in table) throw new Error(`unexpected problem: ${table.problem.problem}`);
    expect(table.headers).toEqual(["code", "name", "debit", "credit"]);
    expect(table.rows).toEqual([
      ["1000", "نقد", "5000000", "0"],
      ["2100", "A/P", "0", "2500000"],
    ]);
  });

  it("answers problems, not guesses: unsupported extension, empty file", async () => {
    const bad = await openingImportTableFromBuffer("balance.xls", Buffer.from("x"));
    expect(bad).toMatchObject({ problem: { problem: "unsupported_format" } });

    const empty = await openingImportTableFromBuffer("empty.csv", Buffer.from("", "utf8"));
    expect(empty).toMatchObject({ problem: { problem: "empty_file" } });
  });

  it("round-trips a parsed table into lines", async () => {
    const csv = "کد,بدهکار,بستانکار\n1000,1000000,\n1200,,300000\n";
    const table = await openingImportTableFromBuffer("b.csv", Buffer.from(csv, "utf8"));
    if ("problem" in table) throw new Error("unexpected problem");
    const out = parseOpeningImportTable(table.headers, table.rows, "rial");
    expect(out.problems).toEqual([]);
    expect(out.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1000", "1000000", "0"],
      ["1200", "0", "300000"],
    ]);
  });
});
