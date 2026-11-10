import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { CampaignReportError } from "@/lib/agency-campaign-report";
const m = vi.hoisted(() => ({
  permission: vi.fn(),
  workspace: vi.fn(),
  load: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  member: vi.fn(),
  cap: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requirePermission: m.permission,
  withTenantScope: (fn: unknown) => fn,
}));
vi.mock("@/lib/agency-campaign-service", () => ({
  loadAgencyCampaign: m.load,
}));
vi.mock("@/lib/agency-campaign-report-service", () => ({
  listCampaignReports: m.list,
  createCampaignReport: m.create,
}));
vi.mock("@/lib/member-access", () => ({ memberAccessFor: m.member }));
vi.mock("@/lib/workspace", () => ({
  requireProjectCapability: m.cap,
  WorkspaceError: class WorkspaceError extends Error {},
}));
vi.mock("@/app/api/workspace/guard", async () => {
  const { NextResponse } = await import("next/server");
  return {
    workspaceOwner: m.workspace,
    handleWorkspaceError: () =>
      NextResponse.json({ error: "unexpected" }, { status: 500 }),
  };
});
vi.mock("@/app/api/crm/campaign-guard", () => ({
  readCampaignBody: (r: Request) => r.json(),
  campaignErrorResponse: () => null,
}));
import { GET, POST } from "./route";
const session = { businessId: "tenant", sub: "actor", fullName: "Member" };
const owner = {
  businessId: "tenant",
  actorUserId: "actor",
  actorName: "Member",
};
const context = { params: Promise.resolve({ id: "campaign" }) };
const request = (method = "GET") =>
  new NextRequest("http://test/api/crm/client-campaigns/campaign/reports", {
    method,
    ...(method === "POST" ? { body: JSON.stringify({ spendRial: 12 }) } : {}),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.permission.mockResolvedValue({ session, error: null });
  m.workspace.mockResolvedValue({ owner, error: null });
  m.load.mockResolvedValue({
    projectId: "project",
    status: "running",
    startDate: "2026-10-01",
  });
  m.list.mockResolvedValue([]);
  m.create.mockResolvedValue({ id: "report" });
  m.member.mockResolvedValue({
    permissions: new Set([PERMISSIONS.crmManage, PERMISSIONS.workspaceManage]),
  });
  m.cap.mockResolvedValue("manager");
});
describe("campaign report boundaries", () => {
  it("requires CRM read and independently Workspace read for project-linked reports", async () => {
    expect((await GET(request(), context)).status).toBe(200);
    expect(m.permission).toHaveBeenCalledWith(PERMISSIONS.crmView);
    expect(m.workspace).toHaveBeenCalledWith(
      PERMISSIONS.workspaceView,
      expect.anything(),
    );
    expect(m.list).toHaveBeenCalledWith(
      { ...owner, workspaceAllowed: true },
      "campaign",
    );
  });
  it("exposes writing only for dated nonplanned campaigns", async () => {
    expect((await (await GET(request(), context)).json()).canWrite).toBe(true);
    m.load.mockResolvedValue({
      projectId: "project",
      status: "planned",
      startDate: "2026-10-01",
    });
    expect((await (await GET(request(), context)).json()).canWrite).toBe(false);
    m.load.mockResolvedValue({
      projectId: "project",
      status: "cancelled",
      startDate: null,
    });
    expect((await (await GET(request(), context)).json()).canWrite).toBe(false);
  });
  it("requires both write authorities before calling the reporting service", async () => {
    m.workspace.mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    expect((await POST(request("POST"), context)).status).toBe(403);
    expect(m.permission).toHaveBeenCalledWith(PERMISSIONS.crmManage);
    expect(m.workspace).toHaveBeenCalledWith(
      PERMISSIONS.workspaceManage,
      expect.anything(),
    );
    expect(m.create).not.toHaveBeenCalled();
  });
  it("never reads campaigns after a CRM denial", async () => {
    m.permission.mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    expect((await GET(request(), context)).status).toBe(403);
    expect((await POST(request("POST"), context)).status).toBe(403);
    expect(m.load).not.toHaveBeenCalled();
  });
  it("keeps unlinked CRM campaigns usable without granting any Workspace permission", async () => {
    m.load.mockResolvedValue({ projectId: null, status: "running" });
    expect((await POST(request("POST"), context)).status).toBe(201);
    expect(m.workspace).not.toHaveBeenCalled();
    expect(m.create).toHaveBeenCalledWith(
      { ...owner, workspaceAllowed: false },
      "campaign",
      { spendRial: 12 },
    );
  });
  it("hides the write form for a member without the independent manage permissions", async () => {
    m.member.mockResolvedValue({ permissions: new Set() });
    const response = await GET(request(), context);
    expect((await response.json()).canWrite).toBe(false);
  });
  it("returns scoped not-found/conflict/validation errors", async () => {
    m.load.mockResolvedValue(null);
    expect((await GET(request(), context)).status).toBe(404);
    m.load.mockResolvedValue({ projectId: null, status: "running" });
    m.create.mockRejectedValue(new CampaignReportError("report_conflict"));
    expect((await POST(request("POST"), context)).status).toBe(409);
    m.create.mockRejectedValue(new CampaignReportError("invalid_report"));
    expect((await POST(request("POST"), context)).status).toBe(400);
  });
});
