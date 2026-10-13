/**
 * Phase 43 — running the retail trades' own standard reports.
 *
 * Every report in this file already existed. What did not exist was one way to
 * *run* one: «تطبیق وزنی» was reachable only from the jewellery manager's own
 * tab through `/api/jewelry/reports/weight-counts`, «کالای راکد» only from the
 * warehouse module through `/api/stock/reports`, and neither was visible from
 * «گزارش‌ها» — where an owner goes to look at reports. So a jeweller had two
 * report sections, and neither one was complete.
 *
 * `runTradeReport` is the missing half: given a report key from
 * `STANDARD_REPORTS`, it calls whichever service already computes that answer
 * and returns it under the shape the definition declares. The trade's own
 * routes keep working untouched — this adds a second door onto the same
 * functions, it does not move them — so the manager tabs that read
 * `/api/{trade}/reports` are unaffected.
 *
 * The industry check does not live here: `/api/reports/standard/[key]` resolves
 * the business's industry once and refuses a key the trade does not have
 * (`standardReportsFor`), which is the same gate the list endpoint applies. A
 * report reaching this function has already been proven to belong to the
 * caller's trade.
 */
import { getConsignorSummaries, getConsignorSummaryPage } from "./consignment-service";
import { nearExpiryBatches, nearExpiryBatchesPage } from "./cosmetics-service";
import type { Industry } from "./industries";
import {
  brandSalesAnalysis, brandSalesAnalysisPage,
  repairReport, repairReportPage,
  variantSalesAnalysis, variantSalesAnalysisPage,
  warrantyReport, warrantyReportPage,
  weightReconciliation,
} from "./industry-reports-service";
import {
  vehicleInventoryReport,
  vehicleReservationReport,
  vehicleSalesReport,
} from "./automotive-reports-service";
import { listLayaways, listLayawaysPage } from "./jewelry-flagship-service";
import { deadStockReport, lowStockReport, deadStockReportPage, lowStockReportPage } from "./retail-stock-service";
import type { DateRangeFilters } from "./reports-service";

/**
 * Which `domain_events` prefix a trade's sale events carry. Jewellery and watch
 * are absent on purpose: they sell weighted pieces and serialised units, which
 * write no variant sale event for the analysis to read — and the report is
 * gated to the five trade-goods industries for exactly that reason.
 */
const SALE_EVENT_PREFIX: Partial<Record<Industry, string>> = {
  accessories: "accessory",
  cosmetics: "cosmetic",
  wholesale: "wholesale",
  tools_fittings: "tools",
  haberdashery: "haberdashery",
};

/** How many days without a sale makes stock "dead" — the warehouse module's own default. */
const DEAD_STOCK_DAYS = 90;

export interface TradeReportContext {
  businessId: string;
  /** The branch to report on; a business with no branch yet reports nothing. */
  locationId: string | null;
  industry: Industry;
  filters?: DateRangeFilters;
  /** Today, ISO — passed in rather than read here so a caller can report as of a chosen day. */
  todayIso?: string;
}

/**
 * Runs one trade-shaped standard report and returns its payload, or null when
 * the key is not one of them (the caller then falls through to the ordinary
 * view dump). A business with no branch yet gets each report's empty shape
 * rather than an error: an empty report reads as "nothing yet", which is true,
 * where a 500 would read as "this is broken".
 */
export async function runTradeReport(
  key: string,
  context: TradeReportContext,
): Promise<Record<string, unknown> | null> {
  const { businessId, locationId, industry, filters } = context;
  const from = filters?.dateFrom;
  const to = filters?.dateTo;

  switch (key) {
    case "weight_reconciliation":
      if (!locationId) return { reconciliation: [] };
      return { reconciliation: await weightReconciliation(locationId) };

    case "consignor_statements": {
      const summaries = await getConsignorSummaries(businessId);
      return { summaries, summary: {
        count: summaries.length,
        balance: summaries.reduce((sum, r) => sum + r.balance, 0),
        totalOwed: summaries.reduce((sum, r) => sum + r.totalOwed, 0),
        totalPaid: summaries.reduce((sum, r) => sum + r.totalPaid, 0),
      } };
    }

    case "layaway_book": {
      if (!locationId) return { rows: [], book: null };
      const { rows, book } = await listLayaways(businessId, locationId);
      return { rows, book };
    }

    case "warranty_register":
      if (!locationId) return { rows: [], counts: {} };
      return warrantyReport(locationId, { asOfDate: to }).then((report) => ({ ...report, totalCount: report.rows.length }));

    case "repair_profitability":
      if (!locationId) return { rows: [], byStatus: {}, totals: { revenue: 0, partsCost: 0, margin: 0 } };
      return repairReport(locationId, { from, to }).then((report) => ({ ...report, totalCount: report.rows.length }));

    case "variant_sales": {
      if (!locationId) return { rows: [] };
      const eventPrefix = SALE_EVENT_PREFIX[industry];
      if (!eventPrefix) return { rows: [] };
      return { rows: await variantSalesAnalysis(businessId, locationId, { from, to, eventPrefix }) };
    }

    case "brand_sales": {
      if (!locationId) return { rows: [] };
      const eventPrefix = SALE_EVENT_PREFIX[industry];
      if (!eventPrefix) return { rows: [] };
      return { rows: await brandSalesAnalysis(businessId, locationId, { from, to, eventPrefix }) };
    }

    case "near_expiry_batches":
      if (!locationId) return { rows: [] };
      return { rows: await nearExpiryBatches(locationId) };

    case "low_stock":
      if (!locationId) return { rows: [] };
      return { rows: await lowStockReport(locationId) };

    // Issue #839 §14 — the dealership's reports. `locationId` null means "every
    // branch", which these reports genuinely support (a dealer with two lots
    // asks for all of them at once); the branch filter is applied when the
    // caller has an active one, exactly as the manager's own screens do.
    case "vehicle_stock_valuation":
      return vehicleInventoryReport(businessId, {
        locationId,
        today: context.todayIso ?? new Date().toISOString().slice(0, 10),
      }) as unknown as Record<string, unknown>;

    case "vehicle_sales_profitability":
      return vehicleSalesReport(businessId, { locationId, dateFrom: from ?? null, dateTo: to ?? null }) as unknown as Record<string, unknown>;

    case "vehicle_reservations":
      return vehicleReservationReport(businessId, {
        locationId,
        today: context.todayIso ?? new Date().toISOString().slice(0, 10),
      }) as unknown as Record<string, unknown>;

    case "dead_stock": {
      if (!locationId) return { rows: [] };
      const today = context.todayIso ?? new Date().toISOString().slice(0, 10);
      const rows = await deadStockReport(locationId, DEAD_STOCK_DAYS, today);
      return { rows, totalCount: rows.length, totalValueRial: rows.reduce((sum, r) => sum + r.valueRial, 0) };
    }

    default:
      return null;
  }
}

/** Same authoritative services, with SQL-bounded detail reads and full rollups.
 * The caller has already validated industry/app/branch access. Weight
 * reconciliation is a fixed purity summary, not an unbounded detail list.
 */
export async function runTradeReportPage(key: string, context: TradeReportContext, page: number) {
  const { businessId, locationId, industry, filters } = context;
  const options = { from: filters?.dateFrom, to: filters?.dateTo, eventPrefix: SALE_EVENT_PREFIX[industry] };
  if (key === "consignor_statements") {
    const r = await getConsignorSummaryPage(businessId, page);
    return { report: { summaries: r.rows, summary: r.summary }, pagination: r.pagination };
  }
  if (!locationId) return null;
  switch (key) {
    case "layaway_book": {
      const r = await listLayawaysPage(businessId, locationId, page);
      return { report: { rows: r.rows, book: r.summary }, pagination: r.pagination };
    }
    case "warranty_register": {
      const r = await warrantyReportPage(locationId, { asOfDate: filters?.dateTo }, page);
      return { report: { rows: r.rows, counts: r.summary, totalCount: r.total }, pagination: r.pagination };
    }
    case "repair_profitability": {
      const r = await repairReportPage(locationId, options, page);
      return { report: { rows: r.rows, ...r.summary, totalCount: r.total }, pagination: r.pagination };
    }
    case "dead_stock": {
      const r = await deadStockReportPage(locationId, DEAD_STOCK_DAYS, context.todayIso ?? new Date().toISOString().slice(0, 10), page);
      return { report: { rows: r.rows, totalCount: r.total, ...r.summary }, pagination: r.pagination };
    }
    case "variant_sales": {
      if (!options.eventPrefix) return null;
      const r = await variantSalesAnalysisPage(businessId, locationId, options, page);
      return { report: { rows: r.rows }, pagination: r.pagination };
    }
    case "brand_sales": {
      if (!options.eventPrefix) return null;
      const r = await brandSalesAnalysisPage(businessId, locationId, options, page);
      return { report: { rows: r.rows }, pagination: r.pagination };
    }
    case "near_expiry_batches": {
      const r = await nearExpiryBatchesPage(locationId, page);
      return { report: { rows: r.rows }, pagination: r.pagination };
    }
    case "low_stock": {
      const r = await lowStockReportPage(locationId, page);
      return { report: { rows: r.rows }, pagination: r.pagination };
    }
    default: return null;
  }
}
