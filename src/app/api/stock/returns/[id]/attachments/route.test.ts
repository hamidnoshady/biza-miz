import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as authorize from "@/lib/authorize";
import { DELETE, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermissions: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});
vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return { ...actual, canActInLocation: vi.fn() };
});

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12" };
const RETURN_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const ASSET_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const context = { params: Promise.resolve({ id: RETURN_ID }) };

function request(url: string, body?: unknown) {
  return {
    url,
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermissions).mockResolvedValue({ session: SESSION, membership: {} as never, error: null } as never);
  vi.mocked(authorize.canActInLocation).mockResolvedValue(true);
});

describe("supplier-return supporting-file links", () => {
  it("requires both inventory adjustment and Media Library management", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValueOnce({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const response = await POST(request("http://local/api", { mediaAssetId: ASSET_ID }), context);
    expect(response.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("creates an idempotent link to an active same-tenant document asset", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ location_id: "location-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: ASSET_ID }] } as never)
      .mockResolvedValueOnce({ rows: [{ media_asset_id: ASSET_ID }] } as never);

    const response = await POST(request("http://local/api", { mediaAssetId: ASSET_ID }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, duplicate: false });
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("kind = 'document' AND deleted_at IS NULL"), [SESSION.businessId, ASSET_ID]);
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("ON CONFLICT (business_id, return_id, media_asset_id) DO NOTHING"), [SESSION.businessId, RETURN_ID, ASSET_ID, SESSION.sub]);
  });

  it("does not link a missing, trashed, non-document, or foreign tenant asset", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ location_id: "location-1" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const response = await POST(request("http://local/api", { mediaAssetId: ASSET_ID }), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "asset_not_found" });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("returns duplicate success without creating a second association", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ location_id: "location-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: ASSET_ID }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const response = await POST(request("http://local/api", { mediaAssetId: ASSET_ID }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
  });

  it("removes only the attachment association, never the media asset", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ location_id: "location-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ media_asset_id: ASSET_ID }] } as never);

    const response = await DELETE(request(`http://local/api?mediaAssetId=${ASSET_ID}`), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("DELETE FROM item_supplier_return_attachments"), [SESSION.businessId, RETURN_ID, ASSET_ID]);
  });
});
