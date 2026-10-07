/**
 * The printing/invoice design system — paper sizes, the template model, the
 * five built-in templates, and one pure renderer that turns any of them into a
 * standalone HTML document.
 *
 * Why a model instead of more hand-written templates: `receipt-template.ts`
 * and `kitchen-ticket-template.ts` each hard-code one layout for one paper
 * width. Every request after them ("put the logo on it", "we print A4 invoices
 * for company customers", "hide the cashier line") forked another template.
 * Here a template is *data*: a paper, a handful of options and an ordered list
 * of blocks. The five presets below are the same data — nothing about a
 * built-in template is privileged over one a shop designs in the browser — so
 * the designer screen, the preview, the print agent and the stored rows all
 * speak one language and are tested as strings.
 *
 * Pure and dependency-free (no DB, no `next`, no React) exactly like the two
 * templates it generalises, so the print agent, a route handler and the
 * browser can all import it.
 */
import { ean13Modules } from "./barcode";
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";
import { formatMoney, type MoneyUnit, type Rial } from "./money";

/* ────────────────────────────── paper ────────────────────────────── */

export type PaperKey = "thermal58" | "thermal80" | "a4" | "a5" | "label57x40";

export interface PaperSpec {
  key: PaperKey;
  label: string;
  /** How this paper is fed: continuous thermal roll, a cut sheet, or a label. */
  kind: "thermal" | "sheet" | "label";
  widthMm: number;
  /** Cut sheets and labels have a fixed height; a roll does not. */
  heightMm: number | null;
  /**
   * Raster width for the ESC/POS path (printing/chromium.ts screenshots at
   * this pixel width). Only thermal/label rolls take that path; a sheet goes
   * to the browser's own print dialog at real mm.
   */
  rasterPx?: number;
  /** Default page margin, in mm. */
  marginMm: number;
  /** One line of what this paper is for, shown in the paper picker. */
  hint: string;
}

export const PAPERS: Record<PaperKey, PaperSpec> = {
  thermal58: {
    key: "thermal58",
    label: "فیش حرارتی ۵۸ میلی‌متری",
    kind: "thermal",
    widthMm: 58,
    heightMm: null,
    rasterPx: 372,
    marginMm: 2,
    hint: "چاپگرهای کوچک صندوق و دستگاه‌های سیار",
  },
  thermal80: {
    key: "thermal80",
    label: "فیش حرارتی ۸۰ میلی‌متری",
    kind: "thermal",
    widthMm: 80,
    heightMm: null,
    rasterPx: 512,
    marginMm: 3,
    hint: "رایج‌ترین چاپگر رسید کافه و رستوران",
  },
  a4: {
    key: "a4",
    label: "کاغذ A4",
    kind: "sheet",
    widthMm: 210,
    heightMm: 297,
    marginMm: 12,
    hint: "فاکتور رسمی روی چاپگر لیزری یا جوهرافشان",
  },
  a5: {
    key: "a5",
    label: "کاغذ A5",
    kind: "sheet",
    widthMm: 148,
    heightMm: 210,
    marginMm: 8,
    hint: "فاکتور نصف‌برگی، پیک و تحویل",
  },
  label57x40: {
    key: "label57x40",
    label: "برچسب ۵۷×۴۰ میلی‌متر",
    kind: "label",
    widthMm: 57,
    heightMm: 40,
    rasterPx: 372,
    marginMm: 2,
    hint: "برچسب قیمت و بارکد روی چاپگر لیبل‌زن",
  },
};

export const PAPER_KEYS = Object.keys(PAPERS) as PaperKey[];

export function isPaperKey(value: unknown): value is PaperKey {
  return typeof value === "string" && value in PAPERS;
}

/* ───────────────────────────── the model ─────────────────────────── */

export type DocType = "receipt" | "invoice" | "kitchen" | "label";

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  receipt: "رسید فروش",
  invoice: "فاکتور",
  kitchen: "سفارش آشپزخانه",
  label: "برچسب",
};

export type BlockType =
  | "logo"
  | "businessName"
  | "businessMeta"
  | "title"
  | "meta"
  | "customer"
  | "items"
  | "totals"
  | "payments"
  | "note"
  | "text"
  | "qr"
  | "barcode"
  | "labelFields"
  | "signature"
  | "divider"
  | "spacer";

export const BLOCK_LABELS: Record<BlockType, string> = {
  logo: "لوگو",
  businessName: "نام کسب‌وکار",
  businessMeta: "آدرس و تماس",
  title: "عنوان سند",
  meta: "شمارهٔ سند و تاریخ",
  customer: "مشخصات مشتری",
  items: "جدول اقلام",
  totals: "جمع‌ها و مالیات",
  payments: "پرداخت‌ها",
  note: "یادداشت سند",
  text: "متن دلخواه",
  qr: "کد QR",
  barcode: "بارکد / شمارهٔ سند",
  labelFields: "مشخصات برچسب",
  signature: "محل امضا",
  divider: "خط جداکننده",
  spacer: "فاصلهٔ خالی",
};

/**
 * Blocks the designer must not offer, with the reason it must not.
 *
 * `qr`: the renderer only draws a QR from a document-supplied payload
 * (`withQrCode`), and nothing in the product produces one yet. The block type
 * stays in the model — an existing template may carry it, and the renderer
 * honours it the day a payload exists — but it is not a choice a person can
 * make from a control that would print nothing.
 */
export const HIDDEN_BLOCK_TYPES: BlockType[] = ["qr"];

/** Which columns the items table prints, in display order. */
export type ItemColumn = "row" | "name" | "qty" | "unitPrice" | "discount" | "tax" | "total";

export const ITEM_COLUMN_LABELS: Record<ItemColumn, string> = {
  row: "ردیف",
  name: "شرح کالا / خدمات",
  qty: "تعداد",
  unitPrice: "قیمت واحد",
  discount: "تخفیف",
  tax: "مالیات",
  total: "مبلغ کل",
};

/**
 * Block types the designer may add. `qr` is deliberately absent — see
 * `HIDDEN_BLOCK_TYPES` below: no document supplies a QR payload yet, and
 * offering a control the renderer would silently drop is the exact drift this
 * model exists to prevent. The pipeline is ready for it: the server generates
 * the QR image itself from the document's `qrPayload` (`withQrCode` in
 * printing/render-service.ts), so re-enabling the control is a one-line change
 * once a payload source is configured.
 */
export type Align = "start" | "center" | "end";
export type TextSize = "xs" | "sm" | "md" | "lg" | "xl";

export interface TemplateBlock {
  /** Stable within a template; the designer reorders by id. */
  id: string;
  type: BlockType;
  visible: boolean;
  align?: Align;
  size?: TextSize;
  bold?: boolean;
  /** `text` blocks (and the label under a signature line). */
  text?: string;
  /** `spacer` height, in mm. */
  heightMm?: number;
  /** `items` — which columns to print. */
  columns?: ItemColumn[];
  /** `items` — draw a ruled table (sheets) instead of receipt-style rows. */
  ruled?: boolean;
  /** `logo` — printed height, in mm. */
  logoHeightMm?: number;
}

export interface TemplateOptions {
  /** Multiplies every font size; 1 is the paper's natural size. */
  fontScale: number;
  /** Line height multiplier — tighter fits more rows on a roll. */
  lineHeight: number;
  /** Page margin in mm; defaults to the paper's own. */
  marginMm: number;
  /** Ink weight: thermal heads print `bold` far more legibly than hairlines. */
  bodyWeight: 400 | 500 | 600 | 700;
  /** Print the amount unit («تومان») next to the grand total. */
  showUnit: boolean;
  /** Repeat the document on two copies («نسخهٔ مشتری» / «نسخهٔ فروشنده»). */
  copies: 1 | 2;
  /** Only for sheets: the second copy's caption. */
  copyLabels?: [string, string];
}

export interface PrintTemplate {
  /** Built-ins use their preset key; a saved template uses its row id. */
  key: string;
  name: string;
  docType: DocType;
  paper: PaperKey;
  options: TemplateOptions;
  blocks: TemplateBlock[];
}

export const DEFAULT_OPTIONS: TemplateOptions = {
  fontScale: 1,
  lineHeight: 1.5,
  marginMm: 3,
  bodyWeight: 500,
  showUnit: true,
  copies: 1,
};

/* ───────────────────────────── the data ──────────────────────────── */

export interface PrintBusinessInfo {
  name: string;
  legalName?: string | null;
  address?: string | null;
  phone?: string | null;
  taxId?: string | null;
  email?: string | null;
  website?: string | null;
  /**
   * The uploaded logo as a `data:` URL. A data URL rather than a link on
   * purpose: the print agent renders in a browser with no session and often no
   * route to the app server, so anything the page needs must travel with it.
   */
  logoDataUrl?: string | null;
}

export interface PrintParty {
  name: string;
  phone?: string | null;
  address?: string | null;
  taxId?: string | null;
  economicCode?: string | null;
}

export interface PrintLine {
  name: string;
  quantity: number;
  /** Free text under the line: modifiers, batch, gold breakdown, anything. */
  detail?: string | null;
  unitPrice?: Rial | null;
  discount?: Rial | null;
  tax?: Rial | null;
  lineTotal: Rial;
}

export interface PrintDocumentData {
  business: PrintBusinessInfo;
  /** «فاکتور فروش» / «رسید پرداخت» — overrides the template's title block text. */
  title?: string | null;
  /** «#42» / «T-42» / «۱۴۰۳-۰۰۱۲». */
  number: string;
  /** «حضوری — میز ۳», «بیرون‌بر», «فروش نقدی». */
  subtitle?: string | null;
  issuedAt: Date | string;
  customer?: PrintParty | null;
  cashierName?: string | null;
  lines: PrintLine[];
  subtotal: Rial;
  discount: Rial;
  tax: Rial;
  total: Rial;
  tip?: Rial;
  paid?: Rial | null;
  due?: Rial | null;
  payments?: { label: string; amount: Rial }[] | null;
  note?: string | null;
  footer?: string | null;
  /** Text under the QR block (a payment link, an invoice URL, a tax id). */
  qrPayload?: string | null;
  /** Pre-rendered QR image (data URL) — the browser/route makes it, the template only places it. */
  qrDataUrl?: string | null;
  barcodeValue?: string | null;
  /** A label's trade fields («رنگ», «عیار», «سایز», …) — see the `labelFields` block. */
  labelFields?: { label: string; value: string }[] | null;
  unit?: MoneyUnit;
}

/* ─────────────────────────── built-in presets ────────────────────── */

function block(
  id: string,
  type: BlockType,
  extra: Partial<TemplateBlock> = {},
): TemplateBlock {
  return { id, type, visible: true, ...extra };
}

const THERMAL_RECEIPT_BLOCKS = (): TemplateBlock[] => [
  block("logo", "logo", { align: "center", logoHeightMm: 14 }),
  block("businessName", "businessName", { align: "center", size: "lg", bold: true }),
  block("businessMeta", "businessMeta", { align: "center", size: "sm" }),
  block("d1", "divider"),
  block("title", "title", { align: "center", size: "lg", bold: true }),
  block("meta", "meta", { size: "sm" }),
  block("customer", "customer", { size: "sm", visible: false }),
  block("d2", "divider"),
  block("items", "items", { columns: ["name", "qty", "total"] }),
  block("d3", "divider"),
  block("totals", "totals"),
  block("payments", "payments"),
  block("note", "note", { size: "sm" }),
  block("d4", "divider"),
  block("qr", "qr", { align: "center", visible: false }),
  block("footer", "text", { align: "center", size: "sm", text: "" }),
];

/**
 * A label roll's blocks: the trade name, the item, the fields a shop reads at
 * the counter, and the barcode. No totals, no payments, and no divider — a
 * 57×40mm sticker has no room for them, which is exactly why the designer
 * needs a preset rather than a receipt template squeezed onto a sticker.
 */
const LABEL_BLOCKS = (): TemplateBlock[] => [
  block("businessName", "businessName", { align: "center", size: "xs" }),
  block("title", "title", { align: "center", size: "md", bold: true }),
  block("fields", "labelFields", { size: "sm" }),
  block("barcode", "barcode", { align: "center" }),
];

/**
 * The six templates every install starts with. Between them they cover the
 * paper a shop in this market actually owns: the two thermal roll widths, the
 * two office sheet sizes, a kitchen roll and a label size. A shop can
 * duplicate any of them into a template of its own — that is what the
 * designer's «ذخیره به‌عنوان قالب جدید» does — but it can never break one,
 * because these are code.
 */
export const BUILT_IN_TEMPLATES: PrintTemplate[] = [
  {
    key: "thermal80-receipt",
    name: "فیش فروش ۸۰ میلی‌متری",
    docType: "receipt",
    paper: "thermal80",
    options: { ...DEFAULT_OPTIONS, marginMm: 3, fontScale: 1 },
    blocks: THERMAL_RECEIPT_BLOCKS(),
  },
  {
    key: "thermal58-receipt",
    name: "فیش فشردهٔ ۵۸ میلی‌متری",
    docType: "receipt",
    paper: "thermal58",
    options: { ...DEFAULT_OPTIONS, marginMm: 2, fontScale: 0.92, lineHeight: 1.4 },
    blocks: THERMAL_RECEIPT_BLOCKS().map((b) =>
      b.type === "logo" ? { ...b, logoHeightMm: 10 } : b,
    ),
  },
  {
    key: "a4-invoice",
    name: "فاکتور رسمی A4",
    docType: "invoice",
    paper: "a4",
    options: { ...DEFAULT_OPTIONS, marginMm: 12, fontScale: 1, lineHeight: 1.6, bodyWeight: 400, copies: 1 },
    blocks: [
      block("logo", "logo", { align: "start", logoHeightMm: 20 }),
      block("businessName", "businessName", { align: "start", size: "xl", bold: true }),
      block("businessMeta", "businessMeta", { align: "start", size: "sm" }),
      block("title", "title", { align: "center", size: "lg", bold: true }),
      block("meta", "meta"),
      block("customer", "customer"),
      block("items", "items", {
        ruled: true,
        columns: ["row", "name", "qty", "unitPrice", "discount", "tax", "total"],
      }),
      block("totals", "totals", { align: "end" }),
      block("payments", "payments", { align: "end" }),
      block("note", "note", { size: "sm" }),
      block("signature", "signature", { text: "مهر و امضای فروشنده|مهر و امضای خریدار" }),
      block("footer", "text", { align: "center", size: "xs", text: "" }),
    ],
  },
  {
    key: "a5-invoice",
    name: "فاکتور A5 (پیک و تحویل)",
    docType: "invoice",
    paper: "a5",
    options: { ...DEFAULT_OPTIONS, marginMm: 8, fontScale: 0.95, lineHeight: 1.5, bodyWeight: 400 },
    blocks: [
      block("logo", "logo", { align: "start", logoHeightMm: 14 }),
      block("businessName", "businessName", { align: "start", size: "lg", bold: true }),
      block("businessMeta", "businessMeta", { align: "start", size: "xs" }),
      block("d1", "divider"),
      block("title", "title", { align: "center", size: "md", bold: true }),
      block("meta", "meta", { size: "sm" }),
      block("customer", "customer", { size: "sm" }),
      block("items", "items", { ruled: true, columns: ["row", "name", "qty", "unitPrice", "total"] }),
      block("totals", "totals", { align: "end" }),
      block("payments", "payments", { align: "end", visible: false }),
      block("note", "note", { size: "xs" }),
      block("signature", "signature", { size: "xs", text: "تحویل‌گیرنده|تحویل‌دهنده" }),
    ],
  },
  {
    key: "label57x40-label",
    name: "برچسب ۵۷×۴۰ میلی‌متری",
    docType: "label",
    paper: "label57x40",
    options: { ...DEFAULT_OPTIONS, marginMm: 2, fontScale: 1, lineHeight: 1.35, bodyWeight: 600, showUnit: false },
    blocks: LABEL_BLOCKS(),
  },
  {
    key: "thermal80-kitchen",
    name: "سفارش آشپزخانه ۸۰ میلی‌متری",
    docType: "kitchen",
    paper: "thermal80",
    options: { ...DEFAULT_OPTIONS, fontScale: 1.25, lineHeight: 1.45, bodyWeight: 700, showUnit: false },
    blocks: [
      // The branch's name, from the same resolver receipts use: a kitchen with
      // two printers and one rail should be able to tell whose ticket it is.
      block("businessName", "businessName", { align: "center", size: "xs" }),
      block("title", "title", { align: "center", size: "xl", bold: true }),
      block("meta", "meta", { align: "center", size: "sm" }),
      block("d1", "divider"),
      block("items", "items", { columns: ["qty", "name"] }),
      block("d2", "divider"),
      block("note", "note", { bold: true }),
    ],
  },
];

export function builtInTemplate(key: string): PrintTemplate | null {
  return BUILT_IN_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** A starting point for «قالب جدید»: the built-in that best fits the paper. */
export function starterTemplate(paper: PaperKey, docType: DocType): PrintTemplate {
  const match =
    BUILT_IN_TEMPLATES.find((t) => t.paper === paper && t.docType === docType) ??
    BUILT_IN_TEMPLATES.find((t) => t.paper === paper) ??
    BUILT_IN_TEMPLATES.find((t) => t.docType === docType) ??
    BUILT_IN_TEMPLATES[0];
  return {
    ...match,
    key: "",
    name: `${match.name} — کپی`,
    paper,
    docType,
    options: { ...match.options },
    blocks: match.blocks.map((b) => ({ ...b })),
  };
}

/* ───────────────────────────── validation ────────────────────────── */

const BLOCK_TYPES = new Set<string>(Object.keys(BLOCK_LABELS));
const ITEM_COLUMNS = new Set<string>(Object.keys(ITEM_COLUMN_LABELS));
const ALIGNS = new Set(["start", "center", "end"]);
const SIZES = new Set(["xs", "sm", "md", "lg", "xl"]);

export const MAX_TEMPLATE_NAME = 80;
export const MAX_BLOCKS = 40;
export const MAX_TEXT = 400;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

/**
 * Normalise anything that claims to be a template into one this renderer can
 * print, or `null` when it is not a template at all. The API stores only what
 * comes back from here, so a stored row can never contain a block type, column
 * or font scale the renderer does not understand.
 */
export function parsePrintTemplate(input: unknown): PrintTemplate | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > MAX_TEMPLATE_NAME) return null;
  if (!isPaperKey(raw.paper)) return null;
  const docType = raw.docType;
  if (docType !== "receipt" && docType !== "invoice" && docType !== "kitchen" && docType !== "label") {
    return null;
  }
  const blocksRaw = Array.isArray(raw.blocks) ? raw.blocks : [];
  if (blocksRaw.length === 0 || blocksRaw.length > MAX_BLOCKS) return null;

  const blocks: TemplateBlock[] = [];
  for (const [index, item] of blocksRaw.entries()) {
    if (!item || typeof item !== "object") return null;
    const b = item as Record<string, unknown>;
    if (typeof b.type !== "string" || !BLOCK_TYPES.has(b.type)) return null;
    const columns = Array.isArray(b.columns)
      ? (b.columns.filter((c) => typeof c === "string" && ITEM_COLUMNS.has(c)) as ItemColumn[])
      : undefined;
    const text = typeof b.text === "string" ? b.text.slice(0, MAX_TEXT) : undefined;
    blocks.push({
      id: typeof b.id === "string" && b.id.trim() ? b.id.trim().slice(0, 40) : `b${index}`,
      type: b.type as BlockType,
      visible: b.visible !== false,
      align: typeof b.align === "string" && ALIGNS.has(b.align) ? (b.align as Align) : undefined,
      size: typeof b.size === "string" && SIZES.has(b.size) ? (b.size as TextSize) : undefined,
      bold: b.bold === true,
      ...(text !== undefined ? { text } : {}),
      ...(b.heightMm !== undefined ? { heightMm: clampNumber(b.heightMm, 0, 100, 4) } : {}),
      ...(columns && columns.length > 0 ? { columns } : {}),
      ...(b.ruled !== undefined ? { ruled: b.ruled === true } : {}),
      ...(b.logoHeightMm !== undefined ? { logoHeightMm: clampNumber(b.logoHeightMm, 4, 60, 14) } : {}),
    });
  }

  const optionsRaw = (raw.options && typeof raw.options === "object" ? raw.options : {}) as Record<string, unknown>;
  const weight = Number(optionsRaw.bodyWeight);
  const options: TemplateOptions = {
    fontScale: clampNumber(optionsRaw.fontScale, 0.6, 2, DEFAULT_OPTIONS.fontScale),
    lineHeight: clampNumber(optionsRaw.lineHeight, 1, 2.4, DEFAULT_OPTIONS.lineHeight),
    marginMm: clampNumber(optionsRaw.marginMm, 0, 30, PAPERS[raw.paper].marginMm),
    bodyWeight: weight === 400 || weight === 500 || weight === 600 || weight === 700 ? weight : DEFAULT_OPTIONS.bodyWeight,
    showUnit: optionsRaw.showUnit !== false,
    copies: Number(optionsRaw.copies) === 2 ? 2 : 1,
  };
  if (Array.isArray(optionsRaw.copyLabels) && optionsRaw.copyLabels.length === 2) {
    const [first, second] = optionsRaw.copyLabels;
    if (typeof first === "string" && typeof second === "string") {
      options.copyLabels = [first.slice(0, 40), second.slice(0, 40)];
    }
  }

  return {
    key: typeof raw.key === "string" ? raw.key.slice(0, 64) : "",
    name,
    docType,
    paper: raw.paper,
    options,
    blocks,
  };
}

/* ───────────────────────────── the renderer ──────────────────────── */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Base font size in px for each paper, before `options.fontScale`. */
const BASE_FONT_PX: Record<PaperKey, number> = {
  thermal58: 20,
  thermal80: 22,
  a4: 12,
  a5: 11,
  label57x40: 18,
};

const SIZE_FACTORS: Record<TextSize, number> = { xs: 0.72, sm: 0.85, md: 1, lg: 1.25, xl: 1.6 };

function alignCss(align: Align | undefined, fallback: Align = "start"): string {
  const value = align ?? fallback;
  return value === "center" ? "center" : value === "end" ? "left" : "right";
}

export interface RenderOptions {
  /**
   * The paper the *printer* is loaded with, when it differs from the
   * template's own (a template designed for 80mm printed on a 58mm roll).
   * Only the width changes; the layout is the template's.
   */
  paperOverride?: PaperKey;
  /** Adds a screen-only watermark strip — used by the designer's preview. */
  previewLabel?: string;
}

/**
 * Render `template` filled with `data` into a complete, standalone HTML
 * document — the single output every print path shares. The print agent
 * screenshots it for thermal rolls; the browser hands the same string to
 * `window.print()` for A4/A5; the designer drops it into a preview iframe.
 */
export function renderPrintTemplate(
  template: PrintTemplate,
  data: PrintDocumentData,
  renderOpts: RenderOptions = {},
): string {
  const paper = PAPERS[renderOpts.paperOverride ?? template.paper] ?? PAPERS[template.paper];
  const opts = template.options;
  const unit: MoneyUnit = data.unit ?? "toman";
  const basePx = BASE_FONT_PX[paper.key] * opts.fontScale;
  const money = (value: Rial, withUnit = false) => formatMoney(value, unit, { withUnit });
  const dateLabel = toPersianDigits(formatJalali(data.issuedAt, { withMonthName: true, withTime: true }));

  const body = template.blocks
    .filter((b) => b.visible)
    .map((b) => renderBlock(b, { template, paper, data, money, dateLabel, opts }))
    .filter(Boolean)
    .join("\n");

  const copies =
    opts.copies === 2 && paper.kind !== "thermal"
      ? [opts.copyLabels?.[0] ?? "نسخهٔ خریدار", opts.copyLabels?.[1] ?? "نسخهٔ فروشنده"]
      : [null];

  const pages = copies
    .map(
      (caption, index) =>
        `<section class="page${index > 0 ? " page-break" : ""}">` +
        (caption ? `<div class="copy-caption">${escapeHtml(caption)}</div>` : "") +
        body +
        `</section>`,
    )
    .join("\n");

  const pageRule =
    paper.kind === "thermal"
      ? `@page { size: ${paper.widthMm}mm auto; margin: 0; }`
      : `@page { size: ${paper.widthMm}mm ${paper.heightMm}mm; margin: 0; }`;

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(data.title ?? template.name)}</title>
<style>
  ${pageRule}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #fff; color: #000; }
  body {
    font-family: "Vazirmatn", "Tahoma", sans-serif;
    font-size: ${basePx.toFixed(2)}px;
    font-weight: ${opts.bodyWeight};
    line-height: ${opts.lineHeight};
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    width: ${paper.widthMm}mm;
    ${paper.heightMm ? `min-height: ${paper.heightMm}mm;` : ""}
    padding: ${opts.marginMm}mm;
    margin: 0 auto;
    background: #fff;
    position: relative;
  }
  .page-break { page-break-before: always; break-before: page; }
  .copy-caption { font-size: 0.8em; text-align: left; margin-bottom: 2mm; }
  .blk { margin: 0 0 1.5mm; }
  .blk:last-child { margin-bottom: 0; }
  .row { display: flex; justify-content: space-between; gap: 4px; }
  .muted { color: #333; }
  .divider { border-top: 1px dashed #000; margin: 2mm 0; }
  .divider-solid { border-top: 1px solid #000; margin: 2mm 0; }
  .logo img { display: block; max-width: 100%; object-fit: contain; }
  .items-plain .item { margin: 1mm 0; }
  .items-plain .item-main { display: flex; align-items: baseline; gap: 6px; }
  .items-plain .item-main .name { flex: 1; }
  .items-plain .qty, .items-plain .amount { flex-shrink: 0; }
  .detail { font-size: 0.78em; color: #333; padding-inline-start: 6mm; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th, table.items td { padding: 1mm 1.5mm; text-align: right; vertical-align: top; }
  table.items.ruled th, table.items.ruled td { border: 1px solid #000; }
  table.items thead th { font-weight: 700; background: #eee; }
  table.items td.num, table.items th.num { text-align: center; white-space: nowrap; }
  .totals { display: inline-block; min-width: 55%; }
  .totals .row { padding: 0.6mm 0; }
  .grand { font-weight: 700; font-size: 1.2em; border-top: 1px solid #000; margin-top: 1mm; padding-top: 1mm; }
  .party { display: grid; grid-template-columns: 1fr 1fr; gap: 0 4mm; }
  .party .cell { display: flex; gap: 4px; }
  .party .cell .k { color: #333; }
  .signature { display: flex; justify-content: space-between; gap: 6mm; margin-top: 8mm; }
  .signature .slot { flex: 1; border-top: 1px solid #000; padding-top: 1.5mm; text-align: center; font-size: 0.8em; }
  .barcode { font-family: "Courier New", monospace; letter-spacing: 2px; direction: ltr; text-align: center; }
  .barcode-bars { direction: ltr; }
  .barcode-bars .bars { display: block; margin: 0 auto; }
  .barcode-bars .code-text { font-family: "Courier New", monospace; font-size: 1.1em; letter-spacing: 3px; text-align: center; }
  .label-fields .field { display: flex; justify-content: space-between; gap: 2mm; }
  .label-fields .field-label { color: #333; }
  .label-fields .field-value { font-weight: 600; }
  .preview-label { display: none; }
  @media screen { .page { box-shadow: 0 0 0 1px #ddd; } }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

interface BlockContext {
  template: PrintTemplate;
  paper: PaperSpec;
  data: PrintDocumentData;
  money: (value: Rial, withUnit?: boolean) => string;
  dateLabel: string;
  opts: TemplateOptions;
}

/**
 * The scannable bars of an EAN-13/UPC-A code as an inline SVG, or null for a
 * code in another shape (which stays text-only). 2px per module at the label
 * raster width leaves quiet zones a real scanner accepts; the bars print pure
 * black on the same monochrome raster path as the rest of the document.
 */
function barcodeSvg(code: string): string | null {
  const modules = ean13Modules(code);
  if (!modules) return null;
  const moduleWidth = 2;
  const height = 62;
  const rects: string[] = [];
  let run = 0;
  for (let i = 0; i <= modules.length; i++) {
    if (i < modules.length && modules[i] === "1") {
      run += 1;
      continue;
    }
    if (run > 0) {
      const x = (i - run) * moduleWidth;
      rects.push(`<rect x="${x}" y="0" width="${run * moduleWidth}" height="${height}"/>`);
      run = 0;
    }
  }
  const width = modules.length * moduleWidth;
  return `<svg class="bars" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" fill="black" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

function blockStyle(b: TemplateBlock, fallbackAlign: Align = "start"): string {
  const size = b.size ? SIZE_FACTORS[b.size] : 1;
  return `text-align:${alignCss(b.align, fallbackAlign)};font-size:${size}em;${b.bold ? "font-weight:700;" : ""}`;
}

function renderBlock(b: TemplateBlock, ctx: BlockContext): string {
  const { data, money, dateLabel, paper, opts } = ctx;
  const style = blockStyle(b);

  switch (b.type) {
    case "logo": {
      if (!data.business.logoDataUrl) return "";
      const h = b.logoHeightMm ?? 14;
      return `<div class="blk logo" style="${style}"><img src="${escapeHtml(data.business.logoDataUrl)}" alt="" style="height:${h}mm;margin:${b.align === "center" ? "0 auto" : "0"}" /></div>`;
    }
    case "businessName":
      return `<div class="blk" style="${style}">${escapeHtml(data.business.legalName || data.business.name)}</div>`;
    case "businessMeta": {
      const parts = [
        data.business.address,
        data.business.phone ? toPersianDigits(data.business.phone) : null,
        data.business.taxId ? `شناسهٔ مالیاتی ${toPersianDigits(data.business.taxId)}` : null,
        data.business.website,
      ].filter(Boolean) as string[];
      if (parts.length === 0) return "";
      return `<div class="blk muted" style="${style}">${parts.map((p) => escapeHtml(p)).join(" · ")}</div>`;
    }
    case "title": {
      const title = data.title || b.text || DOC_TYPE_LABELS[ctx.template.docType];
      const sub = data.subtitle ? `<div class="muted" style="font-size:0.7em">${escapeHtml(data.subtitle)}</div>` : "";
      return `<div class="blk" style="${blockStyle(b, "center")}">${escapeHtml(title)}${sub}</div>`;
    }
    case "meta": {
      const rows: string[] = [];
      rows.push(`<div class="row"><span>شماره</span><span>${toPersianDigits(escapeHtml(data.number))}</span></div>`);
      rows.push(`<div class="row"><span>تاریخ</span><span>${dateLabel}</span></div>`);
      if (data.cashierName) {
        rows.push(`<div class="row"><span>صادرکننده</span><span>${escapeHtml(data.cashierName)}</span></div>`);
      }
      return `<div class="blk" style="${style}">${rows.join("")}</div>`;
    }
    case "customer": {
      if (!data.customer) return "";
      const c = data.customer;
      const cells = [
        ["نام", c.name],
        ["تلفن", c.phone ? toPersianDigits(c.phone) : null],
        ["نشانی", c.address],
        ["کد اقتصادی", c.economicCode ? toPersianDigits(c.economicCode) : null],
        ["شناسهٔ مالیاتی", c.taxId ? toPersianDigits(c.taxId) : null],
      ].filter(([, value]) => Boolean(value)) as [string, string][];
      if (cells.length === 0) return "";
      const grid = paper.kind === "thermal" ? "" : ' class="party"';
      const inner = cells
        .map(([k, v]) => `<div class="cell"><span class="k">${k}:</span><span>${escapeHtml(v)}</span></div>`)
        .join("");
      return `<div class="blk" style="${style}"><div${grid}>${inner}</div></div>`;
    }
    case "items":
      return renderItems(b, ctx);
    case "totals": {
      const rows: string[] = [];
      rows.push(`<div class="row"><span>جمع جزء</span><span>${money(data.subtotal)}</span></div>`);
      if (data.discount > 0) rows.push(`<div class="row"><span>تخفیف</span><span>-${money(data.discount)}</span></div>`);
      if (data.tax > 0) rows.push(`<div class="row"><span>مالیات و عوارض</span><span>${money(data.tax)}</span></div>`);
      if (data.tip && data.tip > 0) rows.push(`<div class="row"><span>انعام</span><span>${money(data.tip)}</span></div>`);
      rows.push(
        `<div class="row grand"><span>مبلغ قابل پرداخت</span><span>${money(data.total + (data.tip ?? 0), opts.showUnit)}</span></div>`,
      );
      if (data.paid != null) rows.push(`<div class="row"><span>پرداخت‌شده</span><span>${money(data.paid)}</span></div>`);
      if (data.due != null && data.due > 0) rows.push(`<div class="row"><span>مانده</span><span>${money(data.due)}</span></div>`);
      const wrapper = b.align === "end" ? `<div style="text-align:left"><div class="totals">${rows.join("")}</div></div>` : rows.join("");
      return `<div class="blk" style="${blockStyle(b, "start")}">${wrapper}</div>`;
    }
    case "payments": {
      if (!data.payments?.length) return "";
      const rows = data.payments
        .map((p) => `<div class="row"><span>${escapeHtml(p.label)}</span><span>${money(p.amount)}</span></div>`)
        .join("");
      const wrapper = b.align === "end" ? `<div style="text-align:left"><div class="totals">${rows}</div></div>` : rows;
      return `<div class="blk" style="${blockStyle(b, "start")}">${wrapper}</div>`;
    }
    case "note":
      if (!data.note) return "";
      return `<div class="blk" style="${style}">${escapeHtml(data.note)}</div>`;
    case "text": {
      const value = b.text?.trim() || data.footer?.trim() || "";
      if (!value) return "";
      return `<div class="blk" style="${style}">${escapeHtml(value).replace(/\n/g, "<br />")}</div>`;
    }
    case "qr": {
      if (!data.qrDataUrl) return "";
      const caption = data.qrPayload ? `<div class="muted" style="font-size:0.7em;direction:ltr">${escapeHtml(data.qrPayload)}</div>` : "";
      return `<div class="blk" style="${blockStyle(b, "center")}"><img src="${escapeHtml(data.qrDataUrl)}" alt="" style="width:22mm;height:22mm" />${caption}</div>`;
    }
    case "barcode": {
      const value = data.barcodeValue || data.number;
      if (!value) return "";
      const bars = barcodeSvg(value);
      if (!bars) {
        return `<div class="blk barcode" style="font-size:${b.size ? SIZE_FACTORS[b.size] : 1}em">${escapeHtml(value)}</div>`;
      }
      // A shelf label exists to be scanned: an EAN-13/UPC-A code prints as
      // real bars with its digits beneath, on the same monochrome raster path
      // as everything else. Codes in another shape keep the text block.
      return `<div class="blk barcode-bars" style="${alignCss(b.align, "center") === "center" ? "text-align:center;" : ""}">${bars}<div class="code-text">${escapeHtml(value)}</div></div>`;
    }
    case "labelFields": {
      if (!data.labelFields?.length) return "";
      const rows = data.labelFields
        .map((field) => `<div class="field"><span class="field-label">${escapeHtml(field.label)}</span><span class="field-value">${escapeHtml(field.value)}</span></div>`)
        .join("");
      return `<div class="blk label-fields" style="${style}">${rows}</div>`;
    }
    case "signature": {
      const [right, left] = (b.text || "مهر و امضای فروشنده|مهر و امضای خریدار").split("|");
      return `<div class="blk signature" style="font-size:${b.size ? SIZE_FACTORS[b.size] : 1}em"><div class="slot">${escapeHtml(right ?? "")}</div><div class="slot">${escapeHtml(left ?? "")}</div></div>`;
    }
    case "divider":
      return `<div class="${paper.kind === "thermal" ? "divider" : "divider-solid"}"></div>`;
    case "spacer":
      return `<div style="height:${b.heightMm ?? 4}mm"></div>`;
    default:
      return "";
  }
}

function renderItems(b: TemplateBlock, ctx: BlockContext): string {
  const { data, money } = ctx;
  const columns: ItemColumn[] = b.columns?.length ? b.columns : ["name", "qty", "total"];

  // A receipt roll reads better as stacked rows than as a squeezed table: the
  // name gets the full width and the amount sits on the same baseline.
  if (!b.ruled) {
    const rows = data.lines
      .map((line) => {
        const bits: string[] = [];
        if (columns.includes("qty")) bits.push(`<span class="qty">${toPersianDigits(line.quantity)}×</span>`);
        if (columns.includes("name")) bits.push(`<span class="name">${escapeHtml(line.name)}</span>`);
        if (columns.includes("unitPrice") && line.unitPrice != null) {
          bits.push(`<span class="qty muted">${money(line.unitPrice)}</span>`);
        }
        if (columns.includes("total")) bits.push(`<span class="amount">${money(line.lineTotal)}</span>`);
        const detail = line.detail ? `<div class="detail">${escapeHtml(line.detail)}</div>` : "";
        return `<div class="item"><div class="item-main">${bits.join("")}</div>${detail}</div>`;
      })
      .join("");
    return `<div class="blk items-plain">${rows}</div>`;
  }

  const head = columns.map((c) => `<th class="${c === "name" ? "" : "num"}">${ITEM_COLUMN_LABELS[c]}</th>`).join("");
  const body = data.lines
    .map((line, index) => {
      const cells = columns
        .map((c) => {
          switch (c) {
            case "row":
              return `<td class="num">${toPersianDigits(index + 1)}</td>`;
            case "name":
              return `<td>${escapeHtml(line.name)}${line.detail ? `<div class="detail">${escapeHtml(line.detail)}</div>` : ""}</td>`;
            case "qty":
              return `<td class="num">${toPersianDigits(line.quantity)}</td>`;
            case "unitPrice":
              return `<td class="num">${line.unitPrice != null ? money(line.unitPrice) : "—"}</td>`;
            case "discount":
              return `<td class="num">${line.discount ? money(line.discount) : "—"}</td>`;
            case "tax":
              return `<td class="num">${line.tax ? money(line.tax) : "—"}</td>`;
            case "total":
              return `<td class="num">${money(line.lineTotal)}</td>`;
            default:
              return "<td></td>";
          }
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="blk"><table class="items ruled"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
