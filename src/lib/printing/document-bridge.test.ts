import { describe, expect, it } from "vitest";
import { kitchenToPrintDocument, labelToPrintDocument, receiptToPrintDocument } from "./document-bridge";
import { builtInTemplate, renderPrintTemplate } from "../print-template";
import type { ReceiptData } from "../receipt-template";

const receipt: ReceiptData = {
  business: { name: "کافه نمونه", address: "خیابان ۱", phone: "021", footerMessage: "" },
  orderLabel: "#۱۲",
  orderTypeLabel: "حضوری",
  issuedAt: "2026-09-25T08:00:00.000Z",
  lines: [{ name: "لاته", quantity: 2, lineTotal: 200_000, modifiersLabel: "شیر بادام" }],
  subtotal: 200_000,
  discount: 0,
  tax: 0,
  total: 200_000,
};

describe("receiptToPrintDocument", () => {
  it("puts the configured footer and logo on the template document", () => {
    const doc = receiptToPrintDocument(receipt, {
      logoDataUrl: "data:image/png;base64,aaaa",
      footer: "با تشکر",
    });
    expect(doc.business.logoDataUrl).toContain("data:image/png");
    expect(doc.footer).toBe("با تشکر");
    expect(doc.lines[0].detail).toContain("شیر بادام");
    const html = renderPrintTemplate(builtInTemplate("thermal80-receipt")!, doc);
    expect(html).toContain("کافه نمونه");
    expect(html).toContain("با تشکر");
    expect(html).toContain("data:image/png;base64,aaaa");
    expect(html).not.toContain("2026-09-25");
  });

  it("prefers the receipt's own footer over the profile default", () => {
    const doc = receiptToPrintDocument(
      { ...receipt, business: { ...receipt.business, footerMessage: "سررسید خودتان" } },
      { footer: "پیش‌فرض" },
    );
    expect(doc.footer).toBe("سررسید خودتان");
  });
});

describe("labelToPrintDocument", () => {
  it("maps a shelf label onto the general template model", () => {
    const doc = labelToPrintDocument({
      businessName: "کافه تست",
      itemName: "قهوه",
      code: "2000000000015",
      fields: [{ label: "قیمت", value: "۱۰۰٬۰۰۰" }],
    });
    expect(doc.business.name).toBe("کافه تست");
    expect(doc.title).toBe("قهوه");
    expect(doc.barcodeValue).toBe("2000000000015");
    expect(doc.labelFields).toEqual([{ label: "قیمت", value: "۱۰۰٬۰۰۰" }]);
    const html = renderPrintTemplate(builtInTemplate("label57x40-label")!, doc);
    expect(html).toContain("قهوه");
    expect(html).toContain("قیمت");
    expect(html).toContain("<svg");
  });

  it("falls back to the resolved business name when the label carries none", () => {
    const doc = labelToPrintDocument(
      { businessName: "", itemName: "کالا", code: "1", fields: [] },
      { name: "کافه تست" },
    );
    expect(doc.business.name).toBe("کافه تست");
  });
});

describe("kitchenToPrintDocument", () => {
  it("renders a priceless kitchen ticket through the kitchen template", () => {
    const doc = kitchenToPrintDocument(
      {
        label: "میز ۳",
        orderTypeLabel: "حضوری",
        sentAt: "2026-09-25T08:00:00.000Z",
        lines: [{ name: "اسپرسو", quantity: 1, note: "بدون شکر" }],
      },
      { name: "کافه نمونه" },
    );
    const html = renderPrintTemplate(builtInTemplate("thermal80-kitchen")!, doc);
    expect(html).toContain("میز ۳");
    expect(html).toContain("اسپرسو");
    expect(html).toContain("بدون شکر");
    expect(html).not.toContain("تومان");
    expect(html).toContain("کافه نمونه");
  });
});
