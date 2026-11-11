import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as roster from "@/lib/marketing-roster-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["authorized"]) }));
vi.mock("@/lib/marketing-roster-service", () => ({ listSupervisorCandidates: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const req = (query: string) => new NextRequest(`http://localhost/api/growth/marketers/supervisors?${query}`);
beforeEach(() => vi.clearAllMocks());
describe("supervisor picker API", () => {
  it("requires explicit roster management", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await GET(req(`locationId=${id}`))).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketersManage);
    expect(roster.listSupervisorCandidates).not.toHaveBeenCalled();
  });
  it("validates inputs and derives tenant and actionable branches from the session", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "business" }, membership: {}, error: null } as never);
    vi.mocked(roster.listSupervisorCandidates).mockResolvedValue({ supervisors: [], hasMore: false });
    for (const query of ["locationId=bad", `locationId=${id}&page=0`, `locationId=${id}&page=10001`, `locationId=${id}&page=1.5`, `locationId=${id}&q=${"a".repeat(151)}`]) expect((await GET(req(query))).status).toBe(400);
    expect((await GET(req(`locationId=${id}&page=2&q=Ali&businessId=forged`))).status).toBe(200);
    expect(roster.listSupervisorCandidates).toHaveBeenCalledWith("business", ["authorized"], id, "Ali", 2);
  });
});
