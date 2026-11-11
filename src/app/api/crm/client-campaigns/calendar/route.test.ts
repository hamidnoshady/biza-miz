import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
const m = vi.hoisted(() => ({
  permission: vi.fn(),
  member: vi.fn(),
  workspace: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requirePermission: m.permission,
  withTenantScope: (fn: unknown) => fn,
}));
vi.mock("@/lib/member-access", () => ({ memberAccessFor: m.member }));
vi.mock("@/app/api/workspace/guard", () => ({ workspaceOwner: m.workspace }));
vi.mock("@/lib/agency-campaign-calendar-service", () => ({
  listCampaignCalendar: m.list,
}));
import { GET } from "./route";
const session = { businessId: "tenant", sub: "actor" };
const request = (query = "start=2026-10-01&end=2026-10-31") =>
  new NextRequest(`http://test/api/crm/client-campaigns/calendar?${query}`);
beforeEach(() => {
  vi.clearAllMocks();
  m.permission.mockResolvedValue({ session, error: null });
  m.member.mockResolvedValue({ permissions: new Set() });
  m.workspace.mockResolvedValue({
    owner: {
      businessId: "tenant",
      actorUserId: "actor",
      access: { override: "read" },
    },
    error: null,
  });
  m.list.mockResolvedValue({ events: [], nextOffset: null });
});
describe("campaign calendar boundary", () => {
  it("requires CRM view before any source access", async () => {
    m.permission.mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    expect((await GET(request())).status).toBe(403);
    expect(m.permission).toHaveBeenCalledWith(PERMISSIONS.crmView);
    expect(m.member).not.toHaveBeenCalled();
    expect(m.list).not.toHaveBeenCalled();
  });
  it("does not grant project visibility from CRM permission alone", async () => {
    expect((await GET(request())).status).toBe(200);
    expect(m.workspace).not.toHaveBeenCalled();
    expect(m.list).toHaveBeenCalledWith(
      { businessId: "tenant", actorUserId: "actor", workspaceAllowed: false },
      { start: "2026-10-01", end: "2026-10-31", offset: 0, partyId: null },
    );
  });
  it("uses live Workspace guard and source override flags only after independent permission", async () => {
    m.member.mockResolvedValue({
      permissions: new Set([PERMISSIONS.workspaceView]),
    });
    await GET(request());
    expect(m.workspace).toHaveBeenCalledWith(
      PERMISSIONS.workspaceView,
      expect.anything(),
    );
    expect(m.list.mock.calls[0][0]).toMatchObject({
      workspaceAllowed: true,
      access: { override: "read" },
    });
  });
  it("does not downgrade a Workspace guard error to unfiltered CRM access", async () => {
    m.member.mockResolvedValue({
      permissions: new Set([PERMISSIONS.workspaceView]),
    });
    m.workspace.mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    expect((await GET(request())).status).toBe(403);
    expect(m.list).not.toHaveBeenCalled();
  });
  it("refuses invalid ranges before invoking source", async () => {
    expect((await GET(request("start=bad&end=2026-10-01"))).status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });
});
