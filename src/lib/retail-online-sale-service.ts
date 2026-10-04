/**
 * Retail + Cosmetics (issue #770) — the one application-domain service every
 * website channel calls to sell a mapped retail item.
 *
 * WooCommerce and Eshobe CMS are adapters. They validate/map the external
 * payload, resolve the tenant/location/item and persist their own idempotency
 * mapping — and then this service decides what selling actually means:
 *
 *   tracking (none | batch) → FEFO + expired-batch exclusion → exact cost →
 *   stock movement (batches or the fungible rollup) → persisted allocation
 *
 * Before this existed, each adapter carried its own copy of "read
 * item_stock.unit_cost, decrement item_stock.quantity, post COGS". That is
 * correct for fungible stock and *wrong* for a `tracking='batch'` item:
 * it bypassed FEFO, could sell expired stock, never decremented
 * `item_batches`, and posted a shelf-average COGS. Both adapters now call
 * this instead, so there is exactly one answer to "what does a retail sale
 * do", whether it came from the counter, the website or an external API.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { roundRial, rialText, type RialText } from "./inventory-exact";
import {
  allocateBatchStock,
  allocationBatchNumbers,
  allocationCostValue,
  allocationExpiryDate,
  consumeBatchAllocations,
  recordOrderItemBatchAllocations,
  type BatchAllocation,
} from "./retail-batch-inventory";

export interface OnlineRetailLineSaleInput {
  locationId: string;
  orderId: string;
  /** The `order_items` row this sale is attached to (persisted with the allocation). */
  orderItemId: string;
  itemId: string;
  /** Decimal string — Woo/CMS quantities are whole today, the column is not. */
  quantity: string;
  /** `woocommerce_order` | `cms_store_order` | … — recorded on the allocation. */
  sourceType: string;
  sourceId: string;
  /** Injectable "today" for tests; defaults to the current date. */
  today?: string;
}

export interface OnlineRetailLineSaleResult {
  /** The exact cost this line relieved, Rial — what the channel posts as COGS. */
  cogsRial: RialText;
  /** Batch-tracked lines only: the exact lots consumed. */
  batchAllocations?: BatchAllocation[];
  batchNumbers?: string[];
  expiryDate?: string | null;
  tracking: "none" | "batch";
}

/**
 * Sells one line of an online retail order in the caller's transaction.
 *
 * Batch-tracked items go through the canonical engine: expired stock is
 * refused (the import fails and is retried/deferred rather than silently
 * selling it), FEFO picks the lots, the batches are relieved, the rollup is
 * recomputed and the allocation is persisted against the order line.
 *
 * Fungible items keep the retail rule this codebase already documents — no
 * cost basis, no COGS — and relieve `item_stock` with `GREATEST(0, …)` so a
 * stock picture already synced post-sale (WooCommerce deducted it) can never
 * drive the quantity negative and abort the order.
 */
export async function sellOnlineRetailLine(
  client: PoolClient,
  input: OnlineRetailLineSaleInput,
): Promise<OnlineRetailLineSaleResult> {
  const { rows } = await client.query<{ tracking: string }>(
    `SELECT tracking::text AS tracking FROM items WHERE id = $1 AND location_id = $2`,
    [input.itemId, input.locationId],
  );
  if (!rows[0]) throw new Error("item_not_found");
  const tracking = rows[0].tracking;

  if (tracking === "batch") {
    const allocations = await allocateBatchStock(client, {
      itemId: input.itemId,
      quantity: input.quantity,
      today: input.today,
    });
    await consumeBatchAllocations(client, input.itemId, allocations);
    await recordOrderItemBatchAllocations(client, {
      orderItemId: input.orderItemId,
      orderId: input.orderId,
      locationId: input.locationId,
      itemId: input.itemId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      allocations,
    });
    await client.query(`UPDATE item_stock SET last_sold_at = now(), updated_at = now() WHERE item_id = $1`, [
      input.itemId,
    ]);
    return {
      cogsRial: allocationCostValue(allocations),
      batchAllocations: allocations,
      batchNumbers: allocationBatchNumbers(allocations),
      expiryDate: allocationExpiryDate(allocations),
      tracking: "batch",
    };
  }

  const { rows: stockRows } = await client.query<{ unit_cost: string | null }>(
    `SELECT unit_cost::text FROM item_stock WHERE item_id = $1`,
    [input.itemId],
  );
  const unitCost = stockRows[0]?.unit_cost == null ? null : BigInt(stockRows[0].unit_cost);
  if (unitCost == null || unitCost <= 0n) {
    return { cogsRial: rialText("0"), tracking: "none" };
  }

  await client.query(
    `UPDATE item_stock SET quantity = GREATEST(0, quantity - $2), last_sold_at = now(), updated_at = now()
      WHERE item_id = $1`,
    [input.itemId, input.quantity],
  );
  return {
    cogsRial: rialText(roundRial(new Decimal(input.quantity).times(unitCost.toString()))),
    tracking: "none",
  };
}
