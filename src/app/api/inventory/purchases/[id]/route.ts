import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import {
  MissingLedgerAccountError,
  postExactPurchaseEntry,
  postNegativeStockSettlementEntry,
  postPeriodicPurchaseEntry,
} from "@/lib/ledger-service";
import { positiveQuantityText, rialText } from "@/lib/inventory-exact";
import { getInventorySystem } from "@/lib/inventory-service";
import { applyPurchaseReceiptCosting } from "@/lib/purchase-receipt-costing";
import {
  preparePurchaseLines,
  purchaseDateOrNull,
  PurchaseLineError,
  type PurchaseItemInput,
  type PurchaseLine,
} from "@/lib/purchase-lines";
import { resolveActiveLocation } from "@/lib/setup-state";
import { enqueueHolooPurchase } from "@/lib/integrations/holoo/outbox-producer";
import { receivePurchaseInTransaction } from "@/lib/purchase-receive-service";
import { PurchaseServiceError, SUPPLIER_INVOICE_DUE_DATE_SQL, supplierInvoiceOrError } from "@/lib/purchase-service";
import type { SupplierInvoiceInput } from "@/lib/payables-input";

const SETTLEMENT_METHODS = ["cash", "bank", "credit"] as const;
type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: header } = await query(
    `SELECT p.*, s.name AS supplier_name FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.location_id = p.location_id
      WHERE p.id = $1 AND p.location_id = $2`,
    [id, location.id],
  );
  if (!header[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { rows: items } = await query(
    `SELECT pi.id, pi.inventory_item_id, ii.name AS inventory_item_name, ii.unit,
            ii.purchase_unit, ii.purchase_unit_factor,
            pi.quantity, pi.unit_cost, pi.extended_cost,
            (SELECT il.id FROM inventory_lots il
              WHERE il.source_type = 'purchase' AND il.source_id = pi.purchase_id
                AND il.inventory_item_id = pi.inventory_item_id AND il.remaining_qty > 0
              ORDER BY il.received_at, il.id LIMIT 1) AS inventory_lot_id
       FROM purchase_items pi JOIN inventory_items ii ON ii.id = pi.inventory_item_id
      WHERE pi.purchase_id = $1 AND ii.location_id = $2
        AND EXISTS (SELECT 1 FROM purchases p WHERE p.id=pi.purchase_id AND p.location_id=$2)`,
    [id, location.id],
  );
  return NextResponse.json({ purchase: header[0], items });
});

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["ordered", "received", "cancelled"],
  ordered: ["received", "cancelled"],
  received: [],
  cancelled: [],
};

/**
 * Edits an unreceived purchase's supplier, date, note, and lines.
 *
 * Only draft/ordered are editable. A received purchase has already moved
 * stock, rolled cost basis forward, and posted its journal entry, so
 * correcting one is a supplier return (POST /api/inventory/supplier-returns),
 * not an edit — the same reason DELETE refuses a received purchase. A
 * cancelled purchase is a closed record.
 *
 * Lines are replaced wholesale rather than diffed: nothing references an
 * unreceived purchase's purchase_items (the costing allocations and return
 * lines that do only exist once it's received, and those statuses are
 * rejected above), so there is no identity worth preserving, and a full
 * replace can't leave a stale line behind.
 */
export const PUT = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: {
    supplierId?: string | null;
    note?: string;
    purchaseDate?: string | null;
    items?: PurchaseItemInput[];
    /** Audit F11 — the supplier invoice block; omitted = leave the stored one alone. */
    invoice?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.supplierId) {
    const { rows: supplier } = await query(
      "SELECT id FROM suppliers WHERE id = $1 AND location_id = $2",
      [body.supplierId, location.id],
    );
    if (supplier.length === 0) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }

  let lines: PurchaseLine[];
  let total: string;
  let purchaseDate: string | null;
  let invoice: SupplierInvoiceInput | null = null;
  try {
    purchaseDate = purchaseDateOrNull(body.purchaseDate);
    ({ lines, total } = await preparePurchaseLines(body.items ?? [], location.id));
    if (body.invoice !== undefined) invoice = supplierInvoiceOrError(body.invoice);
  } catch (err) {
    if (err instanceof PurchaseLineError || err instanceof PurchaseServiceError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: locked } = await client.query<{ status: string }>(
      "SELECT status FROM purchases WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [id, location.id],
    );
    const purchase = locked[0];
    if (!purchase) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (purchase.status === "received") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "purchase_received_cannot_edit" }, { status: 409 });
    }
    if (purchase.status === "cancelled") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "purchase_cancelled_cannot_edit" }, { status: 409 });
    }

    // A cleared date field means "leave the stored date alone", not "reset to
    // today" — the edit form always opens prefilled, so an empty value is a
    // caller that isn't touching the date.
    await client.query(
      `UPDATE purchases SET supplier_id = $2, note = $3, total = $4,
              purchase_date = COALESCE($6::date, purchase_date)
        WHERE id = $1 AND location_id = $5`,
      [id, body.supplierId || null, body.note?.trim() || null, total, location.id, purchaseDate],
    );
    if (invoice) {
      // A received purchase is refused above, so the VAT stored here is always
      // the one its receipt will post.
      await client.query(
        `UPDATE purchases
            SET supplier_invoice_number = $2, supplier_invoice_date = $3::date, vat_amount = $4,
                payment_terms_days = $5::integer,
                payment_due_date = ${SUPPLIER_INVOICE_DUE_DATE_SQL("$6", "$5", "$3", "purchase_date")}
          WHERE id = $1`,
        [id, invoice.invoiceNumber, invoice.invoiceDate, invoice.vatAmount, invoice.paymentTermsDays, invoice.dueDate],
      );
    }
    await client.query("DELETE FROM purchase_items WHERE purchase_id = $1", [id]);
    for (const line of lines) {
      await client.query(
        `INSERT INTO purchase_items (purchase_id, inventory_item_id, quantity, unit_cost, extended_cost)
         VALUES ($1, $2, $3, $4::numeric / $3::numeric, $4)`,
        [id, line.inventoryItemId, line.baseQty, line.totalCost],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, total });
});

/** Status transitions: draft -> ordered (optional formal PO step) -> received, or straight to received/cancelled. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { status?: string; settlementMethod?: string; supplierId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const nextStatus = body.status;
  if (!nextStatus) return NextResponse.json({ error: "invalid_transition" }, { status: 409 });

  // received: increases stock, (weighted-average) rolls avg_cost forward, and
  // posts the Phase 7 journal entry (Debit Inventory / Credit AP or Cash/Bank).
  const settlementMethod: SettlementMethod = SETTLEMENT_METHODS.includes(body.settlementMethod as SettlementMethod)
    ? (body.settlementMethod as SettlementMethod)
    : "credit";
  const supplierId = body.supplierId?.trim() || null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (nextStatus !== "received") {
      const { rows } = await client.query<{ status: string }>(
        "SELECT status::text FROM purchases WHERE id=$1 AND location_id=$2 FOR UPDATE",
        [id, location.id],
      );
      const purchase = rows[0];
      if (!purchase) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (!(VALID_TRANSITIONS[purchase.status] ?? []).includes(nextStatus)) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
      }
      await client.query(
        `UPDATE purchases SET status=$2::purchase_status,
                ordered_at=CASE WHEN $2::purchase_status='ordered' THEN now() ELSE ordered_at END
          WHERE id=$1`,
        [id, nextStatus],
      );
    } else {
      await receivePurchaseInTransaction(client, {
        businessId: session.businessId,
        locationId: location.id,
        purchaseId: id,
        settlementMethod,
        supplierId,
        createdBy: session.sub,
        sync: { actorRole: session.role },
      });
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const code = err instanceof Error ? err.message : "apply_failed";
    const status = code.endsWith("_not_found") ? 404 : code === "supplier_required" ? 400 : 409;
    return NextResponse.json({ error: code }, { status });
  } finally {
    client.release();
  }
});

/**
 * Remove an unreceived purchase and its draft lines. A received purchase has
 * already changed stock and posted accounting entries, so it must be reversed
 * through an inventory return rather than deleted.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      "SELECT status FROM purchases WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [id, location.id],
    );
    const purchase = rows[0];
    if (!purchase) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (purchase.status === "received") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "purchase_received_cannot_delete" }, { status: 409 });
    }

    // purchase_items has ON DELETE CASCADE. Restrict this to the locked,
    // active-location purchase so a stale id can never delete another branch.
    await client.query("DELETE FROM purchases WHERE id = $1 AND location_id = $2", [id, location.id]);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true });
});
