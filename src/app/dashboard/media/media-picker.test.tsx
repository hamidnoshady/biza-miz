/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaImageField, MediaPickerDialog } from "./media-picker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MediaPickerDialog & MediaImageField", () => {
  it("requests server-side excludeMime filtering, supports multi-select gallery confirmation, and closes on Escape", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/media?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [
              {
                id: "img-1",
                folderId: null,
                kind: "image",
                fileName: "cover-1.png",
                mimeType: "image/png",
                byteSize: 1200,
                category: null,
                tags: [],
                aiStatus: "none",
                aiLabels: {},
                variant: "original",
                sourceAssetId: null,
                source: "upload",
                createdByAi: false,
                conversationId: null,
                projectId: null,
                deletedAt: null,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
              {
                id: "img-2",
                folderId: null,
                kind: "image",
                fileName: "gallery-2.png",
                mimeType: "image/png",
                byteSize: 1400,
                category: null,
                tags: [],
                aiStatus: "none",
                aiLabels: {},
                variant: "original",
                sourceAssetId: null,
                source: "upload",
                createdByAi: false,
                conversationId: null,
                projectId: null,
                deletedAt: null,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
            ],
            total: 2,
            storage: { ready: true, enhancePriceRial: 0 },
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onClose = vi.fn();
    const onPickMultiple = vi.fn();

    render(
      <MediaPickerDialog
        title="انتخاب چند تصویر از کتابخانه"
        multiple
        onPickMultiple={onPickMultiple}
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "انتخاب چند تصویر از کتابخانه" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await screen.findByText("cover-1.png");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("excludeMime=image%2Fsvg%2Bxml"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fireEvent.click(screen.getByTitle("cover-1.png"));
    fireEvent.click(screen.getByTitle("gallery-2.png"));
    fireEvent.click(screen.getByRole("button", { name: "تأیید انتخاب (۲)" }));

    expect(onPickMultiple).toHaveBeenCalledWith([
      { id: "img-1", fileName: "cover-1.png" },
      { id: "img-2", fileName: "gallery-2.png" },
    ]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("loads a foldered asset directly via GET /api/media/:id when editing from MediaImageField", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/media/foldered-asset-1") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              id: "foldered-asset-1",
              folderId: "folder-abc",
              kind: "image",
              fileName: "folder-hero.png",
              mimeType: "image/png",
              byteSize: 2048,
              category: "محصولات",
              tags: ["ویژه"],
              aiStatus: "none",
              aiLabels: {},
              variant: "original",
              sourceAssetId: null,
              source: "upload",
              createdByAi: false,
              conversationId: null,
              projectId: null,
              deletedAt: null,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
            enhancePriceRial: 5000,
          }),
        };
      }
      if (url === "/api/media/foldered-asset-1/usage") {
        return { ok: true, status: 200, json: async () => ({ usage: { menuItems: [], inventoryItems: [], expenses: [], purchases: [] } }) };
      }
      if (url === "/api/media/foldered-asset-1/collections") {
        return { ok: true, status: 200, json: async () => ({ collections: [] }) };
      }
      if (url === "/api/media/foldered-asset-1/wordpress") {
        return { ok: true, status: 200, json: async () => ({ connections: [] }) };
      }
      if (url === "/api/media/foldered-asset-1/lineage") {
        return { ok: true, status: 200, json: async () => ({ lineage: { ancestors: [], descendants: [] } }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MediaImageField
        label="تصویر اصلی محصول"
        value="foldered-asset-1"
        onChange={() => {}}
        allowEdit
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "ویرایش / هوش مصنوعی" }));
    await screen.findByRole("dialog", { name: "folder-hero.png" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/foldered-asset-1",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
    );
  });
});
