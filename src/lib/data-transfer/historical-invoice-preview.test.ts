import { describe, expect, it } from "vitest";
import { parseHistoricalDate, parseHistoricalRial, previewHistoricalInvoices, previewHistoricalInvoiceSheets, type HistoricalInvoiceRow, type HistoricalPreviewOptions } from "./historical-invoice-preview";

const options: HistoricalPreviewOptions = {
  sourceKey: "file:shop-a",
  currency: "toman",
  calendar: "jalali",
  verifiedCustomers: [{ externalCustomerCode: "C1", partyId: "party-1" }],
  archivedExternalIds: [],
};
const base: HistoricalInvoiceRow = {
  rowNumber: 2, externalInvoiceId: "id-1", invoiceNumber: "12", invoiceDate: "۱۴۰۳/۰۱/۰۱",
  externalCustomerCode: "C1", total: "۱۰۰", paid: "30", balance: "70",
};

describe("historical invoice dry-run", () => {
  it("converts money exactly without rounding or unsafe integers", () => {
    expect(parseHistoricalRial("۹۰۰٬۷۱۹٬۹۲۵٬۴۷۴٬۰۹۹٫۱", "toman")).toBe("9007199254740991");
    expect(parseHistoricalRial("0.1", "toman")).toBe("1");
    expect(parseHistoricalRial("0.01", "toman")).toBeNull();
    expect(parseHistoricalRial("1.1", "rial")).toBeNull();
    expect(parseHistoricalRial("-1", "rial")).toBeNull();
    expect(parseHistoricalRial("1foo", "rial")).toBeNull();
    expect(parseHistoricalRial("9223372036854775808", "rial")).toBeNull();
  });
  it("validates explicit calendars without normalizing invalid dates", () => {
    expect(parseHistoricalDate("۱۴۰۳/۱/۱", "jalali")).toBe("2024-03-20");
    expect(parseHistoricalDate("1402/12/30", "jalali")).toBeNull();
    expect(parseHistoricalDate("2023-02-29", "gregorian")).toBeNull();
    expect(parseHistoricalDate("2024-02-29", "gregorian")).toBe("2024-02-29");
  });
  it("groups lines as one document and preserves rows without side effects", () => {
    const rows = [
      { ...base, lineName: "A", quantity: "2", unitPrice: "20" },
      { rowNumber: 3, externalInvoiceId: "id-1", lineSku: "B", quantity: "1", unitPrice: "60" },
    ];
    const before = structuredClone(rows);
    const result = previewHistoricalInvoices(rows, options);
    expect(rows).toEqual(before);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ partyId: "party-1", outcome: "ready", totalRial: "1000", paidRial: "300", balanceRial: "700", summaryOnly: false, invoiceDate: "2024-03-20" });
    expect(result[0].rows).toHaveLength(2);
    expect(result[0].warnings.join()).toContain("پرداخت جزئی");
  });
  it("keeps header-only records explicit and does not invent lines or balances", () => {
    const [doc] = previewHistoricalInvoices([{ ...base, paid: undefined, balance: undefined }], options);
    expect(doc).toMatchObject({ summaryOnly: true, paidRial: null, balanceRial: null, outcome: "ready" });
  });
  it("requires a reviewed source-specific customer binding and blocks ambiguity", () => {
    expect(previewHistoricalInvoices([base], { ...options, verifiedCustomers: [] })[0]).toMatchObject({ outcome: "review", partyId: null });
    expect(previewHistoricalInvoices([base], { ...options, verifiedCustomers: [...options.verifiedCustomers, { externalCustomerCode: "C1", partyId: "party-2" }] })[0]).toMatchObject({ outcome: "review", partyId: null });
  });
  it("rejects collisions in a document, bad money, currency and inconsistent totals", () => {
    const rows = [
      { ...base, currency: "rial", lineName: "A", quantity: "-1", unitPrice: "30" },
      { ...base, rowNumber: 3, externalCustomerCode: "C2", total: "99", balance: "80" },
    ];
    const [doc] = previewHistoricalInvoices(rows, options);
    expect(doc.outcome).toBe("invalid");
    expect(doc.errors.join(" ")).toContain("externalCustomerCode");
    expect(doc.errors.join(" ")).toContain("واحد پول");
    expect(doc.errors.join(" ")).toContain("مرجوعی");
    expect(doc.errors.join(" ")).toContain("جمع ردیف‌ها");
  });
  it("never uses an invoice number as its ID and blocks archived IDs", () => {
    const docs = previewHistoricalInvoices([{ ...base, externalInvoiceId: "" }, { ...base, rowNumber: 3, externalInvoiceId: "" }, base], { ...options, archivedExternalIds: ["id-1"] });
    expect(docs.map((d) => d.outcome)).toEqual(["invalid", "invalid", "already_imported"]);
  });
  it("reconciles line and invoice discounts and taxes, and refuses fractional rial", () => {
    const [doc] = previewHistoricalInvoices([{ ...base, total: "95", paid: undefined, balance: undefined, invoiceDiscount: "10", invoiceTax: "5", lineName: "A", quantity: "2", unitPrice: "50" }], options);
    expect(doc.outcome).toBe("ready");
    const [fraction] = previewHistoricalInvoices([{ ...base, total: "1", lineName: "A", quantity: "0.5", unitPrice: "0.1" }], options);
    expect(fraction.outcome).toBe("invalid");
    expect(fraction.errors.join()).toContain("کسر ریال");
  });
  it("joins two sheets only by ID and reports orphan lines and duplicate headers", () => {
    const result = previewHistoricalInvoiceSheets([base], [
      { rowNumber: 2, externalInvoiceId: "id-1", lineName: "A", quantity: "1", unitPrice: "100" },
      { rowNumber: 3, externalInvoiceId: "unknown", lineName: "B", quantity: "1", unitPrice: "1" },
      { rowNumber: 4, externalInvoiceId: "", lineName: "C" },
    ], options);
    expect(result.documents[0]).toMatchObject({ outcome: "ready", summaryOnly: false });
    expect(result.orphanLines.map((row) => row.rowNumber)).toEqual([3, 4]);
    const duplicate = previewHistoricalInvoiceSheets([base, { ...base, rowNumber: 3 }], [], options);
    expect(duplicate.documents[0].outcome).toBe("invalid");
  });

  it("groups a 2,000-document batch against 500 existing customer bindings", () => {
    const bindings = Array.from({ length: 500 }, (_, i) => ({ externalCustomerCode: `C${i}`, partyId: `party-${i}` }));
    const rows = Array.from({ length: 2000 }, (_, i) => ({ ...base, rowNumber: i + 2, externalInvoiceId: `invoice-${i}`, externalCustomerCode: `C${i % 500}` }));
    const docs = previewHistoricalInvoices(rows, { ...options, verifiedCustomers: bindings });
    expect(docs).toHaveLength(2000);
    expect(docs.every((doc, i) => doc.outcome === "ready" && doc.partyId === `party-${i % 500}`)).toBe(true);
  });

});
