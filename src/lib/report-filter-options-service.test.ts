import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "./db";
import { reportFilterOptions } from "./report-filter-options-service";

vi.mock("./db", () => ({ query: vi.fn() }));

const DYNAMIC_SOURCES = [
  { view: "v_menu_item_performance", filter: "category", table: "menu_categories", params: ["business-1", "location-1"] },
  { view: "v_modifier_performance", filter: "group", table: "modifier_groups", params: ["business-1", "location-1"] },
  { view: "v_purchase_summary", filter: "supplier", table: "suppliers", params: ["business-1", "location-1"] },
  { view: "v_ledger_by_account", filter: "account_code", table: "accounts", params: ["business-1", null] },
  { view: "v_expense_summary", filter: "account_code", table: "accounts", params: ["business-1", "expense"] },
] as const;

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(query).mockResolvedValue({
    rows: [{ value: "entity-1", label: "گزینهٔ آزمایشی" }],
    rowCount: 1,
  } as never);
});

describe("reportFilterOptions", () => {
  it.each(DYNAMIC_SOURCES)("loads $view options using fixed $table mapping and authorized scope", async ({ view, filter, table, params }) => {
    const options = await reportFilterOptions("business-1", "location-1", view);
    expect(options[filter]).toEqual([{ value: "entity-1", label: "گزینهٔ آزمایشی" }]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = vi.mocked(query).mock.calls[0];
    expect(String(sql)).toContain(`FROM ${table}`);
    expect(values).toEqual(params);
    if (table !== "accounts") {
      expect(String(sql)).toContain("l.business_id = $1 AND l.id = $2");
    } else {
      expect(String(sql)).toContain("a.business_id = $1");
    }
  });

  it("serves canonical enum options without a database query", async () => {
    const options = await reportFilterOptions("business-1", "location-1", "v_delivery_performance");
    expect(options.status).toEqual(expect.arrayContaining([
      { value: "pending", label: "در انتظار" },
      { value: "delivered", label: "تحویل‌شده" },
    ]));
    expect(query).not.toHaveBeenCalled();
  });

  it("returns no choices for an unknown view and never executes client-selected SQL", async () => {
    await expect(reportFilterOptions("business-1", "location-1", "dashboard_widgets; DROP TABLE accounts"))
      .resolves.toEqual({});
    expect(query).not.toHaveBeenCalled();
  });
});
