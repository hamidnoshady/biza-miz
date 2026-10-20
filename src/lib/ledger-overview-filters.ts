/**
 * The Accounting Overview's shareable filter state (#912 item 13).
 *
 * Two independent, explicitly-labeled scopes:
 *   - `asOf` — the business-local *document date* the balance-sheet tiles are
 *     read at (entries with `entry_date > asOf` never count as "current").
 *     Absent means "the business's today", resolved server-side.
 *   - `period` — the fiscal period the P&L tiles describe: `auto` (the fiscal
 *     year covering `asOf`, the historical default), `all` (every operational
 *     period, closing entries excluded), or one fiscal year's id.
 *
 * Branch is deliberately absent: `ledger.view` is documented business-wide
 * visibility (see docs/accounting-overview-kpis.md), so there is no branch
 * filter to persist. One parser serves the address bar, the API query and
 * the route, so a shared link and the request it produces cannot drift.
 */
import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";

export interface LedgerOverviewFilters {
  /** ISO `YYYY-MM-DD`, or null for the business-local today. */
  asOf: string | null;
  /** `"auto"`, `"all"`, or a fiscal-year id. */
  period: string;
}

export const DEFAULT_LEDGER_OVERVIEW_FILTERS: LedgerOverviewFilters = {
  asOf: null,
  period: "auto",
};

export interface ParsedLedgerOverviewFilters {
  filters: LedgerOverviewFilters;
  /** Raw values that were dropped as invalid, so the UI can say so once. */
  droppedInvalid: boolean;
}

export function parseLedgerOverviewFilters(
  params: URLSearchParams,
): ParsedLedgerOverviewFilters {
  let droppedInvalid = false;

  const rawAsOf = params.get("asOf");
  let asOf: string | null = null;
  if (rawAsOf) {
    if (isValidIsoDate(rawAsOf)) asOf = rawAsOf;
    else droppedInvalid = true;
  }

  const rawPeriod = params.get("period");
  let period = "auto";
  if (rawPeriod) {
    if (rawPeriod === "auto" || rawPeriod === "all" || isUuid(rawPeriod)) {
      period = rawPeriod;
    } else {
      droppedInvalid = true;
    }
  }

  return { filters: { asOf, period }, droppedInvalid };
}

/** The API query for a selection — only the parts that narrow anything. */
export function ledgerOverviewApiQuery(filters: LedgerOverviewFilters): string {
  const params = new URLSearchParams();
  if (filters.asOf) params.set("asOf", filters.asOf);
  if (filters.period === "all") params.set("fiscalYear", "all");
  else if (filters.period !== "auto") params.set("fiscalYear", filters.period);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Address-bar params for a selection — defaults stay out of shared links. */
export function ledgerOverviewUrlParams(
  filters: LedgerOverviewFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.asOf) params.set("asOf", filters.asOf);
  if (filters.period !== "auto") params.set("period", filters.period);
  return params;
}

export function isDefaultLedgerOverviewFilters(
  filters: LedgerOverviewFilters,
): boolean {
  return filters.asOf === null && filters.period === "auto";
}
