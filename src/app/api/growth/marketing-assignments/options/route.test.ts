import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as ops from "@/lib/marketing-operations-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ assignmentOptions: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const request = (query: string) => new NextRequest(`http://localhost/api/growth/marketing-assignments/options?${query}`);
beforeEach(() => vi.clearAllMocks());
describe("assignment option search", () => {
  it("requires assignment management", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await GET(request(""))).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsManage);
    expect(ops.assignmentOptions).not.toHaveBeenCalled();
  });
  it("validates parameters and scopes both searches", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "business" }, membership: {}, error: null } as never);
    vi.mocked(ops.assignmentOptions).mockResolvedValue({ locations: [], targets: [], agents: [], targetHasMore: false, agentHasMore: false });
    expect((await GET(request(`location=${id}&targetQ=Shop&targetPage=2&agentQ=Partner&agentPage=3`))).status).toBe(200);
    expect(ops.assignmentOptions).toHaveBeenCalledWith("business", ["branch"], id, "Shop", 2, "Partner", 3);
    for (const input of ["location=bad", "targetPage=0", "agentPage=10001", "targetPage=2.5", `targetQ=${"x".repeat(151)}`]) expect((await GET(request(input))).status).toBe(400);
  });
});
