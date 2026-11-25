/**
 * GH #1567 F4 — the return side of the trade sales reports, and the
 * sale-time merchandising snapshot both sides carry.
 *
 * A return writes one `sale_return_facts` row per returned order line, in the
 * same transaction that books it, holding exactly what the ledger booked for
 * that line: its share of the contra-revenue (refund − VAT, allocated so the
 * shares sum to the posted amount), the COGS actually reversed (0 for a
 * damaged return, which reverses none), and the sale's frozen snapshot.
 * Reports read sale facts − return facts, dated by when each happened.
 */
import type { PoolClient } from "pg";

/**
 * The merchandising tags a sale is reported under, frozen when it happens so
 * re-tagging a style later never moves its past sales. `category` is the
 * value of the item's (or its style's) «دسته‌بندی» attribute — the items
 * model has no category column — and null when the shop never set one.
 */
export interface SaleMerchSnapshot {
  collection: string | null;
  season: string | null;
  category: string | null;
  brandId: string | null;
}

/** Attribute names read as the merchandising category, in priority order. */
export const CATEGORY_ATTRIBUTE_NAMES = ["دسته‌بندی", "دسته بندی", "دسته", "category"] as const;

export async function readSaleMerchSnapshot(client: PoolClient, itemId: string): Promise<SaleMerchSnapshot> {
  const { rows } = await client.query<{
    collection: string | null;
    season: string | null;
    brand_id: string | null;
    category: string | null;
  }>(
    `SELECT COALESCE(NULLIF(i.collection, ''), NULLIF(p.collection, '')) AS collection,
            COALESCE(NULLIF(i.season, ''), NULLIF(p.season, '')) AS season,
            COALESCE(i.brand_id, p.brand_id)::text AS brand_id,
            (SELECT NULLIF(a.value, '')
               FROM item_variant_attributes a
              WHERE a.item_id IN (i.id, i.parent_item_id)
                AND lower(a.name) = ANY($2::text[])
              ORDER BY (a.item_id = i.id) DESC, array_position($2::text[], lower(a.name))
              LIMIT 1) AS category
       FROM items i
       LEFT JOIN items p ON p.id = i.parent_item_id
      WHERE i.id = $1`,
    [itemId, CATEGORY_ATTRIBUTE_NAMES.map((name) => name.toLowerCase())],
  );
  const row = rows[0];
  return {
    collection: row?.collection ?? null,
    season: row?.season ?? null,
    category: row?.category ?? null,
    brandId: row?.brand_id ?? null,
  };
}

/** Reads a stored snapshot back; anything malformed is "unknown" (null). */
export function parseSaleMerchSnapshot(value: unknown): SaleMerchSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" && record[key] !== "" ? (record[key] as string) : null);
  return { collection: text("collection"), season: text("season"), category: text("category"), brandId: text("brandId") };
}

/**
 * Splits `total` across `weights` in proportion, by largest remainder, so the
 * parts are non-negative integers that sum to `total` exactly. All-zero
 * weights split evenly (remainder to the first parts).
 */
export function allocateProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return [];
  if (total <= 0n) return weights.map(() => 0n);
  const clean = weights.map((w) => (w > 0n ? w : 0n));
  const sum = clean.reduce((a, b) => a + b, 0n);
  const basis = sum === 0n ? clean.map(() => 1n) : clean;
  const basisSum = sum === 0n ? BigInt(clean.length) : sum;
  const parts = basis.map((w) => (total * w) / basisSum);
  let remainder = total - parts.reduce((a, b) => a + b, 0n);
  const order = basis
    .map((w, index) => ({ index, frac: (total * w) % basisSum }))
    .sort((a, b) => (a.frac === b.frac ? a.index - b.index : a.frac > b.frac ? -1 : 1));
  for (const { index } of order) {
    if (remainder <= 0n) break;
    parts[index] += 1n;
    remainder -= 1n;
  }
  return parts;
}

export interface SaleReturnFactInput {
  businessId: string;
  locationId: string;
  orderId: string;
  orderItemId: string;
  itemId: string;
  factSource: "customer_return" | "online_refund";
  sourceId: string;
  quantity: string;
  netRial: bigint;
  cogsRial: bigint;
  disposition: "restockable" | "discarded";
  merch: SaleMerchSnapshot | null;
  occurredAt?: string | null;
}

/**
 * Records one returned line. Idempotent per (source, order line): a replayed
 * delivery that adds quantity to the same line accumulates, exactly as the
 * return line itself does.
 */
export async function recordSaleReturnFact(client: PoolClient, fact: SaleReturnFactInput): Promise<void> {
  await client.query(
    `INSERT INTO sale_return_facts
       (business_id, location_id, order_id, order_item_id, item_id, source_type, source_id,
        quantity, net_rial, cogs_rial, disposition, merch, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12::jsonb, COALESCE($13::timestamptz, now()))
     ON CONFLICT (source_type, source_id, order_item_id) DO UPDATE
       SET quantity = sale_return_facts.quantity + EXCLUDED.quantity,
           net_rial = sale_return_facts.net_rial + EXCLUDED.net_rial,
           cogs_rial = sale_return_facts.cogs_rial + EXCLUDED.cogs_rial`,
    [
      fact.businessId, fact.locationId, fact.orderId, fact.orderItemId, fact.itemId, fact.factSource, fact.sourceId,
      fact.quantity, fact.netRial.toString(), fact.cogsRial.toString(), fact.disposition,
      fact.merch ? JSON.stringify(fact.merch) : null, fact.occurredAt ?? null,
    ],
  );
}
