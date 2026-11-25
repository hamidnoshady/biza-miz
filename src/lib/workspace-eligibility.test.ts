import { describe, expect, it } from "vitest";
import { INDUSTRIES, type Industry } from "@/lib/industries";
import {
  WORKSPACE_ELIGIBLE_INDUSTRIES,
  WORKSPACE_INDUSTRY_DEFAULTS,
  isWorkspaceEligibleIndustry,
  resolveWorkspaceIndustryEligibility,
} from "@/lib/workspace-eligibility";

/**
 * Issue #1110 — the exhaustive business-type matrix.
 *
 * Every industry must have an explicit decision. Adding a key to `INDUSTRIES`
 * without a default is a TypeScript error, and the completeness test below is
 * the runtime half of the same rule.
 */
describe("workspace industry eligibility", () => {
  it("decides every industry in the registry (no missing keys, no extras)", () => {
    expect(Object.keys(WORKSPACE_INDUSTRY_DEFAULTS).sort()).toEqual(
      [...INDUSTRIES].sort(),
    );
  });

  it("is eligible by default only for project-led trades", () => {
    expect([...WORKSPACE_ELIGIBLE_INDUSTRIES].sort()).toEqual(
      ["advertising_agency", "architecture_construction", "service_saas"].sort(),
    );
    for (const industry of WORKSPACE_ELIGIBLE_INDUSTRIES) {
      const result = resolveWorkspaceIndustryEligibility(industry);
      expect(result, industry).toMatchObject({
        eligible: true,
        reason: "INDUSTRY_ELIGIBLE",
        source: "industry",
      });
    }
  });

  it("hides Workspace from every goods/counter trade", () => {
    const hidden: Industry[] = [
      "food_service",
      "jewelry",
      "watch",
      "accessories",
      "cosmetics",
      "wholesale",
      "tools_fittings",
      "haberdashery",
      "automotive",
    ];
    for (const industry of hidden) {
      expect(resolveWorkspaceIndustryEligibility(industry), industry).toMatchObject({
        eligible: false,
        reason: "INDUSTRY_INELIGIBLE",
        source: "industry",
        industry,
      });
    }
  });

  it("fails closed for unknown, empty or null industries", () => {
    for (const value of [null, undefined, "", "not_a_trade", "Food_Service", " retail "]) {
      expect(resolveWorkspaceIndustryEligibility(value as never)).toMatchObject({
        eligible: false,
        reason: "BUSINESS_TYPE_UNSUPPORTED",
        source: "none",
        industry: null,
      });
      expect(isWorkspaceEligibleIndustry(value as never)).toBe(false);
    }
  });

  it("ignores an unapproved override in both directions", () => {
    expect(
      resolveWorkspaceIndustryEligibility("food_service", {
        approved: false,
        eligible: true,
      }).eligible,
    ).toBe(false);
    expect(
      resolveWorkspaceIndustryEligibility("architecture_construction", {
        approved: false,
        eligible: false,
      }).eligible,
    ).toBe(true);
  });

  it("honours an approved override, including removal, as an explicit decision", () => {
    const added = resolveWorkspaceIndustryEligibility("food_service", {
      approved: true,
      eligible: true,
      rationale: "operator runs client fit-out projects",
    });
    expect(added).toMatchObject({
      eligible: true,
      reason: "APPROVED_OVERRIDE_ELIGIBLE",
      source: "approved_override",
      industry: "food_service",
    });

    const removed = resolveWorkspaceIndustryEligibility("service_saas", {
      approved: true,
      eligible: false,
      rationale: "no project delivery",
    });
    expect(removed).toMatchObject({
      eligible: false,
      reason: "APPROVED_OVERRIDE_INELIGIBLE",
      source: "approved_override",
    });
  });
});
