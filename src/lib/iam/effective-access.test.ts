import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../permissions";
import { isAuthorityIncrease, resolveEffectiveAccess } from "./effective-access";

const policy = (overrides: Partial<Parameters<typeof resolveEffectiveAccess>[0]["sitePolicy"]> = {}) => ({
  allowedLocationIds: null, permissionDenies: [], isLocallySuspended: false, localLoginLocked: false, revision: 1, ...overrides,
});

describe("Hybrid IAM effective access", () => {
  it("can remove a Cloud-granted permission while offline", () => {
    const access = resolveEffectiveAccess({ profile: "hybrid", role: "manager", canonicalLocationIds: ["a"],
      sitePolicy: policy({ permissionDenies: [PERMISSIONS.paymentsRefund] }) });
    expect(access.permissions.has(PERMISSIONS.paymentsRefund)).toBe(false);
  });

  it("preserves cashier checkout authority locally, then enforces a synchronized deny", () => {
    const synced = resolveEffectiveAccess({ profile: "hybrid", role: "cashier", canonicalLocationIds: ["a"],
      sitePolicy: policy() });
    expect(synced.permissions.has(PERMISSIONS.ordersCreate)).toBe(true);
    expect(synced.permissions.has(PERMISSIONS.paymentsTake)).toBe(true);
    expect(synced.permissions.has(PERMISSIONS.ledgerView)).toBe(false);

    const revoked = resolveEffectiveAccess({ profile: "hybrid", role: "cashier",
      overrides: { revoked: [PERMISSIONS.paymentsTake] }, canonicalLocationIds: ["a"], sitePolicy: policy() });
    expect(revoked.permissions.has(PERMISSIONS.paymentsTake)).toBe(false);
    expect(revoked.permissions.has(PERMISSIONS.ordersView)).toBe(true);
  });

  it("gives a local-only cashier the same canonical preset without cloud authority", () => {
    const access = resolveEffectiveAccess({ profile: "local", role: "cashier", canonicalLocationIds: ["a"] });
    expect(access.permissions.has(PERMISSIONS.ordersCreate)).toBe(true);
    expect(access.permissions.has(PERMISSIONS.paymentsTake)).toBe(true);
    expect(access.permissions.has(PERMISSIONS.settingsManage)).toBe(false);
    expect(access.permissions.has(PERMISSIONS.ledgerView)).toBe(false);
  });

  it("cannot turn a Cloud denial into a grant", () => {
    const access = resolveEffectiveAccess({ profile: "hybrid", role: "cashier", canonicalLocationIds: ["a"],
      sitePolicy: policy() });
    expect(access.permissions.has(PERMISSIONS.teamPermissionsManage)).toBe(false);
  });

  it("intersects rather than replaces canonical branch access", () => {
    const access = resolveEffectiveAccess({ profile: "hybrid", role: "manager", canonicalLocationIds: ["a", "b"],
      sitePolicy: policy({ allowedLocationIds: ["b", "foreign"] }) });
    expect([...access.locationIds]).toEqual(["b"]);
  });

  it("local deployment keeps full locally-authoritative RBAC", () => {
    const access = resolveEffectiveAccess({ profile: "local", role: "manager", overrides: { granted: [PERMISSIONS.ledgerPost] },
      canonicalLocationIds: ["a"], sitePolicy: policy({ permissionDenies: [PERMISSIONS.ledgerPost] }) });
    expect(access.permissions.has(PERMISSIONS.ledgerPost)).toBe(true);
  });

  it("detects permission or branch widening", () => {
    expect(isAuthorityIncrease(new Set([PERMISSIONS.ordersView]), new Set([PERMISSIONS.ordersView, PERMISSIONS.ordersVoid]), new Set(["a"]), new Set(["a"]))).toBe(true);
    expect(isAuthorityIncrease(new Set([PERMISSIONS.ordersView]), new Set(), new Set(["a"]), new Set())).toBe(false);
  });
});
