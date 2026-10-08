import type { PoolClient } from "pg";
import { enqueueHolooPurchase } from "./integrations/holoo/outbox-producer";
import { positiveQuantityText, rialText } from "./inventory-exact";
import { getInventorySystem } from "./inventory-service";
import {
  postExactPurchaseEntry,
  postNegativeStockSettlementEntry,
  postPeriodicPurchaseEntry,
} from "./ledger-service";
import { applyPurchaseReceiptCosting } from "./purchase-receipt-costing";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { Role } from "./auth-edge";

export const PURCHASE_SETTLEMENT_METHODS = ["cash", "bank", "credit"] as const;
export type PurchaseSettlementMethod = (typeof PURCHASE_SETTLEMENT_METHODS)[number];

/**
 * Receives an existing draft/ordered purchase inside the caller's transaction.
 * Routes and sync both call this exact stock + accounting implementation.
 */
export async function receivePurchaseInTransaction(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    settlementMethod: PurchaseSettlementMethod;
    supplierId?: string | null;
    createdBy: string | null;
    sync?: { actorRole: Role; clientEventId?: string };
  },
): Promise<{ id: string; inventoryEventId: string | null; duplicate: boolean }> {
  const { rows: locked } = await client.query<{
    id: string;
    status: string;
    total: string;
    supplier_id: string | null;
    vat_amount: string;
  }>(
    "SELECT id,status::text,total::text,supplier_id,vat_amount::text FROM purchases WHERE id=$1 AND location_id=$2 FOR UPDATE",
    [params.purchaseId, params.locationId],
  );
  const purchase = locked[0];
  if (!purchase) throw new Error("purchase_not_found");
  if (purchase.status === "received") {
    const prior = await client.query<{ id: string }>(
      "SELECT id FROM inventory_events WHERE business_id=$1 AND source_type='purchase' AND source_id=$2 ORDER BY occurred_at LIMIT 1",
      [params.businessId, params.purchaseId],
    );
    return { id: params.purchaseId, inventoryEventId: prior.rows[0]?.id ?? null, duplicate: true };
  }
  if (purchase.status !== "draft" && purchase.status !== "ordered") throw new Error("invalid_transition");

  const supplierId = params.supplierId?.trim() || purchase.supplier_id;
  if (params.settlementMethod === "credit" && !supplierId) throw new Error("supplier_required");
  const appendOutbox = async () => {
    if (!params.sync) return;
    await appendSyncOutboxEvent(client, {
      locationId: params.locationId,
      clientEventId: params.sync.clientEventId ?? `purchase:receive:${params.purchaseId}`,
      eventType: "inventory.purchase.received",
      payload: { purchaseId: params.purchaseId, settlementMethod: params.settlementMethod, supplierId },
      actorUserId: params.createdBy,
      actorRole: params.sync.actorRole,
    });
  };
  if (supplierId && supplierId !== purchase.supplier_id) {
    const owned = await client.query("SELECT 1 FROM suppliers WHERE id=$1 AND location_id=$2", [supplierId, params.locationId]);
    if (owned.rowCount !== 1) throw new Error("supplier_not_found");
    await client.query("UPDATE purchases SET supplier_id=$2 WHERE id=$1", [params.purchaseId, supplierId]);
  }

  const totals = await client.query<{ total: string }>(
    "SELECT COALESCE(sum(extended_cost),0)::text total FROM purchase_items WHERE purchase_id=$1",
    [params.purchaseId],
  );
  if (totals.rows[0].total !== purchase.total) throw new Error("purchase_total_mismatch");
  // Audit F11 — the supplier invoice's VAT, stored on the purchase while it was
  // a draft. Posted to input VAT on top of the goods value (see
  // `purchaseSettlementLines`); `total` stays the goods value the costing checks.
  const vat = rialText(purchase.vat_amount);

  if ((await getInventorySystem(params.businessId, client)) === "periodic") {
    await client.query(
      "UPDATE purchases SET status='received',received_at=now(),settlement_method=$2 WHERE id=$1",
      [params.purchaseId, params.settlementMethod],
    );
    await postPeriodicPurchaseEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      purchaseId: params.purchaseId,
      createdBy: params.createdBy,
      total: rialText(totals.rows[0].total),
      settlementMethod: params.settlementMethod,
      vat,
    });
    await enqueueHolooPurchase(client, params.businessId, params.purchaseId, "purchase");
    await appendOutbox();
    return { id: params.purchaseId, inventoryEventId: null, duplicate: false };
  }

  const items = await client.query<{
    id: string;
    inventory_item_id: string;
    quantity: string;
    extended_cost: string;
  }>(
    `SELECT id,inventory_item_id,quantity::text,extended_cost::text
       FROM purchase_items WHERE purchase_id=$1 ORDER BY inventory_item_id,id`,
    [params.purchaseId],
  );
  const event = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key)
     VALUES($1,$2,'purchase_receipt','purchase',$3,$4,2,$5) RETURNING id`,
    [params.businessId, params.locationId, params.purchaseId, params.createdBy, `purchase-receipt:${params.purchaseId}`],
  );
  const inventoryEventId = event.rows[0].id;
  const costing = await applyPurchaseReceiptCosting(client, {
    locationId: params.locationId,
    businessId: params.businessId,
    purchaseId: params.purchaseId,
    inventoryEventId,
    createdBy: params.createdBy,
    items: items.rows.map((item) => ({
      purchaseItemId: item.id,
      inventoryItemId: item.inventory_item_id,
      quantity: positiveQuantityText(item.quantity),
      extendedCost: rialText(item.extended_cost),
    })),
  });
  if (costing.receiptValue !== rialText(purchase.total)) throw new Error("purchase_total_mismatch");
  await client.query(
    "UPDATE purchases SET status='received',received_at=now(),settlement_method=$2 WHERE id=$1",
    [params.purchaseId, params.settlementMethod],
  );
  await postExactPurchaseEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    purchaseId: params.purchaseId,
    createdBy: params.createdBy,
    total: costing.receiptValue,
    settlementMethod: params.settlementMethod,
    inventoryEventId,
    vat,
  });
  await postNegativeStockSettlementEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    purchaseId: params.purchaseId,
    createdBy: params.createdBy,
    upward: costing.upwardSettlementAdjustment,
    downward: costing.downwardSettlementAdjustment,
    inventoryEventId,
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
  await enqueueHolooPurchase(client, params.businessId, params.purchaseId, "purchase");
  await appendOutbox();
  return { id: params.purchaseId, inventoryEventId, duplicate: false };
}
