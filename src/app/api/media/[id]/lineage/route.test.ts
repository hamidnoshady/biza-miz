import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as mediaService from "@/lib/media-service";
import { GET } from "./route";

/**
 * The version-history read (Section V's disclosed "no version-history UI"
 * gap, closed this session): `getMediaAssetLineage` does the real walk, this
 * route is just the tenant/permission gate + 404 in front of it, the same
 * shape `/api/media/[id]/usage` already has and — until now — neither route
 * had a test of its own anywhere in the repo.
 */

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/media-service", () => ({
  getMediaAsset: vi.fn(),
  getMediaAssetLineage: vi.fn(),
}));

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "user-1", role: "owner" };
const ASSET_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

function ctx() {
  return { params: Promise.resolve({ id: ASSET_ID }) };
}

function baseAsset() {
  return { id: ASSET_ID, folderId: null, kind: "image" as const, fileName: "crop.png" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/media/[id]/lineage", () => {
  it("requires media.view — this is a library action, not a usage-based exception", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(403);
    expect(mediaService.getMediaAssetLineage).not.toHaveBeenCalled();
  });

  it("404s when the asset does not exist (or belongs to another tenant)", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION } as never);
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(null);

    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(404);
    expect(mediaService.getMediaAssetLineage).not.toHaveBeenCalled();
  });

  it("returns the ancestor chain and direct descendants for an existing asset", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION } as never);
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(baseAsset() as never);
    const lineage = {
      ancestors: [{ id: "root-1", fileName: "original.png", variant: "original", transformOps: [], deletedAt: null }],
      descendants: [
        { id: "child-1", fileName: "enhance.png", variant: "enhanced", transformOps: [], deletedAt: null },
      ],
    };
    vi.mocked(mediaService.getMediaAssetLineage).mockResolvedValue(lineage as never);

    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lineage).toEqual(lineage);
    expect(mediaService.getMediaAssetLineage).toHaveBeenCalledWith(SESSION.businessId, ASSET_ID);
  });

  it("returns empty arrays, not an error, for an asset with no history either way", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION } as never);
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(baseAsset() as never);
    vi.mocked(mediaService.getMediaAssetLineage).mockResolvedValue({ ancestors: [], descendants: [] } as never);

    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lineage).toEqual({ ancestors: [], descendants: [] });
  });
});
