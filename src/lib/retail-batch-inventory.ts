/**
 * Retail + Cosmetics (issue #770) — the canonical batch inventory engine.
 *
 * The rule this module exists to enforce: for a `tracking='batch'` item,
 * `item_batches` is authoritative and `item_stock` is only a rollup/cache.
 * No channel — POS, WooCommerce order ingestion, Eshobe CMS paid orders,
 * warehouse documents, transfers, supplier returns, voids — may decrement
 * `item_stock.quantity` as if it were the source of truth. Every one of them
 * allocates from the batches (excluding expired stock), relieves exactly the
 * allocated rows, recomputes the rollup, and persists what it consumed so the
 * move can be reversed exactly.
 *
 * The flow, in one place:
 *
 *   allocateBatchStock()          — FEFO across sellable batches, expired refused
 *   consumeBatchAllocations()     — relieve the allocated rows + recompute rollup
 *   recordOrderItemBatchAllocations() — persist the exact per-line allocation
 *   restoreOrderItemBatchStock()  — put returned quantities back into the SAME
 *                                   batch (or record a non-restock disposition)
 *   recomputeItemStockRollup()    — quantity = SUM(batches), cost = weighted average
 *
 * The pure allocation/restoration planning is separated from the DB calls so
 * the rules are unit-testable (`retail-batch-inventory.test.ts`); the
 * DB-touching half is covered by the integration suite, per repo convention.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { allocateFefo, expiredBatches, isBatchExpired, sellableQuantity, type Batch } from "./fefo";
import { quantityText, roundRial, rialText, type RialText } from "./inventory-exact";

export class RetailBatchError extends Error {}

/** A batch row with the traceability columns the engine needs. */
export interface BatchLot extends Batch {
  batchNumber: string;
  unitCost: number | null;
}

/** What one sold line consumed from one batch — the exact allocation record. */
export interface BatchAllocation {
  batchId: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  unitCost: number | null;
  /** quantity × unitCost, Rial (whole) — the exact COGS this batch slice carried. */
  costValue: RialText;
}

/** The dispositions a returned batch quantity can be placed in. */
export const BATCH_DISPOSITIONS = [
  "restockable",
  "damaged",
  "expired",
  "quarantine",
  "tester",
  "no_restock",
] as const;
export type BatchDisposition = (typeof BATCH_DISPOSITIONS)[number];

export function isBatchDisposition(value: unknown): value is BatchDisposition {
  return typeof value === "string" && (BATCH_DISPOSITIONS as readonly string[]).includes(value);
}

/** Only a sellable return goes back on the shelf, in its original lot. */
export function isRestockDisposition(disposition: BatchDisposition): boolean {
  return disposition === "restockable";
}

function lineCostValue(quantity: string, unitCost: number | null): RialText {
  if (unitCost == null) return rialText("0");
  return rialText(roundRial(new Decimal(quantity).times(unitCost)));
}

/**
 * Allocate `quantity` across an item's sellable batches, first-expired-first-out.
 * Exhausted and expired batches are excluded — expired stock is refused, never
 * silently sold. Throws `RetailBatchError` with an actionable Persian message
 * when the sellable stock cannot cover the request.
 */
export function allocateBatchLots(lots: BatchLot[], quantity: string, today: string): BatchAllocation[] {
  const wanted = quantityText(quantity);
  if (new Decimal(wanted).lte(0)) throw new RetailBatchError("تعداد باید بزرگ‌تر از صفر باشد.");

  const expired = expiredBatches(lots, today);
  const sellable = lots.filter((lot) => !isBatchExpired(lot.expiryDate, today));
  if (new Decimal(sellableQuantity(lots, today)).lt(wanted)) {
    throw new RetailBatchError(
      expired.length > 0
        ? "موجودی قابل فروش کافی نیست؛ بخشی از این کالا منقضی شده است."
        : "موجودی کافی نیست.",
    );
  }

  const allocation = allocateFefo(sellable, wanted);
  return allocation.map((a) => {
    const lot = lots.find((l) => l.id === a.batchId)!;
    return {
      batchId: lot.id,
      batchNumber: lot.batchNumber,
      expiryDate: lot.expiryDate,
      quantity: a.quantity,
      unitCost: lot.unitCost,
      costValue: lineCostValue(a.quantity, lot.unitCost),
    };
  });
}

/** Total exact COGS of an allocation, Rial. */
export function allocationCostValue(allocations: Pick<BatchAllocation, "costValue">[]): RialText {
  return rialText(allocations.reduce((sum, a) => sum + BigInt(a.costValue), 0n).toString());
}

/** The distinct batch numbers an allocation touched, in first-consumed order. */
export function allocationBatchNumbers(allocations: BatchAllocation[]): string[] {
  return [...new Set(allocations.map((a) => a.batchNumber))];
}

/** The earliest expiry among an allocation's batches (what the receipt prints). */
export function allocationExpiryDate(allocations: BatchAllocation[]): string | null {
  return (
    allocations
      .map((a) => a.expiryDate)
      .filter((d): d is string => d != null)
      .sort()[0] ?? null
  );
}

/**
 * A stored allocation as the restoration planner sees it: what was consumed,
 * and how much of it is already accounted for.
 */
export interface RestorableAllocation {
  id: string;
  batchId: string | null;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  unitCost: number | null;
  restoredQuantity: string;
  disposedQuantity: string;
}

export interface RestorationTake {
  allocationId: string;
  batchId: string | null;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  unitCost: number | null;
  value: RialText;
}

/**
 * Decide how much of a returned quantity each original allocation takes back,
 * consuming open quantity first-expired-first-out (the same order the sale
 * consumed it, so a return unwinds the lots in the order they left).
 * Throws when the line simply has no open quantity left to return.
 */
export function planBatchRestoration(
  allocations: RestorableAllocation[],
  quantity: string,
  today?: string,
): RestorationTake[] {
  const wanted = quantityText(quantity);
  if (new Decimal(wanted).lte(0)) throw new RetailBatchError("تعداد مرجوعی باید بزرگ‌تر از صفر باشد.");

  const open = allocations
    .map((a) => ({
      allocation: a,
      remaining: new Decimal(a.quantity).minus(a.restoredQuantity).minus(a.disposedQuantity),
    }))
    .filter((row) => row.remaining.gt(0));

  const sorted = [...open].sort((a, b) => {
    const ea = a.allocation.expiryDate;
    const eb = b.allocation.expiryDate;
    if (ea === eb) return 0;
    if (ea === null) return 1;
    if (eb === null) return -1;
    return Date.parse(`${ea}T00:00:00Z`) - Date.parse(`${eb}T00:00:00Z`);
  });

  const available = open.reduce((sum, row) => sum.plus(row.remaining), new Decimal(0));
  if (available.lt(wanted)) {
    throw new RetailBatchError("مقدار مرجوعی از مقدار فروش‌رفتهٔ این ردیف بیشتر است.");
  }

  let remaining = new Decimal(wanted);
  const takes: RestorationTake[] = [];
  for (const row of sorted) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, row.remaining);
    const qty = take.toFixed();
    takes.push({
      allocationId: row.allocation.id,
      batchId: row.allocation.batchId,
      batchNumber: row.allocation.batchNumber,
      expiryDate: row.allocation.expiryDate,
      quantity: qty,
      unitCost: row.allocation.unitCost,
      value: lineCostValue(qty, row.allocation.unitCost),
    });
    remaining = remaining.minus(take);
  }

  if (today && takes.some((t) => isBatchExpired(t.expiryDate, today))) {
    // Not an error: an expired lot coming back is exactly what the
    // `expired`/`no_restock` dispositions exist for. The caller decides;
    // this function only reports the lots.
  }
  return takes;
}

// --------------------------------------------------------------------- DB half

interface BatchRow extends Record<string, unknown> {
  id: string;
  batch_number: string;
  expiry_date: string | null;
  quantity: string;
  unit_cost: string | null;
}

function mapLot(row: BatchRow): BatchLot {
  return {
    id: row.id,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date,
    quantity: row.quantity,
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
  };
}

/** Today, ISO — injectable through the callers' own `today` options for tests. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * An item's batches, locked for update — the read every allocating caller
 * starts from. `FOR UPDATE` on the batch rows (not just `item_stock`) is what
 * makes two concurrent sales of the same last units serialize.
 */
export async function loadBatchLotsForUpdate(client: PoolClient, itemId: string): Promise<BatchLot[]> {
  const { rows } = await client.query<BatchRow>(
    `SELECT id, batch_number, expiry_date::text AS expiry_date, quantity, unit_cost::text AS unit_cost
       FROM item_batches WHERE item_id = $1 ORDER BY expiry_date NULLS LAST, batch_number FOR UPDATE`,
    [itemId],
  );
  return rows.map(mapLot);
}

/** Allocates FEFO from the item's live batch rows. Does not mutate anything. */
export async function allocateBatchStock(
  client: PoolClient,
  input: { itemId: string; quantity: string; today?: string },
): Promise<BatchAllocation[]> {
  const lots = await loadBatchLotsForUpdate(client, input.itemId);
  return allocateBatchLots(lots, input.quantity, input.today ?? todayIso());
}

/**
 * Relieves exactly the allocated batch rows and recomputes the item's rollup,
 * in the caller's transaction. This is the one write a batch consumption goes
 * through — nothing else may touch `item_batches.quantity` for a sale.
 */
export async function consumeBatchAllocations(
  client: PoolClient,
  itemId: string,
  allocations: BatchAllocation[],
): Promise<void> {
  if (allocations.length === 0) return;
  for (const allocation of allocations) {
    const { rowCount } = await client.query(
      `UPDATE item_batches SET quantity = quantity - $2
        WHERE id = $1 AND item_id = $3 AND quantity >= $2`,
      [allocation.batchId, allocation.quantity, itemId],
    );
    if (rowCount !== 1) {
      throw new RetailBatchError("موجودی بچ کافی نیست؛ فروش انجام نشد.");
    }
  }
  await recomputeItemStockRollup(client, itemId);
}

/**
 * The 0078 invariant, in one implementation: `item_stock.quantity` is the SUM
 * of the item's batches and `item_stock.unit_cost` their weighted average
 * (falling back to the existing stock cost when no batch carries a cost).
 * Every batch mutation ends here, so the rollup can never drift.
 */
export async function recomputeItemStockRollup(client: PoolClient, itemId: string): Promise<void> {
  const { rows: existingRows } = await client.query<{ unit_cost: string | null }>(
    `SELECT unit_cost::text AS unit_cost FROM item_stock WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  const fallback = existingRows[0]?.unit_cost == null ? null : Number(existingRows[0].unit_cost);
  const unitCost = Number(await averageCostAcrossBatches(client, itemId, fallback));
  await client.query(
    `INSERT INTO item_stock (item_id, quantity, unit_cost)
     VALUES ($1, (SELECT COALESCE(SUM(quantity), 0) FROM item_batches WHERE item_id = $1), $2)
     ON CONFLICT (item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost, updated_at = now()`,
    [itemId, unitCost],
  );
}

/**
 * Weighted-average unit cost across the batches that carry a cost, falling
 * back to the item's existing stock cost when none does. One implementation,
 * so the COGS basis and the shelf view can never disagree.
 */
export async function averageCostAcrossBatches(
  client: PoolClient,
  itemId: string,
  fallback: number | null,
): Promise<RialText> {
  const { rows } = await client.query<{ total_value: string; total_qty: string }>(
    `SELECT COALESCE(SUM(quantity * unit_cost), 0)::text AS total_value,
            COALESCE(SUM(quantity), 0)::text AS total_qty
       FROM item_batches
      WHERE item_id = $1 AND unit_cost IS NOT NULL`,
    [itemId],
  );
  const qty = new Decimal(rows[0].total_qty);
  if (qty.lte(0)) return rialText(String(fallback ?? 0));
  return roundRial(new Decimal(rows[0].total_value).div(qty));
}

/**
 * Persists what a sold line consumed, one row per batch, so the exact
 * allocation survives the transaction: returns, refunds, voids, COGS
 * reconstruction and recall lookup all read it back.
 */
export async function recordOrderItemBatchAllocations(
  client: PoolClient,
  input: {
    orderItemId: string;
    orderId: string;
    locationId: string;
    itemId: string;
    sourceType: string;
    sourceId: string;
    allocations: BatchAllocation[];
  },
): Promise<void> {
  for (const allocation of input.allocations) {
    await client.query(
      `INSERT INTO order_item_batch_allocations
         (order_item_id, order_id, location_id, item_id, batch_id, batch_number, expiry_date,
          quantity, unit_cost, cost_value, source_type, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12)`,
      [
        input.orderItemId,
        input.orderId,
        input.locationId,
        input.itemId,
        allocation.batchId,
        allocation.batchNumber,
        allocation.expiryDate,
        allocation.quantity,
        allocation.unitCost,
        allocation.costValue,
        input.sourceType,
        input.sourceId,
      ],
    );
  }
}

export interface StoredBatchAllocation {
  id: string;
  batchId: string | null;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  unitCost: number | null;
  costValue: string;
  restoredQuantity: string;
  disposedQuantity: string;
}

export async function listOrderItemBatchAllocations(
  client: PoolClient,
  orderItemId: string,
): Promise<StoredBatchAllocation[]> {
  const { rows } = await client.query<{
    id: string;
    batch_id: string | null;
    batch_number: string;
    expiry_date: string | null;
    quantity: string;
    unit_cost: string | null;
    cost_value: string;
    restored_quantity: string;
    disposed_quantity: string;
  }>(
    `SELECT id, batch_id, batch_number, expiry_date::text AS expiry_date, quantity::text,
            unit_cost::text, cost_value::text, restored_quantity::text, disposed_quantity::text
       FROM order_item_batch_allocations
      WHERE order_item_id = $1
      ORDER BY expiry_date NULLS LAST, created_at`,
    [orderItemId],
  );
  return rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date,
    quantity: row.quantity,
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    costValue: row.cost_value,
    restoredQuantity: row.restored_quantity,
    disposedQuantity: row.disposed_quantity,
  }));
}

/** True when this order line has an exact allocation recorded (not a legacy sale). */
export async function hasBatchAllocations(client: PoolClient, orderItemId: string): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM order_item_batch_allocations WHERE order_item_id = $1 LIMIT 1`,
    [orderItemId],
  );
  return rows.length > 0;
}

export interface RestoreBatchStockResult {
  restockedQuantity: string;
  disposedQuantity: string;
  /** Cost value put back into inventory (0 for a non-restock disposition). */
  restockedValue: RialText;
  takes: RestorationTake[];
  /**
   * True when this exact (line, source_type, source_id) had already accounted
   * for the requested quantity: a replayed webhook delivery restores nothing
   * again and reports the no-op instead of failing on exhausted allocations.
   */
  alreadyRestored: boolean;
}

/**
 * Returns quantity to the batches the sale consumed, in the caller's
 * transaction:
 *
 *   - `restockable` adds each take back to its ORIGINAL `item_batches` row —
 *     the lot's own expiry still governs it — and recomputes the rollup.
 *   - every other disposition records the quantity as disposed of without
 *     putting sellable stock back (damaged, expired, quarantine, tester,
 *     do-not-restock), so a later report can see where it went.
 *
 * The restoration row's unique (allocation, source_type, source_id) index
 * makes a replayed refund delivery idempotent: the second attempt finds the
 * take already recorded and does nothing.
 */
export async function restoreOrderItemBatchStock(
  client: PoolClient,
  input: {
    orderItemId: string;
    itemId: string;
    locationId: string;
    quantity: string;
    disposition: BatchDisposition;
    sourceType: string;
    sourceId: string;
  },
): Promise<RestoreBatchStockResult | null> {
  const stored = await listOrderItemBatchAllocations(client, input.orderItemId);
  if (stored.length === 0) return null;

  // Idempotency before planning: how much has this exact source (a refund
  // delivery, a reversal) already accounted for on this line?
  const { rows: priorRows } = await client.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS quantity FROM order_item_batch_restorations
      WHERE order_item_id = $1 AND source_type = $2 AND source_id = $3`,
    [input.orderItemId, input.sourceType, input.sourceId],
  );
  const prior = new Decimal(priorRows[0].quantity);
  const remaining = new Decimal(quantityText(input.quantity)).minus(prior);
  if (remaining.lte(0)) {
    return {
      restockedQuantity: "0",
      disposedQuantity: "0",
      restockedValue: rialText("0"),
      takes: [],
      alreadyRestored: true,
    };
  }

  const restock = isRestockDisposition(input.disposition);
  const takes = planBatchRestoration(stored, remaining.toFixed());
  let restockedValue = rialText("0");
  let restockedQuantity = new Decimal(0);
  let disposedQuantity = new Decimal(0);

  for (const take of takes) {
    // Idempotency first: has this exact (allocation, source) restoration
    // already been recorded by an earlier delivery of the same event?
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM order_item_batch_restorations
        WHERE allocation_id = $1 AND source_type = $2 AND source_id = $3`,
      [take.allocationId, input.sourceType, input.sourceId],
    );
    if (existing.length > 0) {
      // Already restored by this source — count nothing twice.
      continue;
    }

    if (restock) {
      if (!take.batchId) {
        throw new RetailBatchError("بچ اصلی این ردیف یافت نشد؛ بازگشت به انبار ممکن نیست.");
      }
      const { rowCount } = await client.query(
        `UPDATE item_batches SET quantity = quantity + $2 WHERE id = $1 AND item_id = $3`,
        [take.batchId, take.quantity, input.itemId],
      );
      if (rowCount !== 1) {
        throw new RetailBatchError("بچ اصلی این ردیف یافت نشد؛ بازگشت به انبار ممکن نیست.");
      }
      restockedValue = rialText((BigInt(restockedValue) + BigInt(take.value)).toString());
      restockedQuantity = restockedQuantity.plus(take.quantity);
    } else {
      disposedQuantity = disposedQuantity.plus(take.quantity);
    }

    await client.query(
      `INSERT INTO order_item_batch_restorations
         (allocation_id, order_item_id, location_id, item_id, batch_id, batch_number,
          quantity, disposition, value_rial, source_type, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        take.allocationId,
        input.orderItemId,
        input.locationId,
        input.itemId,
        take.batchId,
        take.batchNumber,
        take.quantity,
        input.disposition,
        restock ? take.value : "0",
        input.sourceType,
        input.sourceId,
      ],
    );

    if (restock) {
      await client.query(
        `UPDATE order_item_batch_allocations
            SET restored_quantity = restored_quantity + $2
          WHERE id = $1`,
        [take.allocationId, take.quantity],
      );
    } else {
      await client.query(
        `UPDATE order_item_batch_allocations
            SET disposed_quantity = disposed_quantity + $2
          WHERE id = $1`,
        [take.allocationId, take.quantity],
      );
    }
  }

  await recomputeItemStockRollup(client, input.itemId);

  return {
    restockedQuantity: restockedQuantity.toFixed(),
    disposedQuantity: disposedQuantity.toFixed(),
    restockedValue,
    takes,
    alreadyRestored: false,
  };
}

/**
 * Moves batch stock between two items (a branch transfer: the destination is
 * a different `items` row) preserving batch identity, number, expiry and
 * cost. Relieves the source lot, merges into the destination lot with the
 * same batch number — re-averaging its unit cost, exactly as a receipt of the
 * same lot does — and rolls both items.
 */
export async function moveBatchStockBetweenItems(
  client: PoolClient,
  input: {
    sourceItemId: string;
    destinationItemId: string;
    allocation: BatchAllocation;
  },
): Promise<{ destinationBatchId: string }> {
  const { batchId, quantity, unitCost, expiryDate, batchNumber } = input.allocation;
  const { rowCount } = await client.query(
    `UPDATE item_batches SET quantity = quantity - $2
      WHERE id = $1 AND item_id = $3 AND quantity >= $2`,
    [batchId, quantity, input.sourceItemId],
  );
  if (rowCount !== 1) throw new RetailBatchError("موجودی بچ مبدأ کافی نیست.");

  const { rows: existing } = await client.query<{ id: string; quantity: string; unit_cost: string | null }>(
    `SELECT id, quantity::text, unit_cost::text FROM item_batches
      WHERE item_id = $1 AND batch_number = $2 FOR UPDATE`,
    [input.destinationItemId, batchNumber],
  );
  let destinationBatchId: string;
  if (existing[0]) {
    const previousQty = new Decimal(existing[0].quantity);
    const previousCost = existing[0].unit_cost == null ? null : new Decimal(existing[0].unit_cost);
    const incoming = new Decimal(quantity);
    const incomingCost = unitCost == null ? null : new Decimal(unitCost);
    const mergedCost =
      previousCost == null ? incomingCost : incomingCost == null ? previousCost : previousQty.plus(incoming).isZero()
        ? incomingCost
        : previousQty.times(previousCost).plus(incoming.times(incomingCost)).div(previousQty.plus(incoming));
    await client.query(
      `UPDATE item_batches
          SET quantity = quantity + $2,
              unit_cost = COALESCE($3, unit_cost),
              expiry_date = COALESCE(expiry_date, $4::date)
        WHERE id = $1`,
      [existing[0].id, quantity, mergedCost == null ? null : roundRial(mergedCost), expiryDate],
    );
    destinationBatchId = existing[0].id;
  } else {
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date, supplier_reference)
       VALUES ($1, $2, $3::date, $4, $5, CURRENT_DATE, NULL)
       RETURNING id`,
      [input.destinationItemId, batchNumber, expiryDate, quantity, unitCost],
    );
    destinationBatchId = inserted[0].id;
  }

  await recomputeItemStockRollup(client, input.sourceItemId);
  await recomputeItemStockRollup(client, input.destinationItemId);
  return { destinationBatchId };
}

// ---------------------------------------------------------------- transfers

interface TransferBatchRow {
  id: string;
  batch_id: string | null;
  batch_number: string;
  expiry_date: string | null;
  quantity: string;
  unit_cost: string | null;
  value_rial: string;
}

/**
 * Relieves a transfer line from the source item's batches and records the
 * exact lots that left, so the destination receives the SAME batches (number,
 * expiry, cost) and a cancelled transfer can put them back where they came
 * from. When the caller names a batch (`batchId`), that lot is used; otherwise
 * the shipment takes FEFO across the sellable lots, exactly like a sale.
 *
 * Used by the shared transfer workflow — there is no separate cosmetics
 * transfer module, by design.
 */
export async function relieveBatchesForTransfer(
  client: PoolClient,
  input: {
    sourceItemId: string;
    transferLineId: string;
    quantity: string;
    batchId?: string | null;
    today?: string;
  },
): Promise<{ allocations: BatchAllocation[]; value: RialText }> {
  const lots = await loadBatchLotsForUpdate(client, input.sourceItemId);
  let allocations: BatchAllocation[];
  if (input.batchId) {
    const lot = lots.find((l) => l.id === input.batchId);
    if (!lot) throw new RetailBatchError("بچ مبدأ یافت نشد.");
    if (new Decimal(lot.quantity).lt(new Decimal(quantityText(input.quantity)))) {
      throw new RetailBatchError("موجودی بچ مبدأ کافی نیست.");
    }
    allocations = [
      {
        batchId: lot.id,
        batchNumber: lot.batchNumber,
        expiryDate: lot.expiryDate,
        quantity: quantityText(input.quantity),
        unitCost: lot.unitCost,
        costValue: lineCostValue(input.quantity, lot.unitCost),
      },
    ];
  } else {
    allocations = allocateBatchLots(lots, input.quantity, input.today ?? todayIso());
  }

  for (const allocation of allocations) {
    const { rowCount } = await client.query(
      `UPDATE item_batches SET quantity = quantity - $2
        WHERE id = $1 AND item_id = $3 AND quantity >= $2`,
      [allocation.batchId, allocation.quantity, input.sourceItemId],
    );
    if (rowCount !== 1) throw new RetailBatchError("موجودی بچ مبدأ کافی نیست.");
    await client.query(
      `INSERT INTO item_stock_transfer_line_batches
         (transfer_line_id, batch_id, batch_number, expiry_date, quantity, unit_cost, value_rial)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7)`,
      [
        input.transferLineId,
        allocation.batchId,
        allocation.batchNumber,
        allocation.expiryDate,
        allocation.quantity,
        allocation.unitCost,
        allocation.costValue,
      ],
    );
  }
  await recomputeItemStockRollup(client, input.sourceItemId);
  return { allocations, value: allocationCostValue(allocations) };
}

/**
 * Receives the lots a shipped transfer recorded into the destination item,
 * merging by lot number (weighted-average cost) exactly as any other receipt
 * of the same lot would, and rolls the destination's stock.
 */
export async function receiveBatchesForTransfer(
  client: PoolClient,
  input: { destinationItemId: string; transferLineId: string },
): Promise<{ value: RialText; batchIds: string[] }> {
  const { rows } = await client.query<TransferBatchRow>(
    `SELECT id, batch_id, batch_number, expiry_date::text AS expiry_date, quantity::text, unit_cost::text, value_rial::text
       FROM item_stock_transfer_line_batches WHERE transfer_line_id = $1 ORDER BY created_at, id`,
    [input.transferLineId],
  );

  let total = 0n;
  const batchIds: string[] = [];
  for (const row of rows) {
    const unitCost = row.unit_cost == null ? null : Number(row.unit_cost);
    const { rows: existing } = await client.query<{ id: string; quantity: string; unit_cost: string | null }>(
      `SELECT id, quantity::text, unit_cost::text FROM item_batches
        WHERE item_id = $1 AND batch_number = $2 FOR UPDATE`,
      [input.destinationItemId, row.batch_number],
    );
    if (existing[0]) {
      const previousQty = new Decimal(existing[0].quantity);
      const previousCost = existing[0].unit_cost == null ? null : new Decimal(existing[0].unit_cost);
      const incomingQty = new Decimal(row.quantity);
      const incomingCost = unitCost == null ? null : new Decimal(unitCost);
      const merged =
        previousCost == null
          ? incomingCost
          : incomingCost == null
            ? previousCost
            : previousQty.plus(incomingQty).isZero()
              ? incomingCost
              : previousQty.times(previousCost).plus(incomingQty.times(incomingCost)).div(previousQty.plus(incomingQty));
      await client.query(
        `UPDATE item_batches
            SET quantity = quantity + $2, unit_cost = COALESCE($3, unit_cost), expiry_date = COALESCE(expiry_date, $4::date)
          WHERE id = $1`,
        [existing[0].id, row.quantity, merged == null ? null : roundRial(merged), row.expiry_date],
      );
      batchIds.push(existing[0].id);
    } else {
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date, supplier_reference)
         VALUES ($1, $2, $3::date, $4, $5, CURRENT_DATE, NULL)
         RETURNING id`,
        [input.destinationItemId, row.batch_number, row.expiry_date, row.quantity, unitCost],
      );
      batchIds.push(inserted[0].id);
    }
    total += BigInt(row.value_rial);
  }

  await recomputeItemStockRollup(client, input.destinationItemId);
  return { value: rialText(total.toString()), batchIds };
}

/**
 * Puts the lots a shipped (not yet received) transfer relieved back into the
 * source item — the cancel path. The exact rows the shipment recorded are
 * restored, so batch identity and cost survive the round trip.
 */
export async function restoreBatchesForTransferCancel(
  client: PoolClient,
  input: { sourceItemId: string; transferLineId: string },
): Promise<{ value: RialText; restoredQuantity: string }> {
  const { rows } = await client.query<TransferBatchRow>(
    `SELECT id, batch_id, batch_number, expiry_date::text AS expiry_date, quantity::text, unit_cost::text, value_rial::text
       FROM item_stock_transfer_line_batches WHERE transfer_line_id = $1 ORDER BY created_at, id`,
    [input.transferLineId],
  );

  let total = 0n;
  let quantity = new Decimal(0);
  for (const row of rows) {
    const unitCost = row.unit_cost == null ? null : Number(row.unit_cost);
    if (!row.batch_id) {
      // The original lot row is gone; recreate it so the quantity returns to
      // a real lot rather than to nowhere.
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date, supplier_reference)
         VALUES ($1, $2, $3::date, $4, $5, CURRENT_DATE, NULL)
         RETURNING id`,
        [input.sourceItemId, row.batch_number, row.expiry_date, row.quantity, unitCost],
      );
      await client.query(`UPDATE item_stock_transfer_line_batches SET batch_id = $2 WHERE id = $1`, [
        row.id,
        inserted[0].id,
      ]);
    } else {
      await client.query(
        `UPDATE item_batches
            SET quantity = quantity + $2, unit_cost = COALESCE(unit_cost, $3)
          WHERE id = $1 AND item_id = $4`,
        [row.batch_id, row.quantity, unitCost, input.sourceItemId],
      );
    }
    total += BigInt(row.value_rial);
    quantity = quantity.plus(row.quantity);
  }

  await recomputeItemStockRollup(client, input.sourceItemId);
  return { value: rialText(total.toString()), restoredQuantity: quantity.toFixed() };
}
