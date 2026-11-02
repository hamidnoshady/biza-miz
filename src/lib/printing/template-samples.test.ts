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

  it("gives every label a product, a barcode and a price — also in a café", () => {
    for (const industry of INDUSTRIES) {
      for (const template of eligible(industry).filter((t) => t.docType === "label")) {
        const sample = sampleForTemplate(template, base, industry);
        expect(sample.barcodeValue, `${industry} / ${template.key}`).toBeTruthy();
        expect(sample.title, `${industry} / ${template.key}`).not.toBe(base.title);
        expect(sample.labelFields?.some((field) => field.label === "قیمت نمونه"), `${industry} / ${template.key}`).toBe(true);
        expect(sample.subtitle ?? "", `${industry} / ${template.key}`).not.toContain("میز");
      }
    }
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
