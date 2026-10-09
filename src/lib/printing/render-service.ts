/**
 * The server half of thermal printing: render a resolved print plan into the
 * canonical bytes for its printer. Server-only (DB + Chromium); it never
 * reaches restaurant hardware — the bytes go back to the browser, which
 * delivers them through the local Cafe POS connector. That split is the
 * architecture: the app server owns rendering (Persian/RTL shaping needs its
 * Chromium pipeline), the cashier's machine owns the printers.
 *
 * **One renderer.** `jobHtml()` is the only place a print document is built,
 * and it renders the plan's template — the same `renderPrintTemplate` the
 * designer preview calls, with the same branding the plan resolved — so
 * "what the preview showed" and "what the printer produced" are the same
 * function of the same inputs. The old `templateFor(printer, …)` (which read
 * a template key out of the printer's jsonb and silently substituted a
 * built-in) is gone: the plan decides, this module renders.
 */
import QRCode from "qrcode";
import { buildDrawerKickJob, buildPrintJob, packMonochromeRaster } from "../escpos";
import type { KitchenTicketData } from "../kitchen-ticket-template";
import type { LabelData } from "../label-template";
import {
  PAPERS,
  renderPrintTemplate,
  type DocType,
  type PaperKey,
  type PrintDocumentData,
  type PrintBusinessInfo,
} from "../print-template";
import { PAPER_WIDTH_PRESETS, type ReceiptData } from "../receipt-template";
import { samplePrintDocument } from "../print-sample";
import type { PrintPlan } from "./plan";
import {
  kitchenToPrintDocument,
  labelToPrintDocument,
  receiptToPrintDocument,
  type PrintBranding,
} from "./document-bridge";
import { printerSupportsCut, printerSupportsDrawer, resolvedPaperOf, type PrinterPurpose, type StoredPrinter } from "./types";
import { decodePngToGrayscale } from "./raster";
import { renderHtmlToPng } from "./chromium";

export type { PrintBranding } from "./document-bridge";

/** The sample content a test print prints — a real receipt/ticket, real shaping. */
const SAMPLE_RECEIPT: ReceiptData = {
  business: { name: "کافه نمونه", footerMessage: "این یک چاپ آزمایشی است" },
  orderLabel: "#0",
  orderTypeLabel: "چاپ آزمایشی",
  issuedAt: new Date(),
  lines: [{ name: "آیتم نمونه", quantity: 1, lineTotal: 100_000 }],
  subtotal: 100_000,
  discount: 0,
  tax: 0,
  total: 100_000,
};

const SAMPLE_TICKET: KitchenTicketData = {
  label: "چاپ آزمایشی",
  orderTypeLabel: "آزمایشی",
  sentAt: new Date(),
  lines: [{ name: "آیتم نمونه", quantity: 1 }],
};

const SAMPLE_LABEL: LabelData = {
  businessName: "",
  itemName: "کالای نمونه",
  code: "2000000000017",
  fields: [{ label: "قیمت", value: "۱۰۰٬۰۰۰" }],
};

/**
 * A print job, described by data rather than by rendered output. There is
 * deliberately no `document`/`html` variant: the browser may not hand the
 * server HTML to render (see POST /api/printing/print), so every job is one
 * of the documents the product itself builds.
 */
export type PrintJob =
  | { type: "receipt"; receipt: ReceiptData; kickDrawer?: boolean }
  | { type: "kitchen-ticket"; ticket: KitchenTicketData }
  | { type: "label"; label: LabelData }
  | { type: "test"; kind: DocType }
  | { type: "drawer-kick" };

export interface PreparedPrint {
  /** `raw` is ESC/POS. `page` is a PNG the Windows driver prints without a dialog. */
  delivery: "raw" | "page";
  bytes: Buffer;
}

/** Sheet papers have no ESC/POS raster width; they still rasterise to a page image. */
const SHEET_RASTER_PX: Record<string, number> = { a4: 794, a5: 559 };

/**
 * The canonical reason a loaded printer cannot print, or null when it can.
 * Reads the relational capability columns; a legacy row that still needs
 * re-pairing is refused before any rendering happens.
 */
export function printerRefusal(printer: StoredPrinter): "printer_inactive" | "reconnect_required" | "invalid_printer" | null {
  if (printer.is_active === false) return "printer_inactive";
  const connection = printer.connection ?? {};
  if (connection.needsReconnect === true) return "reconnect_required";
  if (connection.type === "windows" && (!connection.systemName || String(connection.systemName).trim() === "")) {
    return "invalid_printer";
  }
  if (connection.type === "network" && (!connection.ip || String(connection.ip).trim() === "")) return "invalid_printer";
  if (connection.type !== "windows" && connection.type !== "network") return "invalid_printer";
  return null;
}

/** The paper a plan prints on: what the printer is loaded with, else the template's. */
export function planPaper(plan: PrintPlan): PaperKey {
  const printerPaper = resolvedPaperOf({ ...plan.printer, kind: plan.printer.kind });
  if (plan.printer.paper == null && plan.printer.paper_width_mm == null) return plan.template.paper;
  return printerPaper;
}

/** Raster width for a job: the paper's own preset, else the roll/px default. */
export function rasterWidthFor(paper: PaperKey): number {
  if (PAPERS[paper]?.rasterPx) return PAPERS[paper].rasterPx!;
  if (paper in SHEET_RASTER_PX) return SHEET_RASTER_PX[paper];
  return PAPER_WIDTH_PRESETS[80];
}

/**
 * The document a job prints, in the general template model. Pure, so a test
 * can prove the preview and the production path build the same document.
 */
export function printDocumentDataFor(job: PrintJob, branding: PrintBranding = {}): PrintDocumentData | null {
  switch (job.type) {
    case "receipt":
      return receiptToPrintDocument(job.receipt, branding);
    case "kitchen-ticket":
      return kitchenToPrintDocument(job.ticket, branding);
    case "label":
      return labelToPrintDocument(job.label, branding);
    case "test":
      switch (job.kind) {
        case "kitchen":
          return kitchenToPrintDocument(SAMPLE_TICKET, branding);
        case "label":
          return labelToPrintDocument({ ...SAMPLE_LABEL, businessName: branding.name ?? "" }, branding);
        case "invoice":
          return samplePrintDocument(sampleBusiness(branding), { title: "چاپ آزمایشی", subtitle: null, note: null });
        default:
          return receiptToPrintDocument(SAMPLE_RECEIPT, branding);
      }
    case "drawer-kick":
      return null;
  }
}

/** A branding's non-null fields, in the shape the sample document builder takes. */
function sampleBusiness(branding: PrintBranding): Partial<PrintBusinessInfo> {
  return {
    ...(branding.name ? { name: branding.name } : {}),
    ...(branding.legalName ? { legalName: branding.legalName } : {}),
    ...(branding.address ? { address: branding.address } : {}),
    ...(branding.phone ? { phone: branding.phone } : {}),
    ...(branding.taxId ? { taxId: branding.taxId } : {}),
    ...(branding.email ? { email: branding.email } : {}),
    ...(branding.website ? { website: branding.website } : {}),
  };
}

/** Does the template place a QR image the document has no data for? */
export function templateUsesQr(template: PrintPlan["template"]): boolean {
  return template.blocks.some((block) => block.visible && block.type === "qr");
}

/**
 * Fill in an inline QR image for a document whose template places a QR block.
 * Generated here — server-side, from the document's own `qrPayload` — rather
 * than accepted from the browser, so a template can never ask Chromium to
 * fetch an image from the network.
 */
export async function withQrCode(
  template: PrintPlan["template"],
  data: PrintDocumentData,
): Promise<PrintDocumentData> {
  if (data.qrDataUrl || !data.qrPayload || !templateUsesQr(template)) return data;
  try {
    const qrDataUrl = await QRCode.toDataURL(data.qrPayload, { errorCorrectionLevel: "M", margin: 1, width: 240 });
    return { ...data, qrDataUrl };
  } catch {
    // A QR that cannot be drawn must never stop a receipt.
    return data;
  }
}

/**
 * The HTML one job prints, plus the paper it prints on and whether it kicks
 * the drawer. Pure apart from nothing at all — this is the function the
 * preview-vs-production regression test compares against.
 */
export function jobHtml(
  plan: PrintPlan,
  job: PrintJob,
  data: PrintDocumentData | null,
): { html: string; paper: PaperKey; kickDrawer: boolean } {
  if (job.type === "drawer-kick" || !data) return { html: "", paper: planPaper(plan), kickDrawer: false };
  const paper = planPaper(plan);
  return {
    html: renderPrintTemplate(plan.template, data, { paperOverride: paper }),
    paper,
    kickDrawer: job.type === "receipt" && job.kickDrawer === true,
  };
}

/** ESC/POS raster job bytes: screenshot the HTML and pack it — no sending, ever. */
async function rasterJobBytes(plan: PrintPlan, html: string, paper: PaperKey, kickDrawer: boolean): Promise<Buffer> {
  const png = await renderHtmlToPng(html, rasterWidthFor(paper));
  const gray = decodePngToGrayscale(png);
  const raster = packMonochromeRaster(gray.pixels, gray.width, gray.height);
  return buildPrintJob(raster, { kickDrawer, cut: printerSupportsCut(plan.printer) });
}

/**
 * Render a job to its canonical bytes for the plan's printer: template → HTML
 * (with the Persian font embedded) → Chromium screenshot → monochrome raster →
 * `GS v 0` commands, plus feed/cut and — for a printer configured with
 * «بازکردن کشوی پول» — the drawer kick. Sheet papers become a page image the
 * Windows driver prints without a dialog.
 */
export async function preparePrint(plan: PrintPlan, job: PrintJob): Promise<PreparedPrint> {
  if (job.type === "drawer-kick") {
    if (!printerSupportsDrawer(plan.printer)) throw new Error("drawer_not_supported");
    return { delivery: "raw", bytes: buildDrawerKickJob() };
  }
  const data = printDocumentDataFor(job, plan.branding);
  if (!data) throw new Error("unsupported_job");
  const rendered = jobHtml(plan, job, await withQrCode(plan.template, data));
  if (PAPERS[rendered.paper].kind === "sheet") {
    const png = await renderHtmlToPng(rendered.html, rasterWidthFor(rendered.paper));
    return { delivery: "page", bytes: png };
  }
  return { delivery: "raw", bytes: await rasterJobBytes(plan, rendered.html, rendered.paper, rendered.kickDrawer) };
}

/**
 * The unsaved-draft test print for the add-printer wizard: the same template
 * pipeline and the same sample documents, for a printer that has no row yet.
 * The draft plan carries no branding (nothing about it is authenticated) and
 * resolves the built-in template for the chosen purpose and paper — exactly
 * what the saved printer will print once the wizard finishes.
 */
export async function buildDraftTestPrint(
  purpose: PrinterPurpose,
  paper: PaperKey,
): Promise<PreparedPrint> {
  const { builtInFor } = await import("./plan");
  const { documentTypeForPurpose } = await import("./routing");
  const kind = documentTypeForPurpose(purpose);
  const draftPrinter: StoredPrinter = {
    id: "draft",
    name: "draft",
    kind: purpose,
    is_active: true,
    connection: { type: "network", ip: "0.0.0.0" },
    paper,
    paper_width_mm: paper === "thermal58" ? 58 : paper === "thermal80" ? 80 : null,
    supports_cut: true,
  };
  const template = builtInFor(kind, paper);
  const plan: PrintPlan = {
    locationId: "draft",
    documentType: kind,
    printer: draftPrinter,
    fallbackPrinter: null,
    routingPrinter: {
      id: "draft",
      name: "draft",
      purpose,
      printerClass: PAPERS[paper].kind === "sheet" ? "page" : PAPERS[paper].kind === "label" ? "label" : "thermal",
      isActive: true,
      isDefault: false,
      needsReconnect: false,
      supportsDrawer: false,
      paper,
    },
    template,
    templateId: null,
    templateKey: template.key,
    templateVersion: 1,
    templateSource: "builtin",
    paper,
    branding: { name: "" },
    reason: "only",
  };
  return preparePrint(plan, { type: "test", kind });
}
