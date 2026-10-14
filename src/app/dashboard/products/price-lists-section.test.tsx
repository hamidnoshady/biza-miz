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

/** Persian digits → ASCII, so an assertion does not depend on the input's display digits. */
const latin = (value: string) =>
  value.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[^\d]/g, "");

/**
 * Audit F14, second half: a list cell someone else changed after the matrix
 * loaded comes back from the save as a conflict. The screen must say so in
 * Persian, keep the user's typed value, and let them either take the current
 * value or overwrite deliberately — the overwrite sending the *current*
 * version, the undecided cell the stale one.
 */
describe("PriceListsSection conflicts", () => {
  const LIST = { id: "list-1", locationId: "loc", name: "عمده", currency: "IRR", sort: 1 };

  function stubConflictApi() {
    let stored = { price: 50_000, version: "100", updatedAt: "2026-10-01T08:00:00.000Z" };
    const puts: { updates: { expectedVersion?: string | null; price: number | null }[] }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      let body: unknown;
      if (url.includes("/api/products/price-lists/entries")) {
        const sent = JSON.parse(String(init?.body)) as (typeof puts)[number];
        puts.push(sent);
        const cell = sent.updates[0];
        if (cell.expectedVersion === stored.version) {
          stored = { price: cell.price ?? 0, version: "300", updatedAt: "2026-10-01T09:00:00.000Z" };
          body = { ok: true, touched: 1, conflicts: [] };
        } else {
          // A colleague saved 55,000 after this screen loaded.
          stored = { price: 55_000, version: "200", updatedAt: "2026-10-01T08:30:00.000Z" };
          body = {
            ok: true,
            touched: 0,
            conflicts: [
              {
                priceListId: LIST.id,
                itemId: "item-1",
                requestedPrice: cell.price,
                currentPrice: stored.price,
                currentVersion: stored.version,
                updatedAt: stored.updatedAt,
              },
            ],
          };
        }
      } else if (url.includes("/api/products/price-lists")) {
        body = { lists: [LIST], entries: [{ priceListId: LIST.id, itemId: "item-1", ...stored }] };
      } else {
        body = { items: ITEMS.slice(0, 3) };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { puts, setStoredVersion: (version: string) => (stored = { ...stored, version }) };
  }

  const listInput = () => screen.getByLabelText(/^عمده کالای 1/) as HTMLInputElement;
  const panelTitle = "قیمت‌هایی که هم‌زمان تغییر کرده‌اند";

  async function pressSave() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ذخیره ۱ تغییر/ }));
    });
  }

  async function typeAndSave(value: string) {
    await act(async () => {
      fireEvent.change(listInput(), { target: { value } });
    });
    await pressSave();
  }

  it("reports a conflict in Persian, keeps the typed value, and overwrites only on request", async () => {
    const api = stubConflictApi();
    render(<PriceListsSection apiBase="/api/accessories" />);
    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    // The colleague's save lands before ours: our loaded version is now stale.
    api.setStoredVersion("150");

    await typeAndSave("6000");
    expect(api.puts[0].updates[0].expectedVersion).toBe("100");

    await waitFor(() => expect(screen.getByText(panelTitle)).toBeTruthy());
    expect(screen.getAllByText(/کس دیگری آن را تغییر داده است/).length).toBeGreaterThan(0);
    expect(latin(listInput().value)).toBe("6000");
    expect(listInput().getAttribute("aria-invalid")).toBe("true");

    // Pressing save again without deciding keeps sending the stale version.
    await pressSave();
    expect(api.puts[1].updates[0].expectedVersion).toBe("100");
    await waitFor(() => expect(screen.getByText(panelTitle)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "جایگزینی با مقدار من" }));
    await pressSave();
    expect(api.puts[2].updates[0]).toMatchObject({ expectedVersion: "200", price: 60_000 });
    await waitFor(() => expect(screen.queryByText(panelTitle)).toBeNull());
  });

  it("«بارگذاری مقدار فعلی» replaces the typed value with the stored one", async () => {
    const api = stubConflictApi();
    render(<PriceListsSection apiBase="/api/accessories" />);
    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    api.setStoredVersion("150");

    await typeAndSave("6000");
    await waitFor(() => expect(screen.getByText(panelTitle)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "بارگذاری مقدار فعلی" }));
    expect(latin(listInput().value)).toBe("5500");
    expect(screen.queryByText(panelTitle)).toBeNull();
    expect(screen.getByRole("button", { name: "ذخیره قیمت‌ها" })).toBeTruthy();
  });
});
