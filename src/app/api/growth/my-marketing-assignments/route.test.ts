import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";
import { PATCH } from "./[id]/route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["allowed"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ listOwnAssignments: vi.fn(), transitionOwnAssignment: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const context = { params: Promise.resolve({ id }) };
const req = (body: unknown) => new NextRequest(`http://localhost/api/growth/my-marketing-assignments/${id}`, { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => vi.clearAllMocks());
describe("own assignment API", () => {
  it("requires the self capability and does not call the service on denial", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await GET(new NextRequest("http://localhost/api/growth/my-marketing-assignments"))).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsSelf);
    expect(service.listOwnAssignments).not.toHaveBeenCalled();
  });
  it("uses the authenticated member and actionable locations, not caller-supplied identities", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz", sub: "actor" }, membership: {}, error: null } as never);
    vi.mocked(service.listOwnAssignments).mockResolvedValue({ assignments: [], hasMore: false });
    expect((await GET(new NextRequest("http://localhost/api/growth/my-marketing-assignments?actor=other&business=other"))).status).toBe(200);
    expect(service.listOwnAssignments).toHaveBeenCalledWith("biz", "actor", ["allowed"], "", 1, null);
    vi.mocked(service.transitionOwnAssignment).mockResolvedValue("not_found");
    expect((await PATCH(req({ expected: "planned", next: "completed", actor: "other" }), context)).status).toBe(404);
    expect(service.transitionOwnAssignment).toHaveBeenCalledWith("biz", "actor", ["allowed"], id, "planned", "completed");
    expect((await PATCH(req({ expected: "planned", next: "canceled" }), context)).status).toBe(400);
  });
});

describe("self assignment priority filter", () => {
  it("requires self permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await GET(new NextRequest("http://localhost/api/growth/my-marketing-assignments?priority=high"))).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsSelf);
  });
  it("validates filter and preserves authenticated actor and scope", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "tenant", sub: "actor" }, membership: {}, error: null } as never);
    vi.mocked(service.listOwnAssignments).mockResolvedValue({ assignments: [], hasMore: false });
    expect((await GET(new NextRequest("http://localhost/api/growth/my-marketing-assignments?priority=bad"))).status).toBe(400);
    expect((await GET(new NextRequest("http://localhost/api/growth/my-marketing-assignments?q=Call&page=2&priority=high&actor=forged"))).status).toBe(200);
    expect(service.listOwnAssignments).toHaveBeenCalledWith("tenant", "actor", ["allowed"], "Call", 2, "high");
  });
});
