/**
 * Report PDF template — pure HTML string builders, no DB/I/O (same split as
 * receipt-template.ts). Rendered to an actual PDF by pdf-render.ts, which
 * screenshots this HTML with a real browser engine (Chromium via
 * playwright-core) so Persian/RTL text shapes correctly — same reasoning as
 * the receipt/kitchen-ticket templates (see src/lib/escpos.ts).
 *
 * Branding matches the receipt header (business name/address/phone) —
 * there's no logo field anywhere in the system yet (receipts don't carry
 * one either), so that's the extent of "branding" for now.
 */
import { toPersianDigits } from "./digits";
import { formatJalali, formatShiftWindow } from "./jalali";
import { formatMoney, type MoneyUnit } from "./money";

export interface ReportPdfBusinessInfo {
  name: string;
  address?: string | null;
  phone?: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function cellToLabel(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return toPersianDigits(formatJalali(v));
  if (typeof v === "number") return toPersianDigits(v.toLocaleString("en-US"));
  if (typeof v === "string") {
    const window = formatShiftWindow(v);
    if (window) return window;
    // Reporting views ship date columns as `YYYY-MM-DD` text; the PDF is
    // human-facing and follows the screen's Shamsi labels (issue #819).
    if (ISO_DATE_ONLY.test(v)) return toPersianDigits(formatJalali(v));
  }
  return String(v);
}

/** A `YYYY-MM-DD` held as text — how every reporting view emits a `date` column over JSON. */
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const SHARED_STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Vazirmatn", sans-serif;
    font-size: 14px;
    color: #111;
    background: #fff;
    padding: 28px 32px;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 16px; }
  .biz-name { font-size: 20px; font-weight: 700; }
  .biz-meta { font-size: 12px; color: #444; margin-top: 2px; }
  .report-meta { text-align: left; font-size: 12px; color: #444; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .filters { font-size: 12px; color: #444; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: start; font-size: 13px; }
  th { background: #f3f3f1; font-weight: 700; }
  tr:last-child td { border-bottom: 1px solid #111; }
  .section-heading { font-size: 15px; font-weight: 700; margin: 18px 0 6px; }
  .totals-row td { font-weight: 700; border-top: 2px solid #111; }
  footer { margin-top: 20px; font-size: 11px; color: #888; }
`;

function pageHeader(business: ReportPdfBusinessInfo, title: string, generatedAt: Date | string): string {
  const meta = [business.address, business.phone]
    .filter((v): v is string => Boolean(v))
    .map(escapeHtml)
    .join(" — ");
  return `
    <header>
      <div>
        <div class="biz-name">${escapeHtml(business.name)}</div>
        ${meta ? `<div class="biz-meta">${meta}</div>` : ""}
      </div>
      <div class="report-meta">
        <div>${toPersianDigits(formatJalali(generatedAt, { withMonthName: true }))}</div>
      </div>
    </header>
    <h1>${escapeHtml(title)}</h1>`;
}

export interface ReportPdfColumn {
  key: string;
  label: string;
}

export interface ReportPdfTableData {
  business: ReportPdfBusinessInfo;
  title: string;
  generatedAt: Date | string;
  /** e.g. "از ۱۴۰۴/۰۱/۰۱ تا ۱۴۰۴/۰۱/۳۱" */
  filterSummary?: string | null;
  columns: ReportPdfColumn[];
  rows: Record<string, unknown>[];
}

/** A flat data table report — used for every view-backed standard report and every custom report. */
export function renderReportTableHtml(data: ReportPdfTableData): string {
  const headerCells = data.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const bodyRows = data.rows
    .map((row) => `<tr>${data.columns.map((c) => `<td>${escapeHtml(cellToLabel(row[c.key]))}</td>`).join("")}</tr>`)
    .join("");

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head><meta charset="utf-8" /><style>${SHARED_STYLE}</style></head>
<body>
  ${pageHeader(data.business, data.title, data.generatedAt)}
  ${data.filterSummary ? `<div class="filters">${escapeHtml(data.filterSummary)}</div>` : ""}
  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows || `<tr><td colspan="${data.columns.length}">داده‌ای یافت نشد.</td></tr>`}</tbody>
  </table>
  <footer>تولید شده در ${toPersianDigits(formatJalali(data.generatedAt, { withMonthName: true }))}</footer>
</body>
</html>`;
}

export interface ReportPdfLedgerSection {
  heading: string;
  rows: { code: string; name: string; amount: number }[];
  totalLabel: string;
  totalAmount: number;
}

export interface ReportPdfLedgerData {
  business: ReportPdfBusinessInfo;
  title: string;
  generatedAt: Date | string;
  /** e.g. "از ۱۴۰۴/۰۱/۰۱ تا ۱۴۰۴/۰۱/۳۱" or "تا تاریخ ۱۴۰۴/۰۱/۳۱" */
  periodLabel: string;
  sections: ReportPdfLedgerSection[];
  grandTotalLabel: string;
  grandTotalAmount: number;
  /** The business's display unit; defaults to Toman for callers that don't know it. */
  unit?: MoneyUnit;
}

/** Structured account-type rollup — P&L and Balance Sheet (each account type is its own section, not a flat row list). */
export function renderReportLedgerHtml(data: ReportPdfLedgerData): string {
  const fmt = (amount: number) => formatMoney(amount, data.unit ?? "toman");
  const sectionsHtml = data.sections
    .map((section) => {
      const rows = section.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.name)}</td><td>${fmt(r.amount)}</td></tr>`,
        )
        .join("");
      return `
        <div class="section-heading">${escapeHtml(section.heading)}</div>
        <table>
          <thead><tr><th>کد</th><th>حساب</th><th>مبلغ</th></tr></thead>
          <tbody>
            ${rows || `<tr><td colspan="3">بدون سطر</td></tr>`}
            <tr class="totals-row"><td colspan="2">${escapeHtml(section.totalLabel)}</td><td>${fmt(section.totalAmount)}</td></tr>
          </tbody>
        </table>`;
    })
    .join("");

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head><meta charset="utf-8" /><style>${SHARED_STYLE}</style></head>
<body>
  ${pageHeader(data.business, data.title, data.generatedAt)}
  <div class="filters">${escapeHtml(data.periodLabel)}</div>
  ${sectionsHtml}
  <table>
    <tbody>
      <tr class="totals-row"><td>${escapeHtml(data.grandTotalLabel)}</td><td>${fmt(data.grandTotalAmount)}</td></tr>
    </tbody>
  </table>
  <footer>تولید شده در ${toPersianDigits(formatJalali(data.generatedAt, { withMonthName: true }))}</footer>
</body>
</html>`;
}
