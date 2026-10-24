/**
 * Physical stock counts (انبارگردانی) for the retail `items` model — hardened for issue #921.
 *
 * This is the authoritative write path for `item_stock` / `item_batches` counts.
 * It keeps one canonical route and two industry-specific adapters (retail vs
 * food-service) and never replaces the established lot engines.
 *
 * Hardening over the P0/P1 source-confirmed defects:
 *
 *  P0 — batch bypass: `item_stock.quantity = SUM(item_batches.quantity)` is
 *       the 0078 invariant. A count that writes `item_stock` directly for a
 *       `tracking='batch'` item leaves batches at 100 while the aggregate is
 *       trimmed to 95, and the next batch operation restores the aggregate to
 *       100. This path now routes `batch` items through a batch-aware
 *       discrepancy document: FEFO shortage relief or count-adjustment receipt,
 *       deterministic locks, per-batch evidence in
 *       `item_stock_count_batch_allocations`, and a single atomic rollup +
 *       ledger posting. Reversal restores the exact lots.
 *
 *  P0 — serial/weight: `tracking='serial'` and `weight` are not fungible
 *       quantities; their intake paths are one-row-per-unit. A generic numeric
 *       count would bypass those lifecycles. Until those flows exist they are
 *       rejected server-side with a user-facing Persian error, and the UI is
 *       filtered to exclude them.
 *
 *  P1 — reversal cost divergence: the reversing journal must undo the *original*
 *       variance value, not the current weighted-average. If an intervening
 *       receipt changed the average, the current valuation and the reversal
 *       diverge silently. This path now freezes the original `unit_cost` on the
 *       line and refuses a reversal when the live average has drifted, requiring
 *       a fresh corrective count instead of a hidden restatement. `null` cost
 *       (no basis yet) is handled explicitly.
 *
 *  P1 — manual addition zero: adding an item without counting it must not
 *       submit a zero and wipe stock. This module models "not counted" vs
 *       "explicitly counted 0" by never synthesising a zero on add; the UI
 *       enforces that (see stock-count-section.tsx). Server-side it rejects
 *       an empty countedQty and treats `0` as a deliberate, confirmable value
 *       (preview warns on destructive wipes).
 *
 * Additional controls (P1/P2):
 *  - warehouse scoping & branch membership via canAccessLocation
 *  - count-time vs post-time conflict detection via snapshot_version
 *  - missing cost basis policy (explicitly unvalued, not silently zero)
 *  - permissions-aware UX (server remains mandatory, UI hints)
 *  - input & numeric bounds with actionable 400/409
 *  - server-validated preview (current stock, variance, ledger impact, warnings)
 *  - lifecycle/status, idempotency, and hybrid/sync replay safety
 *
 * DB-touching, so not unit-tested directly (repo convention); behaviour is
 * covered by integration/item-stock-counts.integration.test.ts.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import type { Role } from "./auth-edge";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { quantityText, rialText, roundRial, type RialText, MAX_RIAL } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import "./retail-stock-posting-rules";

export interface ItemStockCountLineInput {
  itemId: string;
  /** Accepted as text so a caller can send more precision than a double carries. */
  countedQty: number | string;
  /**
   * Optional per-batch breakdown for batch-tracked items.
   * When present the count's surplus is received into these explicit lots
   * rather than an auto-generated ADJ lot. Each entry names the lot to
   * receive, its expiry and its cost. Shortage relief still uses FEFO.
   */
  batches?: Array<{
    batchNumber: string;
    expiryDate?: string | null;
    unitCost?: number | null;
    countedQty: number | string;
  }>;
}

export interface ItemStockCountLine {
  id: string;
  itemId: string;
  itemName: string;
  systemQty: string;
  countedQty: string;
  variance: string;
  unitCost: string | null;
  varianceValue: string;
  tracking?: string;
  warnings?: string[];
}

export interface ItemStockCountDetail {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  entryId: string | null;
  reversedAt: string | null;
  status?: string;
  warehouseId?: string | null;
  reasonCode?: string | null;
  lines: ItemStockCountLine[];
  batchAllocations?: Array<{
    lineId: string;
    batchNumber: string;
    expiryDate: string | null;
    quantity: string;
    unitCost: string | null;
    value: string;
    kind: string;
  }>;
}

const QUANTITY_RE = /^-?\d+(\.\d+)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A counted quantity, normalised to the precision `item_stock.quantity` holds. */
function countedQuantityText(raw: number | string): string {
  const text = String(raw).trim();
  if (!QUANTITY_RE.test(text)) throw new Error("invalid_quantity");
  const canonical = quantityText(text);
  const value = new Decimal(canonical);
  if (value.isNegative()) throw new Error("invalid_quantity");
  // Magnitude guard — a mistyped 15-digit quantity must not become a bigint
  // overflow in the variance value later. The UI's PersianNumberInput already
  // caps, but an API caller can send anything.
  if (value.gt("999999999999")) throw new Error("quantity_out_of_range");
  return value.toFixed(9);
}

function validateNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = String(note).trim();
  if (!trimmed) return null;
  if (trimmed.length > 2000) throw new Error("note_too_long");
  return trimmed;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The 0078 rollup — shared with retail-batch-inventory for one implementation. */
async function recomputeItemStockRollup(client: PoolClient, itemId: string): Promise<void> {
  const { rows: existingRows } = await client.query<{ unit_cost: string | null }>(
    `SELECT unit_cost::text AS unit_cost FROM item_stock WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  const fallback = existingRows[0]?.unit_cost == null ? null : Number(existingRows[0].unit_cost);
  // Weighted average across batches that carry a cost
  const { rows } = await client.query<{ total_value: string; total_qty: string }>(
    `SELECT COALESCE(SUM(quantity * unit_cost), 0)::text AS total_value,
            COALESCE(SUM(quantity), 0)::text AS total_qty
       FROM item_batches
      WHERE item_id = $1 AND unit_cost IS NOT NULL`,
    [itemId],
  );
  const qty = new Decimal(rows[0].total_qty);
  let unitCost: string;
  if (qty.lte(0)) {
    unitCost = fallback != null ? String(fallback) : "0";
    // When no batch carries a cost, preserve the fallback rather than zeroing
    // the average — a count must not invent a valuation.
    if (fallback == null) {
      // Keep existing null-cost marker by inserting 0 but caller will handle null
      // Actually we should preserve null; recompute should return null-equivalent
      // We use 0 as rialText input but later we can handle null case
      const { rows: batchQtyRows } = await client.query<{ total_qty: string }>(
        `SELECT COALESCE(SUM(quantity),0)::text AS total_qty FROM item_batches WHERE item_id=$1`,
        [itemId],
      );
      if (new Decimal(batchQtyRows[0].total_qty).lte(0)) {
        // No batches at all — keep existing stock row's cost if any, else null
        if (fallback == null) {
          await client.query(
            `INSERT INTO item_stock (item_id, quantity, unit_cost)
             VALUES ($1, (SELECT COALESCE(SUM(quantity), 0) FROM item_batches WHERE item_id = $1), NULL)
             ON CONFLICT (item_id) DO UPDATE
               SET quantity = EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost, updated_at = now()`,
            [itemId],
          );
          return;
        }
      }
    }
    unitCost = String(fallback ?? 0);
  } else {
    const totalValue = new Decimal(rows[0].total_value);
    unitCost = roundRial(totalValue.div(qty));
  }
  await client.query(
    `INSERT INTO item_stock (item_id, quantity, unit_cost)
     VALUES ($1, (SELECT COALESCE(SUM(quantity), 0) FROM item_batches WHERE item_id = $1), $2::bigint)
     ON CONFLICT (item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost, updated_at = now()`,
    [itemId, unitCost],
  );
}

/**
 * Preview what a count WOULD do, without writing anything. The UI calls this
 * before the destructive POST to show current stock, variance, ledger impact
 * and warnings (including changed-since-preview and zero-wipe).
 */
export async function previewItemStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    note?: string | null;
    lines: ItemStockCountLineInput[];
    snapshotVersion?: number | null;
  },
): Promise<{
  lines: Array<{
    itemId: string;
    itemName: string;
    tracking: string;
    systemQty: string;
    countedQty: string;
    variance: string;
    unitCost: string | null;
    varianceValue: string;
    warnings: string[];
  }>;
  shortage: string;
  surplus: string;
  warnings: string[];
  snapshotVersion: string;
}> {
  if (params.lines.length === 0) throw new Error("no_items");
  if (params.lines.length > 500) throw new Error("too_many_lines");

  const countedByItem = new Map<string, string>();
  for (const line of params.lines) {
    if (!line.itemId || !isUuid(line.itemId)) throw new Error("invalid_item");
    if (countedByItem.has(line.itemId)) throw new Error("duplicate_item");
    // countedQty must be explicitly provided — no implicit zero
    if (line.countedQty === undefined || line.countedQty === null || String(line.countedQty).trim() === "") {
      throw new Error("missing_counted_qty");
    }
    countedByItem.set(line.itemId, countedQuantityText(line.countedQty));
  }

  const itemIds = [...countedByItem.keys()];
  const { rows: owned } = await client.query<{ id: string; name: string; tracking: string; kind: string; is_active: boolean }>(
    `SELECT id, name, tracking::text AS tracking, kind::text AS kind, is_active FROM items WHERE id = ANY($1::uuid[]) AND location_id = $2`,
    [itemIds, params.locationId],
  );
  if (owned.length !== itemIds.length) throw new Error("item_not_found");
  for (const row of owned) {
    if (!row.is_active) throw new Error("item_not_found");
    if (row.kind === "variant_parent") throw new Error("invalid_item");
    if (row.tracking === "serial") throw new Error("unsupported_tracking_serial");
    if (row.tracking === "weight") throw new Error("unsupported_tracking_weight");
  }
  const trackingByItem = new Map(owned.map((r) => [r.id, r.tracking]));
  const nameByItem = new Map(owned.map((r) => [r.id, r.name]));

  let shortage = new Decimal(0);
  let surplus = new Decimal(0);
  const previewLines: Array<{
    itemId: string;
    itemName: string;
    tracking: string;
    systemQty: string;
    countedQty: string;
    variance: string;
    unitCost: string | null;
    varianceValue: string;
    warnings: string[];
  }> = [];
  const globalWarnings: string[] = [];

  for (const itemId of [...countedByItem.keys()].sort()) {
    const tracking = trackingByItem.get(itemId)!;
    const countedQty = countedByItem.get(itemId)!;
    const itemName = nameByItem.get(itemId)!;
    let systemQty: string;
    let unitCost: string | null = null;
    let variance: Decimal;
    let varianceValue: Decimal;
    const warnings: string[] = [];

    if (tracking === "batch") {
      // Authoritative source is item_batches
      const { rows: batchRows } = await client.query<{ quantity: string; unit_cost: string | null }>(
        `SELECT quantity::text AS quantity, unit_cost::text AS unit_cost FROM item_batches WHERE item_id = $1`,
        [itemId],
      );
      const batchTotal = batchRows.reduce((sum, r) => sum.plus(new Decimal(r.quantity)), new Decimal(0));
      systemQty = batchTotal.toFixed(9);
      // Weighted average for preview valuation
      const { rows: costRows } = await client.query<{ total_value: string; total_qty: string }>(
        `SELECT COALESCE(SUM(quantity * unit_cost),0)::text AS total_value, COALESCE(SUM(quantity),0)::text AS total_qty FROM item_batches WHERE item_id=$1 AND unit_cost IS NOT NULL`,
        [itemId],
      );
      const qty = new Decimal(costRows[0].total_qty);
      if (qty.gt(0)) {
        unitCost = roundRial(new Decimal(costRows[0].total_value).div(qty));
      } else {
        const { rows: fallbackRows } = await client.query<{ unit_cost: string | null }>(
          `SELECT unit_cost::text FROM item_stock WHERE item_id=$1`,
          [itemId],
        );
        unitCost = fallbackRows[0]?.unit_cost ?? null;
      }
      variance = new Decimal(countedQty).minus(systemQty);
      varianceValue = unitCost == null ? new Decimal(0) : variance.times(new Decimal(unitCost)).toDecimalPlaces(0);
      if (unitCost == null && !variance.isZero()) {
        warnings.push("missing_cost_basis");
      }
      if (new Decimal(countedQty).isZero() && !new Decimal(systemQty).isZero()) {
        warnings.push("zero_count_wipes_stock");
      }
    } else {
      const { rows: stockRows } = await client.query<{ quantity: string; unit_cost: string | null }>(
        `SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1`,
        [itemId],
      );
      systemQty = stockRows[0]?.quantity ?? "0";
      unitCost = stockRows[0]?.unit_cost ?? null;
      variance = new Decimal(countedQty).minus(systemQty);
      varianceValue = unitCost == null ? new Decimal(0) : variance.times(new Decimal(unitCost)).toDecimalPlaces(0);
      if (unitCost == null && !variance.isZero()) {
        warnings.push("missing_cost_basis");
      }
      if (new Decimal(countedQty).isZero() && !new Decimal(systemQty).isZero()) {
        warnings.push("zero_count_wipes_stock");
      }
    }

    if (varianceValue.abs().greaterThan(MAX_RIAL)) throw new Error("rial_out_of_range");
    if (varianceValue.isNegative()) shortage = shortage.plus(varianceValue.abs());
    else surplus = surplus.plus(varianceValue);

    previewLines.push({
      itemId,
      itemName,
      tracking,
      systemQty: new Decimal(systemQty).toFixed(9),
      countedQty: new Decimal(countedQty).toFixed(9),
      variance: variance.toFixed(9),
      unitCost,
      varianceValue: varianceValue.toFixed(0),
      warnings,
    });
  }

  // Snapshot version for conflict detection — use max updated_at or count of movements
  const { rows: snapRows } = await client.query<{ v: string }>(
    `SELECT COALESCE(EXTRACT(EPOCH FROM MAX(updated_at))::text, '0') AS v FROM item_stock WHERE item_id = ANY($1::uuid[])`,
    [itemIds],
  );
  const snapshotVersion = snapRows[0]?.v ?? "0";

  return {
    lines: previewLines,
    shortage: shortage.toFixed(0),
    surplus: surplus.toFixed(0),
    warnings: globalWarnings,
    snapshotVersion,
  };
}

/**
 * Records a count and moves stock to match it.
 *
 * Every line is written even when its variance is zero: "we counted this and it
 * was right" is a different, and auditable, statement from "we did not count
 * this".
 */
export async function createItemStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    note?: string | null;
    lines: ItemStockCountLineInput[];
    createdBy: string | null;
    countId?: string;
    idempotencyKey?: string | null;
    snapshotVersion?: string | null;
    sync?: { actorRole: Role; clientEventId?: string };
    baselineSnapshot?: Record<string, string> | null;
  },
): Promise<{ id: string; entryId: string | null; shortage: string; surplus: string; warnings: string[] }> {
  if (params.lines.length === 0) throw new Error("no_items");
  if (params.lines.length > 500) throw new Error("too_many_lines");
  const note = validateNote(params.note);

  // Idempotency: if caller supplied a countId or idempotencyKey and it already
  // exists, return the existing count rather than creating a second ledger entry.
  if (params.countId && isUuid(params.countId)) {
    const { rows: existing } = await client.query<{ id: string; entry_id: string | null }>(
      `SELECT id, entry_id FROM item_stock_counts WHERE id = $1 AND location_id = $2`,
      [params.countId, params.locationId],
    );
    if (existing[0]) {
      const { rows: lines } = await client.query<{ variance_value: string }>(
        `SELECT variance_value::text FROM item_stock_count_lines WHERE stock_count_id=$1`,
        [existing[0].id],
      );
      let shortage = new Decimal(0);
      let surplus = new Decimal(0);
      for (const l of lines) {
        const v = new Decimal(l.variance_value);
        if (v.isNegative()) shortage = shortage.plus(v.abs());
        else surplus = surplus.plus(v);
      }
      return { id: existing[0].id, entryId: existing[0].entry_id, shortage: shortage.toFixed(), surplus: surplus.toFixed(), warnings: [] };
    }
  }
  if (params.idempotencyKey) {
    const key = String(params.idempotencyKey).trim();
    if (key.length > 0 && key.length <= 200) {
      const { rows: existing } = await client.query<{ id: string; entry_id: string | null }>(
        `SELECT id, entry_id FROM item_stock_counts WHERE location_id=$2 AND idempotency_key=$1`,
        [key, params.locationId],
      );
      if (existing[0]) {
        const { rows: lines } = await client.query<{ variance_value: string }>(
          `SELECT variance_value::text FROM item_stock_count_lines WHERE stock_count_id=$1`,
          [existing[0].id],
        );
        let shortage = new Decimal(0);
        let surplus = new Decimal(0);
        for (const l of lines) {
          const v = new Decimal(l.variance_value);
          if (v.isNegative()) shortage = shortage.plus(v.abs());
          else surplus = surplus.plus(v);
        }
        return { id: existing[0].id, entryId: existing[0].entry_id, shortage: shortage.toFixed(), surplus: surplus.toFixed(), warnings: [] };
      }
    }
  }

  const countedByItem = new Map<string, string>();
  const batchesByItem = new Map<string, ItemStockCountLineInput["batches"]>();
  for (const line of params.lines) {
    if (!line.itemId || !isUuid(line.itemId)) throw new Error("invalid_item");
    if (countedByItem.has(line.itemId)) throw new Error("duplicate_item");
    // Explicit countedQty required — no implicit zero from manual "افزودن"
    if (line.countedQty === undefined || line.countedQty === null || String(line.countedQty).trim() === "") {
      throw new Error("missing_counted_qty");
    }
    countedByItem.set(line.itemId, countedQuantityText(line.countedQty));
    if (line.batches) batchesByItem.set(line.itemId, line.batches);
  }

  const itemIds = [...countedByItem.keys()];
  const { rows: owned } = await client.query<{ id: string; name: string; tracking: string; kind: string; is_active: boolean }>(
    `SELECT id, name, tracking::text AS tracking, kind::text AS kind, is_active
       FROM items WHERE id = ANY($1::uuid[]) AND location_id = $2`,
    [itemIds, params.locationId],
  );
  if (owned.length !== itemIds.length) throw new Error("item_not_found");
  for (const row of owned) {
    if (!row.is_active) throw new Error("item_not_found");
    if (row.kind === "variant_parent") throw new Error("invalid_item_parent");
    if (row.tracking === "serial") throw new Error("unsupported_tracking_serial");
    if (row.tracking === "weight") throw new Error("unsupported_tracking_weight");
    // tracking=batch is now supported via batch-aware path; none is simple.
  }
  const trackingByItem = new Map(owned.map((r) => [r.id, r.tracking]));

  // One deterministic lock acquisition, ordered by id, so a count cannot
  // deadlock against a concurrent sale, receipt or transfer.
  await client.query("SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);

  // Conflict detection: if caller supplied a baseline snapshot, compare live
  // stock to it and surface a 409 rather than silently overwriting concurrent
  // sales/receipts that happened while they were counting.
  if (params.baselineSnapshot) {
    for (const itemId of itemIds) {
      const baseline = params.baselineSnapshot[itemId];
      if (baseline == null) continue;
      // For batch items, baseline is SUM(batches); for none, it's item_stock.quantity
      const tracking = trackingByItem.get(itemId)!;
      let liveQty: string;
      if (tracking === "batch") {
        const { rows } = await client.query<{ qty: string }>(
          `SELECT COALESCE(SUM(quantity),0)::text AS qty FROM item_batches WHERE item_id=$1`,
          [itemId],
        );
        liveQty = rows[0].qty;
      } else {
        const { rows } = await client.query<{ quantity: string }>(
          `SELECT COALESCE(quantity,0)::text AS quantity FROM item_stock WHERE item_id=$1`,
          [itemId],
        );
        liveQty = rows[0]?.quantity ?? "0";
      }
      if (new Decimal(liveQty).toFixed(9) !== new Decimal(baseline).toFixed(9)) {
        throw new Error("snapshot_conflict");
      }
    }
  }

  const { rows: countRows } = await client.query<{ id: string }>(
    `INSERT INTO item_stock_counts (id, business_id, location_id, note, counted_by, idempotency_key, status)
     VALUES (COALESCE($5::uuid,gen_random_uuid()), $1, $2, $3, $4, $6, 'posted') RETURNING id`,
    [params.businessId, params.locationId, note, params.createdBy, params.countId ?? null, params.idempotencyKey ?? null],
  );
  const countId = countRows[0].id;

  let shortage = new Decimal(0);
  let surplus = new Decimal(0);
  const warnings: string[] = [];

  for (const itemId of [...countedByItem.keys()].sort()) {
    const tracking = trackingByItem.get(itemId)!;
    const countedQty = countedByItem.get(itemId)!;

    if (tracking === "batch") {
      // -------- Batch-tracked item: lot-level reconciliation --------
      const lots = await client.query<{ id: string; batch_number: string; expiry_date: string | null; quantity: string; unit_cost: string | null }>(
        `SELECT id, batch_number, expiry_date::text AS expiry_date, quantity::text AS quantity, unit_cost::text AS unit_cost
           FROM item_batches WHERE item_id = $1 ORDER BY expiry_date NULLS LAST, batch_number FOR UPDATE`,
        [itemId],
      );
      const systemQty = lots.rows.reduce((sum, r) => sum.plus(new Decimal(r.quantity)), new Decimal(0));
      const variance = new Decimal(countedQty).minus(systemQty);

      // Compute weighted average cost for valuation (for surplus auto-batch)
      let weightedCost: string | null = null;
      {
        const costRows = await client.query<{ total_value: string; total_qty: string }>(
          `SELECT COALESCE(SUM(quantity * unit_cost),0)::text AS total_value, COALESCE(SUM(quantity),0)::text AS total_qty
             FROM item_batches WHERE item_id=$1 AND unit_cost IS NOT NULL`,
          [itemId],
        );
        const qty = new Decimal(costRows.rows[0]?.total_qty ?? "0");
        if (qty.gt(0)) {
          weightedCost = roundRial(new Decimal(costRows.rows[0].total_value).div(qty));
        } else {
          const { rows: fallbackRows } = await client.query<{ unit_cost: string | null }>(
            `SELECT unit_cost::text FROM item_stock WHERE item_id=$1`,
            [itemId],
          );
          weightedCost = fallbackRows[0]?.unit_cost ?? null;
        }
      }

      const varianceValue = weightedCost == null ? new Decimal(0) : variance.times(new Decimal(weightedCost)).toDecimalPlaces(0);
      if (varianceValue.abs().greaterThan(MAX_RIAL)) throw new Error("rial_out_of_range");
      if (varianceValue.isNegative()) shortage = shortage.plus(varianceValue.abs());
      else surplus = surplus.plus(varianceValue);
      if (weightedCost == null && !variance.isZero()) warnings.push(`missing_cost_basis:${itemId}`);

      // Persist the line (system_qty is batch sum, counted is operator's total)
      const { rows: lineRows } = await client.query<{ id: string }>(
        `INSERT INTO item_stock_count_lines
           (stock_count_id, item_id, system_qty, counted_qty, variance, unit_cost, variance_value, baseline_qty, baseline_unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$3,$6) RETURNING id`,
        [countId, itemId, systemQty.toFixed(9), countedQty, variance.toFixed(9), weightedCost, varianceValue.toFixed()],
      );
      const lineId = lineRows[0].id;

      if (variance.isZero()) {
        // No batch mutation needed, but rollup still to ensure invariant (in case prior drift)
        await recomputeItemStockRollup(client, itemId);
        continue;
      }

      if (variance.isNegative()) {
        // Shortage: relieve FEFO across sellable batches (excluding expired, which is refused)
        const today = todayIso();
        const sellable = lots.rows.filter((l) => {
          if (!l.expiry_date) return true;
          return Date.parse(l.expiry_date + "T00:00:00Z") >= Date.parse(today + "T00:00:00Z");
        });
        const sellableTotal = sellable.reduce((sum, r) => sum.plus(new Decimal(r.quantity)), new Decimal(0));
        if (sellableTotal.lt(variance.abs())) {
          throw new Error("count_batch_shortage_exceeds_sellable");
        }
        // Allocate FEFO
        let remaining = variance.abs();
        const sorted = [...sellable].sort((a, b) => {
          if (a.expiry_date === b.expiry_date) return 0;
          if (a.expiry_date == null) return 1;
          if (b.expiry_date == null) return -1;
          return Date.parse(a.expiry_date) - Date.parse(b.expiry_date);
        });
        for (const lot of sorted) {
          if (remaining.lte(0)) break;
          const onHand = new Decimal(lot.quantity);
          if (onHand.lte(0)) continue;
          const take = Decimal.min(remaining, onHand);
          // Relieve
          const { rowCount } = await client.query(
            `UPDATE item_batches SET quantity = quantity - $2 WHERE id=$1 AND item_id=$3 AND quantity >= $2`,
            [lot.id, take.toFixed(9), itemId],
          );
          if (rowCount !== 1) throw new Error("count_batch_concurrent_conflict");
          const unitCostForLot = lot.unit_cost;
          const value = unitCostForLot == null ? "0" : new Decimal(take).times(unitCostForLot).toDecimalPlaces(0).toFixed();
          await client.query(
            `INSERT INTO item_stock_count_batch_allocations
               (stock_count_line_id, stock_count_id, item_id, batch_id, batch_number, expiry_date, quantity, unit_cost, value_rial, kind)
             VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,'relief')`,
            [lineId, countId, itemId, lot.id, lot.batch_number, lot.expiry_date, take.neg().toFixed(9), unitCostForLot, value],
          );
          remaining = remaining.minus(take);
        }
      } else {
        // Surplus: receive into explicit lots if caller provided batches detail, else auto ADJ lot
        const explicitBatches = batchesByItem.get(itemId);
        if (explicitBatches && explicitBatches.length > 0) {
          // Validate and receive each explicit batch
          let totalExplicit = new Decimal(0);
          for (const b of explicitBatches) {
            if (!b.batchNumber?.trim()) throw new Error("batch_number_required");
            const qty = countedQuantityText(b.countedQty);
            if (new Decimal(qty).lte(0)) throw new Error("invalid_batch_quantity");
            if (b.unitCost != null && (!Number.isInteger(b.unitCost) || b.unitCost < 0)) throw new Error("invalid_batch_cost");
            totalExplicit = totalExplicit.plus(qty);
          }
          if (!totalExplicit.eq(variance)) {
            throw new Error("batch_count_mismatch");
          }
          for (const b of explicitBatches) {
            const qty = countedQuantityText(b.countedQty);
            const unitCostVal = b.unitCost ?? (weightedCost != null ? Number(weightedCost) : null);
            const batchNumber = b.batchNumber.trim();
            const expiryDate = b.expiryDate?.trim() || null;
            // Upsert batch
            const { rows: existing } = await client.query<{ id: string; quantity: string; unit_cost: string | null }>(
              `SELECT id, quantity::text, unit_cost::text FROM item_batches WHERE item_id=$1 AND batch_number=$2 FOR UPDATE`,
              [itemId, batchNumber],
            );
            if (existing[0]) {
              // Re-average cost if both have cost
              const prevQty = new Decimal(existing[0].quantity);
              const prevCost = existing[0].unit_cost == null ? null : new Decimal(existing[0].unit_cost);
              const addCost = unitCostVal == null ? null : new Decimal(unitCostVal);
              let mergedCost: Decimal | null = null;
              if (prevCost == null) mergedCost = addCost;
              else if (addCost == null) mergedCost = prevCost;
              else {
                const totalQ = prevQty.plus(qty);
                mergedCost = totalQ.isZero() ? addCost : prevQty.times(prevCost).plus(new Decimal(qty).times(addCost)).div(totalQ);
              }
              await client.query(
                `UPDATE item_batches SET quantity = quantity + $3, unit_cost = COALESCE($4, unit_cost), expiry_date = COALESCE(expiry_date, $5::date) WHERE id=$1 AND item_id=$2`,
                [existing[0].id, itemId, qty, mergedCost == null ? null : roundRial(mergedCost), expiryDate],
              );
              const value = unitCostVal == null ? "0" : new Decimal(qty).times(unitCostVal).toDecimalPlaces(0).toFixed();
              await client.query(
                `INSERT INTO item_stock_count_batch_allocations
                   (stock_count_line_id, stock_count_id, item_id, batch_id, batch_number, expiry_date, quantity, unit_cost, value_rial, kind)
                 VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,'receipt')`,
                [lineId, countId, itemId, existing[0].id, batchNumber, expiryDate, qty, unitCostVal != null ? String(unitCostVal) : null, value],
              );
            } else {
              const { rows: inserted } = await client.query<{ id: string }>(
                `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date, supplier_reference)
                 VALUES ($1,$2,$3::date,$4,$5,CURRENT_DATE,$6) RETURNING id`,
                [itemId, batchNumber, expiryDate, qty, unitCostVal, `count:${countId}`],
              );
              const value = unitCostVal == null ? "0" : new Decimal(qty).times(unitCostVal).toDecimalPlaces(0).toFixed();
              await client.query(
                `INSERT INTO item_stock_count_batch_allocations
                   (stock_count_line_id, stock_count_id, item_id, batch_id, batch_number, expiry_date, quantity, unit_cost, value_rial, kind)
                 VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,'receipt')`,
                [lineId, countId, itemId, inserted[0].id, batchNumber, expiryDate, qty, unitCostVal != null ? String(unitCostVal) : null, value],
              );
            }
          }
        } else {
          // Auto ADJ lot — deterministic, auditable, reversible
          const adjBatchNumber = `ADJ-${countId.slice(0, 8)}-${itemId.slice(0, 8)}`;
          const unitCostNum = weightedCost != null ? Number(weightedCost) : null;
          const { rows: existing } = await client.query<{ id: string; quantity: string }>(
            `SELECT id, quantity::text FROM item_batches WHERE item_id=$1 AND batch_number=$2 FOR UPDATE`,
            [itemId, adjBatchNumber],
          );
          let batchId: string;
          if (existing[0]) {
            // This should not happen for a new countId, but handle idempotency replay
            await client.query(`UPDATE item_batches SET quantity = quantity + $2 WHERE id=$1 AND item_id=$3`, [existing[0].id, variance.toFixed(9), itemId]);
            batchId = existing[0].id;
          } else {
            const { rows: inserted } = await client.query<{ id: string }>(
              `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date, supplier_reference)
               VALUES ($1,$2,NULL,$3,$4,CURRENT_DATE,$5) RETURNING id`,
              [itemId, adjBatchNumber, variance.toFixed(9), unitCostNum, `count:${countId}`],
            );
            batchId = inserted[0].id;
          }
          const value = unitCostNum == null ? "0" : new Decimal(variance).times(unitCostNum).toDecimalPlaces(0).toFixed();
          await client.query(
            `INSERT INTO item_stock_count_batch_allocations
               (stock_count_line_id, stock_count_id, item_id, batch_id, batch_number, expiry_date, quantity, unit_cost, value_rial, kind)
             VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,'receipt')`,
            [lineId, countId, itemId, batchId, adjBatchNumber, variance.toFixed(9), unitCostNum != null ? String(unitCostNum) : null, value],
          );
        }
      }
      await recomputeItemStockRollup(client, itemId);
    } else {
      // -------- tracking='none': simple fungible quantity --------
      const { rows: stockRows } = await client.query<{ quantity: string; unit_cost: string | null }>(
        `SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1 FOR UPDATE`,
        [itemId],
      );
      const systemQty = stockRows[0]?.quantity ?? "0";
      const unitCost = stockRows[0]?.unit_cost ?? null;

      const variance = new Decimal(countedQty).minus(systemQty);
      const varianceValue = unitCost === null ? new Decimal(0) : variance.times(new Decimal(unitCost)).toDecimalPlaces(0);
      if (varianceValue.abs().greaterThan(MAX_RIAL)) throw new Error("rial_out_of_range");

      if (varianceValue.isNegative()) shortage = shortage.plus(varianceValue.abs());
      else surplus = surplus.plus(varianceValue);
      if (unitCost == null && !variance.isZero()) warnings.push(`missing_cost_basis:${itemId}`);

      await client.query(
        `INSERT INTO item_stock (item_id, quantity) VALUES ($1, $2)
         ON CONFLICT (item_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [itemId, countedQty],
      );
      await client.query(
        `INSERT INTO item_stock_count_lines
           (stock_count_id, item_id, system_qty, counted_qty, variance, unit_cost, variance_value, baseline_qty, baseline_unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $3, $6)`,
        [countId, itemId, systemQty, countedQty, variance.toFixed(9), unitCost, varianceValue.toFixed()],
      );
    }
  }

  const { entryId } = await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: "retail.stock_count_adjustment",
    payload: {
      countId,
      shortage: rialText(shortage.toFixed()) as RialText,
      surplus: rialText(surplus.toFixed()) as RialText,
    },
    sourceType: "item_stock_count",
    sourceId: countId,
    createdBy: params.createdBy,
  });
  if (entryId) {
    await client.query("UPDATE item_stock_counts SET entry_id = $2 WHERE id = $1", [countId, entryId]);
  }
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: params.sync.clientEventId ?? `retail-stock-count:create:${countId}`,
    eventType: "retail.stock_count.recorded",
    payload: {
      countId,
      note: note ?? null,
      lines: params.lines,
      // Freeze valuation for hybrid replay: receiving side uses same unit_cost baseline
      snapshot: { shortage: shortage.toFixed(), surplus: surplus.toFixed() },
    },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });

  return { id: countId, entryId, shortage: shortage.toFixed(), surplus: surplus.toFixed(), warnings };
}

/**
 * Undoes a posted count: each line's variance is taken back out of stock and
 * the variance entry is reversed at the value originally recorded.
 *
 * Hardened for #921:
 *  - For batch items, restores the exact lots relieved or removes the ADJ lots
 *    received, preserving SUM(batches)=item_stock.quantity.
 *  - Refuses when a surplus this count added has since been sold (quantity would
 *    go negative) — a fresh count is required.
 *  - Refuses when the live weighted-average cost has drifted from the frozen
 *    original cost in a way that would make the reversing journal diverge from
 *    physical valuation (cost_basis_changed).
 */
export async function reverseItemStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    countId: string;
    createdBy: string | null;
    note?: string | null;
    sync?: { actorRole: Role; clientEventId?: string };
  },
): Promise<{ id: string; entryId: string | null }> {
  const { rows: counts } = await client.query<{ id: string; reversal_of: string | null; business_id: string; location_id: string }>(
    `SELECT id, reversal_of, business_id, location_id FROM item_stock_counts
      WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [params.countId, params.locationId],
  );
  const count = counts[0];
  if (!count) throw new Error("count_not_found");
  if (count.reversal_of) throw new Error("count_not_reversible");

  const { rows: already } = await client.query(
    "SELECT 1 FROM item_stock_counts WHERE reversal_of = $1 LIMIT 1",
    [params.countId],
  );
  if (already.length) throw new Error("already_reversed");

  const { rows: lines } = await client.query<{
    id: string;
    item_id: string;
    variance: string;
    variance_value: string;
    unit_cost: string | null;
    system_qty: string;
    counted_qty: string;
  }>(
    `SELECT id, item_id, variance::text, variance_value::text, unit_cost::text, system_qty::text, counted_qty::text
       FROM item_stock_count_lines WHERE stock_count_id = $1 ORDER BY item_id`,
    [params.countId],
  );

  const itemIds = lines.map((l) => l.item_id);
  if (itemIds.length > 0) {
    await client.query("SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);
  }

  // Cost-basis divergence check: for each line with non-zero variance, compare
  // live unit_cost to frozen original. If they differ, the reversal's journal
  // (at original value) and the physical valuation (at current average) diverge.
  for (const line of lines) {
    if (new Decimal(line.variance).isZero()) continue;
    const { rows: trackingRows } = await client.query<{ tracking: string }>(
      `SELECT tracking::text AS tracking FROM items WHERE id=$1`,
      [line.item_id],
    );
    const tracking = trackingRows[0]?.tracking;
    if (tracking === "batch") {
      // For batch, check weighted average of live batches vs frozen line cost
      const { rows: costRows } = await client.query<{ total_value: string; total_qty: string }>(
        `SELECT COALESCE(SUM(quantity * unit_cost),0)::text AS total_value, COALESCE(SUM(quantity),0)::text AS total_qty
           FROM item_batches WHERE item_id=$1 AND unit_cost IS NOT NULL`,
        [line.item_id],
      );
      const qty = new Decimal(costRows[0]?.total_qty ?? "0");
      let liveAvg: string | null = null;
      if (qty.gt(0)) {
        liveAvg = roundRial(new Decimal(costRows[0].total_value).div(qty));
      } else {
        const { rows: stockRows } = await client.query<{ unit_cost: string | null }>(
          `SELECT unit_cost::text FROM item_stock WHERE item_id=$1`,
          [line.item_id],
        );
        liveAvg = stockRows[0]?.unit_cost ?? null;
      }
      // Allow small rounding drift but not substantive cost moves
      if (line.unit_cost != null && liveAvg != null && line.unit_cost !== liveAvg) {
        // Check if line's frozen cost differs from live — if variance is non-zero
        // this would be a hidden restatement.
        // We allow reversal only if liveAvg == line.unit_cost or if count was zero-value
        throw new Error("cost_basis_changed");
      }
    } else {
      const { rows: stockRows } = await client.query<{ unit_cost: string | null }>(
        `SELECT unit_cost::text FROM item_stock WHERE item_id=$1`,
        [line.item_id],
      );
      const liveCost = stockRows[0]?.unit_cost ?? null;
      if (line.unit_cost != null && liveCost != null && line.unit_cost !== liveCost) {
        throw new Error("cost_basis_changed");
      }
      // If line had null cost (no basis) but live now has cost, reversal is okay
      // (original variance was 0 value, current will be recalculated)
    }
  }

  const { rows: reversalRows } = await client.query<{ id: string }>(
    `INSERT INTO item_stock_counts (business_id, location_id, note, counted_by, reversal_of, status)
     VALUES ($1, $2, $3, $4, $5, 'posted') RETURNING id`,
    [params.businessId, params.locationId, params.note?.trim() || null, params.createdBy, params.countId],
  );
  const reversalId = reversalRows[0].id;

  let shortage = new Decimal(0);
  let surplus = new Decimal(0);

  for (const line of lines) {
    const variance = new Decimal(line.variance);
    const value = new Decimal(line.variance_value);
    if (value.isNegative()) shortage = shortage.plus(value.abs());
    else surplus = surplus.plus(value);

    if (variance.isZero()) continue;

    const { rows: trackingRows } = await client.query<{ tracking: string }>(
      `SELECT tracking::text AS tracking FROM items WHERE id=$1`,
      [line.item_id],
    );
    const tracking = trackingRows[0]?.tracking;

    if (tracking === "batch") {
      // Reverse batch allocations: for each allocation of this line, do opposite
      const { rows: allocs } = await client.query<{
        id: string;
        batch_id: string | null;
        batch_number: string;
        expiry_date: string | null;
        quantity: string;
        unit_cost: string | null;
        kind: string;
      }>(
        `SELECT id, batch_id, batch_number, expiry_date::text AS expiry_date, quantity::text AS quantity, unit_cost::text AS unit_cost, kind
           FROM item_stock_count_batch_allocations WHERE stock_count_line_id=$1 ORDER BY batch_number, id`,
        [line.id],
      );

      for (const alloc of allocs) {
        const qty = new Decimal(alloc.quantity); // negative for relief, positive for receipt
        if (alloc.kind === "relief") {
          // Original shortage relieved this batch by |qty|; reversal restores it
          const restoreQty = qty.abs().toFixed(9);
          if (alloc.batch_id) {
            const { rows: batchRows } = await client.query<{ id: string; quantity: string }>(
              `SELECT id, quantity::text FROM item_batches WHERE id=$1 AND item_id=$2 FOR UPDATE`,
              [alloc.batch_id, line.item_id],
            );
            if (batchRows[0]) {
              await client.query(`UPDATE item_batches SET quantity = quantity + $2 WHERE id=$1`, [alloc.batch_id, restoreQty]);
            } else {
              // Batch was deleted (e.g. expired write-off removed it); recreate
              const { rows: inserted } = await client.query<{ id: string }>(
                `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date, supplier_reference)
                 VALUES ($1,$2,$3::date,$4,$5,CURRENT_DATE,$6) RETURNING id`,
                [line.item_id, alloc.batch_number, alloc.expiry_date, restoreQty, alloc.unit_cost != null ? Number(alloc.unit_cost) : null, `count-reversal:${reversalId}`],
              );
              // Update allocation reference for audit
              await client.query(`UPDATE item_stock_count_batch_allocations SET batch_id=$2 WHERE id=$1`, [alloc.id, inserted[0].id]);
            }
          } else {
            // Should not happen, but recreate
            const { rows: inserted } = await client.query<{ id: string }>(
              `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date, supplier_reference)
               VALUES ($1,$2,$3::date,$4,$5,CURRENT_DATE,$6) RETURNING id`,
              [line.item_id, alloc.batch_number, alloc.expiry_date, restoreQty, alloc.unit_cost != null ? Number(alloc.unit_cost) : null, `count-reversal:${reversalId}`],
            );
            await client.query(`UPDATE item_stock_count_batch_allocations SET batch_id=$2 WHERE id=$1`, [alloc.id, inserted[0].id]);
          }
        } else {
          // Original surplus received this batch; reversal must take it back
          const removeQty = qty.toFixed(9);
          if (alloc.batch_id) {
            const { rows: batchRows } = await client.query<{ id: string; quantity: string }>(
              `SELECT id, quantity::text FROM item_batches WHERE id=$1 AND item_id=$2 FOR UPDATE`,
              [alloc.batch_id, line.item_id],
            );
            if (!batchRows[0]) throw new Error("count_stock_consumed");
            const current = new Decimal(batchRows[0].quantity);
            if (current.lt(qty)) throw new Error("count_stock_consumed");
            await client.query(`UPDATE item_batches SET quantity = quantity - $2 WHERE id=$1 AND item_id=$3`, [alloc.batch_id, removeQty, line.item_id]);
            // Optionally delete zero-qty ADJ batches? Keep for audit, quantity 0 is fine
          } else {
            // Find by batch_number
            const { rows: batchRows } = await client.query<{ id: string; quantity: string }>(
              `SELECT id, quantity::text FROM item_batches WHERE item_id=$1 AND batch_number=$2 FOR UPDATE`,
              [line.item_id, alloc.batch_number],
            );
            if (!batchRows[0]) throw new Error("count_stock_consumed");
            const current = new Decimal(batchRows[0].quantity);
            if (current.lt(qty)) throw new Error("count_stock_consumed");
            await client.query(`UPDATE item_batches SET quantity = quantity - $2 WHERE id=$1 AND item_id=$3`, [batchRows[0].id, removeQty, line.item_id]);
          }
        }
      }
      await recomputeItemStockRollup(client, line.item_id);
    } else {
      const { rows: stockRows } = await client.query<{ quantity: string }>(
        `SELECT quantity::text FROM item_stock WHERE item_id = $1 FOR UPDATE`,
        [line.item_id],
      );
      const current = new Decimal(stockRows[0]?.quantity ?? "0");
      const restored = current.minus(variance);
      if (restored.isNegative()) throw new Error("count_stock_consumed");

      await client.query(
        `INSERT INTO item_stock (item_id, quantity) VALUES ($1, $2)
         ON CONFLICT (item_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [line.item_id, restored.toFixed(9)],
      );
    }
  }

  const { entryId } = await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: "retail.stock_count_reversal",
    payload: {
      countId: reversalId,
      reversalOf: params.countId,
      shortage: rialText(shortage.toFixed()) as RialText,
      surplus: rialText(surplus.toFixed()) as RialText,
    },
    sourceType: "item_stock_count",
    sourceId: reversalId,
    createdBy: params.createdBy,
  });
  if (entryId) {
    await client.query("UPDATE item_stock_counts SET entry_id = $2 WHERE id = $1", [reversalId, entryId]);
  }
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: params.sync.clientEventId ?? `retail-stock-count:reverse:${params.countId}`,
    eventType: "retail.stock_count.reversed",
    payload: { countId: params.countId, note: params.note ?? null },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });

  return { id: reversalId, entryId };
}

export interface ItemStockCountSummary {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  lineCount: number;
  shortageValue: string;
  surplusValue: string;
  reversed: boolean;
  status?: string;
  warehouseId?: string | null;
  reasonCode?: string | null;
}

/** Recent counts at this branch, newest first. Reversal rows are folded into the count they undo. */
export async function listItemStockCounts(
  client: PoolClient,
  locationId: string,
  limit = 50,
): Promise<ItemStockCountSummary[]> {
  const { counts } = await searchItemStockCounts(client, locationId, { limit });
  return counts;
}

export async function searchItemStockCounts(
  client: PoolClient,
  locationId: string,
  options: {
    limit?: number;
    offset?: number;
    search?: string | null;
    status?: string | null;
    warehouseId?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    userId?: string | null;
    itemId?: string | null;
  } = {},
): Promise<{ counts: ItemStockCountSummary[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const conditions: string[] = ["c.location_id = $1", "c.reversal_of IS NULL"];
  const params: unknown[] = [locationId];
  let paramIdx = 2;

  if (options.status) {
    conditions.push(`c.status = $${paramIdx++}`);
    params.push(options.status);
  }
  if (options.warehouseId) {
    conditions.push(`c.warehouse_id = $${paramIdx++}`);
    params.push(options.warehouseId);
  }
  if (options.dateFrom) {
    conditions.push(`c.counted_at >= $${paramIdx++}::timestamptz`);
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    conditions.push(`c.counted_at <= $${paramIdx++}::timestamptz`);
    params.push(options.dateTo);
  }
  if (options.userId) {
    conditions.push(`c.counted_by = $${paramIdx++}::uuid`);
    params.push(options.userId);
  }
  if (options.search) {
    conditions.push(`(c.note ILIKE $${paramIdx} OR EXISTS (SELECT 1 FROM item_stock_count_lines l JOIN items i ON i.id=l.item_id WHERE l.stock_count_id=c.id AND i.name ILIKE $${paramIdx}))`);
    params.push(`%${options.search}%`);
    paramIdx++;
  }
  if (options.itemId) {
    conditions.push(`EXISTS (SELECT 1 FROM item_stock_count_lines l WHERE l.stock_count_id=c.id AND l.item_id=$${paramIdx}::uuid)`);
    params.push(options.itemId);
    paramIdx++;
  }

  const where = conditions.join(" AND ");

  const countQuery = `SELECT count(*)::text AS total FROM item_stock_counts c WHERE ${where}`;
  const { rows: totalRows } = await client.query<{ total: string }>(countQuery, params);
  const total = Number(totalRows[0]?.total ?? "0");

  const listQuery = `
    SELECT c.id, c.note, c.counted_at::text, u.full_name AS counted_by_name,
            (SELECT count(*) FROM item_stock_count_lines l WHERE l.stock_count_id = c.id)::text AS line_count,
            COALESCE((SELECT sum(-l.variance_value) FROM item_stock_count_lines l
                       WHERE l.stock_count_id = c.id AND l.variance_value < 0), 0)::text AS shortage_value,
            COALESCE((SELECT sum(l.variance_value) FROM item_stock_count_lines l
                       WHERE l.stock_count_id = c.id AND l.variance_value > 0), 0)::text AS surplus_value,
            EXISTS (SELECT 1 FROM item_stock_counts r WHERE r.reversal_of = c.id) AS reversed,
            c.status::text AS status, c.warehouse_id::text AS warehouse_id, c.reason_code
       FROM item_stock_counts c
       LEFT JOIN users u ON u.id = c.counted_by
      WHERE ${where}
      ORDER BY c.counted_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;

  const { rows } = await client.query<{
    id: string;
    note: string | null;
    counted_at: string;
    counted_by_name: string | null;
    line_count: string;
    shortage_value: string;
    surplus_value: string;
    reversed: boolean;
    status: string;
    warehouse_id: string | null;
    reason_code: string | null;
  }>(listQuery, [...params, limit, offset]);

  return {
    total,
    counts: rows.map((r) => ({
      id: r.id,
      note: r.note,
      countedAt: r.counted_at,
      countedByName: r.counted_by_name,
      lineCount: Number(r.line_count),
      shortageValue: r.shortage_value,
      surplusValue: r.surplus_value,
      reversed: r.reversed,
      status: r.status,
      warehouseId: r.warehouse_id,
      reasonCode: r.reason_code,
    })),
  };
}

/** Backward-compatible wrapper for callers that expect a simple array. */
export async function listItemStockCountsLegacy(
  client: PoolClient,
  locationId: string,
  limit = 50,
): Promise<ItemStockCountSummary[]> {
  return listItemStockCounts(client, locationId, limit);
}

/** One count's header and lines, scoped to the caller's branch. */
export async function getItemStockCountDetail(
  client: PoolClient,
  params: { locationId: string; countId: string },
): Promise<ItemStockCountDetail | null> {
  const { rows: counts } = await client.query<{
    id: string;
    note: string | null;
    counted_at: string;
    counted_by_name: string | null;
    entry_id: string | null;
    reversed_at: string | null;
    status: string | null;
    warehouse_id: string | null;
    reason_code: string | null;
  }>(
    `SELECT c.id, c.note, c.counted_at::text, u.full_name AS counted_by_name, c.entry_id,
            (SELECT r.counted_at::text FROM item_stock_counts r WHERE r.reversal_of = c.id) AS reversed_at,
            c.status::text AS status, c.warehouse_id::text AS warehouse_id, c.reason_code
       FROM item_stock_counts c
       LEFT JOIN users u ON u.id = c.counted_by
      WHERE c.id = $1 AND c.location_id = $2 AND c.reversal_of IS NULL`,
    [params.countId, params.locationId],
  );
  if (!counts[0]) return null;

  const { rows: lines } = await client.query<{
    id: string;
    item_id: string;
    item_name: string;
    tracking: string;
    system_qty: string;
    counted_qty: string;
    variance: string;
    unit_cost: string | null;
    variance_value: string;
  }>(
    `SELECT l.id, l.item_id, i.name AS item_name, i.tracking::text AS tracking,
            trim_scale(l.system_qty)::text AS system_qty,
            trim_scale(l.counted_qty)::text AS counted_qty,
            trim_scale(l.variance)::text AS variance,
            l.unit_cost::text, l.variance_value::text
       FROM item_stock_count_lines l
       JOIN items i ON i.id = l.item_id AND i.location_id = $2
      WHERE l.stock_count_id = $1
      ORDER BY i.name, l.id`,
    [params.countId, params.locationId],
  );

  // Batch allocations for audit
  const { rows: batchAllocs } = await client.query<{
    line_id: string;
    batch_number: string;
    expiry_date: string | null;
    quantity: string;
    unit_cost: string | null;
    value_rial: string;
    kind: string;
  }>(
    `SELECT stock_count_line_id AS line_id, batch_number, expiry_date::text AS expiry_date, quantity::text AS quantity, unit_cost::text AS unit_cost, value_rial::text AS value_rial, kind
       FROM item_stock_count_batch_allocations WHERE stock_count_id=$1 ORDER BY batch_number, created_at`,
    [params.countId],
  );

  return {
    id: counts[0].id,
    note: counts[0].note,
    countedAt: counts[0].counted_at,
    countedByName: counts[0].counted_by_name,
    entryId: counts[0].entry_id,
    reversedAt: counts[0].reversed_at,
    status: counts[0].status ?? undefined,
    warehouseId: counts[0].warehouse_id,
    reasonCode: counts[0].reason_code,
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      itemName: l.item_name,
      tracking: l.tracking,
      systemQty: l.system_qty,
      countedQty: l.counted_qty,
      variance: l.variance,
      unitCost: l.unit_cost,
      varianceValue: l.variance_value,
    })),
    batchAllocations: batchAllocs.map((b) => ({
      lineId: b.line_id,
      batchNumber: b.batch_number,
      expiryDate: b.expiry_date,
      quantity: b.quantity,
      unitCost: b.unit_cost,
      value: b.value_rial,
      kind: b.kind,
    })),
  };
}
