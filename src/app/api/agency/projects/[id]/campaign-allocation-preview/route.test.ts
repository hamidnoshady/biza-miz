import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { CampaignAllocationError } from "@/lib/agency-campaign-allocation";
const m = vi.hoisted(() => ({
  permission: vi.fn(),
  owner: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: m.permission,
}));
vi.mock("@/lib/agency-campaign-allocation-service", () => ({
  previewPostedCampaignAllocation: m.preview,
}));
vi.mock("../../../guard", () => ({
  agencyOwner: m.owner,
  PERMISSIONS: {
    workspaceManage: "workspace.manage",
    ledgerApprove: "ledger.approve",
    ledgerView: "ledger.view",
    crmView: "crm.view",
  },
  readBody: (r: Request) => r.json(),
  handleAgencyError: (err: unknown) => {
    throw err;
  },
}));
import { POST } from "./route";
const owner = { businessId: "tenant", actorUserId: "actor" };
const context = { params: Promise.resolve({ id: "project" }) };
const request = () =>
  new NextRequest(
    "http://test/api/agency/projects/project/campaign-allocation-preview",
    { method: "POST", body: '{"sourceLineId":"1","amountRial":"forged"}' },
  );
beforeEach(() => {
  vi.clearAllMocks();
  m.permission.mockResolvedValue({ error: null });
  m.owner.mockResolvedValue({ owner, error: null });
  m.preview.mockResolvedValue({ previewOnly: true });
});
describe("campaign allocation preview authority", () => {
  it("intersects live ledger, CRM and Workspace authority", async () => {
    expect((await POST(request(), context)).status).toBe(200);
    expect(m.permission).toHaveBeenNthCalledWith(1, "ledger.approve");
    expect(m.permission).toHaveBeenNthCalledWith(2, "ledger.view");
    expect(m.permission).toHaveBeenNthCalledWith(3, "crm.view");
    expect(m.owner).toHaveBeenCalledWith(
      "workspace.manage",
      expect.any(NextRequest),
    );
    expect(m.preview).toHaveBeenCalledWith(owner, "project", {
      sourceLineId: "1",
      amountRial: "forged",
    });
  });
  it.each([1, 2, 3])("stops at live permission refusal %s", async (nth) => {
    m.permission.mockReset().mockResolvedValue({ error: null });
    for (let index = 1; index < nth; index++)
      m.permission.mockResolvedValueOnce({ error: null });
    m.permission.mockResolvedValueOnce({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    expect((await POST(request(), context)).status).toBe(403);
    expect(m.owner).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
  });
  it("stops on Workspace service/permission refusal", async () => {
    m.owner.mockResolvedValue({
      error: NextResponse.json({ error: "service_disabled" }, { status: 403 }),
    });
    expect((await POST(request(), context)).status).toBe(403);
    expect(m.preview).not.toHaveBeenCalled();
  });
  it.each([
    ["invalid_allocation", 400],
    ["allocation_source_not_found", 404],
    ["allocation_campaign_not_found", 404],
  ] as const)("maps %s without ledger metadata", async (code, status) => {
    m.preview.mockRejectedValue(new CampaignAllocationError(code));
    const response = await POST(request(), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
  it("does not disguise unexpected errors", async () => {
    m.preview.mockRejectedValue(new Error("database unavailable"));
    await expect(POST(request(), context)).rejects.toThrow(
      "database unavailable",
    );
  });
});
