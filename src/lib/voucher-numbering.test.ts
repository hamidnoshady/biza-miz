/**
 * Issue #867 — voucher numbering rules: the number's shape, the book each
 * source type belongs to, and where a sequence has a hole.
 */
import { describe, expect, it } from "vitest";
import {
  VOUCHER_DOCUMENT_TYPES,
  VOUCHER_DOCUMENT_TYPE_SPECS,
  documentTypeForSourceType,
  findVoucherGaps,
  fiscalYearLabel,
  isFiscalYearLabel,
  parseVoucherNumber,
  voucherNumberDisplay,
  voucherNumberFor,
  voucherReferenceProblem,
} from "./voucher-numbering";

describe("documentTypeForSourceType", () => {
  it("puts manual entries and their reversals in the manual book", () => {
    expect(documentTypeForSourceType("manual")).toBe("manual");
    expect(documentTypeForSourceType("manual_reversal")).toBe("manual");
  });

  it("keeps every opening source in the opening book", () => {
    expect(documentTypeForSourceType("opening")).toBe("opening");
    expect(documentTypeForSourceType("opening_carry_forward")).toBe("opening");
  });

  it("sends auto-posted and unknown sources to the journal book", () => {
    expect(documentTypeForSourceType("order")).toBe("journal");
    expect(documentTypeForSourceType("purchase")).toBe("journal");
    expect(documentTypeForSourceType("ar_receipt")).toBe("journal");
    expect(documentTypeForSourceType("fixed_asset_depreciation")).toBe("journal");
    expect(documentTypeForSourceType("something_new_next_year")).toBe("journal");
    expect(documentTypeForSourceType(null)).toBe("journal");
    expect(documentTypeForSourceType(undefined)).toBe("journal");
    expect(documentTypeForSourceType("")).toBe("journal");
  });
});

describe("fiscalYearLabel", () => {
  it("renders the Jalali year as four digits", () => {
    expect(fiscalYearLabel(1404)).toBe("1404");
    expect(fiscalYearLabel(999)).toBe("0999");
  });

  it("rejects values that are not years", () => {
    expect(() => fiscalYearLabel(1404.5)).toThrow();
    expect(() => fiscalYearLabel(-1)).toThrow();
    expect(() => fiscalYearLabel(10000)).toThrow();
  });

  it("validates labels", () => {
    expect(isFiscalYearLabel("1404")).toBe(true);
    expect(isFiscalYearLabel("140")).toBe(false);
    expect(isFiscalYearLabel("14a4")).toBe(false);
    expect(isFiscalYearLabel(null)).toBe(false);
  });
});

describe("voucherNumberFor / parseVoucherNumber", () => {
  it("builds a stable printable number with a six-digit sequence", () => {
    expect(voucherNumberFor("manual", "1404", 12)).toBe("MJ-1404-000012");
    expect(voucherNumberFor("journal", "1404", 1)).toBe("RJ-1404-000001");
    expect(voucherNumberFor("opening", "1403", 999999)).toBe("OP-1403-999999");
    expect(voucherNumberFor("summary", "1405", 1)).toBe("SV-1405-000001");
  });

  it("round-trips through parseVoucherNumber", () => {
    for (const type of VOUCHER_DOCUMENT_TYPES) {
      const number = voucherNumberFor(type, "1404", 42);
      expect(parseVoucherNumber(number)).toEqual({ documentType: type, fiscalYearLabel: "1404", sequenceNo: 42 });
    }
  });

  it("rejects malformed numbers and out-of-range sequences", () => {
    expect(parseVoucherNumber("MJ-1404-00012")).toBeNull(); // five digits
    expect(parseVoucherNumber("XX-1404-000012")).toBeNull(); // unknown book
    expect(parseVoucherNumber("mj-1404-000012")).toBeNull(); // case is part of the shape
    expect(parseVoucherNumber("")).toBeNull();
    expect(parseVoucherNumber(null)).toBeNull();
    expect(parseVoucherNumber("s-1404-000012")).toBeNull();
    expect(() => voucherNumberFor("manual", "1404", 0)).toThrow();
    expect(() => voucherNumberFor("manual", "1404", 10 ** 6)).toThrow();
    expect(() => voucherNumberFor("manual", "140", 12)).toThrow();
  });
});

describe("voucherReferenceProblem", () => {
  it("accepts empty (no reference) and well-shaped references", () => {
    expect(voucherReferenceProblem(null)).toBeNull();
    expect(voucherReferenceProblem(undefined)).toBeNull();
    expect(voucherReferenceProblem("")).toBeNull();
    expect(voucherReferenceProblem("OLDSYS-1234/5")).toBeNull();
    expect(voucherReferenceProblem("a.b_c-d")).toBeNull();
  });

  it("refuses shapes the column's CHECK would refuse", () => {
    expect(voucherReferenceProblem("has space")).toBe("voucher_reference_invalid");
    expect(voucherReferenceProblem("پارسی")).toBe("voucher_reference_invalid");
    expect(voucherReferenceProblem("x".repeat(65))).toBe("voucher_reference_invalid");
    expect(voucherReferenceProblem("bad!char")).toBe("voucher_reference_invalid");
  });
});

describe("findVoucherGaps", () => {
  it("reports an unbroken sequence as gap-free", () => {
    const report = findVoucherGaps(
      [1, 2, 3, 4, 5].map((n) => ({ sequenceNo: n })),
      "journal",
      "1404",
    );
    expect(report.gapCount).toBe(0);
    expect(report.missing).toEqual([]);
    expect(report.presentCount).toBe(5);
    expect(report.maxSequenceNo).toBe(5);
    expect(report.missingTruncated).toBe(false);
  });

  it("names the missing sequence numbers in order", () => {
    const report = findVoucherGaps(
      [{ sequenceNo: 1 }, { sequenceNo: 3 }, { sequenceNo: 6 }],
      "manual",
      "1404",
    );
    expect(report.gapCount).toBe(3); // 6 used slots, 3 present
    expect(report.missing).toEqual([2, 4, 5]);
  });

  it("caps the missing list but counts every gap", () => {
    const rows: { sequenceNo: number }[] = [];
    for (let n = 1; n <= 1200; n++) {
      if (n % 2 === 1) rows.push({ sequenceNo: n }); // odd 1..1199: 599 gaps
    }
    const report = findVoucherGaps(rows, "journal", "1404");
    expect(report.gapCount).toBe(599);
    expect(report.missing.length).toBe(500);
    expect(report.missingTruncated).toBe(true);
  });

  it("ignores non-positive or fractional sequences", () => {
    const report = findVoucherGaps(
      [{ sequenceNo: 0 }, { sequenceNo: -3 }, { sequenceNo: 1.5 }, { sequenceNo: 2 }],
      "opening",
      "1404",
    );
    expect(report.presentCount).toBe(1);
    expect(report.maxSequenceNo).toBe(2);
    expect(report.gapCount).toBe(1);
    expect(report.missing).toEqual([1]);
  });

  it("handles an empty set", () => {
    const report = findVoucherGaps([], "summary", "1404");
    expect(report.presentCount).toBe(0);
    expect(report.maxSequenceNo).toBe(0);
    expect(report.gapCount).toBe(0);
  });

  it("shows the allocated trailing hole: counter handed out a number no live entry holds", () => {
    // 1..7 live, the counter has already given out 8 (its entry was deleted,
    // or renumbered away). The 8 is a real hole renumbering may never reuse,
    // even though the in-use sequence looks contiguous.
    const report = findVoucherGaps(
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({ sequenceNo: n })),
      "journal",
      "1404",
      8,
    );
    expect(report.maxSequenceNo).toBe(8);
    expect(report.gapCount).toBe(1);
    expect(report.missing).toEqual([8]);
  });

  it("shows a whole allocated tail, not just the last number", () => {
    // Counter at 10, only 1..3 live: 4..10 were handed out and then vanished.
    const report = findVoucherGaps(
      [1, 2, 3].map((n) => ({ sequenceNo: n })),
      "manual",
      "1404",
      10,
    );
    expect(report.maxSequenceNo).toBe(10);
    expect(report.gapCount).toBe(7);
    expect(report.missing).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it("ignores an allocated max below the in-use maximum (legacy counter)", () => {
    const report = findVoucherGaps(
      [1, 2, 5].map((n) => ({ sequenceNo: n })),
      "journal",
      "1404",
      3,
    );
    expect(report.maxSequenceNo).toBe(5);
    expect(report.gapCount).toBe(2);
    expect(report.missing).toEqual([3, 4]);
  });

  it("keeps the trailing hole inside the missing-list cap", () => {
    const rows = [1, 2, 3].map((n) => ({ sequenceNo: n }));
    const report = findVoucherGaps(rows, "journal", "1404", 10_000);
    expect(report.gapCount).toBe(9_997);
    expect(report.missing.length).toBe(500);
    expect(report.missingTruncated).toBe(true);
    expect(report.missing[0]).toBe(4);
  });
});

describe("voucherNumberDisplay", () => {
  it("shows the stored number, a minted one, or a dash — never blank", () => {
    expect(
      voucherNumberDisplay({ voucherNumber: "MJ-1404-000012", sequenceNo: 12, documentType: "manual", fiscalYearLabel: "1404" }),
    ).toBe("MJ-1404-000012");
    expect(
      voucherNumberDisplay({ voucherNumber: null, sequenceNo: 7, documentType: "journal", fiscalYearLabel: "1404" }),
    ).toBe("RJ-1404-000007");
    expect(
      voucherNumberDisplay({ voucherNumber: null, sequenceNo: null, documentType: "journal", fiscalYearLabel: "1404" }),
    ).toBe("—");
    expect(voucherNumberDisplay(null)).toBe("—");
  });
});

describe("the catalogue", () => {
  it("has four books, each with a stable distinct prefix", () => {
    const prefixes = VOUCHER_DOCUMENT_TYPES.map((t) => VOUCHER_DOCUMENT_TYPE_SPECS[t].prefix);
    expect(new Set(prefixes).size).toBe(4);
    expect(VOUCHER_DOCUMENT_TYPE_SPECS.journal.prefix).toBe("RJ");
    expect(VOUCHER_DOCUMENT_TYPE_SPECS.manual.prefix).toBe("MJ");
    expect(VOUCHER_DOCUMENT_TYPE_SPECS.opening.prefix).toBe("OP");
    expect(VOUCHER_DOCUMENT_TYPE_SPECS.summary.prefix).toBe("SV");
  });
});
