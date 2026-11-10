import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-touchpoints-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET, POST } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermissions: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-touchpoints-service", () => ({ recordOwnMarketingTouch: vi.fn(), listOwnMarketingTouches: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const body = { assignmentId: id, leadId: id, idempotencyKey: id, channel: "phone", source: "phone" };
const req = (payload: unknown) => new NextRequest("http://localhost/api/growth/my-marketing-touchpoints", { method: "POST", body: JSON.stringify(payload) });
beforeEach(() => vi.clearAllMocks());
describe("own marketing touch route", () => {
  it("requires the self capability AND both explicit CRM permissions", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await POST(req(body))).status).toBe(403);
    expect(auth.requirePermissions).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsSelf, PERMISSIONS.crmView, PERMISSIONS.crmManage);
    expect(service.recordOwnMarketingTouch).not.toHaveBeenCalled();
  });
  it("requires the same three explicit permissions to view private history", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await GET(new NextRequest("http://localhost/api/growth/my-marketing-touchpoints"))).status).toBe(403);
    expect(auth.requirePermissions).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsSelf, PERMISSIONS.crmView, PERMISSIONS.crmManage);
    expect(service.listOwnMarketingTouches).not.toHaveBeenCalled();
  });
  it("validates history search and derives scope from the authenticated session", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "biz", sub: "actor" }, membership: {}, error: null } as never);
    vi.mocked(service.listOwnMarketingTouches).mockResolvedValue({ touches: [], hasMore: false });
    const url = "http://localhost/api/growth/my-marketing-touchpoints";
    for (const query of ["?page=0", "?page=10001", "?page=1.1", "?q=" + "a".repeat(151)]) expect((await GET(new NextRequest(url+query))).status).toBe(400);
    expect((await GET(new NextRequest(url+"?q=Lead&page=2&actorId=other&locationId=other"))).status).toBe(200);
    expect(service.listOwnMarketingTouches).toHaveBeenCalledWith("biz", "actor", ["branch"], "Lead", 2);
  });
  it("derives actor, tenant and locations, rejecting invalid input", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "biz", sub: "actor" }, membership: {}, error: null } as never);
    expect((await POST(req({ ...body, assignmentId: "bad" }))).status).toBe(400);
    vi.mocked(service.recordOwnMarketingTouch).mockResolvedValue({ kind: "replayed", id });
    expect((await POST(req({ ...body, businessId: "other", actorId: "other", locationId: "other" }))).status).toBe(200);
    expect(service.recordOwnMarketingTouch).toHaveBeenCalledWith("biz", "actor", ["branch"], body);
  });
  it.each([["created",201], ["not_found",404], ["conflict",409], ["party_mismatch",409]] as const)("maps %s safely", async (kind, status) => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "biz", sub: "actor" }, membership: {}, error: null } as never);
    vi.mocked(service.recordOwnMarketingTouch).mockResolvedValue((kind === "created" ? { kind, id } : { kind }) as never);
    expect((await POST(req(body))).status).toBe(status);
  });
});
