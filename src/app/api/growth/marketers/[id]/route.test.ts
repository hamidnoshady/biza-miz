import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as roster from "@/lib/marketing-roster-service";
import { PERMISSIONS } from "@/lib/permissions";
import { PATCH } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-roster-service", () => ({ changeMarketer: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const context = { params: Promise.resolve({ id }) };
const request = (body: unknown) => new NextRequest(`http://localhost/api/growth/marketers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => vi.clearAllMocks());
describe("marketer lifecycle API", () => {
  it("requires roster management", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await PATCH(request({ action: "deactivate", expectedRevision: 0 }), context)).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketersManage);
    expect(roster.changeMarketer).not.toHaveBeenCalled();
  });
  it("validates input and derives scope and identity from the session", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "business", sub: "actor" }, membership: {}, error: null } as never);
    expect((await PATCH(request({ action: "reactivate", expectedRevision: -1 }), context)).status).toBe(400);
    expect((await PATCH(request({ action: "deactivate", expectedRevision: 0 }), { params: Promise.resolve({ id: "invalid" }) })).status).toBe(400);
    vi.mocked(roster.changeMarketer).mockResolvedValue("updated");
    expect((await PATCH(request({ action: "rename", name: " Partner ", expectedRevision: 1, businessId: "forged", userId: id, locationId: id }), context)).status).toBe(200);
    expect(roster.changeMarketer).toHaveBeenCalledWith("business", "actor", ["branch"], id, { action: "rename", name: "Partner", expectedRevision: 1 });
  });
  it("does not disclose cross-scope records and surfaces each conflict", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "business", sub: "actor" }, membership: {}, error: null } as never);
    for (const [value, status] of [["not_found", 404], ["conflict", 409], ["open_assignments", 409], ["ineligible_user", 409]] as const) {
      vi.mocked(roster.changeMarketer).mockResolvedValue(value);
      const result = await PATCH(request({ action: "deactivate", expectedRevision: 0 }), context);
      expect(result.status).toBe(status); expect(await result.json()).toEqual({ error: value });
    }
  });
});
