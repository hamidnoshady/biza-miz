import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  effectivePermissions,
  hasPermission,
  isAbsoluteRole,
  isOwnerOnlyPermission,
  parseOverrides,
  roleBasePermissions,
  canUsePos,
} from "./permissions";

describe("role presets", () => {
  it("gives the owner every permission, including ones added later", () => {
    // The owner's set is a rule, not a list — so it must equal the full
    // catalogue rather than a snapshot someone has to remember to update.
    expect(roleBasePermissions("owner").sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(isAbsoluteRole("owner")).toBe(true);
  });

  it("keeps the accountant off the floor and the floor out of the books", () => {
    const accountant = new Set(roleBasePermissions("accountant"));
    expect(accountant.has(PERMISSIONS.ledgerPost)).toBe(true);
    expect(accountant.has(PERMISSIONS.ledgerClosePeriod)).toBe(true);
    expect(accountant.has(PERMISSIONS.paymentsTake)).toBe(false);
    expect(accountant.has(PERMISSIONS.ordersCreate)).toBe(false);

    const cashier = new Set(roleBasePermissions("cashier"));
    expect(cashier.has(PERMISSIONS.paymentsTake)).toBe(true);
    expect(cashier.has(PERMISSIONS.ledgerPost)).toBe(false);
    expect(cashier.has(PERMISSIONS.accountsEdit)).toBe(false);
  });

  it("pins the cashier till preset without granting bookkeeping or settings authority", () => {
    const cashier = new Set(roleBasePermissions("cashier"));
    for (const permission of [PERMISSIONS.ordersView, PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake]) {
      expect(cashier.has(permission), permission).toBe(true);
    }
    expect(cashier.has(PERMISSIONS.ledgerView)).toBe(false);
    expect(cashier.has(PERMISSIONS.settingsManage)).toBe(false);
    expect(canUsePos(cashier)).toBe(true);
  });

  it("requires both order creation and payment authority for the full POS surface", () => {
    expect(canUsePos(new Set([PERMISSIONS.ordersCreate]))).toBe(false);
    expect(canUsePos(new Set([PERMISSIONS.paymentsTake]))).toBe(false);
    expect(canUsePos(new Set([PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake]))).toBe(true);
    expect(canUsePos(effectivePermissions("cashier", { revoked: [PERMISSIONS.paymentsTake] }))).toBe(false);
    expect(canUsePos(effectivePermissions("cashier", { revoked: [PERMISSIONS.ordersCreate] }))).toBe(false);
  });

  it("lets managers, cashiers and accountants manage the persons file, each from their own app", () => {
    // The record is one thing (`parties`) but every app manages it from its own
    // screen: the floor from the CRM directory, the accountant from Accounting's
    // «اشخاص» view. Keeping the accountant view-only here while the ledger's own
    // tabs offer «افزودن شخص» would be a button that only ever answers 403.
    expect(new Set(roleBasePermissions("manager")).has(PERMISSIONS.partiesManage)).toBe(true);
    expect(new Set(roleBasePermissions("cashier")).has(PERMISSIONS.partiesManage)).toBe(true);
    const accountant = new Set(roleBasePermissions("accountant"));
    expect(accountant.has(PERMISSIONS.partiesView)).toBe(true);
    expect(accountant.has(PERMISSIONS.partiesManage)).toBe(true);
  });

  it("restricts kitchen and waiter to their own surfaces", () => {
    expect(hasPermission("kitchen", null, PERMISSIONS.kitchenView)).toBe(true);
    expect(hasPermission("kitchen", null, PERMISSIONS.paymentsTake)).toBe(false);
    expect(hasPermission("waiter", null, PERMISSIONS.ordersCreate)).toBe(true);
    expect(hasPermission("waiter", null, PERMISSIONS.ordersVoid)).toBe(false);
    expect(hasPermission("waiter", null, PERMISSIONS.reportsView)).toBe(false);
    expect(hasPermission("waiter", null, PERMISSIONS.partiesManage)).toBe(false);
  });

  it("does not let any non-owner role manage the team by default", () => {
    for (const role of ["manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      expect(hasPermission(role, null, PERMISSIONS.teamManage)).toBe(false);
    }
  });
});

describe("per-member overrides", () => {
  it("adds read prerequisites and lets prerequisite revocation disable mutation", () => {
    expect(hasPermission("cashier", null, PERMISSIONS.crmView)).toBe(true);
    const permissions = effectivePermissions("manager", { revoked: [PERMISSIONS.inventoryView] });
    expect(permissions.has(PERMISSIONS.inventoryView)).toBe(false);
    expect(permissions.has(PERMISSIONS.inventoryAdjust)).toBe(false);
  });

  it("grants a capability the role preset does not include", () => {
    expect(hasPermission("manager", null, PERMISSIONS.ledgerPost)).toBe(false);
    expect(
      hasPermission("manager", { granted: [PERMISSIONS.ledgerPost] }, PERMISSIONS.ledgerPost),
    ).toBe(true);
  });

  it("revokes a capability the role preset does include", () => {
    expect(hasPermission("cashier", null, PERMISSIONS.ordersDiscount)).toBe(true);
    expect(
      hasPermission("cashier", { revoked: [PERMISSIONS.ordersDiscount] }, PERMISSIONS.ordersDiscount),
    ).toBe(false);
  });

  it("applies revocation after grant when a key appears in both", () => {
    const effective = effectivePermissions("cashier", {
      granted: [PERMISSIONS.ledgerPost],
      revoked: [PERMISSIONS.ledgerPost],
    });
    expect(effective.has(PERMISSIONS.ledgerPost)).toBe(false);
  });

  it("cannot reduce an owner — a business must not be able to lock itself out", () => {
    const effective = effectivePermissions("owner", {
      revoked: [PERMISSIONS.teamManage, PERMISSIONS.settingsManage],
    });
    expect(effective.has(PERMISSIONS.teamManage)).toBe(true);
    expect(hasPermission("owner", { revoked: [PERMISSIONS.teamManage] }, PERMISSIONS.teamManage)).toBe(
      true,
    );
  });

  it("ignores unknown permission keys instead of throwing", () => {
    // A stored override naming a permission a later release removed must not
    // break every request that member makes.
    const effective = effectivePermissions("cashier", {
      granted: ["ledger.timetravel"],
      revoked: ["nonexistent.thing"],
    });
    expect(effective.has(PERMISSIONS.paymentsTake)).toBe(true);
    expect([...effective].every((p) => (ALL_PERMISSIONS as string[]).includes(p))).toBe(true);
  });

  it("leaves the preset untouched — effectivePermissions must not mutate shared state", () => {
    effectivePermissions("cashier", { revoked: [PERMISSIONS.paymentsTake] });
    expect(roleBasePermissions("cashier")).toContain(PERMISSIONS.paymentsTake);
  });
});

describe("parseOverrides", () => {
  it("reads well-formed jsonb", () => {
    expect(parseOverrides({ granted: ["ledger.post"], revoked: ["menu.edit"] })).toEqual({
      granted: ["ledger.post"],
      revoked: ["menu.edit"],
    });
  });

  it("degrades to no override for anything unusable", () => {
    for (const value of [null, undefined, "{}", 42, [], { granted: "ledger.post" }]) {
      const parsed = parseOverrides(value);
      expect(parsed.granted ?? []).toEqual([]);
      expect(parsed.revoked ?? []).toEqual([]);
    }
  });

  it("drops non-string entries inside the arrays", () => {
    expect(parseOverrides({ granted: ["ledger.post", 7, null] })).toEqual({
      granted: ["ledger.post"],
      revoked: [],
    });
  });
});


describe("owner-only permissions", () => {
  it("gives Admin every delegatable capability but no owner-only capability", () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPermission("admin", null, permission)).toBe(!isOwnerOnlyPermission(permission));
    }
  });

  it("does not let overrides delegate destructive security capabilities", () => {
    for (const permission of [
      PERMISSIONS.apiManage,
      PERMISSIONS.backupConfigure,
      PERMISSIONS.backupExport,
      PERMISSIONS.backupRestore,
      PERMISSIONS.rollupManage,
    ]) {
      expect(hasPermission("manager", { granted: [permission] }, permission)).toBe(false);
      expect(hasPermission("admin", { granted: [permission] }, permission)).toBe(false);
      expect(hasPermission("owner", { revoked: [permission] }, permission)).toBe(true);
    }
  });

  it("does not let overrides delegate API credential management", () => {
    expect(hasPermission("owner", null, PERMISSIONS.apiManage)).toBe(true);
    for (const role of ["manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      expect(hasPermission(role, null, PERMISSIONS.apiManage)).toBe(false);
      expect(
        hasPermission(role, { granted: [PERMISSIONS.apiManage] }, PERMISSIONS.apiManage),
      ).toBe(false);
    }
  });

  it("drops a legacy owner-only override instead of preserving a delegation", () => {
    expect(parseOverrides({ granted: [PERMISSIONS.apiManage], revoked: [PERMISSIONS.apiManage] })).toEqual({
      granted: [],
      revoked: [],
    });
  });
});
