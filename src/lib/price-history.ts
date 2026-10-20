/**
 * Immutable product price history (issue #924 F07).
 *
 * Every path that can change a shelf or purchase price — the price matrix,
 * bulk quick update, product creation, the online-store sync — appends here in
 * the same transaction as the price write, so a price can never move without
 * a row saying who moved it, from what, to what, and why.
 *
 * The table is append-only (`migrations/0234_product_price_history.sql`);
 * nothing in the app updates or deletes a row.
 */

import { query } from "./db";
import type { ProductPriceKind, ProductPriceSource } from "./price-history-labels";

/**
 * The vocabulary lives in a client-safe module (the matrix's history dialog
 * labels rows without importing this file, which opens the database pool).
 * These aliases keep the names every existing caller imports.
 */
export type PriceChangeSource = ProductPriceSource;
export type PriceKind = ProductPriceKind;
export type { ProductPriceSource, ProductPriceKind };

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
 * A database that has not run migration 0234 yet keeps working (42P01 is
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

/** One row of the read side, already joined to the names a screen shows. */
export interface PriceHistoryListRow {
  id: string;
  itemId: string;
  itemName: string | null;
  priceKind: PriceKind;
  priceListId: string | null;
  priceListName: string | null;
  oldPrice: number | null;
  newPrice: number | null;
  source: PriceChangeSource;
  actorId: string | null;
  actorName: string | null;
  /** Groups every row one bulk operation wrote; null for a one-off edit. */
  batchId: string | null;
  createdAt: string;
  reason: string | null;
}

export interface PriceHistoryFilters {
  itemId?: string | null;
  priceKind?: PriceKind | null;
  sources?: PriceChangeSource[] | null;
  /** Default 100, clamped to 1…500. */
  limit?: number;
}

/**
 * Read the immutable history of one branch — the single read path behind
 * `GET /api/products/price-history` (the matrix's per-item dialog and any
 * report built on it).
 *
 * Branch-scoped by `location_id`, newest first. Names are joined here rather
 * than resolved per row by the caller: an audit line is only useful if it says
 * *which* product, *which* named list and *who*.
 */
export async function listPriceHistory(
  locationId: string,
  filters: PriceHistoryFilters = {},
): Promise<PriceHistoryListRow[]> {
  const where = ["h.location_id = $1"];
  const values: unknown[] = [locationId];
  if (filters.itemId) {
    values.push(filters.itemId);
    where.push(`h.item_id = $${values.length}::uuid`);
  }
  if (filters.priceKind) {
    values.push(filters.priceKind);
    where.push(`h.price_kind = $${values.length}`);
  }
  if (filters.sources && filters.sources.length > 0) {
    values.push(filters.sources);
    where.push(`h.source = ANY($${values.length}::text[])`);
  }
  const rawLimit = filters.limit ?? 100;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
  values.push(limit);

  try {
    const { rows } = await query<{
      id: string;
      item_id: string;
      item_name: string | null;
      price_kind: PriceKind;
      price_list_id: string | null;
      price_list_name: string | null;
      old_price: string | null;
      new_price: string | null;
      source: PriceChangeSource;
      actor_id: string | null;
      actor_name: string | null;
      batch_id: string | null;
      created_at: Date;
      reason: string | null;
    }>(
      `SELECT h.id, h.item_id, i.name AS item_name, h.price_kind, h.price_list_id,
              pl.name AS price_list_name,
              h.old_price::text, h.new_price::text, h.source, h.actor_id, h.batch_id,
              u.full_name AS actor_name, h.created_at, h.reason
         FROM product_price_history h
         JOIN items i ON i.id = h.item_id
         LEFT JOIN price_lists pl ON pl.id = h.price_list_id
         LEFT JOIN users u ON u.id = h.actor_id
        WHERE ${where.join(" AND ")}
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      itemName: r.item_name,
      priceKind: r.price_kind,
      priceListId: r.price_list_id,
      priceListName: r.price_list_name,
      oldPrice: r.old_price == null ? null : Number(r.old_price),
      newPrice: r.new_price == null ? null : Number(r.new_price),
      source: r.source,
      actorId: r.actor_id,
      actorName: r.actor_name,
      batchId: r.batch_id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      reason: r.reason,
    }));
  } catch (error) {
    // A database that has not run the migration answers an empty report;
    // every other failure is real and must not read as "nothing happened".
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

/** Record one price change, ignoring the no-op case (old === new). */
export async function recordOnePriceChange(row: PriceHistoryRow): Promise<void> {
  if (row.oldPrice === row.newPrice) return;
  await recordPriceHistory([row]);
}
