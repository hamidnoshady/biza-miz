import { describe, expect, it } from "vitest";
import { INDUSTRIES } from "./industries";
import {
  buildFoodCostVariance,
  buildReportQuery,
  computeBranchOverviewMetrics,
  groupedStandardReportsFor,
  previousPeriodRange,
  REPORT_GROUP_ORDER,
  REPORT_GROUPS,
  REPORT_VIEWS,
  reportShape,
  reportViewsFor,
  isReportViewAvailableForIndustry,
  STANDARD_REPORTS,
  standardReportsFor,
  validateReportConfig,
  validateReportConfigForIndustry,
  type ReportConfig,
} from "./reports";
import { branchScope, BUSINESS_WIDE_SCOPE } from "./report-scope";

const BIZ = "biz-1";

describe("REPORT_VIEWS whitelist", () => {
  it("every dimension/metric/filter key is unique within its view", () => {
    for (const [name, view] of Object.entries(REPORT_VIEWS)) {
      const dimKeys = view.dimensions.map((d) => d.key);
      expect(new Set(dimKeys).size, `${name} dimensions`).toBe(dimKeys.length);
      const metricKeys = view.metrics.map((m) => m.key);
      expect(new Set(metricKeys).size, `${name} metrics`).toBe(metricKeys.length);
      if (view.filters) {
        const filterKeys = view.filters.map((f) => f.key);
        expect(new Set(filterKeys).size, `${name} filters`).toBe(filterKeys.length);
      }
    }
  });

  it("every date-trunc dimension belongs to a view with a dateColumn", () => {
    for (const view of Object.values(REPORT_VIEWS)) {
      if (view.dimensions.some((d) => d.dateTrunc)) {
        expect(view.dateColumn).not.toBeNull();
      }
    }
  });

  it("only the count aggregation is offered on a column-less metric", () => {
    // count is COUNT(*); every other aggregation interpolates metric.column
    // into SQL, so pairing one with a null column would emit "null".
    for (const [name, view] of Object.entries(REPORT_VIEWS)) {
      for (const metric of view.metrics) {
        if (metric.column === null) {
          expect(metric.aggregations, `${name}.${metric.key}`).toEqual(["count"]);
        }
      }
    }
  });
});

describe("validateReportConfig", () => {
  it("accepts a well-formed config", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig(config)).toEqual([]);
  });

  it("rejects an unknown view", () => {
    const config = { view: "orders", metric: "total", aggregation: "sum", dimension: "day" } as ReportConfig;
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an unknown metric for the view", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "not_a_metric",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an aggregation not supported by the metric", () => {
    const config: ReportConfig = {
      view: "v_staff_performance",
      metric: "avg_ticket",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an unknown dimension for the view", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "item",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects a date-range filter on a view with no date column", () => {
    const config: ReportConfig = {
      view: "v_inventory_valuation",
      metric: "valuation",
      aggregation: "sum",
      dimension: "item",
      filters: { dateFrom: "2026-01-01" },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects dateFrom after dateTo", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "2026-02-01", dateTo: "2026-01-01" },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects a malformed date string", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "01/01/2026" },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects an equals-filter key not declared by the view", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { equals: { not_a_filter: "x" } },
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("accepts a declared equals-filter key", () => {
    const config: ReportConfig = {
      view: "v_ledger_by_account",
      metric: "debit",
      aggregation: "sum",
      dimension: "day",
      filters: { equals: { account_code: "5100" } },
    };
    expect(validateReportConfig(config)).toEqual([]);
  });

  it("rejects unsupported sort and visualization values rather than silently normalizing them", () => {
    const base: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig({ ...base, sort: { by: "sql; drop table" as never, dir: "desc" } })).toContain(
      "ترتیب گزارش نامعتبر است.",
    );
    expect(validateReportConfig({ ...base, sort: { by: "metric", dir: "sideways" as never } })).toContain(
      "ترتیب گزارش نامعتبر است.",
    );
    expect(validateReportConfig({ ...base, visualization: "scatter" as never })).toContain(
      "نوع نمایش گزارش نامعتبر است.",
    );
  });

  it("rejects ISO-shaped dates that are not real calendar dates", () => {
    const base: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig({ ...base, filters: { dateFrom: "2026-02-30" } })).toContain("تاریخ شروع نامعتبر است.");
    expect(validateReportConfig({ ...base, filters: { dateTo: "2026-13-01" } })).toContain("تاریخ پایان نامعتبر است.");
  });

  it("rejects malformed filter containers and non-string equality values", () => {
    const base: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    expect(validateReportConfig({ ...base, filters: [] as never })).toContain("فیلترهای گزارش نامعتبر هستند.");
    expect(validateReportConfig({ ...base, filters: { equals: { status: 3 } as never } })).toContain(
      "مقدار فیلتر «status» نامعتبر است.",
    );
    expect(validateReportConfig(null as never)).toContain("پیکربندی گزارش نامعتبر است.");
  });

  it("rejects a Top-N limit above the engine's bounded maximum", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      limit: 1_001,
    };
    expect(validateReportConfig(config)).toContain("محدودیت تعداد ردیف باید عدد صحیح بین ۱ و 1000 باشد.");
  });

  it("rejects a non-positive limit", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      limit: 0,
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });
});

describe("buildReportQuery", () => {
  it("refuses a missing scope rather than running over every branch (issue #819)", () => {
    const config: ReportConfig = { view: "v_sales_by_day", metric: "total", aggregation: "sum", dimension: "day" };
    // The bypass the audit found was exactly this call shape: a caller that
    // never resolved a branch. A untyped caller must fail loudly.
    expect(() => buildReportQuery(config, BIZ, undefined as never)).toThrow(/missing_report_scope/);
    expect(() => buildReportQuery(config, BIZ, {} as never)).toThrow(/missing_report_scope/);
  });

  it("omits the branch predicate only for the explicitly authorized consolidated scope", () => {
    const config: ReportConfig = { view: "v_sales_by_day", metric: "total", aggregation: "sum", dimension: "day" };
    const wide = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(wide.sql).not.toContain("location_id");
    const branch = buildReportQuery(config, BIZ, branchScope("branch-a"));
    expect(branch.sql).toContain("location_id = $2");
    expect(branch.params).toContain("branch-a");
  });

  it("throws for an invalid config instead of building SQL", () => {
    const config = { view: "nope", metric: "x", aggregation: "sum", dimension: "y" } as ReportConfig;
    expect(() => buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE)).toThrow();
  });

  it("builds a day-bucketed sum query with businessId bound as $1", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    const { sql, params } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(params[0]).toBe(BIZ);
    expect(sql).toContain("FROM v_sales_by_day");
    expect(sql).toContain("business_id = $1");
    expect(sql).toContain("date_trunc('day', sale_date)::date AS dim");
    expect(sql).toContain("sum(total) AS value");
    expect(sql).toContain("GROUP BY date_trunc('day', sale_date)::date");
  });

  it("binds a supplied location after business scope for branch-bound callers", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "2026-01-01", dateTo: "2026-01-31" },
    };
    const { sql, params } = buildReportQuery(config, BIZ, branchScope("location-1"));
    expect(params).toEqual([BIZ, "location-1", "2026-01-01", "2026-01-31"]);
    expect(sql).toContain("business_id = $1");
    expect(sql).toContain("location_id = $2");
    expect(sql).toContain("sale_date >= $3");
    expect(sql).toContain("sale_date <= $4");
  });

  it("builds an entity-dimension query grouping by id + label columns", () => {
    const config: ReportConfig = {
      view: "v_menu_item_performance",
      metric: "quantity",
      aggregation: "sum",
      dimension: "item",
    };
    const { sql } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("item_name AS dim");
    expect(sql).toContain("GROUP BY menu_item_id, item_name");
  });

  it("reports add-on revenue at the modifier grain, filtered by group", () => {
    const config: ReportConfig = {
      view: "v_modifier_performance",
      metric: "revenue",
      aggregation: "sum",
      dimension: "modifier",
      filters: { equals: { group: "grp-1" } },
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql, params } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("FROM v_modifier_performance");
    expect(sql).toContain("modifier_name AS dim");
    expect(sql).toContain("GROUP BY modifier_id, modifier_name");
    expect(sql).toContain("sum(revenue) AS value");
    expect(sql).toContain("modifier_group_id = $2");
    expect(params).toEqual([BIZ, "grp-1"]);
  });

  it("uses COUNT(*) for the count aggregation and ignores the metric column", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "rows",
      aggregation: "count",
      dimension: "day",
    };
    const { sql } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("count(*) AS value");
  });

  it("counts purchases, not purchase lines, via count_distinct", () => {
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "purchase_count",
      aggregation: "count_distinct",
      dimension: "supplier",
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("count(DISTINCT purchase_id) AS value");
    expect(sql).toContain("GROUP BY supplier_id, supplier_name");
  });

  it("reports purchase spend by item, filtered to received purchases", () => {
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "cost",
      aggregation: "sum",
      dimension: "item",
      filters: { dateFrom: "2026-01-01", equals: { status: "received" } },
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql, params } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("FROM v_purchase_summary");
    expect(sql).toContain("sum(cost) AS value");
    expect(sql).toContain("purchase_date >= $2");
    expect(sql).toContain("status = $3");
    expect(params).toEqual([BIZ, "2026-01-01", "received"]);
  });

  it("reports expense totals by expense-account category", () => {
    const config: ReportConfig = {
      view: "v_expense_summary",
      metric: "amount",
      aggregation: "sum",
      dimension: "category",
    };
    expect(validateReportConfig(config)).toEqual([]);
    const { sql } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("FROM v_expense_summary");
    expect(sql).toContain("account_name AS dim");
    expect(sql).toContain("GROUP BY account_id, account_code, account_name");
    expect(sql).toContain("sum(amount) AS value");
  });

  it("rejects an aggregation the metric does not offer", () => {
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "purchase_count",
      aggregation: "sum",
      dimension: "supplier",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
  });

  it("rejects a column-less metric under any aggregation but count", () => {
    // Guards the SQL builder: every aggregation except count interpolates
    // metric.column, so a null column would emit the literal string "null".
    const config: ReportConfig = {
      view: "v_purchase_summary",
      metric: "rows",
      aggregation: "count_distinct",
      dimension: "supplier",
    };
    expect(validateReportConfig(config).length).toBeGreaterThan(0);
    expect(() => buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE)).toThrow(/invalid_report_config/);
  });

  it("binds date-range filters as parameters, in order, after businessId", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
      filters: { dateFrom: "2026-01-01", dateTo: "2026-01-31" },
    };
    const { sql, params } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(params).toEqual([BIZ, "2026-01-01", "2026-01-31"]);
    expect(sql).toContain("sale_date >= $2");
    expect(sql).toContain("sale_date <= $3");
  });

  it("binds an equals filter by its declared column, never the raw key", () => {
    const config: ReportConfig = {
      view: "v_ledger_by_account",
      metric: "debit",
      aggregation: "sum",
      dimension: "day",
      filters: { equals: { account_code: "5100" } },
    };
    const { sql, params } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("account_code = $2");
    expect(params).toEqual([BIZ, "5100"]);
  });

  it("applies sort and limit", () => {
    const config: ReportConfig = {
      view: "v_menu_item_performance",
      metric: "quantity",
      aggregation: "sum",
      dimension: "item",
      sort: { by: "metric", dir: "desc" },
      limit: 10,
    };
    const { sql, params } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("ORDER BY value DESC");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([BIZ, 10]);
  });

  it("defaults to ordering by dimension ascending", () => {
    const config: ReportConfig = {
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    };
    const { sql } = buildReportQuery(config, BIZ, BUSINESS_WIDE_SCOPE);
    expect(sql).toContain("ORDER BY dim ASC");
  });
});

describe("STANDARD_REPORTS", () => {
  it("has 32 pre-built reports with unique keys", () => {
    // 18 through Phase 35, plus Phase 36's four CRM reports (acquisition,
    // retention, lifetime value, consent coverage), plus Phase 43's ten
    // retail-trade reports, which moved into the library from the per-trade
    // manager tabs they used to be the only door to.
    expect(STANDARD_REPORTS).toHaveLength(32);
    expect(new Set(STANDARD_REPORTS.map((r) => r.key)).size).toBe(32);
  });

  it("every report declares a group the UI can shelve it under", () => {
    for (const report of STANDARD_REPORTS) {
      expect(REPORT_GROUPS, report.key).toContain(report.group);
    }
  });

  it("every non-null view is a whitelisted reporting view", () => {
    for (const report of STANDARD_REPORTS) {
      if (!report.view) continue;
      expect(REPORT_VIEWS[report.view], report.key).toBeDefined();
    }
  });

  it("every defaultChart config validates cleanly against REPORT_VIEWS", () => {
    for (const report of STANDARD_REPORTS) {
      if (!report.defaultChart) continue;
      expect(validateReportConfig(report.defaultChart.config), report.key).toEqual([]);
    }
  });

  it("profit_and_loss, balance_sheet, cash_flow and food_cost_variance have no generic view (computed separately)", () => {
    const pnl = STANDARD_REPORTS.find((r) => r.key === "profit_and_loss");
    const bs = STANDARD_REPORTS.find((r) => r.key === "balance_sheet");
    const cf = STANDARD_REPORTS.find((r) => r.key === "cash_flow");
    const fcv = STANDARD_REPORTS.find((r) => r.key === "food_cost_variance");
    expect(pnl?.view).toBeNull();
    expect(bs?.view).toBeNull();
    expect(cf?.view).toBeNull();
    expect(fcv?.view).toBeNull();
  });

  it("a report with its own shape computes its own payload, so it declares no view", () => {
    // The inverse matters just as much: a `rows` report MUST have a view, or
    // runStandardReportRows has nothing to dump and throws at request time.
    for (const report of STANDARD_REPORTS) {
      if (reportShape(report) === "rows") {
        expect(report.view, report.key).not.toBeNull();
      } else {
        expect(report.view, report.key).toBeNull();
        expect(report.defaultChart, report.key).toBeNull();
      }
    }
  });
});

describe("standardReportsFor", () => {
  it("gives food service exactly the library it had before the split", () => {
    // The 22 that shipped through Phase 36 — a café's report section must not
    // lose or gain anything from the industry scoping.
    expect(standardReportsFor("food_service")).toHaveLength(22);
  });

  it("keeps the shared reports available to every trade", () => {
    // The finance/CRM/staff core: a jeweller reads a P&L exactly as a café
    // does, so these must never be gated behind a module.
    const shared = [
      "profit_and_loss",
      "balance_sheet",
      "cash_flow",
      "daily_sales_summary",
      "shift_reconciliation",
      "cogs_trend",
      "expenses_by_category",
      "staff_performance",
      "customer_acquisition",
      "customer_retention",
      "customer_lifetime_value",
      "consent_coverage",
    ];
    for (const industry of INDUSTRIES) {
      const keys = standardReportsFor(industry).map((r) => r.key);
      for (const key of shared) expect(keys, `${industry} lost ${key}`).toContain(key);
    }
  });

  it("hides F&B-only reports from the retail trades", () => {
    // Each of these queries a view over tables a shop never writes — a table
    // session, a courier run, a recipe — so it could only ever be empty there.
    const fnbOnly = [
      "table_turnover",
      "delivery_performance",
      "courier_performance",
      "waste_report",
      "food_cost_variance",
      "top_selling_items",
      "top_selling_add_ons",
    ];
    for (const industry of INDUSTRIES) {
      if (industry === "food_service") continue;
      const keys = standardReportsFor(industry).map((r) => r.key);
      for (const key of fnbOnly) expect(keys, `${industry} still sees ${key}`).not.toContain(key);
    }
  });

  it("gives each retail trade its own reports and nobody else's", () => {
    const jewelry = standardReportsFor("jewelry").map((r) => r.key);
    expect(jewelry).toContain("weight_reconciliation");
    expect(jewelry).toContain("layaway_book");
    expect(jewelry).toContain("consignor_statements");
    // Jewellery repairs too (industry-profile gives it the capability).
    expect(jewelry).toContain("warranty_register");
    // …but sells weighted pieces, which write no variant sale event.
    expect(jewelry).not.toContain("variant_sales");
    expect(jewelry).not.toContain("brand_sales");

    const cosmetics = standardReportsFor("cosmetics").map((r) => r.key);
    expect(cosmetics).toContain("brand_sales");
    expect(cosmetics).toContain("near_expiry_batches");
    expect(cosmetics).toContain("variant_sales");
    expect(cosmetics).not.toContain("weight_reconciliation");
    expect(cosmetics).not.toContain("warranty_register");

    const haberdashery = standardReportsFor("haberdashery").map((r) => r.key);
    expect(haberdashery).toContain("variant_sales");
    expect(haberdashery).toContain("low_stock");
    expect(haberdashery).toContain("dead_stock");
    // Batch expiry is a cosmetics capability, not every trade-goods shop's.
    expect(haberdashery).not.toContain("near_expiry_batches");

    // The warehouse reports follow the `stock` module, which F&B has no part
    // of — its equivalent is the recipe-costed inventory store.
    expect(standardReportsFor("food_service").map((r) => r.key)).not.toContain("low_stock");
  });

  it("falls back to food service for a business whose industry could not be read", () => {
    // getBusinessIndustry answers null rather than throwing when RLS hides the
    // row; the caller should see the historical library, not an empty screen.
    expect(standardReportsFor(null)).toEqual(standardReportsFor("food_service"));
    expect(standardReportsFor(undefined)).toEqual(standardReportsFor("food_service"));
  });
});

describe("groupedStandardReportsFor", () => {
  it("shelves every one of a trade's reports and drops the empty groups", () => {
    for (const industry of INDUSTRIES) {
      const groups = groupedStandardReportsFor(industry);
      const flattened = groups.flatMap((group) => group.reports.map((r) => r.key));
      expect(new Set(flattened).size, industry).toBe(flattened.length);
      expect(flattened.sort()).toEqual(standardReportsFor(industry).map((r) => r.key).sort());
      for (const group of groups) expect(group.reports.length, `${industry}/${group.group}`).toBeGreaterThan(0);
    }
  });

  it("orders the groups the same way for every trade", () => {
    // The shelves are a subject, not a trade: an owner who learns where the
    // statements live should find them in the same place in any business.
    for (const industry of INDUSTRIES) {
      const order = groupedStandardReportsFor(industry).map((g) => g.group);
      expect(order, industry).toEqual(REPORT_GROUP_ORDER.filter((g) => order.includes(g)));
    }
  });
});

describe("reportViewsFor", () => {
  it("gives food service the whole whitelist", () => {
    // Every view was written for the F&B schema first; the scoping must not
    // take any of them away from the trade that has all of them.
    expect(reportViewsFor("food_service")).toHaveLength(Object.keys(REPORT_VIEWS).length);
  });

  it("hides the sources whose tables a retail trade never writes", () => {
    const fnbOnly = [
      "v_table_turnover",
      "v_delivery_performance",
      "v_courier_performance",
      "v_menu_item_performance",
      "v_modifier_performance",
      "v_waste_summary",
      "v_production_summary",
    ];
    for (const industry of INDUSTRIES) {
      if (industry === "food_service") continue;
      const keys = reportViewsFor(industry).map((entry) => entry.key);
      for (const key of fnbOnly) expect(keys, `${industry} still offers ${key}`).not.toContain(key);
    }
  });

  it("keeps the cross-trade sources everywhere", () => {
    // The ledger, the day's sales and the customer file exist in every trade,
    // so the builder must be able to build on them anywhere.
    const shared = ["v_sales_by_day", "v_ledger_by_account", "v_customer_value", "v_staff_performance"];
    for (const industry of INDUSTRIES) {
      const keys = reportViewsFor(industry).map((entry) => entry.key);
      for (const key of shared) expect(keys, `${industry} lost ${key}`).toContain(key);
    }
  });

  /**
   * The invariant that matters: the builder and the ready-made library are two
   * halves of one section, so a trade must never be refused a report and then
   * offered the view behind it as a place to rebuild the same empty thing.
   */
  it("offers no source that the trade's own report library has already hidden", () => {
    for (const industry of INDUSTRIES) {
      const offeredViews = new Set(reportViewsFor(industry).map((entry) => entry.key));
      const hiddenReportViews = STANDARD_REPORTS.filter(
        (report) => report.view !== null && !standardReportsFor(industry).includes(report),
      );
      for (const report of hiddenReportViews) {
        // A view may legitimately still be offered if a *different* report the
        // trade does have reads it — so only assert on views no visible report
        // touches.
        const stillReadByAVisibleReport = standardReportsFor(industry).some((r) => r.view === report.view);
        if (stillReadByAVisibleReport) continue;
        expect(offeredViews, `${industry}: ${report.key}'s view ${report.view} is still offered`).not.toContain(
          report.view,
        );
      }
    }
  });

  it("rejects a structurally valid but cross-trade config at request boundaries", () => {
    const view = REPORT_VIEWS.v_menu_item_performance;
    const metric = view.metrics[0];
    const config: ReportConfig = {
      view: "v_menu_item_performance",
      metric: metric.key,
      aggregation: metric.aggregations[0],
      dimension: view.dimensions[0].key,
    };
    expect(validateReportConfig(config)).toEqual([]);
    expect(isReportViewAvailableForIndustry(config.view, "food_service")).toBe(true);
    expect(isReportViewAvailableForIndustry(config.view, "jewelry")).toBe(false);
    expect(validateReportConfigForIndustry(config, "food_service")).toEqual([]);
    expect(validateReportConfigForIndustry(config, "jewelry")).toContain(
      "منبع داده برای صنف فعلی کسب‌وکار در دسترس نیست.",
    );
  });

  it("falls back to food service for an unreadable industry", () => {
    expect(reportViewsFor(null)).toEqual(reportViewsFor("food_service"));
    expect(reportViewsFor(undefined)).toEqual(reportViewsFor("food_service"));
  });
});

describe("buildFoodCostVariance", () => {
  it("uses full-source theoretical cost for a SQL detail page without changing line ratios", () => {
    const items = [
      { menuItemId: "a", menuItemName: "A", unitsSold: 1, theoreticalCost: 100, revenue: 500 },
      { menuItemId: "b", menuItemName: "B", unitsSold: 1, theoreticalCost: 900, revenue: 1000 },
    ];
    const full = buildFoodCostVariance(items, 1200, 50);
    const page = buildFoodCostVariance(items.slice(0, 1), 1200, 50, { theoreticalCost: 1000 });
    expect(page).toEqual({ ...full, items: [full.items.find((i) => i.menuItemId === "a")] });
  });

  it("computes each item's food-cost % and sorts worst (highest %) first", () => {
    const result = buildFoodCostVariance(
      [
        { menuItemId: "a", menuItemName: "اسپرسو", unitsSold: 10, theoreticalCost: 100_000, revenue: 500_000 },
        { menuItemId: "b", menuItemName: "کیک شکلاتی", unitsSold: 5, theoreticalCost: 200_000, revenue: 400_000 },
      ],
      0,
      0,
    );
    expect(result.items.map((i) => i.menuItemId)).toEqual(["b", "a"]);
    expect(result.items[0].foodCostPct).toBeCloseTo(0.5);
    expect(result.items[1].foodCostPct).toBeCloseTo(0.2);
  });

  it("returns a null food-cost % for an item with no revenue, sorted last", () => {
    const result = buildFoodCostVariance(
      [
        { menuItemId: "a", menuItemName: "اسپرسو", unitsSold: 10, theoreticalCost: 100_000, revenue: 500_000 },
        { menuItemId: "b", menuItemName: "بدون فروش", unitsSold: 0, theoreticalCost: 0, revenue: 0 },
      ],
      0,
      0,
    );
    expect(result.items.map((i) => i.menuItemId)).toEqual(["a", "b"]);
    expect(result.items[1].foodCostPct).toBeNull();
  });

  it("sums theoretical cost across items and compares it against actual COGS + waste", () => {
    const result = buildFoodCostVariance(
      [
        { menuItemId: "a", menuItemName: "اسپرسو", unitsSold: 10, theoreticalCost: 100_000, revenue: 500_000 },
        { menuItemId: "b", menuItemName: "کیک شکلاتی", unitsSold: 5, theoreticalCost: 200_000, revenue: 400_000 },
      ],
      330_000,
      20_000,
    );
    expect(result.theoreticalCost).toBe(300_000);
    expect(result.actualCogs).toBe(330_000);
    expect(result.wasteCost).toBe(20_000);
    expect(result.actualTotalCost).toBe(350_000);
    // spent 50,000 more than the recipes predict
    expect(result.variance).toBe(50_000);
    expect(result.variancePct).toBeCloseTo(50_000 / 300_000);
    // of that 50,000, 20,000 is recorded waste — 30,000 is unexplained
    expect(result.unexplainedVariance).toBe(30_000);
  });

  it("returns a null variance % when there's no theoretical cost to compare against", () => {
    const result = buildFoodCostVariance([], 10_000, 0);
    expect(result.theoreticalCost).toBe(0);
    expect(result.variancePct).toBeNull();
  });
});

describe("previousPeriodRange", () => {
  it("shifts back by the same number of days, ending the day before dateFrom", () => {
    expect(previousPeriodRange("2025-04-01", "2025-04-30")).toEqual({
      dateFrom: "2025-03-02",
      dateTo: "2025-03-31",
    });
  });

  it("handles a single-day range", () => {
    expect(previousPeriodRange("2025-04-15", "2025-04-15")).toEqual({
      dateFrom: "2025-04-14",
      dateTo: "2025-04-14",
    });
  });

  it("crosses a year boundary correctly", () => {
    expect(previousPeriodRange("2025-01-01", "2025-01-31")).toEqual({
      dateFrom: "2024-12-01",
      dateTo: "2024-12-31",
    });
  });
});

describe("computeBranchOverviewMetrics", () => {
  it("computes gross profit, margin %, average ticket, and revenue share correctly", () => {
    const row = {
      orderCount: 50,
      total: 10_000_000,
      cogs: 4_000_000,
    };
    const consolidatedTotal = 25_000_000;

    const metrics = computeBranchOverviewMetrics(row, consolidatedTotal);
    expect(metrics.grossProfit).toBe(6_000_000);
    expect(metrics.grossMarginPct).toBe(60);
    expect(metrics.avgTicket).toBe(200_000);
    expect(metrics.revenueSharePct).toBe(40);
  });

  it("safely handles division by zero when orderCount, total, and consolidatedTotal are 0", () => {
    const row = {
      orderCount: 0,
      total: 0,
      cogs: 0,
    };
    const consolidatedTotal = 0;

    const metrics = computeBranchOverviewMetrics(row, consolidatedTotal);
    expect(metrics.grossProfit).toBe(0);
    expect(metrics.grossMarginPct).toBe(0);
    expect(metrics.avgTicket).toBe(0);
    expect(metrics.revenueSharePct).toBe(0);
  });

  it("computes negative profit and margin when cogs exceed total sales", () => {
    const row = {
      orderCount: 10,
      total: 1_000_000,
      cogs: 1_500_000,
    };
    const consolidatedTotal = 2_000_000;

    const metrics = computeBranchOverviewMetrics(row, consolidatedTotal);
    expect(metrics.grossProfit).toBe(-500_000);
    expect(metrics.grossMarginPct).toBe(-50);
    expect(metrics.avgTicket).toBe(100_000);
    expect(metrics.revenueSharePct).toBe(50);
  });
});
