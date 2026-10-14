import { toLatinDigits } from "./digits";
import { isValidIsoDate } from "./jalali";
import { normalizePosSearchText } from "./pos-selection";
import { isUuid } from "./uuid";
import type { OrderKind } from "./shift-orders";
import type { OrderStatus } from "./order-read-service";

export const REPORT_ORDER_STATUSES = ["open", "held", "completed", "voided"] as const;
export const REPORT_ORDER_TYPES = ["dine_in", "takeaway", "delivery", "retail"] as const;

export interface ReportOrderFilters {
  /** null means all shifts; undefined preserves the legacy newest-shift default. */
  shiftId?: string | null;
  /**
   * Only orders opened outside every shift window of the branch — website
   * orders, and sales at a branch that does not clock in (audit F18).
   * Implies `shiftId: null`.
   */
  unassigned?: boolean;
  dateFrom?: string;
  dateTo?: string;
  orderNumber?: string;
  customerQuery?: string;
  status?: OrderStatus;
  type?: OrderKind;
  page?: number;
  pageSize?: number;
  /** Branch IANA time zone, supplied by the authenticated route rather than user input. */
  timeZone?: string;
}

export type ParsedReportOrderFilters = ReportOrderFilters & {
  page: number;
  pageSize: number;
};

/** Accepts #۱۲۳۴, 1234 and Arabic-Indic digits without ever converting bigint text to Number. */
export function normalizeReportOrderNumber(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = toLatinDigits(value).trim().replace(/^#\s*/, "");
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, "") : undefined;
}

export function normalizeCustomerQuery(value: string | null | undefined): string | undefined {
  const normalized = normalizePosSearchText(value ?? "");
  return normalized ? normalized.slice(0, 120) : undefined;
}

export function parseReportOrderFilters(params: URLSearchParams):
  | { ok: true; filters: ParsedReportOrderFilters }
  | { ok: false; error: string } {
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to)) || (from && to && from > to)) {
    return { ok: false, error: "invalid_range" };
  }

  const rawShift = params.get("shiftId");
  const unassigned = rawShift === "unassigned";
  const allShifts = params.get("allShifts") === "1" || rawShift === "all" || unassigned;
  if (rawShift && rawShift !== "all" && !unassigned && !isUuid(rawShift)) return { ok: false, error: "invalid_shift" };

  const rawOrder = params.get("orderNumber");
  const orderNumber = normalizeReportOrderNumber(rawOrder);
  if (rawOrder?.trim() && !orderNumber) return { ok: false, error: "invalid_order_number" };

  const status = params.get("status") || undefined;
  if (status && !(REPORT_ORDER_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: "invalid_status" };
  }
  const type = params.get("type") || undefined;
  if (type && !(REPORT_ORDER_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: "invalid_type" };
  }

  const pageRaw = params.get("page");
  const sizeRaw = params.get("pageSize");
  const page = pageRaw ? Number(pageRaw) : 1;
  const pageSize = sizeRaw ? Number(sizeRaw) : 25;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return { ok: false, error: "invalid_pagination" };
  }

  return {
    ok: true,
    filters: {
      shiftId: allShifts ? null : rawShift || undefined,
      ...(unassigned ? { unassigned: true } : {}),
      dateFrom: from,
      dateTo: to,
      orderNumber,
      customerQuery: normalizeCustomerQuery(params.get("customer")),
      status: status as OrderStatus | undefined,
      type: type as OrderKind | undefined,
      page,
      pageSize,
    },
  };
}
