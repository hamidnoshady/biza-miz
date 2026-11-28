import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GH #1567 6D / 6B — views folded into their parent routes for the desktop
 * size gate: `/api/consignment-contracts?view=consignors` (was
 * `/consignors`) and `/api/production-orders?view=report` (was `/report`).
 * Pins each view's permission, dispatch and refusal of unknown views. Service
 * behaviour is covered by the fashion consignment / production DB suites.
 */
const mocks = vi.hoisted(() => ({
  requirePermissions: vi.fn(),
  industry: vi.fn(async () => "fashion_apparel"),
  location: vi.fn(async () => ({ id: "loc-1" })),
  listContracts: vi.fn(async () => []),
  createContract: vi.fn(async () => ({ id: "c" })),
  listConsignors: vi.fn(async () => [{ id: "o" }]),
  createConsignorRecord: vi.fn(async () => ({ id: "o2" })),
  listProductionOrders: vi.fn(async () => []),
  productionReport: vi.fn(async () => ({ wip: 0 })),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermissions: mocks.requirePermissions,
}));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: mocks.industry }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.location }));
vi.mock("@/lib/fashion-consignment-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fashion-consignment-service")>("@/lib/fashion-consignment-service");
  return { ...actual, listContracts: mocks.listContracts, createContract: mocks.createContract,
    listConsignors: mocks.listConsignors, createConsignorRecord: mocks.createConsignorRecord };
});
vi.mock("@/lib/fashion-production-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fashion-production-service")>("@/lib/fashion-production-service");
  return { ...actual, listProductionOrders: mocks.listProductionOrders, productionReport: mocks.productionReport };
});

import { GET, POST } from "./route";
import { GET as PRODUCTION_GET } from "../production-orders/route";

const actor = { businessId: "biz", userId: "u1" };
const url = (path: string) => `https://app.test/api${path}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.industry.mockResolvedValue("fashion_apparel");
  mocks.requirePermissions.mockResolvedValue({ session: { businessId: "biz", sub: "u1" }, membership: { permissions: new Set() }, error: null });
});

describe("GH #1567 6D — consignment contracts and ?view=consignors", () => {
  it("lists contracts by default and consignors under the view, both with inventory.view", async () => {
    let res = await GET(new NextRequest(url("/consignment-contracts")));
    expect(await res.json()).toEqual({ contracts: [] });
    res = await GET(new NextRequest(url("/consignment-contracts?view=consignors")));
    expect(await res.json()).toEqual({ consignors: [{ id: "o" }] });
    expect(mocks.listConsignors).toHaveBeenCalledWith(actor);
    for (const call of mocks.requirePermissions.mock.calls) expect(call).toEqual(["inventory.view"]);
  });

  it("POST under the view creates a consignor (inventory.adjust) and validates the consignor body, not the contract body", async () => {
    let res = await POST(new NextRequest(url("/consignment-contracts?view=consignors"), {
      method: "POST", body: JSON.stringify({ name: "تولیدی ستاره", phone: "" }) }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ consignor: { id: "o2" } });
    expect(mocks.createConsignorRecord).toHaveBeenCalledWith(actor, "loc-1", expect.objectContaining({ name: "تولیدی ستاره", phone: null }));
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("inventory.adjust");
    res = await POST(new NextRequest(url("/consignment-contracts?view=consignors"), {
      method: "POST", body: JSON.stringify({ name: "x", reference: "C-1" }) }));
    expect(res.status).toBe(400);
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it("an unknown view is refused before any permission check", async () => {
    expect((await GET(new NextRequest(url("/consignment-contracts?view=owners")))).status).toBe(400);
    expect((await POST(new NextRequest(url("/consignment-contracts?view=owners"), { method: "POST", body: "{}" }))).status).toBe(400);
    expect(mocks.requirePermissions).not.toHaveBeenCalled();
  });

  it("is closed to other trades", async () => {
    mocks.industry.mockResolvedValue("food_service");
    expect((await GET(new NextRequest(url("/consignment-contracts?view=consignors")))).status).toBe(403);
    expect(mocks.listConsignors).not.toHaveBeenCalled();
  });
});

describe("GH #1567 6B — production orders and ?view=report", () => {
  it("the report view returns the summary with inventory.view and does not list orders", async () => {
    const res = await PRODUCTION_GET(new NextRequest(url("/production-orders?view=report")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: { wip: 0 } });
    expect(mocks.requirePermissions).toHaveBeenCalledWith("inventory.view");
    expect(mocks.productionReport).toHaveBeenCalledWith(expect.objectContaining(actor), "loc-1");
    expect(mocks.listProductionOrders).not.toHaveBeenCalled();
  });

  it("the default list still validates status; an unknown view is refused before any permission check", async () => {
    expect((await PRODUCTION_GET(new NextRequest(url("/production-orders?status=bogus")))).status).toBe(400);
    expect((await PRODUCTION_GET(new NextRequest(url("/production-orders")))).status).toBe(200);
    expect(mocks.listProductionOrders).toHaveBeenCalledTimes(1);
    mocks.requirePermissions.mockClear();
    expect((await PRODUCTION_GET(new NextRequest(url("/production-orders?view=wip")))).status).toBe(400);
    expect(mocks.requirePermissions).not.toHaveBeenCalled();
  });
});
