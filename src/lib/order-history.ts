import { isUuid } from "./customer-return-domain";
import { isOrderStatus, type OrderStatus } from "./order-read-service";

export const ORDER_HISTORY_PAGE_SIZE = 25;
export const ORDER_HISTORY_MAX_PAGE_SIZE = 100;
export const ORDER_HISTORY_MAX_PAGE = 1_000_000;
export const ORDER_HISTORY_MAX_SEARCH_LENGTH = 200;

export type OrderHistoryType = "dine_in" | "takeaway" | "delivery";
const ORDER_TYPES: readonly OrderHistoryType[] = ["dine_in", "takeaway", "delivery"];

export interface OrderHistoryFilters {
  page: number;
  pageSize: number;
  search: string;
  status: OrderStatus | null;
  type: OrderHistoryType | null;
  tableId: string | null;
  shiftId: string | null;
  from: string | null;
  to: string | null;
}

export type ParseOrderHistoryFiltersResult =
  | { ok: true; filters: OrderHistoryFilters }
  | { ok: false; error: string };

function parsePositiveInteger(raw: string | null, fallback: number, maximum: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return Math.min(value, maximum);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Parse user-controlled history query parameters into a bounded, typed request. */
export function parseOrderHistoryFilters(params: URLSearchParams): ParseOrderHistoryFiltersResult {
  const allowedParameters = new Set(["page", "pageSize", "q", "status", "type", "tableId", "shiftId", "from", "to"]);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowedParameters.has(key) || seen.has(key)) {
      return { ok: false, error: "invalid_history_filter" };
    }
    seen.add(key);
  }

  const page = parsePositiveInteger(params.get("page"), 1, ORDER_HISTORY_MAX_PAGE);
  const pageSize = parsePositiveInteger(params.get("pageSize"), ORDER_HISTORY_PAGE_SIZE, ORDER_HISTORY_MAX_PAGE_SIZE);
  if (page === null || pageSize === null) return { ok: false, error: "invalid_pagination" };

  const search = (params.get("q") ?? "").trim();
  if (search.length > ORDER_HISTORY_MAX_SEARCH_LENGTH) return { ok: false, error: "search_too_long" };

  const rawStatus = params.get("status");
  if (rawStatus && rawStatus !== "all" && !isOrderStatus(rawStatus)) {
    return { ok: false, error: "invalid_status" };
  }
  const rawType = params.get("type");
  if (rawType && rawType !== "all" && !(ORDER_TYPES as readonly string[]).includes(rawType)) {
    return { ok: false, error: "invalid_order_type" };
  }

  const tableId = params.get("tableId") || null;
  const shiftId = params.get("shiftId") || null;
  if (tableId && !isUuid(tableId)) return { ok: false, error: "invalid_table_id" };
  if (shiftId && !isUuid(shiftId)) return { ok: false, error: "invalid_shift_id" };

  const from = params.get("from") || null;
  const to = params.get("to") || null;
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
    return { ok: false, error: "invalid_date_range" };
  }
  if (from && to && from > to) return { ok: false, error: "invalid_date_range" };

  return {
    ok: true,
    filters: {
      page,
      pageSize,
      search,
      status: rawStatus && rawStatus !== "all" ? rawStatus as OrderStatus : null,
      type: rawType && rawType !== "all" ? rawType as OrderHistoryType : null,
      tableId,
      shiftId,
      from,
      to,
    },
  };
}
