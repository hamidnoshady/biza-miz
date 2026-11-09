import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-touchpoints-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermissions: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-touchpoints-service", () => ({ listMarketingTouchesForLead: vi.fn() }));
const lead = "123e4567-e89b-42d3-a456-426614174000";
const req = (query: string) => new NextRequest(`http://localhost/api/growth/marketing-touchpoints/by-lead?${query}`);
beforeEach(() => vi.clearAllMocks());
describe("CRM projection of marketer touchpoints", () => {
  it("requires the full intersection of Growth and CRM permissions", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await GET(req(`leadId=${lead}`))).status).toBe(403);
    expect(auth.requirePermissions).toHaveBeenCalledWith(PERMISSIONS.marketingAttributionView, PERMISSIONS.crmView, PERMISSIONS.crmManage);
    expect(service.listMarketingTouchesForLead).not.toHaveBeenCalled();
  });
  it("validates lead and bounded page, and uses authenticated tenant and branch scope", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "business" }, membership: {}, error: null } as never);
    vi.mocked(service.listMarketingTouchesForLead).mockResolvedValue({ touches: [], hasMore: false });
    for (const value of ["", "leadId=invalid", `leadId=${lead}&page=0`, `leadId=${lead}&page=1.2`, `leadId=${lead}&page=10001`]) expect((await GET(req(value))).status).toBe(400);
    expect((await GET(req(`leadId=${lead}&page=2&businessId=forged&locationId=forged`))).status).toBe(200);
    expect(service.listMarketingTouchesForLead).toHaveBeenCalledWith("business", ["branch"], lead, 2);
  });
});
