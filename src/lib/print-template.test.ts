import { describe, expect, it } from "vitest";
import {
  BUILT_IN_TEMPLATES,
  PAPERS,
  builtInTemplate,
  parsePrintTemplate,
  renderPrintTemplate,
  starterTemplate,
  type PrintTemplate,
} from "./print-template";
import { samplePrintDocument } from "./print-sample";

const data = samplePrintDocument();

describe("built-in templates", () => {
  it("ships a template for every document type the app prints", () => {
    // Receipt and kitchen on both roll widths, invoice on both sheets, and the
    // shelf label — one label template replaces the legacy private renderer.
    expect(BUILT_IN_TEMPLATES).toHaveLength(6);
    const papers = new Set(BUILT_IN_TEMPLATES.map((t) => t.paper));
    expect(papers).toContain("thermal58");
    expect(papers).toContain("thermal80");
    expect(papers).toContain("a4");
    expect(papers).toContain("a5");
    expect(papers).toContain("label57x40");
    const docTypes = new Set(BUILT_IN_TEMPLATES.map((t) => t.docType));
    expect([...docTypes].sort()).toEqual(["invoice", "kitchen", "label", "receipt"]);
  });

  it("gives every template a unique key and a Persian name", () => {
    const keys = BUILT_IN_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const template of BUILT_IN_TEMPLATES) {
      expect(template.name.trim()).not.toBe("");
      expect(/[A-Za-z]/.test(template.name.replace(/[A-Z0-9]/g, ""))).toBe(false);
    }
  });

  it("round-trips every built-in through the parser unchanged in shape", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      const parsed = parsePrintTemplate(template);
      expect(parsed, template.key).not.toBeNull();
      expect(parsed!.blocks).toHaveLength(template.blocks.length);
      expect(parsed!.paper).toBe(template.paper);
      expect(parsed!.docType).toBe(template.docType);
    }
  });

  it("renders every built-in into a complete document with the paper's page size", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      const html = renderPrintTemplate(template, data);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('dir="rtl"');
      expect(html).toContain(`width: ${PAPERS[template.paper].widthMm}mm`);
      if (template.docType === "label") {
        // A label is not a bill: it carries the branch, a title and bars.
        expect(html).toContain("کافه نمونه");
        expect(html).toContain("برچسب");
      } else {
        // Every bill-like template shows the items it was given.
        expect(html).toContain("قهوه اسپرسو دوبل");
      }
    }
  });

  it("prints a label template that a saved row can be seeded from", () => {
    const label = builtInTemplate("label57x40-label")!;
    const html = renderPrintTemplate(label, { ...data, title: "کالای نمونه", labelFields: [{ label: "قیمت", value: "۱۰۰٬۰۰۰" }] });
    expect(html).toContain("کالای نمونه");
    expect(html).toContain("۱۰۰٬۰۰۰");
  });
});

describe("renderPrintTemplate", () => {
  const receipt = builtInTemplate("thermal80-receipt")!;

  it("shows Persian digits and Toman amounts, never raw Gregorian dates", () => {
    const html = renderPrintTemplate(receipt, data);
    // ۴۰۲٬۰۰۰ تومان — the sample's 4,020,000 Rial grand total.
    expect(html).toContain("۴۰۲٬۰۰۰");
    expect(html).toContain("تومان");
    expect(html).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });

  it("omits the logo block entirely when no logo was uploaded", () => {
    expect(renderPrintTemplate(receipt, data)).not.toContain("<img src=\"data:image");
  });

  it("prints the uploaded logo at the block's height when one exists", () => {
    const html = renderPrintTemplate(receipt, {
      ...data,
      business: { ...data.business, logoDataUrl: "data:image/png;base64,AAAA" },
    });
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("height:14mm");
  });

  it("hides a block whose `visible` is false", () => {
    const hidden: PrintTemplate = {
      ...receipt,
      blocks: receipt.blocks.map((b) => (b.type === "totals" ? { ...b, visible: false } : b)),
    };
    expect(renderPrintTemplate(hidden, data)).not.toContain("مبلغ قابل پرداخت");
  });

  it("draws a ruled table with one column per configured field on a sheet", () => {
    const invoice = builtInTemplate("a4-invoice")!;
    const html = renderPrintTemplate(invoice, data);
    expect(html).toContain('<table class="items ruled">');
    expect(html).toContain("شرح کالا / خدمات");
    expect(html).toContain("قیمت واحد");
    // The row column numbers the lines in Persian digits.
    expect(html).toContain(">۱</td>");
  });

  it("prints the customer's economic code on an invoice and nothing when absent", () => {
    const invoice = builtInTemplate("a4-invoice")!;
    expect(renderPrintTemplate(invoice, data)).toContain("کد اقتصادی");
    expect(renderPrintTemplate(invoice, { ...data, customer: null })).not.toContain("کد اقتصادی");
  });

  it("emits a second page with its caption when the template asks for two copies", () => {
    const invoice = builtInTemplate("a4-invoice")!;
    const twoUp: PrintTemplate = { ...invoice, options: { ...invoice.options, copies: 2 } };
    const html = renderPrintTemplate(twoUp, data);
    expect(html).toContain('class="page page-break"');
    expect(html).toContain("نسخهٔ خریدار");
    expect(html).toContain("نسخهٔ فروشنده");
  });

  it("never doubles a thermal receipt onto a second page (a roll has no pages)", () => {
    const twoUp: PrintTemplate = { ...receipt, options: { ...receipt.options, copies: 2 } };
    expect(renderPrintTemplate(twoUp, data)).not.toContain('class="page page-break"');
  });

  it("prints at the printer's real width when the loaded paper differs from the design", () => {
    const html = renderPrintTemplate(receipt, data, { paperOverride: "thermal58" });
    expect(html).toContain("width: 58mm");
  });

  it("escapes item names so a document can never inject markup", () => {
    const html = renderPrintTemplate(receipt, {
      ...data,
      lines: [{ name: "<script>alert(1)</script>", quantity: 1, lineTotal: 1000 }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("prints one row per tender when the bill was split", () => {
    const html = renderPrintTemplate(receipt, data);
    expect(html).toContain("نقدی");
    expect(html).toContain("کارت‌خوان");
  });

  it("keeps the kitchen ticket priceless", () => {
    const kitchen = builtInTemplate("thermal80-kitchen")!;
    const html = renderPrintTemplate(kitchen, data);
    expect(html).not.toContain("مبلغ قابل پرداخت");
    expect(html).toContain("قهوه اسپرسو دوبل");
  });
});

describe("parsePrintTemplate", () => {
  const valid = {
    name: "قالب من",
    docType: "receipt",
    paper: "thermal80",
    options: { fontScale: 1.1 },
    blocks: [{ id: "a", type: "businessName", visible: true }],
  };

  it("accepts a minimal template and fills the missing options with defaults", () => {
    const parsed = parsePrintTemplate(valid)!;
    expect(parsed.options.fontScale).toBe(1.1);
    expect(parsed.options.lineHeight).toBe(1.5);
    expect(parsed.options.copies).toBe(1);
  });

  it("rejects an unknown paper, an unknown block type and an empty name", () => {
    expect(parsePrintTemplate({ ...valid, paper: "a3" })).toBeNull();
    expect(parsePrintTemplate({ ...valid, blocks: [{ type: "iframe" }] })).toBeNull();
    expect(parsePrintTemplate({ ...valid, name: "   " })).toBeNull();
    expect(parsePrintTemplate({ ...valid, blocks: [] })).toBeNull();
    expect(parsePrintTemplate(null)).toBeNull();
  });

  it("drops item columns the renderer does not know", () => {
    const parsed = parsePrintTemplate({
      ...valid,
      blocks: [{ id: "i", type: "items", columns: ["name", "profitMargin", "total"] }],
    })!;
    expect(parsed.blocks[0].columns).toEqual(["name", "total"]);
  });

  it("clamps a font scale or margin a hand-written payload pushed out of range", () => {
    const parsed = parsePrintTemplate({ ...valid, options: { fontScale: 99, marginMm: -5 } })!;
    expect(parsed.options.fontScale).toBe(2);
    expect(parsed.options.marginMm).toBe(0);
  });

  it("truncates a custom text block rather than storing an essay", () => {
    const parsed = parsePrintTemplate({
      ...valid,
      blocks: [{ id: "t", type: "text", text: "الف".repeat(1000) }],
    })!;
    expect(parsed.blocks[0].text!.length).toBe(400);
  });
});

describe("starterTemplate", () => {
  it("starts a new A4 invoice from the built-in A4 invoice, with no key", () => {
    const draft = starterTemplate("a4", "invoice");
    expect(draft.key).toBe("");
    expect(draft.paper).toBe("a4");
    expect(draft.docType).toBe("invoice");
    expect(draft.blocks.length).toBeGreaterThan(3);
  });

  it("still produces a usable draft for a paper/type pair no built-in covers", () => {
    const draft = starterTemplate("label57x40", "label");
    expect(draft.paper).toBe("label57x40");
    expect(draft.docType).toBe("label");
    expect(parsePrintTemplate({ ...draft, name: "برچسب من" })).not.toBeNull();
  });

  it("does not alias the built-in it copied (editing a draft cannot corrupt a preset)", () => {
    const draft = starterTemplate("a4", "invoice");
    draft.blocks[0].visible = false;
    expect(builtInTemplate("a4-invoice")!.blocks[0].visible).toBe(true);
  });
});
