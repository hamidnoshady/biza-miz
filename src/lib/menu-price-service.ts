/**
 * The canonical selling-price change service — issue #844.
 *
 * `menu_items.price` used to be a plain mutable column written directly by
 * whoever got there: the manual menu editor, the CSV/Excel importer, the AI
 * `menu.item.priceUpdate` action, the WooCommerce product sync, Data Transfer
 * and the Hybrid master merge all had their own `UPDATE … SET price`. None of
 * them left a record of what the price had been, so the question «این قیمت کی
 * و چرا عوض شد؟» had no answer and a bulk import could silently undo a
 * manager's correction.
 *
 * Now there is exactly one writer. Every actual price change:
 *
 *   1. locks the item row (`SELECT … FOR UPDATE`) so two concurrent writers
 *      serialise instead of both reading the same "current" price,
 *   2. validates the new price with the same `parsePrice` the manual CRUD uses,
 *   3. updates `menu_items.price` (the fast current price — unchanged in role),
 *   4. appends one immutable row to `menu_item_price_history`,
 *   5. writes the shared `menu.item.price_changed` audit event,
 *   6. commits — all six inside one transaction, so history can never disagree
 *      with the price it describes.
 *
 * `old == new` writes nothing: a no-op PATCH is not a price change.
 *
 * The *source* is a server-side fact about the calling path, never a request
 * body field — a client cannot relabel its edit as a migration or an import.
 * The callers are:
 *
 *   manual       the price-change dialog / PATCH `/api/menu/items/:id`
 *   suggested    POST `/api/menu/items/:id/suggested-price` (server-computed)
 *   import       Data Transfer `pos.products`, the setup/legacy menu importer
 *   ai           autopilot + MCP executors, the AI proposal-apply proxy
 *   integration  WooCommerce product sync (`integrations/sync-service.ts`)
 *   sync         Hybrid/central master-row merge (`master-sync-service.ts`)
 *   migration    reserved for one-off backfills
 *
 * Existing closed orders are unaffected by design: order lines snapshot their
 * own sale price. This history is a catalogue/audit concern, not an invoice
 * rewrite.
 *
 * DB-touching; the transactional contract is exercised by `npm run test:db`
 * routes, and the pure rules (labels, validation, delta maths) are unit-tested
 * in menu-price-service.test.ts.
 */
import type { PoolClient } from "pg";
import { getPool, isPinnedToTransaction, query, withTenant } from "./db";
import { parsePrice } from "./menu-validation";
import {
  PRICE_CHANGE_SOURCES,
  PRICE_SOURCE_LABELS,
  isPriceChangeSource,
  priceChangeSummary,
  type PriceChangeSource,
} from "./menu-price-sources";

// The vocabulary is defined once, in the client-safe `menu-price-sources.ts`
// (the history screen and this writer must never disagree), and re-exported
// here so every server caller keeps its single import.
export {
  PRICE_CHANGE_SOURCES,
  PRICE_SOURCE_LABELS,
  isPriceChangeSource,
  priceChangeSummary,
};
export type { PriceChangeSource };

/**
 * One statement executor — either a pinned transaction client or the ambient
 * `query()` (which is itself the pinned client inside `withTenantTransaction`).
 * The core takes this so one implementation serves the standalone transaction,
 * the importer's own transaction and the Hybrid merge's client alike.
 */
export interface PriceChangeExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface PriceChangeInput {
  businessId: string;
  locationId: string;
  menuItemId: string;
  /** New selling price, integer Rial — validated here, never trusted. */
  newPrice: number;
  source: PriceChangeSource;
  /** The acting member (uuid), or null for a background writer. */
  changedBy?: string | null;
  /** Which audit row / file / connection produced the change. */
  sourceRef?: string | null;
  reason?: string | null;
  note?: string | null;
  /** When the price takes effect; defaults to now. */
  effectiveFrom?: Date | null;
}

export type PriceChangeResult =
  | { ok: true; changed: boolean; historyId?: string; oldPrice?: number; newPrice?: number }
  | { ok: false; error: string; status: number };

/** A `PoolClient` (or anything with `.query`) as a `PriceChangeExecutor`. */
export function clientExecutor(client: Pick<PoolClient, "query">): PriceChangeExecutor {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) {
      return client.query<T>(sql, values as never);
    },
  };
}

/**
 * The six-step contract, on an executor the caller already runs inside a
 * transaction. Callers holding a `PoolClient` pass `clientExecutor(client)`;
 * callers inside `withTenantTransaction` pass `query` itself (ambient query is
 * pinned to that transaction's client).
 */
export async function changeMenuItemPriceWith(
  executor: PriceChangeExecutor,
  input: PriceChangeInput,
): Promise<PriceChangeResult> {
  const price = parsePrice(input.newPrice);
  if (!price.ok) return { ok: false, error: "invalid_price", status: 400 };

  // 1. Lock. Two concurrent writers serialise here; the loser sees the
  // winner's price and re-evaluates `old == new` against it.
  const { rows } = await executor.query<{ price: string | number }>(
    "SELECT price::text AS price FROM menu_items WHERE id = $1 AND location_id = $2 FOR UPDATE",
    [input.menuItemId, input.locationId],
  );
  if (!rows[0]) return { ok: false, error: "item_not_found", status: 404 };
  const oldPrice = Number(rows[0].price);

  // 4 in step order but earliest in code: nothing at all happens on a no-op.
  if (oldPrice === price.value) return { ok: true, changed: false, oldPrice, newPrice: oldPrice };

  // 3. Update the current price.
  await executor.query("UPDATE menu_items SET price = $1, updated_at = now() WHERE id = $2", [
    price.value,
    input.menuItemId,
  ]);

  // 4. Append the immutable history row.
  const history = await executor.query<{ id: string }>(
    `INSERT INTO menu_item_price_history
       (business_id, location_id, menu_item_id, old_price_rial, new_price_rial,
        effective_from, changed_at, changed_by, source, source_ref, reason, note)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, now()), now(), $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.businessId,
      input.locationId,
      input.menuItemId,
      oldPrice,
      price.value,
      input.effectiveFrom ?? null,
      input.changedBy ?? null,
      input.source,
      input.sourceRef ?? null,
      input.reason ?? null,
      input.note ?? null,
    ],
  );

  // 5. The shared audit event — Persian label in src/lib/audit.ts.
  await executor.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'menu.item.price_changed', 'menu_item', $4, $5)`,
    [
      input.businessId,
      input.locationId,
      input.changedBy ?? null,
      input.menuItemId,
      JSON.stringify({
        oldPrice,
        newPrice: price.value,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        reason: input.reason ?? null,
      }),
    ],
  );

  return {
    ok: true,
    changed: true,
    historyId: history.rows[0]?.id,
    oldPrice,
    newPrice: price.value,
  };
}

/**
 * Standalone: one transaction of its own (lock → validate → update → history
 * → audit → commit). This is the entry point for callers that are not already
 * inside a transaction — the API routes, autopilot executors, the adapters.
 *
 * A caller that already holds a `withTenantTransaction` is joined to *that*
 * transaction instead (ambient `query()` is pinned to it), so the service's
 * history and audit commit together with the caller's own writes and never on
 * a second connection that could disagree with them.
 */
export async function changeMenuItemPrice(input: PriceChangeInput): Promise<PriceChangeResult> {
  if (isPinnedToTransaction()) {
    // Ambient `query()` IS the pinned client — the caller's own transaction —
    // wrapped in the executor object because `PriceChangeExecutor` is a
    // method-bearing interface, not a bare function type.
    const ambient: PriceChangeExecutor = { query };
    return withTenant(
      input.businessId,
      () => changeMenuItemPriceWith(ambient, input),
      { locationId: input.locationId, userId: input.changedBy ?? null },
    );
  }
  return withTenant(
    input.businessId,
    async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await changeMenuItemPriceWith(clientExecutor(client), input);
        if (result.ok) await client.query("COMMIT");
        else await client.query("ROLLBACK");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    { locationId: input.locationId, userId: input.changedBy ?? null },
  );
}

// ---------------------------------------------------------------------------
// Read side — the price-history screen
// ---------------------------------------------------------------------------

export interface PriceHistoryFilters {
  /** Exact item. */
  menuItemId?: string | null;
  /** Item name search (ilike) — the history screen's search box. */
  search?: string | null;
  categoryId?: string | null;
  sources?: readonly PriceChangeSource[] | null;
  changedBy?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
}

export interface PriceHistoryRow {
  id: string;
  menuItemId: string;
  itemName: string;
  categoryName: string | null;
  oldPriceRial: number;
  newPriceRial: number;
  deltaRial: number;
  deltaPercent: number | null;
  effectiveFrom: string;
  changedAt: string;
  changedBy: string | null;
  changedByName: string | null;
  source: PriceChangeSource;
  sourceRef: string | null;
  reason: string | null;
  note: string | null;
}

/**
 * History rows for one branch, newest first. Persian digits, money formatting
 * and the source labels are applied by the screen — this returns the wire
 * shape (ISO instants, integer Rial), like every other read in the product.
 */
export async function listPriceHistory(
  locationId: string,
  filters: PriceHistoryFilters = {},
): Promise<PriceHistoryRow[]> {
  const where = ["h.location_id = $1"];
  const params: unknown[] = [locationId];
  const add = (sql: (index: number) => string, value: unknown) => {
    params.push(value);
    where.push(sql(params.length));
  };

  if (filters.menuItemId) add((i) => `h.menu_item_id = $${i}::uuid`, filters.menuItemId);
  if (filters.categoryId) add((i) => `mi.category_id = $${i}::uuid`, filters.categoryId);
  if (filters.search?.trim())
    add((i) => `mi.name ILIKE '%' || $${i} || '%'`, filters.search.trim());
  if (filters.changedBy) add((i) => `h.changed_by = $${i}`, filters.changedBy);
  if (filters.dateFrom) add((i) => `h.changed_at >= $${i}::date`, filters.dateFrom);
  if (filters.dateTo) add((i) => `h.changed_at < ($${i}::date + interval '1 day')`, filters.dateTo);
  if (filters.sources && filters.sources.length > 0)
    add((i) => `h.source = ANY($${i}::text[])`, [...filters.sources]);

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  params.push(limit);

  const { rows } = await query<Record<string, unknown>>(
    `SELECT h.id, h.menu_item_id, mi.name AS item_name, mc.name AS category_name,
            h.old_price_rial, h.new_price_rial,
            h.effective_from, h.changed_at, h.changed_by, u.full_name AS changed_by_name,
            h.source, h.source_ref, h.reason, h.note
       FROM menu_item_price_history h
       JOIN menu_items mi ON mi.id = h.menu_item_id
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
       LEFT JOIN users u ON u.id = CASE
         WHEN h.changed_by ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN h.changed_by::uuid END
      WHERE ${where.join(" AND ")}
      ORDER BY h.changed_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => {
    const oldPrice = Number(row.old_price_rial ?? 0);
    const newPrice = Number(row.new_price_rial ?? 0);
    const delta = newPrice - oldPrice;
    return {
      id: String(row.id),
      menuItemId: String(row.menu_item_id),
      itemName: String(row.item_name ?? ""),
      categoryName: row.category_name == null ? null : String(row.category_name),
      oldPriceRial: oldPrice,
      newPriceRial: newPrice,
      deltaRial: delta,
      deltaPercent: oldPrice > 0 ? Math.round((delta / oldPrice) * 1000) / 10 : null,
      effectiveFrom: new Date(String(row.effective_from)).toISOString(),
      changedAt: new Date(String(row.changed_at)).toISOString(),
      changedBy: row.changed_by == null ? null : String(row.changed_by),
      changedByName: row.changed_by_name == null ? null : String(row.changed_by_name),
      source: (isPriceChangeSource(row.source) ? row.source : "manual") as PriceChangeSource,
      sourceRef: row.source_ref == null ? null : String(row.source_ref),
      reason: row.reason == null ? null : String(row.reason),
      note: row.note == null ? null : String(row.note),
    };
  });
}

/**
 * The items tab's «آخرین تغییر قیمت» column: the newest history row per item
 * of this branch, as one map. One query instead of N.
 */
export async function latestPriceChangesByItem(
  locationId: string,
): Promise<Record<string, { changedAt: string; oldPriceRial: number; newPriceRial: number; source: PriceChangeSource }>> {
  const { rows } = await query<{
    menu_item_id: string;
    changed_at: Date;
    old_price_rial: string | number;
    new_price_rial: string | number;
    source: string;
  }>(
    `SELECT DISTINCT ON (h.menu_item_id)
            h.menu_item_id, h.changed_at, h.old_price_rial, h.new_price_rial, h.source
       FROM menu_item_price_history h
      WHERE h.location_id = $1
      ORDER BY h.menu_item_id, h.changed_at DESC`,
    [locationId],
  );
  const out: Record<string, { changedAt: string; oldPriceRial: number; newPriceRial: number; source: PriceChangeSource }> = {};
  for (const row of rows) {
    out[row.menu_item_id] = {
      changedAt: new Date(row.changed_at).toISOString(),
      oldPriceRial: Number(row.old_price_rial),
      newPriceRial: Number(row.new_price_rial),
      source: isPriceChangeSource(row.source) ? row.source : "manual",
    };
  }
  return out;
}
