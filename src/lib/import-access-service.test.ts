/**
 * GitHub #1580 — the database-facing access resolver.
 *
 * The pure matrix is pinned in `import-access.test.ts`; this suite pins the
 * *wiring*: which canonical axis the resolver reads, that each shared axis is
 * read once per batch, and that a background caller's "permission already
 * enforced" flag does not turn into a permission bypass for the service axis.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSelection,
  mockActivation,
  mockWorkspaceActivation,
  mockGrant,
  mockAvailability,
  mockWorkspace,
} = vi.hoisted(() => ({
  mockSelection: vi.fn(),
  mockActivation: vi.fn(),
  mockWorkspaceActivation: vi.fn(),
  mockGrant: vi.fn(),
  mockAvailability: vi.fn(),
  mockWorkspace: vi.fn(),
}));

vi.mock("./setup-apps-service", () => ({ getSelectedSetupApps: mockSelection }));
vi.mock("./service-activation/app-gate-service", () => ({
  appServiceActivationState: mockActivation,
  serviceActivationState: mockWorkspaceActivation,
}));
vi.mock("./complimentary-grant-service", () => ({
  readActiveComplimentaryGrant: mockGrant,
}));
vi.mock("./app-availability-service", () => ({
  effectiveAppAvailability: mockAvailability,
}));
vi.mock("./workspace-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace-access")>();
  return { ...actual, workspaceAccessFor: mockWorkspace };
});

import { importAccessForTarget, importAccessForTargets } from "./import-access-service";

const AT = "2026-11-27T12:00:00.000Z";
const businessId = "biz-1";

const PERMITTED = new Set(["data.import", "menu.edit", "crm.edit"]);

beforeEach(() => {
  vi.clearAllMocks();
  mockSelection.mockResolvedValue(["accounting"]);
  mockActivation.mockResolvedValue("active");
  mockWorkspaceActivation.mockResolvedValue(null);
  mockGrant.mockResolvedValue(null);
  mockAvailability.mockResolvedValue({});
  mockWorkspace.mockResolvedValue({
    available: true,
    eligible: true,
    serviceEnabled: true,
    deploymentSupported: true,
    permitted: true,
    reason: null,
    industry: "architecture_construction",
    industryReason: "INDUSTRY_ELIGIBLE",
  });
});

const target = {
  module: "pos" as const,
  requiredPermission: "menu.edit",
  importable: true,
};

describe("importAccessForTarget", () => {
  it("allows an active paid app and reads the selection + activation axes", async () => {
    const decision = await importAccessForTarget({
      businessId,
      ...target,
      permissions: PERMITTED,
      at: AT,
    });
    expect(decision).toMatchObject({ allowed: true, source: "paid_active" });
    expect(mockSelection).toHaveBeenCalledWith(businessId);
    expect(mockActivation).toHaveBeenCalledWith(businessId, "accounting");
  });

  it("allows an active grant when no activation row exists (#1579)", async () => {
    mockActivation.mockResolvedValue(null);
    mockGrant.mockResolvedValue({
      status: "active",
      startsAt: "2026-11-01T00:00:00.000Z",
      expiresAt: null,
    });
    const decision = await importAccessForTarget({
      businessId,
      ...target,
      permissions: PERMITTED,
      at: AT,
    });
    expect(decision).toMatchObject({ allowed: true, source: "complimentary_grant" });
  });

  it("returns awaiting activation for a selected app with no activation or grant", async () => {
    mockActivation.mockResolvedValue(null);
    const decision = await importAccessForTarget({
      businessId,
      ...target,
      permissions: PERMITTED,
      at: AT,
    });
    expect(decision).toMatchObject({
      allowed: false,
      stagingAllowed: true,
      reason: "awaiting_activation",
    });
  });

  it("keeps a legacy tenant's access (no gallery selection)", async () => {
    mockSelection.mockResolvedValue(null);
    mockActivation.mockResolvedValue(null);
    const decision = await importAccessForTarget({
      businessId,
      ...target,
      permissions: PERMITTED,
      at: AT,
    });
    expect(decision).toMatchObject({ allowed: true, source: "legacy_grandfathered" });
  });

  it("denies on a failed selection read instead of grandmothering", async () => {
    mockSelection.mockRejectedValue(new Error("db down"));
    mockActivation.mockResolvedValue(null);
    const decision = await importAccessForTarget({
      businessId,
      ...target,
      permissions: PERMITTED,
      at: AT,
    });
    expect(decision.reason).toBe("app_not_selected");
  });

  it("still asks the service axis when the caller already checked permissions", async () => {
    mockActivation.mockResolvedValue("suspended_insufficient_credit");
    const decision = await importAccessForTarget({
      businessId,
      ...target,
      permissions: new Set<string>(),
      permissionAlreadyEnforced: true,
      at: AT,
    });
    expect(decision.reason).toBe("service_suspended");
  });

  it("denies a member who lacks the entity's own key", async () => {
    const decision = await importAccessForTarget({
      businessId,
      ...target,
      permissions: new Set(["data.import"]),
      at: AT,
    });
    expect(decision.reason).toBe("permission");
  });

  it("uses the Workspace decision for workspace targets, not an APP_KEY", async () => {
    const decision = await importAccessForTarget({
      businessId,
      module: "workspace",
      importable: true,
      permissions: PERMITTED,
      at: AT,
    });
    expect(decision.allowed).toBe(true);
    expect(mockWorkspace).toHaveBeenCalled();

    mockWorkspace.mockResolvedValue({
      available: false,
      eligible: false,
      serviceEnabled: true,
      deploymentSupported: true,
      permitted: true,
      reason: "BUSINESS_TYPE_UNSUPPORTED",
      industry: "food_service",
      industryReason: "INDUSTRY_INELIGIBLE",
    });
    const denied = await importAccessForTarget({
      businessId,
      module: "workspace",
      importable: true,
      permissions: PERMITTED,
      at: AT,
    });
    expect(denied.reason).toBe("workspace_unavailable");
  });
});

describe("importAccessForTargets", () => {
  it("reads each shared axis once and each app's activation/grant once", async () => {
    mockSelection.mockResolvedValue(["accounting", "crm"]);
    const decisions = await importAccessForTargets(
      businessId,
      [
        { module: "pos", requiredPermission: "menu.edit", importable: true },
        { module: "pos", requiredPermission: "menu.edit", importable: true },
        { module: "crm", requiredPermission: "crm.edit", importable: true },
      ],
      PERMITTED,
      AT,
    );
    expect(decisions.every((decision) => decision.allowed)).toBe(true);
    expect(mockSelection).toHaveBeenCalledTimes(1);
    expect(mockAvailability).toHaveBeenCalledTimes(1);
    // One activation read for accounting (shared by both pos targets), one for
    // crm; one grant read per distinct app.
    expect(mockActivation).toHaveBeenCalledTimes(2);
    expect(mockGrant).toHaveBeenCalledTimes(2);
    // No Workspace target in this batch, so no Workspace read at all.
    expect(mockWorkspace).not.toHaveBeenCalled();
  });
});
