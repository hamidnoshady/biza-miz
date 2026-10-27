// @vitest-environment jsdom

/**
 * Issue #909 §6 — a narrow, focused regression for one confirmed defect:
 * `load()`'s refresh after a stock/price save never cleared `items` on
 * failure (so the table correctly kept the rows it already had), but
 * `loadError` itself was only ever read inside the "table is empty" branch
 * — a refresh failure with data already on screen was silent, with nothing
 * telling the reader their figures might be stale.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { ProductsListSection } from "./products-list-section";

// The sticky stock-panel wrapper measures its container with a
// ResizeObserver, which jsdom does not implement.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    name: "پیراهن آبی",
    sku: "SKU-1",
    barcode: null,
    source: "manual",
    quantity: 5,
    unitCost: 100_000,
    unitPrice: 150_000,
    isVariantParent: false,
    parentName: null,
    attributes: [],
    ...overrides,
  };
}

function renderSection() {
  return render(
    <MoneyProvider unit="rial">
      <ProductsListSection apiBase="/api/products" />
    </MoneyProvider>,
  );
}

describe("ProductsListSection", () => {
  it("keeps the row visible, with a Retry, when the refresh after a save fails (issue #909 §6)", async () => {
    let itemsAttempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/products/items") {
          itemsAttempt += 1;
          // Attempt 1: the initial load (ok). Attempt 2: the refresh the
          // save triggers (fails). Attempt 3: the reader's own retry (ok).
          if (itemsAttempt === 2) {
            return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
          }
          return { ok: true, status: 200, json: async () => ({ items: [item()] }) };
        }
        if (url === "/api/products/items/item-1/stock") {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");

    await user.click(screen.getByRole("button", { name: "ورود کالا / قیمت" }));
    const priceField = screen.getByLabelText(/قیمت فروش هر واحد/);
    fireEvent.change(priceField, { target: { value: "160000" } });
    await user.click(screen.getByRole("button", { name: "ذخیره" }));

    // The save itself succeeded; its own refresh (attempt 2) failed. The row
    // from attempt 1 must stay on screen, with a visible retry — not a
    // silently stale table.
    await waitFor(() =>
      expect(screen.getByText(/به‌روزرسانی فهرست محصولات ناموفق بود/)).toBeTruthy(),
    );
    expect(screen.getAllByText("پیراهن آبی").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() =>
      expect(screen.queryByText(/به‌روزرسانی فهرست محصولات ناموفق بود/)).toBeNull(),
    );
    expect(screen.getAllByText("پیراهن آبی").length).toBeGreaterThan(0);
  });

  it("edits a product's publish status and descriptions through the meta write path", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/products/items") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [item({ publishStatus: "published", shortDescription: "قدیمی", longDescription: null })],
          }),
        };
      }
      if (url === "/api/products/items/item-1/meta") {
        expect(init?.method).toBe("PATCH");
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");

    await user.click(screen.getByRole("button", { name: "توضیحات و انتشار" }));
    const save = screen.getByRole("button", { name: "ذخیره" });
    // Nothing changed yet, so there is nothing to save.
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("وضعیت انتشار"), { target: { value: "draft" } });
    fireEvent.change(screen.getByLabelText("توضیح کوتاه"), { target: { value: "  جدید  " } });
    await user.click(screen.getByRole("button", { name: "ذخیره" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/api/products/items/item-1/meta"),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/products/items/item-1/meta")!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      publishStatus: "draft",
      shortDescription: "  جدید  ",
      longDescription: "",
    });
  });

  it("shows a draft or private product's status beside its name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ items: [item({ publishStatus: "draft" })] }),
      })),
    );
    renderSection();
    await screen.findByText("پیراهن آبی");
    expect(screen.getByText("پیش‌نویس")).toBeTruthy();
  });
});
