import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const requirePermission = vi.fn();
const workspaceAccessFor = vi.fn();

vi.mock("@/lib/auth", () => ({ requirePermission }));
vi.mock("@/lib/workspace-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace-access")>(
    "@/lib/workspace-access",
  );
  return { ...actual, workspaceAccessFor };
});

const session = {
  sub: "user-1",
  role: "owner",
  businessId: "biz-1",
  locationId: null,
  fullName: "مالک",
};
const membership = {
  permissions: new Set([PERMISSIONS.workspaceView]),
  role: "owner",
  isActive: true,
};

describe("Workspace API authorization (issue #1110)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ session, membership, error: null });
  });

  it("refuses a read for an ineligible/inactive/unauthorized Workspace", async () => {
    workspaceAccessFor.mockResolvedValue({
      available: false,
      reason: "BUSINESS_TYPE_UNSUPPORTED",
      eligible: false,
      serviceEnabled: true,
      deploymentSupported: true,
      permitted: true,
      industry: "food_service",
      industryReason: "INDUSTRY_INELIGIBLE",
    });
    const { workspaceOwner } = await import("./guard");
    const result = await workspaceOwner(PERMISSIONS.workspaceView);
    expect(result.error).toBeInstanceOf(NextResponse);
    expect(result.error?.status).toBe(403);
    await expect(result.error?.json()).resolves.toMatchObject({
      error: "workspace_not_available",
      reason: "BUSINESS_TYPE_UNSUPPORTED",
    });
    expect(result.owner).toBeNull();
  });

  it("admits an eligible, active, authorized member and keeps project scoping in the service", async () => {
    workspaceAccessFor.mockResolvedValue({
      available: true,
      reason: null,
      eligible: true,
      serviceEnabled: true,
      deploymentSupported: true,
      permitted: true,
      industry: "architecture_construction",
      industryReason: "INDUSTRY_ELIGIBLE",
    });
    const { workspaceOwner } = await import("./guard");
    const result = await workspaceOwner(PERMISSIONS.workspaceView);
    expect(result.error).toBeNull();
    expect(result.owner).toMatchObject({
      businessId: "biz-1",
      actorUserId: "user-1",
    });
    expect(workspaceAccessFor).toHaveBeenCalledWith(
      "biz-1",
      membership.permissions,
    );
  });
});

describe("AEC API authorization (issue #1110)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ session, membership, error: null });
  });

  it("refuses the AEC registers when Workspace is unavailable", async () => {
    workspaceAccessFor.mockResolvedValue({
      available: false,
      reason: "WORKSPACE_SERVICE_DISABLED",
      eligible: true,
      serviceEnabled: false,
      deploymentSupported: true,
      permitted: true,
      industry: "architecture_construction",
      industryReason: "INDUSTRY_ELIGIBLE",
    });
    const { aecOwner } = await import("../aec/guard");
    const result = await aecOwner(PERMISSIONS.workspaceView);
    expect(result.error?.status).toBe(403);
    await expect(result.error?.json()).resolves.toMatchObject({
      error: "workspace_not_available",
      reason: "WORKSPACE_SERVICE_DISABLED",
    });
  });
});
