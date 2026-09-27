// @vitest-environment jsdom

/**
 * The crop tool inside the asset drawer (migration 0175's `/transform`
 * backend already existed; this is the drag-to-select UI on top of it).
 *
 * What matters is not that a rectangle is drawn but that the numbers it
 * produces are right: the operator drags in *displayed* CSS pixels over a
 * possibly-scaled-down `<img>`, and the request the drawer sends must be in
 * the image's *natural* pixels — the same space `applyMediaTransform`
 * measures server-side after its own EXIF auto-orient. A scale bug here would
 * silently crop the wrong region with no error to notice.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetDrawer, MediaManager, type AssetRow } from "./media-manager";

afterEach(cleanup);

function baseAsset(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset-1",
    folderId: null,
    kind: "image",
    fileName: "product.jpg",
    mimeType: "image/jpeg",
    byteSize: 12345,
    category: null,
    tags: [],
    aiStatus: "none",
    aiLabels: {},
    variant: "original",
    sourceAssetId: null,
    source: "upload",
    createdByAi: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A 400×200-natural image displayed at 200×100 — a plain 2× downscale, the
 * common case (a big upload shown small in the drawer). */
function stubImageGeometry(img: HTMLImageElement) {
  Object.defineProperty(img, "naturalWidth", {
    value: 400,
    configurable: true,
  });
  Object.defineProperty(img, "naturalHeight", {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(img, "clientWidth", { value: 200, configurable: true });
  Object.defineProperty(img, "clientHeight", {
    value: 100,
    configurable: true,
  });
  img.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      right: 210,
      bottom: 120,
      x: 10,
      y: 20,
      toJSON() {},
    }) as DOMRect;
}

function drag(
  overlay: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  act(() => {
    overlay.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        clientX: from.x,
        clientY: from.y,
      }),
    );
    overlay.dispatchEvent(
      new window.PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: to.x,
        clientY: to.y,
      }),
    );
    overlay.dispatchEvent(
      new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
    );
  });
}

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ message: "ok" }),
  });
}

describe("AssetDrawer WordPress push", () => {
  function wpFetch(connections: unknown[]) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/media/asset-1/usage") {
        return { ok: true, status: 200, json: async () => ({ usage: { menuItems: [], inventoryItems: [], expenses: [], purchases: [] } }) };
      }
      if (url === "/api/media/asset-1/collections") {
        return { ok: true, status: 200, json: async () => ({ collections: [] }) };
      }
      if (url === "/api/media/asset-1/wordpress" && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => ({ connections }) };
      }
      if (url === "/api/media/asset-1/wordpress" && init?.method === "POST") {
        return { ok: true, status: 201, json: async () => ({ ok: true, mapping: { status: "pending" } }) };
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
  }

  it("hides the section entirely for a business with no WooCommerce connections", async () => {
    const fetchMock = wpFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={0} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/media/asset-1/wordpress")).toBe(true),
    );
    expect(screen.queryByText("ارسال به وردپرس")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("never fetches a push list for a document — the feature is scoped to image/video", async () => {
    const fetchMock = wpFetch([{ id: "conn-1", name: "فروشگاه من", canPush: true, mapping: null }]);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AssetDrawer
        asset={baseAsset({ kind: "document", mimeType: "application/pdf" })}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/media/asset-1/usage")).toBe(true),
    );
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/media/asset-1/wordpress")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("shows each connection's push eligibility and current sync status, and disables the button when the plugin cannot receive media", async () => {
    const fetchMock = wpFetch([
      { id: "conn-1", name: "فروشگاه فعال", canPush: true, mapping: null },
      { id: "conn-2", name: "فروشگاه قدیمی", canPush: false, mapping: null },
      { id: "conn-3", name: "فروشگاه همگام‌شده", canPush: true, mapping: { status: "synced", wpUrl: "https://shop.example.com/x.png", lastError: null } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={0} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    await screen.findByText("فروشگاه فعال");
    expect(screen.getByText("فروشگاه قدیمی")).not.toBeNull();
    expect(screen.getByText("همگام‌شده")).not.toBeNull();
    const link = screen.getByRole("link", { name: "مشاهده در سایت" });
    expect(link.getAttribute("href")).toBe("https://shop.example.com/x.png");

    const buttons = screen.getAllByRole("button", { name: /ارسال/ });
    // «فروشگاه قدیمی» cannot receive media — its button is disabled.
    const disabled = buttons.find((b) => b.hasAttribute("disabled"));
    expect(disabled).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("pushing queues the job and refreshes the connection list", async () => {
    const fetchMock = wpFetch([{ id: "conn-1", name: "فروشگاه فعال", canPush: true, mapping: null }]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={0} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    const button = await screen.findByRole("button", { name: "ارسال" });
    await act(async () => {
      await user.click(button);
    });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/media/asset-1/wordpress" && init?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(call![1]?.body).toBe(JSON.stringify({ connectionId: "conn-1" }));
    });
    await screen.findByText("به صف ارسال به وردپرس اضافه شد؛ وضعیت پس از دریافت پاسخ افزونه به‌روزرسانی می‌شود.");
    vi.unstubAllGlobals();
  });
});

/**
 * The three lightweight AI edit operations beyond crop/rotate/resize/enhance
 * (migration 0176): background removal, upscale, variations. Each is a
 * non-destructive POST that must only be offered on an 'original' asset (an
 * already-derived one is not offered a second round in this drawer), and
 * each must surface the server's own message rather than a generic one.
 */
describe("AssetDrawer AI edit operations", () => {
  function aiEditFetch(overrides: Record<string, { status: number; body: unknown }> = {}) {
    return vi.fn(async (url: string) => {
      if (url === "/api/media/asset-1/usage") {
        return { ok: true, status: 200, json: async () => ({ usage: { menuItems: [], inventoryItems: [], expenses: [], purchases: [] } }) };
      }
      if (url === "/api/media/asset-1/collections") {
        return { ok: true, status: 200, json: async () => ({ collections: [] }) };
      }
      if (url === "/api/media/asset-1/wordpress") {
        return { ok: true, status: 200, json: async () => ({ connections: [] }) };
      }
      const hit = overrides[url];
      if (hit) return { ok: hit.status < 400, status: hit.status, json: async () => hit.body };
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("offers background removal, upscale, and variations only on an original asset, never on an already-derived one", async () => {
    vi.stubGlobal("fetch", aiEditFetch());
    render(
      <AssetDrawer asset={baseAsset({ variant: "original" })} folders={[]} collections={[]} enhancePriceRial={0} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    expect(await screen.findByText("حذف پس‌زمینه")).not.toBeNull();
    expect(screen.getByText("بزرگ‌نمایی")).not.toBeNull();
    expect(screen.getByText(/ساخت ۳ تنوع از تصویر/)).not.toBeNull();
    vi.unstubAllGlobals();
    cleanup();

    vi.stubGlobal("fetch", aiEditFetch());
    render(
      <AssetDrawer asset={baseAsset({ variant: "bg_removed" })} folders={[]} collections={[]} enhancePriceRial={0} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    await screen.findByText("ذخیره");
    expect(screen.queryByText("حذف پس‌زمینه")).toBeNull();
    expect(screen.queryByText("بزرگ‌نمایی")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("removing the background posts to /bg-remove and surfaces the success notice", async () => {
    vi.stubGlobal("fetch", aiEditFetch({ "/api/media/asset-1/bg-remove": { status: 201, body: { ok: true } } }));
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={5000} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    fireEvent.click(await screen.findByText(/حذف پس‌زمینه/));
    await screen.findByText(/تصویر بدون پس‌زمینه ساخته و به کتابخانه اضافه شد/);
    vi.unstubAllGlobals();
  });

  it("surfaces the server's own rejection message for a failed upscale rather than a generic one", async () => {
    vi.stubGlobal(
      "fetch",
      aiEditFetch({ "/api/media/asset-1/upscale": { status: 402, body: { message: "موجودی کیف پول کافی نیست." } } }),
    );
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={5000} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    fireEvent.click(await screen.findByText(/بزرگ‌نمایی/));
    await screen.findByText("موجودی کیف پول کافی نیست.");
    vi.unstubAllGlobals();
  });

  it("variations reports how many alternates the server actually created", async () => {
    vi.stubGlobal(
      "fetch",
      aiEditFetch({
        "/api/media/asset-1/variations": { status: 201, body: { ok: true, assets: [{ id: "v1" }, { id: "v2" }] } },
      }),
    );
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={5000} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    fireEvent.click(await screen.findByText(/ساخت ۳ تنوع از تصویر/));
    await screen.findByText(/۲ تنوع از تصویر ساخته و به کتابخانه اضافه شد/);
    vi.unstubAllGlobals();
  });
});

/**
 * The version-history panel (Section V's disclosed "no version-history UI"
 * gap, closed this session): `getMediaAssetLineage`'s ancestor chain and
 * direct-descendant list, rendered lazily the same way the usage panel next
 * to it already is.
 */
describe("AssetDrawer version history (lineage)", () => {
  function lineageFetch(lineage: { ancestors: unknown[]; descendants: unknown[] }) {
    return vi.fn(async (url: string) => {
      if (url === "/api/media/asset-1/usage") {
        return { ok: true, status: 200, json: async () => ({ usage: { menuItems: [], inventoryItems: [], expenses: [], purchases: [] } }) };
      }
      if (url === "/api/media/asset-1/collections") {
        return { ok: true, status: 200, json: async () => ({ collections: [] }) };
      }
      if (url === "/api/media/asset-1/wordpress") {
        return { ok: true, status: 200, json: async () => ({ connections: [] }) };
      }
      if (url === "/api/media/asset-1/lineage") {
        return { ok: true, status: 200, json: async () => ({ lineage }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("shows no version-history panel at all for an asset with no ancestors and no descendants", async () => {
    vi.stubGlobal("fetch", lineageFetch({ ancestors: [], descendants: [] }));
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={0} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/media/asset-1/lineage")).toBe(true),
    );
    expect(screen.queryByText(/سابقهٔ نسخه/)).toBeNull();
    expect(screen.queryByText(/نسخه‌های ساخته‌شده از این فایل/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("renders the full ancestor chain root-first, ending on the open asset itself, each ancestor linked to its own file", async () => {
    vi.stubGlobal(
      "fetch",
      lineageFetch({
        ancestors: [
          { id: "root-1", fileName: "اصلی.png", variant: "original" },
          { id: "crop-1", fileName: "برش.png", variant: "transformed" },
        ],
        descendants: [],
      }),
    );
    render(
      <AssetDrawer
        asset={baseAsset({ fileName: "بزرگ‌نمایی.png", variant: "upscaled" })}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );
    await screen.findByText(/سابقهٔ نسخه/);
    const rootLink = screen.getByRole("link", { name: /اصلی\.png/ });
    expect(rootLink.getAttribute("href")).toBe("/api/media/root-1/file");
    const cropLink = screen.getByRole("link", { name: /برش\.png/ });
    expect(cropLink.getAttribute("href")).toBe("/api/media/crop-1/file");
    // The open asset itself is named in the chain but is not a link — it is
    // already open, right here, in this same drawer.
    const lineagePanel = (await screen.findByText(/سابقهٔ نسخه/)).closest("p") as HTMLElement;
    expect(within(lineagePanel).getByText(/بزرگ‌نمایی\.png/).closest("a")).toBeNull();
    expect(within(lineagePanel).queryByRole("link", { name: /بزرگ‌نمایی\.png/ })).toBeNull();
  });

  it("lists every direct descendant, each linked to its own file", async () => {
    vi.stubGlobal(
      "fetch",
      lineageFetch({
        ancestors: [],
        descendants: [
          { id: "child-1", fileName: "برش.png", variant: "transformed" },
          { id: "child-2", fileName: "بزرگ‌نمایی.png", variant: "upscaled" },
        ],
      }),
    );
    render(
      <AssetDrawer asset={baseAsset()} folders={[]} collections={[]} enhancePriceRial={0} onClose={() => {}} onUpdated={() => {}} onDeleted={() => {}} />,
    );
    await screen.findByText(/نسخه‌های ساخته‌شده از این فایل/);
    const cropLink = screen.getByRole("link", { name: /برش\.png/ });
    expect(cropLink.getAttribute("href")).toBe("/api/media/child-1/file");
    const upscaleLink = screen.getByRole("link", { name: /بزرگ‌نمایی\.png/ });
    expect(upscaleLink.getAttribute("href")).toBe("/api/media/child-2/file");
  });
});

describe("AssetDrawer crop tool", () => {
  it("hides the crop button for non-image assets", () => {
    render(
      <AssetDrawer
        asset={baseAsset({ kind: "document", mimeType: "application/pdf" })}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );
    expect(screen.queryByText("برش تصویر")).toBeNull();
  });

  it("keeps «اعمال برش» disabled until a real rectangle is drawn, then sends natural-pixel coordinates", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AssetDrawer
        asset={baseAsset()}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );

    const img = screen.getByAltText("product.jpg") as HTMLImageElement;
    stubImageGeometry(img);

    fireEvent.click(screen.getByText("برش تصویر"));
    const applyButton = screen.getByText("اعمال برش").closest("button")!;
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);

    const overlay = img.parentElement!;

    // A drag smaller than the 12px minimum must not arm the apply button —
    // an accidental click-and-release must not be treated as "crop everything".
    drag(overlay, { x: 10 + 20, y: 20 + 20 }, { x: 10 + 24, y: 20 + 22 });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);

    // Drag from displayed (30,20) to (110,70) inside a 200×100-displayed,
    // 400×200-natural image whose rect origin is (10,20): a clean 2× scale
    // puts the natural-pixel crop at (60,40) sized 160×100.
    drag(overlay, { x: 10 + 30, y: 20 + 20 }, { x: 10 + 110, y: 20 + 70 });
    expect((applyButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(applyButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/asset-1/transform",
      expect.objectContaining({ method: "POST" }),
    );
    const call = fetchMock.mock.calls.find(
      ([url]) => url === "/api/media/asset-1/transform",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toEqual({
      operation: "crop",
      params: { x: 60, y: 40, width: 160, height: 100 },
    });

    // Applying resets crop mode — the button set collapses back to "برش تصویر".
    expect(screen.queryByText("اعمال برش")).toBeNull();
    expect(screen.getByText("برش تصویر")).not.toBeNull();
  });

  it("«انصراف» discards the drawn rectangle without calling the API", () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AssetDrawer
        asset={baseAsset()}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );

    const img = screen.getByAltText("product.jpg") as HTMLImageElement;
    stubImageGeometry(img);

    fireEvent.click(screen.getByText("برش تصویر"));
    drag(
      img.parentElement!,
      { x: 10 + 30, y: 20 + 20 },
      { x: 10 + 110, y: 20 + 70 },
    );
    expect(
      (screen.getByText("اعمال برش").closest("button") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByText("انصراف"));

    expect(screen.queryByText("اعمال برش")).toBeNull();
    // The drawer's own mount-time fetches (collections, usage) are fine —
    // what "انصراف" must never trigger is a call to the transform endpoint.
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === "/api/media/asset-1/transform",
      ),
    ).toBe(false);
  });
});

/**
 * The library page's own upload flow (`MediaManager`), now driven by the
 * shared `uploadFiles` engine (`src/lib/media-uploader.ts`) instead of a
 * bare sequential `fetch` loop — Section J of `MEDIA_LIBRARY_REPORT.md`
 * named the missing bounded-concurrency/retry/cancel manager as the largest
 * unattempted gap. The engine's own pool/retry/cancel behavior is covered by
 * `media-uploader.test.ts`; what this suite protects is the *wiring*: a real
 * file selection produces a visible per-file progress row, a duplicate is
 * reported distinctly from a fresh store, and a failed upload surfaces its
 * server message rather than a silent no-op.
 */
describe("MediaManager upload panel", () => {
  function libraryPayload(overrides: Record<string, unknown> = {}) {
    return {
      assets: [],
      total: 0,
      folders: [],
      facets: { categories: [], tags: [] },
      usage: { totalBytes: 0, assetCount: 0 },
      storage: {
        ready: true,
        billingEnabled: false,
        dailyFlatRial: 0,
        dailyPerGbRial: 0,
        freeQuotaMb: 0,
        enhancePriceRial: 0,
      },
      ...overrides,
    };
  }

  function routeFetch(handlers: {
    upload: (file: File) => { status: number; body: unknown };
  }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/media?")) {
        return new Response(JSON.stringify(libraryPayload()), { status: 200 });
      }
      if (url === "/api/media/collections") {
        return new Response(JSON.stringify({ collections: [] }), {
          status: 200,
        });
      }
      if (url === "/api/media" && init?.method === "POST") {
        const form = init.body as FormData;
        const file = form.get("file") as File;
        const { status, body } = handlers.upload(file);
        return new Response(JSON.stringify(body), { status });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("shows one progress row per selected file and separates a fresh store from a reused duplicate", async () => {
    const fetchMock = routeFetch({
      upload: (file) =>
        file.name === "dup.png"
          ? {
              status: 200,
              body: {
                asset: { id: "dup-id", fileName: "dup.png" },
                duplicate: true,
              },
            }
          : {
              status: 200,
              body: { asset: { id: `id-${file.name}`, fileName: file.name } },
            },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MediaManager />);
    await screen.findByText("بارگذاری فایل");

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const fresh = new File(["a"], "fresh.png", { type: "image/png" });
    const dup = new File(["b"], "dup.png", { type: "image/png" });
    await act(async () => {
      await userEvent.upload(input, [fresh, dup]);
    });

    await act(async () => {
      await waitFor(() => {
        expect(
          screen.getByText("fresh.png").parentElement?.textContent,
        ).toContain("موفق");
        expect(
          screen.getByText("dup.png").parentElement?.textContent,
        ).toContain("موفق");
      });
    });

    // The two files went through the *same* endpoint the manager always
    // used, one request each — the new engine changes concurrency/retry
    // policy, not the wire contract.
    const uploadCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/media" && (init as RequestInit)?.method === "POST",
    );
    expect(uploadCalls).toHaveLength(2);

    await act(async () => {
      await waitFor(() => {
        expect(screen.getByText(/۱ فایل ذخیره شد/)).not.toBeNull();
        expect(
          screen.getByText(/۱ فایل از قبل در کتابخانه بود/),
        ).not.toBeNull();
      });
    });
  });

  it("surfaces the server's rejection message for a failed file instead of silently dropping it", async () => {
    // A file the client happily declares as image/png but the server's
    // byte-signature check rejects (bytes don't match the declared type) —
    // a 422 is not retryable, so this must appear as one attempt, not a
    // silent retry loop.
    const fetchMock = routeFetch({
      upload: () => ({ status: 422, body: { message: "نوع فایل مجاز نیست." } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MediaManager />);
    await screen.findByText("بارگذاری فایل");

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const bad = new File(["x"], "bad.png", { type: "image/png" });
    await act(async () => {
      await userEvent.upload(input, [bad]);
    });

    await act(async () => {
      await waitFor(() => {
        expect(
          screen.getByText("bad.png").parentElement?.textContent,
        ).toContain("ناموفق");
      });
    });
    // The failure count must survive `upload()`'s own `reload()` call — a
    // real bug this test caught: `reload()`'s underlying `load()` clears the
    // shared `error` state on every successful library refresh, which used
    // to wipe an upload-failure message before the operator ever saw it
    // (every *other* mutating action in this screen only calls `reload()`
    // on its own success path, so it never collided with a fresh error the
    // way a partially-failed upload batch does). The summary now goes
    // through `notice`, which `load()` never touches.
    await act(async () => {
      await waitFor(() => {
        expect(screen.getByText(/۱ فایل بارگذاری نشد/)).not.toBeNull();
      });
    });

    const uploadCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/media" && (init as RequestInit)?.method === "POST",
    );
    expect(uploadCalls).toHaveLength(1);
  });

  it("«لغو بارگذاری» stops the batch — files already in flight are aborted, files not yet started never call the API", async () => {
    // 5 files against the manager's default concurrency (3): 3 start
    // immediately, 2 sit queued. None of the 3 in-flight requests ever
    // resolves on its own — only an abort (real fetch's own behavior,
    // mirrored here) settles them — so every outcome in this test is
    // attributable to cancel(), not to a race with a mock timer.
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/media?"))
        return Promise.resolve(
          new Response(JSON.stringify(libraryPayload()), { status: 200 }),
        );
      if (url === "/api/media/collections")
        return Promise.resolve(
          new Response(JSON.stringify({ collections: [] }), { status: 200 }),
        );
      if (url === "/api/media" && init?.method === "POST") {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MediaManager />);
    await screen.findByText("بارگذاری فایل");

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const files = Array.from(
      { length: 5 },
      (_, i) => new File([String(i)], `f${i}.png`, { type: "image/png" }),
    );
    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = userEvent.upload(input, files);
    });

    await screen.findByText("لغو بارگذاری");
    fireEvent.click(screen.getByText("لغو بارگذاری"));

    await act(async () => {
      await uploadPromise;
    });

    await act(async () => {
      await waitFor(() => {
        expect(screen.queryAllByText("لغو شد")).toHaveLength(5);
      });
    });
    // The batch settled — no lingering "لغو بارگذاری" affordance for a
    // finished upload.
    expect(screen.queryByText("لغو بارگذاری")).toBeNull();
    const uploadCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/media" && (init as RequestInit)?.method === "POST",
    );
    // Only the 3 that actually started ever reached the network; the 2
    // still queued when cancel() fired never called fetch at all.
    expect(uploadCalls).toHaveLength(3);
  });
});

/**
 * The visual folder explorer (the whole tree, not just the current level)
 * and the active-filter chip row — both new UI over data the manager
 * already fetched, no new endpoint involved.
 */
describe("MediaManager folder explorer and active-filter chips", () => {
  function libraryPayload(overrides: Record<string, unknown> = {}) {
    return {
      assets: [],
      total: 0,
      folders: [
        { id: "f-root", parentId: null, name: "تصاویر", assetCount: 3 },
        { id: "f-child", parentId: "f-root", name: "تابستان", assetCount: 1 },
      ],
      facets: { categories: ["نوشیدنی"], tags: ["ویژه"] },
      usage: { totalBytes: 0, assetCount: 0 },
      storage: {
        ready: true,
        billingEnabled: false,
        dailyFlatRial: 0,
        dailyPerGbRial: 0,
        freeQuotaMb: 0,
        enhancePriceRial: 0,
      },
      ...overrides,
    };
  }

  function routeFetch() {
    return vi.fn(async (url: string) => {
      if (url.startsWith("/api/media?")) {
        return new Response(JSON.stringify(libraryPayload()), { status: 200 });
      }
      if (url === "/api/media/collections") {
        return new Response(JSON.stringify({ collections: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("renders the whole folder hierarchy at once and lets you jump straight into a nested child", async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<MediaManager />);
    await screen.findByText("کاوشگر پوشه‌ها (نمای درختی)");

    const tree = screen.getByRole("list", { name: "درخت پوشه‌ها" });
    // Both the parent and its nested child are visible without any extra
    // navigation click — a real tree, not a one-level-at-a-time picker.
    expect(within(tree).getByText("تصاویر")).not.toBeNull();
    expect(within(tree).getByText("تابستان")).not.toBeNull();

    fetchMock.mockClear();
    fireEvent.click(within(tree).getByText("تابستان"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => (url as string).startsWith("/api/media?"));
      expect(call).toBeDefined();
      expect((call![0] as string)).toContain("folderId=f-child");
    });
  });

  it("collapsing a node hides its children until it is expanded again", async () => {
    vi.stubGlobal("fetch", routeFetch());
    render(<MediaManager />);
    await screen.findByText("کاوشگر پوشه‌ها (نمای درختی)");

    const tree = screen.getByRole("list", { name: "درخت پوشه‌ها" });
    expect(within(tree).getByText("تابستان")).not.toBeNull();

    fireEvent.click(within(tree).getByLabelText("بستن پوشهٔ تصاویر"));
    expect(within(tree).queryByText("تابستان")).toBeNull();

    fireEvent.click(within(tree).getByLabelText("بازکردن پوشهٔ تصاویر"));
    expect(within(tree).getByText("تابستان")).not.toBeNull();
  });

  it("shows an active-filter chip for a chosen category and clears just that filter on ✕", async () => {
    vi.stubGlobal("fetch", routeFetch());
    render(<MediaManager />);
    await screen.findByText("کاوشگر پوشه‌ها (نمای درختی)");

    expect(screen.queryByText("فیلترهای فعال:")).toBeNull();

    const categorySelect = screen.getByDisplayValue("همهٔ دسته‌بندی‌ها");
    fireEvent.change(categorySelect, { target: { value: "نوشیدنی" } });

    await screen.findByText("دسته: نوشیدنی");
    expect(screen.getByText("فیلترهای فعال:")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("حذف فیلتر: دسته: نوشیدنی"));

    await waitFor(() => {
      expect(screen.queryByText("دسته: نوشیدنی")).toBeNull();
    });
    expect(screen.getByDisplayValue("همهٔ دسته‌بندی‌ها")).not.toBeNull();
  });

  it("\"پاک کردن همهٔ فیلترها\" clears every active filter at once", async () => {
    vi.stubGlobal("fetch", routeFetch());
    render(<MediaManager />);
    await screen.findByText("کاوشگر پوشه‌ها (نمای درختی)");

    fireEvent.change(screen.getByDisplayValue("همهٔ دسته‌بندی‌ها"), { target: { value: "نوشیدنی" } });
    fireEvent.change(screen.getByDisplayValue("همهٔ برچسب‌ها"), { target: { value: "ویژه" } });
    await screen.findByText("پاک کردن همهٔ فیلترها");

    fireEvent.click(screen.getByText("پاک کردن همهٔ فیلترها"));

    await waitFor(() => {
      expect(screen.queryByText("فیلترهای فعال:")).toBeNull();
    });
    expect(screen.getByDisplayValue("همهٔ دسته‌بندی‌ها")).not.toBeNull();
    expect(screen.getByDisplayValue("همهٔ برچسب‌ها")).not.toBeNull();
  });
});
