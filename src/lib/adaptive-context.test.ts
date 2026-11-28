import { describe, it, expect } from "vitest";
import {
  BUSINESS_SIZES,
  businessSizeFromMemberCount,
  resolveAdaptiveContext,
  filterToolsForPresentation,
  DEFAULT_USER_PREFERENCES,
  EMPTY_AUTHORIZATION,
  EMPTY_READINESS,
  isKnownIndustry,
  type AdaptiveInputs,
} from "./adaptive-context";
import { PERMISSIONS } from "./permissions";

function base(over: Partial<AdaptiveInputs> = {}): AdaptiveInputs {
  return {
    authorization: {
      ...EMPTY_AUTHORIZATION,
      permissions: new Set([PERMISSIONS.crmView]),
      enabledApps: new Set(["crm", "growth"]),
      enabledModules: new Set(["customers"]),
      capabilities: new Set(),
    },
    industry: "food_service",
    activeMembers: 1,
    readiness: { ...EMPTY_READINESS },
    preferences: { ...DEFAULT_USER_PREFERENCES },
    detectedGoals: [],
    ...over,
  };
}

describe("business size", () => {
  it("maps member counts to canonical profiles", () => {
    expect(businessSizeFromMemberCount(1)).toBe("solo");
    expect(businessSizeFromMemberCount(2)).toBe("small");
    expect(businessSizeFromMemberCount(5)).toBe("small");
    expect(businessSizeFromMemberCount(6)).toBe("growing");
    expect(businessSizeFromMemberCount(25)).toBe("growing");
    expect(businessSizeFromMemberCount(26)).toBe("organization");
    expect(businessSizeFromMemberCount(1000)).toBe("organization");
  });
  it("degrades unknown/0 to solo; never invents permission", () => {
    expect(businessSizeFromMemberCount(null)).toBe("solo");
    expect(businessSizeFromMemberCount(undefined)).toBe("solo");
    expect(businessSizeFromMemberCount(NaN)).toBe("solo");
    expect(businessSizeFromMemberCount(0)).toBe("solo");
  });
  it("exposes exactly the four canonical profiles", () => {
    expect([...BUSINESS_SIZES]).toEqual(["solo", "small", "growing", "organization"]);
  });
});

describe("resolveAdaptiveContext — five separated axes", () => {
  it("size/industry/goals NEVER widen authorization", () => {
    const ctx = resolveAdaptiveContext(base({ activeMembers: 100, industry: "automotive", detectedGoals: ["increase_sales"] }));
    expect(ctx.authorization.permissions.has(PERMISSIONS.crmManage)).toBe(false);
    expect(ctx.authorization.permissions.size).toBe(1); // untouched
    expect(ctx.presentation.advancedAlwaysReachable).toBe(true);
  });

  it("size profile from member count; explicit override wins; never a permission", () => {
    expect(resolveAdaptiveContext(base({ activeMembers: 30 })).profile.size).toBe("organization");
    expect(resolveAdaptiveContext(base({ activeMembers: 30, preferences: { ...DEFAULT_USER_PREFERENCES, sizeOverride: "solo" } })).profile.size).toBe("solo");
    const ctx = resolveAdaptiveContext(base({ activeMembers: 30, preferences: { ...DEFAULT_USER_PREFERENCES, sizeOverride: "solo" } }));
    expect(ctx.authorization.permissions.size).toBe(1);
  });

  it("unknown industry never invents a key", () => {
    expect(isKnownIndustry("clothing")).toBe(false); // #1567 not in registry yet
    const ctx = resolveAdaptiveContext(base({ industry: "clothing" as never }));
    expect(ctx.profile.industry).toBeNull();
    expect(ctx.profile.industryKnown).toBe(false);
  });

  it("goals: explicit override > detected > default; invalid dropped", () => {
    expect(resolveAdaptiveContext(base({ preferences: { ...DEFAULT_USER_PREFERENCES, goalsOverride: ["loyalty"] }, detectedGoals: ["acquisition"] })).profile.goals).toEqual(["loyalty"]);
    expect(resolveAdaptiveContext(base({ detectedGoals: ["acquisition"] })).profile.goalsSource).toBe("detected");
    expect(resolveAdaptiveContext(base({ preferences: { ...DEFAULT_USER_PREFERENCES, goalsOverride: ["bogus" as never] }, detectedGoals: [] })).profile.goals).toEqual([]);
  });

  it("density: explicit override wins; otherwise derived from size; advanced always reachable", () => {
    // no explicit choice → derived (organization defaults advanced, solo defaults simple)
    expect(resolveAdaptiveContext(base({ activeMembers: 100, preferences: { ...DEFAULT_USER_PREFERENCES, density: null } })).presentation.density).toBe("advanced");
    expect(resolveAdaptiveContext(base({ activeMembers: 100, preferences: { ...DEFAULT_USER_PREFERENCES, density: null } })).presentation.densitySource).toBe("derived");
    expect(resolveAdaptiveContext(base({ activeMembers: 1, preferences: { ...DEFAULT_USER_PREFERENCES, density: null } })).presentation.density).toBe("simple");
    const ctx = resolveAdaptiveContext(base({ activeMembers: 100, preferences: { ...DEFAULT_USER_PREFERENCES, density: "simple" } }));
    expect(ctx.presentation.density).toBe("simple"); // explicit override wins
    expect(ctx.presentation.advancedAlwaysReachable).toBe(true);
  });

  it("RTL Persian default", () => {
    const ctx = resolveAdaptiveContext(base());
    expect(ctx.profile.locale).toBe("fa-IR");
    expect(ctx.profile.rtl).toBe(true);
  });
});

describe("My Tools / All Tools", () => {
  const tools = [{ key: "a" }, { key: "b" }, { key: "c" }];
  it("all_tools returns everything authorized", () => {
    const ctx = resolveAdaptiveContext(base({ preferences: { ...DEFAULT_USER_PREFERENCES, toolsView: "all_tools" } }));
    expect(filterToolsForPresentation(tools, ctx, () => true)).toHaveLength(3);
  });
  it("my_tools with no pins shows all authorized (not an empty list)", () => {
    const ctx = resolveAdaptiveContext(base({ preferences: { ...DEFAULT_USER_PREFERENCES, toolsView: "my_tools", pinnedTools: [] } }));
    expect(filterToolsForPresentation(tools, ctx, () => true)).toHaveLength(3);
  });
  it("my_tools restricts to pinned when pins exist", () => {
    const ctx = resolveAdaptiveContext(base({ preferences: { ...DEFAULT_USER_PREFERENCES, toolsView: "my_tools", pinnedTools: ["a"] } }));
    expect(filterToolsForPresentation(tools, ctx, () => true).map((t) => t.key)).toEqual(["a"]);
  });
  it("authorization filter always applies", () => {
    const ctx = resolveAdaptiveContext(base({ preferences: { ...DEFAULT_USER_PREFERENCES, toolsView: "all_tools", pinnedTools: ["a"] } }));
    expect(filterToolsForPresentation(tools, ctx, (t) => t.key !== "a")).toEqual([{ key: "b" }, { key: "c" }]);
  });
});
