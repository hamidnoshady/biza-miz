// @vitest-environment jsdom

/**
 * Issue #909 item 3b (inventory sub-panel audit) — the items-load failure
 * box's own «تلاش مجدد» called `switchWarehouse(locationId)`, but that
 * function's very first line is `if (next === locationId) return;` — a retry
 * always passes the *current* warehouse, so the guard fired every time and
 * the button did nothing at all. Fixed by giving the retry its own
 * `loadItems()` callback, independent of the warehouse-switch guard.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentFormSection } from "./document-form-section";
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

describe("DocumentFormSection — the items-load retry (issue #909 item 3b)", () => {
  it("actually re-fetches the current warehouse's items instead of doing nothing", async () => {
    let stockLevelsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/inventory/warehouses")) {
          return { ok: true, status: 200, json: async () => ({ warehouses: [warehouse()] }) };
        }
        if (url.startsWith("/api/inventory/stock-levels")) {
          stockLevelsCalls += 1;
          if (stockLevelsCalls === 1) {
            return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
          }
          return { ok: true, status: 200, json: async () => ({ items: [{ id: "item-1", item_name: "روغن زیتون", unit: "kg" }] }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    render(<DocumentFormSection onCreated={() => {}} />);

    const retryButton = await screen.findByRole("button", { name: "تلاش مجدد" });
    expect(stockLevelsCalls).toBe(1);

    fireEvent.click(retryButton);
    await waitFor(() => expect(stockLevelsCalls).toBe(2));
    // The retry succeeded this time, so the failure box (and its button)
    // is gone — before the fix, the click above changed nothing at all and
    // this button would still be on screen with `stockLevelsCalls` stuck at 1.
    await waitFor(() => expect(screen.queryByRole("button", { name: "تلاش مجدد" })).toBeNull());
  });
});
