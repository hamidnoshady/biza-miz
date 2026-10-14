import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  requirePermission: vi.fn(),
  requireIndustry: vi.fn(),
  accessibleLocations: vi.fn(),
  getProfile: vi.fn(),
  savePreferences: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock("@/lib/industry-guard", () => ({ requireIndustryForApi: mocks.requireIndustry }));
vi.mock("@/lib/setup-state", () => ({ accessibleLocationsFor: mocks.accessibleLocations }));
vi.mock("@/lib/automotive-lead-service", () => ({
  getLeadVehicleProfile: mocks.getProfile,
  saveLeadVehiclePreferences: mocks.savePreferences,
  VehicleLeadError: class VehicleLeadError extends Error {
    code = "vehicle_lead_error";
    status = 400;
  },
}));
vi.mock("../../guard", () => ({
  handleAutomotiveError: (error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 }),
  readBody: async (request: Request) => request.json(),
}));

import * as auth from "@/lib/auth";
import * as leadService from "@/lib/automotive-lead-service";
import * as setupState from "@/lib/setup-state";
import { GET, PUT } from "./route";

const SESSION = { businessId: "session-business", sub: "actor-1", role: "member" };
const LEAD_ID = "lead-1";

function context() {
  return { params: Promise.resolve({ id: LEAD_ID }) };
}

function request(method: "GET" | "PUT", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/automotive/leads/${LEAD_ID}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function allowIndustryAccess() {
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  mocks.requireIndustry.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ session: SESSION, error: null });
  mocks.requireIndustry.mockResolvedValue(null);
  mocks.accessibleLocations.mockResolvedValue({ locations: [{ id: "branch-1" }, { id: "branch-2" }] });
  mocks.getProfile.mockResolvedValue({ leadId: LEAD_ID, preferences: null, links: [] });
  mocks.savePreferences.mockResolvedValue({ leadId: LEAD_ID, make: "پژو" });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
});

describe("GET /api/automotive/leads/[id]", () => {
  it("requires vehicles.view for a direct API read", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    const response = await GET(request("GET"), context());

    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.vehiclesView);
    expect(leadService.getLeadVehicleProfile).not.toHaveBeenCalled();
  });

  it("scopes linked vehicle details to branches accessible to the session", async () => {
    allowIndustryAccess();

    const response = await GET(request("GET"), context());

    expect(response.status).toBe(200);
    expect(setupState.accessibleLocationsFor).toHaveBeenCalledWith(SESSION);
    expect(leadService.getLeadVehicleProfile).toHaveBeenCalledWith(
      SESSION.businessId,
      LEAD_ID,
      undefined,
      ["branch-1", "branch-2"],
    );
  });
});

describe("PUT /api/automotive/leads/[id]", () => {
  it("requires crm.manage for a direct preference write", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    const response = await PUT(request("PUT", { make: "پژو" }), context());

    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.crmManage);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(leadService.saveLeadVehiclePreferences).not.toHaveBeenCalled();
  });

  it("derives tenant and actor from the session, not the request body", async () => {
    allowIndustryAccess();

    const response = await PUT(request("PUT", {
      businessId: "attacker-business",
      actorId: "attacker-user",
      make: "پژو",
      modelYearFrom: 1400,
    }), context());

    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.crmManage);
    expect(leadService.saveLeadVehiclePreferences).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      businessId: SESSION.businessId,
      leadId: LEAD_ID,
      actorId: SESSION.sub,
      make: "پژو",
      modelYearFrom: 1400,
    }));
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
