import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveWorkspaceAccessDecision } from "@/lib/workspace-access";

const VIEW = [PERMISSIONS.workspaceView] as const;

function decide(overrides: Partial<Parameters<typeof resolveWorkspaceAccessDecision>[0]> = {}) {
  return resolveWorkspaceAccessDecision({
    industry: "architecture_construction",
    deploymentProfile: "cloud",
    serviceEnabled: true,
    permissions: VIEW,
    ...overrides,
  });
}

/**
 * Issue #1110 — industry, service activation, deployment and permission are
 * intersected, never substituted. Every axis alone must be able to deny.
 */
describe("workspace access decision", () => {
  it("is available for an eligible, active, deployed, authorized business", () => {
    expect(decide()).toMatchObject({
      available: true,
      eligible: true,
      serviceEnabled: true,
      deploymentSupported: true,
      permitted: true,
      reason: null,
    });
  });

  it("denies a retail business even when the member holds workspace.view", () => {
    expect(
      decide({ industry: "food_service" }),
    ).toMatchObject({
      available: false,
      eligible: false,
      reason: "BUSINESS_TYPE_UNSUPPORTED",
    });
    expect(decide({ industry: "jewelry" }).available).toBe(false);
    expect(decide({ industry: "automotive" }).available).toBe(false);
  });

  it("denies an unknown industry (fail closed)", () => {
    for (const industry of [null, undefined, "unknown_trade"]) {
      expect(decide({ industry: industry as never })).toMatchObject({
        available: false,
        reason: "BUSINESS_TYPE_UNSUPPORTED",
      });
    }
  });

  it("hides an eligible business whose Workspace service is inactive", () => {
    expect(decide({ serviceEnabled: false })).toMatchObject({
      available: false,
      eligible: true,
      serviceEnabled: false,
      reason: "WORKSPACE_SERVICE_DISABLED",
    });
  });

  it("hides an eligible business on a deployment that cannot run it", () => {
    expect(decide({ deploymentProfile: "local" })).toMatchObject({
      available: false,
      eligible: true,
      deploymentSupported: false,
      reason: "DEPLOYMENT_UNSUPPORTED",
    });
  });

  it("hides an eligible business from a member without workspace.view", () => {
    expect(decide({ permissions: [] })).toMatchObject({
      available: false,
      eligible: true,
      permitted: false,
      reason: "INSUFFICIENT_PERMISSION",
    });
    expect(
      decide({ permissions: [PERMISSIONS.ledgerView] }).available,
    ).toBe(false);
  });

  it("reports the most fundamental blocking reason first", () => {
    expect(
      decide({
        industry: "food_service",
        serviceEnabled: false,
        deploymentProfile: "local",
        permissions: [],
      }).reason,
    ).toBe("BUSINESS_TYPE_UNSUPPORTED");
    expect(
      decide({ serviceEnabled: false, deploymentProfile: "local", permissions: [] })
        .reason,
    ).toBe("WORKSPACE_SERVICE_DISABLED");
    expect(decide({ deploymentProfile: "local", permissions: [] }).reason).toBe(
      "DEPLOYMENT_UNSUPPORTED",
    );
  });

  it("accepts a Set as well as a readonly array of permissions", () => {
    expect(decide({ permissions: new Set(VIEW) }).permitted).toBe(true);
  });
});
