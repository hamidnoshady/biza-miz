// @vitest-environment jsdom
/**
 * Issue #1207 §A — the store control says what it is.
 *
 * Three row shapes, three different buttons: a linked row is a **manual
 * update** (automatic stock/price sync is a separate asynchronous path), an
 * unlinked row is a **publication** with the optional link-to-existing offer,
 * and a probable duplicate with no mapping is a **review** instead of a
 * publication. The review → confirm → queued flow is unchanged, including the
 * review token and its invalidation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductPublicationPanel, ProductStoreActionButton } from "./product-publication-panel";

const fetchMock = vi.fn<typeof fetch>();
let posts: Record<string, unknown>[];

const LINKED = {
  connectionId: "store-a",
  storeName: "Store A",
  remoteId: "5023",
  connectionStatus: "active" as const,
  lastOutboundStatus: null,
};

beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) posts.push(body);
    return new Response(
      JSON.stringify(
        !body
          ? { stores: [{ id: "store-a", name: "Store A" }, { id: "store-b", name: "Store B" }] }
          : body.confirm
            ? { queued: 1 }
            : {
                previews: [
                  {
                    connectionId: "store-a",
                    storeName: "Store A",
                    name: "Product",
                    action: body.stores[0]?.remoteId ? "link" : "update",
                    reviewToken: "reviewed",
                    payload: { sku: "SKU", status: "publish" },
                  },
                ],
              },
      ),
      { status: body?.confirm ? 202 : 200, headers: { "Content-Type": "application/json" } },
    );
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the row's store control is named after what it does", () => {
  it("offers «به‌روزرسانی دستی» on a linked row and says the automatic sync needs no click", async () => {
    const user = userEvent.setup();
    render(
      <ProductPublicationPanel localId="local-product" links={[LINKED]} duplicate={false} open onQueued={() => {}} />,
    );
    expect(screen.getByText("به‌روزرسانی دستی")).toBeTruthy();
    expect(screen.getByText(/همگام‌سازی خودکار موجودی و قیمت/)).toBeTruthy();
    // The store's own state is shown, per store, not one global badge.
    const store = await screen.findByRole("checkbox", { name: /Store A/ });
    expect(store).toBeTruthy();
    expect(screen.getByText("به‌روزرسانی دستی محصول ووکامرس #۵۰۲۳")).toBeTruthy();
    await user.click(store);
    await user.click(screen.getByRole("button", { name: "بازبینی به‌روزرسانی دستی" }));
    expect(posts[0]).toMatchObject({ confirm: false, stores: [{ connectionId: "store-a" }] });
  });

  it("offers «انتشار در فروشگاه» plus the optional link-to-existing field on an unlinked row", async () => {
    render(<ProductPublicationPanel localId="local-product" links={[]} duplicate={false} open onQueued={() => {}} />);
    expect(screen.getByText("انتشار در فروشگاه")).toBeTruthy();
    expect(screen.getByText(/اگر همان محصول از قبل در فروشگاه هست/)).toBeTruthy();
    expect(await screen.findByLabelText("شناسهٔ محصول فروشگاه برای پیوند")).toBeTruthy();
    // A publication is never called an update.
    expect(screen.queryByText("به‌روزرسانی دستی")).toBeNull();
  });

  it("sends a link preview (not a create) when a store id is given", async () => {
    const user = userEvent.setup();
    render(<ProductPublicationPanel localId="local-product" links={[]} duplicate={false} open onQueued={() => {}} />);
    await user.click(await screen.findByRole("checkbox", { name: /Store A/ }));
    await user.type(await screen.findByLabelText("شناسهٔ محصول فروشگاه برای پیوند"), "777");
    await user.click(screen.getByRole("button", { name: "بازبینی انتشار / پیوند" }));
    expect(posts[0]).toMatchObject({ confirm: false, stores: [{ connectionId: "store-a", remoteId: "777" }] });
  });
});

describe("review, confirmation and the queued state", () => {
  it("sends only a reviewed selected store and reports queued, never synced", async () => {
    const onQueued = vi.fn();
    const user = userEvent.setup();
    render(
      <ProductPublicationPanel
        localId="local-product"
        links={[LINKED]}
        duplicate={false}
        open
        onQueued={onQueued}
      />,
    );
    const store = await screen.findByRole("checkbox", { name: /Store A/ });
    expect((store as HTMLInputElement).checked).toBe(false);
    await user.click(store);
    await user.click(screen.getByRole("button", { name: "بازبینی به‌روزرسانی دستی" }));
    await user.click(await screen.findByRole("button", { name: "تأیید و ارسال موارد بازبینی‌شده" }));
    expect(posts[1]).toMatchObject({ confirm: true, stores: [{ connectionId: "store-a", reviewToken: "reviewed" }] });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("در صف ارسال");
    expect(status.textContent).toContain("فقط پس از تأیید فروشگاه");
    expect(onQueued).toHaveBeenCalled();
  });

  it("invalidates the review when the selected stores change", async () => {
    const user = userEvent.setup();
    render(
      <ProductPublicationPanel localId="local-product" links={[LINKED]} duplicate={false} open onQueued={() => {}} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: /Store A/ }));
    await user.click(screen.getByRole("button", { name: "بازبینی به‌روزرسانی دستی" }));
    await screen.findByRole("button", { name: "تأیید و ارسال موارد بازبینی‌شده" });
    await user.click(screen.getByRole("checkbox", { name: /Store B/ }));
    expect(screen.queryByRole("button", { name: "تأیید و ارسال موارد بازبینی‌شده" })).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it("shows a failure instead of a fake success", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body) posts.push(body);
      return new Response(JSON.stringify(body ? { error: "publication_preview_changed" } : { stores: [{ id: "store-a", name: "Store A" }] }), {
        status: body ? 409 : 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const user = userEvent.setup();
    render(
      <ProductPublicationPanel localId="local-product" links={[LINKED]} duplicate={false} open onQueued={() => {}} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: /Store A/ }));
    await user.click(screen.getByRole("button", { name: "بازبینی به‌روزرسانی دستی" }));
    expect((await screen.findByRole("alert")).textContent).toContain("publication_preview_changed");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a probable duplicate with no mapping", () => {
  it("offers the review instead of a publication, so no third twin is created", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    render(
      <ProductStoreActionButton
        links={[]}
        duplicate
        open={false}
        controls="store-panel-local"
        onToggle={() => {}}
        onReviewDuplicate={onReview}
      />,
    );
    const button = screen.getByRole("button", { name: "بررسی محصول تکراری" });
    expect(screen.queryByRole("button", { name: "انتشار در فروشگاه" })).toBeNull();
    await user.click(button);
    expect(onReview).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the manual update on a linked duplicate, since it creates nothing", () => {
    render(
      <ProductStoreActionButton
        links={[LINKED]}
        duplicate
        open={false}
        controls="store-panel-local"
        onToggle={() => {}}
        onReviewDuplicate={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "به‌روزرسانی دستی" })).toBeTruthy();
  });
});
