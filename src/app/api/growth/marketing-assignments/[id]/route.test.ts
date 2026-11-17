import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { PATCH } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ transitionAssignment: vi.fn(), changeAssignmentPriority: vi.fn() }));
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

describe("assignment priority endpoint", () => {
  it("requires management permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await PATCH(request({ action: "priority", expectedRevision: 0, priority: "high" }), context)).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketingAssignmentsManage);
    expect(service.changeAssignmentPriority).not.toHaveBeenCalled();
  });
  it("validates input, derives scope and rejects unknown actions", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "tenant", sub: "actor" }, membership: {}, error: null } as never);
    expect((await PATCH(request({ action: "priority", expectedRevision: -1, priority: "high" }), context)).status).toBe(400);
    expect((await PATCH(request({ action: "unknown", expected: "planned", next: "completed" }), context)).status).toBe(400);
    vi.mocked(service.changeAssignmentPriority).mockResolvedValue("updated");
    expect((await PATCH(request({ action: "priority", expectedRevision: 2, priority: "urgent", businessId: "forged" }), context)).status).toBe(200);
    expect(service.changeAssignmentPriority).toHaveBeenCalledWith("tenant", "actor", ["branch"], id, { action: "priority", expectedRevision: 2, priority: "urgent" });
    vi.mocked(service.transitionAssignment).mockResolvedValue("updated");
    expect((await PATCH(request({ expected: "planned", next: "completed" }), context)).status).toBe(200);
    expect(service.transitionAssignment).toHaveBeenCalledWith("tenant", "actor", ["branch"], id, "planned", "completed");
  });
  it("returns scoped not found and stale conflicts", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "tenant", sub: "actor" }, membership: {}, error: null } as never);
    for (const [value, status] of [["not_found", 404], ["conflict", 409]] as const) {
      vi.mocked(service.changeAssignmentPriority).mockResolvedValue(value);
      const response = await PATCH(request({ action: "priority", expectedRevision: 0, priority: "high" }), context);
      expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: value });
    }
  });
});
