import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { AgencyReservationError } from "@/lib/agency-reservation";
const m = vi.hoisted(() => ({
  owner: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ withTenantScope: (fn: unknown) => fn }));
vi.mock("@/lib/agency-reservation-service", () => ({
  listReservations: m.list,
  createReservation: m.create,
}));
vi.mock("../../../guard", () => ({
  agencyOwner: m.owner,
  PERMISSIONS: {
    workspaceView: "workspace.view",
    workspaceManage: "workspace.manage",
  },
  readBody: (r: Request) => r.json(),
  handleAgencyError: (err: unknown) => {
    throw err;
  },
}));
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ id: "project" }) };
const owner = {
  businessId: "tenant",
  actorUserId: "manager",
  access: { canManage: true },
};
const request = (method = "GET", query = "from=2026-11-01&to=2026-11-30") =>
  new NextRequest(
    `http://test/api/agency/projects/project/reservations?${query}`,
    { method, ...(method === "POST" ? { body: '{"workerId":"staff"}' } : {}) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  m.owner.mockResolvedValue({ owner, error: null });
  m.list.mockResolvedValue({ rows: [], canManage: true });
  m.create.mockResolvedValue({ id: "reservation" });
});
describe("resource reservation authority", () => {
  it("passes the request to the existing activation/permission guard for reads and mutations", async () => {
    expect((await GET(request(), context)).status).toBe(200);
    expect((await POST(request("POST"), context)).status).toBe(201);
    expect(m.owner).toHaveBeenNthCalledWith(
      1,
      "workspace.view",
      expect.anything(),
    );
    expect(m.owner).toHaveBeenNthCalledWith(
      2,
      "workspace.manage",
      expect.anything(),
    );
    expect(m.create).toHaveBeenCalledWith(owner, "project", {
      workerId: "staff",
    });
  });
  it("never calls source functions after a permission/service denial", async () => {
    m.owner.mockResolvedValue({
      error: NextResponse.json({ error: "service_disabled" }, { status: 403 }),
    });
    expect((await POST(request("POST"), context)).status).toBe(403);
    expect((await GET(request(), context)).status).toBe(403);
    expect(m.list).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });
  it("requires both live management flags and project management for the form", async () => {
    expect((await (await GET(request(), context)).json()).canWrite).toBe(true);
    m.list.mockResolvedValue({ rows: [], canManage: false });
    expect((await (await GET(request(), context)).json()).canWrite).toBe(false);
    m.list.mockResolvedValue({ rows: [], canManage: true });
    m.owner.mockResolvedValue({
      owner: { ...owner, access: { canManage: false } },
      error: null,
    });
    expect((await (await GET(request(), context)).json()).canWrite).toBe(false);
  });
  it("refuses invalid ranges before any data query", async () => {
    expect(
      (await GET(request("GET", "from=bad&to=2026-11-01"), context)).status,
    ).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });
  it("returns only generic conflicts, not another project's name or details", async () => {
    m.create.mockRejectedValue(
      new AgencyReservationError("reservation_conflict"),
    );
    const r = await POST(request("POST"), context);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "reservation_conflict" });
  });
});
