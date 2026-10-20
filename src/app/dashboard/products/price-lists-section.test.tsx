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
    expect(csv.slice(1).split("\r\n")[0]).toBe(
      "کد کالا,بارکد,عنوان کالا,قیمت فروش (تومان),قیمت خرید (تومان),عمده (تومان)",
    );

    // A formula-shaped name is neutralised, and quotes are doubled.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);

    // The named-list cell is exported from the stored value, in the same unit.
    expect(csv).toContain(`"5000"`);

    download.restore();
  });
});
