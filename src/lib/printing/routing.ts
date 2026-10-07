/**
 * Printer routing, purpose compatibility, drawer policy and job states.
 * Pure: callers pass the branch's printers and rules; nothing here reads
 * the database or talks to hardware.
 *
 * This module owns the ONE compatibility matrix the whole product agrees on —
 * the same predicates validate a printer in the settings UI, at the settings
 * write boundary AND when a job is routed at the till, so a rule the operator
 * can save is always a rule that can print.
 */
import type { DocType, PaperKey } from "../print-template";
import { PAPERS } from "../print-template";
import type { PrinterClass, PrinterPurpose } from "./types";
import { isPrinterPurpose } from "./types";

export type { PrinterClass, PrinterPurpose };
export type { PrinterPurpose as RoutingPrinterPurpose };

export type PrintJobPhase = "created" | "preparing" | "routing" | "sending" | "handed_off" | "failed";

export const PRINT_PHASE_LABELS: Record<PrintJobPhase, string> = {
  created: "ایجاد درخواست چاپ",
  preparing: "آماده‌سازی سند",
  routing: "یافتن چاپگر",
  sending: "ارسال به چاپگر",
  handed_off: "به چاپگر ارسال شد",
  failed: "ارسال ناموفق",
};

/** A job left in `sending` for longer than this is a lost handoff, not a live one. */
export const SENDING_STALE_AFTER_SECONDS = 120;

export type WindowsQueueStatus =
  | "ready"
  | "available"
  | "offline"
  | "paused"
  | "error"
  | "needs_reconnection"
  | "inactive"
  | "unknown";

export const WINDOWS_STATUS_LABELS: Record<WindowsQueueStatus, string> = {
  ready: "آماده",
  available: "در ویندوز موجود است",
  offline: "خاموش",
  paused: "متوقف",
  error: "خطا",
  needs_reconnection: "نیاز به اتصال دوباره",
  inactive: "غیرفعال",
  unknown: "نامشخص",
};

/** Win32_Printer.PrinterStatus values that mean something we can say honestly. */
export function mapWindowsPrinterStatus(input: {
  printerStatus?: number | null;
  workOffline?: boolean | null;
  detectedError?: number | null;
}): WindowsQueueStatus {
  if (input.workOffline === true) return "offline";
  const code = input.printerStatus;
  if (code === 7) return "offline";
  if (code === 6) return "paused";
  if (code === 8 || (input.detectedError != null && input.detectedError > 0 && input.detectedError !== 2)) return "error";
  if (code === 3 || code === 4 || code === 5) return "ready";
  if (code == null && input.workOffline == null) return "unknown";
  return "available";
}

export interface RoutingPrinter {
  id: string;
  name: string;
  purpose: PrinterPurpose;
  printerClass: PrinterClass;
  isActive: boolean;
  isDefault: boolean;
  needsReconnect: boolean;
  supportsDrawer: boolean;
  paper: PaperKey | null;
}

export interface PrintRuleRef {
  documentType: DocType;
  printerId: string | null;
  fallbackPrinterId: string | null;
  templateKey: string | null;
  templateId: string | null;
}

export type ResolveReason =
  | "explicit"
  | "rule"
  | "default"
  | "last_used"
  | "only"
  | "fallback"
  /** The rule names a printer (or fallback) but neither can take the document right now. */
  | "unavailable"
  | "choose";

export interface ResolveResult {
  printer: RoutingPrinter | null;
  fallbackFrom: RoutingPrinter | null;
  templateKey: string | null;
  templateId: string | null;
  reason: ResolveReason;
}

const DOC_PURPOSE: Record<DocType, PrinterPurpose> = {
  receipt: "receipt",
  invoice: "document",
  kitchen: "kitchen",
  label: "label",
};

export function purposeForDocument(doc: DocType): PrinterPurpose {
  return DOC_PURPOSE[doc];
}

/** The document type a printer purpose serves — the inverse of `purposeForDocument`. */
export function documentTypeForPurpose(purpose: PrinterPurpose): DocType {
  return purpose === "document" ? "invoice" : purpose;
}

export function isDocType(value: unknown): value is DocType {
  return value === "receipt" || value === "invoice" || value === "kitchen" || value === "label";
}

/**
 * What kind of paper a purpose may be loaded with. This is the write-boundary
 * matrix: `receipt` and `kitchen` are thermal rolls, `document` is a cut
 * sheet on a Windows queue, `label` is a label roll (or a thermal roll used as
 * one).
 */
export const PAPERS_FOR_PURPOSE: Record<PrinterPurpose, PaperKey[]> = {
  receipt: ["thermal80", "thermal58"],
  kitchen: ["thermal80", "thermal58"],
  document: ["a4", "a5"],
  label: ["label57x40", "thermal80", "thermal58"],
};

export function paperAllowedForPurpose(purpose: PrinterPurpose, paper: PaperKey): boolean {
  return PAPERS_FOR_PURPOSE[purpose].includes(paper);
}

/** The paper a purpose gets when a caller names none — the wizard's default. */
export const PAPER_FOR_PURPOSE_DEFAULTS: Record<PrinterPurpose, PaperKey> = {
  receipt: "thermal80",
  kitchen: "thermal80",
  document: "a4",
  label: "label57x40",
};

/** The purpose each document type routes to — `purposeForDocument`, exported as data for the UI. */
export const PURPOSE_FOR_DOC_DEFAULTS: Record<DocType, PrinterPurpose> = DOC_PURPOSE;

/**
 * The printer class a purpose + paper pair produces. Derived, never stored by
 * hand: `label57x40` is a label printer, A4/A5 a page printer, everything
 * else a thermal roll.
 */
export function printerClassFor(purpose: PrinterPurpose, paper: PaperKey | null | undefined): PrinterClass {
  if (paper === "label57x40") return "label";
  if (purpose === "label") return "label";
  if (paper === "a4" || paper === "a5" || purpose === "document") return "page";
  return "thermal";
}

/**
 * The document types a printer class can physically carry.
 *
 *   thermal roll → receipt, kitchen, and label jobs (a label-purpose printer
 *                  loaded with a roll prints a sticker as a short raster);
 *   label roll   → label jobs only;
 *   cut sheet    → invoice only.
 *
 * Physical capability is only half the decision: the printer's PURPOSE must
 * match the document too (`printerAcceptsDocument`), which is what keeps a
 * customer receipt out of the kitchen.
 */
export const DOC_TYPES_FOR_CLASS: Record<PrinterClass, DocType[]> = {
  thermal: ["receipt", "kitchen", "label"],
  label: ["label"],
  page: ["invoice"],
};

export function classAcceptsDocument(printerClass: PrinterClass, doc: DocType): boolean {
  return DOC_TYPES_FOR_CLASS[printerClass].includes(doc);
}

/**
 * The template paper kinds a printer class can render: a thermal roll takes
 * thermal and label templates (a label template on a roll is just a short
 * raster), a label printer takes label templates, and a page printer takes
 * sheet templates only.
 */
const TEMPLATE_PAPER_KINDS_FOR_CLASS: Record<PrinterClass, Array<"thermal" | "sheet" | "label">> = {
  thermal: ["thermal", "label"],
  label: ["label"],
  page: ["sheet"],
};

/** Can this printer physically render a template designed for `paper`? */
export function printerAcceptsPaper(printerClass: PrinterClass, paper: PaperKey | null | undefined): boolean {
  if (!paper || !PAPERS[paper]) return false;
  return TEMPLATE_PAPER_KINDS_FOR_CLASS[printerClass].includes(PAPERS[paper].kind);
}

/**
 * A printer must not receive a document it cannot carry: a kitchen ticket
 * must not go to an A4 tray, an invoice must not go to a 58mm roll, a label
 * must not go to a page printer. Inactive and reconnect-required printers
 * are never "compatible" — those are routing problems, not compatibility
 * ones, and the caller answers them with their own error code.
 */
export function printerAcceptsDocument(printer: RoutingPrinter, doc: DocType): boolean {
  if (!printer.isActive || printer.needsReconnect) return false;
  if (printer.purpose !== purposeForDocument(doc)) return false;
  return classAcceptsDocument(printer.printerClass, doc);
}

export function resolvePrinter(input: {
  documentType: DocType;
  printers: RoutingPrinter[];
  rules?: PrintRuleRef[];
  requestedPrinterId?: string | null;
  lastUsedPrinterId?: string | null;
}): ResolveResult {
  const compatible = input.printers.filter((printer) => printerAcceptsDocument(printer, input.documentType));
  const rule = input.rules?.find((item) => item.documentType === input.documentType) ?? null;
  const templateKey = rule?.templateKey ?? null;
  const templateId = rule?.templateId ?? null;

  const byId = (id: string | null | undefined) => compatible.find((printer) => printer.id === id) ?? null;

  if (input.requestedPrinterId) {
    const explicit = byId(input.requestedPrinterId);
    if (explicit) return { printer: explicit, fallbackFrom: null, templateKey, templateId, reason: "explicit" };
  }

  const primary = byId(rule?.printerId);
  if (primary) return { printer: primary, fallbackFrom: null, templateKey, templateId, reason: "rule" };

  // The rule's printer exists but cannot take this document right now
  // (offline, inactive, re-paired, wrong paper): the fallback is exactly for
  // this, and the caller records `fallbackFrom` so history says why.
  const fallback = byId(rule?.fallbackPrinterId);
  if (rule?.printerId && fallback) {
    const named = input.printers.find((printer) => printer.id === rule.printerId) ?? null;
    return { printer: fallback, fallbackFrom: named, templateKey, templateId, reason: "fallback" };
  }

  // A rule that names a printer at all is authoritative: if neither it nor its
  // fallback is usable we do NOT quietly pick another printer behind the
  // operator's back — the till must say "this printer is unavailable".
  if (rule?.printerId || rule?.fallbackPrinterId) {
    return { printer: null, fallbackFrom: null, templateKey, templateId, reason: "unavailable" };
  }

  const defaults = compatible.filter((printer) => printer.isDefault);
  if (defaults.length === 1) return { printer: defaults[0], fallbackFrom: null, templateKey, templateId, reason: "default" };

  const last = byId(input.lastUsedPrinterId);
  if (last) return { printer: last, fallbackFrom: null, templateKey, templateId, reason: "last_used" };

  if (compatible.length === 1) return { printer: compatible[0], fallbackFrom: null, templateKey, templateId, reason: "only" };

  return { printer: null, fallbackFrom: null, templateKey, templateId, reason: "choose" };
}

/**
 * The drawer opens once, for a cash settlement, on a printer that has a
 * drawer. A reprint and a card payment do not pulse it.
 */
export function shouldOpenDrawer(input: {
  paymentIncludesCash: boolean;
  isReprint: boolean;
  supportsDrawer: boolean;
}): boolean {
  return input.paymentIncludesCash && !input.isReprint && input.supportsDrawer;
}

export function isSheetPaper(paper: string | null | undefined): boolean {
  return paper === "a4" || paper === "a5";
}

export function isLabelPaper(paper: string | null | undefined): boolean {
  return paper === "label57x40";
}

/** The paper a printer will feed, given the relational columns. Kept for callers holding plain data. */
export function paperOfPrinter(raw: { paper?: unknown; paper_width_mm?: unknown; paperWidthMm?: unknown }): PaperKey {
  if (typeof raw.paper === "string" && raw.paper in PAPERS) return raw.paper as PaperKey;
  const width = Number(raw.paper_width_mm ?? raw.paperWidthMm);
  if (width === 58) return "thermal58";
  return "thermal80";
}

export function isPrinterPurposeValue(value: unknown): value is PrinterPurpose {
  return isPrinterPurpose(value);
}
