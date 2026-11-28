import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GH #1567 6C — the size-pack read views share one route (desktop size gate).
 * These pin each view's permission (the till's barcode lookup is a cashier
 * action, `orders.create`; the builder views need `inventory.view`), its
 * parameter checks and which service it reaches. Service behaviour is covered
 * by integration/fashion-size-packs.integration.test.ts.
 */
const STYLE = "0b0c6d39-3b43-4f51-9e0e-0b3c1c9ae0d1";
const ORDER = "6a0f8d0e-3c35-4b1f-8f43-0e1e6f9b6c12";

const mocks = vi.hoisted(() => ({
  requirePermissions: vi.fn(),
  industry: vi.fn(async () => "fashion_apparel"),
  location: vi.fn(async () => ({ id: "loc-1" })),
  listSizePacks: vi.fn(async () => []),
  listStyles: vi.fn(async () => [{ id: "s" }]),
  styleMatrix: vi.fn(async () => ({ axes: [], cells: [] })),
  listSizePackSales: vi.fn(async () => []),
  lookupSizePackByBarcode: vi.fn(async () => null),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermissions: mocks.requirePermissions,
}));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: mocks.industry }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.location }));
vi.mock("@/lib/fashion-size-pack-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fashion-size-pack-service")>("@/lib/fashion-size-pack-service");
  return { ...actual, listSizePacks: mocks.listSizePacks, listStyles: mocks.listStyles, styleMatrix: mocks.styleMatrix,
    listSizePackSales: mocks.listSizePackSales, lookupSizePackByBarcode: mocks.lookupSizePackByBarcode };
});

import { GET } from "./route";

const actor = { businessId: "biz", userId: "u1" };
const get = (query: string) => GET(new NextRequest(`https://app.test/api/size-packs${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.industry.mockResolvedValue("fashion_apparel");
  mocks.requirePermissions.mockResolvedValue({ session: { businessId: "biz", sub: "u1" }, error: null });
});

describe("GH #1567 6C — size-pack read views", () => {
  it("lists packs by default (inventory.view), honouring active=1", async () => {
    const res = await get("?active=1");
    expect(res.status).toBe(200);
    expect(mocks.requirePermissions).toHaveBeenCalledWith("inventory.view");
    expect(mocks.listSizePacks).toHaveBeenCalledWith(actor, "loc-1", { activeOnly: true });
  });

  it("the till lookup needs orders.create, not inventory.view, and a 1–64 character code", async () => {
    let res = await get("?view=lookup&code=%20%20");
    expect(res.status).toBe(400);
    expect(mocks.lookupSizePackByBarcode).not.toHaveBeenCalled();
    res = await get(`?view=lookup&code=${"9".repeat(65)}`);
    expect(res.status).toBe(400);
    res = await get("?view=lookup&code=%206260000000017%20");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pack: null });
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("orders.create");
    expect(mocks.requirePermissions).not.toHaveBeenCalledWith("inventory.view");
    expect(mocks.lookupSizePackByBarcode).toHaveBeenCalledWith(actor, "loc-1", "6260000000017");
  });

  it("styles, matrix (valid styleId required) and sales (optional valid orderId) need inventory.view", async () => {
    expect((await get("?view=styles")).status).toBe(200);
    expect(mocks.listStyles).toHaveBeenCalledWith(actor, "loc-1");
    expect((await get("?view=matrix")).status).toBe(400);
    expect((await get("?view=matrix&styleId=nope")).status).toBe(400);
    expect(mocks.styleMatrix).not.toHaveBeenCalled();
    expect((await get(`?view=matrix&styleId=${STYLE}`)).status).toBe(200);
    expect(mocks.styleMatrix).toHaveBeenCalledWith(actor, "loc-1", STYLE);
    expect((await get("?view=sales&orderId=nope")).status).toBe(400);
    expect((await get("?view=sales")).status).toBe(200);
    expect(mocks.listSizePackSales).toHaveBeenLastCalledWith(actor, "loc-1", { orderId: undefined });
    expect((await get(`?view=sales&orderId=${ORDER}`)).status).toBe(200);
    expect(mocks.listSizePackSales).toHaveBeenLastCalledWith(actor, "loc-1", { orderId: ORDER });
    for (const call of mocks.requirePermissions.mock.calls) expect(call).toEqual(["inventory.view"]);
  });

  it("an unknown view is refused before any permission check", async () => {
    const res = await get("?view=everything");
    expect(res.status).toBe(400);
    expect(mocks.requirePermissions).not.toHaveBeenCalled();
  });

  it("a member without the key, or another trade, is refused before any service call", async () => {
    mocks.requirePermissions.mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await get("?view=lookup&code=X1")).status).toBe(403);
    mocks.requirePermissions.mockResolvedValue({ session: { businessId: "biz", sub: "u1" }, error: null });
    mocks.industry.mockResolvedValue("food_service");
    expect((await get("?view=styles")).status).toBe(403);
    expect(mocks.lookupSizePackByBarcode).not.toHaveBeenCalled();
    expect(mocks.listStyles).not.toHaveBeenCalled();
  });
});
