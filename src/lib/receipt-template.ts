/**
 * Customer-facing receipt template — pure HTML string builder, no DB/I/O.
 *
 * The app server (src/lib/printing/chromium.ts) screenshots this HTML with a real browser
 * engine and sends the result to the printer as a raster image (see
 * src/lib/escpos.ts's header comment for why: no ESC/POS printer we can
 * target reliably shapes/reorders Persian text on its own). Keeping the
 * template a pure function of plain data means it can be unit tested as a
 * string and reused unchanged by the setup wizard's test-print preview.
 */
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";
import { formatMoney, type MoneyUnit, type Rial } from "./money";

export interface ReceiptBusinessInfo {
  name: string;
  address?: string | null;
  phone?: string | null;
  /** e.g. "با تشکر از خرید شما" — shown at the bottom. */
  footerMessage?: string | null;
}

export interface ReceiptLine {
  name: string;
  quantity: number;
  /** modifiers included, per line total (Rial) */
  lineTotal: Rial;
  modifiersLabel?: string | null;
  /**
   * Phase 25 — a gold line's price components (src/lib/gold-pricing.ts),
   * printed under the line so the customer can see what they are paying for.
   * A jewellery invoice that shows only a total is not a document anyone in
   * that trade would accept. Absent on every other kind of line.
   */
  goldBreakdown?: {
    metalValue: Rial;
    makingCharge: Rial;
    profit: Rial;
    /** Net weight sold, grams — decimal string (a fraction of a gram is common in jewelry). Optional so old callers keep compiling. */
    netWeight?: string | null;
    /** "18" | "21" | "24" — see src/lib/gold.ts's Purity. Free-form here to avoid a template↔domain dependency. */
    purity?: string | null;
  } | null;
  /**
   * Phase 27 Wave 2 — a batch-tracked line's lot number and expiry date,
   * printed under the line the way the gold breakdown is. Absent on lines
   * without batch tracking, which is every line in a café and most retail
   * lines.
   */
  batch?: {
    batchNumber: string;
    expiryDate?: string | null;
  } | null;
  /**
   * Phase 27 Wave 10 — a pre-owned serialized unit's provenance, printed so
   * the customer buying a used piece sees exactly what was recorded at
   * intake: the condition grade and whether box and papers came with it.
   * Absent on new units and every non-serial line.
   */
  serialProvenance?: {
    conditionGrade?: string | null;
    boxAndPapers: boolean;
  } | null;
  /**
   * A serialized unit's identity and warranty (watches today) — printed so the
   * customer's copy is the warranty document, not just a sales slip. Absent
   * on every non-serial line.
   */
  serial?: {
    serialNumber: string;
    warrantyMonths?: number | null;
    warrantyEndDate?: string | null;
  } | null;
}

/**
 * How a `payment_method` reads to a person. Exported because the receipt is
 * not the only surface that names a tender — the shift order review shows one
 * too, and the two must not drift apart.
 */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "نقدی",
  card: "کارت‌خوان",
  card_to_card: "کارت‌به‌کارت",
  cheque: "چک",
  online: "پرداخت آنلاین",
  credit: "نسیه",
  snappfood: "اسنپ‌فود",
};

/** Exported so the retail invoice detail modal reads the same labels the printed receipt does. */
export const CONDITION_GRADE_LABELS: Record<string, string> = {
  new: "نو",
  like_new: "در حد نو",
  good: "خوب",
  fair: "متوسط",
  poor: "ضعیف",
};

export interface ReceiptData {
  business: ReceiptBusinessInfo;
  /** e.g. "#42" or "T-42" (formatQueueLabel) */
  orderLabel: string;
  /** e.g. "حضوری — میز ۳" or "بیرون‌بر"; "فاکتور فروش" on a retail invoice. */
  orderTypeLabel: string;
  /** Named on the invoice when the sale was made to a known customer. */
  customerName?: string | null;
  issuedAt: Date | string;
  lines: ReceiptLine[];
  subtotal: Rial;
  discount: Rial;
  tax: Rial;
  total: Rial;
  /** A tip collected alongside the bill (issue #160 §4) — on top of `total`, not part of it. */
  tip?: Rial;
  paymentMethod?: string | null;
  /**
   * A bill settled across several ways (migration 0091), each with the name
   * the business gave it. Printed one row per slice in place of the single
   * «روش پرداخت» line, because "نقدی ۲۰۰٬۰۰۰ / کارت‌خوان ۳۰۰٬۰۰۰" is exactly
   * the thing a customer comes back to the counter to check. A single-way sale
   * can pass this too — one row reads no worse than the old line.
   */
  payments?: { label: string; amount: Rial }[] | null;
  cashierName?: string | null;
  /** The business's display unit; defaults to Toman for callers that don't know it. */
  unit?: MoneyUnit;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 58mm and 80mm are the two standard thermal receipt widths; content width leaves ~2mm margins each side. */
export const PAPER_WIDTH_PRESETS = { 58: 372, 80: 512 } as const;
export type PaperWidthMm = keyof typeof PAPER_WIDTH_PRESETS;

export function renderReceiptHtml(data: ReceiptData, opts: { paperWidthMm?: PaperWidthMm } = {}): string {
  const widthPx = PAPER_WIDTH_PRESETS[opts.paperWidthMm ?? 80];
  const fmt = (rial: Rial, fmtOpts: { withUnit?: boolean } = {}) => formatMoney(rial, data.unit ?? "toman", fmtOpts);
  const dateLabel = toPersianDigits(formatJalali(data.issuedAt, { withMonthName: true }));

  const lineRows = data.lines
    .map((l) => {
      const modRow = l.modifiersLabel
        ? `<div class="mods">${escapeHtml(l.modifiersLabel)}</div>`
        : "";
      const goldRow = l.goldBreakdown
        ? `<div class="mods">` +
          (l.goldBreakdown.netWeight
            ? `عیار ${toPersianDigits(l.goldBreakdown.purity ?? "")} · ${toPersianDigits(l.goldBreakdown.netWeight)} گرم · `
            : "") +
          `طلا ${fmt(l.goldBreakdown.metalValue, { withUnit: false })}` +
          ` · اجرت ${fmt(l.goldBreakdown.makingCharge, { withUnit: false })}` +
          ` · سود ${fmt(l.goldBreakdown.profit, { withUnit: false })}</div>`
        : "";
      const batchRow = l.batch
        ? `<div class="mods">بچ ${escapeHtml(l.batch.batchNumber)}` +
          (l.batch.expiryDate ? ` · انقضا ${toPersianDigits(formatJalali(l.batch.expiryDate))}` : "") +
          `</div>`
        : "";
      const provenanceRow = l.serialProvenance
        ? `<div class="mods">دست‌دوم · وضعیت ${CONDITION_GRADE_LABELS[l.serialProvenance.conditionGrade ?? ""] ?? escapeHtml(l.serialProvenance.conditionGrade ?? "")}` +
          (l.serialProvenance.boxAndPapers ? " · همراه جعبه و مدارک" : " · بدون جعبه و مدارک") +
          `</div>`
        : "";
      const serialRow = l.serial
        ? `<div class="mods">سریال ${escapeHtml(l.serial.serialNumber)}` +
          (l.serial.warrantyMonths
            ? ` · گارانتی ${toPersianDigits(l.serial.warrantyMonths)} ماهه` +
              (l.serial.warrantyEndDate ? ` تا ${toPersianDigits(formatJalali(l.serial.warrantyEndDate))}` : "")
            : "") +
          `</div>`
        : "";
      return `
        <div class="line">
          <div class="line-main">
            <span class="qty">${toPersianDigits(l.quantity)}×</span>
            <span class="name">${escapeHtml(l.name)}</span>
            <span class="amount">${fmt(l.lineTotal, { withUnit: false })}</span>
          </div>
          ${modRow}
          ${goldRow}
          ${batchRow}
          ${provenanceRow}
          ${serialRow}
        </div>`;
    })
    .join("");

  const discountRow =
    data.discount > 0
      ? `<div class="totals-row"><span>تخفیف</span><span>-${fmt(data.discount, { withUnit: false })}</span></div>`
      : "";
  const taxRow =
    data.tax > 0
      ? `<div class="totals-row"><span>مالیات</span><span>${fmt(data.tax, { withUnit: false })}</span></div>`
      : "";
  const paymentRow = data.payments?.length
    ? data.payments
        .map(
          (payment) =>
            `<div class="totals-row"><span>${escapeHtml(payment.label)}</span><span>${fmt(payment.amount, { withUnit: false })}</span></div>`,
        )
        .join("")
    : data.paymentMethod
      ? `<div class="totals-row"><span>روش پرداخت</span><span>${escapeHtml(PAYMENT_METHOD_LABELS[data.paymentMethod] ?? data.paymentMethod)}</span></div>`
      : "";
  const tipRow =
    data.tip && data.tip > 0
      ? `<div class="totals-row"><span>انعام</span><span>${fmt(data.tip, { withUnit: false })}</span></div>`
      : "";
  const receivedRow =
    data.tip && data.tip > 0
      ? `<div class="grand-total"><span>مبلغ دریافتی</span><span>${fmt(data.total + data.tip)}</span></div>`
      : "";

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${widthPx}px;
    font-family: "Vazirmatn", sans-serif;
    font-size: 22px;
    line-height: 1.5;
    color: #000;
    background: #fff;
    padding: 12px 10px;
  }
  .center { text-align: center; }
  .business-name { font-size: 28px; font-weight: 700; }
  .business-meta { font-size: 18px; color: #222; margin-top: 4px; }
  .divider { border-top: 2px dashed #000; margin: 10px 0; }
  .meta-row { display: flex; justify-content: space-between; font-size: 18px; margin: 2px 0; }
  .order-label { font-size: 26px; font-weight: 700; text-align: center; margin: 6px 0; }
  .line { margin: 6px 0; }
  .line-main { display: flex; align-items: baseline; gap: 6px; }
  .line-main .qty { flex-shrink: 0; }
  .line-main .name { flex: 1; }
  .line-main .amount { flex-shrink: 0; }
  .mods { font-size: 16px; color: #333; padding-inline-start: 24px; }
  .totals-row { display: flex; justify-content: space-between; font-size: 19px; margin: 3px 0; }
  .grand-total { display: flex; justify-content: space-between; font-size: 26px; font-weight: 700; margin-top: 6px; }
  .footer { text-align: center; font-size: 18px; margin-top: 14px; }
</style>
</head>
<body>
  <div class="center business-name">${escapeHtml(data.business.name)}</div>
  ${data.business.address ? `<div class="center business-meta">${escapeHtml(data.business.address)}</div>` : ""}
  ${data.business.phone ? `<div class="center business-meta" dir="ltr">${toPersianDigits(data.business.phone)}</div>` : ""}

  <div class="divider"></div>
  <div class="order-label">${escapeHtml(data.orderLabel)}</div>
  <div class="meta-row"><span>${escapeHtml(data.orderTypeLabel)}</span><span>${dateLabel}</span></div>
  ${data.customerName ? `<div class="meta-row"><span>مشتری</span><span>${escapeHtml(data.customerName)}</span></div>` : ""}
  ${data.cashierName ? `<div class="meta-row"><span>صندوق‌دار</span><span>${escapeHtml(data.cashierName)}</span></div>` : ""}

  <div class="divider"></div>
  ${lineRows}

  <div class="divider"></div>
  <div class="totals-row"><span>جمع جزء</span><span>${fmt(data.subtotal, { withUnit: false })}</span></div>
  ${discountRow}
  ${taxRow}
  <div class="grand-total"><span>جمع کل</span><span>${fmt(data.total)}</span></div>
  ${tipRow}
  ${receivedRow}
  ${paymentRow}

  <div class="divider"></div>
  ${data.business.footerMessage ? `<div class="footer">${escapeHtml(data.business.footerMessage)}</div>` : ""}
</body>
</html>`;
}
