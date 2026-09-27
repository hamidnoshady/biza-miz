import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as mediaService from "@/lib/media-service";
import { DELETE, PATCH } from "./route";

/**
 * `PATCH`'s `aiDecision` branch is the actual persistence half of the
 * pending_review/confirmed/rejected auto-tagging review workflow the
 * platform spec calls for (`/detect` writes the proposal; this is the only
 * place anything ever leaves `pending_review`) — and, until now, it had no
 * test of its own anywhere in the repo. `DELETE`'s trash/force/purge
 * three-way branch had none either.
 */

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/media-service", () => ({
  deleteMediaAsset: vi.fn(),
  getMediaAsset: vi.fn(),
  getMediaAssetUsage: vi.fn(),
  getMediaConfig: vi.fn(),
  mediaAssetUsageIsEmpty: vi.fn(),
  softDeleteMediaAsset: vi.fn(),
}));

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "user-1", role: "owner" };
const ASSET_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const FOLDER_ID = "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15";

function baseAsset(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ASSET_ID,
    folderId: null,
    kind: "image",
    fileName: "product.png",
    category: null,
    tags: [] as string[],
    aiStatus: "none",
    aiLabels: {},
    deletedAt: null,
    ...overrides,
  };
}

function ctx() {
  return { params: Promise.resolve({ id: ASSET_ID }) };
}

function patchReq(body: unknown): NextRequest {
  return new Request(`http://localhost:3000/api/media/${ASSET_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function deleteReq(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/media/${ASSET_ID}${query}`, { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(mediaService.getMediaAsset).mockResolvedValue(baseAsset() as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
});

describe("PATCH /api/media/[id]", () => {
  it("404s when the asset does not exist in this tenant", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(null);
    const res = await PATCH(patchReq({ fileName: "x.png" }), ctx());
    expect(res.status).toBe(404);
  });

  it("400s on invalid JSON", async () => {
    const bad = new Request(`http://x`, { method: "PATCH", body: "{not json" }) as unknown as NextRequest;
    const res = await PATCH(bad, ctx());
    expect(res.status).toBe(400);
  });

  it("400s missing_fields for a blank rename", async () => {
    const res = await PATCH(patchReq({ fileName: "   " }), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields" });
  });

  it("400s bad_request when the whole body is a no-op", async () => {
    const res = await PATCH(patchReq({}), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("404s folder_not_found for a folder outside the tenant, without writing anything", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never); // folder lookup
    const res = await PATCH(patchReq({ folderId: FOLDER_ID }), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "folder_not_found" });
    expect(db.query).toHaveBeenCalledTimes(1); // only the lookup — no UPDATE
  });

  it("clears the folder on an explicit null", async () => {
    const res = await PATCH(patchReq({ folderId: null }), ctx());
    expect(res.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("folder_id = $3");
    expect(params[2]).toBeNull();
  });

  it("400s on an out-of-range category or tags array", async () => {
    const tooLong = "a".repeat(500);
    const resCat = await PATCH(patchReq({ category: tooLong }), ctx());
    expect(resCat.status).toBe(400);
    expect(await resCat.json()).toEqual({ error: "invalid_category" });

    const resTags = await PATCH(patchReq({ tags: "not-an-array" }), ctx());
    expect(resTags.status).toBe(400);
    expect(await resTags.json()).toEqual({ error: "invalid_tags" });
  });

  it("400s on an unrecognized aiDecision value", async () => {
    const res = await PATCH(patchReq({ aiDecision: "maybe" }), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("confirm with no explicit override merges the AI proposal into category/tags and sets ai_status=confirmed", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(
      baseAsset({
        category: null,
        tags: ["existing"],
        aiStatus: "pending_review",
        aiLabels: { category: "نوشیدنی", tags: ["قهوه", "existing"] },
      }) as never,
    );
    const res = await PATCH(patchReq({ aiDecision: "confirm" }), ctx());
    expect(res.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ai_status = $3");
    expect(sql).toContain("category = $4");
    expect(sql).toContain("tags = $5");
    expect(params[2]).toBe("confirmed");
    expect(params[3]).toBe("نوشیدنی");
    // Deduplicated union of the asset's existing tags and the proposal's.
    expect(new Set(params[4] as string[])).toEqual(new Set(["existing", "قهوه"]));
  });

  it("confirm with an explicit category/tags in the same request lets the operator's edit win over the proposal", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(
      baseAsset({
        aiStatus: "pending_review",
        aiLabels: { category: "پیشنهاد هوش مصنوعی", tags: ["پیشنهادی"] },
      }) as never,
    );
    const res = await PATCH(patchReq({ aiDecision: "confirm", category: "دستهٔ من", tags: ["برچسب من"] }), ctx());
    expect(res.status).toBe(200);
    const [, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(params).toContain("دستهٔ من");
    expect(params).toContainEqual(["برچسب من"]);
  });

  it("reject sets ai_status=rejected and never touches category or tags", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(
      baseAsset({ category: "قبلی", tags: ["قبلی"], aiStatus: "pending_review", aiLabels: { category: "پیشنهاد", tags: ["x"] } }) as never,
    );
    const res = await PATCH(patchReq({ aiDecision: "reject" }), ctx());
    expect(res.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ai_status = $3");
    expect(params[2]).toBe("rejected");
    expect(sql).not.toContain("category =");
    expect(sql).not.toContain("tags =");
  });
});

describe("DELETE /api/media/[id]", () => {
  it("answers 409 asset_in_use with the usage payload when a catalogue item still shows it", async () => {
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({ menuItems: [{ id: "m1", name: "قهوه" }], inventoryItems: [], expenses: [], purchases: [] } as never);
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValue(false);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("asset_in_use");
    expect(body.usage.menuItems).toHaveLength(1);
    expect(mediaService.softDeleteMediaAsset).not.toHaveBeenCalled();
  });

  it("force=1 trashes despite active usage", async () => {
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({ menuItems: [{ id: "m1", name: "قهوه" }], inventoryItems: [], expenses: [], purchases: [] } as never);
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValue(false);
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValue(true);
    const res = await DELETE(deleteReq("?force=1"), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trashed: true });
    expect(mediaService.getMediaAssetUsage).not.toHaveBeenCalled();
  });

  it("plain delete trashes an unused asset", async () => {
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({ menuItems: [], inventoryItems: [], expenses: [], purchases: [] } as never);
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValue(true);
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValue(true);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trashed: true });
  });

  it("a repeated trash request on an already-trashed asset is idempotent, not an error", async () => {
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({ menuItems: [], inventoryItems: [], expenses: [], purchases: [] } as never);
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValue(true);
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValue(false); // already trashed
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(baseAsset({ deletedAt: "2026-01-01T00:00:00Z" }) as never);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trashed: true });
  });

  it("404s a trash request for an asset that never existed", async () => {
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({ menuItems: [], inventoryItems: [], expenses: [], purchases: [] } as never);
    vi.mocked(mediaService.mediaAssetUsageIsEmpty).mockReturnValue(true);
    vi.mocked(mediaService.softDeleteMediaAsset).mockResolvedValue(false);
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(null);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(404);
  });

  it("purge=1 refuses to hard-delete an asset that is not already in the trash", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(baseAsset({ deletedAt: null }) as never);
    const res = await DELETE(deleteReq("?purge=1"), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_in_trash");
    expect(mediaService.deleteMediaAsset).not.toHaveBeenCalled();
  });

  it("purge=1 permanently removes an already-trashed asset", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(baseAsset({ deletedAt: "2026-01-01T00:00:00Z" }) as never);
    vi.mocked(mediaService.deleteMediaAsset).mockResolvedValue(true);
    const res = await DELETE(deleteReq("?purge=1"), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, purged: true });
  });

  it("purge=1 404s for an asset id that does not exist", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(null);
    const res = await DELETE(deleteReq("?purge=1"), ctx());
    expect(res.status).toBe(404);
  });
});
