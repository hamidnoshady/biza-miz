/**
 * Kitchen-facing ticket template — pure HTML string builder, no DB/I/O.
 * Same rendering pipeline as receipt-template.ts (screenshotted by the print
 * agent, packed to an ESC/POS raster image), but larger type and no prices —
 * kitchen tickets are about what to make, not what it costs. Printed in
 * addition to the KDS screen (Phase 4), not instead of it.
 */
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";
import type { PaperWidthMm } from "./receipt-template";
import { PAPER_WIDTH_PRESETS } from "./receipt-template";

export interface KitchenTicketLine {
  name: string;
  quantity: number;
  modifiersLabel?: string | null;
  note?: string | null;
}

export interface KitchenTicketData {
  /** table name (dine-in) or queue label like "T-42" (takeaway) */
  label: string;
  /** e.g. "حضوری" / "بیرون‌بر" */
  orderTypeLabel: string;
  /** Persisted per-order identity, present on every server-built kitchen ticket. */
  orderNumber?: number | string;
  sentAt: Date | string;
  lines: KitchenTicketLine[];
  orderNote?: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderKitchenTicketHtml(data: KitchenTicketData, opts: { paperWidthMm?: PaperWidthMm } = {}): string {
  const widthPx = PAPER_WIDTH_PRESETS[opts.paperWidthMm ?? 80];
  const timeLabel = toPersianDigits(formatJalali(data.sentAt, { withMonthName: true }));

  const lineRows = data.lines
    .map((l) => {
      const modRow = l.modifiersLabel ? `<div class="mods">${escapeHtml(l.modifiersLabel)}</div>` : "";
      const noteRow = l.note ? `<div class="note">توجه: ${escapeHtml(l.note)}</div>` : "";
      return `
        <div class="line">
          <div class="line-main"><span class="qty">${toPersianDigits(l.quantity)}×</span> <span class="name">${escapeHtml(l.name)}</span></div>
          ${modRow}
          ${noteRow}
        </div>`;
    })
    .join("");

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${widthPx}px;
    font-family: "Vazirmatn", sans-serif;
    font-size: 24px;
    line-height: 1.5;
    color: #000;
    background: #fff;
    padding: 12px 10px;
  }
  .center { text-align: center; }
  .label { font-size: 34px; font-weight: 700; text-align: center; }
  .order-type { text-align: center; font-size: 20px; color: #222; margin-top: 2px; }
  .divider { border-top: 3px solid #000; margin: 10px 0; }
  .meta-row { display: flex; justify-content: space-between; font-size: 18px; }
  .line { margin: 10px 0; }
  .line-main .qty { font-weight: 700; }
  .line-main .name { font-weight: 700; }
  .mods { font-size: 18px; color: #222; padding-inline-start: 28px; }
  .note { font-size: 18px; font-weight: 700; padding-inline-start: 28px; }
  .order-note { margin-top: 10px; font-size: 18px; font-weight: 700; border-top: 2px dashed #000; padding-top: 8px; }
</style>
</head>
<body>
  <div class="label">${escapeHtml(data.label)}</div>
  <div class="order-type">${escapeHtml(data.orderTypeLabel)}</div>
  ${data.orderNumber != null ? `<div class="order-type" style="font-weight:700;">سفارش ${toPersianDigits(data.orderNumber)}</div>` : ""}
  <div class="meta-row center" style="justify-content:center; margin-top:4px;"><span>${timeLabel}</span></div>

  <div class="divider"></div>
  ${lineRows}

  ${data.orderNote ? `<div class="order-note">یادداشت سفارش: ${escapeHtml(data.orderNote)}</div>` : ""}
</body>
</html>`;
}
