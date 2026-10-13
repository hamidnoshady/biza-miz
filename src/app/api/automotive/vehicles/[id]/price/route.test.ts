import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  requirePermission: vi.fn(),
  requireIndustry: vi.fn(),
  readBody: vi.fn(),
  holdsPermission: vi.fn(),
  vehicleBranchContext: vi.fn(),
  updatePrice: vi.fn(),
  listHistory: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock("@/lib/industry-guard", () => ({ requireIndustryForApi: mocks.requireIndustry }));
vi.mock("@/lib/automotive-service", () => ({
  updateVehiclePrice: mocks.updatePrice,
  listVehiclePriceHistory: mocks.listHistory,
}));
vi.mock("../../../guard", () => ({
  handleAutomotiveError: (error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 }),
  holdsPermission: mocks.holdsPermission,
  readBody: mocks.readBody,
  vehicleBranchContext: mocks.vehicleBranchContext,
}));

import * as auth from "@/lib/auth";
import * as automotiveService from "@/lib/automotive-service";
import * as automotiveGuard from "../../../guard";
import { POST } from "./route";

const SESSION = { businessId: "biz-session", sub: "actor-1", role: "member" };
const VEHICLE_ID = "vehicle-1";

function request(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/automotive/vehicles/${VEHICLE_ID}/price`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function allowPriceEdit() {
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  mocks.requireIndustry.mockResolvedValue(null);
  mocks.vehicleBranchContext.mockResolvedValue({
    access: { activeLocationId: "branch-1", allowedLocationIds: ["branch-1"] },
    response: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const client = { query: mocks.query, release: vi.fn() };
  mocks.connect.mockResolvedValue(client);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.requirePermission.mockResolvedValue({ session: SESSION, error: null });
  mocks.requireIndustry.mockResolvedValue(null);
  mocks.readBody.mockResolvedValue({ askingPriceRial: 900_000_000 });
  mocks.holdsPermission.mockResolvedValue(false);
  mocks.vehicleBranchContext.mockResolvedValue({
    access: { activeLocationId: "branch-1", allowedLocationIds: ["branch-1"] },
    response: null,
  });
  mocks.updatePrice.mockResolvedValue({ previousAskingPriceRial: 850_000_000, askingPriceRial: 900_000_000 });
  mocks.listHistory.mockResolvedValue([{
    id: "history-1",
    previousAskingPriceRial: 850_000_000,
    askingPriceRial: 900_000_000,
    previousMinimumPriceRial: 700_000_000,
    minimumPriceRial: 720_000_000,
    previousWholesalePriceRial: 800_000_000,
    wholesalePriceRial: 820_000_000,
    previousPromotionalPriceRial: 840_000_000,
    promotionalPriceRial: 860_000_000,
    reason: "market update",
  }]);
});

describe("POST /api/automotive/vehicles/[id]/price", () => {
  it("requires price-edit permission even when called directly", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(request({ askingPriceRial: 900_000_000 }), { params: Promise.resolve({ id: VEHICLE_ID }) });
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.vehiclesPriceEdit);
    expect(automotiveService.updateVehiclePrice).not.toHaveBeenCalled();
  });

  it("does not let price_edit-only members write wholesale or promotional prices hidden by cost redaction", async () => {
    allowPriceEdit();
    mocks.readBody.mockResolvedValue({ askingPriceRial: 900_000_000, wholesalePriceRial: null });
    const response = await POST(request({ askingPriceRial: 900_000_000, wholesalePriceRial: null }), {
      params: Promise.resolve({ id: VEHICLE_ID }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesCostView });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(automotiveService.updateVehiclePrice).not.toHaveBeenCalled();
  });

  it("lets a price editor change asking price without overwriting hidden cost-sensitive fields", async () => {
    allowPriceEdit();
    mocks.readBody.mockResolvedValue({ askingPriceRial: 900_000_000, reason: "بازبینی بازار" });
    const response = await POST(request({ askingPriceRial: 900_000_000, reason: "بازبینی بازار" }), {
      params: Promise.resolve({ id: VEHICLE_ID }),
    });
    expect(response.status).toBe(200);
    expect(automotiveService.updateVehiclePrice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      businessId: SESSION.businessId,
      locationId: "branch-1",
      serialId: VEHICLE_ID,
      askingPriceRial: 900_000_000,
      minimumPriceRial: undefined,
      wholesalePriceRial: undefined,
      promotionalPriceRial: undefined,
      actorId: SESSION.sub,
    }));
    const body = await response.json();
    expect(body.priceHistory[0]).not.toHaveProperty("minimumPriceRial");
    expect(body.priceHistory[0]).not.toHaveProperty("previousMinimumPriceRial");
    expect(body.priceHistory[0]).not.toHaveProperty("wholesalePriceRial");
    expect(body.priceHistory[0]).not.toHaveProperty("promotionalPriceRial");
  });

  it("does not update a vehicle outside the branch resolved from live membership", async () => {
    allowPriceEdit();
    mocks.vehicleBranchContext.mockResolvedValue({
      access: { activeLocationId: "branch-1", allowedLocationIds: ["branch-1"] },
      response: NextResponse.json({ error: "vehicle_not_found" }, { status: 404 }),
    });
    const response = await POST(request({ askingPriceRial: 900_000_000 }), {
      params: Promise.resolve({ id: VEHICLE_ID }),
    });
    expect(response.status).toBe(404);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(automotiveGuard.vehicleBranchContext).toHaveBeenCalledWith(SESSION, VEHICLE_ID, { mutation: true });
  });
});
