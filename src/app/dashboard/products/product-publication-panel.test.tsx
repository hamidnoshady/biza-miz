// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductPublicationPanel } from "./product-publication-panel";

const fetchMock = vi.fn<typeof fetch>();
let posts: Record<string, unknown>[];
beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) posts.push(body);
    return new Response(JSON.stringify(!body ? { stores: [{ id: "store-a", name: "Store A" }, { id: "store-b", name: "Store B" }] } : body.confirm ? { queued: 1 } : {
      previews: [{ connectionId: "store-a", storeName: "Store A", name: "Product", action: "create", reviewToken: "reviewed", payload: { sku: "SKU", status: "publish" } }],
    }), { status: body?.confirm ? 202 : 200, headers: { "Content-Type": "application/json" } });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("explicit product publication review", () => {
  it("selects nothing by default and sends only a reviewed selected store", async () => {
    const user = userEvent.setup();
    render(<ProductPublicationPanel localId="local-product" />);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "انتشار / پیوند فروشگاه" }));
    const store = await screen.findByRole("checkbox", { name: "Store A" });
    expect((store as HTMLInputElement).checked).toBe(false);
    await user.click(store);
    await user.click(screen.getByRole("button", { name: "بازبینی انتشار / پیوند" }));
    expect(posts[0]).toMatchObject({ confirm: false, stores: [{ connectionId: "store-a" }] });
    await user.click(await screen.findByRole("button", { name: "تأیید و ارسال موارد بازبینی‌شده" }));
    expect(posts[1]).toMatchObject({ confirm: true, stores: [{ connectionId: "store-a", reviewToken: "reviewed" }] });
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("در صف ارسال"));
  });

  it("invalidates review when selected stores change", async () => {
    const user = userEvent.setup();
    render(<ProductPublicationPanel localId="local-product" />);
    await user.click(screen.getByRole("button", { name: "انتشار / پیوند فروشگاه" }));
    await user.click(await screen.findByRole("checkbox", { name: "Store A" }));
    await user.click(screen.getByRole("button", { name: "بازبینی انتشار / پیوند" }));
    await screen.findByRole("button", { name: "تأیید و ارسال موارد بازبینی‌شده" });
    await user.click(screen.getByRole("checkbox", { name: "Store B" }));
    expect(screen.queryByRole("button", { name: "تأیید و ارسال موارد بازبینی‌شده" })).toBeNull();
    expect(posts).toHaveLength(1);
  });
});
