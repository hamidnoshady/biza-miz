/**
 * The «رسید و حواله‌های انبار» register — the query surface both warehouse
 * document screens (Food Service on `inventory_items`, Retail on
 * `items`/batches) share: filter parsing, the sort/keyset contract, the
 * complete-result walk the export and the print sheet need, and the export
 * table itself.
 *
 * Issue #923 P2 completes the register's filters. The two families keep their
 * own SQL — their line tables and search columns genuinely differ — but a
 * filter must mean the same thing on both screens, so what a `?sort=` value
 * *means*, how a cursor is resumed against it, and which columns a CSV gets
 * are decided here, once.
 *
 * Two rules that are easy to get wrong and are therefore encoded here:
 *
 *   * **Money is Rial, text is text.** `amountMin`/`amountMax` arrive as an
 *     integer Rial string (the screen converts the entered toman/rial amount
 *     with the business's own unit before sending) and are compared against
 *     `COALESCE(total_value_rial, 0)` — the column is nullable on legacy rows,
 *     and `NULL > 0` would silently drop them from an "amount from" filter.
 *   * **The business date is the branch's date.** `business_date` falls back to
 *     the *location's* day, not the server's: a document posted 03:00 in a
 *     branch whose zone is not the server's belongs to that branch's calendar
 *     day. The expression lives in `businessDateSql()` and is used by the list,
 *     the detail and the print, so the three can never disagree.
 */

import { query } from "./db";
import {
  isWarehousePostingState,
  isWarehouseRegisterSort,
  type WarehousePostingState,
  type WarehouseRegisterSort,
} from "./warehouse-document-register-options";

export type WarehouseRegisterFamily = "fnb" | "retail";

export {
  WAREHOUSE_POSTING_STATES,
  WAREHOUSE_REGISTER_SORTS,
  WAREHOUSE_REGISTER_SORT_LABELS,
  isWarehousePostingState,
  isWarehouseRegisterSort,
  type WarehousePostingState,
  type WarehouseRegisterSort,
} from "./warehouse-document-register-options";

/** Everything the register filters on. All fields optional; absent = unfiltered. */
export interface WarehouseRegisterFilters {
  kind?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Integer Rial strings — the API never accepts a decimal amount. */
  amountMin?: string;
  amountMax?: string;
  createdBy?: string;
  postingState?: WarehousePostingState;
}

/** The cursor is the last row's full sort key plus the sort it belongs to. */
export interface WarehouseRegisterCursor {
  sort: WarehouseRegisterSort;
  /** The sort key of the last row: an ISO instant, an ISO date, or Rial digits. */
  key: string;
  id: string;
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RIAL_RE = /^\d{1,18}$/;

/**
 * Encode a cursor. Delimited ASCII then base64url, like the register's
 * original `(createdAt, id)` cursor — readable in a log, safe in a URL.
 */
export function encodeWarehouseRegisterCursor(cursor: WarehouseRegisterCursor): string {
  return Buffer.from(`${cursor.sort}|${cursor.key}|${cursor.id}`).toString("base64url");
}

/**
 * Parse `?cursor=`, or `null` when it is not one.
 *
 * A cursor from the previous, sort-less release (`createdAt|id`) still decodes
 * — as `created_desc`, which is what it was. A cursor whose sort does not
 * match the request's sort (the client changed the selector but kept the
 * cursor) is also `null`: resuming a page against a different order would skip
 * or repeat rows, and starting from the first page is the only honest answer.
 */
export function decodeWarehouseRegisterCursor(
  raw: string | null | undefined,
  expectedSort: WarehouseRegisterSort,
): WarehouseRegisterCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split("|");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (parts.length === 2) {
    const [createdAt, id] = parts;
    if (!createdAt || !id || !ISO_INSTANT_RE.test(createdAt) || !UUID_RE.test(id)) return null;
    return expectedSort === "created_desc" ? { sort: "created_desc", key: createdAt, id } : null;
  }
  if (parts.length !== 3) return null;
  const [sort, key, id] = parts;
  if (!isWarehouseRegisterSort(sort) || sort !== expectedSort) return null;
  if (!id || !UUID_RE.test(id)) return null;
  if (!sortKeyMatches(sort, key)) return null;
  return { sort, key, id };
}

function sortKeyMatches(sort: WarehouseRegisterSort, key: string): boolean {
  if (sort === "created_asc" || sort === "created_desc") return ISO_INSTANT_RE.test(key);
  if (sort === "date_asc" || sort === "date_desc") return ISO_DATE_RE.test(key);
  return RIAL_RE.test(key);
}

/**
 * The branch-aware business date of a document row.
 *
 * `business_date` is the date the register displays and filters on (#923 P1).
 * Legacy rows have none, and the fallback must be the *branch's* calendar day:
 * `created_at::date` would use the database session's timezone, so a receipt
 * posted at 00:30 in Tehran (21:00 UTC the day before) would land on the wrong
 * day for a UTC server. `app_business_date` (migration 0076) is the platform's
 * single implementation of "which business day is this instant", honouring both
 * the location's timezone and its configured business-day start.
 *
 * `alias` is the document table's alias; the join to `locations` must be
 * present (both register queries join it as `l`).
 */
export function businessDateSql(alias = "d", locationAlias = "l"): string {
  return `COALESCE(${alias}.business_date, app_business_date(${alias}.created_at, ${locationAlias}.timezone, ${locationAlias}.business_day_start_minutes))`;
}

/**
 * The keyset predicate for a cursor under `sort`.
 *
 * Values are always bound as parameters; only the operator and the key
 * expression come from the (whitelisted) sort.
 */
export function keysetSql(
  sort: WarehouseRegisterSort,
  keySql: string,
  alias: string,
  keyParam: string,
  idParam: string,
): string {
  const operator = sort.endsWith("_asc") ? ">" : "<";
  return `(${keySql}, ${alias}.id) ${operator} (${keyParam}, ${idParam})`;
}

/** `ORDER BY` for a sort, given the key expression it orders on. */
export function orderBySql(sort: WarehouseRegisterSort, keySql: string, alias: string): string {
  const direction = sort.endsWith("_asc") ? "ASC" : "DESC";
  return `${keySql} ${direction}, ${alias}.id ${direction}`;
}

/** The key expression a sort orders by (and the cursor compares against). */
export function sortKeySql(sort: WarehouseRegisterSort, alias = "d", locationAlias = "l"): string {
  if (sort === "amount_asc" || sort === "amount_desc") {
    return `COALESCE(${alias}.total_value_rial, 0)`;
  }
  if (sort === "date_asc" || sort === "date_desc") {
    return businessDateSql(alias, locationAlias);
  }
  return `${alias}.created_at`;
}

/** A row as the register reads it — family-specific extras are added by each lister. */
export interface WarehouseRegisterRow {
  /** Family-specific extras (e.g. the F&B supplier) and the pg row shape. */
  [key: string]: unknown;
  id: string;
  kind: string;
  location_id: string;
  location_name: string;
  /** The branch's IANA zone — timestamps on screen are shown in it. */
  location_timezone: string;
  recipient: string | null;
  supplier_name?: string | null;
  document_number: string | null;
  internal_voucher_number: string | null;
  voucher_number: string | null;
  business_date: string;
  reversed_of: string | null;
  is_reversal: boolean;
  created_by_name: string | null;
  note: string | null;
  total_value_rial: string;
  created_at: string;
  line_count: number;
  /** The row's own sort key (text) — what the next page's cursor compares to. */
  sort_key: string;
}

/**
 * The export's columns — the screen's shape, in the same order, with the money
 * columns labelled in the business's display unit and dates Jalali (the shared
 * exporter renders a `Date` that way). An export that did not look like the
 * screen it came from would just be a second, silent report.
 */
export function registerExportTable(
  rows: WarehouseRegisterRow[],
  unitLabel: string,
  format: "csv" | "xlsx",
  helpers: {
    toDisplayAmount: (rial: string, format: "csv" | "xlsx") => string | number;
    formatDate: (businessDate: string) => string;
    kindLabel: (kind: string) => string;
  },
): { columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number>> } {
  return {
    columns: [
      { key: "voucher", label: "شماره انبار" },
      { key: "date", label: "تاریخ سند" },
      { key: "kind", label: "نوع" },
      { key: "location", label: "انبار" },
      { key: "party", label: "طرف‌حساب" },
      { key: "lines", label: "اقلام" },
      { key: "amount", label: `مبلغ (${unitLabel})` },
      { key: "actor", label: "ثبت‌کننده" },
      { key: "reversal", label: "برگشت" },
      { key: "note", label: "یادداشت" },
    ],
    rows: rows.map((row) => ({
      voucher: row.voucher_number ?? "",
      date: helpers.formatDate(row.business_date),
      kind: helpers.kindLabel(row.kind),
      location: row.location_name,
      party: (row.kind === "receipt" ? (row.supplier_name ?? "") : (row.recipient ?? "")) || "",
      lines: row.line_count,
      amount: helpers.toDisplayAmount(row.total_value_rial, format),
      actor: row.created_by_name ?? "",
      reversal: row.is_reversal ? `برگشتِ ${row.reversed_of ?? ""}` : "",
      note: row.note ?? "",
    })),
  };
}

/** What a validated `GET /…/warehouse-documents?…` means. */
export interface ParsedWarehouseRegisterQuery {
  filters: WarehouseRegisterFilters;
  sort: WarehouseRegisterSort;
  limit: number;
  cursor: WarehouseRegisterCursor | null;
  format: "csv" | "xlsx" | null;
}

export type WarehouseRegisterQueryError =
  | "invalid_date"
  | "bad_request"
  | "invalid_cursor"
  | "invalid_amount_range"
  | "unknown_creator";

/**
 * Validate the register's query string.
 *
 * Every rejection is a typed code the route turns into a 400/404 — the client
 * never gets to hand a raw string to SQL, and a filter that cannot mean
 * anything (a negative amount, a range whose floor is above its ceiling, a
 * non-uuid creator) is refused rather than silently ignored, because "showed
 * everything" is indistinguishable from "the filter did nothing".
 */
export function parseWarehouseRegisterQuery(
  url: URL,
  opts: {
    isKind: (value: string) => boolean;
    isUuid: (value: string) => boolean;
  },
): ParsedWarehouseRegisterQuery | { error: WarehouseRegisterQueryError } {
  const params = url.searchParams;
  const filters: WarehouseRegisterFilters = {};

  const kind = params.get("kind");
  if (kind !== null && kind !== "") {
    if (!opts.isKind(kind)) return { error: "bad_request" };
    filters.kind = kind;
  }

  const search = (params.get("search") ?? "").trim();
  if (search) filters.search = search;

  const dateFrom = params.get("dateFrom") || undefined;
  const dateTo = params.get("dateTo") || undefined;
  if (dateFrom !== undefined) {
    if (!ISO_DATE_RE.test(dateFrom) || !isRealDate(dateFrom)) return { error: "invalid_date" };
    filters.dateFrom = dateFrom;
  }
  if (dateTo !== undefined) {
    if (!ISO_DATE_RE.test(dateTo) || !isRealDate(dateTo)) return { error: "invalid_date" };
    filters.dateTo = dateTo;
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    return { error: "invalid_date" };
  }

  const amountMin = normaliseAmount(params.get("amountMin"));
  const amountMax = normaliseAmount(params.get("amountMax"));
  if (amountMin === "invalid" || amountMax === "invalid") return { error: "bad_request" };
  if (amountMin && amountMax && BigInt(amountMin) > BigInt(amountMax)) {
    return { error: "invalid_amount_range" };
  }
  if (amountMin) filters.amountMin = amountMin;
  if (amountMax) filters.amountMax = amountMax;

  const createdBy = params.get("createdBy");
  if (createdBy !== null && createdBy !== "") {
    if (!opts.isUuid(createdBy)) return { error: "unknown_creator" };
    filters.createdBy = createdBy;
  }

  const postingState = params.get("postingState");
  if (postingState !== null && postingState !== "") {
    if (!isWarehousePostingState(postingState)) return { error: "bad_request" };
    filters.postingState = postingState;
  }

  const rawSort = params.get("sort");
  const sort: WarehouseRegisterSort =
    rawSort === null || rawSort === "" ? "created_desc" : isWarehouseRegisterSort(rawSort) ? rawSort : "created_desc";

  const rawLimit = Number(params.get("limit") ?? "100");
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 1), 500);

  const rawFormat = params.get("format");
  if (rawFormat !== null && rawFormat !== "" && rawFormat !== "csv" && rawFormat !== "xlsx") {
    return { error: "bad_request" };
  }
  const format = rawFormat === "csv" || rawFormat === "xlsx" ? rawFormat : null;

  const rawCursor = params.get("cursor");
  const cursor = rawCursor ? decodeWarehouseRegisterCursor(rawCursor, sort) : null;
  // A non-empty cursor that does not decode is a caller error, not "page one":
  // silently restarting would repeat rows the caller already rendered.
  if (rawCursor && !cursor) return { error: "invalid_cursor" };

  return { filters, sort, limit, cursor, format };
}

/** Persian digits and thousands separators are what a numeric field submits. */
function normaliseAmount(raw: string | null): string | null | "invalid" {
  if (raw === null) return null;
  const trimmed = raw
    .trim()
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[,٬\s]/g, "");
  if (trimmed === "") return null;
  if (!RIAL_RE.test(trimmed)) return "invalid";
  return trimmed;
}

function isRealDate(iso: string): boolean {
  const [year, month, day] = iso.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Every creator who has posted a document in the caller's permitted branches —
 * the register's creator filter.
 *
 * Deliberately not `/api/team`: that endpoint demands `team.view`, and a
 * bookkeeper who may read the register but not the roster must still be able
 * to filter by the people who posted. This answers only "who appears on these
 * vouchers", which is register data the caller can already read — and it is
 * branch-scoped by the caller's permitted set, like the register itself.
 */
export async function listWarehouseDocumentCreators(
  businessId: string,
  locationIds: string[],
  family: WarehouseRegisterFamily,
): Promise<Array<{ id: string; name: string; documentCount: number }>> {
  if (locationIds.length === 0) return [];
  const table = family === "fnb" ? "warehouse_documents" : "retail_warehouse_documents";
  const { rows } = await query<{ id: string; name: string; document_count: number }>(
    `SELECT d.created_by AS id,
            COALESCE(MAX(d.created_by_name), MAX(u.full_name), '—') AS name,
            count(*)::int AS document_count
       FROM ${table} d
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.business_id = $1 AND d.location_id = ANY($2::uuid[]) AND d.created_by IS NOT NULL
      GROUP BY d.created_by
      ORDER BY name`,
    [businessId, locationIds],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, documentCount: row.document_count }));
}
