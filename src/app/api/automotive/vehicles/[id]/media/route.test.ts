import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  list: vi.fn(),
  requirePermission: vi.fn(),
  requireIndustry: vi.fn(),
  holdsPermission: vi.fn(),
  readBody: vi.fn(),
  vehicleBranchContext: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock("@/lib/industry-guard", () => ({ requireIndustryForApi: mocks.requireIndustry }));
vi.mock("@/lib/automotive-service", () => ({
  attachVehicleMedia: mocks.attach,
  detachVehicleMedia: mocks.detach,
  listVehicleMedia: mocks.list,
}));
vi.mock("../../../guard", () => ({
  handleAutomotiveError: (error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 }),
  holdsPermission: mocks.holdsPermission,
  readBody: mocks.readBody,
  vehicleBranchContext: mocks.vehicleBranchContext,
}));

import * as auth from "@/lib/auth";
import * as industryGuard from "@/lib/industry-guard";
import * as automotiveService from "@/lib/automotive-service";
import * as automotiveGuard from "../../../guard";
import { DELETE, GET, POST } from "./route";

const SESSION = { businessId: "biz-session", sub: "actor-1", role: "member" };
const VEHICLE_ID = "vehicle-1";
const ASSET_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const attachment = (mediaKind: "image" | "video" | "document", id: string) => ({
  id,
  mediaAssetId: `asset-${id}`,
  fileName: `${id}.file`,
  mimeType: mediaKind === "image" ? "image/png" : mediaKind === "video" ? "video/mp4" : "application/pdf",
  mediaKind,
  category: mediaKind === "document" ? "registration" : "photo",
  title: id,
  description: null,
  displayOrder: 0,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function context() {
  return { params: Promise.resolve({ id: VEHICLE_ID }) };
}

function request(method: "GET" | "POST" | "DELETE", body?: unknown, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/automotive/vehicles/${VEHICLE_ID}/media${query}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function allowVehicleView() {
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(industryGuard.requireIndustryForApi).mockResolvedValue(null as never);
  vi.mocked(automotiveGuard.vehicleBranchContext).mockResolvedValue({
    access: { allowedLocationIds: ["branch-1"], activeLocationId: "branch-1" },
    response: null,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  const client = { query: mocks.query, release: vi.fn() };
  mocks.connect.mockResolvedValue(client);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.requirePermission.mockResolvedValue({ session: SESSION, error: null });
  mocks.requireIndustry.mockResolvedValue(null);
  mocks.holdsPermission.mockResolvedValue(false);
  mocks.readBody.mockResolvedValue({});
  mocks.vehicleBranchContext.mockResolvedValue({
    access: { allowedLocationIds: ["branch-1"], activeLocationId: "branch-1" },
    response: null,
  });
  mocks.list.mockResolvedValue([]);
  mocks.attach.mockResolvedValue(attachment("image", "attached"));
  mocks.detach.mockResolvedValue(true);
});

describe("GET /api/automotive/vehicles/[id]/media", () => {
  it("requires vehicle-view permission and scopes the media query to allowed branches", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await GET(request("GET"), context());
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.vehiclesView);
    expect(automotiveService.listVehicleMedia).not.toHaveBeenCalled();

    allowVehicleView();
    mocks.list.mockResolvedValue([attachment("image", "photo"), attachment("document", "registration")]);
    const allowed = await GET(request("GET"), context());
    expect(allowed.status).toBe(200);
    expect(automotiveService.listVehicleMedia).toHaveBeenCalledWith(
      SESSION.businessId,
      VEHICLE_ID,
      undefined,
      { locationIds: ["branch-1"] },
    );
    expect(await allowed.json()).toEqual({ attachments: [attachment("image", "photo")] });
  });

  it("reveals document metadata only to a member with media.view", async () => {
    allowVehicleView();
    mocks.list.mockResolvedValue([attachment("image", "photo"), attachment("video", "walkaround"), attachment("document", "contract")]);
    const withoutLibraryAccess = await GET(request("GET"), context());
    expect(await withoutLibraryAccess.json()).toEqual({
      attachments: [attachment("image", "photo"), attachment("video", "walkaround")],
    });

    mocks.holdsPermission.mockResolvedValue(true);
    const withLibraryAccess = await GET(request("GET"), context());
    expect(await withLibraryAccess.json()).toEqual({
      attachments: [attachment("image", "photo"), attachment("video", "walkaround"), attachment("document", "contract")],
    });
  });

  it("does not expose a vehicle from a branch outside the caller's allowed set", async () => {
    allowVehicleView();
    mocks.vehicleBranchContext.mockResolvedValue({
      access: { allowedLocationIds: [], activeLocationId: null },
      response: NextResponse.json({ error: "vehicle_not_found" }, { status: 404 }),
    });
    const response = await GET(request("GET"), context());
    expect(response.status).toBe(404);
    expect(automotiveService.listVehicleMedia).not.toHaveBeenCalled();
  });
});

describe("vehicle-media mutations", () => {
  it("rejects direct POST and DELETE calls without vehicle-edit permission", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const post = await POST(request("POST", { mediaAssetId: ASSET_ID, category: "photo", title: "Front" }), context());
    const del = await DELETE(request("DELETE", undefined, `?mediaAssetId=${ASSET_ID}`), context());
    expect(post.status).toBe(403);
    expect(del.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.vehiclesEdit);
    expect(automotiveService.attachVehicleMedia).not.toHaveBeenCalled();
    expect(automotiveService.detachVehicleMedia).not.toHaveBeenCalled();
  });

  it("requires media.view in addition to vehicle.edit, even for direct API calls", async () => {
    allowVehicleView();
    mocks.holdsPermission.mockResolvedValue(false);
    mocks.readBody.mockResolvedValue({ mediaAssetId: ASSET_ID, category: "photo", title: "Front" });
    const post = await POST(request("POST", { mediaAssetId: ASSET_ID, category: "photo", title: "Front" }), context());
    const del = await DELETE(request("DELETE", undefined, `?mediaAssetId=${ASSET_ID}`), context());
    expect(post.status).toBe(403);
    expect(del.status).toBe(403);
    expect(automotiveGuard.holdsPermission).toHaveBeenCalledWith(SESSION, PERMISSIONS.mediaView);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("derives tenant and source branch from the session, never the request body", async () => {
    allowVehicleView();
    mocks.holdsPermission.mockResolvedValue(true);
    mocks.readBody.mockResolvedValue({
      businessId: "attacker-business",
      locationId: "attacker-branch",
      mediaAssetId: ASSET_ID,
      category: "photo",
      title: "Front",
    });
    const response = await POST(request("POST", { mediaAssetId: ASSET_ID, category: "photo", title: "Front" }), context());
    expect(response.status).toBe(201);
    expect(automotiveGuard.vehicleBranchContext).toHaveBeenCalledWith(SESSION, VEHICLE_ID, { mutation: true });
    expect(automotiveService.attachVehicleMedia).toHaveBeenCalledWith(expect.anything(), {
      businessId: SESSION.businessId,
      locationId: "branch-1",
      serialId: VEHICLE_ID,
      mediaAssetId: ASSET_ID,
      category: "photo",
      title: "Front",
      description: null,
      actorId: SESSION.sub,
    });
  });

  it("honors a branch-context denial before opening a transaction", async () => {
    allowVehicleView();
    mocks.holdsPermission.mockResolvedValue(true);
    mocks.readBody.mockResolvedValue({ mediaAssetId: ASSET_ID, category: "photo", title: "Front" });
    mocks.vehicleBranchContext.mockResolvedValue({
      access: { allowedLocationIds: ["branch-2"], activeLocationId: "branch-2" },
      response: NextResponse.json({ error: "wrong_location" }, { status: 409 }),
    });
    const response = await POST(request("POST", { mediaAssetId: ASSET_ID, category: "photo", title: "Front" }), context());
    expect(response.status).toBe(409);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(automotiveService.attachVehicleMedia).not.toHaveBeenCalled();
  });
});
