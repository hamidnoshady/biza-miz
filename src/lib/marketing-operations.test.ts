import { describe, expect, it } from "vitest";
import { parseTargetInput, parseTargetChange, parseAssignmentInput, parsePriorityChange, parseTransition, parseAssignmentPlanFilter, assignmentPlanQuery } from "./marketing-operations";
import { PERMISSIONS, effectivePermissions, type Permission } from "./permissions";
import { canOpenGrowth, growthApiPermission } from "./growth-access";
const id = "123e4567-e89b-42d3-a456-426614174000";
describe("marketing operations contracts", () => {
  it("validates targets and optional canonical party references", () => {
    expect(parseTargetInput({ locationId: id, siteLabel: "  Site ", partyId: id })).toEqual({ locationId: id, siteLabel: "Site", partyId: id, city: "", neighborhood: "" });
    expect(parseTargetInput({ locationId: id, siteLabel: "Site", reviewToken: "a".repeat(64) })?.reviewToken).toBe("a".repeat(64));
    for (const token of [null, "x", "A".repeat(64), 5, "a".repeat(65)]) expect(parseTargetInput({ locationId: id, siteLabel: "Site", reviewToken: token })).toBeNull();
    for (const body of [{ locationId: "invalid", siteLabel: "x" }, { locationId: id, siteLabel: " " }, { locationId: id, siteLabel: "x", partyId: "bad" }, { locationId: id, siteLabel: "x", city: "x".repeat(101) }]) expect(parseTargetInput(body)).toBeNull();
  });
  it("validates target revisions and lifecycle changes", () => {
    expect(parseTargetChange({ action: "edit", expectedRevision: 0, siteLabel: " Site ", city: " City ", neighborhood: "" })).toEqual({ action: "edit", expectedRevision: 0, siteLabel: "Site", city: "City", neighborhood: "" });
    expect(parseTargetChange({ action: "restore", expectedRevision: 3 })).toEqual({ action: "restore", expectedRevision: 3 });
    for (const input of [{ action: "archive", expectedRevision: -1 }, { action: "archive", expectedRevision: 1.5 }, { action: "archive", expectedRevision: 2147483647 }, { action: "edit", expectedRevision: 0, siteLabel: " " }, { action: "edit", expectedRevision: 0, siteLabel: "x", city: "x".repeat(101) }, { action: "delete", expectedRevision: 0 }]) expect(parseTargetChange(input)).toBeNull();
  });
  it("validates IDs, dates and the assignment lifecycle", () => {
    expect(parseAssignmentInput({ locationId: id, targetId: id, agentId: id, title: "Call", dueDate: "2028-02-29" })?.dueDate).toBe("2028-02-29");
    const base = { locationId: id, targetId: id, agentId: id, title: "Call" };
    expect(parseAssignmentInput(base)?.priority).toBe("normal");
    for (const priority of ["low", "normal", "high", "urgent"]) expect(parseAssignmentInput({ ...base, priority })?.priority).toBe(priority);
    for (const priority of [null, "", "HIGH", "critical", 1, {}]) expect(parseAssignmentInput({ ...base, priority })).toBeNull();
    expect(parseAssignmentInput({ locationId: id, targetId: id, agentId: id, title: "Call", dueDate: "2027-02-29" })).toBeNull();
    expect(parseAssignmentInput({ locationId: id, targetId: id, agentId: "no", title: "Call" })).toBeNull();
    expect(parseTransition({ expected: "planned", next: "in_progress" })).toEqual({ expected: "planned", next: "in_progress" });
    expect(parseTransition({ expected: "completed", next: "planned" })).toBeNull();
    expect(parseTransition({ expected: "planned", next: "planned" })).toBeNull();
  });
  it("validates inclusive deadline filters and whitelisted sorting", () => {
    expect(parseAssignmentPlanFilter(new URLSearchParams())).toEqual({ status: null, dueFrom: null, dueTo: null, sort: "newest" });
    const filter = { status: "planned" as const, dueFrom: "2028-02-29", dueTo: "2028-03-01", sort: "due_asc" as const };
    expect(parseAssignmentPlanFilter(new URLSearchParams("status=planned&dueFrom=2028-02-29&dueTo=2028-03-01&sort=due_asc"))).toEqual(filter);
    expect(assignmentPlanQuery(filter)).toBe("&status=planned&dueFrom=2028-02-29&dueTo=2028-03-01&sort=due_asc");
    for (const query of ["status=unknown", "status=", "sort=invalid", "sort=due_asc&sort=newest", "dueFrom=2027-02-29", "dueTo=1899-12-31", "dueTo=", "dueFrom=2028-03-02&dueTo=2028-03-01", "dueFrom=2028-02-29&dueFrom=2028-03-01"]) expect(parseAssignmentPlanFilter(new URLSearchParams(query))).toBeNull();
  });
  it("validates priority revisions and rejects invalid changes", () => {
    expect(parsePriorityChange({ action: "priority", expectedRevision: 2, priority: "high", businessId: "ignored" })).toEqual({ action: "priority", expectedRevision: 2, priority: "high" });
    for (const body of [null, {}, { action: "priority", expectedRevision: -1, priority: "high" }, { action: "priority", expectedRevision: 1.5, priority: "high" }, { action: "priority", expectedRevision: 2147483647, priority: "high" }, { action: "priority", expectedRevision: 0, priority: "critical" }, { action: "other", expectedRevision: 0, priority: "high" }]) expect(parsePriorityChange(body)).toBeNull();
  });
  it("separates work permissions from directory and financial permissions", () => {
    expect(canOpenGrowth(new Set([PERMISSIONS.marketingAssignmentsView]))).toBe(true);
    expect(growthApiPermission("/api/growth/marketing-targets", "POST")).toEqual([PERMISSIONS.marketingTargetsView, PERMISSIONS.marketingTargetsManage, PERMISSIONS.partiesView]);
    expect(effectivePermissions("cashier", {}).has(PERMISSIONS.marketingAssignmentsView)).toBe(false);
    expect(effectivePermissions("manager", {}).has(PERMISSIONS.marketingAssignmentsManage)).toBe(true);
    expect(effectivePermissions("cashier", {}).has(PERMISSIONS.marketingAssignmentsSelf)).toBe(false);
    const selfOnly = new Set<Permission>([PERMISSIONS.marketingAssignmentsSelf]);
    expect(canOpenGrowth(selfOnly)).toBe(true);
    expect(growthApiPermission("/api/growth/my-marketing-assignments", "GET")).toEqual([PERMISSIONS.marketingAssignmentsSelf]);
    expect(selfOnly.has(PERMISSIONS.marketingAssignmentsView)).toBe(false);
    expect(selfOnly.has(PERMISSIONS.crmView)).toBe(false);
  });
});
