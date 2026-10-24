/**
 * Issue #915 phase 3 — the printable view of a POSTED retail purchase
 * receipt.
 *
 * Policy (docs/plans/ISSUE_915_PLAN.md): a posted receipt is never edited or deleted —
 * corrections happen through supplier returns / credit notes. What the
 * operator legitimately needs from an old receipt is to SEE and HAND OVER
 * it: this builds a self-contained, print-ready HTML document (RTL, Shamsi
 * dates, exact Rial text money) for `window.print()`. Pure string in/out so
 * the escaping and formatting are unit-testable without a browser.
 */
import { formatJalali } from "@/lib/jalali";
import { formatQuantity, toPersianDigits } from "@/lib/digits";

export interface ReceiptPurchase {
  id: string;
  total: string;
  vatAmount: string;
  settlementMethod: string;
  supplierInvoiceNumber: string | null;
  supplierInvoiceDate: string | null;
  paymentDueDate: string | null;
  note: string | null;
  receivedAt: string;
  supplierName: string | null;
  createdByName: string | null;
}

export interface ReceiptLine {
  id: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  unitCost: string;
  batchNumber: string | null;
  serialNumber: string | null;
  expiryDate: string | null;
}

const SETTLEMENT_LABELS: Record<string, string> = {
  credit: "نسیه (حساب‌های پرداختنی)",
  cash: "نقدی (صندوق)",
  bank: "بانک/کارت‌خوان",
};

/** Minimal HTML escaping — every dynamic value goes through this. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildPurchaseReceiptHtml(
  purchase: ReceiptPurchase,
  lines: ReceiptLine[],
  /** The money context's exact-text formatter (Rial text in, display text out). */
  formatMoney: (rialText: string) => string,
): string {
  const esc = escapeHtml;
  const row = (l: ReceiptLine) => `
      <tr>
        <td>${esc(l.itemName)}${l.sku ? ` <span class="muted">(${esc(l.sku)})</span>` : ""}${
          l.batchNumber ? `<div class="muted">بچ ${esc(toPersianDigits(l.batchNumber))}</div>` : ""
        }${l.serialNumber ? `<div class="muted">سریال ${esc(toPersianDigits(l.serialNumber))}</div>` : ""}${
          l.expiryDate ? `<div class="muted">انقضا ${esc(formatJalali(l.expiryDate))}</div>` : ""
        }</td>
        <td>${esc(formatQuantity(l.quantity))}</td>
        <td>${esc(formatMoney(l.unitCost))}</td>
      </tr>`;

  const meta: Array<[string, string]> = [
    ["تاریخ دریافت", formatJalali(purchase.receivedAt, { withTime: true })],
    ["تأمین‌کننده", purchase.supplierName ?? "بدون تأمین‌کننده"],
    ["تسویه", SETTLEMENT_LABELS[purchase.settlementMethod] ?? purchase.settlementMethod],
    ["شمارهٔ فاکتور", purchase.supplierInvoiceNumber ? toPersianDigits(purchase.supplierInvoiceNumber) : "—"],
    ["تاریخ فاکتور", purchase.supplierInvoiceDate ? formatJalali(purchase.supplierInvoiceDate) : "—"],
    ["سررسید پرداخت", purchase.paymentDueDate ? formatJalali(purchase.paymentDueDate) : "—"],
    ["ثبت‌کننده", purchase.createdByName ?? "—"],
  ];

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8">
<title>رسید خرید</title>
<style>
  body { font-family: system-ui, Tahoma, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .muted { color: #555; font-size: 11px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 12px; margin: 12px 0; }
  dt { color: #555; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #bbb; padding: 4px 8px; text-align: right; vertical-align: top; }
  th { background: #f2f2f2; }
  tfoot td { font-weight: 600; }
  .doc-id { font-size: 10px; color: #777; margin-top: 16px; direction: ltr; text-align: left; }
  @media print { body { margin: 8mm; } }
</style>
</head>
<body>
  <h1>رسید خرید</h1>
  <p class="muted">سند ثبت‌شدهٔ انبار — اصلاح فقط با سند برگشت به تأمین‌کننده یا اعلامیهٔ بستانکاری انجام می‌شود.</p>
  <dl>
    ${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("\n    ")}
  </dl>
  <table>
    <thead>
      <tr><th>کالا</th><th>تعداد</th><th>بهای واحد</th></tr>
    </thead>
    <tbody>${lines.map(row).join("")}
    </tbody>
    <tfoot>
      <tr><td colspan="2">جمع کالا</td><td>${esc(formatMoney(purchase.total))}</td></tr>${
        purchase.vatAmount !== "0"
          ? `
      <tr><td colspan="2">مالیات بر ارزش افزوده</td><td>${esc(formatMoney(purchase.vatAmount))}</td></tr>`
          : ""
      }
    </tfoot>
  </table>${purchase.note ? `\n  <p class="muted">یادداشت: ${esc(purchase.note)}</p>` : ""}
  <p class="doc-id">${esc(purchase.id)}</p>
</body>
</html>`;
}
