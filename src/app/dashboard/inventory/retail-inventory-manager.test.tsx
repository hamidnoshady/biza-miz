// @vitest-environment jsdom

/**
 * Issue #909 item 4 — `loadItems()` in retail-inventory-manager.tsx fetches
 * the count-section's item list and reruns both after a warehouse document is
 * posted (`DocumentFormSection`'s `onCreated`, which may fire while the user
 * is on another tab) and from the count section's own `reload`. Its
 * failure/catch branches unconditionally zeroed `countItems`, so a refresh
 * that itself failed erased an already-loaded item list the «انبارگردانی»
 * count section may be mid-way through.
 *
 * Child sections (`DocumentFormSection`, `StockCountSection`, etc.) are
 * stubbed so the test exercises only `RetailInventoryManager`'s own
 * load/refresh-safety logic, not each child's full form.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../stock/warehouses-section", () => ({
  AddWarehouseSection: () => null,
  WarehouseListSection: () => null,
}));
vi.mock("../stock/document-form-section", () => ({
  DocumentFormSection: ({ onCreated }: { onCreated?: () => void }) => (
    <button type="button" onClick={onCreated}>ثبت سند آزمایشی</button>
  ),
}));
vi.mock("../stock/documents-section", () => ({ DocumentsSection: () => null }));
vi.mock("../stock/stock-levels-section", () => ({ StockLevelsSection: () => null }));
vi.mock("../stock/purchases-section", () => ({ PurchasesSection: () => null }));
vi.mock("../stock/returns-section", () => ({ ReturnsSection: () => null }));
vi.mock("../stock/reports-section", () => ({ ReportsSection: () => null }));
vi.mock("../stock/stock-count-section", () => ({
  StockCountSection: ({
    items,
    reload,
  }: {
    items: { id: string; name: string; quantity: string }[];
    reload: () => void;
  }) => (
    <>
      <button type="button" onClick={reload}>بازخوانی آزمایشی</button>
      <ul>
        {items.map((i) => (
          <li key={i.id}>{i.name}</li>
        ))}
      </ul>
    </>
  ),
}));

import { RetailInventoryManager } from "./retail-inventory-manager";

afterEach(cleanup);

// jsdom has no layout engine: section-nav.tsx scrolls its root into view on
// a tab switch, which jsdom's Element doesn't implement at all.
Element.prototype.scrollIntoView = vi.fn();

function goToCountsTab() {
  fireEvent.click(screen.getByRole("button", { name: "انبارگردانی" }));
}

describe("RetailInventoryManager — a same-scope refresh (issue #909 item 4)", () => {
  it("keeps the count section's item list on screen when its own reload fails", async () => {
    let getCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/stock/items") {
          getCall += 1;
          if (getCall === 1) {
            return { ok: true, status: 200, json: async () => ({ items: [{ id: "item-1", name: "روغن", quantity: "5" }] }) };
          }
          return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    render(<RetailInventoryManager />);
    goToCountsTab();
    await screen.findByText("روغن");

    // The count section itself reruns loadItems() after a posted count (same `reload` prop).
    fireEvent.click(screen.getByRole("button", { name: "بازخوانی آزمایشی" }));
    await waitFor(() => expect(getCall).toBe(2));

    // Still there — a reload that fails after a successful first load does not erase a good list.
    expect(screen.getByText("روغن")).toBeTruthy();
  });

  it("clears to an empty, retryable state on a genuine first-load failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/stock/items") return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    render(<RetailInventoryManager />);
    goToCountsTab();
    expect(await screen.findByRole("button", { name: "تلاش دوباره برای دریافت اقلام" })).toBeTruthy();
    expect(screen.queryByText("روغن")).toBeNull();
  });
});
