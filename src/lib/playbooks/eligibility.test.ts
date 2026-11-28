import { describe, it, expect } from "vitest";
import { evaluateEligibility, rankPlaybooks, featuredPlaybooks } from "./eligibility";
import { PLAYBOOK_CATALOG, playbookByKey } from "./catalog";
import {
  resolveAdaptiveContext,
  DEFAULT_USER_PREFERENCES,
  EMPTY_AUTHORIZATION,
  EMPTY_READINESS,
  type AdaptiveInputs,
} from "../adaptive-context";
import { PERMISSIONS } from "../permissions";

function ctx(over: Partial<AdaptiveInputs> = {}) {
  return resolveAdaptiveContext({
    authorization: {
      ...EMPTY_AUTHORIZATION,
      permissions: new Set([PERMISSIONS.crmView, PERMISSIONS.partiesView, PERMISSIONS.partiesManage, PERMISSIONS.growthView, PERMISSIONS.campaignsView, PERMISSIONS.campaignsManage, PERMISSIONS.crmManage]),
      enabledApps: new Set(["crm", "growth", "website"]),
      enabledModules: new Set(["customers", "promotions", "website"]),
      capabilities: new Set(["messaging"]),
      locationScope: "all",
    },
    industry: "food_service",
    activeMembers: 1,
    readiness: { ...EMPTY_READINESS, hasCustomers: true, hasTransactions: true, hasDeals: true, hasConsentData: true, messagingConfigured: true, smsReady: true, hasBirthdays: true, hasCampaignExecutor: true },
    preferences: { ...DEFAULT_USER_PREFERENCES },
    detectedGoals: [],
    ...over,
  });
}

describe("evaluateEligibility", () => {
  const lead = playbookByKey("crm.follow_up_new_lead")!;

  it("authorized CRM template is visible + launchable", () => {
    const e = evaluateEligibility(lead, ctx());
    expect(e.visible).toBe(true);
    expect(e.launchable).toBe(true);
    expect(e.state).toBe("available");
  });

  it("missing permission blocks launch but authorization is independent of size", () => {
    const noPerm = ctx({ authorization: { ...EMPTY_AUTHORIZATION, permissions: new Set(), enabledApps: new Set(["crm"]), enabledModules: new Set(["customers"]), capabilities: new Set(), locationScope: "all" }, activeMembers: 1000 });
    const e = evaluateEligibility(lead, noPerm);
    expect(e.launchable).toBe(false);
    expect(e.reasons.some((r) => r.code === "missing_permission" || r.code === "missing_launch_permission")).toBe(true);
  });

  it("disabled app hides the template (never a dead-end launcher)", () => {
    const c = ctx({ authorization: { ...EMPTY_AUTHORIZATION, permissions: new Set([PERMISSIONS.crmView, PERMISSIONS.partiesView, PERMISSIONS.partiesManage]), enabledApps: new Set(), enabledModules: new Set(["customers"]), capabilities: new Set(), locationScope: "all" } });
    expect(evaluateEligibility(lead, c).visible).toBe(false);
  });

  it("industry-unsupported template is not visible", () => {
    const t = playbookByKey("crm.repeat_cafe_visit")!;
    expect(evaluateEligibility(t, ctx({ industry: "automotive" })).visible).toBe(false);
  });

  it("unknown industry never invents a match for industry-specific templates", () => {
    const t = playbookByKey("crm.repeat_cafe_visit")!;
    expect(evaluateEligibility(t, ctx({ industry: null })).visible).toBe(false);
  });

  it("missing required data → requires_setup (not fake available, not hidden)", () => {
    const t = playbookByKey("crm.follow_up_stalled_deals")!;
    const c = ctx({ readiness: { ...EMPTY_READINESS, hasCustomers: true, hasDeals: false } });
    const e = evaluateEligibility(t, c);
    expect(e.visible).toBe(true);
    expect(e.launchable).toBe(false);
    expect(e.state).toBe("requires_setup");
    expect(e.reasons.some((r) => r.code === "data_missing")).toBe(true);
  });

  it("Growth message template is launchable when messaging configured + authorized; blocked when not", () => {
    const g = playbookByKey("growth.winback_inactive")!;
    expect(evaluateEligibility(g, ctx()).launchable).toBe(true);
    const noMsg = ctx({ readiness: { ...EMPTY_READINESS, hasCustomers: true, messagingConfigured: false }, authorization: { ...EMPTY_AUTHORIZATION, permissions: new Set([PERMISSIONS.growthView, PERMISSIONS.campaignsView, PERMISSIONS.campaignsManage, PERMISSIONS.partiesView]), enabledApps: new Set(["growth"]), enabledModules: new Set(["customers", "promotions"]), capabilities: new Set(["messaging"]), locationScope: "all" } });
    expect(evaluateEligibility(g, noMsg).launchable).toBe(false);
  });

  it("requires_setup data never yields a fake Run", () => {
    const t = playbookByKey("crm.renewal_reminder")!;
    const c = ctx({ readiness: { ...EMPTY_READINESS, hasCustomers: true, hasRenewalDates: false } });
    expect(evaluateEligibility(t, c).launchable).toBe(false);
  });
});

describe("deterministic ranking", () => {
  it("no AI; stable order; industry/goal/size/favorite scoring; invisible excluded", () => {
    const c = ctx({ industry: "food_service", detectedGoals: ["repeat_purchase"] });
    const ranked = rankPlaybooks(PLAYBOOK_CATALOG, c);
    expect(ranked.every((r) => r.eligibility.visible)).toBe(true);
    // deterministic
    expect(rankPlaybooks(PLAYBOOK_CATALOG, c).map((r) => r.template.key)).toEqual(ranked.map((r) => r.template.key));
    // industry-specific food template surfaces for food_service
    expect(ranked.some((r) => r.template.key === "crm.repeat_cafe_visit")).toBe(true);
    // a non-food industry template is excluded for food_service
    expect(ranked.some((r) => r.template.key === "crm.repeat_cafe_visit" && r.eligibility.visible)).toBe(true);
    expect(ranked.find((r) => r.template.key === "crm.automotive_test_drive_followup")).toBeUndefined();
  });

  it("favorites boost", () => {
    const c = ctx({ preferences: { ...DEFAULT_USER_PREFERENCES, favoritePlaybooks: ["crm.vip_customers"] } });
    const ranked = rankPlaybooks(PLAYBOOK_CATALOG, c);
    const vip = ranked.find((r) => r.template.key === "crm.vip_customers")!;
    expect(vip.reasonsFa.some((x) => x.includes("نشان"))).toBe(true);
  });

  it("featured limits to app + N", () => {
    const c = ctx();
    const f = featuredPlaybooks(PLAYBOOK_CATALOG, c, "crm", 4);
    expect(f.length).toBeLessThanOrEqual(4);
    expect(f.every((r) => r.template.owningApp === "crm")).toBe(true);
  });

  it("restricted member cannot see launchable dead-ends", () => {
    const restricted = ctx({ authorization: { ...EMPTY_AUTHORIZATION, permissions: new Set([PERMISSIONS.crmView]), enabledApps: new Set(["crm"]), enabledModules: new Set(["customers"]), capabilities: new Set(), locationScope: "none" } });
    const ranked = rankPlaybooks(PLAYBOOK_CATALOG, restricted);
    expect(ranked.every((r) => !r.eligibility.launchable)).toBe(true);
  });
});
