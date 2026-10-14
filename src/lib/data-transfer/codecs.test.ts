/**
 * The platform's one file codec layer.
 *
 * These cases began as `crm-csv.test.ts` and moved here when the data transfer
 * engine consolidated the three CSV parsers the product used to carry. Every
 * property they pinned still holds — the state machine, the BOM, the Persian
 * digits, the formula guard — because the consolidated writer is the strictest
 * of the three, not a new one. The cases below them are the capabilities the
 * other two copies had (delimiter detection) plus the formats that had no
 * parser at all before (JSON, PDF tables).
 */
import { describe, expect, it } from "vitest";

import {
  csvCell,
  detectDelimiter,
  jsonToRows,
  mapHeaders,
  normaliseHeader,
  parseCsv,
  textTableToRows,
  toCsv,
  westernDigits,
  sheetsToXlsxBuffer,
  xlsxToRows,
  xlsxToWorkbook,
} from "./codecs";

describe("parseCsv", () => {
  it("parses a plain sheet", () => {
    expect(parseCsv("name,phone\nعلی,0912\nرضا,0913")).toEqual([
      ["name", "phone"],
      ["علی", "0912"],
      ["رضا", "0913"],
    ]);
  });

  it("strips the BOM Excel writes, so the first header is recognised", () => {
    // Without this the importer reports "no name column" on a file that has
    // one, and the user has no way to see why.
    const [header] = parseCsv("\uFEFFname,phone\nعلی,0912");
    expect(header[0]).toBe("name");
  });

  it("keeps a comma inside a quoted field", () => {
    expect(parseCsv('name,city\n"شرکت الف، شعبه ۲",تهران')).toEqual([
      ["name", "city"],
      ["شرکت الف، شعبه ۲", "تهران"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsv('name\n"کافه ""لاته"""')).toEqual([["name"], ['کافه "لاته"']]);
  });

  it("keeps a newline inside a quoted field as one cell", () => {
    // Multi-line addresses are common and must not split the row.
    const rows = parseCsv('name,address\nعلی,"خیابان الف\nپلاک ۲"');
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe("خیابان الف\nپلاک ۲");
  });

  it("handles CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops trailing blank lines rather than importing an empty customer", () => {
    expect(parseCsv("name\nعلی\n\n\n")).toEqual([["name"], ["علی"]]);
  });

  it("keeps an empty cell in the middle of a row", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("westernDigits", () => {
  it("converts Persian digits", () => {
    expect(westernDigits("۰۹۱۲۳۴۵۶۷۸۹")).toBe("09123456789");
  });

  it("converts Arabic-Indic digits", () => {
    expect(westernDigits("٠٩١٢")).toBe("0912");
  });

  it("leaves letters and punctuation alone", () => {
    expect(westernDigits("تهران ۲-الف")).toBe("تهران 2-الف");
  });
});

describe("csvCell", () => {
  it("neutralises a formula so Excel does not execute it", () => {
    // A customer name of =HYPERLINK(...) would otherwise run on the machine of
    // whoever opens the export.
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("keeps a finite number numeric — only text can carry a formula", () => {
    expect(csvCell(-1800000)).toBe("-1800000");
    expect(csvCell(-0.5)).toBe("-0.5");
    expect(csvCell("-1800000")).toBe("'-1800000");
  });

  it("quotes cells containing a comma, quote or newline", () => {
    expect(csvCell("الف, ب")).toBe('"الف, ب"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("leaves ordinary text unquoted", () => {
    expect(csvCell("علی")).toBe("علی");
  });

  it("does not quote a Persian comma, which is not a delimiter", () => {
    // U+060C is a letter-like punctuation mark in the data, not CSV syntax.
    // Quoting it would be harmless but wrong, and it appears in most Persian
    // company names.
    expect(csvCell("شرکت الف، شعبه ۲")).toBe("شرکت الف، شعبه ۲");
  });

  it("renders null and undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("round-trips through parseCsv", () => {
    // The strongest statement available: anything we export, we can re-import.
    const headers = ["نام", "یادداشت"];
    const rows = [
      ["شرکت الف، شعبه ۲", 'گفت "بله"'],
      ["علی", "خط ۱\nخط ۲"],
    ];
    const parsed = parseCsv(toCsv(headers, rows));
    expect(parsed).toEqual([headers, ...rows]);
  });

  it("emits a BOM so Excel reads Persian correctly", () => {
    expect(toCsv(["نام"], [])).toMatch(/^\uFEFF/);
  });
});

describe("mapHeaders", () => {
  const aliases = { name: ["name", "نام"], phone: ["phone", "موبایل"] };

  it("matches regardless of case and surrounding space", () => {
    expect(mapHeaders([" Name ", "PHONE"], aliases)).toEqual({ name: 0, phone: 1 });
  });

  it("matches a Persian alias", () => {
    expect(mapHeaders(["نام", "موبایل"], aliases)).toEqual({ name: 0, phone: 1 });
  });

  it("omits fields with no matching column", () => {
    expect(mapHeaders(["نام"], aliases)).toEqual({ name: 0 });
  });
});

describe("detectDelimiter", () => {
  it("reads a comma file as comma-delimited", () => {
    expect(detectDelimiter("name,phone\nعلی,0912")).toBe(",");
  });

  it("reads the semicolons a Persian Windows Excel writes", () => {
    // The list separator of a fa-IR locale is a semicolon, so this is what an
    // ordinary «ذخیره به‌صورت CSV» produces on a Persian Windows install. Two
    // of the three parsers this replaced did not detect it, so the same file
    // imported into the menu and failed into the CRM.
    expect(detectDelimiter("name;phone;city\nعلی;0912;تهران")).toBe(";");
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("reads a tab-separated file", () => {
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
  });

  it("is not fooled by delimiters inside a quoted header cell", () => {
    // `name,"a;b;c;d",phone` has four semicolons and two commas, but it is a
    // comma file: the semicolons are data.
    expect(detectDelimiter('name,"a;b;c;d",phone\n1,2,3')).toBe(",");
  });
});

describe("normaliseHeader", () => {
  it("folds the Arabic ي/ك onto the Persian ی/ک", () => {
    // A file exported from an Arabic-locale Excel writes «كد كالا»; the app
    // spells the same words «کد کالا». Treating them as different columns is
    // a mapping failure the user cannot diagnose.
    expect(normaliseHeader("كد كالا")).toBe(normaliseHeader("کد کالا"));
  });

  it("ignores case, padding, separators and digit script", () => {
    expect(normaliseHeader("  Unit_Price ")).toBe("unit price");
    expect(normaliseHeader("ستون ۲")).toBe("ستون 2");
  });
});

describe("jsonToRows", () => {
  it("reads a bare array of objects", () => {
    expect(jsonToRows('[{"name":"علی","phone":"0912"}]')).toEqual([
      ["name", "phone"],
      ["علی", "0912"],
    ]);
  });

  it("reads the common envelope shapes", () => {
    for (const key of ["data", "rows", "items", "records"]) {
      expect(jsonToRows(`{"${key}":[{"a":1}]}`)).toEqual([["a"], ["1"]]);
    }
  });

  it("unions the keys of every record, so a later extra field is not lost", () => {
    expect(jsonToRows('[{"a":1},{"a":2,"b":3}]')).toEqual([
      ["a", "b"],
      ["1", ""],
      ["2", "3"],
    ]);
  });

  it("renders nested values rather than [object Object]", () => {
    expect(jsonToRows('[{"tags":["x","y"],"meta":{"k":1}}]')[1]).toEqual([
      "x، y",
      '{"k":1}',
    ]);
  });

  it("throws a named error on malformed JSON", () => {
    expect(() => jsonToRows("{not json")).toThrow("json_parse_failed");
  });
});

describe("XLSX workbook parsing", () => {
  async function sampleWorkbook(): Promise<ArrayBuffer> {
    const bytes = await sheetsToXlsxBuffer([
      {
        name: "Goods",
        columns: [{ key: "code", label: "Code" }, { key: "name", label: "Name" }],
        rows: [{ code: "A-1", name: "چای" }],
      },
      {
        name: "Persons",
        columns: [{ key: "code", label: "Code" }, { key: "name", label: "Name" }],
        rows: [{ code: "P-1", name: "علی" }],
      },
    ]);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  it("exposes every sheet, its exact name, header columns, and body rows", async () => {
    const workbook = await xlsxToWorkbook(await sampleWorkbook());
    expect(workbook).toEqual([
      { name: "Goods", columns: ["Code", "Name"], rows: [["A-1", "چای"]] },
      { name: "Persons", columns: ["Code", "Name"], rows: [["P-1", "علی"]] },
    ]);
  });

  it("keeps the generic first-sheet reader backward compatible", async () => {
    expect(await xlsxToRows(await sampleWorkbook())).toEqual([
      ["Code", "Name"],
      ["A-1", "چای"],
    ]);
  });

  it("rejects unsafe large numeric cells only on the provider workbook path", async () => {
    const bytes = await sheetsToXlsxBuffer([{
      name: "Journal",
      columns: [{ key: "code", label: "Code" }, { key: "amount", label: "Amount", type: "money" }],
      rows: [{ code: "J-1", amount: Number.MAX_SAFE_INTEGER + 1 }],
    }]);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await expect(xlsxToWorkbook(buffer)).rejects.toThrow("xlsx_unsafe_numeric_value");
    expect(await xlsxToRows(buffer)).toHaveLength(2);
  });
});

describe("textTableToRows (the PDF heuristic)", () => {
  it("splits a column-gutter table and drops the prose around it", () => {
    // Pass one: an extractor that preserved the table's gutters. The title and
    // the page number are single-cell lines and fall away.
    const page = [
      "فهرست قیمت تأمین‌کننده",
      "",
      "کد        نام            قیمت",
      "A-1       اسپرسو         85000",
      "A-2       کاپوچینو       95000",
      "صفحه ۱ از ۲",
    ].join("\n");
    expect(textTableToRows(page)).toEqual([
      ["کد", "نام", "قیمت"],
      ["A-1", "اسپرسو", "85000"],
      ["A-2", "کاپوچینو", "95000"],
    ]);
  });

  it("falls back to single spaces, because pdf.js collapses the gutters", () => {
    // This is what `unpdf`/pdf.js actually hands back for the same document —
    // verified against a real PDF, not assumed. Without the second pass the
    // extractor finds no table at all and every PDF import reports an empty
    // file.
    const page = [
      "CODE NAME PRICE",
      "A-1 espresso 85000",
      "A-2 cappuccino 95000",
      "A-3 latte 99000",
    ].join("\n");
    expect(textTableToRows(page)).toEqual([
      ["CODE", "NAME", "PRICE"],
      ["A-1", "espresso", "85000"],
      ["A-2", "cappuccino", "95000"],
      ["A-3", "latte", "99000"],
    ]);
  });

  it("cannot tell a same-width heading from a row — the documented limit", () => {
    // A PDF has no table structure, so a three-word title is indistinguishable
    // from a three-column row once whitespace is normalised. The engine does
    // not pretend otherwise: the operator sees every extracted row in the
    // mapping and preview steps before anything is written, and this is why
    // the UI calls PDF support best-effort.
    const page = ["Supplier Price List", "A-1 espresso 85000", "A-2 latte 95000"].join("\n");
    expect(textTableToRows(page)[0]).toEqual(["Supplier", "Price", "List"]);
  });

  it("answers nothing for a page with no table, rather than inventing one", () => {
    expect(textTableToRows("یک پاراگراف معمولی بدون جدول.")).toEqual([]);
  });

  it("refuses to call a single matching line a table", () => {
    // One three-word sentence on a page is a sentence. Returning it would
    // produce an import job whose column headers are somebody's prose.
    expect(textTableToRows("این یک جمله است\nو این هم یکی دیگر که طولانی‌تر است")).toEqual([]);
  });
});
