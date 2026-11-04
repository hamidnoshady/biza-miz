import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { PATCH } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ transitionAssignment: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const request = (body: unknown) => new NextRequest(`http://localhost/api/growth/marketing-assignments/${id}`, { method: "PATCH", body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id }) };
beforeEach(() => { vi.clearAllMocks(); });
describe("assignment status guard", () => {
  it("does not update without management permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    const response = await PATCH(request({ expected: "planned", next: "completed" }), context);
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsManage);
    expect(service.transitionAssignment).not.toHaveBeenCalled();
  });
  it("reports stale updates as conflicts, and refuses invalid transitions", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz", sub: "actor" }, membership: {}, error: null } as never);
    vi.mocked(service.transitionAssignment).mockResolvedValue("conflict");
    expect((await PATCH(request({ expected: "planned", next: "completed" }), context)).status).toBe(409);
    expect(service.transitionAssignment).toHaveBeenCalledWith("biz", "actor", ["branch"], id, "planned", "completed");
    expect((await PATCH(request({ expected: "completed", next: "planned" }), context)).status).toBe(400);
    expect(service.transitionAssignment).toHaveBeenCalledTimes(1);
  });
});
