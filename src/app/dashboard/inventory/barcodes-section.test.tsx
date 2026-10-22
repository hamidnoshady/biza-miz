// @vitest-environment jsdom

/**
 * Issue #909 item 3b (inventory sub-panel audit) — `loadBarcodes()` never
 * cleared `barcodes` before a refetch for a *different* item. While the
 * request was in flight the skeleton masked the previous item's list, but a
 * failed fetch for the newly-selected item left the old item's barcodes in
 * state; once `barcodesLoading` flipped back to `false`, the `<ul>` branch
 * rendered the *previous* item's codes as if they belonged to the item now
 * selected. Fixed by clearing `barcodes` immediately on a genuine item
 * switch, the same convention stock-section.tsx/documents-section.tsx use —
 * a same-item reload (after «ثبت»/«تولید بارکد داخلی») is unaffected.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BarcodesSection } from "./barcodes-section";
import type { InventoryItem } from "./inventory-manager";

afterEach(cleanup);

const ITEM_1 = { id: "item-1", name: "روغن زیتون", sku: "OL-1", unit: "kg", is_active: true } as InventoryItem;
const ITEM_2 = { id: "item-2", name: "آرد", sku: "FL-1", unit: "kg", is_active: true } as InventoryItem;

function barcodeRow(id: string, code: string) {
  return { id, inventoryItemId: id, code, symbology: "internal" as const, note: null };
}

/**
 * Opens the item `SearchableSelect` and picks one option by its visible
 * label. The trigger's own accessible text is whichever item is currently
 * selected (or the placeholder before anything is), so it is found by its
 * `aria-haspopup="listbox"` combobox role rather than by that changing text.
 */
async function selectItem(optionName: string) {
  const trigger = document.querySelector('button[aria-haspopup="listbox"]');
  if (!trigger) throw new Error("item combobox trigger not found");
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.click(option);
}

function stubRoutes(onBarcodes: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    if (url === "/api/inventory/barcodes") {
      return { ok: true, status: 200, json: async () => ({ pending: [] }) };
    }
    if (url.startsWith("/api/inventory/barcodes?")) {
      return onBarcodes(url);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("BarcodesSection — a changed scope (switching the selected item) must not keep showing the old item's barcodes", () => {
  it("clears item-1's codes immediately on switching to item-2, and does not reveal them again when item-2's own load fails", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutes((url) =>
        url.includes("item-1")
          ? { ok: true, status: 200, json: async () => ({ barcodes: [barcodeRow("b1", "1111111111111")] }) }
          : { ok: false, status: 500, json: async () => ({ message: "خطا در دریافت بارکدهای قلم." }) },
      ),
    );
    render(<BarcodesSection items={[ITEM_1, ITEM_2]} busy={false} />);

    await selectItem(`${ITEM_1.name} (${ITEM_1.unit})`);
    expect(await screen.findByText("1111111111111")).toBeTruthy();

    await selectItem(`${ITEM_2.name} (${ITEM_2.unit})`);
    // The failed load for item-2 must not leave item-1's code on screen
    // mislabeled as item-2's, nor keep rendering it once loading settles.
    await waitFor(() => expect(screen.getByText("خطا در دریافت بارکدهای قلم.")).toBeTruthy());
    expect(screen.queryByText("1111111111111")).toBeNull();
  });

  it("switches cleanly between two items that both load successfully — each shows only its own codes, never the other's", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutes((url) =>
        url.includes("item-1")
          ? { ok: true, status: 200, json: async () => ({ barcodes: [barcodeRow("b1", "1111111111111")] }) }
          : { ok: true, status: 200, json: async () => ({ barcodes: [barcodeRow("b2", "2222222222222")] }) },
      ),
    );
    render(<BarcodesSection items={[ITEM_1, ITEM_2]} busy={false} />);

    await selectItem(`${ITEM_1.name} (${ITEM_1.unit})`);
    expect(await screen.findByText("1111111111111")).toBeTruthy();

    await selectItem(`${ITEM_2.name} (${ITEM_2.unit})`);
    expect(await screen.findByText("2222222222222")).toBeTruthy();
    expect(screen.queryByText("1111111111111")).toBeNull();

    await selectItem(`${ITEM_1.name} (${ITEM_1.unit})`);
    expect(await screen.findByText("1111111111111")).toBeTruthy();
    expect(screen.queryByText("2222222222222")).toBeNull();
  });
});
