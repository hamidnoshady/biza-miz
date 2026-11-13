import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ listAssignments: vi.fn(), createAssignment: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe("manager assignment priority filter", () => {
  it("requires view permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-assignments?priority=urgent"))).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsView);
  });
  it("validates the filter and supplies session scope", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "tenant", sub: "actor" }, membership: {}, error: null } as never);
    vi.mocked(service.listAssignments).mockResolvedValue({ assignments: [], hasMore: false });
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-assignments?priority=invalid"))).status).toBe(400);
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-assignments?priority="))).status).toBe(400);
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-assignments?q=Call&page=2&priority=urgent"))).status).toBe(200);
    expect(service.listAssignments).toHaveBeenCalledWith("tenant", ["branch"], "Call", 2, "urgent");
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-assignments"))).status).toBe(200);
    expect(service.listAssignments).toHaveBeenLastCalledWith("tenant", ["branch"], "", 1, null);
  });
});
