import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as codecs from "./codecs";
import { csvCell, toCsv } from "./csv";

describe("toCsv", () => {
  it("writes a UTF-8 BOM and CRLF line endings so Excel reads Persian text", () => {
    expect(toCsv(["نام", "مبلغ"], [["علی", 1500000]])).toBe("\uFEFFنام,مبلغ\r\nعلی,1500000\r\n");
  });

  it("keeps integer Rial amounts numeric, including a negative balance", () => {
    expect(toCsv(["مانده"], [[-1800000]])).toBe("\uFEFFمانده\r\n-1800000\r\n");
  });

  it("renders null and undefined as empty cells", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("\uFEFFa,b\r\n,\r\n");
  });
});

describe("csvCell", () => {
  it.each(["=SUM(A1)", "+1", "-x", "@cmd", "\tcmd", "\rcmd"])(
    "neutralises spreadsheet-formula text %j with a leading apostrophe",
    (value) => {
      expect(csvCell(value).replace(/^"/, "")).toMatch(/^'/);
    },
  );

  it("quotes cells that contain a delimiter, a quote or a line break, doubling embedded quotes", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("leaves plain text and finite numbers untouched", () => {
    expect(csvCell("علی")).toBe("علی");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-42)).toBe("-42");
  });
});

describe("codecs compatibility", () => {
  it("re-exports the same function objects, so server consumers keep their import path", () => {
    expect(codecs.toCsv).toBe(toCsv);
    expect(codecs.csvCell).toBe(csvCell);
  });
});

describe("client-safety boundary", () => {
  it("declares no imports, so a browser component importing it never pulls in exceljs or unpdf", () => {
    const source = readFileSync(fileURLToPath(new URL("./csv.ts", import.meta.url)), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*(import\s|export\s[^;]*\sfrom\s|require\()/.test(line));
    expect(importLines).toEqual([]);
  });
});
