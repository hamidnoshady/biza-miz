import { describe, expect, it } from "vitest";
import type { ReportConfig } from "@/lib/reports";
import { builderConfigFromState, builderStateFromConfig } from "./report-builder-config";

const FILTER_KEYS = ["status", "order_type"];

describe("report builder config round-trip", () => {
  it("loses no field when a fully-populated report is loaded and saved again", () => {
    const stored: ReportConfig = {
      view: "v_shift_reconciliation",
      metric: "gross_total",
      aggregation: "sum",
      dimension: "staff",
      filters: { dateFrom: "2026-01-01", dateTo: "2026-01-31", equals: { status: "completed" } },
      sort: { by: "metric", dir: "desc" },
      limit: 10,
      visualization: "pie",
    };
    const rebuilt = builderConfigFromState(builderStateFromConfig(stored), FILTER_KEYS);
    expect(rebuilt).toEqual(stored);
  });

  it("keeps a saved report's sort, Top-N and chart", () => {
    // Each of these was dropped by the old loadIntoBuilder/currentConfig pair
    // (issue #819), so a reader's line chart came back as a bar and a Top-N
    // report came back unsorted and unbounded.
    const rebuilt = builderConfigFromState(
      builderStateFromConfig({
        view: "v_sales_by_day",
        metric: "total",
        aggregation: "sum",
        dimension: "day",
        sort: { by: "dimension", dir: "asc" },
        limit: 5,
        visualization: "line",
      }),
      [],
    );
    expect(rebuilt.sort).toEqual({ by: "dimension", dir: "asc" });
    expect(rebuilt.limit).toBe(5);
    expect(rebuilt.visualization).toBe("line");
  });

  it("does not carry a value typed for one source into another source", () => {
    const config = builderConfigFromState(
      {
        view: "v_sales_by_day",
        metric: "total",
        aggregation: "sum",
        dimension: "day",
        dateFrom: "",
        dateTo: "",
        equals: { status: "completed", unknown_key: "x" },
        sortBy: "",
        sortDir: "desc",
        limit: "",
        chartType: "bar",
      },
      FILTER_KEYS,
    );
    expect(config.filters?.equals).toEqual({ status: "completed" });
  });

  it("omits empty filters, sort and limit instead of storing empty strings or NaN", () => {
    const config = builderConfigFromState(
      {
        view: "v_sales_by_day",
        metric: "order_count",
        aggregation: "sum",
        dimension: "day",
        dateFrom: "",
        dateTo: "",
        equals: { status: "" },
        sortBy: "",
        sortDir: "desc",
        limit: "abc",
        chartType: "number",
      },
      FILTER_KEYS,
    );
    expect(config.filters?.equals).toBeUndefined();
    expect(config.sort).toBeUndefined();
    expect(config.limit).toBeUndefined();
    expect(config.visualization).toBe("number");
  });

  it("defaults a report with no stored visualization to a bar chart", () => {
    const state = builderStateFromConfig({
      view: "v_sales_by_day",
      metric: "total",
      aggregation: "sum",
      dimension: "day",
    });
    expect(state.chartType).toBe("bar");
    expect(state.limit).toBe("");
    expect(state.sortBy).toBe("");
  });
});
