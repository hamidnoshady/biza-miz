import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { AgencyTimeError } from "@/lib/agency-time";
const m = vi.hoisted(() => ({
  owner: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ withTenantScope: (fn: unknown) => fn }));
vi.mock("@/lib/agency-time-service", () => ({
  listAgencyTime: m.list,
  createAgencyTime: m.create,
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
  actorUserId: "actor",
  access: { canManage: true },
};
const request = (method = "GET") =>
  new NextRequest("http://test/api/agency/projects/project/time", {
    method,
    ...(method === "POST"
      ? { body: '{"minutes":60,"createdBy":"forged"}' }
      : {}),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.owner.mockResolvedValue({ owner, error: null });
  m.list.mockResolvedValue({ rows: [], canContribute: true });
  m.create.mockResolvedValue({ id: "time" });
});
describe("time reporting guard", () => {
  it("requires read vs write via the canonical Workspace service guard with request context", async () => {
    await GET(request(), context);
    await POST(request("POST"), context);
    expect(m.owner).toHaveBeenNthCalledWith(
      1,
      PERMISSIONS.workspaceView,
      expect.anything(),
    );
    expect(m.owner).toHaveBeenNthCalledWith(
      2,
      PERMISSIONS.workspaceManage,
      expect.anything(),
    );
    expect(m.create).toHaveBeenCalledWith(owner, "project", {
      minutes: 60,
      createdBy: "forged",
    });
  });
  it("never calls sources after permission/service refusal", async () => {
    m.owner.mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    expect((await POST(request("POST"), context)).status).toBe(403);
    expect((await GET(request(), context)).status).toBe(403);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.list).not.toHaveBeenCalled();
  });
  it("requires both live write permission and project contribution for UI capability", async () => {
    expect((await (await GET(request(), context)).json()).canWrite).toBe(true);
    m.owner.mockResolvedValue({
      owner: { ...owner, access: { canManage: false } },
      error: null,
    });
    expect((await (await GET(request(), context)).json()).canWrite).toBe(false);
    m.owner.mockResolvedValue({ owner, error: null });
    m.list.mockResolvedValue({ rows: [], canContribute: false });
    expect((await (await GET(request(), context)).json()).canWrite).toBe(false);
  });
  it("maps expected validation/conflict/authority failures", async () => {
    for (const [code, status] of [
      ["invalid_time", 400],
      ["time_conflict", 409],
      ["time_forbidden", 403],
    ] as const) {
      m.create.mockRejectedValue(new AgencyTimeError(code));
      expect((await POST(request("POST"), context)).status).toBe(status);
    }
  });
});
