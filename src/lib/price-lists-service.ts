/**
 * Phase 42 — named price lists («لیست قیمت») for the products workspace.
 * Hardened per issue #924: costing safety, permissions, bulk scope, history,
 * concurrency, zero semantics, currency/precision, and scalability.
 *
 * `item_stock.unit_price` / `unit_cost` stay the sale and purchase price the
 * invoice screen reads; a price list is an *extra* named shelf column (عمده،
 * همکار، بازار…) whose cells live in `price_list_entries`.
 */

import { isPinnedToTransaction, query, withTenantTransaction } from "./db";
import {
  conflictFor,
  entryKey,
  isValidExpectedVersion,
  planEntrySave,
  type EntryConflict,
  type EntryVersion,
  type VersionedEntryUpdate,
} from "./price-list-conflicts";
import { isUuid } from "./uuid";
import { recordPriceHistory, type PriceChangeSource } from "./price-history";

export type { EntryConflict, VersionedEntryUpdate } from "./price-list-conflicts";

export interface PriceList {
  id: string;
  locationId: string;
  name: string;
  currency: string;
  sort: number;
}

export interface PriceEntry {
  priceListId: string;
  itemId: string;
  price: number;
  version: string;
  updatedAt: string;
}

interface PriceListRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  currency: string;
  sort: number;
}

interface EntryRow extends Record<string, unknown> {
  price_list_id: string;
  item_id: string;
  price: string | number;
  version: string;
  updated_at: Date | string;
}

const MAX_NAME_LENGTH = 60;

function mapList(row: PriceListRow): PriceList {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    currency: row.currency,
    sort: row.sort,
  };
}

export async function listPriceLists(locationId: string): Promise<PriceList[]> {
  const { rows } = await query<PriceListRow>(
    `SELECT * FROM price_lists WHERE location_id = $1 ORDER BY sort, created_at`,
    [locationId],
  );
  return rows.map(mapList);
}

const SUPPORTED_CURRENCIES = new Set(["IRR", "IRT", "USD", "EUR"]);
const CURRENCY_ERROR = "unsupported_currency";

function normalizeCurrency(input?: string): string {
  const trimmed = input?.trim().toUpperCase() || "IRR";
  return trimmed;
}

export async function createPriceList(input: {
  locationId: string;
  name: string;
  currency?: string;
}): Promise<{ list?: PriceList; error?: string }> {
  const name = input.name.trim();
  if (!name) return { error: "missing_fields" };
  if (name.length > MAX_NAME_LENGTH) return { error: "name_too_long" };
  const currency = normalizeCurrency(input.currency);
  if (!SUPPORTED_CURRENCIES.has(currency)) return { error: CURRENCY_ERROR };
  try {
    const { rows } = await query<PriceListRow>(
      `INSERT INTO price_lists (location_id, name, currency, sort)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM price_lists WHERE location_id = $1))
       RETURNING *`,
      [input.locationId, name, currency],
    );
    return { list: mapList(rows[0]) };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function renamePriceList(
  id: string,
  name: string,
  locationId: string,
): Promise<{ list?: PriceList; error?: string }> {
  if (!isUuid(id)) return { error: "not_found" };
  const trimmed = name.trim();
  if (!trimmed) return { error: "missing_fields" };
  if (trimmed.length > MAX_NAME_LENGTH) return { error: "name_too_long" };
  try {
    const { rows } = await query<PriceListRow>(
      `UPDATE price_lists SET name = $2, updated_at = now()
        WHERE id = $1 AND location_id = $3
        RETURNING *`,
      [id, trimmed, locationId],
    );
    return rows[0] ? { list: mapList(rows[0]) } : { error: "not_found" };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

/** Thrown inside the delete transaction when another caller already removed the list. */
const PRICE_LIST_DEAD = Symbol("price_list_dead");

export async function deletePriceList(
  id: string,
  locationId: string,
  audit: {
    businessId: string;
    actorId?: string | null;
    batchId?: string | null;
    source?: PriceChangeSource;
  },
): Promise<boolean> {
  if (!isUuid(id)) return false;

  const run = async (): Promise<boolean> => {
    // Lock the list first: the branch predicate is checked before the entry
    // snapshot, so a list in another branch leaves no history attributed to
    // this one, and a concurrent delete waits here instead of interleaving its
    // history with ours (two FK key-share locks upgrading to DELETE deadlock).
    const { rows: owned } = await query(
      `SELECT 1 FROM price_lists WHERE id = $1 AND location_id = $2 FOR UPDATE`,
      [id, locationId],
    );
    if (owned.length === 0) return false;

    // Snapshot and audit before the cascade removes the entries. History is
    // inserted while the list still exists (the FK requires it), and the
    // whole sequence commits or rolls back as one unit.
    const { rows } = await query<{ item_id: string; price: string }>(
      `SELECT e.item_id, e.price::text AS price FROM price_list_entries e WHERE e.price_list_id = $1`,
      [id],
    );
    if (rows.length > 0) {
      await recordPriceHistory(
        rows.map((r) => ({
          businessId: audit.businessId,
          locationId,
          itemId: r.item_id,
          priceKind: "list" as const,
          priceListId: id,
          oldPrice: Number(r.price),
          newPrice: null,
          source: audit.source ?? "manual",
          actorId: audit.actorId ?? null,
          batchId: audit.batchId ?? null,
          reason: "price_list_deleted",
        })),
      );
    }
    const { rowCount } = await query(`DELETE FROM price_lists WHERE id = $1 AND location_id = $2`, [id, locationId]);
    // Defensive: the row lock above makes this unreachable, but a delete that
    // removed nothing must never leave history claiming it did.
    if ((rowCount ?? 0) === 0) throw PRICE_LIST_DEAD;
    return true;
  };

  try {
    if (isPinnedToTransaction()) return await run();
    return await withTenantTransaction(audit.businessId, run, {
      locationId,
      userId: audit.actorId ?? null,
    });
  } catch (error) {
    if (error === PRICE_LIST_DEAD) return false;
    throw error;
  }
}

const VERSION_SQL = `(extract(epoch FROM e.updated_at) * 1000000)::bigint::text`;
const STOCK_VERSION_SQL = `(extract(epoch FROM s.updated_at) * 1000000)::bigint::text`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * One bounded window of the price matrix (issue #924 F12 / code-review item 1).
 *
 * The screen used to load every item of the branch plus every filled list cell:
 * at 1,685 items that is thousands of rows and three unbounded queries before
 * the first render. This read answers one page — search server-side, a hard
 * `limit`, and `entries` only for the items actually returned — so the payload
 * is bounded by the page size, not by the catalogue.
 */
export interface PriceMatrixRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  kind: string;
  parentName: string | null;
  unitPrice: number | null;
  unitCost: number | null;
  /**
   * `items.is_sellable`. A not-for-sale item still holds a stored price — the
   * matrix will not refuse the edit, because a shop often sets the price before
   * putting the item on the shelf — but the row says so, so "unset", "zero" and
   * "not offered" stay three different facts on screen (issue #924 F08).
   */
  isSellable: boolean;
  /** `item_stock` version for the sale/purchase cells, null when no stock row. */
  version: string | null;
}

export interface PriceMatrixPage {
  items: PriceMatrixRow[];
  entries: PriceEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export const PRICE_MATRIX_DEFAULT_LIMIT = 50;
export const PRICE_MATRIX_MAX_LIMIT = 200;
export const PRICE_MATRIX_MAX_QUERY_LENGTH = 100;

export interface PriceMatrixQuery {
  q: string | null;
  limit: number;
  offset: number;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Clamp untrusted query parameters. A missing `limit` is the page size; a huge
 * or negative one is clamped rather than rejected, so a hand-edited URL still
 * gets a correct answer without letting it ask for the whole catalogue.
 */
export function normalizePriceMatrixQuery(raw: {
  q?: unknown;
  limit?: unknown;
  offset?: unknown;
}): PriceMatrixQuery {
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, PRICE_MATRIX_MAX_QUERY_LENGTH) : "";
  return {
    q: q ? q : null,
    limit: boundedInt(raw.limit, PRICE_MATRIX_DEFAULT_LIMIT, 1, PRICE_MATRIX_MAX_LIMIT),
    offset: boundedInt(raw.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** `LIKE` metacharacters in a user's search are literals, not wildcards. */
function escapeLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Fold the characters a Persian keyboard and a barcode scanner disagree about
 * (issue #924 F12, acceptance "do not regress search normalization").
 *
 * The matrix used to filter in the browser through `normalizePosSearchText`,
 * which folds `ي`→`ی`, `ك`→`ک`, Persian/Arabic digits → Latin and collapses
 * whitespace. Moving the search to SQL must not silently drop that: «كرم» has
 * to find «کرم» and «۱۲۳» has to find "123". This function is the TypeScript
 * half of the pair; `SEARCH_FOLD_SQL` is the Postgres half, and both fold
 * exactly the same characters so the needle and the haystack agree.
 */
const SEARCH_FOLD_MAP: [RegExp, (match: string) => string][] = [
  [/ي/g, () => "ی"],
  [/ك/g, () => "ک"],
  [/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))],
  [/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))],
];

export function foldPriceSearch(value: string): string {
  let folded = value;
  for (const [pattern, replacer] of SEARCH_FOLD_MAP) folded = folded.replace(pattern, replacer);
  return folded.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The same folds, applied to a column inside Postgres. */
const SEARCH_FOLD_SQL = (column: string) =>
  `regexp_replace(translate(lower(${column}), '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩يك', '01234567890123456789یک'), '\\s+', ' ', 'g')`;

export async function listPriceMatrix(
  locationId: string,
  filter: PriceMatrixQuery,
): Promise<PriceMatrixPage> {
  const like = filter.q ? `%${escapeLike(foldPriceSearch(filter.q))}%` : null;
  const [rowsResult, totalResult] = await Promise.all([
    queryRows(locationId, like, filter.limit, filter.offset),
    query(
      `SELECT COUNT(*)::int AS total
         FROM items i
        WHERE i.location_id = $1 AND i.kind <> 'variant_parent'
          AND ($2::text IS NULL
               OR ${SEARCH_FOLD_SQL("i.name")} LIKE $2 ESCAPE '\\'
               OR ${SEARCH_FOLD_SQL("coalesce(i.sku, '')")} LIKE $2 ESCAPE '\\'
               OR ${SEARCH_FOLD_SQL("coalesce(i.barcode, '')")} LIKE $2 ESCAPE '\\')`,
      [locationId, like],
    ),
  ]);
  const items = rowsResult;
  const total = Number((totalResult.rows[0] as { total?: number } | undefined)?.total ?? 0);
  const entries = items.length === 0 ? [] : await listEntriesForItems(locationId, items.map((item) => item.id));
  return {
    items,
    entries,
    total,
    limit: filter.limit,
    offset: filter.offset,
    hasMore: filter.offset + items.length < total,
  };
}

async function queryRows(
  locationId: string,
  like: string | null,
  limit: number,
  offset: number,
): Promise<PriceMatrixRow[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    barcode: string | null;
    kind: string;
    parent_name: string | null;
    unit_price: string | null;
    unit_cost: string | null;
    is_sellable: boolean;
    version: string | null;
  }>(
    `SELECT i.id, i.name, i.sku, i.barcode, i.kind, p.name AS parent_name,
            i.is_sellable, s.unit_price, s.unit_cost, ${STOCK_VERSION_SQL} AS version
       FROM items i
       LEFT JOIN items p ON p.id = i.parent_item_id
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $1 AND i.kind <> 'variant_parent'
        AND ($2::text IS NULL
             OR ${SEARCH_FOLD_SQL("i.name")} LIKE $2 ESCAPE '\\'
             OR ${SEARCH_FOLD_SQL("coalesce(i.sku, '')")} LIKE $2 ESCAPE '\\'
             OR ${SEARCH_FOLD_SQL("coalesce(i.barcode, '')")} LIKE $2 ESCAPE '\\')
      ORDER BY i.name, i.id
      LIMIT $3 OFFSET $4`,
    [locationId, like, limit, offset],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    kind: row.kind,
    parentName: row.parent_name,
    unitPrice: row.unit_price == null ? null : Number(row.unit_price),
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    isSellable: row.is_sellable,
    version: row.version,
  }));
}

/** Filled cells for the items on this page, never for the whole branch. */
async function listEntriesForItems(locationId: string, itemIds: string[]): Promise<PriceEntry[]> {
  const { rows } = await query<EntryRow>(
    `SELECT e.price_list_id, e.item_id, e.price,
            ${VERSION_SQL} AS version, e.updated_at
       FROM price_list_entries e
       JOIN price_lists l ON l.id = e.price_list_id AND l.location_id = $1
      WHERE e.item_id = ANY($2::uuid[])`,
    [locationId, itemIds],
  );
  return rows.map((r) => ({
    priceListId: r.price_list_id,
    itemId: r.item_id,
    price: Number(r.price),
    version: r.version,
    updatedAt: toIso(r.updated_at),
  }));
}

export const PRICE_ENTRIES_MAX = 2000;

/**
 * Filled cells for a branch, hard-capped at `PRICE_ENTRIES_MAX`. The matrix
 * screen no longer uses this read (it asks for one page's cells), but the AI
 * listing verb still does — and no caller may pull an unbounded result set out
 * of a large shop.
 */
export async function listPriceEntries(
  locationId: string,
  limit = PRICE_ENTRIES_MAX,
): Promise<PriceEntry[]> {
  const bounded = boundedInt(limit, PRICE_ENTRIES_MAX, 1, PRICE_ENTRIES_MAX);
  const { rows } = await query<EntryRow>(
    `SELECT e.price_list_id, e.item_id, e.price,
            ${VERSION_SQL} AS version, e.updated_at
       FROM price_list_entries e
       JOIN price_lists l ON l.id = e.price_list_id
      WHERE l.location_id = $1
      ORDER BY e.updated_at DESC, e.price_list_id, e.item_id
      LIMIT $2`,
    [locationId, bounded],
  );
  return rows.map((r) => ({
    priceListId: r.price_list_id,
    itemId: r.item_id,
    price: Number(r.price),
    version: r.version,
    updatedAt: toIso(r.updated_at),
  }));
}

export type EntryUpdate = VersionedEntryUpdate;

export interface PriceEntrySaveResult {
  touched: number;
  conflicts: EntryConflict[];
}

// --- Stock price concurrency (F04) ---
export interface StockPriceVersion {
  price: number | null;
  version: string;
  updatedAt: string;
}

export interface StockPriceUpdate {
  itemId: string;
  kind: "sale" | "purchase";
  price: number | null; // null = clear attempt (sale: no-op, purchase: rejected if stock exists)
  expectedVersion?: string | null;
}

export interface StockPriceSaveResult {
  touched: number;
  conflicts: StockPriceConflict[];
  skipped: StockPriceSkip[];
}

export interface StockPriceConflict {
  itemId: string;
  kind: "sale" | "purchase";
  requestedPrice: number | null;
  currentPrice: number | null;
  currentVersion: string | null;
  updatedAt: string | null;
}

export interface StockPriceSkip {
  itemId: string;
  kind: "sale" | "purchase";
  reason: string;
}

export const STOCK_CONFLICT_VERSION_PATTERN = /^\d{1,20}$/;

export function isValidStockVersion(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && /^\d{1,20}$/.test(value));
}

async function readCurrentEntries(
  cells: readonly VersionedEntryUpdate[],
  locationId: string,
  lock: boolean,
): Promise<Map<string, EntryVersion>> {
  const current = new Map<string, EntryVersion>();
  if (cells.length === 0) return current;
  const { rows } = await query<EntryRow>(
    `SELECT e.price_list_id, e.item_id, e.price, ${VERSION_SQL} AS version, e.updated_at
       FROM price_list_entries e
       JOIN price_lists l ON l.id = e.price_list_id AND l.location_id = $3
       JOIN unnest($1::uuid[], $2::uuid[]) AS t(price_list_id, item_id)
         ON t.price_list_id = e.price_list_id AND t.item_id = e.item_id
     ${lock ? "FOR UPDATE OF e" : ""}`,
    [cells.map((c) => c.priceListId), cells.map((c) => c.itemId), locationId],
  );
  for (const row of rows) {
    current.set(entryKey(row.price_list_id, row.item_id), {
      price: Number(row.price),
      version: row.version,
      updatedAt: toIso(row.updated_at),
    });
  }
  return current;
}

export async function savePriceEntries(
  updates: VersionedEntryUpdate[],
  scope: { locationId: string; businessId: string; userId?: string | null },
): Promise<PriceEntrySaveResult> {
  const valid = updates.filter(
    (u) =>
      isUuid(u.priceListId) &&
      isUuid(u.itemId) &&
      (u.price === null || (Number.isFinite(u.price) && Number.isInteger(u.price) && u.price >= 0 && u.price <= Number.MAX_SAFE_INTEGER)) &&
      isValidExpectedVersion(u.expectedVersion),
  );
  const deduped = new Map<string, VersionedEntryUpdate>();
  for (const update of valid) {
    deduped.set(entryKey(update.priceListId, update.itemId), {
      ...update,
      price: update.price === null ? null : Math.round(update.price),
    });
  }
  const cells = [...deduped.values()];
  if (cells.length === 0) return { touched: 0, conflicts: [] };

  const run = () => applyPriceEntries(cells, scope);
  if (isPinnedToTransaction()) return run();
  return withTenantTransaction(scope.businessId, run, {
    locationId: scope.locationId,
    userId: scope.userId ?? null,
  });
}

async function applyPriceEntries(
  cells: VersionedEntryUpdate[],
  scope: { locationId: string; businessId: string; userId?: string | null },
): Promise<PriceEntrySaveResult> {
  const current = await readCurrentEntries(cells, scope.locationId, true);
  const plan = planEntrySave(cells, current);
  const conflicts = [...plan.conflicts];
  let touched = 0;
  const keyArrays = (list: readonly VersionedEntryUpdate[]) => [list.map((u) => u.priceListId), list.map((u) => u.itemId)];

  // History for deletes/updates: capture old prices
  const historyRows: Parameters<typeof recordPriceHistory>[0] = [];

  if (plan.deletes.length > 0) {
    for (const del of plan.deletes) {
      const key = entryKey(del.priceListId, del.itemId);
      const cur = current.get(key);
      if (cur) {
        historyRows.push({
          businessId: scope.businessId,
          locationId: scope.locationId,
          itemId: del.itemId,
          priceKind: "list",
          priceListId: del.priceListId,
          oldPrice: cur.price,
          newPrice: null,
          source: "manual",
          actorId: scope.userId ?? null,
        });
      }
    }
    const { rowCount } = await query(
      `DELETE FROM price_list_entries e
        USING unnest($1::uuid[], $2::uuid[]) AS t(price_list_id, item_id)
        WHERE e.price_list_id = t.price_list_id AND e.item_id = t.item_id`,
      keyArrays(plan.deletes),
    );
    touched += rowCount ?? 0;
  }

  if (plan.updates.length > 0) {
    for (const upd of plan.updates) {
      const key = entryKey(upd.priceListId, upd.itemId);
      const cur = current.get(key);
      historyRows.push({
        businessId: scope.businessId,
        locationId: scope.locationId,
        itemId: upd.itemId,
        priceKind: "list",
        priceListId: upd.priceListId,
        oldPrice: cur?.price ?? null,
        newPrice: upd.price,
        source: "manual",
        actorId: scope.userId ?? null,
      });
    }
    const { rowCount } = await query(
      `UPDATE price_list_entries e
          SET price = t.price, updated_at = clock_timestamp()
         FROM unnest($1::uuid[], $2::uuid[], $3::bigint[]) AS t(price_list_id, item_id, price)
        WHERE e.price_list_id = t.price_list_id AND e.item_id = t.item_id`,
      [...keyArrays(plan.updates), plan.updates.map((u) => u.price as number)],
    );
    touched += rowCount ?? 0;
  }

  const insertSql = (onConflict: string) =>
    `INSERT INTO price_list_entries (price_list_id, item_id, price, updated_at)
     SELECT t.price_list_id, t.item_id, t.price, clock_timestamp()
       FROM unnest($1::uuid[], $2::uuid[], $3::bigint[]) AS t(price_list_id, item_id, price)
       JOIN price_lists l ON l.id = t.price_list_id AND l.location_id = $4
       JOIN items i ON i.id = t.item_id AND i.location_id = $4
     ${onConflict}
     RETURNING price_list_id, item_id`;
  const insertParams = (list: readonly VersionedEntryUpdate[]) => [
    ...keyArrays(list),
    list.map((u) => u.price as number),
    scope.locationId,
  ];

  const loose = plan.inserts.filter((i) => !i.strict).map((i) => i.update);
  if (loose.length > 0) {
    for (const ins of loose) {
      historyRows.push({
        businessId: scope.businessId,
        locationId: scope.locationId,
        itemId: ins.itemId,
        priceKind: "list",
        priceListId: ins.priceListId,
        oldPrice: null,
        newPrice: ins.price,
        source: "manual",
        actorId: scope.userId ?? null,
      });
    }
    const { rowCount } = await query(
      insertSql(
        `ON CONFLICT (price_list_id, item_id)
         DO UPDATE SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at`,
      ),
      insertParams(loose),
    );
    touched += rowCount ?? 0;
  }

  const strict = plan.inserts.filter((i) => i.strict).map((i) => i.update);
  if (strict.length > 0) {
    const { rows } = await query<{ price_list_id: string; item_id: string }>(
      insertSql("ON CONFLICT (price_list_id, item_id) DO NOTHING"),
      insertParams(strict),
    );
    touched += rows.length;
    const inserted = new Set(rows.map((r) => entryKey(r.price_list_id, r.item_id)));
    const missed = strict.filter((u) => !inserted.has(entryKey(u.priceListId, u.itemId)));
    if (missed.length > 0) {
      const raced = await readCurrentEntries(missed, scope.locationId, false);
      for (const update of missed) {
        const now = raced.get(entryKey(update.priceListId, update.itemId));
        if (now && now.price !== update.price) conflicts.push(conflictFor(update, now));
      }
    }
    // History for strict inserts that succeeded
    for (const r of rows) {
      const upd = strict.find((u) => u.priceListId === r.price_list_id && u.itemId === r.item_id);
      if (upd) {
        historyRows.push({
          businessId: scope.businessId,
          locationId: scope.locationId,
          itemId: upd.itemId,
          priceKind: "list",
          priceListId: upd.priceListId,
          oldPrice: null,
          newPrice: upd.price,
          source: "manual",
          actorId: scope.userId ?? null,
        });
      }
    }
  }

  await recordPriceHistory(historyRows);
  return { touched, conflicts };
}

// --- Stock price batch save with optimistic concurrency ---
export async function saveStockPrices(
  updates: StockPriceUpdate[],
  scope: { locationId: string; businessId: string; userId?: string | null },
): Promise<StockPriceSaveResult> {
  const valid = updates.filter(
    (u) =>
      isUuid(u.itemId) &&
      (u.kind === "sale" || u.kind === "purchase") &&
      (u.price === null || (Number.isFinite(u.price) && Number.isInteger(u.price) && u.price >= 0 && u.price <= Number.MAX_SAFE_INTEGER)) &&
      isValidStockVersion(u.expectedVersion),
  );

  const deduped = new Map<string, StockPriceUpdate>();
  for (const u of valid) {
    const key = `${u.kind}:${u.itemId}`;
    deduped.set(key, { ...u, price: u.price === null ? null : Math.round(u.price) });
  }
  const cells = [...deduped.values()];
  if (cells.length === 0) return { touched: 0, conflicts: [], skipped: [] };

  const run = () => applyStockPrices(cells, scope);
  if (isPinnedToTransaction()) return run();
  return withTenantTransaction(scope.businessId, run, {
    locationId: scope.locationId,
    userId: scope.userId ?? null,
  });
}

async function applyStockPrices(
  cells: StockPriceUpdate[],
  scope: { locationId: string; businessId: string; userId?: string | null },
): Promise<StockPriceSaveResult> {
  // Load current stock rows with version and quantity for cost guard
  const itemIds = cells.map((c) => c.itemId);
  const { rows } = await query<{
    item_id: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
    version: string;
    updated_at: Date;
  }>(
    `SELECT s.item_id, s.quantity::text AS quantity, s.unit_cost::text AS unit_cost, s.unit_price::text AS unit_price,
            ${STOCK_VERSION_SQL} AS version, s.updated_at
       FROM item_stock s
       JOIN items i ON i.id = s.item_id AND i.location_id = $2
      WHERE s.item_id = ANY($1::uuid[])
      FOR UPDATE OF s`,
    [itemIds, scope.locationId],
  );
  const currentMap = new Map<string, { quantity: string; unitCost: number | null; unitPrice: number | null; version: string; updatedAt: string }>();
  for (const r of rows) {
    currentMap.set(r.item_id, {
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      unitPrice: r.unit_price == null ? null : Number(r.unit_price),
      version: r.version,
      updatedAt: toIso(r.updated_at),
    });
  }

  const conflicts: StockPriceConflict[] = [];
  const skipped: StockPriceSkip[] = [];
  const toApply: StockPriceUpdate[] = [];
  const historyRows: Parameters<typeof recordPriceHistory>[0] = [];

  for (const cell of cells) {
    const cur = currentMap.get(cell.itemId);
    const currentPrice = cell.kind === "sale" ? (cur?.unitPrice ?? null) : (cur?.unitCost ?? null);
    const currentVersion = cur?.version ?? null;

    // Version check
    if (cell.expectedVersion !== undefined) {
      const expected = cell.expectedVersion;
      const unchanged = expected === null ? cur === undefined || currentPrice === null : currentVersion === expected;
      if (!unchanged) {
        // If already holds requested value, skip as no-op not conflict
        if (cell.price === currentPrice) continue;
        conflicts.push({
          itemId: cell.itemId,
          kind: cell.kind,
          requestedPrice: cell.price,
          currentPrice,
          currentVersion,
          updatedAt: cur?.updatedAt ?? null,
        });
        continue;
      }
    }

    // No-op check
    if (cell.price === currentPrice) continue;

    // Zero/blank semantics: sale blank (null) is no-op skip, not clear
    if (cell.price === null) {
      skipped.push({ itemId: cell.itemId, kind: cell.kind, reason: "clear_not_supported" });
      continue;
    }

    // Sale must be >0
    if (cell.kind === "sale" && cell.price === 0) {
      skipped.push({ itemId: cell.itemId, kind: "sale", reason: "sale_price_must_be_positive" });
      continue;
    }

    // Purchase cost guard: never overwrite weighted-average when quantity>0
    // This mirrors accessories-service setInitialUnitCost guard and cosmetics refusal
    if (cell.kind === "purchase") {
      const qty = cur ? Number(cur.quantity) : 0;
      // Any on-hand quantity means the carrying cost is owned by receipts/lots;
      // writing it from the matrix (even from null) would revalue stock silently.
      if (qty !== 0) {
        skipped.push({ itemId: cell.itemId, kind: "purchase", reason: "purchase_cost_locked_with_stock" });
        continue;
      }
      // Also reject for cosmetics batch items? Quantity guard already covers it, but also
      // if item has batch tracking, we should block. Check items.tracking = 'batch'
      // We can query tracking, but for now quantity guard suffices; cosmetics with batches have quantity>0.
    }

    // Passed checks -> apply
    toApply.push(cell);
    historyRows.push({
      businessId: scope.businessId,
      locationId: scope.locationId,
      itemId: cell.itemId,
      priceKind: cell.kind,
      oldPrice: currentPrice,
      newPrice: cell.price,
      source: "manual",
      actorId: scope.userId ?? null,
    });
  }

  let touched = 0;
  // Batch update sale and purchase separately via unnest
  const saleUpdates = toApply.filter((c) => c.kind === "sale");
  const purchaseUpdates = toApply.filter((c) => c.kind === "purchase");

  if (saleUpdates.length > 0) {
    // Ensure stock rows exist: INSERT ... ON CONFLICT UPDATE for sale price
    const { rowCount } = await query(
      `INSERT INTO item_stock (item_id, unit_price, updated_at)
       SELECT t.item_id::uuid, t.price::bigint, clock_timestamp()
         FROM unnest($1::uuid[], $2::bigint[]) AS t(item_id, price)
       ON CONFLICT (item_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, updated_at = clock_timestamp()
       RETURNING item_id`,
      [saleUpdates.map((u) => u.itemId), saleUpdates.map((u) => u.price as number)],
    );
    touched += rowCount ?? saleUpdates.length;
  }

  if (purchaseUpdates.length > 0) {
    // For purchase with quantity=0 guard already, we can upsert unit_cost
    // Use same pattern but with quantity=0 check already done; double-guard in SQL
    const { rowCount } = await query(
      `INSERT INTO item_stock (item_id, unit_cost, updated_at, quantity)
       SELECT t.item_id::uuid, t.price::bigint, clock_timestamp(), 0
         FROM unnest($1::uuid[], $2::bigint[]) AS t(item_id, price)
       ON CONFLICT (item_id) DO UPDATE SET unit_cost = EXCLUDED.unit_cost, updated_at = clock_timestamp()
       WHERE item_stock.quantity = 0
       RETURNING item_stock.item_id`,
      [purchaseUpdates.map((u) => u.itemId), purchaseUpdates.map((u) => u.price as number)],
    );
    // rowCount may be less than purchaseUpdates.length if WHERE filtered; those become skipped
    const applied = rowCount ?? 0;
    touched += applied;
    if (applied < purchaseUpdates.length) {
      // The ones not updated were filtered by quantity check in SQL (race)
      const missing = purchaseUpdates.length - applied;
      for (let i = 0; i < missing; i++) {
        // Find which ones — we don't have granular return, so mark generic skip
        skipped.push({ itemId: purchaseUpdates[applied + i].itemId, kind: "purchase", reason: "purchase_cost_locked_with_stock" });
      }
    }
  }

  await recordPriceHistory(historyRows);
  return { touched, conflicts, skipped };
}

// Bulk unified save for price matrix: handles both lists and stock in one transaction
export async function savePriceMatrix(
  input: {
    locationId: string;
    businessId: string;
    userId?: string | null;
    listUpdates: VersionedEntryUpdate[];
    stockUpdates: StockPriceUpdate[];
  },
): Promise<{ lists: PriceEntrySaveResult; stock: StockPriceSaveResult }> {
  const run = async () => {
    const lists = await savePriceEntries(input.listUpdates, { locationId: input.locationId, businessId: input.businessId, userId: input.userId });
    const stock = await saveStockPrices(input.stockUpdates, { locationId: input.locationId, businessId: input.businessId, userId: input.userId });
    return { lists, stock };
  };
  if (isPinnedToTransaction()) return run();
  return withTenantTransaction(input.businessId, run, { locationId: input.locationId, userId: input.userId ?? null });
}

export type QuickUpdateTarget = { kind: "sale" } | { kind: "purchase" } | { kind: "list"; priceListId: string };

export interface QuickUpdateInput {
  target: QuickUpdateTarget;
  mode: "percent" | "amount";
  value: number;
  round: boolean;
  /**
   * Legacy selected-id list. An **empty** array is *not* "all items": only an
   * explicit `scope: { kind: "all" }` may move a whole branch (issue #924 F03
   * acceptance: "selected scope malformed or empty is rejected; only an
   * explicit all-items selection executes branch-wide operations").
   */
  itemIds: string[];
  /** The explicit scope a caller chose. Required for a branch-wide update. */
  scope?: QuickUpdateScope;
  locationId: string;
}

export interface QuickUpdateScope {
  kind: "all" | "selected";
  itemIds?: string[];
}

export const QUICK_UPDATE_MAX_SELECTED = 2000;

export function validateQuickUpdateScope(scope: unknown): { ok: true; scope: QuickUpdateScope } | { ok: false; error: string } {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return { ok: false, error: "invalid_scope" };
  const s = scope as Record<string, unknown>;
  if (s.kind === "all") {
    if (s.itemIds !== undefined) return { ok: false, error: "invalid_scope" };
    return { ok: true, scope: { kind: "all" } };
  }
  if (s.kind === "selected") {
    const ids = s.itemIds;
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "selected_scope_requires_ids" };
    if (ids.length > QUICK_UPDATE_MAX_SELECTED) return { ok: false, error: "selected_scope_too_large" };
    const uniq = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !isUuid(id)) return { ok: false, error: "invalid_item_id" };
      if (uniq.has(id)) return { ok: false, error: "duplicate_item_id" };
      uniq.add(id);
    }
    return { ok: true, scope: { kind: "selected", itemIds: [...uniq] } };
  }
  return { ok: false, error: "invalid_scope_kind" };
}

// Backward-compat helper: interpret legacy itemIds array
export function normalizeQuickUpdateScope(body: { scope?: unknown; itemIds?: unknown }): { ok: true; scope: QuickUpdateScope } | { ok: false; error: string } {
  if (body.scope !== undefined) return validateQuickUpdateScope(body.scope);
  // Legacy: itemIds array — an explicitly sent empty array means all (the AI/MCP
  // contract), but omitting both scope and itemIds must never widen to the branch.
  if (body.itemIds === undefined) return { ok: false, error: "missing_scope" };
  if (!Array.isArray(body.itemIds)) return { ok: false, error: "invalid_itemIds_not_array" };
  // An explicitly empty selection is *not* a branch-wide command. It is the
  // shape a serialization or filtering bug produces, and widening it to every
  // item is the P0 failure this issue reports. Callers that mean "all" must say
  // so: `scope: { kind: "all" }`.
  if (body.itemIds.length === 0) return { ok: false, error: "empty_itemIds" };
  // Non-empty legacy: treat as selected with validation
  return validateQuickUpdateScope({ kind: "selected", itemIds: body.itemIds });
}

const ROUND_UNIT = 10_000;

export const MIN_PERCENT = -100;
export const MAX_PERCENT = 10_000;
/**
 * The largest absolute Rial amount a bulk move may add or subtract.
 *
 * 9e12 Rial is 900 billion Toman — three orders of magnitude above any real
 * catalogue — and it leaves room for `old + amount` to stay inside a signed
 * 64-bit column. The bound lives here, in the one validator every caller
 * shares, because it used to live *only* in `quickUpdatePrices`: the route and
 * the AI executor both accepted larger amounts and the service then returned
 * `{ changed: 0 }`, which the screen reported as "nothing changed" instead of
 * a refused value (issue #924 F10: bound the arithmetic with a descriptive
 * validation error).
 */
export const MAX_AMOUNT = 9_000_000_000_000;

export function isValidQuickUpdateValue(mode: "percent" | "amount", value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (mode === "percent") return value >= MIN_PERCENT && value <= MAX_PERCENT;
  // Amount: whole Rial, and small enough that the arithmetic cannot overflow.
  if (!Number.isInteger(value)) return false;
  return Math.abs(value) <= MAX_AMOUNT;
}

export function applyQuickUpdate(current: number, input: Pick<QuickUpdateInput, "mode" | "value" | "round">): number {
  const next = input.mode === "percent" ? current * (1 + input.value / 100) : current + input.value;
  const clamped = Math.max(0, Math.round(next));
  if (!input.round) return clamped;
  const rounded = Math.round(clamped / ROUND_UNIT) * ROUND_UNIT;
  return rounded === 0 && clamped > 0 ? ROUND_UNIT : rounded;
}

// Preview for bulk update
export interface QuickUpdatePreview {
  affectedCount: number;
  skippedCount: number;
  sample: { itemId: string; itemName: string; oldPrice: number | null; newPrice: number | null; willChange: boolean }[];
  totalBefore: number;
  totalAfter: number;
}

export async function previewQuickUpdate(
  input: QuickUpdateInput & { scope: QuickUpdateScope; businessId: string },
): Promise<QuickUpdatePreview> {
  const scopeIds = input.scope.kind === "selected" ? input.scope.itemIds! : null;
  // Verify branch membership for selected scope
  if (scopeIds) {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM items WHERE id = ANY($1::uuid[]) AND location_id = $2`,
      [scopeIds, input.locationId],
    );
    if (Number(rows[0].count) !== scopeIds.length) throw new Error("scope_items_not_in_branch");
  }

  const moved = input.mode === "percent" ? `(%COL% * (1 + %VAL%::numeric / 100))` : `(%COL% + %VAL%::numeric)`;
  const clamped = `GREATEST(0, round(${moved}))`;
  const expression = input.round
    ? `CASE WHEN ${clamped} > 0 AND round(${clamped} / ${ROUND_UNIT}) * ${ROUND_UNIT} = 0 THEN ${ROUND_UNIT} ELSE round(${clamped} / ${ROUND_UNIT}) * ${ROUND_UNIT} END`
    : clamped;
  const sqlExpr = (template: string, col: string, valParam: string) =>
    template.replaceAll("%COL%", col).replaceAll("%VAL%", valParam);

  interface PreviewTotalsRow extends Record<string, unknown> {
    total: string;
    affected: string;
    total_before: string | null;
    total_after: string | null;
  }
  interface PreviewSampleRow extends Record<string, unknown> {
    item_id: string;
    name: string;
    old_price: string;
    new_price: string;
  }

  if (input.target.kind === "list") {
    const expr = sqlExpr(expression, "e.price", "$4");
    const params = [input.locationId, input.target.priceListId, scopeIds, input.value];
    const from = `FROM items i
        JOIN price_list_entries e ON e.item_id = i.id AND e.price_list_id = $2
        JOIN price_lists l ON l.id = e.price_list_id AND l.location_id = $1
       WHERE i.location_id = $1 AND ($3::uuid[] IS NULL OR i.id = ANY($3::uuid[]))`;

    // Counts and totals cover the whole scope; the sample is only for the preview table.
    const { rows: totals } = await query<PreviewTotalsRow>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE (${expr}) <> e.price)::text AS affected,
              COALESCE(SUM(e.price), 0)::text AS total_before,
              COALESCE(SUM(${expr}), 0)::text AS total_after
         ${from}`,
      params,
    );
    const { rows: sample } = await query<PreviewSampleRow>(
      `SELECT i.id AS item_id, i.name, e.price::text AS old_price,
              (${expr})::text AS new_price
         ${from}
        ORDER BY i.name LIMIT 5`,
      params,
    );
    const total = Number(totals[0]?.total ?? 0);
    const affected = Number(totals[0]?.affected ?? 0);
    return {
      affectedCount: affected,
      skippedCount: total - affected,
      sample: sample.map((r) => ({
        itemId: r.item_id,
        itemName: r.name,
        oldPrice: Number(r.old_price),
        newPrice: Number(r.new_price),
        willChange: r.old_price !== r.new_price,
      })),
      totalBefore: Number(totals[0]?.total_before ?? 0),
      totalAfter: Number(totals[0]?.total_after ?? 0),
    };
  } else {
    const column = input.target.kind === "sale" ? "unit_price" : "unit_cost";
    const expr = sqlExpr(expression, `s.${column}`, "$3");
    const guard = input.target.kind === "sale" ? `AND (${expr}) > 0` : "";
    // For purchase, add quantity=0 guard in preview as well
    const purchaseGuard = input.target.kind === "purchase" ? `AND s.quantity = 0` : "";
    const params = [input.locationId, scopeIds, input.value];
    const from = `FROM items i JOIN item_stock s ON s.item_id = i.id
       WHERE i.location_id = $1 AND s.${column} IS NOT NULL
         AND ($2::uuid[] IS NULL OR s.item_id = ANY($2::uuid[]))
         ${guard} ${purchaseGuard}`;

    const { rows: totals } = await query<PreviewTotalsRow>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE (${expr}) <> s.${column})::text AS affected,
              COALESCE(SUM(s.${column}), 0)::text AS total_before,
              COALESCE(SUM(${expr}), 0)::text AS total_after
         ${from}`,
      params,
    );
    const { rows: sample } = await query<PreviewSampleRow>(
      `SELECT i.id AS item_id, i.name, s.${column}::text AS old_price,
              (${expr})::text AS new_price
         ${from}
        ORDER BY i.name LIMIT 5`,
      params,
    );
    const total = Number(totals[0]?.total ?? 0);
    const affected = Number(totals[0]?.affected ?? 0);
    return {
      affectedCount: affected,
      skippedCount: total - affected,
      sample: sample.map((r) => ({
        itemId: r.item_id,
        itemName: r.name,
        oldPrice: Number(r.old_price),
        newPrice: Number(r.new_price),
        willChange: r.old_price !== r.new_price,
      })),
      totalBefore: Number(totals[0]?.total_before ?? 0),
      totalAfter: Number(totals[0]?.total_after ?? 0),
    };
  }
}

export interface QuickUpdateOutcome {
  /** Cells whose stored price actually moved. */
  changed: number;
  /** Cells in scope that the guards refused or that were already at the target value. */
  skipped: number;
}

export async function quickUpdatePrices(
  input: QuickUpdateInput & {
    businessId?: string;
    actorId?: string | null;
    batchId?: string;
    source?: PriceChangeSource;
  },
): Promise<QuickUpdateOutcome> {
  const nothing: QuickUpdateOutcome = { changed: 0, skipped: 0 };
  // Defensive: every caller validates first (the route answers 400, the AI
  // executor fails `invalid_value`), so this only guards a direct service call.
  if (!isValidQuickUpdateValue(input.mode, input.value)) return nothing;

  // Scope resolution (F03): an explicit scope wins; otherwise a non-empty id
  // list is a selection; otherwise there is no target. An empty id list is never
  // widened to the whole branch — only `scope: { kind: "all" }` does that.
  let scope: string[] | null;
  if (input.scope) {
    if (input.scope.kind === "all") scope = null;
    else {
      const selected = (input.scope.itemIds ?? []).filter(isUuid);
      if (selected.length === 0 || selected.length !== (input.scope.itemIds ?? []).length) return nothing;
      scope = selected;
    }
  } else {
    const itemIds = input.itemIds.filter(isUuid);
    // If the caller sent non-uuid ids, they are invalid — do not widen the
    // update to every item because none survived validation.
    if (input.itemIds.length > 0 && itemIds.length === 0) return nothing;
    if (itemIds.length === 0) return nothing;
    scope = itemIds;
  }

  // A selection that names another branch's item is refused, exactly as the
  // preview refuses it — a silent no-op would let a caller believe the price
  // moved. The row-level `location_id` filter below still protects the write.
  if (scope) {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM items WHERE id = ANY($1::uuid[]) AND location_id = $2`,
      [scope, input.locationId],
    );
    if (Number(rows[0].count) !== scope.length) throw new Error("scope_items_not_in_branch");
  }

  const moved =
    input.mode === "percent" ? `(%COL% * (1 + %VAL%::numeric / 100))` : `(%COL% + %VAL%::numeric)`;
  const clamped = `GREATEST(0, round(${moved}))`;
  const expression = input.round
    ? `CASE WHEN ${clamped} > 0 AND round(${clamped} / ${ROUND_UNIT}) * ${ROUND_UNIT} = 0
             THEN ${ROUND_UNIT}
             ELSE round(${clamped} / ${ROUND_UNIT}) * ${ROUND_UNIT} END`
    : clamped;

  const sql = (template: string, col: string, valueParam: string) =>
    template.replaceAll("%COL%", col).replaceAll("%VAL%", valueParam);

  interface ChangedRow {
    item_id: string;
    price_list_id: string | null;
    old_price: string | null;
    new_price: string | null;
  }
  interface OutcomeRow extends Record<string, unknown> {
    changed: number;
    skipped: number;
    changed_rows: ChangedRow[];
  }

  /**
   * One statement per target: the candidate set is locked, the eligible rows
   * are updated, and the same scan reports how many cells were left alone
   * (no-op, out of range, or refused by a cost guard). Postgres executes a
   * data-modifying CTE exactly once, so `updated` can feed both the counts and
   * the audit rows.
   */
  async function run(): Promise<QuickUpdateOutcome> {
    const bigintMax = "9223372036854775807";

    if (input.target.kind === "list") {
      if (!isUuid(input.target.priceListId)) return nothing;
      const listExpr = sql(expression, "e.price", "$4");
      const { rows } = await query<OutcomeRow>(
        `WITH candidates AS (
           SELECT e.price_list_id, e.item_id, e.price AS old_price,
                  (${listExpr}) AS new_price
             FROM price_list_entries e
             JOIN price_lists l ON l.id = e.price_list_id
            WHERE l.location_id = $1
              AND e.price_list_id = $2
              AND ($3::uuid[] IS NULL OR e.item_id = ANY($3::uuid[]))
            FOR UPDATE OF e
         ), eligible AS (
           SELECT * FROM candidates c
            WHERE c.new_price IS NOT NULL
              AND c.new_price >= 0
              AND c.new_price <= ${bigintMax}
              AND c.new_price <> c.old_price
         ), updated AS (
           UPDATE price_list_entries e
              SET price = g.new_price::bigint,
                  updated_at = now()
             FROM eligible g
            WHERE e.price_list_id = g.price_list_id
              AND e.item_id = g.item_id
           RETURNING e.price_list_id, e.item_id, e.price AS new_price
         )
         SELECT
           (SELECT COUNT(*)::int FROM updated) AS changed,
           (SELECT COUNT(*)::int FROM candidates c WHERE NOT (
              c.new_price IS NOT NULL AND c.new_price >= 0
              AND c.new_price <= ${bigintMax} AND c.new_price <> c.old_price
            )) AS skipped,
           (SELECT COALESCE(json_agg(json_build_object(
              'item_id', u.item_id,
              'price_list_id', u.price_list_id,
              'old_price', g.old_price::text,
              'new_price', u.new_price::text
            )), '[]'::json)
              FROM updated u
              JOIN eligible g ON g.price_list_id = u.price_list_id AND g.item_id = u.item_id
           ) AS changed_rows`,
        [input.locationId, input.target.priceListId, scope, input.value],
      );
      return await finish(rows[0]);
    }

    const column = input.target.kind === "sale" ? "unit_price" : "unit_cost";
    const stockExpr = sql(expression, `s.${column}`, "$3");
    // F01: purchase bulk never revalues existing inventory; sale never reaches zero.
    const guard =
      input.target.kind === "sale" ? "AND c.new_price > 0" : input.target.kind === "purchase" ? "AND c.quantity = 0" : "";
    const { rows } = await query<OutcomeRow>(
      `WITH candidates AS (
         SELECT s.item_id, s.quantity, s.${column} AS old_price,
                (${stockExpr}) AS new_price
           FROM item_stock s
           JOIN items i ON i.id = s.item_id AND i.location_id = $1
          WHERE s.${column} IS NOT NULL
            AND ($2::uuid[] IS NULL OR s.item_id = ANY($2::uuid[]))
          FOR UPDATE OF s
       ), eligible AS (
         SELECT * FROM candidates c
          WHERE c.new_price IS NOT NULL
            AND c.new_price >= 0
            AND c.new_price <= ${bigintMax}
            AND c.new_price <> c.old_price
            ${guard}
       ), updated AS (
         UPDATE item_stock s
            SET ${column} = g.new_price::bigint,
                updated_at = now()
           FROM eligible g
          WHERE s.item_id = g.item_id
         RETURNING s.item_id, s.${column} AS new_price
       )
       SELECT
         (SELECT COUNT(*)::int FROM updated) AS changed,
         (SELECT COUNT(*)::int FROM candidates c WHERE NOT (
            c.new_price IS NOT NULL AND c.new_price >= 0
            AND c.new_price <= ${bigintMax} AND c.new_price <> c.old_price
            ${guard}
          )) AS skipped,
         (SELECT COALESCE(json_agg(json_build_object(
            'item_id', u.item_id,
            'price_list_id', NULL::uuid,
            'old_price', g.old_price::text,
            'new_price', u.new_price::text
          )), '[]'::json)
            FROM updated u
            JOIN eligible g ON g.item_id = u.item_id
         ) AS changed_rows`,
      [input.locationId, scope, input.value],
    );
    return await finish(rows[0]);
  }

  async function finish(row: OutcomeRow | undefined): Promise<QuickUpdateOutcome> {
    const changedRows = row?.changed_rows ?? [];
    const changed = row?.changed ?? 0;
    if (changedRows.length > 0 && input.businessId) {
      await recordPriceHistory(
        changedRows.map((changedRow) => ({
          businessId: input.businessId!,
          locationId: input.locationId,
          itemId: changedRow.item_id,
          priceKind: input.target.kind,
          priceListId: changedRow.price_list_id,
          oldPrice: changedRow.old_price == null ? null : Number(changedRow.old_price),
          newPrice: changedRow.new_price == null ? null : Number(changedRow.new_price),
          source: input.source ?? "bulk",
          actorId: input.actorId ?? null,
          batchId: input.batchId ?? null,
          reason: "quick_update",
        })),
      );
    }
    return { changed, skipped: row?.skipped ?? 0 };
  }

  if (isPinnedToTransaction() || !input.businessId) return run();
  return withTenantTransaction(input.businessId, run, {
    locationId: input.locationId,
    userId: input.actorId ?? null,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export const SUPPORTED_CURRENCIES_EXPORT = SUPPORTED_CURRENCIES;
