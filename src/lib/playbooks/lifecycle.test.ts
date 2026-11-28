import { describe, it, expect } from "vitest";
import { canTransition, INSTANCE_STATES, INSTANCE_TRANSITIONS, validatePlaybook, PLAYBOOK_SCHEMA_VERSION, type InstanceState } from "./types";

describe("instance lifecycle", () => {
  it("canonical states", () => {
    expect([...INSTANCE_STATES]).toEqual(["draft", "pending_approval", "scheduled", "running", "paused", "completed", "failed", "canceled"]);
  });
  it("valid transitions; terminal completed/canceled immutable; no self-loops", () => {
    expect(canTransition("draft", "pending_approval")).toBe(true);
    expect(canTransition("pending_approval", "scheduled")).toBe(true);
    expect(canTransition("scheduled", "running")).toBe(true);
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("failed", "running")).toBe(true); // retry idempotent
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("canceled", "draft")).toBe(false);
    expect(canTransition("running", "running")).toBe(false);
  });
  it("every transition target is a known state", () => {
    const known = new Set<InstanceState>(INSTANCE_STATES);
    for (const [from, tos] of Object.entries(INSTANCE_TRANSITIONS)) {
      expect(known.has(from as InstanceState)).toBe(true);
      for (const to of tos) expect(known.has(to)).toBe(true);
    }
  });
});

describe("validatePlaybook", () => {
  it("rejects unsafe fields (no arbitrary SQL/JS)", () => {
    const base = {
      key: "crm.x", version: "1.0.0", schemaVersion: PLAYBOOK_SCHEMA_VERSION, owningApp: "crm", publicationState: "published", availability: "available",
      localized: { titleFa: "x", summaryFa: "x", outcomeFa: "x" }, businessGoals: ["follow_up"], category: "follow_up", tags: [], supportedIndustries: ["all"], sizeDefaults: ["solo"],
      requiredCapabilities: { modules: [], apps: [], capabilities: [] }, requiredPermissions: [], launchPermission: "crm.view", resultsPermission: null, requiredData: [], quickInputSchema: { fields: [] }, stepsFa: ["a", "b"], setupMinutes: 1, costClass: "free", channels: [], trigger: "x",
      executionBinding: { executor: "crm", action: "crm.create_tasks", canonicalService: "x", requiresApproval: false, requiresOnline: false }, measurement: [{ key: "k", labelFa: "k", source: "crm_activity", definitionFa: "x" }],
    } as const;
    expect(validatePlaybook(base as never)).toEqual([]);
    const evil = { ...base, sql: "DROP TABLE parties" } as never;
    expect(validatePlaybook(evil).length).toBeGreaterThan(0);
  });
  it("CRM executor cannot send marketing or move money", () => {
    const base = {
      key: "crm.x", version: "1.0.0", schemaVersion: PLAYBOOK_SCHEMA_VERSION, owningApp: "crm", publicationState: "published", availability: "available",
      localized: { titleFa: "x", summaryFa: "x", outcomeFa: "x" }, businessGoals: ["follow_up"], category: "follow_up", tags: [], supportedIndustries: ["all"], sizeDefaults: ["solo"],
      requiredCapabilities: { modules: [], apps: [], capabilities: [] }, requiredPermissions: [], launchPermission: "crm.view", resultsPermission: null, requiredData: [], quickInputSchema: { fields: [] }, stepsFa: ["a", "b"], setupMinutes: 1, costClass: "free", channels: [], trigger: "x",
      executionBinding: { executor: "crm", action: "growth.message_campaign_launch", canonicalService: "x", requiresApproval: false, requiresOnline: false }, measurement: [{ key: "k", labelFa: "k", source: "crm_activity", definitionFa: "x" }],
    } as never;
    expect(validatePlaybook(base).length).toBeGreaterThan(0);
  });
});
