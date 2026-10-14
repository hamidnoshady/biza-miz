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
 *
 * Since migration 0209 every line it sells also writes one `online_sale_lines`
 * row — the channel's sale fact: quantity, net, cost status, the COGS posted
 * and what happened to the shelf. That row is what the variant/brand reports
 * read for the website channel, what the overview counts as uncosted
 * («سود موقت»), and what a refund restores against. The rules themselves are
 * pure and live in `online-sale-policy.ts`.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { rialText, type RialText } from "./inventory-exact";
import {
  decideOnlineLineCost,
  decideOnlineStockRelief,
  type OnlineCostStatus,
  type OnlineStockOutcome,
} from "./online-sale-policy";
import {
  allocateBatchStock,
  allocationBatchNumbers,
  allocationCostValue,
  allocationExpiryDate,
  consumeBatchAllocations,
  recordOrderItemBatchAllocations,
  type BatchAllocation,
} from "./retail-batch-inventory";

export type OnlineSaleSourceType = "woocommerce_order" | "cms_store_order";

export interface OnlineRetailLineSaleInput {
  locationId: string;
  orderId: string;
  /** The `order_items` row this sale is attached to (persisted with the allocation). */
  orderItemId: string;
  itemId: string;
  /** Decimal string — Woo/CMS quantities are whole today, the column is not. */
  quantity: string;
  /** The line's net revenue, Rial — recorded on the sale fact for the reports. */
  netRial: string;
  /** `woocommerce_order` | `cms_store_order` — recorded on the allocation and the fact. */
  sourceType: OnlineSaleSourceType;
  sourceId: string;
  /** The instant the sale belongs to (see `chooseOnlineOccurredAt`). */
  occurredAt: string;
  /**
   * The remote order's own instant, when the payload carried one. Compared to
   * `item_stock.remote_snapshot_at`; null means "cannot tell", which relieves.
   */
  remoteOccurredAt: string | null;
  /** Injectable "today" for tests; defaults to the current date. */
  today?: string;
}

export interface OnlineRetailLineSaleResult {
  /** The exact cost this line relieved, Rial — what the channel posts as COGS. */
  cogsRial: RialText;
  costStatus: OnlineCostStatus;
  stockOutcome: OnlineStockOutcome;
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
 * Fungible items follow `decideOnlineStockRelief`: the shelf is relieved
 * unless a newer remote snapshot already contains the sale, and units beyond
 * what is on hand are recorded as a shortfall rather than clamped away. The
 * cost is the recorded purchase cost (`decideOnlineLineCost`); a missing one
 * no longer skips the stock movement or `last_sold_at` — it is recorded as a
 * `missing` cost on the fact and the revenue still posts.
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
    const cogsRial = allocationCostValue(allocations);
    const uncosted = allocations.some((a) => a.unitCost == null || a.unitCost <= 0);
    const costStatus: OnlineCostStatus = uncosted
      ? allocations.every((a) => a.unitCost == null || a.unitCost <= 0) ? "missing" : "partial"
      : "known";
    await recordOnlineSaleLine(client, {
      ...input,
      costStatus,
      cogsRial,
      stockOutcome: "relieved",
      relievedQuantity: input.quantity,
      shortQuantity: "0",
    });
    return {
      cogsRial,
      costStatus,
      stockOutcome: "relieved",
      batchAllocations: allocations,
      batchNumbers: allocationBatchNumbers(allocations),
      expiryDate: allocationExpiryDate(allocations),
      tracking: "batch",
    };
  }

  // Lock the row: two deliveries of different orders for the same variant
  // must not both read the same on-hand figure.
  const { rows: stockRows } = await client.query<{
    quantity: string;
    unit_cost: string | null;
    remote_snapshot_at: string | null;
  }>(
    `SELECT quantity::text, unit_cost::text, remote_snapshot_at::text
       FROM item_stock WHERE item_id = $1 FOR UPDATE`,
    [input.itemId],
  );
  const stock = stockRows[0] ?? null;
  const relief = decideOnlineStockRelief({
    quantity: input.quantity,
    onHand: stock?.quantity ?? "0",
    remoteSnapshotAt: stock?.remote_snapshot_at ? new Date(stock.remote_snapshot_at).toISOString() : null,
    remoteOccurredAt: input.remoteOccurredAt,
  });
  const cost = decideOnlineLineCost({
    quantity: input.quantity,
    shortQuantity: relief.short,
    unitCost: stock?.unit_cost ?? null,
  });

  if (stock) {
    await client.query(
      `UPDATE item_stock SET quantity = quantity - $2::numeric, last_sold_at = now(), updated_at = now()
        WHERE item_id = $1`,
      [input.itemId, relief.relieve],
    );
  }
  await recordOnlineSaleLine(client, {
    ...input,
    costStatus: cost.costStatus,
    cogsRial: rialText(cost.cogsRial),
    stockOutcome: relief.outcome,
    relievedQuantity: relief.relieve,
    shortQuantity: relief.short,
  });
  return {
    cogsRial: rialText(cost.cogsRial),
    costStatus: cost.costStatus,
    stockOutcome: relief.outcome,
    tracking: "none",
  };
}

/**
 * The sale fact for a line that holds no stock — a variation that landed on
 * its family row, or a product the store never mapped. Recorded so the
 * report's revenue matches the books for the channel; it carries
 * `not_applicable` cost (nothing on any shelf was relieved).
 */
export async function recordUntrackedOnlineLine(
  client: PoolClient,
  input: Omit<OnlineRetailLineSaleInput, "itemId" | "today" | "remoteOccurredAt"> & { itemId: string | null },
): Promise<void> {
  await recordOnlineSaleLine(client, {
    ...input,
    costStatus: "not_applicable",
    cogsRial: rialText("0"),
    stockOutcome: "not_tracked",
    relievedQuantity: "0",
    shortQuantity: "0",
  });
}

async function recordOnlineSaleLine(
  client: PoolClient,
  fact: {
    locationId: string;
    orderId: string;
    orderItemId: string;
    itemId: string | null;
    quantity: string;
    netRial: string;
    sourceType: OnlineSaleSourceType;
    occurredAt: string;
    costStatus: OnlineCostStatus;
    cogsRial: RialText;
    stockOutcome: OnlineStockOutcome;
    relievedQuantity: string;
    shortQuantity: string;
  },
): Promise<void> {
  if (new Decimal(fact.quantity).lte(0)) return;
  await client.query(
    `INSERT INTO online_sale_lines
       (order_item_id, order_id, location_id, item_id, source_type, quantity, net_rial,
        cost_status, cogs_rial, stock_outcome, relieved_quantity, short_quantity, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11::numeric, $12::numeric, $13)`,
    [
      fact.orderItemId, fact.orderId, fact.locationId, fact.itemId, fact.sourceType, fact.quantity,
      fact.netRial, fact.costStatus, fact.cogsRial, fact.stockOutcome, fact.relievedQuantity,
      fact.shortQuantity, fact.occurredAt,
    ],
  );
}
