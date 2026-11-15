import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as service from "@/lib/marketing-operations-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(), requirePermissions: vi.fn(),
}));
vi.mock("@/lib/authorize", () => ({ actionableLocationIds: vi.fn(async () => ["123e4567-e89b-42d3-a456-426614174000"]) }));
vi.mock("@/lib/marketing-operations-service", () => ({ createTarget: vi.fn(), listTargets: vi.fn(), DuplicateTargetReview: class DuplicateTargetReview extends Error { constructor(public candidates: unknown[], public hasMore: boolean, public reviewToken: string) { super("possible_duplicate_target"); } }, TargetReviewChanged: class TargetReviewChanged extends Error {} }));
const id = "123e4567-e89b-42d3-a456-426614174000";
const request = (body: unknown) => new NextRequest("http://localhost/api/growth/marketing-targets", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); });
describe("target creation guard", () => {
  it("requires target view, management and the directory permission", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    const response = await POST(request({ locationId: id, siteLabel: "Site" }));
    expect(response.status).toBe(403);
    expect(auth.requirePermissions).toHaveBeenCalledWith(PERMISSIONS.marketingTargetsView, PERMISSIONS.marketingTargetsManage, PERMISSIONS.partiesView);
    expect(service.createTarget).not.toHaveBeenCalled();
  });
  it("returns the scoped candidate review and passes the snapshot on confirmation", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "business", sub: "actor" }, membership: {}, error: null } as never);
    const token = "a".repeat(64);
    const candidate = { id, site_label: "Site", city: "", neighborhood: "", status: "archived" as const, revision: 1, party_linked: true };
    vi.mocked(service.createTarget).mockRejectedValueOnce(new service.DuplicateTargetReview([candidate], false, token)).mockResolvedValueOnce({ id });
    const first = await POST(request({ locationId: id, siteLabel: "Site" }));
    expect(first.status).toBe(409); expect(await first.json()).toEqual({ error: "possible_duplicate_target", candidates: [candidate], hasMore: false, reviewToken: token });
    expect((await POST(request({ locationId: id, siteLabel: "Site", reviewToken: "invalid" }))).status).toBe(400);
    expect((await POST(request({ locationId: id, siteLabel: "Site", reviewToken: token }))).status).toBe(201);
    expect(service.createTarget).toHaveBeenLastCalledWith("business", "actor", [id], { locationId: id, siteLabel: "Site", partyId: null, city: "", neighborhood: "", reviewToken: token });
  });
  it("uses the resolved tenant, actor and authorized branches rather than request claims", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue({ session: { businessId: "business", sub: "actor" }, membership: { role: "manager" }, error: null } as never);
    vi.mocked(service.createTarget).mockResolvedValue({ id } as never);
    const response = await POST(request({ locationId: id, siteLabel: "Site", businessId: "other", actorId: "other" }));
    expect(response.status).toBe(201);
    expect(service.createTarget).toHaveBeenCalledWith("business", "actor", [id], { locationId: id, siteLabel: "Site", partyId: null, city: "", neighborhood: "" });
  });
});

describe("target list status", () => {
  it("defaults to active, accepts archived, and rejects unknown statuses", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "business" }, membership: {}, error: null } as never);
    vi.mocked(service.listTargets).mockResolvedValue({ targets: [], hasMore: false });
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-targets"))).status).toBe(200);
    expect(service.listTargets).toHaveBeenLastCalledWith("business", [id], "", 1, "active");
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-targets?status=archived"))).status).toBe(200);
    expect(service.listTargets).toHaveBeenLastCalledWith("business", [id], "", 1, "archived");
    expect((await GET(new NextRequest("http://localhost/api/growth/marketing-targets?status=deleted"))).status).toBe(400);
  });
});
