/**
 * Phase 27 Wave 11 — accessories/cosmetics merchandising (DB-touching).
 *
 * Three capabilities on the Wave 3 matrix and Wave 8 stock model:
 *   - a variant-matrix bulk editor that sets price/stock across a grid in one
 *     transaction with one audit event per item;
 *   - a markdown planner that classifies stock as fast/slow/dead (and, for
 *     batch-tracked cosmetics, near-expiry) and applies an accepted markdown
 *     as a price change only (GH #1567 F3 — a write-down is the separate,
 *     reviewed NRV act in item-nrv-write-down-service.ts);
 *   - sell-through by season/collection off the same sale events the sales
 *     report reads.
 */
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { getPool, query } from "./db";
import { recordItemEvent } from "./item-audit-service";
import {
  expiryBucket,
  stockVelocityClass,
  type StockVelocityClass,
} from "./industry-reports";
import { rialText } from "./inventory-exact";
import { createItemStockCount } from "./item-stock-count-service";

// Side-effect import: keeps the legacy item.markdown_write_down rule
// registered so events posted before F3 still replay; nothing emits it now.
import "./merchandising-posting-rules";

export interface MatrixVariantUpdate {
  itemId: string;
  /** New shelf price (Rial per unit, pre-VAT); omitted = leave unchanged. */
  unitPrice?: number | null;
  /** New absolute on-hand quantity; omitted = leave unchanged. */
  quantity?: number | null;
}

/**
 * Sets price and/or stock across a whole colour × size (or shade × volume)
 * grid in one transaction. A failure on any variant rolls the whole grid
 * back, and each touched variant gets its own audit event.
 */
export async function bulkUpdateVariantMatrix(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    updates: MatrixVariantUpdate[];
    createdBy?: string | null;
  },
): Promise<void> {
  if (input.updates.length === 0) return;
  // F2 (GH #1567): a new on-hand figure typed into the grid is a stock count,
  // not a silent overwrite — it goes through the canonical count, so the
  // shortage/surplus posts to the ledger at the carrying value and the count
  // is reversible. A variant with no cost basis is refused below.
  const countLines: Array<{ itemId: string; countedQty: string }> = [];

  for (const update of input.updates) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT i.id FROM items i
        WHERE i.id = $1 AND i.location_id = $2 AND i.kind = 'variant_child'`,
      [update.itemId, input.locationId],
    );
    if (!rows[0]) throw new Error(`کالای تنوع یافت نشد: ${update.itemId}`);

    if (update.unitPrice != null) {
      if (!Number.isInteger(update.unitPrice) || update.unitPrice <= 0) {
        throw new Error("قیمت باید یک عدد صحیح مثبت (ریال) باشد.");
      }
      await client.query(
        `INSERT INTO item_stock (item_id, unit_price) VALUES ($1, $2)
         ON CONFLICT (item_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, updated_at = now()`,
        [update.itemId, update.unitPrice],
      );
    }
    if (update.quantity != null) {
      if (!Number.isFinite(update.quantity) || update.quantity < 0) {
        throw new Error("موجودی نمی‌تواند منفی باشد.");
      }
      const current = await client.query<{ quantity: string }>(
        `SELECT quantity::text FROM item_stock WHERE item_id = $1`,
        [update.itemId],
      );
      // An unchanged cell is not a count line (no empty count documents).
      if (!new Decimal(current.rows[0]?.quantity ?? 0).eq(update.quantity)) {
        countLines.push({ itemId: update.itemId, countedQty: String(update.quantity) });
      }
    }

    await recordItemEvent(
      {
        businessId: input.businessId,
        locationId: input.locationId,
        itemId: update.itemId,
        eventType: "item.merchandising_bulk_update",
        payload: {
          unitPrice: update.unitPrice ?? null,
          quantity: update.quantity ?? null,
        },
        createdBy: input.createdBy ?? null,
      },
      client,
    );
  }

  if (countLines.length > 0) {
    const counted = await createItemStockCount(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      note: "ویرایش گروهی موجودی از جدول تنوع‌ها",
      lines: countLines,
      createdBy: input.createdBy ?? null,
    });
    // A variant with no cost basis would gain or lose units at an unknown
    // value — exactly the silent stock change F2 removes. Refuse the grid
    // (the caller's transaction rolls every cell back); its first stock
    // belongs on an opening-stock document or a purchase.
    if (counted.warnings.some((warning) => warning.startsWith("missing_cost_basis"))) {
      throw new Error("برای تنوعی که قیمت تمام‌شده ندارد، موجودی را با سند موجودی افتتاحیه یا خرید ثبت کنید.");
    }
  }
}

export interface MarkdownCandidate {
  itemId: string;
  itemName: string;
  parentName: string | null;
  quantity: string;
  unitPrice: number | null;
  unitCost: number | null;
  velocity: StockVelocityClass;
  daysSinceLastSale: number | null;
  /** Earliest expiry (cosmetics), null for non-batch items. */
  nearestExpiry: string | null;
  suggestedPrice: number | null;
}

/**
 * Stock that should move — slow or dead — ordered so cosmetics expiring
 * within 90 days come first, then dead, then slow. The suggested price is a
 * fixed 20% markdown off the shelf price; null when there is no price to
 * mark down from.
 */
export async function listMarkdownCandidates(
  businessId: string,
  locationId: string,
  todayIso: string,
): Promise<MarkdownCandidate[]> {
  const { rows } = await query<{
    item_id: string;
    item_name: string;
    parent_name: string | null;
    quantity: string;
    unit_price: string | null;
    unit_cost: string | null;
    last_sold_at: string | null;
    nearest_expiry: string | null;
    units_sold: string;
  }>(
    `WITH sales AS (
        SELECT source_id AS item_id, SUM((payload->>'quantity')::numeric)::text AS units_sold
          FROM domain_events
         WHERE business_id = $1 AND location_id = $2
           AND event_type IN ('accessory.sale_revenue', 'cosmetic.sale_revenue')
           AND created_at >= now() - interval '90 days'
         GROUP BY source_id
      )
      SELECT i.id AS item_id, i.name AS item_name, p.name AS parent_name,
             s.quantity::text, s.unit_price::text, s.unit_cost::text,
             s.last_sold_at::text AS last_sold_at,
             (SELECT MIN(b.expiry_date)::text FROM item_batches b WHERE b.item_id = i.id) AS nearest_expiry,
             COALESCE(sa.units_sold, '0') AS units_sold
        FROM items i
        JOIN item_stock s ON s.item_id = i.id
        LEFT JOIN items p ON p.id = i.parent_item_id
        LEFT JOIN sales sa ON sa.item_id = i.id
       WHERE i.location_id = $2 AND i.is_active AND i.kind = 'variant_child'
         AND s.quantity > 0`,
    [businessId, locationId],
  );

  const today = Date.parse(`${todayIso}T00:00:00Z`);
  const candidates: MarkdownCandidate[] = [];
  for (const r of rows) {
    const daysSinceLastSale = r.last_sold_at
      ? Math.floor((today - Date.parse(`${r.last_sold_at.slice(0, 10)}T00:00:00Z`)) / 86_400_000)
      : null;
    const velocity = stockVelocityClass({ unitsSold: Number(r.units_sold), daysSinceLastSale });
    if (velocity === "fast") continue;

    const unitPrice = r.unit_price == null ? null : Number(r.unit_price);
    candidates.push({
      itemId: r.item_id,
      itemName: r.item_name,
      parentName: r.parent_name,
      quantity: r.quantity,
      unitPrice,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      velocity,
      daysSinceLastSale,
      nearestExpiry: r.nearest_expiry,
      suggestedPrice: unitPrice == null ? null : Math.max(1, Math.round(unitPrice * 0.8)),
    });
  }

  const nearExpiry = (c: MarkdownCandidate) =>
    c.nearestExpiry && expiryBucket(c.nearestExpiry, todayIso) !== "ok" ? 0 : 1;
  const velocityRank: Record<StockVelocityClass, number> = { dead: 0, slow: 1, fast: 2 };
  return candidates.sort(
    (a, b) => nearExpiry(a) - nearExpiry(b) || velocityRank[a.velocity] - velocityRank[b.velocity],
  );
}

export interface AppliedMarkdown {
  itemId: string;
  oldPrice: number;
  newPrice: number;
  quantity: string;
  /**
   * Always 0 since GH #1567 F3: a markdown is a price decision and posts
   * nothing. Kept so existing callers keep their shape.
   */
  writeDownRial: number;
  entryId: string | null;
  /** The carrying value per unit the new price is compared against (null = no cost basis). */
  carryingUnitValue: string | null;
  /**
   * True when the new shelf price is below the carrying value per unit — a
   * sign NRV may be below cost. Nothing is posted: the write-down is a
   * separate, reviewed act (`item-nrv-write-down-service`).
   */
  belowCost: boolean;
  /** carrying value − quantity × new price, floored at 0 (an upper bound before selling costs). */
  nrvShortfallRial: string;
}

/**
 * Applies an accepted markdown: sets the new shelf price (the sell screen
 * reads it next) and records the audit event. A selling-price reduction is
 * **not** an inventory write-down (GH #1567 F3) — before F3 this posted
 * quantity × (old − new) *retail* price against inventory, which wrote off
 * value the stock still had (cost 50,000, price 100,000 → 70,000 on 5 units
 * wrote off 150,000). The stock keeps its cost; when the new price signals
 * NRV below cost the result says so and the reviewed NRV write-down decides.
 */
export async function applyMarkdown(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    itemId: string;
    newPrice: number;
    /** The trade's inventory account code (kept for callers; nothing is posted). */
    inventoryAccountCode?: string;
    createdBy?: string | null;
  },
): Promise<AppliedMarkdown> {
  if (!Number.isInteger(input.newPrice) || input.newPrice <= 0) {
    throw new Error("قیمت جدید باید یک عدد صحیح مثبت (ریال) باشد.");
  }

  const { rows } = await client.query<{ unit_price: string | null; quantity: string; total_value_rial: string | null; unit_cost: string | null }>(
    `SELECT s.unit_price::text, s.quantity::text, s.total_value_rial::text, s.unit_cost::text
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE s.item_id = $1 AND i.location_id = $2
      FOR UPDATE OF s`,
    [input.itemId, input.locationId],
  );
  if (!rows[0] || rows[0].unit_price == null) throw new Error("این کالا قیمت فروش ندارد.");
  const oldPrice = Number(rows[0].unit_price);
  const quantity = new Decimal(rows[0].quantity);
  if (input.newPrice >= oldPrice) throw new Error("قیمت جدید باید کمتر از قیمت فعلی باشد.");

  await client.query(
    `UPDATE item_stock SET unit_price = $2, updated_at = now() WHERE item_id = $1`,
    [input.itemId, input.newPrice],
  );

  const carrying = rows[0].total_value_rial ?? (rows[0].unit_cost == null ? null : rialText(quantity.times(rows[0].unit_cost).toFixed(0)));
  let carryingUnitValue: string | null = null;
  let shortfall = 0n;
  if (carrying != null && quantity.gt(0)) {
    carryingUnitValue = new Decimal(carrying).div(quantity).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
    const atNewPrice = BigInt(quantity.times(input.newPrice).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
    shortfall = BigInt(carrying) - atNewPrice;
    if (shortfall < 0n) shortfall = 0n;
  }

  await recordItemEvent(
    {
      businessId: input.businessId,
      locationId: input.locationId,
      itemId: input.itemId,
      eventType: "item.markdown_applied",
      payload: { oldPrice, newPrice: input.newPrice, writeDownRial: 0, belowCost: shortfall > 0n, nrvShortfallRial: shortfall.toString() },
      createdBy: input.createdBy ?? null,
    },
    client,
  );

  return {
    itemId: input.itemId,
    oldPrice,
    newPrice: input.newPrice,
    quantity: quantity.toString(),
    writeDownRial: 0,
    entryId: null,
    carryingUnitValue,
    belowCost: shortfall > 0n,
    nrvShortfallRial: shortfall.toString(),
  };
}

export interface CollectionSellThroughRow {
  collection: string | null;
  season: string | null;
  /** GH #1567 F4 — the «دسته‌بندی» the sale was tagged with, frozen at sale time. */
  category: string | null;
  /**
   * False for sales (and returns) recorded before sale-time snapshots existed
   * (migration 0328): their tags were never captured, so the row is
   * "unknown" — never today's tags passed off as then's.
   */
  snapshotKnown: boolean;
  quantitySold: string;
  netRevenue: number;
  /** GH #1567 C6 — returned units with an unknown revenue share (pre-0328); not "0" ⇒ revenue incomplete. */
  unknownReturnQuantity: string;
  revenueComplete: boolean;
}

/**
 * Sell-through by collection / season / category — net of returns, over both
 * channels, grouped by the tags each sale carried WHEN IT HAPPENED (GH #1567
 * F4). Re-tagging a style moves only its future sales. The counter's tags are
 * in its `<trade>.sale_revenue` event (`payload.merch`), a website sale's in
 * `online_sale_lines.merch`, and a return carries its sale's tags in
 * `sale_return_facts.merch`; quantities and revenue are exactly the ones the
 * variant report (SALE_FACTS_CTE) nets, so the two always agree.
 */
export async function sellThroughByCollection(
  businessId: string,
  locationId: string,
  options: { from?: string; to?: string; eventPrefix?: string } = {},
): Promise<CollectionSellThroughRow[]> {
  const prefix = options.eventPrefix ?? "accessory";
  const { rows } = await query<{
    snapshot_known: boolean;
    collection: string | null;
    season: string | null;
    category: string | null;
    quantity_sold: string;
    net_revenue: string;
    unknown_return_qty: string;
  }>(
    `WITH facts AS (
        SELECT e.payload -> 'merch' AS merch,
               (e.payload->>'quantity')::numeric AS quantity,
               (e.payload->>'net')::numeric AS net,
               0::numeric AS unknown_return_qty
          FROM domain_events e
         WHERE e.business_id = $1 AND e.location_id = $2
           AND e.event_type = $5 || '.sale_revenue'
           AND ($3::date IS NULL OR e.created_at >= $3::date)
           AND ($4::date IS NULL OR e.created_at < ($4::date + 1))
        UNION ALL
        SELECT f.merch, f.quantity, f.net_rial::numeric, 0::numeric
          FROM online_sale_lines f
          JOIN order_items oi ON oi.id = f.order_item_id AND oi.status <> 'voided'
         WHERE f.location_id = $2 AND f.item_id IS NOT NULL
           AND ($3::date IS NULL OR f.occurred_at >= $3::date)
           AND ($4::date IS NULL OR f.occurred_at < ($4::date + 1))
        UNION ALL
        SELECT rf.merch, -trim_scale(rf.quantity), -rf.net_rial::numeric,
               CASE WHEN rf.amounts_known THEN 0 ELSE trim_scale(rf.quantity) END
          FROM sale_return_facts rf
          JOIN order_items oi ON oi.id = rf.order_item_id AND oi.status <> 'voided'
         WHERE rf.business_id = $1 AND rf.location_id = $2
           AND ($3::date IS NULL OR rf.occurred_at >= $3::date)
           AND ($4::date IS NULL OR rf.occurred_at < ($4::date + 1))
      )
      SELECT jsonb_typeof(merch) = 'object' AS snapshot_known,
             NULLIF(merch->>'collection', '') AS collection,
             NULLIF(merch->>'season', '') AS season,
             NULLIF(merch->>'category', '') AS category,
             SUM(quantity)::text AS quantity_sold,
             SUM(net)::text AS net_revenue,
             SUM(unknown_return_qty)::text AS unknown_return_qty
        FROM facts
       GROUP BY 1, 2, 3, 4
       ORDER BY SUM(net) DESC, 2 NULLS LAST, 3 NULLS LAST, 4 NULLS LAST`,
    [businessId, locationId, options.from ?? null, options.to ?? null, prefix],
  );
  return rows.map((r) => ({
    collection: r.collection,
    season: r.season,
    category: r.category,
    snapshotKnown: r.snapshot_known === true,
    quantitySold: r.quantity_sold,
    netRevenue: Number(r.net_revenue),
    unknownReturnQuantity: r.unknown_return_qty && Number(r.unknown_return_qty) !== 0 ? r.unknown_return_qty : "0",
    revenueComplete: !r.unknown_return_qty || Number(r.unknown_return_qty) === 0,
  }));
}

/** Convenience wrapper for callers that don't already hold a client. */
export async function withMerchandisingTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
