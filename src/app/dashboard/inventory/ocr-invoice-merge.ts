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

/**
 * Issue #915 — the OCR grand-total cross-check. OCR reads two independent
 * figures from a supplier invoice: the per-line totals and the printed grand
 * total. When lines + VAT don't add up to the printed total, one of them was
 * misread (or a line was dropped), and posting the draft silently would book
 * the wrong cost. The check is exact bigint arithmetic — a misread on a
 * billion-Rial invoice is still one Rial off, never a float "close enough".
 *
 * Returns null when there is nothing to check (the scan found no grand
 * total) or when the figures agree; otherwise the exact expected/actual/
 * difference as decimal text for the approval prompt. The caller must hold
 * the submission until the operator explicitly approves the mismatch.
 */
export function ocrGrandTotalMismatch(input: {
  /** The printed grand total as OCR read it (Rial); null when not found. */
  grandTotalRial: number | string | null;
  /** The draft's line totals (Rial, decimal text or safe integers). */
  lineTotalsRial: Array<number | string>;
  /** The draft's VAT (Rial). */
  vatRial: number | string;
}): { grandTotal: string; linesPlusVat: string; difference: string } | null {
  const toBigInt = (value: number | string): bigint | null => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) return null;
      return BigInt(value);
    }
    const text = value.trim();
    if (!/^\d{1,19}$/.test(text)) return null;
    return BigInt(text);
  };

  if (input.grandTotalRial === null) return null;
  const grandTotal = toBigInt(input.grandTotalRial);
  // An unreadable grand total cannot be cross-checked; treating it as a
  // mismatch would demand approval for every scan with a smudged footer.
  if (grandTotal === null) return null;

  let sum = 0n;
  for (const line of input.lineTotalsRial) {
    const parsed = toBigInt(line);
    // A malformed line is caught by the form's own validation; the
    // cross-check only compares figures that are actually numbers.
    if (parsed === null) return null;
    sum += parsed;
  }
  const vat = toBigInt(input.vatRial);
  if (vat === null) return null;
  const linesPlusVat = sum + vat;

  if (linesPlusVat === grandTotal) return null;
  const difference = grandTotal - linesPlusVat;
  return {
    grandTotal: grandTotal.toString(),
    linesPlusVat: linesPlusVat.toString(),
    difference: (difference < 0n ? -difference : difference).toString(),
  };
}
