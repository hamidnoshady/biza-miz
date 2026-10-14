/**
 * Stock-count lifecycle: create, inspect, reverse, and edit.
 *
 * A posted physical count is a source document with exact-costing and ledger
 * effects, so it is never mutated in place. Correction is modelled the same
 * way the write-down and transfer workflows model it: a reversal event that
 * undoes the original variance at the original recorded value, optionally
 * followed by a fresh re-count. `reversal_of` on `stock_counts` marks the
 * reversal row, and the original `inventory_events` row is flipped to
 * `posting_status = 'reversed'`.
 *
 * A count whose surplus stock has since been consumed (its own FIFO lot drawn
 * down, or a weighted-average carrying value no longer covering it) cannot be
 * unwound bit-exactly without re-costing later sales, so those corrections are
 * refused with `count_stock_consumed` rather than silently mis-accounted.
 *
 * DB-touching, so not unit-tested directly (repo convention) — behaviour is
 * covered by integration/stock-count-corrections.integration.test.ts.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { query } from "./db";
import type { Role } from "./auth-edge";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { applyStockAdjustmentExact } from "./inventory-adjustment-exact";
import { quantityText, rialText } from "./inventory-exact";
import { isLotBased, type CostingMethod } from "./inventory-costing";
import { adjustCarryingValue, insertLot, insertMovement } from "./inventory-reversal";
import { getCostingMethod } from "./inventory-service";
import {
  postExactNegativeSettlementEntry,
  postExactStockCountEntry,
  postExactStockCountReversalEntry,
} from "./ledger-service";

export interface StockCountLineInput {
  inventoryItemId: string;
  /** accepted as text so a caller can send more precision than a double carries */
  countedQty?: number | string;
}

export interface StockCountDetailLine {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  systemQty: string;
  countedQty: string;
  variance: string;
  unitCarryingCost: string;
  varianceValue: string;
}

export interface StockCountDetail {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  reversed: boolean;
  lines: StockCountDetailLine[];
}


/**
 * Undoes one stock-count line's variance at its original recorded value.
 * Returns the COGS settlement correction the reversal must post to undo the
 * surplus's negative-layer settlements (always zero for a shortage line).
 */
async function reverseAdjustmentLine(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    inventoryItemId: string;
    countedAt: string;
    variance: string;
    varianceValueRial: string;
    originalCountId: string;
    originalEventId: string;
    reversalCountId: string;
    reversalEventId: string;
    createdBy: string | null;
    method: CostingMethod;
  },
): Promise<{ upward: bigint; downward: bigint }> {
  const variance = new Decimal(params.variance);
  if (variance.eq(0)) return { upward: 0n, downward: 0n };

  const quantity = variance.abs();
  const signedValue = BigInt(params.varianceValueRial);
  const value = signedValue < 0n ? -signedValue : signedValue;
  let upward = 0n;
  let downward = 0n;

  if (variance.isNegative()) {
    // Shortage reversal: put the counted quantity back, first cancelling any
    // negative layer this count opened for the item.
    const { rows: layers } = await client.query<{
      id: string;
      original_quantity: string;
      remaining_quantity: string;
      remaining_provisional_value_rial: string | null;
    }>(
      `SELECT id, original_quantity::text, remaining_quantity::text, remaining_provisional_value_rial::text
         FROM inventory_negative_layers
        WHERE inventory_item_id=$1 AND source_inventory_event_id=$2
        ORDER BY created_at, id
        FOR UPDATE`,
      [params.inventoryItemId, params.originalEventId],
    );
    let negativeQuantity = new Decimal(0);
    let negativeValue = 0n;
    for (const layer of layers) {
      if (layer.remaining_provisional_value_rial === null) {
        throw new Error(`inventory_exact_cutover_required: negative_layer:${layer.id}`);
      }
      // A layer a later event has since settled cannot be cleanly undone here.
      if (new Decimal(layer.remaining_quantity).lt(new Decimal(layer.original_quantity))) {
        throw new Error("count_layer_settled");
      }
      const { rows: settled } = await client.query(
        "SELECT 1 FROM inventory_negative_layer_settlements WHERE negative_layer_id=$1 LIMIT 1",
        [layer.id],
      );
      if (settled.length) throw new Error("count_layer_settled");
      negativeQuantity = negativeQuantity.plus(layer.remaining_quantity);
      negativeValue += BigInt(layer.remaining_provisional_value_rial);
      await client.query("DELETE FROM inventory_negative_layers WHERE id=$1", [layer.id]);
    }

    await insertMovement(client, {
      locationId: params.locationId,
      inventoryItemId: params.inventoryItemId,
      quantity,
      value,
      sourceType: "stock_count_reversal",
      sourceId: params.reversalCountId,
      createdBy: params.createdBy,
      inventoryEventId: params.reversalEventId,
    });

    const positiveQuantity = quantity.minus(negativeQuantity);
    const positiveValue = value - negativeValue;
    if (positiveQuantity.lt(0) || positiveValue < 0n) throw new Error("stock_count_reversal_inconsistent");
    if (positiveQuantity.gt(0)) {
      if (isLotBased(params.method)) {
        await insertLot(client, {
          locationId: params.locationId,
          inventoryItemId: params.inventoryItemId,
          quantity: positiveQuantity,
          value: positiveValue,
          receivedAt: params.countedAt,
          sourceType: "stock_count_reversal",
          sourceId: params.reversalCountId,
          inventoryEventId: params.reversalEventId,
        });
      } else {
        await adjustCarryingValue(client, { inventoryItemId: params.inventoryItemId, deltaRial: positiveValue });
      }
    }
    return { upward: 0n, downward: 0n };
  }

  // Surplus reversal: un-settle the negative layers this count closed, then
  // take the residual positive value back out of stock.
  const { rows: settlements } = await client.query<{
    id: string;
    negative_layer_id: string;
    quantity: string;
    provisional_value_rial: string;
    actual_value_rial: string;
  }>(
    `SELECT s.id, s.negative_layer_id, s.quantity::text, s.provisional_value_rial::text, s.actual_value_rial::text
       FROM inventory_negative_layer_settlements s
       JOIN inventory_negative_layers l ON l.id = s.negative_layer_id
      WHERE s.stock_count_id=$1 AND l.inventory_item_id=$2
      ORDER BY s.id
      FOR UPDATE OF s`,
    [params.originalCountId, params.inventoryItemId],
  );
  let settledValue = 0n;
  for (const settlement of settlements) {
    const provisional = BigInt(settlement.provisional_value_rial);
    const actual = BigInt(settlement.actual_value_rial);
    const difference = actual - provisional;
    if (difference > 0n) upward += difference;
    else if (difference < 0n) downward += -difference;
    settledValue += actual;
    await client.query(
      `UPDATE inventory_negative_layers
          SET remaining_quantity = remaining_quantity + $2::numeric,
              remaining_provisional_value_rial = remaining_provisional_value_rial + $3::bigint,
              settled_at = NULL
        WHERE id=$1`,
      [settlement.negative_layer_id, settlement.quantity, settlement.provisional_value_rial],
    );
    await client.query("DELETE FROM inventory_negative_layer_settlements WHERE id=$1", [settlement.id]);
  }

  await insertMovement(client, {
    locationId: params.locationId,
    inventoryItemId: params.inventoryItemId,
    quantity: quantity.neg(),
    value,
    sourceType: "stock_count_reversal",
    sourceId: params.reversalCountId,
    createdBy: params.createdBy,
    inventoryEventId: params.reversalEventId,
  });

  const positiveValue = value - settledValue;
  if (positiveValue < 0n) throw new Error("stock_count_reversal_inconsistent");
  if (isLotBased(params.method)) {
    // The count's own FIFO lot is the positive portion; it must still be fully
    // on hand, or a later sale already consumed part of the surplus.
    const { rows: lots } = await client.query<{
      id: string;
      original_quantity: string;
      remaining_qty: string;
      original_value_rial: string;
    }>(
      `SELECT id, original_quantity::text, remaining_qty::text, original_value_rial::text
         FROM inventory_lots
        WHERE inventory_item_id=$1 AND source_type='stock_count' AND source_id=$2 AND inventory_event_id=$3
        ORDER BY received_at, id
        FOR UPDATE`,
      [params.inventoryItemId, params.originalCountId, params.originalEventId],
    );
    let removedValue = 0n;
    for (const lot of lots) {
      if (!new Decimal(lot.remaining_qty).eq(new Decimal(lot.original_quantity))) {
        throw new Error("count_stock_consumed");
      }
      removedValue += BigInt(lot.original_value_rial);
      await client.query(
        "UPDATE inventory_lots SET remaining_qty=0, remaining_value_rial=0 WHERE id=$1",
        [lot.id],
      );
    }
    if (removedValue !== positiveValue) throw new Error("stock_count_reversal_inconsistent");
  } else {
    const { rows } = await client.query<{ carrying: string }>(
      "SELECT COALESCE(carrying_value_rial,0)::text carrying FROM inventory_items WHERE id=$1 FOR UPDATE",
      [params.inventoryItemId],
    );
    const carrying = BigInt(rows[0]?.carrying ?? "0");
    if (carrying < positiveValue) throw new Error("count_stock_consumed");
    await adjustCarryingValue(client, { inventoryItemId: params.inventoryItemId, deltaRial: -positiveValue });
  }
  return { upward, downward };
}

/**
 * Ad hoc physical count entry — the exact path extracted from the POST route.
 * For each line the counted quantity is compared against system stock and the
 * difference posted as an 'adjustment' stock movement so on-hand stock matches
 * reality going forward.
 */
export interface StockCountListRow extends Record<string, unknown> {
  id: string;
  note: string | null;
  counted_at: string;
  counted_by_name: string | null;
  line_count: string;
  shortage_value: string;
  surplus_value: string;
  reversed: boolean;
}

/**
 * The stock-count list the route `/api/inventory/stock-counts` GET and the MCP
 * read tool `list_stock_counts` share. Extracted from the route handler for
 * issue #883 so the screen and the connector literally run the same query —
 * capped at 50, reversals-only-out (a reversing count replaces what it
 * reverses), newest first.
 */
export async function listStockCounts(locationId: string): Promise<StockCountListRow[]> {
  const { rows } = await query<StockCountListRow>(
    `SELECT sc.id, sc.note, sc.counted_at, u.full_name AS counted_by_name,
            (SELECT count(*) FROM stock_count_lines WHERE stock_count_id = sc.id) AS line_count,
            COALESCE((SELECT sum(CASE WHEN variance < 0 THEN -variance_value ELSE 0 END)
                        FROM stock_count_lines WHERE stock_count_id = sc.id), 0)::text AS shortage_value,
            COALESCE((SELECT sum(CASE WHEN variance > 0 THEN variance_value ELSE 0 END)
                        FROM stock_count_lines WHERE stock_count_id = sc.id), 0)::text AS surplus_value,
            EXISTS (SELECT 1 FROM stock_counts reversal WHERE reversal.reversal_of = sc.id) AS reversed
       FROM stock_counts sc LEFT JOIN users u ON u.id = sc.counted_by
      WHERE sc.location_id = $1 AND sc.reversal_of IS NULL
      ORDER BY sc.counted_at DESC LIMIT 50`,
    [locationId],
  );
  return rows;
}

export async function createStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    note?: string | null;
    lines: StockCountLineInput[];
    createdBy: string | null;
    countId?: string;
    sync?: { actorRole: Role; clientEventId?: string };
    /** Archived lines from an existing count may be preserved during an edit. */
    allowInactiveItemIds?: string[];
  },
): Promise<{ id: string }> {
  if (params.lines.length === 0) throw new Error("no_items");

  const countedByItem = new Map<string, string>();
  for (const line of params.lines) {
    if (!line.inventoryItemId) throw new Error("invalid_item");
    // A duplicate line is ambiguous: silently replacing the first value would
    // make a malformed request appear to have counted the item once. The
    // retail count path rejects the same shape, so keep both models honest.
    if (countedByItem.has(line.inventoryItemId)) throw new Error("duplicate_item");
    try {
      countedByItem.set(line.inventoryItemId, quantityText(String(line.countedQty ?? "")));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "quantity_precision_exceeded" || code === "invalid_quantity") {
        throw new Error(code);
      }
      throw new Error("invalid_item");
    }
  }

  const itemIds = [...countedByItem.keys()];
  const allowInactiveItemIds = params.allowInactiveItemIds ?? [];
  const { rows: owned } = await client.query(
    `SELECT id FROM inventory_items
      WHERE id = ANY($1::uuid[]) AND location_id = $2
        AND (is_active OR id = ANY($3::uuid[]))`,
    [itemIds, params.locationId, allowInactiveItemIds],
  );
  if (owned.length !== new Set(itemIds).size) throw new Error("item_not_found");

  // One deterministic lock acquisition prevents count/sale/purchase deadlocks.
  await client.query("SELECT id FROM inventory_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);
  const { rows: countRows } = await client.query<{ id: string }>(
    "INSERT INTO stock_counts (id, location_id, note, counted_by) VALUES (COALESCE($4::uuid,gen_random_uuid()), $1, $2, $3) RETURNING id",
    [params.locationId, params.note?.trim() || null, params.createdBy, params.countId ?? null],
  );
  const stockCountId = countRows[0].id;
  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,created_by,idempotency_key,costing_version)
     VALUES($1,$2,'stock_count_adjustment','stock_count',$3,$4,'stock-count:' || $5,2) RETURNING id`,
    [params.businessId, params.locationId, stockCountId, params.createdBy, stockCountId],
  );
  const eventId = eventRows[0].id;
  await client.query("UPDATE stock_counts SET inventory_event_id=$2 WHERE id=$1", [stockCountId, eventId]);

  let shortageValue = 0n;
  let surplusValue = 0n;
  let upward = 0n;
  let downward = 0n;
  for (const [inventoryItemId, countedQty] of [...countedByItem].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { rows: stockRows } = await client.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
      [inventoryItemId],
    );
    const systemQty = stockRows[0].quantity;
    const variance = new Decimal(countedQty).minus(new Decimal(systemQty)).toFixed();

    const result = await applyStockAdjustmentExact(client, {
      locationId: params.locationId,
      businessId: params.businessId,
      inventoryItemId,
      delta: variance,
      stockCountId,
      sourceType: "stock_count",
      sourceId: stockCountId,
      createdBy: params.createdBy,
      inventoryEventId: eventId,
    });
    const varianceValue = BigInt(result.varianceValueRial);
    if (varianceValue < 0n) shortageValue += -varianceValue;
    else surplusValue += varianceValue;
    upward += BigInt(result.upwardSettlementAdjustment);
    downward += BigInt(result.downwardSettlementAdjustment);
    await client.query(
      `INSERT INTO stock_count_lines (stock_count_id, inventory_item_id, system_qty, counted_qty, variance, unit_carrying_cost, variance_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [stockCountId, inventoryItemId, systemQty, countedQty, variance, result.unitCost, result.varianceValueRial],
    );
  }

  await postExactStockCountEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    stockCountId,
    inventoryEventId: eventId,
    createdBy: params.createdBy,
    shortageValue: rialText(shortageValue.toString()),
    surplusValue: rialText(surplusValue.toString()),
  });
  await postExactNegativeSettlementEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "stock_count",
    sourceId: stockCountId,
    createdBy: params.createdBy,
    upward: rialText(upward.toString()),
    downward: rialText(downward.toString()),
    inventoryEventId: eventId,
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [eventId]);
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: params.sync.clientEventId ?? `stock-count:create:${stockCountId}`,
    eventType: "inventory.stock_count.recorded",
    payload: { countId: stockCountId, note: params.note ?? null, lines: params.lines },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });
  return { id: stockCountId };
}

/** One count's header and lines, scoped to the caller's business/location. */
export async function getStockCountDetail(
  client: PoolClient,
  params: { businessId: string; locationId: string; countId: string },
): Promise<StockCountDetail | null> {
  const { rows: counts } = await client.query<{
    id: string;
    note: string | null;
    counted_at: string;
    counted_by_name: string | null;
    reversed: boolean;
  }>(
    `SELECT sc.id, sc.note, sc.counted_at::text, u.full_name AS counted_by_name,
            EXISTS (SELECT 1 FROM stock_counts reversal WHERE reversal.reversal_of = sc.id) AS reversed
       FROM stock_counts sc LEFT JOIN users u ON u.id = sc.counted_by
      WHERE sc.id=$1 AND sc.location_id=$2 AND sc.reversal_of IS NULL`,
    [params.countId, params.locationId],
  );
  if (!counts[0]) return null;
  const { rows: lines } = await client.query<{
    id: string;
    inventory_item_id: string;
    item_name: string;
    unit: string;
    system_qty: string;
    counted_qty: string;
    variance: string;
    unit_carrying_cost: string;
    variance_value: string;
  }>(
    `SELECT l.id, l.inventory_item_id, i.name AS item_name, i.unit,
            trim_scale(l.system_qty)::text AS system_qty,
            trim_scale(l.counted_qty)::text AS counted_qty,
            trim_scale(l.variance)::text AS variance,
            trim_scale(l.unit_carrying_cost)::text AS unit_carrying_cost,
            l.variance_value::text AS variance_value
       FROM stock_count_lines l
       JOIN inventory_items i ON i.id = l.inventory_item_id AND i.location_id = $2
      WHERE l.stock_count_id=$1
      ORDER BY i.name, l.id`,
    [params.countId, params.locationId],
  );
  return {
    id: counts[0].id,
    note: counts[0].note,
    countedAt: counts[0].counted_at,
    countedByName: counts[0].counted_by_name,
    reversed: counts[0].reversed,
    lines: lines.map((l) => ({
      id: l.id,
      inventoryItemId: l.inventory_item_id,
      itemName: l.item_name,
      unit: l.unit,
      systemQty: l.system_qty,
      countedQty: l.counted_qty,
      variance: l.variance,
      unitCarryingCost: l.unit_carrying_cost,
      varianceValue: l.variance_value,
    })),
  };
}

/**
 * Full reversal of a posted count: opposite movements at the original recorded
 * value, un-settles negative layers the count closed, and posts reversing
 * ledger entries. Returns the reversal row and its inventory event.
 */
export async function reverseStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    countId: string;
    createdBy: string | null;
    note?: string | null;
    sync?: { actorRole: Role; clientEventId?: string };
  },
): Promise<{ id: string; eventId: string }> {
  const { rows: counts } = await client.query<{
    id: string;
    location_id: string;
    inventory_event_id: string | null;
    counted_at: string;
  }>(
    `SELECT id, location_id, inventory_event_id, counted_at::text
       FROM stock_counts
      WHERE id=$1 AND location_id=$2 AND reversal_of IS NULL
      FOR UPDATE`,
    [params.countId, params.locationId],
  );
  const count = counts[0];
  if (!count) throw new Error("count_not_found");
  if (!count.inventory_event_id) throw new Error("count_not_reversible");

  const { rows: already } = await client.query("SELECT 1 FROM stock_counts WHERE reversal_of=$1 LIMIT 1", [
    params.countId,
  ]);
  if (already.length) throw new Error("already_reversed");

  const { rows: lines } = await client.query<{
    inventory_item_id: string;
    variance: string;
    variance_value: string;
  }>(
    `SELECT inventory_item_id, variance::text, variance_value::text
       FROM stock_count_lines
      WHERE stock_count_id=$1
      ORDER BY inventory_item_id`,
    [params.countId],
  );

  // Same deterministic item-lock acquisition as the count/purchase paths, so a
  // reversal can't deadlock against a concurrent sale, receipt, or count.
  const itemIds = lines.map((l) => l.inventory_item_id);
  if (itemIds.length > 0) {
    await client.query("SELECT id FROM inventory_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);
  }

  let shortageValue = 0n;
  let surplusValue = 0n;
  for (const line of lines) {
    const value = BigInt(line.variance_value);
    if (value < 0n) shortageValue += -value;
    else surplusValue += value;
  }

  const { rows: reversalRows } = await client.query<{ id: string }>(
    "INSERT INTO stock_counts (location_id, note, counted_by, reversal_of) VALUES ($1,$2,$3,$4) RETURNING id",
    [params.locationId, params.note?.trim() || null, params.createdBy, params.countId],
  );
  const reversalCountId = reversalRows[0].id;
  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id, location_id, event_type, source_type, source_id, created_by, costing_version, idempotency_key, reversal_of)
     VALUES($1,$2,'stock_count_reversal','stock_count',$3,$4,2,$5,$6) RETURNING id`,
    [
      params.businessId,
      params.locationId,
      reversalCountId,
      params.createdBy,
      `stock-count-reversal:${reversalCountId}`,
      count.inventory_event_id,
    ],
  );
  const reversalEventId = eventRows[0].id;
  await client.query("UPDATE stock_counts SET inventory_event_id=$2 WHERE id=$1", [
    reversalCountId,
    reversalEventId,
  ]);

  const method = await getCostingMethod(params.businessId, client);
  let upward = 0n;
  let downward = 0n;
  for (const line of lines) {
    const result = await reverseAdjustmentLine(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      inventoryItemId: line.inventory_item_id,
      countedAt: count.counted_at,
      variance: line.variance,
      varianceValueRial: line.variance_value,
      originalCountId: params.countId,
      originalEventId: count.inventory_event_id,
      reversalCountId,
      reversalEventId,
      createdBy: params.createdBy,
      method,
    });
    upward += result.upward;
    downward += result.downward;
  }

  await postExactStockCountReversalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    stockCountId: reversalCountId,
    inventoryEventId: reversalEventId,
    createdBy: params.createdBy,
    shortageValue: rialText(shortageValue.toString()),
    surplusValue: rialText(surplusValue.toString()),
  });
  // The original settlement entry moved COGS ↔ inventory for the value
  // difference; the reversal swaps the two directions.
  await postExactNegativeSettlementEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "stock_count_reversal",
    sourceId: reversalCountId,
    createdBy: params.createdBy,
    upward: rialText(downward.toString()),
    downward: rialText(upward.toString()),
    inventoryEventId: reversalEventId,
  });

  await client.query("UPDATE inventory_events SET posting_status='reversed' WHERE id=$1", [count.inventory_event_id]);
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [reversalEventId]);
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: params.sync.clientEventId ?? `stock-count:reverse:${params.countId}`,
    eventType: "inventory.stock_count.reversed",
    payload: { countId: params.countId, note: params.note ?? null },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });
  return { id: reversalCountId, eventId: reversalEventId };
}

/**
 * Corrects a posted count: reverse it, then (unless the corrected set of lines
 * is empty, i.e. a pure delete) record a fresh count with the edited lines.
 */
export async function editStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    countId: string;
    note?: string | null;
    lines: StockCountLineInput[];
    createdBy: string | null;
    sync?: { actorRole: Role };
  },
): Promise<{ reversed: boolean; id: string | null }> {
  // An item may have been archived after the original count. It is still valid
  // to retain that historical line while editing; newly added archived items
  // must not bypass the active-item guard in createStockCount.
  const { rows: originalLines } = await client.query<{ inventory_item_id: string }>(
    `SELECT l.inventory_item_id
       FROM stock_count_lines l
       JOIN inventory_items i ON i.id = l.inventory_item_id AND i.location_id = $2
      WHERE l.stock_count_id = $1
      FOR UPDATE`,
    [params.countId, params.locationId],
  );
  if (originalLines.length === 0) throw new Error("count_not_found");

  await reverseStockCount(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    countId: params.countId,
    createdBy: params.createdBy,
    note: params.note ?? null,
    sync: params.sync,
  });
  if (params.lines.length === 0) return { reversed: true, id: null };
  const created = await createStockCount(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    note: params.note ?? null,
    lines: params.lines,
    createdBy: params.createdBy,
    sync: params.sync,
    allowInactiveItemIds: originalLines.map((line) => line.inventory_item_id),
  });
  return { reversed: true, id: created.id };
}
