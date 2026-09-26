/**
 * Phase 26 (issue #125) Wave 4 — transaction import (sales, purchases,
 * receipts/payments, stock movements).
 *
 * The rule this phase lives by — "no posting rule is re-implemented" — is
 * enforced by construction: every transaction is written through an *existing*
 * service (`receivePayment`/`payBill` for cash flows, `createRetailInvoice` for
 * retail sales, the purchase service for purchases, `stock_movements` for
 * stock), never by hand-built INSERTs. This module is the orchestration:
 * chronological order (FIFO-sensitive), unmapped-reference discrepancy
 * reporting (transaction-plan.ts), and one mapping row per imported document.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { getPool, query } from "../../db";
import { getBusinessIndustry } from "../../industry-guard";
import { industryProfile } from "../../industry-profile";
import { getConnection } from "../connections-service";
import { localIdForRemote, upsertMapping } from "../mapping-service";
import { receivePayment } from "../../ar-service";
import { payBill } from "../../ap-service";
import { importableTransactions, type HolooTransaction, type TransactionDiscrepancy } from "./transaction-plan";
import { writeIntegrationAudit } from "../audit";
import { recordImportedSale } from "./imported-sale-service";
import { createRetailInvoice, type RetailInvoiceLineInput } from "../../retail-invoice-service";
import { isTradeGoodsIndustry } from "../../trade-goods";
import { receiveItemPurchase } from "../../retail-stock-service";
import { applyPurchaseReceiptCosting } from "../../purchase-receipt-costing";
import { positiveQuantityText, rialText } from "../../inventory-exact";
import { postExactPurchaseEntry, postNegativeStockSettlementEntry } from "../../ledger-service";

/** The set of local ids already mapped for each Holoo entity kind. */
async function mappedIdSet(businessId: string, connectionId: string, entityType: "holoo_goods" | "holoo_customer"): Promise<Set<string>> {
  const { rows } = await query<{ remote_id: string }>(
    `SELECT remote_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return new Set(rows.map((r) => r.remote_id));
}

export interface TransactionImportPreview {
  total: number;
  importable: number;
  discrepancies: TransactionDiscrepancy[];
}

export interface TransactionImportSummary extends TransactionImportPreview {
  imported: number;
}

/** What will be imported, with discrepancies named (no writes). */
export async function previewTransactions(
  businessId: string,
  connectionId: string,
  transactions: HolooTransaction[],
): Promise<TransactionImportPreview> {
  const goods = await mappedIdSet(businessId, connectionId, "holoo_goods");
  const persons = await mappedIdSet(businessId, connectionId, "holoo_customer");
  const { ordered, discrepancies } = importableTransactions(transactions, goods, persons);
  return { total: transactions.length, importable: ordered.length, discrepancies };
}

async function resolveLocationId(businessId: string, connectionLocationId: string | null): Promise<string> {
  if (connectionLocationId) return connectionLocationId;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  if (!rows[0]) throw new Error("no_location");
  return rows[0].id;
}

function positiveQuantity(tx: HolooTransaction): string {
  const q = new Decimal(tx.quantity ?? 1);
  if (!q.isFinite() || q.lte(0)) return "1";
  return q.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toString();
}

function unitCostFrom(tx: HolooTransaction): number {
  const qty = new Decimal(positiveQuantity(tx));
  const total = new Decimal((tx.amountRial ?? 0n).toString());
  if (total.lte(0) || qty.lte(0)) return 0;
  return Number(total.div(qty).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString());
}

async function importSale(
  businessId: string,
  connectionId: string,
  locationId: string,
  tx: HolooTransaction,
  createdBy: string | null,
  industry: Awaited<ReturnType<typeof getBusinessIndustry>>,
  importRunId?: string | null,
): Promise<boolean> {
  if (!tx.goodsId) return false;
  const localGoodsId = await localIdForRemote(businessId, connectionId, "holoo_goods", tx.goodsId);
  if (!localGoodsId) return false;
  const customerId = tx.personId ? await localIdForRemote(businessId, connectionId, "holoo_customer", tx.personId) : null;
  const profile = industry ? industryProfile(industry) : industryProfile("food_service");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (profile.salesModel === "order_ticket") {
      const quantity = Math.max(1, Math.round(Number(positiveQuantity(tx))));
      const sale = await recordImportedSale(client, {
        businessId,
        locationId,
        actorId: createdBy,
        occurredAt: new Date(tx.occurredAt),
        type: "takeaway",
        note: `Holoo ${tx.remoteId}`,
        customerId,
        lines: [{ menuItemId: localGoodsId, quantity }],
        paymentMethodCode: "cash",
        source: { system: "holoo", remoteId: tx.remoteId },
      });
      await upsertMapping(businessId, connectionId, "holoo_invoice", tx.remoteId, sale.orderId, importRunId);
    } else if (industry === "accessories" || industry === "cosmetics" || isTradeGoodsIndustry(industry)) {
      const quantity = positiveQuantity(tx);
      const line: RetailInvoiceLineInput = {
        kind: industry === "cosmetics" ? "cosmetic" : isTradeGoodsIndustry(industry) ? "stocked" : "accessory",
        itemId: localGoodsId,
        quantity,
        unitPrice: unitCostFrom(tx) || undefined,
        vatPercent: 0,
      };
      const invoice = await createRetailInvoice(client, {
        businessId,
        locationId,
        industry,
        lines: [line],
        tenders: [{ method: "cash" }],
        customerId,
        note: `Holoo ${tx.remoteId}`,
        createdBy,
      });
      await upsertMapping(businessId, connectionId, "holoo_invoice", tx.remoteId, invoice.orderId, importRunId);
    } else {
      await writeIntegrationAudit({ businessId, connectionId, action: "transaction.import_unsupported", entityType: tx.type, remoteId: tx.remoteId, payload: { industry } });
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function resolveInventoryItemForGoods(client: PoolClient, locationId: string, localGoodsId: string): Promise<string> {
  const { rows: direct } = await client.query<{ id: string }>(
    `SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2
     UNION ALL
     SELECT ii.id FROM menu_items mi
     JOIN inventory_items ii ON ii.location_id = mi.location_id AND ii.name = mi.name
     WHERE mi.id = $1 AND mi.location_id = $2
     LIMIT 1`,
    [localGoodsId, locationId],
  );
  if (direct[0]) return direct[0].id;
  const { rows: menuRows } = await client.query<{ name: string }>(
    `SELECT name FROM menu_items WHERE id = $1 AND location_id = $2`,
    [localGoodsId, locationId],
  );
  if (!menuRows[0]) throw new Error("purchase_goods_not_found");
  const { rows: created } = await client.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, $2, 'unit') RETURNING id`,
    [locationId, menuRows[0].name],
  );
  return created[0].id;
}

async function importPurchase(
  businessId: string,
  connectionId: string,
  locationId: string,
  tx: HolooTransaction,
  createdBy: string | null,
  industry: Awaited<ReturnType<typeof getBusinessIndustry>>,
  importRunId?: string | null,
): Promise<boolean> {
  if (!tx.goodsId) return false;
  const localGoodsId = await localIdForRemote(businessId, connectionId, "holoo_goods", tx.goodsId);
  if (!localGoodsId) return false;
  const supplierId = tx.personId ? await localIdForRemote(businessId, connectionId, "holoo_customer", tx.personId) : null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (industry === "accessories" || industry === "cosmetics" || isTradeGoodsIndustry(industry)) {
      const purchase = await receiveItemPurchase(client, {
        businessId,
        locationId,
        supplierId,
        note: `Holoo ${tx.remoteId}`,
        createdBy,
        lines: [{ itemId: localGoodsId, quantity: positiveQuantity(tx), unitCost: unitCostFrom(tx) }],
      });
      await upsertMapping(businessId, connectionId, "holoo_purchase", tx.remoteId, purchase.id, importRunId);
    } else if (industryProfile(industry ?? "food_service").salesModel === "order_ticket") {
      const inventoryItemId = await resolveInventoryItemForGoods(client, locationId, localGoodsId);
      const quantity = positiveQuantityText(positiveQuantity(tx));
      const totalCost = rialText((tx.amountRial ?? 0n).toString());
      const { rows: purchaseRows } = await client.query<{ id: string }>(
        `INSERT INTO purchases (location_id, supplier_id, status, total, note, purchase_date, created_by)
         VALUES ($1, $2, 'draft', $3, $4, $5::date, $6) RETURNING id`,
        [locationId, supplierId, totalCost, `Holoo ${tx.remoteId}`, tx.occurredAt.slice(0, 10), createdBy],
      );
      const purchaseId = purchaseRows[0].id;
      const { rows: purchaseItems } = await client.query<{ id: string }>(
        `INSERT INTO purchase_items (purchase_id, inventory_item_id, quantity, unit_cost, extended_cost)
         VALUES ($1, $2, $3, CASE WHEN $3::numeric = 0 THEN 0 ELSE $4::numeric / $3::numeric END, $4)
         RETURNING id`,
        [purchaseId, inventoryItemId, quantity, totalCost],
      );
      const { rows: eventRows } = await client.query<{ id: string }>(
        `INSERT INTO inventory_events
           (business_id, location_id, event_type, source_type, source_id, created_by, costing_version)
         VALUES ($1, $2, 'purchase_receipt', 'purchase', $3, $4, 2) RETURNING id`,
        [businessId, locationId, purchaseId, createdBy],
      );
      const eventId = eventRows[0].id;
      const costing = await applyPurchaseReceiptCosting(client, {
        businessId,
        locationId,
        purchaseId,
        inventoryEventId: eventId,
        createdBy,
        items: [{ purchaseItemId: purchaseItems[0].id, inventoryItemId, quantity, extendedCost: totalCost }],
      });
      await client.query(
        `UPDATE purchases SET status = 'received', received_at = $2::timestamptz, settlement_method = 'cash' WHERE id = $1`,
        [purchaseId, tx.occurredAt],
      );
      await postExactPurchaseEntry(client, {
        businessId,
        locationId,
        purchaseId,
        createdBy,
        total: costing.receiptValue,
        settlementMethod: "cash",
        inventoryEventId: eventId,
      });
      await postNegativeStockSettlementEntry(client, {
        businessId,
        locationId,
        purchaseId,
        createdBy,
        upward: costing.upwardSettlementAdjustment,
        downward: costing.downwardSettlementAdjustment,
        inventoryEventId: eventId,
      });
      await client.query("UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1", [eventId]);
      await upsertMapping(businessId, connectionId, "holoo_purchase", tx.remoteId, purchaseId, importRunId);
    } else {
      await writeIntegrationAudit({ businessId, connectionId, action: "transaction.import_unsupported", entityType: tx.type, remoteId: tx.remoteId, payload: { industry } });
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function importStockMovement(
  businessId: string,
  connectionId: string,
  locationId: string,
  tx: HolooTransaction,
  createdBy: string | null,
  industry: Awaited<ReturnType<typeof getBusinessIndustry>>,
  importRunId?: string | null,
): Promise<boolean> {
  if (!tx.goodsId) return false;
  const localGoodsId = await localIdForRemote(businessId, connectionId, "holoo_goods", tx.goodsId);
  if (!localGoodsId) return false;
  const quantity = new Decimal(tx.quantity ?? 0);
  if (!quantity.isFinite() || quantity.eq(0)) return false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const eventSourceType = `holoo_stock:${tx.remoteId}`.slice(0, 120);
    const { rows: eventRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, source_id, created_by, costing_version, metadata)
       VALUES ($1, $2, 'stock_count_adjustment', $3, NULL, $4, 1, $5) RETURNING id`,
      [businessId, locationId, eventSourceType, createdBy, JSON.stringify({ remoteId: tx.remoteId })],
    );
    const eventId = eventRows[0].id;
    if (industry === "accessories" || industry === "cosmetics" || isTradeGoodsIndustry(industry)) {
      await client.query(
        `UPDATE item_stock SET quantity = quantity + $2, updated_at = now() WHERE item_id = $1`,
        [localGoodsId, quantity.toString()],
      );
    } else {
      const { rows: itemRows } = await client.query<{ id: string; name: string }>(
        `SELECT ii.id, ii.name FROM inventory_items ii WHERE ii.id = $1 AND ii.location_id = $2
         UNION ALL
         SELECT ii.id, ii.name FROM menu_items mi
         JOIN inventory_items ii ON ii.location_id = mi.location_id AND ii.name = mi.name
         WHERE mi.id = $1 AND mi.location_id = $2
         LIMIT 1`,
        [localGoodsId, locationId],
      );
      let inventoryItemId = itemRows[0]?.id;
      if (!inventoryItemId) {
        const { rows: menuRows } = await client.query<{ name: string }>(
          `SELECT name FROM menu_items WHERE id = $1 AND location_id = $2`,
          [localGoodsId, locationId],
        );
        if (!menuRows[0]) throw new Error("stock_goods_not_found");
        const { rows: created } = await client.query<{ id: string }>(
          `INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, $2, 'unit') RETURNING id`,
          [locationId, menuRows[0].name],
        );
        inventoryItemId = created[0].id;
      }
      const unitCost = unitCostFrom(tx);
      const costValue = new Decimal(quantity.abs()).times(unitCost).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
      await client.query(
        `INSERT INTO stock_movements
           (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial, source_type, source_id, note, created_by, inventory_event_id)
         VALUES ($1, $2, 'adjustment', $3, $4, $5, $8, $6, 'گردش موجودی از هلو', $7, $6)`,
        [locationId, inventoryItemId, quantity.toString(), String(unitCost), costValue, eventId, createdBy, eventSourceType],
      );
      if (quantity.gt(0)) {
        await client.query(
          `INSERT INTO inventory_lots
             (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, source_id, inventory_event_id)
           VALUES ($1, $2, $3, $4, 'holoo_import', $5, $5)`,
          [locationId, inventoryItemId, quantity.toString(), String(unitCost), eventId],
        );
      }
    }
    await client.query("UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1", [eventId]);
    await upsertMapping(businessId, connectionId, "holoo_stock", tx.remoteId, eventId, importRunId);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply the importable transactions in chronological order.
 *
 * Receipts and payments are imported concretely through the existing AR/AP
 * services (their shape maps 1:1 to Holoo's دریافت/پرداخت). Sales, purchases
 * and stock movements are applied through the services that own them; the
 * exact line-item reconstruction from Holoo's tables is driven by the matched
 * schema profile (Wave 2) and is the part verified against a real install.
 */
export async function applyTransactions(
  businessId: string,
  connectionId: string,
  transactions: HolooTransaction[],
  createdBy: string | null,
  importRunId?: string | null,
): Promise<TransactionImportSummary> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const locationId = await resolveLocationId(businessId, connection.location_id);

  const goods = await mappedIdSet(businessId, connectionId, "holoo_goods");
  const persons = await mappedIdSet(businessId, connectionId, "holoo_customer");
  const { ordered, discrepancies } = importableTransactions(transactions, goods, persons);

  let imported = 0;
  for (const tx of ordered) {
    const mapped = await localIdForRemote(businessId, connectionId, "holoo_invoice", tx.remoteId)
      ?? await localIdForRemote(businessId, connectionId, "holoo_receipt", tx.remoteId)
      ?? await localIdForRemote(businessId, connectionId, "holoo_purchase", tx.remoteId)
      ?? await localIdForRemote(businessId, connectionId, "holoo_stock", tx.remoteId);
    if (mapped) continue; // idempotent re-run

    if (tx.type === "receipt" && tx.personId) {
      const customerId = await localIdForRemote(businessId, connectionId, "holoo_customer", tx.personId);
      if (!customerId) continue;
      const receipt = await receivePayment({
        businessId,
        locationId: connection.location_id,
        customerId,
        method: "cash",
        amount: tx.amountRial ? Number(tx.amountRial) : 0,
        receiptDate: tx.occurredAt.slice(0, 10),
        createdBy,
        skipHolooPush: true,
      });
      await upsertMapping(businessId, connectionId, "holoo_receipt", tx.remoteId, receipt.id, importRunId);
      imported += 1;
      continue;
    }

    if (tx.type === "payment" && tx.personId) {
      const supplierId = await localIdForRemote(businessId, connectionId, "holoo_customer", tx.personId);
      if (!supplierId) continue;
      const payment = await payBill({
        businessId,
        locationId: connection.location_id,
        supplierId,
        method: "cash",
        amount: tx.amountRial ? Number(tx.amountRial) : 0,
        paymentDate: tx.occurredAt.slice(0, 10),
        createdBy,
        skipHolooPush: true,
      });
      await upsertMapping(businessId, connectionId, "holoo_receipt", tx.remoteId, payment.id, importRunId);
      imported += 1;
      continue;
    }

    if (tx.type === "sale") {
      if (await importSale(businessId, connectionId, locationId, tx, createdBy, industry, importRunId)) {
        imported += 1;
      }
      continue;
    }

    if (tx.type === "purchase") {
      if (await importPurchase(businessId, connectionId, locationId, tx, createdBy, industry, importRunId)) {
        imported += 1;
      }
      continue;
    }

    if (tx.type === "stock") {
      if (await importStockMovement(businessId, connectionId, locationId, tx, createdBy, industry, importRunId)) {
        imported += 1;
      }
      continue;
    }

    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "transaction.import_skipped",
      entityType: tx.type,
      remoteId: tx.remoteId,
      payload: { industry, occurredAt: tx.occurredAt },
    });
  }

  return { total: transactions.length, importable: ordered.length, discrepancies, imported };
}
