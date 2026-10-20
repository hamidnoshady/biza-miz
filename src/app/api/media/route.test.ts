import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaStorageConfig } from "@/lib/media";
import type { MediaAssetRecord as MediaAsset } from "@/lib/media-service";

vi.mock("@/lib/auth", () => ({
  withTenantScope: <T>(fn: T) => fn,
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/media-service", () => ({
  addAssetToCollection: vi.fn(),
  assertTenantFolderExists: vi.fn(),
  dedupeOrStoreMediaAsset: vi.fn(),
  getMediaAsset: vi.fn(),
  getMediaAssetUsage: vi.fn(),
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(),
  listMediaAssets: vi.fn(),
  listMediaFacets: vi.fn(),
  listMediaFolders: vi.fn(),
  mediaAssetUsageIsEmpty: vi.fn(),
  mediaAssetUsageIsProtected: vi.fn(),
  mediaUsageFor: vi.fn(),
  softDeleteMediaAsset: vi.fn(),
  MediaAssetProtectedError: class MediaAssetProtectedError extends Error {
    usage: { protectedItems?: Array<{ kind: string; id: string; name: string; reason: string; message: string }> };
    constructor(usage: { protectedItems?: Array<{ kind: string; id: string; name: string; reason: string; message: string }> }) {
      super("asset_protected");
      this.usage = usage;
    }
  },
  MediaInvalidFolderError: class MediaInvalidFolderError extends Error {},
  MediaFolderNotFoundError: class MediaFolderNotFoundError extends Error {},
}));

import { GET, PATCH, POST } from "./route";
import * as auth from "@/lib/auth";
import * as mediaService from "@/lib/media-service";

const BID = "11111111-1111-1111-1111-111111111111";
const FID = "22222222-2222-2222-2222-222222222222";
const SESSION = {
  sub: "u1",
  email: "u@test.com",
  role: "owner" as const,
  businessId: BID,
  locationId: null,
  fullName: "Owner",
};
const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

function assetFixture(): MediaAsset {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    folderId: FID,
    kind: "image",
    fileName: "item.png",
    mimeType: "image/png",
    byteSize: VALID_PNG.byteLength,
    category: null,
    tags: [],
    aiStatus: "none",
    aiLabels: {},
    variant: "original",
    sourceAssetId: null,
    transformOps: [],
    source: "upload",
    createdByAi: false,
    conversationId: null,
    projectId: null,
    deletedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    membership: { id: "m1", role: "owner", permissions: new Set() } as never,
    error: null,
  });
  vi.mocked(mediaService.getMediaConfig).mockResolvedValue({} as never);
  vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(true);
  vi.mocked(mediaService.assertTenantFolderExists).mockImplementation(async (_bid, fid) => fid ?? null);
});

describe("GET /api/media — server-side excludeMime & filtering (P2 #11)", () => {
  it("passes parsed excludeMime array down to listMediaAssets", async () => {
    vi.mocked(mediaService.listMediaAssets).mockResolvedValueOnce({ assets: [], total: 0 });
    vi.mocked(mediaService.listMediaFolders).mockResolvedValueOnce([]);
    vi.mocked(mediaService.listMediaFacets).mockResolvedValueOnce({ categories: [], tags: [] });
    vi.mocked(mediaService.mediaUsageFor).mockResolvedValueOnce({
      totalBytes: 0,
      assetCount: 0,
      byKind: { image: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 }, document: { count: 0, bytes: 0 } },
    });

    const res = await GET(
      new NextRequest("http://localhost:3000/api/media?kind=image&excludeMime=image/svg%2Bxml&limit=40&offset=0"),
    );
    expect(res.status).toBe(200);
    expect(mediaService.listMediaAssets).toHaveBeenCalledWith(BID, {
      folderId: "any",
      kind: "image",
      excludeMime: ["image/svg+xml"],
      limit: 40,
      offset: 0,
    });
  });
});

describe("POST /api/media — pre-storage folder validation, streaming upload, and atomic dedupe (P0 #3, P1 #6, P2 #10)", () => {
  it("P0 #3: rejects malformed folderId with 400 invalid_folder BEFORE reading/storing bytes (never 502)", async () => {
    vi.mocked(mediaService.assertTenantFolderExists).mockRejectedValueOnce(
      new mediaService.MediaInvalidFolderError(),
    );
    const form = new FormData();
    form.set("file", new File([VALID_PNG], "item.png", { type: "image/png" }));
    form.set("folderId", "not-a-uuid");

    const res = await POST(new NextRequest("http://localhost:3000/api/media", { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_folder");
    expect(mediaService.dedupeOrStoreMediaAsset).not.toHaveBeenCalled();
  });

  it("P0 #3: rejects cross-tenant or nonexistent folderId with 404 folder_not_found BEFORE storing bytes", async () => {
    vi.mocked(mediaService.assertTenantFolderExists).mockRejectedValueOnce(
      new mediaService.MediaFolderNotFoundError(),
    );
    const form = new FormData();
    form.set("file", new File([VALID_PNG], "item.png", { type: "image/png" }));
    form.set("folderId", "99999999-9999-9999-9999-999999999999");

    const res = await POST(new NextRequest("http://localhost:3000/api/media", { method: "POST", body: form }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("folder_not_found");
    expect(mediaService.dedupeOrStoreMediaAsset).not.toHaveBeenCalled();
  });

  it("P1 #6: rejects oversized Content-Length upfront with 413 before parsing multipart payload", async () => {
    const res = await POST(
      new NextRequest("http://localhost:3000/api/media", {
        method: "POST",
        headers: { "content-length": String(500 * 1024 * 1024) },
      }),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("file_too_large");
  });

  it("P1 #6 & P2 #10: streams upload chunks, verifies magic signature, computes exact SHA-256, and surfaces folderMismatch metadata", async () => {
    vi.mocked(mediaService.dedupeOrStoreMediaAsset).mockResolvedValueOnce({
      asset: assetFixture(),
      reused: true,
      action: "reused",
      requestedFolderId: null,
      folderMismatch: true,
    });

    const form = new FormData();
    form.set("file", new File([VALID_PNG], "item.png", { type: "image/png" }));

    const res = await POST(new NextRequest("http://localhost:3000/api/media", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(body.folderMismatch).toBe(true);
    expect(mediaService.dedupeOrStoreMediaAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        sha256: createHash("sha256").update(VALID_PNG).digest("hex"),
        byteSize: VALID_PNG.byteLength,
        onDuplicate: "reuse",
      }),
    );
  });

  it("P2 #12: PATCH /api/media bounds batch size <= 200 and validates protected, replaceable, and cross-tenant folder rules server-side", async () => {
    const oversized = await PATCH(
      new NextRequest("http://localhost:3000/api/media", {
        method: "PATCH",
        body: JSON.stringify({
          action: "trash",
          ids: Array.from({ length: 201 }, (_, idx) => `id-${idx}`),
        }),
      }),
    );
    expect(oversized.status).toBe(400);
    expect((await oversized.json()).error).toBe("invalid_batch_size");

    vi.mocked(mediaService.assertTenantFolderExists).mockRejectedValueOnce(
      new mediaService.MediaFolderNotFoundError(),
    );
    const foreignFolder = await PATCH(
      new NextRequest("http://localhost:3000/api/media", {
        method: "PATCH",
        body: JSON.stringify({
          action: "move_folder",
          ids: ["a-1"],
          folderId: "99999999-9999-9999-9999-999999999999",
        }),
      }),
    );
    expect(foreignFolder.status).toBe(404);
    expect((await foreignFolder.json()).error).toBe("folder_not_found");

    vi.mocked(mediaService.getMediaAsset).mockImplementation(async (_bid, id) =>
      id === "missing" ? null : assetFixture(),
    );
    vi.mocked(mediaService.getMediaAssetUsage).mockImplementation(async (id) => {
      if (id === "prot") {
        return {
          menuItems: [],
          inventoryItems: [],
          expenses: [],
          purchases: [],
          parties: [],
          vehicles: [],
          workspaceDocuments: [{ id: "d1", name: "قرارداد امضاشده" }],
          transfers: [],
          products: [],
          protectedItems: [
            {
              kind: "workspace_document",
              id: "d1",
              name: "قرارداد امضاشده",
              reason: "approved",
              message: "متصل به سند تأییدشدهٔ Workspace",
            },
          ],
        };
      }
      if (id === "used") {
        return {
          menuItems: [],
          inventoryItems: [],
          expenses: [],
          purchases: [],
          parties: [],
          vehicles: [],
          workspaceDocuments: [{ id: "d2", name: "پیش‌نویس یادداشت" }],
          transfers: [],
          products: [],
          protectedItems: [],
        };
      }
      return {
        menuItems: [],
        inventoryItems: [],
        expenses: [],
        purchases: [],
        parties: [],
        vehicles: [],
        workspaceDocuments: [],
        transfers: [],
        products: [],
        protectedItems: [],
      };
    });
    vi.mocked(mediaService.mediaAssetUsageIsProtected).mockImplementation(
      (u) => (u.protectedItems?.length ?? 0) > 0,
    );
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockImplementation(
      (u) => (u.workspaceDocuments?.length ?? 0) === 0 && (u.protectedItems?.length ?? 0) === 0,
    );
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValue(true);

    const batchRes = await PATCH(
      new NextRequest("http://localhost:3000/api/media", {
        method: "PATCH",
        body: JSON.stringify({
          action: "trash",
          ids: ["ok-1", "prot", "used", "missing"],
          force: false,
        }),
      }),
    );
    expect(batchRes.status).toBe(200);
    const batchBody = await batchRes.json();
    expect(batchBody.succeededIds).toEqual(["ok-1"]);
    expect(batchBody.protectedItems).toEqual([
      { id: "prot", message: "متصل به سند تأییدشدهٔ Workspace" },
    ]);
    expect(batchBody.replaceableItems).toHaveLength(1);
    expect(batchBody.replaceableItems[0].id).toBe("used");
    expect(batchBody.failedItems).toEqual([{ id: "missing", message: "فایل یافت نشد." }]);
    expect(mediaService.softDeleteMediaAsset).toHaveBeenCalledTimes(1);
  });
});
