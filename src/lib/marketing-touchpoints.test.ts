import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRM_SOURCES } from "./crm-sources";
import { canRevealMarketingLead, parseTouchInput } from "./marketing-touchpoints";
import { PERMISSIONS, effectivePermissions } from "./permissions";
import { canOpenGrowth, growthApiPermission } from "./growth-access";
const id = "123e4567-e89b-42d3-a456-426614174000";
const valid = { assignmentId: id, leadId: id, idempotencyKey: id, source: "phone", channel: "phone" };
describe("marketing touchpoint contracts", () => {
  it("validates IDs and a closed channel/source vocabulary", () => {
    expect(parseTouchInput(valid)).toEqual(valid);
    for (const patch of [{ assignmentId: "bad" }, { leadId: "" }, { idempotencyKey: null }, { channel: "gps-proof" }, { source: "unapproved-source" }]) expect(parseTouchInput({ ...valid, ...patch })).toBeNull();
  });
  it("keeps the database source constraint aligned with CRM's vocabulary", () => {
    const migration = readFileSync(join(process.cwd(), "migrations/0286_marketing_lead_touches.sql"), "utf8");
    const values = migration.match(/source IN \(([^)]+)\)/)?.[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1));
    expect(values).toEqual([...CRM_SOURCES]);
  });
  it("separates lead details and recording from attribution view", () => {
    expect(canOpenGrowth(new Set([PERMISSIONS.marketingAttributionView]))).toBe(true);
    expect(canRevealMarketingLead(new Set([PERMISSIONS.marketingAttributionView]))).toBe(false);
    expect(canRevealMarketingLead(new Set([PERMISSIONS.crmView]))).toBe(false);
    expect(canRevealMarketingLead(new Set([PERMISSIONS.crmView, PERMISSIONS.crmManage]))).toBe(true);
    expect(growthApiPermission("/api/growth/marketing-touchpoints", "POST")).toEqual([PERMISSIONS.marketingAttributionManage, PERMISSIONS.crmView, PERMISSIONS.crmManage, PERMISSIONS.marketingAssignmentsView]);
    expect(effectivePermissions("cashier", {}).has(PERMISSIONS.marketingAttributionView)).toBe(false);
  });
});
