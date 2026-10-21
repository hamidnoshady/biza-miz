// @vitest-environment jsdom

/**
 * Issue #909 item 4 — `loadStock()` never blanked `data` before a refetch
 * (the manual «به‌روزرسانی» button already kept levels on screen while in
 * flight), but a refresh that itself failed still unconditionally zeroed a
 * perfectly good, already-loaded stock list. Fixed by only clearing `data`
 * on a genuine first-load failure (nothing shown yet).
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StockSection } from "./stock-section";
import type { Warehouse } from "./warehouses-section";

afterEach(cleanup);

function warehouse(overrides: Partial<Warehouse> = {}): Warehouse {
  return {
    id: "wh-1",
    name: "انبار مرکزی",
    address: null,
    phone: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    item_count: "1",
    stock_value_rial: "0",
    low_stock_count: "0",
    last_movement_at: null,
    suppliers: [],
    ...overrides,
  };
}

function levelsPayload() {
  return {
    locationId: "wh-1",
    items: [
      {
        id: "item-1",
        item_name: "روغن زیتون",
        sku: null,
        unit: "kg",
        quantity: "10",
        reorder_level: "2",
        value_rial: "1000000",
        unit_cost: "100000",
      },
    ],
    totals: { count: 1, lowStockCount: 0, outOfStockCount: 0, totalValueRial: "1000000" },
  };
}

function stubRoutes(onLevels: () => unknown) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/inventory/warehouses")) {
      return { ok: true, status: 200, json: async () => ({ warehouses: [warehouse()] }) };
    }
    if (url.startsWith("/api/inventory/stock-levels")) {
      return onLevels();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("StockSection — a same-scope refresh (issue #909 item 4)", () => {
  it("keeps the levels on screen when the manual refresh itself fails, and still names the failure", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      stubRoutes(() => {
        call += 1;
        if (call === 1) return { ok: true, status: 200, json: async () => levelsPayload() };
        return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
      }),
    );
    render(<StockSection />);
    await screen.findByText("روغن زیتون");

    const refreshButton = screen.getByRole("button", { name: "به‌روزرسانی موجودی" });
    refreshButton.click();
    await waitFor(() => expect(call).toBe(2));
    // Still there — a failed background refresh does not erase good levels.
    expect(screen.getByText("روغن زیتون")).toBeTruthy();
    expect(await screen.findByText(/دوباره تلاش کنید/)).toBeTruthy();
  });

  it("clears the levels on a genuine first-load failure, with nothing to protect yet", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutes(() => ({ ok: false, status: 500, json: async () => ({ error: "server_error" }) })),
    );
    render(<StockSection />);
    expect(await screen.findByText(/دوباره تلاش کنید/)).toBeTruthy();
    expect(screen.queryByText("روغن زیتون")).toBeNull();
  });
});
