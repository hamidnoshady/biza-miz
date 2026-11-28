import { describe, it, expect } from "vitest";
import { buildPreflight } from "./preflight";
import { playbookByKey } from "./catalog";
import {
  resolveAdaptiveContext,
  DEFAULT_USER_PREFERENCES,
  EMPTY_AUTHORIZATION,
  EMPTY_READINESS,
  type AdaptiveInputs,
} from "../adaptive-context";
import { PERMISSIONS } from "../permissions";

const lead = playbookByKey("crm.follow_up_new_lead")!;
const winback = playbookByKey("growth.winback_inactive")!;

function ctx(over: Partial<AdaptiveInputs> = {}) {
  return resolveAdaptiveContext({
    authorization: {
      ...EMPTY_AUTHORIZATION,
      permissions: new Set([PERMISSIONS.crmView, PERMISSIONS.partiesView, PERMISSIONS.partiesManage, PERMISSIONS.growthView, PERMISSIONS.campaignsView, PERMISSIONS.campaignsManage]),
      enabledApps: new Set(["crm", "growth"]),
      enabledModules: new Set(["customers", "promotions"]),
      capabilities: new Set(["messaging"]),
      locationScope: "all",
    },
    industry: "food_service",
    activeMembers: 1,
    readiness: { ...EMPTY_READINESS, hasCustomers: true, messagingConfigured: true, smsReady: true },
    preferences: { ...DEFAULT_USER_PREFERENCES },
    detectedGoals: [],
    ...over,
  });
}

describe("buildPreflight", () => {
  it("CRM template: no cost, no audience gating, approval flag honored", () => {
    const p = buildPreflight(lead, ctx(), { slaHours: 12 });
    expect(p.blocked).toBe(false);
    expect(p.cost.estimatedRial).toBeNull(); // unknown ≠ zero
    expect(p.canPause).toBe(true);
    expect(p.canCancel).toBe(true);
    expect(p.kpiSummaryFa.length).toBeGreaterThan(0);
  });

  it("unknown estimates render نامشخص, not zero", () => {
    const p = buildPreflight(lead, ctx(), {});
    expect(p.cost.estimatedRial).toBeNull();
    const costCheck = p.checks.find((c) => c.key === "cost")!;
    expect(costCheck.state).toBe("unknown");
  });

  it("Growth outbound: consent-qualified reachable separate from total; blocked when 0 reachable", () => {
    const ok = buildPreflight(winback, ctx(), { channel: "sms", inactiveDays: 60, messageBody: "hi {name}", durationDays: 14 }, { audience: { totalMatched: 100, reachable: 40, excluded: 60 } });
    expect(ok.audience.totalMatched).toBe(100);
    expect(ok.audience.reachable).toBe(40);
    expect(ok.blocked).toBe(false);
    const none = buildPreflight(winback, ctx(), { channel: "sms", inactiveDays: 60, messageBody: "x", durationDays: 14 }, { audience: { totalMatched: 100, reachable: 0, excluded: 100 } });
    expect(none.blocked).toBe(true);
  });

  it("Growth blocked when messaging not configured", () => {
    const p = buildPreflight(winback, ctx({ readiness: { ...EMPTY_READINESS, hasCustomers: true, messagingConfigured: false } }), { channel: "sms", inactiveDays: 60, messageBody: "x", durationDays: 14 });
    expect(p.blocked).toBe(true);
  });

  it("missing launch permission blocks", () => {
    const p = buildPreflight(lead, ctx({ authorization: { ...EMPTY_AUTHORIZATION, permissions: new Set([PERMISSIONS.crmView]), enabledApps: new Set(["crm"]), enabledModules: new Set(["customers"]), capabilities: new Set(), locationScope: "all" } }), {});
    expect(p.blocked).toBe(true);
  });

  it("requiresApproval surfaced; nothing committed in preflight", () => {
    const p = buildPreflight(winback, ctx(), { channel: "sms", inactiveDays: 60, messageBody: "x", durationDays: 14 });
    expect(p.requiresApproval).toBe(true);
    expect(p.cost.actualRial).toBeNull();
  });

  it("integer-Rial cost passthrough; liability shown", () => {
    const p = buildPreflight(lead, ctx(), {}, { cost: { estimatedRial: 12000, liabilityRial: 5000, actualRial: null, currencyDisplay: "toman" } });
    expect(p.cost.estimatedRial).toBe(12000);
    expect(p.cost.liabilityRial).toBe(5000);
    expect(p.cost.currencyDisplay).toBe("toman");
  });
});
