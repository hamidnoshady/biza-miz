import { describe, expect, it } from "vitest";
import { buildPurchaseReceiptHtml, escapeHtml, type ReceiptLine, type ReceiptPurchase } from "./purchase-receipt-print";

const PURCHASE: ReceiptPurchase = {
  id: "7d4f8a3e-1b2c-4d5e-8f90-123456789abc",
  total: "9007199254740993", // 2^53 + 1 — must appear exactly
  vatAmount: "45000",
  settlementMethod: "bank",
  supplierInvoiceNumber: "F-12",
  supplierInvoiceDate: "2026-01-04",
  paymentDueDate: null,
  note: "<script>alert(1)</script>",
  receivedAt: "2026-01-05T08:00:00Z",
  supplierName: 'Acme & "Sons"',
  createdByName: null,
};

const LINES: ReceiptLine[] = [
  {
    id: "l1",
    itemName: "کرم <b>دست</b>",
    sku: "SKU-1",
    quantity: "2",
    unitCost: "4503599627370497",
    batchNumber: "B-9",
    serialNumber: null,
    expiryDate: "2027-03-01",
  },
];

const formatMoney = (t: string) => `${t} ریال`;

describe("buildPurchaseReceiptHtml (issue #915 phase 3 — print view of a posted receipt)", () => {
  it("escapes every dynamic value — a note or item name can never inject markup", () => {
    const html = buildPurchaseReceiptHtml(PURCHASE, LINES, formatMoney);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>دست</b>");
    expect(html).toContain("Acme &amp; &quot;Sons&quot;");
  });

  it("shows exact text money (past 2^53) and Shamsi dates, never raw ISO", () => {
    const html = buildPurchaseReceiptHtml(PURCHASE, LINES, formatMoney);
    expect(html).toContain("9007199254740993 ریال");
    expect(html).toContain("4503599627370497 ریال");
    expect(html).toContain("۱۴۰۴/۱۰/۱۵"); // receivedAt in Jalali
    expect(html).toContain("۱۴۰۴/۱۰/۱۴"); // invoice date in Jalali
    expect(html).not.toContain("2026-01-05"); // no Gregorian leaks into the printed page
    expect(html).not.toContain("2026-01-04");
  });

  it("carries the correction policy and the document id; omits the VAT row when VAT is zero", () => {
    const html = buildPurchaseReceiptHtml(PURCHASE, LINES, formatMoney);
    expect(html).toContain("برگشت به تأمین‌کننده");
    expect(html).toContain(PURCHASE.id);
    expect(html).toContain("مالیات بر ارزش افزوده");
    const noVat = buildPurchaseReceiptHtml({ ...PURCHASE, vatAmount: "0" }, LINES, formatMoney);
    expect(noVat).not.toContain("مالیات بر ارزش افزوده");
  });

  it("is an RTL fa document", () => {
    const html = buildPurchaseReceiptHtml(PURCHASE, LINES, formatMoney);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
  });
});

describe("escapeHtml", () => {
  it("escapes the five special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
