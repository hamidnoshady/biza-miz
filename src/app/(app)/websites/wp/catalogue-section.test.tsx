/** @vitest-environment jsdom */
//
// The RTL + keyboard contract of the WooCommerce catalogue section
// (issue #943, item 6). The assertions are about what a keyboard-only,
// screen-reader-using, Persian-reading owner actually meets:
//
//   * every state the issue asks the row to show — local, remote, pending,
//     failed, last-synced — is rendered in Persian words, not icons alone;
//   * machine-directional text (SKUs, remote ids, raw store errors) is
//     isolated with dir="ltr" inside the RTL page;
//   * every action is a native <button>/<a>/<select>/<input> — reachable by
//     Tab, activatable by Enter, exposed with an accessible name and honest
//     aria-pressed state (no div-with-onClick anywhere);
//   * the per-product push switches, the failed-queue retry and the editor's
//     untracked-stock opt-in post exactly the payloads the routes enforce.
//
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(""),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/websites/wp",
  useSearchParams: () => nav.search,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/app/dashboard/ui", () => ({
  api: vi.fn(),
  errorMessageOrRaw: (message: string) => message,
  ErrorBox: ({ children }: { children?: React.ReactNode }) => <div role="alert">{children}</div>,
  InfoBox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  inputClass: "",
}));

import { api } from "@/app/dashboard/ui";
import { formatPersianNumber } from "@/lib/digits";
import { CatalogueSection, syncProductsResultText } from "./catalogue-section";

type SectionCall = React.ComponentProps<typeof CatalogueSection>["call"];

/** The base row: a tracked, published simple product with a mirrored image. */
function simpleProduct(overrides: Record<string, unknown> = {}) {
  return {
    remoteId: "55",
    localId: "item-55",
    name: "قهوه ترک",
    sku: "SKU-55",
    wooType: "simple",
    itemKind: "simple",
    sellable: true,
    priceRial: "1000000",
    quantity: 12,
    parentRemoteId: null,
    categories: ["نوشیدنی"],
    attributes: [],
    remoteStatus: "publish",
    remoteManageStock: true,
    remoteRegularPriceRial: "1000000",
    remoteSalePriceRial: null,
    remoteImageSrc: "https://store.example.com/wp-content/uploads/coffee.jpg",
    remoteImageAlt: "بسته قهوه",
    stockTracked: true,
    stockPushPaused: false,
    pricePushPaused: false,
    remoteMissing: false,
    lastSyncedAt: "2026-10-20T08:00:00.000Z",
    queue: null,
    ...overrides,
  };
}

/** A variation whose last stock push failed — the row that needs a human. */
function failedVariation() {
  return simpleProduct({
    remoteId: "56",
    localId: "item-56",
    name: "کوله پشتی",
    sku: "SKU-56",
    wooType: "variation",
    itemKind: "variant_child",
    parentRemoteId: "54",
    priceRial: "2500000",
    quantity: 9,
    categories: [],
    attributes: ["قرمز"],
    remoteStatus: null,
    remoteImageSrc: null,
    remoteImageAlt: null,
    lastSyncedAt: null,
    queue: {
      state: "failed",
      kinds: ["stock"],
      pendingPatch: { stock_quantity: 9, manage_stock: true },
      lastError: "HTTP 502 from store",
      updatedAt: "2026-10-20T09:00:00.000Z",
      lastSentAt: "2026-10-19T10:00:00.000Z",
    },
  });
}

/** An external product: no tracked stock, an image without alt text, a queued
 *  price patch, and no longer seen by the store's last complete read. */
function untrackedExternal() {
  return simpleProduct({
    remoteId: "57",
    localId: "item-57",
    name: "کیف چرم",
    sku: null,
    wooType: "external",
    itemKind: "simple",
    priceRial: null,
    quantity: null,
    categories: [],
    remoteStatus: "draft",
    remoteManageStock: false,
    remoteRegularPriceRial: null,
    remoteSalePriceRial: null,
    remoteImageSrc: "https://store.example.com/wp-content/uploads/bag.jpg",
    remoteImageAlt: null,
    stockTracked: false,
    remoteMissing: true,
    lastSyncedAt: null,
    queue: {
      state: "queued",
      kinds: ["price"],
      pendingPatch: { regular_price: "250" },
      lastError: null,
      updatedAt: "2026-10-20T09:30:00.000Z",
      lastSentAt: null,
    },
  });
}

function catalogueResponse(overrides: Record<string, unknown> = {}) {
  return {
    moneyUnit: "toman",
    connection: {
      currencyUnit: "toman",
      linkMode: "rest_api",
      status: "active",
      pushStock: true,
      pushPrices: true,
      syncProducts: true,
      lastCatalogueSyncAt: "2026-10-20T08:05:00.000Z",
      lastError: null,
    },
    summary: { total: 3, sellable: 2, variations: 1, containers: 0, outOfStock: 0, uncategorised: 1 },
    types: ["external", "simple", "variation"],
    total: 3,
    totalPages: 1,
    page: 1,
    pageSize: 25,
    products: [simpleProduct(), failedVariation(), untrackedExternal()],
    ...overrides,
  };
}

function stubApi(response = catalogueResponse()) {
  vi.mocked(api).mockResolvedValue({ ok: true, data: response } as never);
}

async function renderSection(call?: ReturnType<typeof vi.fn>) {
  const callMock = (call ?? vi.fn().mockResolvedValue({ ok: true })) as unknown as SectionCall;
  const view = render(<CatalogueSection connectionId="woo" busy={false} call={callMock} />);
  // The rows arrive on the first fetch; wait for one of them.
  await screen.findByText("قهوه ترک");
  return { ...view, callMock };
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li");
  if (!row) throw new Error(`row for ${name} not found`);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = new URLSearchParams("");
  stubApi();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CatalogueSection — initial mount keeps a shared URL (Codex review, 4ed562e)", () => {
  it("fetches with the URL's q/type/page/size and never resets them on mount", async () => {
    nav.search = new URLSearchParams("store=woo&q=قهوه&type=simple&page=2&size=10");
    await renderSection();

    // The first fetch must already honour the shared link's filters.
    const firstUrl = String(vi.mocked(api).mock.calls[0]?.[0] ?? "");
    const params = new URLSearchParams(firstUrl.split("?")[1] ?? "");
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("10");
    expect(params.get("search")).toBe("قهوه");
    expect(params.get("type")).toBe("simple");

    // The store-switch reset must not fire on mount: no router.replace
    // wiping q/type/page/size, and the search box keeps the shared query.
    expect(nav.replace).not.toHaveBeenCalled();
    const searchInput = screen.getByPlaceholderText("نام، SKU، نوع، دسته، برچسب یا ویژگی…") as HTMLInputElement;
    expect(searchInput.value).toBe("قهوه");
  });
});

describe("CatalogueSection — the search box survives its own fetch", () => {
  it("keeps the same focused input mounted while a refetch is in flight", async () => {
    await renderSection();
    const input = screen.getByPlaceholderText("نام، SKU، نوع، دسته، برچسب یا ویژگی…") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    // A fetch that never answers: the section is `loading` from here on.
    vi.mocked(api).mockImplementation(() => new Promise(() => {}) as never);
    fireEvent.click(screen.getByRole("button", { name: "تازه‌سازی" }));

    await waitFor(() => expect(screen.getByLabelText("فهرست محصولات ووکامرس").getAttribute("aria-busy")).toBe("true"));
    const after = screen.getByPlaceholderText("نام، SKU، نوع، دسته، برچسب یا ویژگی…");
    expect(after).toBe(input);
    expect(document.activeElement).toBe(input);
  });
});

describe("CatalogueSection — row states (issue #943, item 5)", () => {
  it("shows local, remote, pending, failed and last-synced states side by side, in Persian words", async () => {
    const { container } = await renderSection();
    const body = container.textContent ?? "";
    // Local (Accounting) vs remote (store mirror) vs last-synced.
    expect(body).toContain("قیمت در حسابداری");
    expect(body).toContain("قیمت در فروشگاه");
    expect(body).toContain("آخرین همگام‌سازی کاتالوگ:");
    expect(body).toContain(`آخرین همگام‌سازی:`);
    // Pending: the queued patch is described in words on the external row.
    expect(screen.getByText(/در صف ارسال:/)).toBeTruthy();
    expect(body).toContain("قیمت ۲۵۰");
    // Failed: the parked push names its axis and shows the raw store error.
    expect(screen.getByText(/ارسال ناموفق:/)).toBeTruthy();
    expect(screen.getByText("HTTP 502 from store")).toBeTruthy();
    // Last acknowledged send, on the failed row.
    expect(body).toContain("آخرین ارسال تأییدشده به فروشگاه:");
    // Badges.
    expect(screen.getByText("در صف")).toBeTruthy();
    expect(screen.getAllByText("ارسال ناموفق").length).toBeGreaterThan(0);
    expect(screen.getByText("در فروشگاه دیده نشد")).toBeTruthy();
    expect(screen.getByText("منتشرشده")).toBeTruthy();
    expect(screen.getByText("پیش‌نویس")).toBeTruthy();
  });

  it("mirrors the store image read-only with an honest alt, and falls back when the store sent none", async () => {
    await renderSection();
    expect(screen.getByAltText("بسته قهوه")).toBeTruthy();
    // The external product's image has no alt text at the store — the mirror
    // names the product instead of leaving a silent image.
    expect(screen.getByAltText("تصویر محصول کیف چرم")).toBeTruthy();
    // The variation had no image at the last sync: nothing is fabricated.
    expect(screen.queryAllByRole("img")).toHaveLength(2);
  });
});

describe("CatalogueSection — the RTL contract", () => {
  it("isolates machine-directional text with dir=ltr inside the Persian page", async () => {
    await renderSection();
    expect(screen.getByText("SKU-55").getAttribute("dir")).toBe("ltr");
    expect(screen.getByText(/والد #54/).getAttribute("dir")).toBe("ltr");
    expect(screen.getByText("HTTP 502 from store").getAttribute("dir")).toBe("ltr");
  });

  it("announces the section and its live counts to assistive technology", async () => {
    const { container } = await renderSection();
    const section = container.querySelector('section[aria-label="فهرست محصولات ووکامرس"]');
    expect(section).toBeTruthy();
    expect(section?.getAttribute("aria-busy")).toBe("false");
    // The mapped-count line is a polite live region, and the summary chips
    // are grouped under their own label.
    const live = screen.getByText(`${formatPersianNumber(3)} محصول نگاشت‌شده`);
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector('[aria-label="خلاصهٔ کاتالوگ"]')).toBeTruthy();
  });
});

describe("CatalogueSection — the keyboard contract (issue #943, item 6)", () => {
  it("builds every action from native controls — no role=button divs anywhere", async () => {
    const { container } = await renderSection();
    expect(container.querySelectorAll("[role='button']")).toHaveLength(0);
    // The core actions are real buttons with accessible Persian names.
    expect(screen.getByRole("button", { name: "همگام‌سازی محصولات" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "تازه‌سازی" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "نوع محصول" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "جست‌وجوی محصول" })).toBeTruthy();
    // Queue diagnostics are a real link to the queue page, per row and in the header.
    const queueLinks = screen.getAllByRole("link", { name: /صف و رویدادها/ });
    expect(queueLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of queueLinks) expect(link.getAttribute("href")).toContain("/websites/wp/queue?store=woo");
  });

  it("is read-only: no product editor, no price/stock push switches, and nothing posts to the product route", async () => {
    const { callMock } = await renderSection();
    expect(screen.queryByRole("button", { name: /ویرایش محصول/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /قیمت:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /موجودی:/ })).toBeNull();
    expect(screen.queryByText(/ارسال به فروشگاه$/)).toBeNull();
    // It says where products are managed instead, with a link to Accounting.
    const link = screen.getByRole("link", { name: "محصولات حسابداری" });
    expect(link.getAttribute("href")).toBe("/accounting/products");
    expect(callMock).not.toHaveBeenCalled();
  });
});

describe("CatalogueSection — the failed-queue retry (issue #943, item 5)", () => {
  it("offers «retry» only on the failed row, and it posts to the retry route", async () => {
    const { callMock } = await renderSection();
    const failedRow = rowOf("کوله پشتی");
    const retry = within(failedRow).getByRole("button", { name: "تلاش دوبارهٔ ارسال" });
    expect(within(rowOf("قهوه ترک")).queryByRole("button", { name: "تلاش دوبارهٔ ارسال" })).toBeNull();
    expect(within(rowOf("کیف چرم")).queryByRole("button", { name: "تلاش دوبارهٔ ارسال" })).toBeNull();
    // The failed row keeps the diagnostic link next to the retry.
    expect(
      within(failedRow).getByRole("link", { name: "پیگیری در «صف و رویدادها»" }).getAttribute("href"),
    ).toBe("/websites/wp/queue?store=woo");

    fireEvent.click(retry);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("/api/integrations/connections/woo/store/products/retry", "POST", {
        remoteId: "56",
      }),
    );
  });
});

describe("CatalogueSection — filters, facets and the gallery", () => {
  it("sends category, tag, status and stock filters to the catalogue route as the server expects them", async () => {
    nav.search = new URLSearchParams("store=woo&cat=12&status=draft&stock=out");
    await renderSection();
    const url = String(vi.mocked(api).mock.calls[0]?.[0] ?? "");
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    expect(params.get("taxonomy")).toBe("product_cat");
    expect(params.get("term")).toBe("12");
    expect(params.get("status")).toBe("draft");
    expect(params.get("stock")).toBe("out");
  });

  it("offers the store's real statuses and the stock choices as filter chips, and applies one through the URL", async () => {
    stubApi(
      catalogueResponse({
        facets: {
          categories: [{ remoteId: "12", name: "نوشیدنی", count: 2 }],
          tags: [{ remoteId: "30", name: "پرفروش", count: 1 }],
          statuses: ["draft", "publish"],
        },
      }),
    );
    await renderSection();
    const statusGroup = screen.getByRole("group", { name: "فیلتر وضعیت انتشار" });
    expect(within(statusGroup).getByRole("button", { name: "پیش‌نویس" })).toBeTruthy();
    fireEvent.click(within(statusGroup).getByRole("button", { name: "منتشرشده" }));
    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining("status=publish"), { scroll: false });
    const stockGroup = screen.getByRole("group", { name: "فیلتر موجودی" });
    fireEvent.click(within(stockGroup).getByRole("button", { name: "ناموجود" }));
    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining("stock=out"), { scroll: false });
  });

  it("shows a product's tags and gallery, and flags a price the store and Accounting disagree on", async () => {
    stubApi(
      catalogueResponse({
        products: [
          simpleProduct({
            tags: ["پرفروش"],
            remoteGallery: [
              { src: "https://store.example.com/g1.jpg", alt: "نمای کنار" },
              { src: "https://store.example.com/g2.jpg", alt: "" },
            ],
            priceRial: "1200000",
            remoteRegularPriceRial: "1000000",
          }),
        ],
      }),
    );
    await renderSection();
    const row = rowOf("قهوه ترک");
    expect(within(row).getByText("# پرفروش")).toBeTruthy();
    expect(within(row).getByAltText("نمای کنار")).toBeTruthy();
    expect(within(row).getByText("ناهمخوان")).toBeTruthy();
  });

  it("does not flag a matching price", async () => {
    await renderSection();
    expect(within(rowOf("قهوه ترک")).queryByText("ناهمخوان")).toBeNull();
  });
});

describe("CatalogueSection — rial vs toman display (issue #943, item 6)", () => {
  it("shows every money figure in the business's own unit, never a hardcoded «تومان»", async () => {
    stubApi(
      catalogueResponse({
        moneyUnit: "rial",
        connection: {
          currencyUnit: "rial",
          linkMode: "rest_api",
          status: "active",
          pushStock: true,
          pushPrices: true,
          syncProducts: true,
          lastCatalogueSyncAt: null,
          lastError: null,
        },
      }),
    );
    const { container } = await renderSection();
    const row = rowOf("قهوه ترک");
    // 1,000,000 integer Rial is displayed 1:1 in a Rial business.
    expect(row.textContent).toContain("۱٬۰۰۰٬۰۰۰");
    expect(row.textContent).toContain("ریال");
    expect(row.textContent).not.toContain("تومان");
    // The queued-patch wording follows the same unit.
    expect(container.textContent).toContain("قیمت ۲۵۰ ریال");
  });
});

describe("CatalogueSection — the storefront content sheet (issue #1215, P1-2)", () => {
  it("opens the sheet for the row's own product, and only on a click", async () => {
    const user = userEvent.setup();
    await renderSection();
    // The card itself stays the read-only mirror: nothing was fetched for a
    // product nobody opened.
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).includes("/store/products/55"))).toBe(false);

    await user.click(within(rowOf("قهوه ترک")).getByRole("button", { name: "محتوا و تصاویر" }));

    expect(await screen.findByText(/محتوا و تصاویر «قهوه ترک»/)).toBeTruthy();
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).endsWith("/store/products/55"))).toBe(true);
  });
});

describe("syncProductsResultText — the sync outcome wording (issue #943, item 5)", () => {
  it("reports skipped and missing-remotely counts, and never invents a deletion", () => {
    const text = syncProductsResultText({
      total: 10,
      created: 2,
      updated: 7,
      skipped: 1,
      variations: 3,
      containers: 1,
      missingRemotely: 2,
    });
    expect(text).toContain("همگام‌سازی محصولات انجام شد");
    expect(text).toContain(`${formatPersianNumber(1)} ردشده`);
    expect(text).toContain(`${formatPersianNumber(2)} محصول نگاشت‌شده`);
    // Flagged, not removed: the wording says «علامت خورد» (flagged), and the
    // row/badge promise no local deletion.
    expect(text).toContain("در فروشگاه دیده نشد");
    expect(text).toContain("علامت خورد");
  });

  it("stays quiet about missing products when the count is zero, and honest about partial syncs", () => {
    const clean = syncProductsResultText({ total: 4, created: 0, updated: 4, skipped: 0, missingRemotely: 0 });
    expect(clean).not.toContain("دیده نشد");

    const partial = syncProductsResultText({
      total: 6,
      created: 1,
      updated: 3,
      skipped: 0,
      partial: true,
      failed: 2,
      failureIds: ["7", "8"],
    });
    expect(partial).toContain("⚠ همگام‌سازی ناقص بود");
    expect(partial).toContain("شناسه‌ها: 7، 8");
    // A partial read never carries a missing-remotely count — the server
    // guards the flag run on a complete, failure-free read, and the wording
    // must not claim flags that were not set.
    expect(partial).not.toContain("دیده نشد");
  });

  it("uses the plugin queue wording when the sync itself was queued", () => {
    expect(syncProductsResultText({ queued: true })).toContain("در صف افزونه");
  });

  it("renders the sync outcome in a status region after the button press", async () => {
    const call = vi.fn().mockResolvedValue({
      queued: false,
      total: 4,
      created: 0,
      updated: 4,
      skipped: 0,
      variations: 0,
      containers: 0,
      missingRemotely: 1,
    });
    await renderSection(call);
    const before = vi.mocked(api).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "همگام‌سازی محصولات" }));
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("همگام‌سازی محصولات انجام شد");
    expect(notice.textContent).toContain("دیده نشد");
    // REST mode: the section re-reads the catalogue so the rows and the new
    // flags are the post-sync truth.
    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(before));
  });
});
