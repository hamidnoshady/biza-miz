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
    await user.click(screen.getByRole("button", { name: "اعمال قیمت پیشنهادی" }));
    expect(sellPrice.value).toBe("۱٬۰۰۰");

    await user.clear(sellPrice);
    await user.type(sellPrice, "1250");
    expect(sellPrice.value).toBe("۱٬۲۵۰");
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
});
