import { describe, expect, it } from "vitest";
import { parseRosterInput } from "./marketing-roster";
import { effectivePermissions, PERMISSIONS } from "./permissions";
import { canOpenGrowth, canViewGrowthSection, growthApiPermission } from "./growth-access";

const branch = "123e4567-e89b-42d3-a456-426614174000";
const user = "123e4567-e89b-42d3-a456-426614174001";
describe("marketing roster foundation", () => {
  it("requires a tenant branch and a user only for employees", () => {
    expect(parseRosterInput({ locationId: branch, kind: "employee", userId: user })).toEqual({ locationId: branch, kind: "employee", userId: user, name: null });
    expect(parseRosterInput({ locationId: branch, kind: "affiliate", name: "  Partner  " })).toEqual({ locationId: branch, kind: "affiliate", name: "Partner", userId: null });
    for (const input of [
      { locationId: "bad", kind: "employee", userId: user },
      { locationId: branch, kind: "employee", name: "someone" },
      { locationId: branch, kind: "affiliate", name: "x", userId: user },
      { locationId: branch, kind: "affiliate", name: " " },
      { locationId: branch, kind: "other", name: "x" },
    ]) expect(parseRosterInput(input)).toBeNull();
  });
  it("opens Growth on roster view alone but does not grant CRM, accounting or roster writes", () => {
    const permissions = new Set<string>([PERMISSIONS.marketersView]);
    expect(canOpenGrowth(permissions)).toBe(true);
    expect(canViewGrowthSection(permissions, "marketers")).toBe(true);
    expect(growthApiPermission("/api/growth/marketers", "POST")).toEqual([PERMISSIONS.marketersManage]);
    expect(permissions.has(PERMISSIONS.crmView)).toBe(false);
    expect(permissions.has(PERMISSIONS.commissionView)).toBe(false);
    expect(effectivePermissions("cashier", {}).has(PERMISSIONS.marketersView)).toBe(false);
  });
});
