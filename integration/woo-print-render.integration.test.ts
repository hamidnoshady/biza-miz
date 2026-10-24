/** Real Chromium, not a renderer mock. Set PRINT_CHROMIUM_PATH on Linux. */
import { afterAll, describe, expect, it } from "vitest";
import { builtInTemplate, PAPERS } from "../src/lib/print-template";
import { closeBrowser, pngHeightOf, renderHtmlToPng } from "../src/lib/printing/chromium";
import { jobHtml, preparePrint, rasterWidthFor } from "../src/lib/printing/render-service";
import { buildWooPrintDocument } from "../src/lib/printing/woo-order-print-data";
import { LOCATION, PRINTER, wooDetail } from "../src/lib/printing/__fixtures__/woo-order";
import type { PrintPlan } from "../src/lib/printing/plan";

const canRender = Boolean(process.env.PRINT_CHROMIUM_PATH) || process.platform === "win32";
function plan(key: string): PrintPlan {
  const template = builtInTemplate(key)!;
  return {
    locationId: LOCATION, documentType: template.docType, paper: template.paper, template,
    templateId: null, templateKey: key, templateVersion: 1, templateSource: "builtin", reason: "default", fallbackPrinter: null, branding: {},
    printer: { id: PRINTER, name: "Windows driver", kind: template.docType === "shipping_label" ? "label" : "document", is_active: true, connection: { type: "windows", systemName: "test" }, paper: template.paper, printer_class: template.docType === "shipping_label" ? "label" : "page" },
    routingPrinter: { id: PRINTER, name: "Windows driver", purpose: template.docType === "shipping_label" ? "label" : "document", printerClass: template.docType === "shipping_label" ? "label" : "page", paper: template.paper, isActive: true, isDefault: true, needsReconnect: false, supportsDrawer: false },
  };
}
afterAll(closeBrowser);

describe.skipIf(!canRender)("Woo preview/production RTL raster parity (real Chromium)", () => {
  it.each(["woo-shipping-100x150", "woo-shipping-a6", "woo-a4-invoice", "woo-a5-invoice"])("renders %s at its physical geometry through the same pipeline", async key => {
    const resolved = plan(key);
    const data = buildWooPrintDocument(wooDetail(), resolved.documentType as "shipping_label" | "woo_invoice", "toman");
    const job = { type: "woo-order" as const, data };
    const preview = jobHtml(resolved, job, data);
    // preparePrint lays the Woo 100x150 label out in CSS mm at 96dpi (not the 203dpi rasterPx) to keep barcode modules >= 2px (#935).
    const width = key === "woo-shipping-100x150" ? Math.round(PAPERS.label100x150.widthMm * 96 / 25.4) : rasterWidthFor(preview.paper);
    const png = await renderHtmlToPng(preview.html, width, { deviceScaleFactor: 2 });
    const actual = await preparePrint(resolved, job);
    expect(actual.delivery).toBe("page");
    expect(actual.bytes.equals(png)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(width * 2);
    expect(pngHeightOf(png)).toBeLessThanOrEqual(Math.ceil(PAPERS[preview.paper].heightMm! * 192 / 25.4) + 2);
    expect(preview.html).toContain('dir="rtl"');
    expect(preview.html).toContain("وصول تأیید نشده");
  });
  it("refuses an oversized shipping label instead of clipping an address onto a second package", async () => {
    const resolved = plan("woo-shipping-100x150");
    const data = buildWooPrintDocument(wooDetail(), "shipping_label", "toman");
    data.shipment!.address = "نشانی طولانی ".repeat(400);
    await expect(preparePrint(resolved, { type: "woo-order", data })).rejects.toThrow("shipping_label_overflow");
  });
});
