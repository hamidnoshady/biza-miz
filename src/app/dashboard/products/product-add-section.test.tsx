// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import { ProductAddSection } from "./product-add-section";

const attributeId = "5b04a6c7-df35-4f35-b26b-1534bce6b391";
const definition: AttributeDefinition = {
  id: attributeId,
  locationId: "branch-a",
  name: "رنگ",
  options: ["قرمز"],
  isActive: true,
  version: 1,
  usageCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function legacyDraft(values: Record<string, string>) {
  return [{
    id: "draft-1",
    savedAt: Date.now(),
    form: {
      name: "پیراهن",
      variants: [{ id: "variant-1", values, sku: "", barcode: "", autoBarcode: false, sellPrice: "", purchasePrice: "", quantity: "" }],
    },
  }];
}

function installFetch(definitions: AttributeDefinition[], onCreate?: (payload: Record<string, unknown>) => void) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url === "/api/products/attributes") return jsonResponse({ definitions });
    if (url === "/api/settings/retail-pricing") {
      return jsonResponse({
        policy: {
          fixedOverheadRial: null,
          percentOverhead: null,
          overheadBase: "reference",
          profitMode: "markup",
          profitPercent: 20,
          rounding: "none",
          roundStepRial: 10_000,
          taxMode: "exclusive",
        },
        defaultTaxPercent: null,
      });
    }
    if (url === "/api/products/items" && init?.method === "POST") {
      onCreate?.(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true, message: "created" });
    }
    return jsonResponse({ error: "unexpected_request" }, 500);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProductAddSection attribute drafts", () => {
  it("keeps price recommendations advisory until explicitly applied and allows a manual override", async () => {
    installFetch([]);
    const user = userEvent.setup();
    render(<ProductAddSection draftScope="business-1:branch-a" />);
    await user.click(await screen.findByRole("tab", { name: "قیمت‌گذاری" }));

    const purchaseLabels = await screen.findAllByText(/قیمت خرید \(/);
    const purchaseLabel = purchaseLabels[0];
    const sellLabel = screen.getByText("قیمت فروش (تومان)");
    const purchasePrice = purchaseLabel.closest("label")?.querySelector("input");
    const sellPrice = sellLabel.closest("label")?.querySelector("input");
    expect(purchasePrice).toBeInstanceOf(HTMLInputElement);
    expect(sellPrice).toBeInstanceOf(HTMLInputElement);
    if (!(purchasePrice instanceof HTMLInputElement) || !(sellPrice instanceof HTMLInputElement)) return;
    await user.type(purchasePrice, "1000");
    expect(sellPrice.value).toBe("");
    // The suggestion comes from the business policy (20% markup) and waits to be applied.
    await user.click(await screen.findByRole("button", { name: "اعمال قیمت پیشنهادی" }));
    expect(sellPrice.value).toBe("۱٬۲۰۰");

    await user.clear(sellPrice);
    await user.type(sellPrice, "1250");
    expect(sellPrice.value).toBe("۱٬۲۵۰");
  });

  it("submits the publish status and descriptions written on the «توضیحات و انتشار» tab", async () => {
    let submitted: Record<string, unknown> | undefined;
    installFetch([], (payload) => { submitted = payload; });
    const user = userEvent.setup();
    render(<ProductAddSection draftScope="business-1:branch-a" />);

    await user.type(await screen.findByLabelText(/نام محصول/), "دستبند چرم");
    await user.click(screen.getByRole("tab", { name: "توضیحات و انتشار" }));
    await user.selectOptions(screen.getByLabelText("وضعیت انتشار"), "draft");
    await user.type(screen.getByLabelText("توضیح کوتاه"), "دستبند دست‌دوز");
    await user.type(screen.getByLabelText("توضیح کامل"), "متن کامل دستبند");
    await user.click(screen.getAllByRole("button", { name: /ثبت محصول/ })[0]);

    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({
      publishStatus: "draft",
      shortDescription: "دستبند دست‌دوز",
      longDescription: "متن کامل دستبند",
    });
  });

  it("migrates a legacy name-keyed draft to a stable definition ID and submits that ID", async () => {
    let submitted: Record<string, unknown> | undefined;
    installFetch([definition], (payload) => { submitted = payload; });
    window.localStorage.setItem("products-add-drafts:v2:business-1:branch-a", JSON.stringify(legacyDraft({ رنگ: "قرمز" })));
    const user = userEvent.setup();
    render(<ProductAddSection draftScope="business-1:branch-a" />);

    await user.click((await screen.findAllByRole("button", { name: /پیراهن/ }))[0]);
    await user.click(screen.getByRole("tab", { name: "تنوع‌ها" }));
    await user.click(screen.getAllByRole("button", { name: "ثبت محصول و تنوع‌ها" })[0]);

    await waitFor(() => expect(submitted).toBeDefined());
    const variants = submitted?.variants as { attributes: { definitionId: string; name: string; value: string }[] }[];
    expect(variants[0].attributes).toEqual([{ definitionId: attributeId, name: "رنگ", value: "قرمز" }]);
  });

  it("preserves an ID-keyed stale value until the user explicitly maps it to an allowed current option", async () => {
    const current = { ...definition, name: "طیف رنگ", options: ["آبی"], version: 2 };
    let submitted: Record<string, unknown> | undefined;
    installFetch([current], (payload) => { submitted = payload; });
    window.localStorage.setItem("products-add-drafts:v3:business-1:branch-a", JSON.stringify([{
      id: "draft-2",
      savedAt: Date.now(),
      form: {
        name: "پیراهن",
        definitionSnapshot: { [attributeId]: { name: "رنگ", options: ["قرمز"], isActive: true } },
        variants: [{ id: "variant-2", values: { [attributeId]: "قرمز" }, unresolvedValues: {}, sku: "", barcode: "", autoBarcode: false, sellPrice: "", purchasePrice: "", quantity: "" }],
      },
    }]));
    const user = userEvent.setup();
    render(<ProductAddSection draftScope="business-1:branch-a" />);

    await user.click((await screen.findAllByRole("button", { name: /پیراهن/ }))[0]);
    await user.click(screen.getByRole("tab", { name: "تنوع‌ها" }));
    expect(await screen.findByText(/مقدار پیش‌نویس «قرمز» دیگر مجاز نیست/)).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "ثبت محصول و تنوع‌ها" })[0]);
    expect(await screen.findByText(/نیاز به بازبینی دارند/)).toBeTruthy();
    expect(submitted).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "ویژگی طیف رنگ برای تنوع ۱" }));
    await user.click(await screen.findByRole("option", { name: "آبی" }));
    await user.click(screen.getByRole("button", { name: "ساختار تازه را بررسی کردم؛ مقدارها را حفظ کن" }));
    await user.click(screen.getAllByRole("button", { name: "ثبت محصول و تنوع‌ها" })[0]);

    await waitFor(() => expect(submitted).toBeDefined());
    const variants = submitted?.variants as { attributes: { definitionId: string; name: string; value: string }[] }[];
    expect(variants[0].attributes).toEqual([{ definitionId: attributeId, name: "طیف رنگ", value: "آبی" }]);
  });

  it("supports shared /media main cover, multi-select gallery, canonical AI/version selection, and never blocks plain product creation", async () => {
    const coverOrigId = "11111111-1111-4111-8111-111111111111";
    const coverBgRemovedId = "22222222-2222-4222-8222-222222222222";
    const galleryId = "33333333-3333-4333-8333-333333333333";
    const submittedPayloads: Record<string, unknown>[] = [];

    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
      if (url === "/api/products/attributes") return jsonResponse({ definitions: [definition] });
      if (url.startsWith("/api/media?")) {
        return jsonResponse({
          assets: [
            {
              id: coverOrigId,
              folderId: null,
              kind: "image",
              fileName: "shirt-front.png",
              mimeType: "image/png",
              byteSize: 2048,
              category: null,
              tags: [],
              aiStatus: "none",
              aiLabels: {},
              variant: "original",
              sourceAssetId: null,
              source: "upload",
              createdByAi: false,
              createdAt: "2026-10-20T00:00:00.000Z",
            },
            {
              id: galleryId,
              folderId: null,
              kind: "image",
              fileName: "shirt-side.png",
              mimeType: "image/png",
              byteSize: 2048,
              category: null,
              tags: [],
              aiStatus: "none",
              aiLabels: {},
              variant: "original",
              sourceAssetId: null,
              source: "upload",
              createdByAi: false,
              createdAt: "2026-10-20T00:00:00.000Z",
            },
          ],
          total: 2,
          storage: { ready: true, enhancePriceRial: 0 },
        });
      }
      if (url === `/api/media/${coverOrigId}/usage`) {
        return jsonResponse({ usage: { menuItems: [], inventoryItems: [], expenses: [], purchases: [] } });
      }
      if (url === `/api/media/${coverOrigId}/collections`) {
        return jsonResponse({ collections: [] });
      }
      if (url === `/api/media/${coverOrigId}/wordpress`) {
        return jsonResponse({ connections: [] });
      }
      if (url === `/api/media/${coverOrigId}/bg-remove` && init?.method === "POST") {
        return jsonResponse({ ok: true }, 201);
      }
      if (url === `/api/media/${coverOrigId}/lineage`) {
        return jsonResponse({
          lineage: {
            ancestors: [],
            descendants: [{ id: coverBgRemovedId, fileName: "shirt-front-nobg.png", variant: "bg_removed" }],
          },
        });
      }
      if (url === "/api/products/items" && init?.method === "POST") {
        submittedPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ ok: true, message: "created" });
      }
      return jsonResponse({ error: "unexpected_request", url }, 500);
    });

    const user = userEvent.setup();
    render(<ProductAddSection draftScope="business-1:branch-a" />);

    // 1. Plain product creation with zero images succeeds cleanly
    await user.type(await screen.findByPlaceholderText("مثلاً پیراهن مردانه"), "کالای ساده بدون عکس");
    await user.click(screen.getAllByRole("button", { name: "ثبت محصول" })[0]);
    await waitFor(() => expect(submittedPayloads.length).toBe(1));
    expect(submittedPayloads[0]).toMatchObject({
      name: "کالای ساده بدون عکس",
      coverMediaId: null,
      galleryMediaIds: [],
    });

    // 2. Product with canonical /media AI edit + version selection + multi-select gallery
    await user.type(await screen.findByPlaceholderText("مثلاً پیراهن مردانه"), "پیراهن سفید رسمی");
    await user.click(screen.getByRole("button", { name: "انتخاب از کتابخانه" }));
    await screen.findByText("shirt-front.png");
    // Open canonical /media AssetDrawer directly from picker card
    await user.click(screen.getAllByRole("button", { name: "ویرایش / هوش مصنوعی" })[0]);
    await user.click(await screen.findByText("حذف پس‌زمینه"));
    await screen.findByText(/shirt-front-nobg\.png/);
    const useVersionButtons = screen.getAllByRole("button", { name: "استفاده از این نسخه" });
    await user.click(useVersionButtons[1]);

    // Multi-select gallery picker
    await user.click(screen.getByRole("button", { name: "افزودن تصاویر گالری" }));
    await user.click(await screen.findByTitle("shirt-side.png"));
    await user.click(screen.getByRole("button", { name: /تأیید انتخاب/ }));

    await user.click(screen.getAllByRole("button", { name: "ثبت محصول" })[0]);
    await waitFor(() => expect(submittedPayloads.length).toBe(2));
    expect(submittedPayloads[1]).toMatchObject({
      name: "پیراهن سفید رسمی",
      coverMediaId: coverBgRemovedId,
      galleryMediaIds: [galleryId],
    });
  });
});
