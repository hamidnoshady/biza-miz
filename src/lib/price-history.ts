/**
 * Immutable product price history (issue #924 F07).
 *
 * Every path that can change a shelf or purchase price — the price matrix,
 * bulk quick update, product creation, the online-store sync — appends here in
 * the same transaction as the price write, so a price can never move without
 * a row saying who moved it, from what, to what, and why.
 *
 * The table is append-only (`migrations/0233_product_price_history.sql`);
 * nothing in the app updates or deletes a row.
 */

import { query } from "./db";

export type PriceChangeSource =
  | "manual"
  | "bulk"
  | "import"
  | "ai"
  | "sync"
  | "system"
  /** A retail-advisor suggestion accepted unchanged (issue #924 review item 3). */
  | "recommendation";

export type PriceKind = "sale" | "purchase" | "list";

export interface PriceHistoryRow {
  businessId: string;
  locationId: string;
  itemId: string;
  priceKind: PriceKind;
  priceListId?: string | null;
  oldPrice: number | null;
  newPrice: number | null;
  source: PriceChangeSource;
  actorId?: string | null;
  batchId?: string | null;
  idempotencyKey?: string | null;
  reason?: string | null;
  /**
   * Reproducible inputs behind a derived price — for `source: "recommendation"`
   * the advisor mode, overheads, rounding policy, tax preview and the suggested
   * amount. Stored as `jsonb`, null for a plain manual edit.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * Append history rows in one round-trip. A 2,000-cell bulk edit must not become
 * 2,000 INSERTs, and this must join the caller's transaction — `query()` is
 * pinned to the open transaction when there is one.
 *
 * A database that has not run migration 0233 yet keeps working (42P01 is
 * ignored), but any other failure throws: a price must never change without
 * its audit row.
 */
/** The shape both the pool and a checked-out transaction client satisfy. */
export interface PriceHistoryQueryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export async function recordPriceHistory(rows: PriceHistoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await query(
      `INSERT INTO product_price_history
        (business_id, location_id, item_id, price_kind, price_list_id, old_price, new_price,
         old_price_rial, new_price_rial, source, actor_id, batch_id, idempotency_key, reason, metadata)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::uuid[],
         $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[],
         $10::text[], $11::uuid[], $12::uuid[], $13::text[], $14::text[], $15::jsonb[]
       )`,
      [
        rows.map((r) => r.businessId),
        rows.map((r) => r.locationId),
        rows.map((r) => r.itemId),
        rows.map((r) => r.priceKind),
        rows.map((r) => r.priceListId ?? null),
        rows.map((r) => r.oldPrice),
        rows.map((r) => r.newPrice),
        rows.map((r) => r.oldPrice),
        rows.map((r) => r.newPrice),
        rows.map((r) => r.source),
        rows.map((r) => r.actorId ?? null),
        rows.map((r) => r.batchId ?? null),
        rows.map((r) => r.idempotencyKey ?? null),
        rows.map((r) => r.reason ?? null),
        rows.map((r) => (r.metadata == null ? null : JSON.stringify(r.metadata))),
      ],
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "42P01") return;
    throw error;
  }
}

/**
 * Same append, on a caller-owned client. Use this when the price write runs on
 * a checked-out connection that is *not* pinned in the async-local storage
 * (e.g. `createForRemoteOnce`), where the module-level `query()` would go to a
 * different pool connection and land outside the transaction.
 */
export async function insertPriceHistory(
  client: PriceHistoryQueryable,
  rows: PriceHistoryRow[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await client.query(
      `INSERT INTO product_price_history
        (business_id, location_id, item_id, price_kind, price_list_id, old_price, new_price,
         old_price_rial, new_price_rial, source, actor_id, batch_id, idempotency_key, reason, metadata)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::uuid[],
         $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[],
         $10::text[], $11::uuid[], $12::uuid[], $13::text[], $14::text[], $15::jsonb[]
       )`,
      [
        rows.map((r) => r.businessId),
        rows.map((r) => r.locationId),
        rows.map((r) => r.itemId),
        rows.map((r) => r.priceKind),
        rows.map((r) => r.priceListId ?? null),
        rows.map((r) => r.oldPrice),
        rows.map((r) => r.newPrice),
        rows.map((r) => r.oldPrice),
        rows.map((r) => r.newPrice),
        rows.map((r) => r.source),
        rows.map((r) => r.actorId ?? null),
        rows.map((r) => r.batchId ?? null),
        rows.map((r) => r.idempotencyKey ?? null),
        rows.map((r) => r.reason ?? null),
        rows.map((r) => (r.metadata == null ? null : JSON.stringify(r.metadata))),
      ],
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "42P01") return;
    throw error;
  }
}

/** Record one price change, ignoring the no-op case (old === new). */
export async function recordOnePriceChange(row: PriceHistoryRow): Promise<void> {
  if (row.oldPrice === row.newPrice) return;
  await recordPriceHistory([row]);
}
