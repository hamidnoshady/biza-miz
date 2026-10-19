import { isValidIsoDate } from "./iso-date";

function purchaseDateOrNull(value: string | null): string | null {
  if (!value) return null;
  if (!isValidIsoDate(value)) throw new Error("invalid_date");
  return value;
}
import { retailUuid } from "./retail-purchase-input";

export const PURCHASE_HISTORY_PAGE_SIZE = 25;
export function purchaseHistoryInput(params: URLSearchParams, statuses: readonly string[]) {
  const pageText = params.get("page") ?? "1";
  if (!/^[1-9]\d{0,5}$/.test(pageText)) throw new Error("invalid_page");
  const page = Number(pageText);
  const status = params.get("status") || null;
  if (status && !statuses.includes(status)) throw new Error("invalid_status");
  const supplierId = params.get("supplierId") ? retailUuid(params.get("supplierId")) : null;
  const dateFrom = purchaseDateOrNull(params.get("dateFrom"));
  const dateTo = purchaseDateOrNull(params.get("dateTo"));
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error("invalid_date_range");
  const search = (params.get("q") ?? "").trim();
  if (search.length > 200) throw new Error("invalid_search");
  return { page, offset: (page - 1) * PURCHASE_HISTORY_PAGE_SIZE, status, supplierId, dateFrom, dateTo, search };
}
