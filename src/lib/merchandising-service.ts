/**
 * Phase 27 Wave 11 — accessories/cosmetics merchandising (DB-touching).
 *
 * Three capabilities on the Wave 3 matrix and Wave 8 stock model:
 *   - a variant-matrix bulk editor that sets price/stock across a grid in one
 *     transaction with one audit event per item;
 *   - a markdown planner that classifies stock as fast/slow/dead (and, for
 *     batch-tracked cosmetics, near-expiry) and applies an accepted markdown
 *     as a ledger write-down plus a price change;
 *   - sell-through by season/collection off the same sale events the sales
 *     report reads.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { getPool, query } from "./db";
import { emitDomainEvent } from "./posting-engine";
import { recordItemEvent } from "./item-audit-service";
import {
  expiryBucket,
  stockVelocityClass,
  type StockVelocityClass,
} from "./industry-reports";
import { rialText } from "./inventory-exact";

// Side-effect import: registers item.markdown_write_down with the engine.
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
      await client.query(
        `INSERT INTO item_stock (item_id, quantity) VALUES ($1, $2)
         ON CONFLICT (item_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [update.itemId, update.quantity],
      );
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
  writeDownRial: number;
  entryId: string | null;
}

/**
 * Applies an accepted markdown: sets the new shelf price (the sell screen
 * reads it next), posts Debit expense / Credit inventory for the carrying
 * value given up, and records the audit event.
 */
export async function applyMarkdown(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    itemId: string;
    newPrice: number;
    /** The trade's inventory account code (1340 accessories / 1350 cosmetics). */
    inventoryAccountCode: string;
    createdBy?: string | null;
  },
): Promise<AppliedMarkdown> {
  if (!Number.isInteger(input.newPrice) || input.newPrice <= 0) {
    throw new Error("قیمت جدید باید یک عدد صحیح مثبت (ریال) باشد.");
  }

  const { rows } = await client.query<{ unit_price: string | null; quantity: string }>(
    `SELECT unit_price::text, quantity::text FROM item_stock WHERE item_id = $1 FOR UPDATE`,
    [input.itemId],
  );
  if (!rows[0] || rows[0].unit_price == null) throw new Error("این کالا قیمت فروش ندارد.");
  const oldPrice = Number(rows[0].unit_price);
  const quantity = new Decimal(rows[0].quantity);
  if (input.newPrice >= oldPrice) throw new Error("قیمت جدید باید کمتر از قیمت فعلی باشد.");

  const writeDown = Math.round(quantity.times(oldPrice - input.newPrice).toNumber());

  await client.query(
    `UPDATE item_stock SET unit_price = $2, updated_at = now() WHERE item_id = $1`,
    [input.itemId, input.newPrice],
  );

  // Same defect class as the retail sell-services: `postingKind` for this
  // rule is the fixed string "markdown_write_down", and slow-moving stock is
  // routinely marked down more than once over its shelf life. Keying the
  // posting identity on `input.itemId`, as this used to, meant only the
  // *first* markdown of any item could ever post; a second markdown of the
  // same item threw a raw unique-constraint violation. `itemAuditTrail`
  // matches on `payload->>'itemId'` (kept, unchanged) as well as
  // `domain_events.source_id`, so it is unaffected; `postingSourceId` is the
  // separate identity only the ledger posting itself uses, fresh per call.
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "item.markdown_write_down",
    payload: { itemId: input.itemId, inventoryAccountCode: input.inventoryAccountCode, amount: rialText(String(writeDown)) },
    sourceType: "item",
    sourceId: input.itemId,
    postingSourceId: randomUUID(),
    createdBy: input.createdBy ?? null,
  });

  await recordItemEvent(
    {
      businessId: input.businessId,
      locationId: input.locationId,
      itemId: input.itemId,
      eventType: "item.markdown_applied",
      payload: { oldPrice, newPrice: input.newPrice, writeDownRial: writeDown },
      createdBy: input.createdBy ?? null,
    },
    client,
  );

  return { itemId: input.itemId, oldPrice, newPrice: input.newPrice, quantity: quantity.toString(), writeDownRial: writeDown, entryId };
}

export interface CollectionSellThroughRow {
  collection: string | null;
  season: string | null;
  quantitySold: string;
  netRevenue: number;
}

/**
 * Sell-through by collection/season, off the same `accessory.sale_revenue` /
 * `cosmetic.sale_revenue` events the sales report reads — so the two always
 * agree for the same period. Untagged items group under null.
 */
export async function sellThroughByCollection(
  businessId: string,
  locationId: string,
  options: { from?: string; to?: string; eventPrefix?: string } = {},
): Promise<CollectionSellThroughRow[]> {
  const prefix = options.eventPrefix ?? "accessory";
  const { rows } = await query<{
    collection: string | null;
    season: string | null;
    quantity_sold: string;
    net_revenue: string;
  }>(
    `SELECT i.collection, i.season,
            SUM((e.payload->>'quantity')::numeric)::text AS quantity_sold,
            SUM((e.payload->>'net')::numeric)::text AS net_revenue
       FROM domain_events e
       JOIN items i ON i.id = e.source_id
      WHERE e.business_id = $1 AND e.location_id = $2
        AND e.event_type = $5 || '.sale_revenue'
        AND ($3::date IS NULL OR e.created_at >= $3::date)
        AND ($4::date IS NULL OR e.created_at < ($4::date + 1))
      GROUP BY i.collection, i.season
      ORDER BY net_revenue DESC`,
    [businessId, locationId, options.from ?? null, options.to ?? null, prefix],
  );
  return rows.map((r) => ({
    collection: r.collection,
    season: r.season,
    quantitySold: r.quantity_sold,
    netRevenue: Number(r.net_revenue),
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
