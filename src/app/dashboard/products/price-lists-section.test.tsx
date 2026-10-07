// @vitest-environment jsdom

/**
 * Dashboard audit F14: the price editor drew every item (1,685 in the audited
 * store) with several inputs each. It now draws one page of 50, and an edit
 * typed on one page must survive moving to another and still be saved.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceListsSection } from "./price-lists-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ITEMS = Array.from({ length: 120 }, (_, i) => ({
  id: `item-${i + 1}`,
  name: `کالای ${i + 1}`,
  sku: `SKU${i + 1}`,
  kind: "standard",
  unitPrice: 10_000,
  unitCost: null,
}));

function stubApi() {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.includes("/api/products/price-lists")
      ? { lists: [], entries: [] }
      : { items: ITEMS };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PriceListsSection paging", () => {
  it("draws one page and keeps an edit across pages", async () => {
    stubApi();
    render(<PriceListsSection apiBase="/api/accessories" />);

    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    expect(screen.queryByText("کالای 51")).toBeNull();
    expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(51);

    const input = screen.getByLabelText("قیمت خرید کالای 2") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "7000" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "بعدی" }));
    await waitFor(() => expect(screen.getByText("کالای 51")).toBeTruthy());
    expect(screen.queryByText("کالای 2")).toBeNull();
    expect(screen.getByText(/۱ کالای دیگر هم تغییر ذخیره‌نشده دارد/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /ذخیره ۱ تغییر/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "قبلی" }));
    await waitFor(() => expect(screen.getByText("کالای 2")).toBeTruthy());
    expect((screen.getByLabelText("قیمت خرید کالای 2") as HTMLInputElement).value).not.toBe("");
  });
});
