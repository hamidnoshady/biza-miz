/**
 * Issue #915 — how an applied OCR scan lands in the EDITABLE supplier-invoice
 * draft (supplier-invoice-fields.tsx). Pure and framework-free so the merge
 * rules are unit-tested instead of living inline in the section component:
 *
 *  - the recognised invoice number replaces the draft's (clamped to the
 *    column's 64-char bound) — a scan that found none leaves the typed one;
 *  - the recognised date proposes the invoice date only when the scan has
 *    one — it never blanks a date the operator already picked;
 *  - a scan with neither returns the draft unchanged (same object), so the
 *    caller can skip a no-op state update;
 *  - the VAT fields are deliberately untouched: VAT follows the business's
 *    own rate over the lines until the operator types it, and OCR must not
 *    count as the operator's hand.
 */
import { MAX_SUPPLIER_INVOICE_NUMBER_LENGTH } from "@/lib/payables-input";
import type { SupplierInvoiceDraft } from "./supplier-invoice-fields";

export function mergeOcrInvoiceDraft(
  prev: SupplierInvoiceDraft,
  payload: { invoiceNumber?: string | null; purchaseDate?: string | null },
): SupplierInvoiceDraft {
  if (!payload.invoiceNumber && !payload.purchaseDate) return prev;
  return {
    ...prev,
    invoiceNumber: payload.invoiceNumber
      ? payload.invoiceNumber.slice(0, MAX_SUPPLIER_INVOICE_NUMBER_LENGTH)
      : prev.invoiceNumber,
    invoiceDate: payload.purchaseDate || prev.invoiceDate,
  };
}
