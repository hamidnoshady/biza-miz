import { describe, expect, it } from "vitest";
import { buildCsv, quoteCsvCell, sanitizeCsvText } from "./csv-safe";

/**
 * Issue #829: receipt/payment CSV export must be formula-safe. A memo is
 * free text — «=1+1» or «@SUM(A1)» typed by a customer would execute as a
 * formula when the export opens in a spreadsheet. Leading-formula cells get a
 * `'` prefix; quoting still escapes embedded quotes.
 */
describe("sanitizeCsvText", () => {
  it("prefixes formula-leading text cells", () => {
    expect(sanitizeCsvText("=1+1")).toBe("'=1+1");
    expect(sanitizeCsvText("+cmd")).toBe("'+cmd");
    expect(sanitizeCsvText("-2+3")).toBe("'-2+3");
    expect(sanitizeCsvText("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    // Leading whitespace does not hide the formula: spreadsheets trim first.
    expect(sanitizeCsvText("  =1+1")).toBe("'  =1+1");
    expect(sanitizeCsvText("\t@SUM(A1)")).toBe("'\t@SUM(A1)");
  });

  it("leaves ordinary text and Persian digits alone", () => {
    expect(sanitizeCsvText("تسویه حساب")).toBe("تسویه حساب");
    expect(sanitizeCsvText("علی رضایی")).toBe("علی رضایی");
    expect(sanitizeCsvText("۱۲۳")).toBe("۱۲۳");
  });
});

describe("quoteCsvCell", () => {
  it("escapes embedded quotes", () => {
    expect(quoteCsvCell('گفت "سلام"')).toBe('"گفت ""سلام"""');
  });
});

describe("buildCsv", () => {
  it("quotes cells", () => {
    const csv = buildCsv(["شرح", "مبلغ"], [["گفت \"سلام\"", "100"]]);
    expect(csv).toBe('"شرح","مبلغ"\n"گفت ""سلام""","100"');
  });

  it("keeps a sanitized formula cell inert", () => {
    const csv = buildCsv(["شرح"], [[sanitizeCsvText("=1+1")]]);
    expect(csv).toBe('"شرح"\n"\'=1+1"');
  });
});
