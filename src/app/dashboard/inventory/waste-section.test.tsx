// @vitest-environment jsdom

/**
 * Issue #909 item 4 — `loadEntries()` in waste-section.tsx («ضایعات») ran
 * after every successful submission and from its own «تلاش دوباره» button,
 * but its failure branch unconditionally zeroed `entries` and the render
 * then replaced the whole list with a retry prompt — so a refresh that
 * itself failed erased an already-shown, perfectly good waste history.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem, Runner } from "./food-service-inventory-manager";
import { WasteSection } from "./waste-section";

afterEach(cleanup);

const ITEM: InventoryItem = {
  id: "item-1",
  name: "گوجه فرنگی",
  sku: null,
  unit: "kg",
  reorder_level: "5",
  avg_cost: "100000",
  purchase_unit: null,
  purchase_unit_factor: "1",
  is_active: true,
  is_produced: false,
  image_media_id: null,
  stock: 20,
};

const ENTRY = {
  id: "waste-1",
  inventory_item_id: "item-1",
  inventory_item_name: "گوجه فرنگی",
  unit: "kg",
  quantity: "1",
  total_cost: "100000",
  waste_reason: "spoilage",
  note: null,
  occurred_at: "2026-01-01T00:00:00Z",
};

const run: Runner = async (fn) => {
  const { ok } = await fn();
  return ok;
};

function renderSection() {
  return render(<WasteSection items={[ITEM]} busy={false} run={run} />);
}

/** Opens a `SearchableSelect` by its trigger's accessible name and picks one option by its visible label. */
async function selectFromCombobox(triggerName: string | RegExp, optionName: string) {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.click(option);
}

describe("WasteSection — a same-scope refresh (issue #909 item 4)", () => {
  it("keeps the recent-waste list on screen when the post-submit reload fails, with an inline retry", async () => {
    let getCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/inventory/waste") && (!init || init.method === undefined)) {
          getCall += 1;
          if (getCall === 1) return { ok: true, status: 200, json: async () => ({ entries: [ENTRY] }) };
          return { ok: false, status: 500, json: async () => ({}) };
        }
        if (url === "/api/inventory/waste" && init?.method === "POST") {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
      }),
    );
    renderSection();
    await screen.findByText("گوجه فرنگی");

    await selectFromCombobox("قلم انبار", "گوجه فرنگی (kg)");
    fireEvent.change(screen.getByRole("textbox", { name: /مقدار/ }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت ضایعات" }));

    await waitFor(() => expect(getCall).toBe(2));
    // Still there — a reload that fails after a successful submission does not erase a good history.
    expect(screen.getByText("گوجه فرنگی")).toBeTruthy();
    expect(screen.getByText(/به‌روزرسانی سوابق ضایعات ناموفق بود/)).toBeTruthy();
  });

  it("shows the retry-only state on a genuine first-load failure, with nothing to protect yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/inventory/waste")) return { ok: false, status: 500, json: async () => ({}) };
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    renderSection();
    expect(await screen.findByText("سوابق ضایعات بارگذاری نشد. اتصال را بررسی و دوباره تلاش کنید.")).toBeTruthy();
    expect(screen.queryByText("گوجه فرنگی")).toBeNull();
  });
});
