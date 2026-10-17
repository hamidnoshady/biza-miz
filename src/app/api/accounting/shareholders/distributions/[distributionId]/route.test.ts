import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getShareholderDistributionDetail: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/lib/shareholder-read-service", () => ({
  getShareholderDistributionDetail: mocks.getShareholderDistributionDetail,
}));

const session = { businessId: "business-1", sub: "accountant-1", role: "accountant" as const };
const membership = { role: "accountant", permissions: new Set([PERMISSIONS.shareholdersView]) };
const distributionId = "550e8400-e29b-41d4-a716-446655440000";
const context = { params: Promise.resolve({ distributionId }) };
const request = new NextRequest(`http://localhost/api/accounting/shareholders/distributions/${distributionId}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ session, membership, error: null });
  mocks.getShareholderDistributionDetail.mockResolvedValue({ id: distributionId, status: "posted" });
});

describe("GET /api/accounting/shareholders/distributions/[distributionId]", () => {
  it("authorizes and reads the explicitly selected distribution using the session tenant", async () => {
    const response = await GET(request, context) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.shareholdersView);
    expect(mocks.getShareholderDistributionDetail).toHaveBeenCalledWith(
      session.businessId,
      expect.objectContaining({ userId: session.sub, role: session.role, permissions: membership.permissions }),
      distributionId,
    );
    await expect(response.json()).resolves.toEqual({ id: distributionId, status: "posted" });
  });

  it("returns permission denial before invoking the tenant-scoped detail reader", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    mocks.requirePermission.mockResolvedValue({ session: null, membership: null, error: denied });

    const response = await GET(request, context) as Response;

    expect(response.status).toBe(403);
    expect(mocks.getShareholderDistributionDetail).not.toHaveBeenCalled();
  });

  it("does not reveal a missing or foreign-tenant distribution", async () => {
    mocks.getShareholderDistributionDetail.mockResolvedValue(null);

    const response = await GET(request, context) as Response;

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "distribution_not_found" });
  });
});
