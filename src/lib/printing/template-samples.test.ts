import { describe, expect, it } from "vitest";
import { INDUSTRIES } from "../industries";
import { BUILT_IN_TEMPLATES, renderPrintTemplate } from "../print-template";
import { samplePrintDocument } from "../print-sample";
import { isTemplateAvailable } from "./template-catalog";
import { sampleForTemplate } from "./template-samples";

const base = samplePrintDocument();
const CAFE_ONLY = ["قهوه", "کیک شکلاتی", "آب معدنی", "میز"];

function eligible(industry: (typeof INDUSTRIES)[number]) {
  return BUILT_IN_TEMPLATES.filter((template) => isTemplateAvailable(template, { industry, wooEnabled: true }));
}

describe("sampleForTemplate — one sample per business type", () => {
  it("never shows café data on another business type's documents", () => {
    for (const industry of INDUSTRIES) {
      if (industry === "food_service") continue;
      for (const template of eligible(industry)) {
        if (template.docType === "woo_invoice" || template.docType === "shipping_label") continue;
        const sample = sampleForTemplate(template, base, industry);
        const text = JSON.stringify([sample.subtitle, sample.lines, sample.note, sample.title]);
        for (const word of CAFE_ONLY) {
          expect(text, `${industry} / ${template.key} leaks «${word}»`).not.toContain(word);
        }
      }
    }
  });

  it("gives every label a product and barcode, and only non-specialist labels a sample price", () => {
    for (const industry of INDUSTRIES) {
      for (const template of eligible(industry).filter((t) => t.docType === "label")) {
        const sample = sampleForTemplate(template, base, industry);
        expect(sample.barcodeValue, `${industry} / ${template.key}`).toBeTruthy();
        expect(sample.title, `${industry} / ${template.key}`).not.toBe(base.title);
        expect(sample.labelFields?.some((field) => field.label === "قیمت نمونه"), `${industry} / ${template.key}`).toBe(industry !== "jewelry" && industry !== "watch");
        expect(sample.subtitle ?? "", `${industry} / ${template.key}`).not.toContain("میز");
      }
    }
  });

  it("shows a scannable code and native fields for a jewelry piece", () => {
    const template = BUILT_IN_TEMPLATES.find((item) => item.key === "label57x40-label")!;
    const sample = sampleForTemplate(template, base, "jewelry");
    expect(sample.barcodeValue).toBe("2000000000015");
    expect(sample.barcodeFormat).toBe("ean13");
    expect(sample.labelFields).toContainEqual({ label: "وزن", value: "۳٫۲ گرم خالص" });
  });

  it("does not suggest a model barcode identifies a particular watch serial", () => {
    const template = BUILT_IN_TEMPLATES.find((item) => item.key === "label57x40-label")!;
    const sample = sampleForTemplate(template, base, "watch");
    expect(sample.labelFields).toContainEqual({ label: "مدل", value: "REF-2042" });
    expect(sample.labelFields?.some((field) => field.label.includes("سریال"))).toBe(false);
    expect(sample.barcodeValue).toBe("2000000000015");
  });

  it("reconciles totals and payment rows with the lines on every receipt and invoice", () => {
    for (const industry of INDUSTRIES) {
      if (industry === "food_service") continue;
      for (const template of eligible(industry).filter((t) => t.docType === "receipt" || t.docType === "invoice")) {
        const sample = sampleForTemplate(template, base, industry);
        const lineSum = sample.lines.reduce((sum, line) => sum + line.lineTotal, 0);
        expect(sample.subtotal, `${industry} / ${template.key}`).toBe(lineSum);
        expect(sample.total, `${industry} / ${template.key}`).toBe(sample.subtotal - sample.discount + sample.tax);
        const paid = (sample.payments ?? []).reduce((sum, payment) => sum + payment.amount, 0);
        expect(paid, `${industry} / ${template.key}`).toBe(sample.total);
      }
    }
  });

  it("renders every eligible template for every business type without an empty body", () => {
    for (const industry of INDUSTRIES) {
      for (const template of eligible(industry)) {
        const html = renderPrintTemplate(template, sampleForTemplate(template, base, industry));
        expect(html, `${industry} / ${template.key}`).toContain("<section class=\"page");
        expect(html.length, `${industry} / ${template.key}`).toBeGreaterThan(2_000);
      }
    }
  });

  it("keeps the café's own sale for its receipts and invoices", () => {
    const receipt = BUILT_IN_TEMPLATES.find((template) => template.key === "thermal80-receipt")!;
    expect(sampleForTemplate(receipt, base, "food_service")).toBe(base);
  });
});
