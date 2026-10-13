import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  requirePermission: vi.fn(),
  requireIndustry: vi.fn(),
  branchContext: vi.fn(),
  readBody: vi.fn(),
  link: vi.fn(),
  list: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock("@/lib/industry-guard", () => ({ requireIndustryForApi: mocks.requireIndustry }));
vi.mock("@/lib/automotive-lead-service", () => ({
  linkLeadVehicle: mocks.link,
  listLeadsInterestedInVehicle: mocks.list,
  unlinkLeadVehicle: mocks.unlink,
  VehicleLeadError: class VehicleLeadError extends Error {
    code = "vehicle_lead_error";
    status = 400;
  },
}));
vi.mock("../../../guard", () => ({
  handleAutomotiveError: (error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 }),
  readBody: mocks.readBody,
  vehicleBranchContext: mocks.branchContext,
}));

import * as auth from "@/lib/auth";
import * as automotiveGuard from "../../../guard";
import * as leadService from "@/lib/automotive-lead-service";
import { DELETE, GET, POST } from "./route";

const SESSION = { businessId: "session-business", sub: "actor-1", role: "member" };
const VEHICLE_ID = "vehicle-1";
const LEAD_ID = "lead-1";

function context() {
  return { params: Promise.resolve({ id: VEHICLE_ID }) };
}

function request(method: "GET" | "POST" | "DELETE", body?: unknown, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/automotive/vehicles/${VEHICLE_ID}/leads${query}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function allowAccess() {
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  mocks.requireIndustry.mockResolvedValue(null);
  mocks.branchContext.mockResolvedValue({
    access: { allowedLocationIds: ["branch-1", "branch-2"], activeLocationId: "branch-1" },
    response: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ session: SESSION, error: null });
  mocks.requireIndustry.mockResolvedValue(null);
  mocks.branchContext.mockResolvedValue({
    access: { allowedLocationIds: ["branch-1", "branch-2"], activeLocationId: "branch-1" },
    response: null,
  });
  mocks.readBody.mockResolvedValue({ leadId: LEAD_ID });
  mocks.list.mockResolvedValue([{ leadId: LEAD_ID, bestPurpose: "interest" }]);
  mocks.link.mockResolvedValue({ id: "link-1", purpose: "interest" });
  mocks.unlink.mockResolvedValue(true);
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
});

describe("GET /api/automotive/vehicles/[id]/leads", () => {
  it("requires vehicles.view and confines matches to the caller's accessible branches", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    const deniedResponse = await GET(request("GET"), context());

    expect(deniedResponse.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.vehiclesView);
    expect(leadService.listLeadsInterestedInVehicle).not.toHaveBeenCalled();

    allowAccess();
    const response = await GET(request("GET"), context());

    expect(response.status).toBe(200);
    expect(automotiveGuard.vehicleBranchContext).toHaveBeenCalledWith(SESSION, VEHICLE_ID);
    expect(leadService.listLeadsInterestedInVehicle).toHaveBeenCalledWith(
      SESSION.businessId,
      VEHICLE_ID,
      undefined,
      ["branch-1", "branch-2"],
    );
  });
});

describe("POST /api/automotive/vehicles/[id]/leads", () => {
  it("requires crm.manage and derives business, branch, and actor from the session", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const deniedResponse = await POST(request("POST", { leadId: LEAD_ID }), context());
    expect(deniedResponse.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.crmManage);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(leadService.linkLeadVehicle).not.toHaveBeenCalled();

    allowAccess();
    mocks.readBody.mockResolvedValue({
      businessId: "attacker-business",
      locationId: "attacker-branch",
      leadId: LEAD_ID,
      purpose: "test_drive",
      note: "request from customer",
      actorId: "attacker-user",
    });
    const response = await POST(request("POST", { leadId: LEAD_ID }), context());

    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.crmManage);
    expect(automotiveGuard.vehicleBranchContext).toHaveBeenCalledWith(SESSION, VEHICLE_ID, { mutation: true });
    expect(leadService.linkLeadVehicle).toHaveBeenCalledWith(expect.anything(), {
      businessId: SESSION.businessId,
      leadId: LEAD_ID,
      serialId: VEHICLE_ID,
      locationId: "branch-1",
      purpose: "test_drive",
      note: "request from customer",
      actorId: SESSION.sub,
    });
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

describe("DELETE /api/automotive/vehicles/[id]/leads", () => {
  it("requires crm.manage and scopes removal to the active vehicle branch", async () => {
    allowAccess();

    const response = await DELETE(request("DELETE", undefined, `?leadId=${LEAD_ID}`), context());

    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.crmManage);
    expect(automotiveGuard.vehicleBranchContext).toHaveBeenCalledWith(SESSION, VEHICLE_ID, { mutation: true });
    expect(leadService.unlinkLeadVehicle).toHaveBeenCalledWith(expect.anything(), {
      businessId: SESSION.businessId,
      leadId: LEAD_ID,
      serialId: VEHICLE_ID,
      locationId: "branch-1",
    });
  });

  it("does not mutate when the active branch cannot access the vehicle", async () => {
    allowAccess();
    mocks.branchContext.mockResolvedValue({
      access: { allowedLocationIds: ["branch-2"], activeLocationId: "branch-2" },
      response: NextResponse.json({ error: "wrong_location" }, { status: 409 }),
    });

    const response = await DELETE(request("DELETE", undefined, `?leadId=${LEAD_ID}`), context());

    expect(response.status).toBe(409);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(leadService.unlinkLeadVehicle).not.toHaveBeenCalled();
  });
});
