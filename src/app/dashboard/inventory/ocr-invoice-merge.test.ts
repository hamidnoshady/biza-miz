import { describe, expect, it } from "vitest";
import { mergeOcrInvoiceDraft } from "./ocr-invoice-merge";
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
