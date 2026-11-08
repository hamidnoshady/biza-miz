import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { PERMISSIONS } from "@/lib/permissions";
import { PATCH } from "./route";
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["branch"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ changeTarget: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const request = (body: unknown) => new NextRequest(`http://localhost/api/growth/marketing-targets/${id}`, { method: "PATCH", body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id }) };
beforeEach(() => { vi.clearAllMocks(); });
describe("target lifecycle endpoint", () => {
  it("enforces management permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) } as never);
    expect((await PATCH(request({ action: "archive", expectedRevision: 0 }), context)).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.marketingTargetsManage);
    expect(service.changeTarget).not.toHaveBeenCalled();
  });
  it("validates inputs and derives tenant, actor and branches from authorization", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "tenant", sub: "actor" }, membership: {}, error: null } as never);
    expect((await PATCH(request({ action: "archive", expectedRevision: -1 }), context)).status).toBe(400);
    vi.mocked(service.changeTarget).mockResolvedValue("updated");
    expect((await PATCH(request({ action: "edit", expectedRevision: 2, siteLabel: " Site ", city: "", neighborhood: "", businessId: "forged", locationId: id, partyId: id }), context)).status).toBe(200);
    expect(service.changeTarget).toHaveBeenCalledWith("tenant", "actor", ["branch"], id, { action: "edit", expectedRevision: 2, siteLabel: "Site", city: "", neighborhood: "" });
  });
  it("returns scoped not found and distinct conflict responses", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "tenant", sub: "actor" }, membership: {}, error: null } as never);
    for (const [result, status] of [["not_found", 404], ["conflict", 409], ["open_assignments", 409]] as const) {
      vi.mocked(service.changeTarget).mockResolvedValue(result);
      const response = await PATCH(request({ action: "archive", expectedRevision: 0 }), context);
      expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: result });
    }
  });
});
