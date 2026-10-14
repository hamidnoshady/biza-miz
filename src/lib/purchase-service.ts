/**
 * Phase 31 — the draft-purchase write and the status transition, callable
 * without a request. Extracted verbatim from POST /api/inventory/purchases and
 * PATCH /api/inventory/purchases/[id] so the route handlers and an unattended
 * autopilot run share one implementation rather than two that can drift.
 */
import { getPool, query, type PoolClient } from "./db";
import { preparePurchaseLines, purchaseDateOrNull, type PurchaseItemInput } from "./purchase-lines";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { Role } from "./auth-edge";
import { getMediaAsset } from "./media-service";
import { EMPTY_SUPPLIER_INVOICE, parseSupplierInvoice, PayablesInputError, type SupplierInvoiceInput } from "./payables-input";

export class PurchaseServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "PurchaseServiceError";
  }
}

export interface CreateDraftPurchaseInput {
  locationId: string;
  purchaseId?: string;
  supplierId?: string | null;
  note?: string;
  purchaseDate?: string | null;
  items: PurchaseItemInput[];
  createdBy: string | null;
  /** Present on normal site writes; omitted by cloud replay and automation. */
  sync?: { actorRole: Role; clientEventId?: string };
  /** Required whenever invoiceAssetId is set, so the asset can be
   * re-validated against this tenant (see below) — every current caller that
   * ever sets invoiceAssetId (the purchases route) already has this from its
   * session; autopilot/sync callers never set invoiceAssetId and may omit it. */
  businessId?: string;
  /** Migration 0179 — the canonical Media asset for the supplier-invoice
   * photo this draft was scanned from (`POST /api/ai/invoice-ocr`), when the
   * operator applied an OCR result rather than typing the purchase by hand.
   * Re-validated server-side against `businessId` so a stale or cross-tenant
   * id from the client can never be linked onto someone else's purchase —
   * the same pattern `expense-service.recordExpense` uses for receiptAssetId. */
  invoiceAssetId?: string | null;
  /**
   * Audit F11 — the supplier's invoice: number, date, VAT (integer Rial),
   * payment terms and due date. Raw input; validated by `parseSupplierInvoice`.
   * Omitted means an invoice with none of them and no VAT — never a rate the
   * server guessed.
   */
  invoice?: unknown;
}

/** The supplier-invoice block, with a parse failure in this service's error vocabulary. */
export function supplierInvoiceOrError(raw: unknown): SupplierInvoiceInput {
  try {
    return parseSupplierInvoice(raw);
  } catch (err) {
    if (err instanceof PayablesInputError) throw new PurchaseServiceError(err.code, 400);
    throw err;
  }
}

/**
 * The SQL that stores a supplier invoice on a purchase row. The due date is
 * the explicit one, else the invoice date (or the purchase date) plus the
 * terms — the same rule `resolvePaymentDueDate` states for the screen.
 */
export const SUPPLIER_INVOICE_DUE_DATE_SQL = (dueParam: string, termsParam: string, invoiceDateParam: string, purchaseDateExpr: string) =>
  `COALESCE(${dueParam}::date, COALESCE(${invoiceDateParam}::date, ${purchaseDateExpr}) + ${termsParam}::integer)`;

export async function createDraftPurchaseInTransaction(
  client: PoolClient,
  input: CreateDraftPurchaseInput,
): Promise<{ id: string; total: string }> {
  if (input.supplierId) {
    const { rows: supplier } = await client.query("SELECT id FROM suppliers WHERE id = $1 AND location_id = $2", [
      input.supplierId,
      input.locationId,
    ]);
    if (supplier.length === 0) throw new PurchaseServiceError("supplier_not_found", 404);
  }

  const invoiceAssetId = input.invoiceAssetId?.trim() || null;
  if (invoiceAssetId) {
    const asset = input.businessId ? await getMediaAsset(input.businessId, invoiceAssetId) : null;
    if (!asset) throw new PurchaseServiceError("invoice_asset_not_found", 404);
  }

  const invoice = input.invoice === undefined ? EMPTY_SUPPLIER_INVOICE : supplierInvoiceOrError(input.invoice);
  const purchaseDate = purchaseDateOrNull(input.purchaseDate);
  const { lines, total } = await preparePurchaseLines(input.items, input.locationId, client);
  const { rows: purchaseRows } = await client.query<{ id: string }>(
    `WITH d AS (
       SELECT COALESCE($5::date, (SELECT app_business_date(now(), l.timezone, l.business_day_start_minutes)
                                    FROM locations l WHERE l.id = $1)) AS purchase_date
     )
     INSERT INTO purchases (id, location_id, supplier_id, status, total, note, purchase_date, created_by, invoice_asset_id,
                            supplier_invoice_number, supplier_invoice_date, vat_amount, payment_terms_days, payment_due_date)
     SELECT COALESCE($7::uuid, gen_random_uuid()), $1, $2, 'draft', $3, $4, d.purchase_date, $6, $8,
            $9, $10::date, $11, $12::integer, ${SUPPLIER_INVOICE_DUE_DATE_SQL("$13", "$12", "$10", "d.purchase_date")}
       FROM d
     RETURNING id`,
    [
      input.locationId,
      input.supplierId || null,
      total,
      input.note?.trim() || null,
      purchaseDate,
      input.createdBy,
      input.purchaseId ?? null,
      invoiceAssetId,
      invoice.invoiceNumber,
      invoice.invoiceDate,
      invoice.vatAmount,
      invoice.paymentTermsDays,
      invoice.dueDate,
    ],
  );
  const purchaseId = purchaseRows[0].id;
  for (const line of lines) {
    await client.query(
      `INSERT INTO purchase_items (purchase_id, inventory_item_id, quantity, unit_cost, extended_cost)
       VALUES ($1, $2, $3, $4::numeric / $3::numeric, $4)`,
      [purchaseId, line.inventoryItemId, line.baseQty, line.totalCost],
    );
  }
  if (input.sync) {
    await appendSyncOutboxEvent(client, {
      locationId: input.locationId,
      clientEventId: input.sync.clientEventId ?? `purchase:create:${purchaseId}`,
      eventType: "inventory.purchase.created",
      payload: {
        purchaseId,
        supplierId: input.supplierId ?? null,
        note: input.note?.trim() || null,
        purchaseDate,
        items: input.items,
        invoice,
      },
      actorUserId: input.createdBy,
      actorRole: input.sync.actorRole,
    });
  }
  return { id: purchaseId, total };
}

export async function createDraftPurchase(input: CreateDraftPurchaseInput): Promise<{ id: string; total: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createDraftPurchaseInTransaction(client, input);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancels a draft purchase — the undo path for an autopilot-created draft PO.
 * Only a draft may be cancelled this way: once a purchase is ordered or
 * received it has stock and ledger effects that a status flip must not skip.
 */
export async function cancelDraftPurchase(locationId: string, purchaseId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE purchases SET status = 'cancelled'
      WHERE id = $1 AND location_id = $2 AND status = 'draft'`,
    [purchaseId, locationId],
  );
  return (rowCount ?? 0) > 0;
}
