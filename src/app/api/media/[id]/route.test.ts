import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaStorageConfig } from "@/lib/media";
import type { MediaAssetRecord as MediaAsset, MediaAssetUsage } from "@/lib/media-service";
import { roleBasePermissions } from "@/lib/permissions";

vi.mock("@/lib/auth", () => ({
  withTenantScope: <T>(fn: T) => fn,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/media-service", () => ({
  getMediaAsset: vi.fn(),
  getMediaAssetUsage: vi.fn(),
  mediaAssetUsageIsEmpty: vi.fn(),
  mediaAssetUsageIsProtected: vi.fn(),
  softDeleteMediaAsset: vi.fn(),
  deleteMediaAsset: vi.fn(),
  getMediaConfig: vi.fn(),
  MediaAssetProtectedError: class MediaAssetProtectedError extends Error {},
}));

import { DELETE, PATCH } from "./route";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as mediaService from "@/lib/media-service";

const BID = "11111111-1111-1111-1111-111111111111";
const AID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION = {
  sub: "u1",
  email: "u@test.com",
  role: "owner" as const,
  businessId: BID,
  locationId: null,
  fullName: "Owner",
};

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: AID,
    folderId: null,
    kind: "image",
    fileName: "latte.png",
    mimeType: "image/png",
    byteSize: 1024,
    category: "غذا",
    tags: ["نوشیدنی"],
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
    ...over,
  };
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost:3000/api/media/${AID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: AID }) },
  );
}

function del(qs = "") {
  return DELETE(new NextRequest(`http://localhost:3000/api/media/${AID}${qs}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: AID }),
  });
}

const EMPTY_USAGE: MediaAssetUsage = {
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
  hasProtected: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    membership: { id: "m1", role: "owner", permissions: roleBasePermissions("owner") } as never,
    error: null,
  });
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
  vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue(EMPTY_USAGE);
  vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValue(true);
  vi.mocked(mediaService.mediaAssetUsageIsProtected).mockReturnValue(false);
});

describe("PATCH /api/media/[id]", () => {
  it("404s when the asset does not exist in this tenant", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(null);
    expect((await patch({ fileName: "x.png" })).status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("400s on invalid JSON", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset());
    expect((await patch("{not json")).status).toBe(400);
  });

  it("400s missing_fields for a blank rename", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset());
    const res = await patch({ fileName: "   " });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields" });
  });

  it("400s bad_request when the whole body is a no-op", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset());
    const res = await patch({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("404s folder_not_found for a folder outside the tenant, without writing anything", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset());
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never);

    const res = await patch({ folderId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "folder_not_found" });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("clears the folder on an explicit null", async () => {
    vi.mocked(mediaService.getMediaAsset)
      .mockResolvedValueOnce(asset({ folderId: "f1" }))
      .mockResolvedValueOnce(asset({ folderId: null }));

    const res = await patch({ folderId: null });
    expect(res.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("folder_id = $3");
    expect(params).toEqual([AID, BID, null]);
  });

  it("400s on an out-of-range category or tags array", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(asset());
    expect((await patch({ category: 42 })).status).toBe(400);
    expect((await patch({ tags: "not-an-array" })).status).toBe(400);
  });

  it("400s on an unrecognized aiDecision value", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset());
    expect((await patch({ aiDecision: "maybe" })).status).toBe(400);
  });

  it("confirm with no explicit override merges the AI proposal into category/tags and sets ai_status=confirmed", async () => {
    vi.mocked(mediaService.getMediaAsset)
      .mockResolvedValueOnce(
        asset({
          category: "غذا",
          tags: ["نوشیدنی"],
          aiStatus: "pending_review",
          aiLabels: { category: "قهوه", tags: ["نوشیدنی", "گرم"] },
        }),
      )
      .mockResolvedValueOnce(asset({ category: "قهوه", tags: ["نوشیدنی", "گرم"], aiStatus: "confirmed" }));

    const res = await patch({ aiDecision: "confirm" });
    expect(res.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("ai_status = $3");
    expect(sql).toContain("category = $4");
    expect(sql).toContain("tags = $5");
    expect(params).toEqual([AID, BID, "confirmed", "قهوه", ["نوشیدنی", "گرم"]]);
  });

  it("confirm with an explicit category/tags in the same request lets the operator's edit win over the proposal", async () => {
    vi.mocked(mediaService.getMediaAsset)
      .mockResolvedValueOnce(
        asset({ aiStatus: "pending_review", aiLabels: { category: "پیشنهاد", tags: ["پیشنهاد"] } }),
      )
      .mockResolvedValueOnce(asset({ category: "دستی", tags: ["دستی"], aiStatus: "confirmed" }));

    await patch({ aiDecision: "confirm", category: "دستی", tags: ["دستی"] });
    const [, params] = vi.mocked(db.query).mock.calls[0];
    expect(params).toEqual([AID, BID, "confirmed", "دستی", ["دستی"]]);
  });

  it("reject sets ai_status=rejected and never touches category or tags", async () => {
    vi.mocked(mediaService.getMediaAsset)
      .mockResolvedValueOnce(
        asset({ category: "غذا", tags: ["نوشیدنی"], aiStatus: "pending_review", aiLabels: { category: "قهوه", tags: ["گرم"] } }),
      )
      .mockResolvedValueOnce(asset({ aiStatus: "rejected" }));

    await patch({ aiDecision: "reject" });
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("ai_status = $3");
    expect(sql).not.toContain("category =");
    expect(sql).not.toContain("tags =");
    expect(params).toEqual([AID, BID, "rejected"]);
  });
});

describe("DELETE /api/media/[id]", () => {
  it("answers 409 asset_in_use with the usage payload when a replaceable item still uses it", async () => {
    const usage: MediaAssetUsage = {
      ...EMPTY_USAGE,
      menuItems: [{ id: "m1", name: "لته" }],
    };
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValueOnce(usage);
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValueOnce(false);

    const res = await del();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "asset_in_use", usage });
    expect(mediaService.softDeleteMediaAsset).not.toHaveBeenCalled();
  });

  it("force=1 overrides replaceable usage (409 asset_in_use) after verifying usage is not protected", async () => {
    const usage: MediaAssetUsage = {
      ...EMPTY_USAGE,
      menuItems: [{ id: "m1", name: "لته" }],
    };
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValueOnce(usage);
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValueOnce(false);
    vi.mocked(mediaService.mediaAssetUsageIsProtected).mockReturnValueOnce(false);
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValueOnce(true);

    const res = await del("?force=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trashed: true });
    expect(mediaService.getMediaAssetUsage).toHaveBeenCalledWith(AID, {
      viewerUserId: "u1",
      viewerOverride: true,
    });
    expect(mediaService.softDeleteMediaAsset).toHaveBeenCalledWith(BID, AID);
  });

  it("P0 #4: refuses soft-delete, force=1, AND purge=1 with 409 asset_protected when attached to a protected audit record", async () => {
    const protectedUsage: MediaAssetUsage = {
      ...EMPTY_USAGE,
      workspaceDocuments: [{ id: "doc1", name: "قرارداد امضاشده", protected: true }],
      hasProtected: true,
      protectedItems: [
        {
          kind: "workspace_document" as const,
          id: "doc1",
          name: "قرارداد امضاشده",
          reason: "contract_document" as const,
          message: "این فایل به سند قرارداد متصل است و قابل حذف نیست.",
        },
      ],
    };
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue(protectedUsage);
    vi.mocked(mediaService.mediaAssetUsageIsProtected).mockReturnValue(true);

    for (const qs of ["", "?force=1", "?purge=1"]) {
      const res = await del(qs);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("asset_protected");
      expect(body.message).toContain("سند قرارداد");
    }
    expect(mediaService.softDeleteMediaAsset).not.toHaveBeenCalled();
    expect(mediaService.deleteMediaAsset).not.toHaveBeenCalled();
  });

  it("plain delete trashes an unused asset", async () => {
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValueOnce(true);

    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trashed: true });
    expect(mediaService.deleteMediaAsset).not.toHaveBeenCalled();
  });

  it("a repeated trash request on an already-trashed asset is idempotent, not an error", async () => {
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValueOnce(false);
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset({ deletedAt: "2026-06-02T00:00:00.000Z" }));

    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trashed: true });
  });

  it("404s a trash request for an asset that never existed", async () => {
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValueOnce(false);
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(null);
    expect((await del()).status).toBe(404);
  });

  it("purge=1 refuses to hard-delete an asset that is not already in the trash", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset({ deletedAt: null }));

    const res = await del("?purge=1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_in_trash");
    expect(mediaService.deleteMediaAsset).not.toHaveBeenCalled();
  });

  it("purge=1 permanently removes an already-trashed asset", async () => {
    const cfg = {} as MediaStorageConfig;
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(asset({ deletedAt: "2026-06-02T00:00:00.000Z" }));
    vi.mocked(mediaService.getMediaConfig).mockResolvedValueOnce(cfg);
    vi.mocked(mediaService.deleteMediaAsset).mockResolvedValueOnce(true);

    const res = await del("?purge=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, purged: true });
    expect(mediaService.deleteMediaAsset).toHaveBeenCalledWith(BID, AID, cfg);
  });

  it("purge=1 404s for an asset id that does not exist", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValueOnce(null);
    expect((await del("?purge=1")).status).toBe(404);
    expect(mediaService.deleteMediaAsset).not.toHaveBeenCalled();
  });
});
