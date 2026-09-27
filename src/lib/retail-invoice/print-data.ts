/**
 * The one place a retail invoice becomes a printable receipt.
 *
 * `buildRetailInvoiceReceipt` is a pure function of `RetailInvoiceDetail` (no
 * DB, no Next, no clock) — the exact same call a fresh sale's first print and
 * a months-later reprint both make, so the two can never drift apart the way
 * the old code did (reprint used to re-run `new Date()` for the issue date
 * and hardcode the discount to zero — see retail-invoice-screen.tsx's history).
 *
 * `getRetailInvoicePrintData` is the thin DB-touching wrapper: it loads the
 * detail plus the business/location header info and calls the pure builder.
 * Both the POST-issue first print and the GET .../[id] reprint endpoint call
 * this wrapper — neither hand-rolls its own `ReceiptData`.
 */
import { query } from "../db";
import { getSetting, SETTING_KEYS } from "../settings";
import type { ReceiptBusinessInfo, ReceiptData, ReceiptLine } from "../receipt-template";
import { getRetailInvoiceDetail } from "./read-service";
import type { RetailInvoiceDetail, RetailInvoiceDetailLine, RetailInvoicePrintDataMeta } from "./types";

function toLine(line: RetailInvoiceDetailLine): ReceiptLine {
  const base: ReceiptLine = {
    name: line.nameSnapshot,
    quantity: Number(line.quantity),
    lineTotal: Number(line.total),
  };
  switch (line.kind) {
    case "gold":
      return {
        ...base,
        goldBreakdown: {
          metalValue: Number(line.metalValue),
          makingCharge: Number(line.makingCharge),
          profit: Number(line.profit),
          netWeight: line.netWeight,
          purity: line.purity,
        },
      };
    case "watch":
      return {
        ...base,
        serialProvenance: line.provenance
          ? { conditionGrade: line.provenance.conditionGrade, boxAndPapers: line.provenance.boxAndPapers }
          : null,
        serial: {
          serialNumber: line.serialNumber,
          warrantyMonths: line.warrantyMonths,
          warrantyEndDate: line.warrantyEndDate ?? null,
        },
      };
    case "cosmetic":
      return {
        ...base,
        batch: line.batchNumbers.length
          ? { batchNumber: line.batchNumbers.join("، "), expiryDate: line.expiryDate }
          : null,
      };
    case "accessory":
    case "stocked":
      return base;
    case "legacy":
      return {
        ...base,
        goldBreakdown:
          line.metalValue != null && line.makingCharge != null && line.profit != null
            ? {
                metalValue: Number(line.metalValue),
                makingCharge: Number(line.makingCharge),
                profit: Number(line.profit),
                // Pre-migration rows never recorded weight/purity per line —
                // shown without them rather than guessed.
                netWeight: null,
                purity: null,
              }
            : null,
      };
  }
}

/** Pure transform — unit tested directly in print-data.test.ts, no DB fixture required. */
export function buildRetailInvoiceReceipt(
  detail: RetailInvoiceDetail,
  business: ReceiptBusinessInfo,
): ReceiptData {
  const voidedSuffix = detail.status === "voided" ? " (باطل‌شده)" : "";
  return {
    business,
    orderLabel: `فاکتور ${detail.orderNumber}`,
    orderTypeLabel: `فاکتور فروش${voidedSuffix}`,
    customerName: detail.customer?.name ?? null,
    // The invoice's real, original issue moment — never `new Date()`, so a
    // reprint months later still shows the day the sale actually happened.
    issuedAt: detail.issuedAt,
    lines: detail.lines.map(toLine),
    subtotal: detail.subtotal,
    discount: detail.discount,
    tax: detail.tax,
    total: detail.total,
    paymentMethod: detail.payments[0]?.method ?? null,
    payments: detail.payments.length
      ? detail.payments.map((p) => ({ label: p.methodLabel, amount: p.amount }))
      : null,
    cashierName: detail.cashierName,
    unit: detail.currencyUnit,
  };
}

/**
 * The DB-touching wrapper both the first-print call site and the
 * `/api/sales/invoices/[id]` reprint route use. Returns null when the order
 * does not resolve to a retail invoice owned by this business (the caller
 * turns that into 404).
 */
export async function getRetailInvoicePrintData(
  businessId: string,
  locationId: string,
  orderId: string,
): Promise<{ receipt: ReceiptData; meta: RetailInvoicePrintDataMeta } | null> {
  const detail = await getRetailInvoiceDetail(businessId, locationId, orderId);
  if (!detail) return null;

  const [{ rows: businessRows }, { rows: locationRows }, profile] = await Promise.all([
    query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [businessId]),
    // The invoice's own location — not the viewer's currently active branch,
    // so a manager reprinting a sale from another branch still sees that
    // branch's address/phone on the paper, not their own.
    query<{ address: string | null; phone: string | null }>(
      "SELECT address, phone FROM locations WHERE id = $1",
      [detail.locationId],
    ),
    getSetting<{ receiptFooter?: string }>(businessId, SETTING_KEYS.businessProfile),
  ]);

  const business: ReceiptBusinessInfo = {
    name: businessRows[0]?.name ?? "",
    address: locationRows[0]?.address ?? null,
    phone: locationRows[0]?.phone ?? null,
    footerMessage: profile?.receiptFooter ?? null,
  };

  const legacy = detail.lines.some((l) => l.kind === "legacy");
  return { receipt: buildRetailInvoiceReceipt(detail, business), meta: { legacy } };
}
