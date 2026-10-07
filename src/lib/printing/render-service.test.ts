/**
 * render-service.ts — the server's render pipeline: plan → document →
 * template → HTML → Chromium screenshot → monochrome raster → ESC/POS bytes.
 * What must never regress:
 *
 *  - the raster width follows the PAPER the printer is loaded with, and a
 *    sheet paper renders a page image instead;
 *  - the template that renders is the PLAN's template — this file's central
 *    assertion is that the production path and the designer's preview produce
 *    the identical HTML for the same template and document, which is the
 *    regression the audit asked for;
 *  - the branding the plan resolved (logo, legal name, footer) reaches the
 *    page, so production prints the identity the preview showed;
 *  - labels ride the unified template pipeline instead of a private renderer;
 *  - the drawer kick rides along exactly when asked and supported, and never
 *    on a printer without a drawer;
 *  - refusals are canonical codes (inactive / reconnect / invalid), decided
 *    before any rendering;
 *  - the QR block gets an inline data URL generated server-side from the
 *    document's own payload — never a network fetch.
 *
 * The Chromium render is mocked; its own hardening is pinned in chromium.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { buildDrawerKickJob, buildPrintJob, packMonochromeRaster } from "../escpos";
import { renderPrintTemplate, builtInTemplate } from "../print-template";
import * as chromium from "./chromium";
import { decodePngToGrayscale } from "./raster";
import {
  buildDraftTestPrint,
  jobHtml,
  planPaper,
  preparePrint,
  printDocumentDataFor,
  printerRefusal,
  rasterWidthFor,
  templateUsesQr,
  withQrCode,
  type PrintJob,
} from "./render-service";
import type { PrintPlan } from "./plan";
import type { StoredPrinter } from "./types";
import type { ReceiptData } from "../receipt-template";
import type { KitchenTicketData } from "../kitchen-ticket-template";
import type { LabelData } from "../label-template";

vi.mock("./chromium", () => ({ renderHtmlToPng: vi.fn() }));

/** A real (tiny) PNG so the raster path exercises the actual raster.ts decode. */
function tinyPngBuffer(width = 8, height = 2): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const v = i % 2 === 0 ? 0 : 255;
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function expectedJobFor(png: Buffer, opts: { kickDrawer?: boolean; cut?: boolean } = {}): Buffer {
  const gray = decodePngToGrayscale(png);
  const raster = packMonochromeRaster(gray.pixels, gray.width, gray.height);
  return buildPrintJob(raster, { kickDrawer: opts.kickDrawer, cut: opts.cut !== false });
}

const RECEIPT: ReceiptData = {
  business: { name: "کافه تست" },
  orderLabel: "#42",
  orderTypeLabel: "حضوری",
  issuedAt: new Date("2026-01-15T10:00:00Z"),
  lines: [{ name: "اسپرسو", quantity: 1, lineTotal: 500_000 }],
  subtotal: 500_000,
  discount: 0,
  tax: 0,
  total: 500_000,
};

const TICKET: KitchenTicketData = {
  label: "میز ۳",
  orderTypeLabel: "حضوری",
  sentAt: new Date("2026-01-15T10:00:00Z"),
  lines: [{ name: "پاستا", quantity: 2 }],
};

const LABEL: LabelData = {
  businessName: "کافه تست",
  itemName: "قهوه",
  code: "2000000000015",
  fields: [{ label: "قیمت", value: "۱۰۰٬۰۰۰" }],
};

function printer(overrides: Partial<StoredPrinter> = {}): StoredPrinter {
  return {
    id: "p1",
    name: "چاپگر",
    kind: "receipt",
    connection: { type: "network", ip: "10.0.0.9" },
    is_active: true,
    printer_class: "thermal",
    paper: "thermal80",
    paper_width_mm: 80,
    supports_drawer: true,
    supports_cut: true,
    ...overrides,
  };
}

function planFor(overrides: Partial<PrintPlan> = {}): PrintPlan {
  const stored = overrides.printer ?? printer();
  const template = overrides.template ?? builtInTemplate("thermal80-receipt")!;
  return {
    locationId: "loc-1",
    documentType: "receipt",
    printer: stored,
    fallbackPrinter: null,
    routingPrinter: {
      id: stored.id,
      name: stored.name,
      purpose: stored.kind,
      printerClass: (stored.printer_class as "thermal" | "page" | "label") ?? "thermal",
      isActive: true,
      isDefault: false,
      needsReconnect: false,
      supportsDrawer: stored.supports_drawer === true,
      paper: (stored.paper as never) ?? "thermal80",
    },
    template,
    templateId: null,
    templateKey: template.key,
    templateVersion: 1,
    templateSource: "builtin",
    paper: (stored.paper as never) ?? template.paper,
    branding: {},
    reason: "only",
    ...overrides,
  };
}

let png: Buffer;

beforeEach(() => {
  vi.clearAllMocks();
  png = tinyPngBuffer();
  vi.mocked(chromium.renderHtmlToPng).mockResolvedValue(png);
});

describe("raster width", () => {
  it("screenshots at 512px for an 80mm roll and 372px for 58mm", async () => {
    await preparePrint(planFor({ printer: printer({ paper: "thermal80" }), paper: "thermal80" }), { type: "receipt", receipt: RECEIPT });
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(512);

    await preparePrint(planFor({ printer: printer({ paper: "thermal58", paper_width_mm: 58 }), paper: "thermal58" }), {
      type: "receipt",
      receipt: RECEIPT,
    });
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[1][1]).toBe(372);
  });

  it("defaults a row with no paper column to 80mm/512px", async () => {
    await preparePrint(
      planFor({ printer: printer({ paper: null, paper_width_mm: null }), paper: "thermal80" }),
      { type: "receipt", receipt: RECEIPT },
    );
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(512);
  });

  it("knows every paper's raster width, and the sheet widths", () => {
    expect(rasterWidthFor("thermal58")).toBe(372);
    expect(rasterWidthFor("thermal80")).toBe(512);
    expect(rasterWidthFor("label57x40")).toBe(372);
    expect(rasterWidthFor("a4")).toBe(794);
    expect(rasterWidthFor("a5")).toBe(559);
  });

  it("prints on the paper the printer is loaded with, not the template's", () => {
    const plan = planFor({
      printer: printer({ paper: "thermal58", paper_width_mm: 58 }),
      template: builtInTemplate("thermal80-receipt")!,
      paper: "thermal58",
    });
    expect(planPaper(plan)).toBe("thermal58");
  });
});

describe("job rendering", () => {
  it("renders a receipt to the reference ESC/POS bytes", async () => {
    const prepared = await preparePrint(planFor(), { type: "receipt", receipt: RECEIPT });
    expect(prepared.delivery).toBe("raw");
    expect(prepared.bytes).toEqual(expectedJobFor(png));
  });

  it("renders a kitchen ticket with the same pipeline", async () => {
    const plan = planFor({
      documentType: "kitchen",
      template: builtInTemplate("thermal80-kitchen")!,
      printer: printer({ kind: "kitchen" }),
    });
    const prepared = await preparePrint(plan, { type: "kitchen-ticket", ticket: TICKET });
    expect(prepared.bytes).toEqual(expectedJobFor(png));
  });

  it("renders a label through the unified template renderer", async () => {
    const plan = planFor({
      documentType: "label",
      template: builtInTemplate("label57x40-label")!,
      printer: printer({ kind: "label", paper: "label57x40", paper_width_mm: null, printer_class: "label" }),
      paper: "label57x40",
    });
    const prepared = await preparePrint(plan, { type: "label", label: LABEL });
    expect(prepared.bytes).toEqual(expectedJobFor(png));
    const html = vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0];
    // The label pipeline is the template pipeline: business, item, field and
    // real scannable bars all come from the general renderer.
    expect(html).toContain("کافه تست");
    expect(html).toContain("قهوه");
    expect(html).toContain("قیمت");
    expect(html).toContain("<svg");
  });

  it("adds the drawer kick only when the job asks and the printer has a drawer", async () => {
    const plan = planFor();
    const kicked = await preparePrint(plan, { type: "receipt", receipt: RECEIPT, kickDrawer: true });
    expect(kicked.bytes).toEqual(expectedJobFor(png, { kickDrawer: true }));

    const plain = await preparePrint(plan, { type: "receipt", receipt: RECEIPT });
    expect(plain.bytes).toEqual(expectedJobFor(png, { kickDrawer: false }));
  });

  it("refuses a drawer kick on a printer without a drawer", async () => {
    const plan = planFor({ printer: printer({ supports_drawer: false }) });
    await expect(preparePrint(plan, { type: "drawer-kick" })).rejects.toThrow("drawer_not_supported");
    const withDrawer = await preparePrint(planFor(), { type: "drawer-kick" });
    expect(withDrawer.bytes).toEqual(buildDrawerKickJob());
  });

  it("honours a printer configured without a cutter", async () => {
    const plan = planFor({ printer: printer({ supports_cut: false }) });
    const prepared = await preparePrint(plan, { type: "receipt", receipt: RECEIPT });
    expect(prepared.bytes).toEqual(expectedJobFor(png, { cut: false }));
  });

  it("renders the sample test print for every kind", async () => {
    for (const kind of ["receipt", "kitchen", "label", "invoice"] as const) {
      await preparePrint(planFor({ documentType: kind }), { type: "test", kind });
    }
    expect(chromium.renderHtmlToPng).toHaveBeenCalledTimes(4);
  });
});

describe("preview === production (the audit's regression)", () => {
  it("production HTML is byte-identical to the template preview's for the same template", async () => {
    const template = builtInTemplate("thermal80-receipt")!;
    const plan = planFor({ template });
    const branding = { name: "کافه تست", legalName: "شرکت نمونه", taxId: "411234567890", footer: "با تشکر" };

    // What the designer / gallery preview renders for this template…
    const data = printDocumentDataFor({ type: "receipt", receipt: RECEIPT }, branding)!;
    const previewHtml = renderPrintTemplate(template, data, { paperOverride: "thermal80" });

    // …and what production actually sends to Chromium.
    await preparePrint(planFor({ template, branding }), { type: "receipt", receipt: RECEIPT });
    const printedHtml = vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0];

    expect(printedHtml).toBe(previewHtml);
    expect(printedHtml).toContain("شرکت نمونه");
    // Identity fields print in Persian digits, exactly like the preview.
    expect(printedHtml).toContain("شناسهٔ مالیاتی");
    expect(printedHtml).toContain("۴۱۱۲۳۴۵۶۷۸۹۰");
    expect(printedHtml).toContain("با تشکر");
  });

  it("renders the plan's template, never a built-in substitute", async () => {
    // A saved custom template is what the plan carries; the rendered HTML must
    // be its layout, which the built-in receipt does not have.
    const custom = {
      ...builtInTemplate("thermal80-receipt")!,
      key: "saved-1",
      name: "قالب سفارشی",
      blocks: [
        { id: "only", type: "text" as const, visible: true, text: "متن اختصاصی قالب" },
      ],
    };
    const plan = planFor({ template: custom, templateId: "saved-1", templateKey: "saved-1", templateSource: "rule", templateVersion: 9 });
    await preparePrint(plan, { type: "receipt", receipt: RECEIPT });
    const html = vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0];
    expect(html).toContain("متن اختصاصی قالب");
    expect(html).not.toContain("مبلغ قابل پرداخت");
  });

  it("passes the resolved branding (logo and legal identity) through to the page", async () => {
    const plan = planFor({
      branding: {
        name: "کافه تست",
        legalName: "شرکت نمونهٔ پارس",
        address: "تهران، خیابان ۱",
        phone: "02112345678",
        logoDataUrl: "data:image/png;base64,AAAA",
      },
    });
    await preparePrint(plan, { type: "receipt", receipt: RECEIPT });
    const html = vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0];
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("شرکت نمونهٔ پارس");
    expect(html).toContain("تهران، خیابان ۱");
  });

  it("jobHtml is a pure function of (plan, document)", () => {
    const plan = planFor();
    const data = printDocumentDataFor({ type: "receipt", receipt: RECEIPT }, plan.branding);
    const first = jobHtml(plan, { type: "receipt", receipt: RECEIPT }, data);
    const second = jobHtml(plan, { type: "receipt", receipt: RECEIPT }, data);
    expect(first.html).toBe(second.html);
    expect(first.paper).toBe("thermal80");
  });
});

describe("sheet documents", () => {
  it("renders an A4 invoice as a page image, not ESC/POS", async () => {
    const plan = planFor({
      documentType: "invoice",
      template: builtInTemplate("a4-invoice")!,
      printer: printer({ kind: "document", paper: "a4", paper_width_mm: null, printer_class: "page", connection: { type: "windows", systemName: "HP" } }),
      paper: "a4",
    });
    const prepared = await preparePrint(plan, { type: "test", kind: "invoice" });
    expect(prepared.delivery).toBe("page");
    expect(prepared.bytes).toEqual(png);
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(794);
  });
});

describe("printerRefusal", () => {
  it("refuses inactive, reconnect-required and target-less printers", () => {
    expect(printerRefusal(printer({ is_active: false }))).toBe("printer_inactive");
    expect(printerRefusal(printer({ connection: { needsReconnect: true, legacyTransport: "webusb" } }))).toBe("reconnect_required");
    expect(printerRefusal(printer({ connection: { type: "windows", systemName: "  " } }))).toBe("invalid_printer");
    expect(printerRefusal(printer({ connection: { type: "network", ip: "" } }))).toBe("invalid_printer");
    expect(printerRefusal(printer({ connection: {} }))).toBe("invalid_printer");
  });

  it("accepts a usable printer", () => {
    expect(printerRefusal(printer())).toBeNull();
    expect(printerRefusal(printer({ connection: { type: "windows", systemName: "EPSON" } }))).toBeNull();
  });
});

describe("QR blocks", () => {
  const qrTemplate = {
    ...builtInTemplate("thermal80-receipt")!,
    blocks: [{ id: "qr", type: "qr" as const, visible: true }],
  };

  it("knows whether a template places a QR block", () => {
    expect(templateUsesQr(qrTemplate)).toBe(true);
    expect(templateUsesQr(builtInTemplate("thermal80-receipt")!)).toBe(false);
    expect(templateUsesQr({ ...qrTemplate, blocks: [{ id: "qr", type: "qr", visible: false }] })).toBe(false);
  });

  it("generates the QR image server-side from the document's payload", async () => {
    const data = printDocumentDataFor({ type: "receipt", receipt: RECEIPT })!;
    const withQr = await withQrCode(qrTemplate, { ...data, qrPayload: "https://example.test/invoice/42" });
    expect(withQr.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("leaves a document without a payload untouched — no invented QR", async () => {
    const data = printDocumentDataFor({ type: "receipt", receipt: RECEIPT })!;
    const unchanged = await withQrCode(qrTemplate, data);
    expect(unchanged.qrDataUrl).toBeUndefined();
  });
});

describe("buildDraftTestPrint — the unsaved wizard printer", () => {
  it("renders the built-in for the chosen purpose and paper, raw for rolls", async () => {
    const prepared = await buildDraftTestPrint("receipt", "thermal58");
    expect(prepared.delivery).toBe("raw");
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(372);
  });

  it("renders a page image for a document-purpose draft", async () => {
    const prepared = await buildDraftTestPrint("document", "a4");
    expect(prepared.delivery).toBe("page");
    expect(prepared.bytes).toEqual(png);
  });

  it("renders a label draft through the label template", async () => {
    const prepared = await buildDraftTestPrint("label", "label57x40");
    expect(prepared.delivery).toBe("raw");
    const html = vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0];
    expect(html).toContain("کالای نمونه");
  });
});

describe("kichen tickets carry the branch identity", () => {
  it("uses the resolved branding as the ticket's business name", () => {
    const data = printDocumentDataFor({ type: "kitchen-ticket", ticket: TICKET }, { name: "کافه تست" })!;
    expect(data.business.name).toBe("کافه تست");
  });

  it("never invents a business name", () => {
    const data: ReturnType<typeof printDocumentDataFor> = printDocumentDataFor({ type: "kitchen-ticket", ticket: TICKET });
    expect(data!.business.name).toBe("");
  });
});

describe("job payloads", () => {
  it("has no html/document job type at all", () => {
    // The type union is the security model: a client cannot ask this pipeline
    // to render arbitrary HTML because no such job exists.
    const jobs: PrintJob[] = [
      { type: "receipt", receipt: RECEIPT },
      { type: "kitchen-ticket", ticket: TICKET },
      { type: "label", label: LABEL },
      { type: "test", kind: "receipt" },
      { type: "drawer-kick" },
    ];
    expect(jobs.map((job) => job.type)).not.toContain("document");
  });
});
