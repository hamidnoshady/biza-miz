// @vitest-environment jsdom

/**
 * Dashboard audit F14 + issue #924 F12 / code-review item 1.
 *
 * The price editor used to load every item (1,685 in the audited store) and
 * draw every row; it now asks the server for one bounded page — `limit` and
 * `offset` are real query parameters — draws that page, and keeps an edit typed
 * on one page when the user moves to another.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceListsSection } from "./price-lists-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const ITEMS = Array.from({ length: 120 }, (_, i) => ({
  id: `item-${i + 1}`,
  name: `کالای ${i + 1}`,
  sku: `SKU${i + 1}`,
  barcode: null,
  kind: "standard",
  parentName: null,
  unitPrice: 10_000,
  unitCost: null,
  isSellable: true,
  version: "1000",
}));

/** The bounded matrix payload the route answers with. */
function matrixPayload(url: string) {
  const params = new URL(url, "http://localhost").searchParams;
  const limit = Math.min(Number(params.get("limit") ?? "50") || 50, 200);
  const offset = Math.max(Number(params.get("offset") ?? "0") || 0, 0);
  const q = params.get("q")?.trim() ?? "";
  const matching = q ? ITEMS.filter((item) => item.name.includes(q) || item.sku.includes(q)) : ITEMS;
  return {
    lists: [],
    entries: [],
    items: matching.slice(offset, offset + limit),
    total: matching.length,
    limit,
    offset,
    hasMore: offset + limit < matching.length,
  };
}

function stubApi() {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.includes("/api/products/price-lists")
      ? matrixPayload(url)
      : { items: ITEMS };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PriceListsSection draft mirror", () => {
  it("keeps unsaved cells across a page change and restores them by business scope", async () => {
    stubApi();
    const first = render(<PriceListsSection apiBase="/api/accessories" draftScope="biz-1:loc-a" />);

    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    const input = screen.getByLabelText("قیمت فروش کالای 2") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "7500" } });
    });

    // The mirror is written after the debounce, under the scope the server gave
    // the page — not a global key that another branch's screen would read.
    await waitFor(() => {
      const raw = window.localStorage.getItem("price-lists-drafts:biz-1:loc-a");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)).toEqual({ "item-2": { sale: "7500" } });
    });
    expect(window.localStorage.getItem("price-lists-drafts:biz-1:loc-b")).toBeNull();

    // Leaving the page (the sidebar, the back button) used to lose the typing.
    first.unmount();
    render(<PriceListsSection apiBase="/api/accessories" draftScope="biz-1:loc-a" />);
    await waitFor(() =>
      expect((screen.getByLabelText("قیمت فروش کالای 2") as HTMLInputElement).value).toBe("۷٬۵۰۰"),
    );
    expect(screen.getByRole("button", { name: /ذخیره ۱ تغییر/ })).toBeTruthy();

    // «لغو تغییرات» throws the drafts away — they must not come back.
    fireEvent.click(screen.getByRole("button", { name: /لغو/ }));
    await waitFor(() =>
      // Back to the stored value — in the cell's own display currency (10,000
      // rial shows as 1,000 of the business unit).
      expect((screen.getByLabelText("قیمت فروش کالای 2") as HTMLInputElement).value).toBe("۱٬۰۰۰"),
    );
    expect(window.localStorage.getItem("price-lists-drafts:biz-1:loc-a")).toBeNull();
  });
});

describe("PriceListsSection paging", () => {
  it("draws one page and keeps an edit across pages", async () => {
    stubApi();
    render(<PriceListsSection apiBase="/api/accessories" />);

    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    expect(screen.queryByText("کالای 51")).toBeNull();
    expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(51);

    const input = screen.getByLabelText("قیمت فروش کالای 2") as HTMLInputElement;
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
    expect((screen.getByLabelText("قیمت فروش کالای 2") as HTMLInputElement).value).not.toBe("");
  });

  it("asks the server for a bounded window and pages with offset", async () => {
    const fetch = stubApi();
    render(<PriceListsSection apiBase="/api/accessories" />);

    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    const first = String((fetch.mock.calls[0] as unknown[])[0]);
    expect(first).toContain("/api/products/price-lists?");
    expect(first).toContain("limit=50");
    expect(first).toContain("offset=0");

    fireEvent.click(screen.getByRole("button", { name: "بعدی" }));
    await waitFor(() => expect(screen.getByText("کالای 51")).toBeTruthy());
    const urls = fetch.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.some((url) => url.includes("offset=50"))).toBe(true);
  });

  it("searches server-side instead of filtering a preloaded catalogue", async () => {
    const fetch = stubApi();
    render(<PriceListsSection apiBase="/api/accessories" />);

    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    const search = screen.getByLabelText("جستجوی کالا بر اساس نام، کد یا بارکد");
    await act(async () => {
      fireEvent.change(search, { target: { value: "کالای 12" } });
    });

    await waitFor(() => {
      const urls = fetch.mock.calls.map((call) => String((call as unknown[])[0]));
      expect(urls.some((url) => url.includes("q="))).toBe(true);
    });
  });
});

/**
 * F09, made explicit (code-review item 2): a named list is a reference shelf.
 * The column header says so, so nobody assumes «عمده» sets the invoice price.
 */
describe("PriceListsSection reference-only lists", () => {
  it("labels every named-list column as reference-only and keeps the sale column separate", async () => {
    const LIST = { id: "list-1", locationId: "loc", name: "عمده", currency: "IRR", sort: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("/api/products/price-lists")
          ? { lists: [LIST], entries: [], items: ITEMS.slice(0, 2), total: 2, limit: 50, offset: 0, hasMore: false }
          : { items: ITEMS };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    render(<PriceListsSection apiBase="/api/accessories" />);
    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());

    // One badge per named list, and the description states the resolution rule.
    expect(screen.getByText("مرجع")).toBeTruthy();
    expect(screen.getByText(/فقط قیمت مرجع‌اند/)).toBeTruthy();
    expect(screen.getAllByText(/قیمت فروش/).length).toBeGreaterThan(0);
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
        body = {
          lists: [LIST],
          entries: [{ priceListId: LIST.id, itemId: "item-1", ...stored }],
          items: ITEMS.slice(0, 3),
          total: 3,
          limit: 50,
          offset: 0,
          hasMore: false,
        };
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

/**
 * Issue #924 F02 / acceptance "permission parity … `menu.edit` alone cannot
 * modify item stock"; the same idea for the screen: a member who may view but
 * not adjust inventory must not be offered a control whose request is certain
 * to 403. The server remains the authority — this is the UI half.
 */
describe("PriceListsSection view-only members", () => {
  it("renders the matrix read-only and hides every write control", async () => {
    stubApi();
    render(<PriceListsSection apiBase="/api/accessories" canEdit={false} />);
    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());

    // Editable inputs are replaced by locked display cells.
    expect(screen.queryByLabelText("قیمت فروش کالای 1")).toBeNull();
    expect(screen.getByLabelText("قیمت فروش کالای 1 (قفل)")).toBeTruthy();
    expect(screen.getByText(/دسترسی «اصلاح موجودی» ندارید/)).toBeTruthy();

    // No control that would call a write route.
    expect(screen.queryByRole("button", { name: /بروزرسانی سریع/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /مدیریت لیست‌های قیمت/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /ذخیره قیمت‌ها/ })).toBeNull();
    // Reading and exporting are still allowed.
    expect(screen.getByRole("button", { name: /دانلود CSV/ })).toBeTruthy();
  });
});

/**
 * Issue #924 F05 / acceptance "failed/unapplied cell values remain recoverable
 * after save and reload".
 *
 * The save used to reload the page's stored values and thereby erase whatever
 * the server had refused: the screen looked as if the number had been saved to
 * a different value, and the user's typed price was gone. A failed request must
 * keep the draft *and* say it was not applied.
 */
describe("PriceListsSection failed saves", () => {
  function stubFailingStockApi() {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/products/price-lists/stock")) {
        return new Response(JSON.stringify({ error: "database_unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const body = url.includes("/api/products/price-lists") ? matrixPayload(url) : { items: ITEMS };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("keeps an unapplied price and reports it instead of reloading it away", async () => {
    const fetchMock = stubFailingStockApi();
    render(<PriceListsSection apiBase="/api/accessories" />);

    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());
    const sale = () => screen.getByLabelText("قیمت فروش کالای 1") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(sale(), { target: { value: "12000" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ذخیره ۱ تغییر/ }));
    });

    // The request failed, and the screen says so — it must not claim a save.
    // The message is rendered twice on purpose (visible box + live region), so
    // assert on the live region rather than a single text node.
    await waitFor(() => expect(screen.queryByRole("status")?.textContent).toContain("خطای غیرمنتظره"));
    expect(screen.queryByText("قیمت‌ها ذخیره شد.")).toBeNull();

    // The reload that follows the failure still shows the typed value, and the
    // change is still pending rather than silently reconciled to the server's.
    await waitFor(() => expect(screen.getByRole("button", { name: /ذخیره ۱ تغییر/ })).toBeTruthy());
    expect(latin(sale().value)).toBe("12000");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/products/price-lists?"))).toBe(true);
  });
});

/**
 * Issue #924 F13 / acceptance "cosmetics cost fields respect batch-derived
 * valuation; other industries respect their acquisition/stock rules".
 *
 * The cosmetics single-item route refuses a bare purchase-cost edit because the
 * cost comes from the batch. The matrix used to render an input anyway, so the
 * only feedback a shopkeeper got was a failed request. The column is read-only
 * with the reason; the sale column stays editable.
 */
describe("PriceListsSection industry cost rules", () => {
  it("locks the cosmetics purchase column and explains the batch cost", async () => {
    stubApi();
    render(<PriceListsSection apiBase="/api/cosmetics" />);
    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());

    const locked = screen.getByLabelText("قیمت خرید کالای 1 (قفل)");
    expect(locked.getAttribute("title")).toContain("بهای هر لات");
    // The sale price is still the shopkeeper's to set.
    expect(screen.getByLabelText("قیمت فروش کالای 1")).toBeTruthy();
    expect(screen.queryByLabelText("قیمت خرید کالای 1")).toBeNull();
  });
});

/**
 * Issue #924 F08 names three states that must never be read as one another:
 * «unset» (a blank cell), zero (refused for sale), and *not offered for sale*.
 * The first two are enforced by the stock route; the third lives on the item,
 * and the matrix used to draw it exactly like a sellable row — so a missing
 * sale price on a non-sellable item looked like a gap to fill.
 */
describe("PriceListsSection not-for-sale rows", () => {
  function stubMixedApi() {
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const limit = Math.min(Number(params.get("limit") ?? "50") || 50, 200);
      const offset = Math.max(Number(params.get("offset") ?? "0") || 0, 0);
      const rows = [
        { ...ITEMS[0], id: "item-1", name: "کالای 1", isSellable: true },
        { ...ITEMS[1], id: "item-2", name: "کالای 2", isSellable: false },
      ];
      const body = url.includes("/api/products/price-lists")
        ? { lists: [], entries: [], items: rows.slice(offset, offset + limit), total: rows.length, limit, offset, hasMore: false }
        : { items: rows };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("marks only the row that is not offered for sale, and still lets its price be set", async () => {
    stubMixedApi();
    render(<PriceListsSection apiBase="/api/accessories" />);

    await waitFor(() => expect(screen.getByText("کالای 2")).toBeTruthy());
    // Exactly one badge: the sellable row must not carry it.
    const badges = screen.getAllByText("غیرقابل فروش");
    expect(badges).toHaveLength(1);
    expect(badges[0].getAttribute("title")).toContain("برای فروش عرضه نشده");

    // Preparing a price before the item goes on the shelf is legitimate —
    // the marker informs, it does not lock the cell.
    expect(screen.getByLabelText("قیمت فروش کالای 2")).toBeTruthy();
  });
});

/**
 * Issue #924 F07, read half: "immutable per-cell history … ensure exports and
 * reporting". The rows were already written by every path; this pins that the
 * matrix can show them for one item, with source, actor and old → new, and
 * that the dialog never shows a write control.
 */
describe("PriceListsSection price history", () => {
  function stubHistoryApi() {
    const fetchMock = vi.fn(async (url: string) => {
      let body: unknown;
      if (url.includes("/api/products/price-history")) {
        body = {
          rows: [
            {
              id: "h1",
              itemId: "item-1",
              itemName: "کالای 1",
              priceKind: "sale",
              priceListId: null,
              priceListName: null,
              oldPrice: 100_000,
              newPrice: 110_000,
              source: "bulk",
              actorId: "user-1",
              actorName: "مدیر فروش",
              createdAt: "2026-10-19T08:30:00.000Z",
              reason: null,
            },
            {
              id: "h2",
              itemId: "item-1",
              itemName: "کالای 1",
              priceKind: "list",
              priceListId: "list-1",
              priceListName: "عمده",
              oldPrice: 50_000,
              newPrice: null,
              source: "import",
              actorId: null,
              actorName: null,
              createdAt: "2026-10-18T09:00:00.000Z",
              reason: "holoo_goods_import",
            },
          ],
        };
      } else {
        body = url.includes("/api/products/price-lists") ? matrixPayload(url) : { items: ITEMS };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("shows one item's immutable changes with source, actor and before → after", async () => {
    const fetchMock = stubHistoryApi();
    render(<PriceListsSection apiBase="/api/accessories" />);
    await waitFor(() => expect(screen.getByText("کالای 1")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تاریخچهٔ قیمت کالای 1" }));
    });

    // The read is scoped to the item and bounded.
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
      expect(urls.some((url) => url.includes("/api/products/price-history") && url.includes("itemId=item-1"))).toBe(true);
    });

    expect(await screen.findByText("تاریخچهٔ قیمت کالای 1")).toBeTruthy();
    // Source labels come from the shared vocabulary, not a local copy.
    expect(screen.getByText("بروزرسانی گروهی")).toBeTruthy();
    expect(screen.getByText("ورود اطلاعات")).toBeTruthy();
    expect(screen.getByText("مدیر فروش")).toBeTruthy();
    // A named-list change says which list, and a cleared price reads «بدون قیمت».
    expect(screen.getByText("لیست قیمت — عمده")).toBeTruthy();
    expect(screen.getByText(/بدون قیمت/)).toBeTruthy();
    // A machine reason is shown in Persian, not dropped (an import row with no
    // reason reads like a manual edit).
    expect(screen.getByText("ورود از هلو")).toBeTruthy();
    // History is an audit view: no save or edit control inside it.
    expect(screen.queryByRole("button", { name: /ذخیره/ })).toBeNull();
    expect(screen.getByRole("button", { name: "دانلود CSV تاریخچه" })).toBeTruthy();
  });
});

/**
 * Issue #924 F12 / acceptance "CSV/XLSX labeling and export units are accurate;
 * preserve safe CSV escaping" plus "tests cover … file exports".
 *
 * The export is not a dump of the page on screen: it walks the *filtered* set in
 * bounded 200-row windows. It is a real `.csv` (the button says CSV, not Excel),
 * carries the business's own unit in the headers, keeps the UTF-8 BOM Persian
 * Excel needs, and neutralises a leading `=` so a product name cannot become a
 * formula.
 */
describe("PriceListsSection CSV export", () => {
  const LIST = { id: "list-1", locationId: "loc", name: "عمده", currency: "IRR", sort: 1 };

  /** 250 items ⇒ two bounded windows (200 + 50) when everything is exported. */
  const MANY = Array.from({ length: 250 }, (_, i) => ({
    id: `item-${i + 1}`,
    name: i === 0 ? "=HYPERLINK(\"http://evil\")" : `کالای ${i + 1}`,
    sku: `SKU${i + 1}`,
    barcode: null,
    kind: "standard",
    parentName: null,
    unitPrice: 10_000,
    unitCost: null,
    version: "1000",
  }));

  function stubExportApi() {
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const limit = Math.min(Number(params.get("limit") ?? "50") || 50, 200);
      const offset = Math.max(Number(params.get("offset") ?? "0") || 0, 0);
      const body = url.includes("/api/products/price-lists")
        ? {
            lists: [LIST],
            entries: [{ priceListId: LIST.id, itemId: "item-2", price: 50_000, version: "9", updatedAt: "2026-10-01T08:00:00.000Z" }],
            items: MANY.slice(offset, offset + limit),
            total: MANY.length,
            limit,
            offset,
            hasMore: offset + limit < MANY.length,
          }
        : { items: MANY };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock };
  }

  /**
   * Kept as a real `URL` constructor — replacing the global breaks anything that
   * constructs a URL — and only its object-URL factory is spied so the Blob the
   * export builds can be read back.
   */
  function installDownloadSpies() {
    const created: Blob[] = [];
    // Read the Blob's *sources* directly: reading the body back strips the BOM,
    // and the BOM is one of the things this test exists to protect.
    const RealBlob = globalThis.Blob;
    let captured = "";
    class CapturingBlob extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        captured = parts.map((part) => String(part)).join("");
      }
    }
    vi.stubGlobal("Blob", CapturingBlob);
    // jsdom implements neither factory, so they are defined then removed again.
    const hadCreate = "createObjectURL" in URL;
    const hadRevoke = "revokeObjectURL" in URL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        created.push(blob);
        return "blob:price-lists";
      }),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const anchorClick = vi.fn();
    const realCreate = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = realCreate(tag, options);
      if (tag === "a") Object.defineProperty(element, "click", { value: anchorClick });
      return element;
    }) as typeof document.createElement);
    return {
      anchorClick,
      restore() {
        if (!hadCreate) delete (URL as unknown as Record<string, unknown>).createObjectURL;
        if (!hadRevoke) delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
        createElement.mockRestore();
        vi.stubGlobal("Blob", RealBlob);
      },
      csv: () => captured,
    };
  }

  it("streams every filtered row in bounded windows, as safe CSV with the business unit", async () => {
    const api = stubExportApi();
    render(<PriceListsSection apiBase="/api/accessories" />);
    await waitFor(() => expect(screen.getByText("SKU2")).toBeTruthy());

    const download = installDownloadSpies();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "دانلود CSV لیست قیمت" }));
    });
    await waitFor(() => expect(download.anchorClick).toHaveBeenCalled());

    const csv = download.csv();
    // The button promises CSV and the file is CSV.
    expect(screen.getByRole("button", { name: "دانلود CSV لیست قیمت" })).toBeTruthy();

    // Bounded pages: 200 + 50, not the 50-row screen page and not one huge read.
    const urls = api.fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    const exportUrls = urls.filter((url) => url.includes("limit=200"));
    expect(exportUrls.length).toBeGreaterThanOrEqual(2);
    expect(exportUrls.some((url) => url.includes("offset=0"))).toBe(true);
    expect(exportUrls.some((url) => url.includes("offset=200"))).toBe(true);

    // Every row exported (header + 250), and the header carries the display
    // unit (Toman here).
    expect(csv.split("\r\n").filter(Boolean).length).toBe(251);
    expect(csv.charAt(0)).toBe("\uFEFF");
    // Headers are quoted like every other cell: a list called «عمده, ویژه»
    // would otherwise split the header row into two columns.
    expect(csv.slice(1).split("\r\n")[0]).toBe(
      '"کد کالا","بارکد","عنوان کالا","قیمت فروش (تومان)","قیمت خرید (تومان)","عمده (تومان)"',
    );

    // A formula-shaped name is neutralised, and quotes are doubled.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);

    // The named-list cell is exported from the stored value, in the same unit.
    expect(csv).toContain(`"5000"`);

    download.restore();
  });
});
