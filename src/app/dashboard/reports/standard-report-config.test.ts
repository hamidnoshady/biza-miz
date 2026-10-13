import { describe, expect, it } from "vitest";
import {
  COMPARABLE_SHAPES,
  DOCUMENT_SHAPES,
  canToggleBusinessWideScope,
  EXPORT_KIND_BY_SHAPE,
  SNAPSHOT_SHAPES,
  UNDATED_SHAPES,
  comparisonReady,
  configWithRange,
  errorMessage,
  isInvalidRange,
} from "./standard-report-config";
import { REPORT_VIEWS, STANDARD_REPORTS, reportConfigIsMoney, reportShape } from "@/lib/reports";

describe("configWithRange", () => {
  it("keeps the report's own equals filter when a date range is applied", () => {
    // The regression that motivated this module: «روند بهای تمام‌شده کالا» is
    // the ledger view narrowed to the COGS account. Overwriting `filters` with
    // just the dates turned it into "every debit in the ledger" — a wrong
    // number that still drew a perfectly plausible curve.
    const cogs = STANDARD_REPORTS.find((report) => report.key === "cogs_trend");
    expect(cogs?.defaultChart?.config.filters?.equals).toBeDefined();

    // `{...config}` is what the client actually holds: the server's typed
    // `ReportConfig` after a JSON round-trip through /api/reports/standard.
    const merged = configWithRange({ ...cogs!.defaultChart!.config }, "2024-01-01", "2024-03-31");

    expect(merged.filters?.equals).toEqual(cogs!.defaultChart!.config.filters!.equals);
    expect(merged.filters?.dateFrom).toBe("2024-01-01");
    expect(merged.filters?.dateTo).toBe("2024-03-31");
  });

  it("keeps the equals filter when no range is picked at all", () => {
    const merged = configWithRange(
      { view: "v_ledger_by_account", filters: { equals: { account_code: "5100" } } },
      "",
      "",
    );
    expect(merged.filters).toEqual({ equals: { account_code: "5100" } });
  });

  it("applies one end of the range without inventing the other", () => {
    const merged = configWithRange({ view: "v_sales_by_day" }, "2024-05-01", "");
    expect(merged.filters).toEqual({ dateFrom: "2024-05-01" });
    // An explicit `dateTo: undefined` would serialize away, but an empty
    // `filters` object shipped for a report that had a real filter is exactly
    // how the original bug hid itself.
    expect(JSON.stringify(merged)).not.toContain("dateTo");
  });

  it("leaves filters absent when there is nothing to filter by", () => {
    const merged = configWithRange({ view: "v_sales_by_day", metric: "total" }, "", "");
    expect("filters" in merged).toBe(false);
    expect(merged.view).toBe("v_sales_by_day");
  });

  it("preserves every other config key", () => {
    const merged = configWithRange(
      { view: "v_menu_item_performance", metric: "revenue", limit: 10, sort: { by: "metric", dir: "desc" } },
      "2024-01-01",
      "",
    );
    expect(merged.limit).toBe(10);
    expect(merged.sort).toEqual({ by: "metric", dir: "desc" });
  });

  it("does not mutate the report definition it was handed", () => {
    // `selected.config` is shared state held for the lifetime of the section;
    // mutating it would leak one report's dates into the next read.
    const config = { view: "v_ledger_by_account", filters: { equals: { account_code: "5100" } } };
    configWithRange(config, "2024-01-01", "2024-02-01");
    expect(config.filters).toEqual({ equals: { account_code: "5100" } });
  });

  it("tolerates a report with no config", () => {
    expect(configWithRange(null, "2024-01-01", "2024-02-01")).toEqual({
      filters: { dateFrom: "2024-01-01", dateTo: "2024-02-01" },
    });
  });
});

describe("errorMessage", () => {
  it("tells a blocked user what to do instead of asking them to retry", () => {
    expect(errorMessage(403)).toContain("دسترسی");
    expect(errorMessage(404)).toContain("تعریف نشده");
    expect(errorMessage(401)).toContain("وارد شوید");
  });

  it("distinguishes a server fault from a bad request", () => {
    expect(errorMessage(500)).not.toBe(errorMessage(400));
    expect(errorMessage(503)).toBe(errorMessage(500));
  });

  it("never returns an empty string", () => {
    for (const status of [200, 400, 401, 403, 404, 418, 500, 502]) {
      expect(errorMessage(status).length).toBeGreaterThan(0);
    }
  });
});

describe("comparisonReady", () => {
  it("needs both ends of the range for a period statement", () => {
    expect(comparisonReady("profit_and_loss", "", "")).toBe(false);
    expect(comparisonReady("profit_and_loss", "2024-01-01", "")).toBe(false);
    expect(comparisonReady("cash_flow", "2024-01-01", "2024-03-31")).toBe(true);
  });

  it("lets a balance sheet be ticked first — it collects its comparison date after", () => {
    expect(comparisonReady("balance_sheet", "", "")).toBe(true);
  });

  it("is false for every shape that has no comparison endpoint", () => {
    // food_cost_variance in particular: the API ignores `?compare=1` for it, so
    // offering the checkbox would be a control that provably does nothing.
    expect(comparisonReady("food_cost_variance", "2024-01-01", "2024-03-31")).toBe(false);
    expect(comparisonReady("rows", "2024-01-01", "2024-03-31")).toBe(false);
    expect(comparisonReady("warranty", "2024-01-01", "2024-03-31")).toBe(false);
  });
});

describe("isInvalidRange", () => {
  it("catches a backwards range", () => {
    expect(isInvalidRange("rows", "2024-03-31", "2024-01-01")).toBe(true);
  });

  it("accepts an equal pair — a single day is a legitimate range", () => {
    expect(isInvalidRange("rows", "2024-03-31", "2024-03-31")).toBe(false);
  });

  it("ignores a half-filled range", () => {
    expect(isInvalidRange("rows", "2024-03-31", "")).toBe(false);
    expect(isInvalidRange("rows", "", "2024-01-01")).toBe(false);
  });

  it("does not apply to a snapshot, whose earlier date is the comparison date", () => {
    expect(isInvalidRange("balance_sheet", "2023-12-31", "2024-12-31")).toBe(false);
  });
});

describe("business-wide scope controls", () => {
  it("matches the canonical allowlist and still requires the elevated capability", () => {
    expect(canToggleBusinessWideScope("food_cost_variance", true)).toBe(true);
    expect(canToggleBusinessWideScope("profit_and_loss", true)).toBe(true);
    expect(canToggleBusinessWideScope("daily_sales_summary", true)).toBe(false);
    expect(canToggleBusinessWideScope("food_cost_variance", false)).toBe(false);
  });
});

describe("shape tables", () => {
  it("only marks shapes the export API actually knows", () => {
    for (const shape of Object.keys(EXPORT_KIND_BY_SHAPE)) {
      expect(DOCUMENT_SHAPES.has(shape as never)).toBe(true);
    }
  });

  it("treats every comparable and undated shape as a document", () => {
    for (const shape of [...COMPARABLE_SHAPES, ...UNDATED_SHAPES, ...SNAPSHOT_SHAPES]) {
      expect(DOCUMENT_SHAPES.has(shape)).toBe(true);
    }
  });

  it("never asks for a date range and a snapshot date at once", () => {
    for (const shape of SNAPSHOT_SHAPES) {
      expect(UNDATED_SHAPES.has(shape)).toBe(false);
    }
  });

  it("covers every shape the report library can actually produce", () => {
    // If a new trade report lands without being listed here it falls through to
    // the row-dump path and posts a `view: null` config to /api/reports/query.
    for (const report of STANDARD_REPORTS) {
      const shape = reportShape(report);
      if (shape === "rows") {
        expect(report.defaultChart?.config.view).toBeTruthy();
      } else {
        expect(DOCUMENT_SHAPES.has(shape)).toBe(true);
      }
    }
  });
});

describe("money metrics", () => {
  it("marks the currency metrics and leaves counts alone", () => {
    const sales = REPORT_VIEWS.v_sales_by_day!;
    expect(sales.metrics.find((m) => m.key === "total")?.money).toBe(true);
    expect(sales.metrics.find((m) => m.key === "orders")?.money).toBeFalsy();
  });

  it("never marks a row-count metric, which has no column to be money", () => {
    for (const view of Object.values(REPORT_VIEWS)) {
      for (const metric of view.metrics) {
        if (metric.column === null) expect(metric.money).toBeFalsy();
      }
    }
  });

  it("reads a config as money only when the aggregation preserves the unit", () => {
    const base = { view: "v_sales_by_day", metric: "total" };
    expect(reportConfigIsMoney({ ...base, aggregation: "sum" })).toBe(true);
    expect(reportConfigIsMoney({ ...base, aggregation: "avg" })).toBe(true);
    // Counting how many rows had a `total` is a count, not an amount.
    expect(reportConfigIsMoney({ ...base, aggregation: "count" })).toBe(false);
    expect(reportConfigIsMoney({ ...base, aggregation: "count_distinct" })).toBe(false);
  });

  it("answers false rather than throwing for an unknown view or metric", () => {
    expect(reportConfigIsMoney({ view: "v_nope", metric: "total", aggregation: "sum" })).toBe(false);
    expect(reportConfigIsMoney({ view: "v_sales_by_day", metric: "nope", aggregation: "sum" })).toBe(false);
    expect(reportConfigIsMoney(null)).toBe(false);
    expect(reportConfigIsMoney({})).toBe(false);
  });

  it("classifies every standard chart report", () => {
    // Guards the case that produced the original bug: a money report rendering
    // raw Rial to a business that displays Toman.
    const revenue = STANDARD_REPORTS.find((r) => r.key === "daily_sales_summary");
    expect(reportConfigIsMoney(revenue?.defaultChart?.config)).toBe(true);
  });
});
