// @vitest-environment jsdom

/**
 * Issue #909 item 4 — `loadClosings()` in periodic-closings-section.tsx
 * («دوره‌های بسته‌شده») reruns right after a periodic closing is posted, but
 * its failure/catch branches unconditionally zeroed `closings` — so that
 * refresh failing erased an already-shown closed-period history behind a
 * retry-only empty state. Fixed with the same ref-guarded pattern used for
 * stock-section.tsx and waste-section.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem, Runner } from "./food-service-inventory-manager";
import { PeriodicClosingsSection } from "./periodic-closings-section";

afterEach(cleanup);

const ITEM: InventoryItem = {
  id: "item-1",
  name: "آرد",
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

const CLOSING = {
  id: "closing-1",
  periodEnd: "2026-01-01",
  method: "weighted_average",
  beginningValueRial: "1000000",
  purchasesValueRial: "500000",
  endingValueRial: "800000",
  cogsValueRial: "700000",
  note: null,
  createdAt: "2026-01-02T00:00:00Z",
};

const run: Runner = async (fn) => {
  const { ok } = await fn();
  return ok;
};

function renderSection() {
  return render(<PeriodicClosingsSection items={[ITEM]} busy={false} run={run} />);
}

describe("PeriodicClosingsSection — a same-scope refresh (issue #909 item 4)", () => {
  it("keeps the closed-period history on screen when the post-submit reload fails, with an inline retry", async () => {
    let getCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/inventory/periodic-closings" && (!init || init.method === undefined)) {
          getCall += 1;
          if (getCall === 1) return { ok: true, status: 200, json: async () => ({ closings: [CLOSING] }) };
          return { ok: false, status: 500, json: async () => ({}) };
        }
        if (url === "/api/inventory/periodic-closings" && init?.method === "POST") {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
      }),
    );
    renderSection();
    await screen.findByText(/میانگین موزون/);

    fireEvent.click(screen.getByRole("button", { name: "تاریخ پایان دوره" }));
    fireEvent.click(await screen.findByRole("button", { name: "امروز" }));
    fireEvent.click(screen.getByRole("button", { name: "ثبت بستن دوره" }));

    await waitFor(() => expect(getCall).toBe(2));
    // Still there — a reload that fails after a successful submission does not erase a good history.
    expect(screen.getByText(/میانگین موزون/)).toBeTruthy();
    expect(screen.getByText(/به‌روزرسانی دوره‌های بسته‌شده ناموفق بود/)).toBeTruthy();
  });

  it("shows the retry-only state on a genuine first-load failure, with nothing to protect yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/inventory/periodic-closings") return { ok: false, status: 500, json: async () => ({}) };
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    renderSection();
    expect(await screen.findByText("دوره‌های بسته‌شده بارگذاری نشد. اتصال را بررسی و دوباره تلاش کنید.")).toBeTruthy();
    expect(screen.queryByText(/پایان دوره:/)).toBeNull();
  });
});
