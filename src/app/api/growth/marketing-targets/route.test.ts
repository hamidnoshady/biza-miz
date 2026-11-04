import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(), requirePermissions: vi.fn(),
}));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["123e4567-e89b-42d3-a456-426614174000"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ createTarget: vi.fn(), listTargets: vi.fn() }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const request = (body: unknown) => new NextRequest("http://localhost/api/growth/marketing-targets", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); });
describe("target creation guard", () => {
  it("requires both target management and the directory permission", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    const response = await POST(request({ locationId: id, siteLabel: "Site" }));
    expect(response.status).toBe(403);
    expect(auth.requirePermissions).toHaveBeenCalledWith(PERMISSIONS.marketingTargetsManage, PERMISSIONS.partiesView);
    expect(service.createTarget).not.toHaveBeenCalled();
  });
  it("uses the resolved tenant, actor and authorized branches rather than request claims", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "business", sub: "actor" }, membership: { role: "manager" }, error: null } as never);
    vi.mocked(service.createTarget).mockResolvedValue({ id } as never);
    const response = await POST(request({ locationId: id, siteLabel: "Site", businessId: "other", actorId: "other" }));
    expect(response.status).toBe(201);
    expect(service.createTarget).toHaveBeenCalledWith("business", "actor", [id], { locationId: id, siteLabel: "Site", partyId: null, city: "", neighborhood: "" });
  });
});
