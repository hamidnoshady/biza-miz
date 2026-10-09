/**
 * The one place a print request becomes an actual document, loaded from the
 * database and authorized against the caller's branch.
 *
 * Every persisted document the product prints — a sale's receipt, its formal
 * invoice, its kitchen ticket, a shelf label — arrives here as a reference and
 * leaves as the product's own document data. Nothing a browser sends is
 * rendered, so nothing a browser sends has to be believed: the receipts come
 * from the order's rows, the labels from the barcode's, and the branch scope is
 * the active location the request was resolved against.
 *
 * The loaders themselves are the ones the whole product already trusts:
 * `getOrderDetail` (order-read-service.ts) for a sale, the retail invoice's
 * `getRetailInvoicePrintData` (the canonical builder its own screens and
 * `?view=print` use) when that sale is a retail sale, and
 * `getLabelPrintData` for a label. This module only dispatches, decides which
 * document types each kind may print as, and turns "not in this branch" into
 * the 404 the route answers with.
 */
import { getOrderDetail } from "../order-read-service";
import { getRetailInvoicePrintData } from "../retail-invoice/print-data";
import type { DocType } from "../print-template";
import type { PrintDocumentRef } from "./document-request";
import { documentTypesFor } from "./document-request";
import type { PrinterErrorCode } from "./errors";
import { loadPrintIdentity } from "./identity";
import { getLabelPrintData } from "./label-print-data";
import { buildOrderKitchenTicket, buildOrderReceipt } from "./order-print-data";
import type { PrintJob } from "./render-service";

export interface LoadedPrintDocument {
  job: PrintJob;
  /**
   * The row this print documents — the sale's order id, or the barcode's id.
   * Server-derived, so a hand-edited request cannot file its print under
   * another document's history.
   */
  entityId: string;
  /** Which loader answered — logged with the render, so support can see where the bytes came from. */
  source: PrintDocumentRef["kind"];
}

export type DocumentLoadResult =
  | { ok: true; document: LoadedPrintDocument }
  | { ok: false; status: number; error: PrinterErrorCode };

export interface LoadPrintDocumentInput {
  businessId: string;
  /** The caller's active branch: the only branch a document may be loaded from. */
  locationId: string;
  document: PrintDocumentRef;
  /** The document type the caller asked to print it as (the plan was resolved for it already). */
  documentType: DocType;
}

export async function loadPrintDocument(input: LoadPrintDocumentInput): Promise<DocumentLoadResult> {
  if (!documentTypesFor(input.document).includes(input.documentType)) {
    // Printing a kitchen ticket through the receipt rule (or a receipt as a
    // label) is not a routing question: it is a different document. The two
    // shapes are refused here, before a plan is even consulted.
    return { ok: false, status: 409, error: "document_type_mismatch" };
  }

  switch (input.document.kind) {
    case "order-receipt":
      return loadSaleReceipt(input);
    case "kitchen-ticket":
      return loadKitchenTicket(input);
    case "item-label":
      return loadItemLabel(input);
  }
}

/** A sale's receipt or formal invoice, built from the sale's own rows. */
async function loadSaleReceipt(input: LoadPrintDocumentInput): Promise<DocumentLoadResult> {
  const orderId = input.document.orderId!;
  const detail = await getOrderDetail(input.locationId, orderId);
  if (!detail) return { ok: false, status: 404, error: "document_not_found" };

  // A retail sale is an invoice, and `getRetailInvoicePrintData` is its
  // canonical builder — the same one its own screens, its reprint endpoint and
  // `?view=print` use, with the per-line detail (gold breakdown, serial,
  // batch) a retail receipt carries. Printing the same sale from the orders
  // screen therefore produces the same paper as printing it from the till.
  if (detail.order.type === "retail") {
    const retail = await getRetailInvoicePrintData(input.businessId, input.locationId, orderId);
    if (retail) {
      return { ok: true, document: { job: { type: "receipt", receipt: retail.receipt }, entityId: orderId, source: "order-receipt" } };
    }
    // A retail order whose lines cannot be read as an invoice (a row written
    // before retail invoicing existed) still prints — through the generic sale
    // builder, from the same rows.
  }

  const { business, currencyUnit } = await loadPrintIdentity(input.businessId, input.locationId);
  return {
    ok: true,
    document: {
      job: { type: "receipt", receipt: buildOrderReceipt(detail, business, currencyUnit) },
      entityId: orderId,
      source: "order-receipt",
    },
  };
}

async function loadKitchenTicket(input: LoadPrintDocumentInput): Promise<DocumentLoadResult> {
  const orderId = input.document.orderId!;
  const detail = await getOrderDetail(input.locationId, orderId);
  if (!detail) return { ok: false, status: 404, error: "document_not_found" };
  return {
    ok: true,
    document: { job: { type: "kitchen-ticket", ticket: buildOrderKitchenTicket(detail) }, entityId: orderId, source: "kitchen-ticket" },
  };
}

async function loadItemLabel(input: LoadPrintDocumentInput): Promise<DocumentLoadResult> {
  const label = await getLabelPrintData({
    businessId: input.businessId,
    locationId: input.locationId,
    itemId: input.document.itemId!,
    code: input.document.code ?? null,
  });
  if (!label) return { ok: false, status: 404, error: "document_not_found" };
  return {
    ok: true,
    document: { job: { type: "label", label: label.label }, entityId: label.entityId, source: "item-label" },
  };
}
