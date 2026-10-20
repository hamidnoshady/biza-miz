import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtInTemplate, parsePrintTemplate, renderPrintTemplate, templatePaperFitsDocType } from "../print-template";
import { buildWooPrintDocument } from "./woo-order-print-data";
import { code128Modules, code128Svg } from "./code128";
import { protectWooJob, restoreWooJob } from "./woo-snapshot-privacy";
import { documentTypesFor, parsePrintRequest, printEntityRef } from "./document-request";
import { printerAcceptsDocument, printerAcceptsTemplate, resolvePrinter } from "./routing";
import { CONNECTION, wooDetail } from "./__fixtures__/woo-order";
import type { RoutingPrinter } from "./routing";

beforeEach(() => vi.stubEnv("JWT_SECRET", "woo-print-tests-not-a-production-secret"));

const labelPrinter = (id: string, paper: "label100x150" | "a6" = "label100x150"): RoutingPrinter => ({ id, name: id, purpose: "label", printerClass: "label", paper, isActive: true, isDefault: false, needsReconnect: false, supportsDrawer: false });

describe("typed remote order intents", () => {
  it("parses identity and allowed overrides but discards browser prices, address and HTML", () => {
    const parsed = parsePrintRequest({ document: { kind: "woo-order-invoice", connectionId: CONNECTION, remoteId: "1042", html: "EVIL", total: 1, shipping: { address: "EVIL" } }, templateKey: "woo-a4-invoice" });
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("EVIL");
    if (!parsed.ok || parsed.source.kind !== "document") return;
    expect(documentTypesFor(parsed.source.document)).toEqual(["woo_invoice"]);
    expect(printEntityRef(parsed.source.document)).toBe(`woo:${CONNECTION}:1042`);
  });
  it.each([{ packageIndex: 3, packageCount: 2 }, { packageCount: 101 }, { packageCount: 0 }, { shipmentIndex: -1 }, { packageCount: 1.5 }])("refuses invalid shipment/package selection %j", selection => {
    expect(parsePrintRequest({ document: { kind: "woo-order-shipping-label", connectionId: CONNECTION, remoteId: "1042", ...selection } }).ok).toBe(false);
  });
});

describe("shared Woo documents without financial writes", () => {
  it("prints a remote-only COD order in source currency, with an actual order barcode and no carrier fiction", () => {
    const detail = wooDetail();
    const data = buildWooPrintDocument(detail, "shipping_label", "rial", { packageIndex: 2, packageCount: 3 });
    const html = renderPrintTemplate(builtInTemplate("woo-shipping-100x150")!, data);
    expect(html).toContain("سارا احمدی");
    expect(html).toContain("WC-1042");
    expect(html).toContain("code128");
    expect(html).toContain("بسته ۲ از ۳");
    expect(html).toContain("۲۴٫۴۵ USD");
    expect(html).toContain("وصول تأیید نشده");
    expect(html).not.toContain("رهگیری");
    expect(html).not.toContain("MUST_NOT_PRINT");
    expect(detail.localOrderId).toBeNull();
    expect(data.total).toBe(0); // the generic Rial fields are never the source of Woo prices
  });
  it("separates the Woo invoice from the accounting/POS template, including amounts and revision", () => {
    const data = buildWooPrintDocument(wooDetail(), "woo_invoice", "toman");
    const html = renderPrintTemplate(builtInTemplate("woo-a4-invoice")!, data);
    expect(html).toContain("پیش‌فاکتور سفارش آنلاین (غیرمالیاتی)");
    expect(html).toContain("۲۴٫۴۵ USD");
    expect(html).toContain("تخفیف (WELCOME)");
    expect(html).toContain("نسخه منبع");
    expect(html).toContain("قیمت واحد");
    expect(html).toContain("مالیات");
    expect(html).not.toContain("۲ تومان");
    expect(builtInTemplate("a4-invoice")!.docType).toBe("invoice");
  });
  it("uses actual selected tracking, not a fabricated order-number tracking code", () => {
    const data = buildWooPrintDocument(wooDetail({ shipments: [{ tracking_number: "1234", tracking_provider: "پست" }, { tracking_number: "5678", tracking_provider: "تیپاکس" }] }), "shipping_label", "toman", { shipmentIndex: 1 });
    const html = renderPrintTemplate(builtInTemplate("woo-shipping-a6")!, data);
    expect(data.shipment?.trackingId).toBe("5678");
    expect(html).toContain("رهگیری — تیپاکس");
    expect(data.barcodeValue).toBe("WC-1042");
  });
  it("forces action-level copies for Woo instead of hidden duplicate sheets", () => {
    const template = parsePrintTemplate({ ...builtInTemplate("woo-a4-invoice"), options: { copies: 2 } })!;
    expect(template.options.copies).toBe(1);
    expect(renderPrintTemplate({ ...template, options: { ...template.options, copies: 2 } }, buildWooPrintDocument(wooDetail(), "woo_invoice", "toman"))).not.toContain('class="page page-break"');
    expect(templatePaperFitsDocType("shipping_label", "a4")).toBe(false);
    expect(templatePaperFitsDocType("woo_invoice", "thermal80")).toBe(false);
  });
  it("escapes source names, recipient, instructions and tracking in the shared renderer", () => {
    const detail = wooDetail({ customer_note: '<script>alert("x")</script>' });
    const data = buildWooPrintDocument(detail, "shipping_label", "toman");
    data.shipment!.recipient = '<img src=x onerror="alert(1)">';
    const html = renderPrintTemplate(builtInTemplate("woo-shipping-100x150")!, data);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });
});

describe("scoped encrypted fallback snapshots", () => {
  it("keeps PII out of plaintext job history, binds tenant/branch/order and detects tampering", () => {
    const job = { type: "woo-order" as const, data: buildWooPrintDocument(wooDetail(), "shipping_label", "toman") };
    const sealed = protectWooJob(job, "business:branch:store:order");
    expect(JSON.stringify(sealed)).not.toContain("سارا");
    expect(JSON.stringify(sealed)).not.toContain("09121234567");
    expect(restoreWooJob(sealed, "business:branch:store:order")).toEqual(job);
    expect(() => restoreWooJob(sealed, "different-tenant")).toThrow();
    if (sealed.type !== "woo-order-sealed") throw new Error("not sealed");
    expect(() => restoreWooJob({ ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + "xxxx" }, "business:branch:store:order")).toThrow();
  });
});

describe("compatible store → branch → fallback routing", () => {
  const printers = [labelPrinter("store"), labelPrinter("branch"), labelPrinter("backup"), labelPrinter("a6", "a6")];
  const rules = [
    { documentType: "shipping_label" as const, connectionId: null, printerId: "branch", fallbackPrinterId: null, templateKey: null, templateId: null },
    { documentType: "shipping_label" as const, connectionId: CONNECTION, printerId: "store", fallbackPrinterId: "backup", templateKey: "woo-shipping-100x150", templateId: null },
  ];
  it("prioritizes explicit, store and branch without sharing stores' rules", () => {
    expect(resolvePrinter({ documentType: "shipping_label", connectionId: CONNECTION, printers, rules }).printer?.id).toBe("store");
    expect(resolvePrinter({ documentType: "shipping_label", connectionId: CONNECTION, requestedPrinterId: "branch", printers, rules }).printer?.id).toBe("branch");
    expect(resolvePrinter({ documentType: "shipping_label", connectionId: "other-store", printers, rules }).printer?.id).toBe("branch");
    expect(resolvePrinter({ documentType: "shipping_label", connectionId: CONNECTION, printers, rules, failedPrinterIds: ["store"] }).printer?.id).toBe("backup");
  });
  it("never treats inventory labels, a receipt roll or A4 as shipment paper; never rescales 100×150 onto A6", () => {
    expect(printerAcceptsDocument({ ...printers[0], paper: "label57x40" }, "shipping_label")).toBe(false);
    expect(printerAcceptsDocument({ ...printers[0], paper: "thermal80", printerClass: "thermal" }, "shipping_label")).toBe(false);
    expect(printerAcceptsDocument({ ...printers[0], paper: "a4", purpose: "document", printerClass: "page" }, "shipping_label")).toBe(false);
    expect(printerAcceptsTemplate(printers[3], "shipping_label", "label100x150")).toBe(false);
    expect(printerAcceptsTemplate(printers[3], "shipping_label", "a6")).toBe(true);
  });
});

describe("genuine Code128 with bounded physical module width", () => {
  it("uses quiet zones, checksum and stop bars; compresses even numeric carrier codes with subset C", () => {
    expect(code128Modules("WC-1042")).toMatch(/^0{10}11010010000/);
    expect(code128Modules("12345678901234567890")).toHaveLength(165);
    expect(code128Modules("12345678901234567890")).toMatch(/^0{10}11010011100/);
    expect(code128Svg("12345678901234567890")).toContain("viewBox");
  });
  it("omits bars rather than pretending an unsupported/too-long reference is scannable", () => {
    expect(code128Svg("شماره فارسی")).toBeNull();
    expect(code128Svg("A".repeat(64))).toBeNull();
    expect(code128Svg("WC-1042", 20)).toBeNull();
    expect(code128Svg("WC-1042", 80)).not.toBeNull();
  });
});
