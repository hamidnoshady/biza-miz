// @vitest-environment jsdom

/**
 * The products list's interactions.
 *
 * Issue #909 §6 — a narrow, focused regression for one confirmed defect:
 * `load()`'s refresh after a stock/price save never cleared `items` on
 * failure (so the table correctly kept the rows it already had), but
 * `loadError` itself was only ever read inside the "table is empty" branch
 * — a refresh failure with data already on screen was silent, with nothing
 * telling the reader their figures might be stale.
 *
 * Issue #1207 §A/B — the rest: the row offers the action its own state
 * deserves, the verbose facts sit behind «جزئیات», and a flagged duplicate
 * opens the review instead of a publication.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { ProductsListSection } from "./products-list-section";

// The sticky panel wrapper measures its container with a ResizeObserver, which
// jsdom does not implement.
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
    source: null,
    quantity: 5,
    unitCost: 100_000,
    unitPrice: 150_000,
    isVariantParent: false,
    kind: "simple",
    parentName: null,
    attributes: [],
    isSellable: true,
    publishStatus: "published",
    unit: "عدد",
    ...overrides,
  };
}

function wooLink(overrides: Record<string, unknown> = {}) {
  return {
    localId: "item-1",
    connectionId: "store-a",
    provider: "woocommerce",
    storeName: "فروشگاه الف",
    remoteId: "5023",
    connectionStatus: "active",
    lastCatalogueSyncAt: "2026-10-28T09:15:00.000Z",
    lastOutboundStatus: "sent",
    lastOutboundSentAt: "2026-10-29T10:00:00.000Z",
    lastOutboundError: null,
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

/** A fetch double covering the four reads the board makes. */
function fetchDouble(
  options: {
    items?: () => unknown;
    links?: unknown[];
    duplicateSkus?: string[];
    onStock?: () => unknown;
    duplicateGroup?: unknown;
    posted?: Record<string, unknown>[];
  } = {},
) {
  const posted = options.posted ?? [];
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body) posted.push(JSON.parse(String(init.body)));
    if (url === "/api/products/items") {
      return { ok: true, status: 200, json: async () => (options.items ? options.items() : { items: [item()] }) };
    }
    if (url === "/api/products/woo-links") {
      return { ok: true, status: 200, json: async () => ({ links: options.links ?? [] }) };
    }
    if (url.startsWith("/api/products/duplicates?summary=1")) {
      return { ok: true, status: 200, json: async () => ({ skus: options.duplicateSkus ?? [] }) };
    }
    if (url.startsWith("/api/products/duplicates?sku=")) {
      return { ok: true, status: 200, json: async () => ({ groups: options.duplicateGroup ? [options.duplicateGroup] : [] }) };
    }
    if (url === "/api/products/duplicates" && init?.body) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.endsWith("/stock")) {
      return { ok: true, status: 200, json: async () => (options.onStock ? options.onStock() : {}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
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
        if (url === "/api/products/duplicates?summary=1") {
          return { ok: true, status: 200, json: async () => ({ skus: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");

    // §B: the write paths live in the row's details area.
    await user.click(screen.getByRole("button", { name: /جزئیات/ }));
    await user.click(screen.getByRole("button", { name: "ورود کالا / قیمت" }));
    const priceField = screen.getByLabelText(/قیمت فروش هر واحد/);
    fireEvent.change(priceField, { target: { value: "160000" } });
    await user.click(screen.getByRole("button", { name: "ذخیره" }));

    // The save itself succeeded; its own refresh (attempt 2) failed. The row
    // from attempt 1 must stay on screen, with a visible retry — not a
    // silently stale table.
    await screen.findByText(/به‌روزرسانی فهرست محصولات ناموفق بود/);
    expect(screen.getAllByText("پیراهن آبی").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await screen.findAllByText("پیراهن آبی");
    expect(screen.queryByText(/به‌روزرسانی فهرست محصولات ناموفق بود/)).toBeNull();
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
      if (url === "/api/products/duplicates?summary=1") {
        return { ok: true, status: 200, json: async () => ({ skus: [] }) };
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

    await user.click(screen.getByRole("button", { name: /جزئیات/ }));
    await user.click(screen.getByRole("button", { name: "توضیحات و انتشار" }));
    const save = screen.getByRole("button", { name: "ذخیره" });
    // Nothing changed yet, so there is nothing to save.
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("وضعیت انتشار"), { target: { value: "draft" } });
    fireEvent.change(screen.getByLabelText("توضیح کوتاه"), { target: { value: "  جدید  " } });
    await user.click(screen.getByRole("button", { name: "ذخیره" }));

    const call = await vi.waitFor(() => {
      const found = fetchMock.mock.calls.find(([url]) => url === "/api/products/items/item-1/meta");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      publishStatus: "draft",
      shortDescription: "  جدید  ",
      longDescription: "",
    });
  });

  it("shows a draft or private product's status beside its name", async () => {
    vi.stubGlobal("fetch", fetchDouble({ items: () => ({ items: [item({ publishStatus: "draft" })] }) }));
    renderSection();
    await screen.findByText("پیراهن آبی");
    expect(screen.getAllByText("پیش‌نویس").length).toBeGreaterThan(0);
  });
});

describe("issue #1207 §A — the row's store action is named after its state", () => {
  it("offers «انتشار در فروشگاه» on a row no store knows", async () => {
    vi.stubGlobal("fetch", fetchDouble());
    renderSection();
    await screen.findByText("پیراهن آبی");
    expect(await screen.findByRole("button", { name: "انتشار در فروشگاه" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "به‌روزرسانی دستی" })).toBeNull();
    expect(screen.getByText("بدون پیوند ووکامرس")).toBeTruthy();
  });

  it("offers «به‌روزرسانی دستی» and the store's own acknowledged state on a linked row", async () => {
    vi.stubGlobal("fetch", fetchDouble({ links: [wooLink()] }));
    renderSection();
    await screen.findByText("پیراهن آبی");
    expect(await screen.findByRole("button", { name: "به‌روزرسانی دستی" })).toBeTruthy();
    expect(screen.getByText("ارسال تأیید شد")).toBeTruthy();
    expect(screen.getByText("فروشگاه الف")).toBeTruthy();
  });

  it("keeps the Woo ids and both timestamps in the details area, not on the row", async () => {
    vi.stubGlobal("fetch", fetchDouble({ links: [wooLink()] }));
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");
    expect(screen.queryByText(/Woo ID:/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /جزئیات/ }));
    const details = await screen.findByRole("link", { name: "مدیریت این فروشگاه" });
    expect(details.getAttribute("href")).toBe("/websites/wp/products?store=store-a");
    expect(screen.getByText(/Woo ID: 5023/)).toBeTruthy();
    // §B: the two times are separate facts, never one "last sync".
    expect(screen.getByText(/آخرین دریافت کاتالوگ/)).toBeTruthy();
    expect(screen.getByText(/آخرین تأیید ارسال/)).toBeTruthy();
  });
});

describe("issue #1207 §B — source and per-store filters", () => {
  it("filters by the integration that owns the row", async () => {
    vi.stubGlobal(
      "fetch",
      fetchDouble({
        items: () => ({
          items: [
            item({ id: "item-1", name: "پیراهن آبی", source: { provider: "woocommerce", remoteId: "5023" } }),
            item({ id: "item-2", name: "شلوار خاکی", sku: "SKU-2", source: { provider: "holoo", remoteId: "G1" } }),
            item({ id: "item-3", name: "کلاه محلی", sku: "SKU-3", source: null }),
          ],
        }),
      }),
    );
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");
    expect(screen.getByText("شلوار خاکی")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("فیلتر منبع محصول"), "holoo");
    expect(screen.getByText("شلوار خاکی")).toBeTruthy();
    expect(screen.queryByText("پیراهن آبی")).toBeNull();
    expect(screen.queryByText("کلاه محلی")).toBeNull();

    // `local` is "no integration owns it", not "no store mapping".
    await user.selectOptions(screen.getByLabelText("فیلتر منبع محصول"), "local");
    expect(screen.getByText("کلاه محلی")).toBeTruthy();
    expect(screen.queryByText("شلوار خاکی")).toBeNull();
  });

  it("offers the per-store filter only when more than one store is connected", async () => {
    // One store: the control would be a dropdown with a single real choice.
    vi.stubGlobal("fetch", fetchDouble({ links: [wooLink()] }));
    const { unmount } = renderSection();
    await screen.findByText("پیراهن آبی");
    expect(screen.queryByLabelText("فیلتر فروشگاه مشخص")).toBeNull();
    unmount();
    cleanup();

    vi.stubGlobal(
      "fetch",
      fetchDouble({ links: [wooLink(), wooLink({ connectionId: "store-b", storeName: "فروشگاه ب", remoteId: "9001" })] }),
    );
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");
    const select = await screen.findByLabelText("فیلتر فروشگاه مشخص");
    await user.selectOptions(select, "store-b");
    // This row is mapped to both, so it survives a filter for either store.
    expect(screen.getByText("پیراهن آبی")).toBeTruthy();
    await user.selectOptions(select, "store-a");
    expect(screen.getByText("پیراهن آبی")).toBeTruthy();
  });

  it("drops a row the chosen store does not know, and clearing restores it", async () => {
    vi.stubGlobal(
      "fetch",
      fetchDouble({
        // Two stores, each owning one row: the filter has to separate them.
        links: [
          wooLink({ connectionId: "store-a", storeName: "فروشگاه الف", localId: "item-1" }),
          wooLink({ connectionId: "store-c", storeName: "فروشگاه ج", localId: "item-2", remoteId: "7001" }),
        ],
        items: () => ({
          items: [
            item({ id: "item-1", name: "پیراهن آبی" }),
            item({ id: "item-2", name: "شلوار خاکی", sku: "SKU-2" }),
          ],
        }),
      }),
    );
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");
    await user.selectOptions(await screen.findByLabelText("فیلتر فروشگاه مشخص"), "store-c");
    expect(screen.getByText("شلوار خاکی")).toBeTruthy();
    expect(screen.queryByText("پیراهن آبی")).toBeNull();

    await user.selectOptions(screen.getByLabelText("فیلتر فروشگاه مشخص"), "all");
    expect(await screen.findByText("پیراهن آبی")).toBeTruthy();
  });
});

describe("issue #1207 §C — a duplicate candidate is reviewed, not published", () => {
  const group = {
    sku: "sku-1",
    verdict: "race_orphan",
    needsAction: true,
    reviewed: false,
    reviewedAt: null,
    notes: ["یک ردیف پیوند فروشگاه دارد و دیگری ندارد."],
    separateReasons: ["ردیف بدون پیوند (محلی)"],
    members: [
      {
        itemId: "item-2",
        name: "پیراهن آبی",
        sku: "SKU-1",
        kind: "simple",
        parentItemId: null,
        isActive: true,
        locationId: "loc-1",
        locationName: "شعبهٔ اصلی",
        quantity: "0",
        createdAt: "2026-10-31T09:00:00.000Z",
        mappings: [],
        provenance: "local (no integration mapping)",
        snapshots: [],
      },
    ],
    plan: {
      sku: "sku-1",
      orphanItemId: "item-2",
      orphanName: "پیراهن آبی",
      orphanQuantity: "0",
      orphanCreatedAt: "2026-10-31T09:00:00.000Z",
      twinItemId: "item-1",
      twinQuantity: "5",
      status: "archive",
      blockers: [],
      references: [],
    },
    reviewToken: "token-1",
  };

  it("flags the row and opens the review instead of a publication", async () => {
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", fetchDouble({ duplicateSkus: ["sku-1"], duplicateGroup: group, posted }));
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");
    // The chip on the row (the filter dropdown carries the same words).
    expect((await screen.findAllByText("احتمال تکراری")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "بررسی محصول تکراری" }));
    expect(await screen.findByText(/کد کالای مشترک به‌تنهایی معیار ادغام نیست/)).toBeTruthy();
    // Both safe decisions exist; the archive is offered only because the plan
    // says this orphan is unreferenced.
    expect(screen.getByRole("button", { name: "بایگانی نسخهٔ تکراری" })).toBeTruthy();
    const keep = screen.getByRole("button", { name: "نگهداری جداگانه" });
    await user.click(keep);
    await user.click(screen.getByRole("button", { name: "تأیید" }));
    expect(posted.at(-1)).toMatchObject({
      sku: "sku-1",
      action: "keep_separate",
      confirm: true,
      reviewToken: "token-1",
    });
  });

  it("refuses to archive a blocked candidate and explains why", async () => {
    const blocked = {
      ...group,
      plan: {
        ...group.plan,
        status: "blocked",
        blockers: ["has_references"],
        references: [{ table: "order_items", column: "item_id", count: 3 }],
      },
    };
    vi.stubGlobal("fetch", fetchDouble({ duplicateSkus: ["sku-1"], duplicateGroup: blocked }));
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("پیراهن آبی");
    await user.click(await screen.findByRole("button", { name: "بررسی محصول تکراری" }));
    const panel = await screen.findByText(/بایگانی خودکار مجاز نیست/);
    expect(within(panel.parentElement as HTMLElement).getByText(/ردیف سفارش: ۳ رکورد/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "بایگانی نسخهٔ تکراری" })).toBeNull();
    expect(screen.getByRole("button", { name: "نگهداری جداگانه" })).toBeTruthy();
  });
});
