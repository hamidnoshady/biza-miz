import { describe, expect, it } from "vitest";
import { mergeOcrInvoiceDraft, ocrGrandTotalMismatch } from "./ocr-invoice-merge";
import type { SupplierInvoiceDraft } from "./supplier-invoice-fields";

const DRAFT: SupplierInvoiceDraft = {
  invoiceNumber: "typed-7",
  invoiceDate: "2026-01-05",
  vatText: "1200",
  vatTouched: true,
  paymentTermsDays: "30",
  dueDate: "",
};

describe("mergeOcrInvoiceDraft (issue #915 — OCR metadata lands in the editable draft)", () => {
  it("replaces the invoice number and proposes the date when the scan carries both", () => {
    const next = mergeOcrInvoiceDraft(DRAFT, { invoiceNumber: "F-2026-001", purchaseDate: "2026-02-01" });
    expect(next.invoiceNumber).toBe("F-2026-001");
    expect(next.invoiceDate).toBe("2026-02-01");
  });

  it("keeps the typed number when the scan found none, and the picked date when the scan has none", () => {
    expect(mergeOcrInvoiceDraft(DRAFT, { invoiceNumber: null, purchaseDate: "2026-02-01" }).invoiceNumber).toBe("typed-7");
    expect(mergeOcrInvoiceDraft(DRAFT, { invoiceNumber: "F-9", purchaseDate: null }).invoiceDate).toBe("2026-01-05");
    expect(mergeOcrInvoiceDraft(DRAFT, { invoiceNumber: "F-9", purchaseDate: "" }).invoiceDate).toBe("2026-01-05");
  });

  it("returns the draft unchanged (same reference) when the scan carries neither", () => {
    expect(mergeOcrInvoiceDraft(DRAFT, { invoiceNumber: null, purchaseDate: "" })).toBe(DRAFT);
  });

  it("clamps a recognised number to the column's 64-character bound", () => {
    const long = "X".repeat(100);
    expect(mergeOcrInvoiceDraft(DRAFT, { invoiceNumber: long, purchaseDate: null }).invoiceNumber).toHaveLength(64);
  });

  it("never touches the VAT decision — OCR is not the operator's hand", () => {
    const next = mergeOcrInvoiceDraft(DRAFT, { invoiceNumber: "F-1", purchaseDate: "2026-02-01" });
    expect(next.vatText).toBe(DRAFT.vatText);
    expect(next.vatTouched).toBe(DRAFT.vatTouched);
    expect(next.paymentTermsDays).toBe(DRAFT.paymentTermsDays);
  });
});

describe("ocrGrandTotalMismatch (issue #915 — grand total vs lines + VAT)", () => {
  it("agreeing figures need no approval", () => {
    expect(
      ocrGrandTotalMismatch({ grandTotalRial: 110_000, lineTotalsRial: [60_000, 40_000], vatRial: 10_000 }),
    ).toBeNull();
  });

  it("a mismatch reports exact expected/actual/difference for the approval prompt", () => {
    const mismatch = ocrGrandTotalMismatch({
      grandTotalRial: 120_000,
      lineTotalsRial: [60_000, 40_000],
      vatRial: 10_000,
    });
    expect(mismatch).toEqual({ grandTotal: "120000", linesPlusVat: "110000", difference: "10000" });
  });

  it("stays exact past 2^53 — bigint, not float, arithmetic", () => {
    // 2^53 = 9007199254740992; floats cannot tell 2^53 and 2^53+1 apart.
    const mismatch = ocrGrandTotalMismatch({
      grandTotalRial: "9007199254740993",
      lineTotalsRial: ["9007199254740992"],
      vatRial: "0",
    });
    expect(mismatch).toEqual({
      grandTotal: "9007199254740993",
      linesPlusVat: "9007199254740992",
      difference: "1",
    });
    expect(
      ocrGrandTotalMismatch({
        grandTotalRial: "9007199254740993",
        lineTotalsRial: ["9007199254740990", "3"],
        vatRial: "0",
      }),
    ).toBeNull();
  });

  it("reports the absolute difference when the printed total is LOWER than the lines", () => {
    const mismatch = ocrGrandTotalMismatch({
      grandTotalRial: 90_000,
      lineTotalsRial: [60_000, 40_000],
      vatRial: 0,
    });
    expect(mismatch?.difference).toBe("10000");
  });

  it("no grand total on the scan → nothing to cross-check", () => {
    expect(ocrGrandTotalMismatch({ grandTotalRial: null, lineTotalsRial: [1], vatRial: 0 })).toBeNull();
  });

  it("malformed figures are left to the form's own validation, not flagged as mismatches", () => {
    expect(ocrGrandTotalMismatch({ grandTotalRial: 1.5, lineTotalsRial: [1], vatRial: 0 })).toBeNull();
    expect(ocrGrandTotalMismatch({ grandTotalRial: 10, lineTotalsRial: ["abc"], vatRial: 0 })).toBeNull();
    expect(ocrGrandTotalMismatch({ grandTotalRial: 10, lineTotalsRial: [10], vatRial: "-1" })).toBeNull();
  });
});
