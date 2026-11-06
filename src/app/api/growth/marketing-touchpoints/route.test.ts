import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-touchpoints-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET, POST } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn(), requirePermissions: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-touchpoints-service", () => ({ listMarketingTouches: vi.fn(), recordMarketingTouch: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const body = { assignmentId: id, leadId: id, idempotencyKey: id, channel: "phone", source: "phone" };
const req = (payload: unknown) => new NextRequest("http://localhost/api/growth/marketing-touchpoints", { method: "POST", body: JSON.stringify(payload) });
beforeEach(() => vi.clearAllMocks());
describe("marketing touchpoint authorization", () => {
  it("requires attribution management, assignment view and CRM read and manage", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await POST(req(body))).status).toBe(403);
    expect(auth.requirePermissions).toHaveBeenCalledWith(PERMISSIONS.marketingAttributionManage, PERMISSIONS.crmView, PERMISSIONS.crmManage, PERMISSIONS.marketingAssignmentsView);
    expect(service.recordMarketingTouch).not.toHaveBeenCalled();
  });
  it("derives tenant and actor from the session and returns a replay without another creation", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "biz", sub: "actor" }, membership: {}, error: null } as never);
    vi.mocked(service.recordMarketingTouch).mockResolvedValue({ kind: "replayed", id });
    const response = await POST(req({ ...body, businessId: "other", actorId: "other" }));
    expect(response.status).toBe(200);
    expect(service.recordMarketingTouch).toHaveBeenCalledWith("biz", "actor", ["branch"], body);
  });
  it("does not reveal lead identities to a role holding only attribution view", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz" }, membership: { permissions: new Set([PERMISSIONS.marketingAttributionView]) }, error: null } as never);
    vi.mocked(service.listMarketingTouches).mockResolvedValue({ touches: [], hasMore: false });
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-touchpoints"))).status).toBe(200);
    expect(service.listMarketingTouches).toHaveBeenCalledWith("biz", ["branch"], "", 1, false);
  });
});
