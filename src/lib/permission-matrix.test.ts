/**
 * The permission matrix — what each built-in role may do, asserted exhaustively.
 *
 * ## Why this file is a snapshot of the whole grid rather than spot checks
 *
 * The role presets are edited whenever a feature ships: a new permission key
 * gets added to `manager` so managers keep the screen they already had, an app
 * is split into graded capabilities, a preset is "tidied". Every one of those
 * edits is a one-line diff, and a one-line diff to a preset is indistinguishable
 * — in review — from a one-line privilege escalation.
 *
 * Spot checks ("a cashier cannot refund") do not catch that, because the
 * escalation is always in the key nobody thought to spot-check. So this asserts
 * the *entire* effective set for every role. Adding a permission to a preset is
 * then a visible, deliberate change to this file, and a reviewer sees exactly
 * which role gained what.
 */
import { describe, expect, it } from "vitest";
import type { Role } from "./auth-edge";
import {
  ALL_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  isOwnerOnlyPermission,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  parseOverrides,
  roleBasePermissions,
} from "./permissions";

const ROLES: Role[] = [
  "owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen",
];

const effective = (role: Role) => [...effectivePermissions(role, {})].sort();

describe("built-in role presets", () => {
  it("gives the owner every permission, including the non-delegable ones", () => {
    expect(effective("owner")).toEqual([...ALL_PERMISSIONS].sort());
    for (const key of OWNER_ONLY_PERMISSIONS) {
      expect(hasPermission("owner", {}, key)).toBe(true);
    }
  });

  it("gives the admin everything except the owner-only capabilities", () => {
    const admin = new Set(effective("admin"));
    for (const key of ALL_PERMISSIONS) {
      expect(admin.has(key)).toBe(!isOwnerOnlyPermission(key));
    }
    // The distinction that makes Admin worth having: full tenant
    // administration, no ownership.
    expect(hasPermission("admin", {}, PERMISSIONS.teamManage)).toBe(true);
    expect(hasPermission("admin", {}, PERMISSIONS.teamPermissionsManage)).toBe(true);
    expect(hasPermission("admin", {}, PERMISSIONS.locationsManage)).toBe(true);
    expect(hasPermission("admin", {}, PERMISSIONS.apiManage)).toBe(false);
  });

  it("holds the manager preset exactly", () => {
    expect(effective("manager")).toEqual([
      "ai.automations.manage", "ai.manage", "ai.usage.view", "ai.use",
      "backup.manage",
      "billing.manage", "billing.view",
      "campaigns.manage", "campaigns.view",
      "cms.configure", "cms.content_manage", "cms.publish", "cms.view",
      "commission.manage", "commission.view",
      "crm.configure", "crm.consent_manage", "crm.delete", "crm.export", "crm.manage", "crm.merge", "crm.view",
      "data.export", "data.import",
      "delivery.configure", "delivery.manage",
      "finance.assets_manage", "finance.cheques_manage", "finance.expenses_manage",
      "finance.installments_manage", "finance.payables_manage",
      "finance.receivables_manage", "finance.reconciliation_manage",
      "gift_cards.issue", "gift_cards.redeem", "gift_cards.view",
      "growth.view",
      "integrations.manage", "integrations.view",
      "inventory.adjust", "inventory.view",
      "kitchen.view",
      "ledger.propose", "ledger.view",
      "loyalty.manage", "loyalty.redeem", "loyalty.view",
      "marketing.configure",
      "media.manage", "media.view",
      "menu.edit", "menu.view",
      "orders.amend_closed", "orders.create", "orders.discount", "orders.view", "orders.void",
      "parties.manage", "parties.view",
      "payments.refund", "payments.take",
      "printing.execute",
      "purchases.manage",
      "reports.export", "reports.view",
      "reservations.manage", "reservations.view",
      "settings.manage",
      "store_credit.issue", "store_credit.payout",
      "tables.edit", "tables.manage",
      "website.manage", "website.settings_manage", "website.view",
      "woocommerce.configure", "woocommerce.manage", "woocommerce.sync", "woocommerce.view",
      "workspace.admin", "workspace.approve", "workspace.contracts_manage", "workspace.documents_issue", "workspace.manage", "workspace.view",
    ]);
  });

  it("holds the accountant preset exactly — the books, and no till or floor", () => {
    expect(effective("accountant")).toEqual([
      "accounts.edit",
      "ai.usage.view", "ai.use",
      "commission.view",
      "data.export", "data.import",
      "finance.assets_manage", "finance.cheques_manage", "finance.expenses_manage",
      "finance.installments_manage", "finance.payables_manage",
      "finance.receivables_manage", "finance.reconciliation_manage",
      "growth.view",
      "inventory.view",
      "ledger.approve", "ledger.close_period", "ledger.post", "ledger.propose", "ledger.view",
      "menu.view",
      "parties.manage", "parties.view",
      "payroll.manage", "payroll.view",
      "reports.export", "reports.view",
      "workspace.view",
    ]);
  });

  it("holds the cashier preset exactly", () => {
    expect(effective("cashier")).toEqual([
      "ai.use",
      "crm.manage", "crm.view",
      "delivery.manage",
      "gift_cards.view",
      "inventory.view",
      "loyalty.redeem", "loyalty.view",
      "menu.view",
      "orders.create", "orders.discount", "orders.view",
      "parties.manage", "parties.view",
      "payments.take",
      "printing.execute",
      "reservations.manage", "reservations.view",
      "tables.manage",
      "workspace.manage", "workspace.view",
    ]);
  });

  it("holds the waiter preset exactly", () => {
    expect(effective("waiter")).toEqual([
      "ai.use",
      "menu.view",
      "orders.create", "orders.view",
      "printing.execute",
      "reservations.manage", "reservations.view",
      "tables.manage",
      "workspace.view",
    ]);
  });

  it("holds the kitchen preset exactly", () => {
    expect(effective("kitchen")).toEqual(["ai.use", "kitchen.view", "menu.view", "printing.execute"]);
  });

});

describe("privilege boundaries that must not drift", () => {
  it("keeps the till roles away from money-reversal and the books", () => {
    for (const role of ["cashier", "waiter", "kitchen"] as const) {
      expect(hasPermission(role, {}, PERMISSIONS.paymentsRefund)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.ordersAmendClosed)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.ledgerPost)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.backupManage)).toBe(false);
    }
  });

  it("keeps team administration off every non-administrative preset", () => {
    for (const role of ["manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      expect(hasPermission(role, {}, PERMISSIONS.teamManage)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.teamPermissionsManage)).toBe(false);
    }
  });

  it("keeps API credential management owner-only through every preset", () => {
    for (const role of ROLES) {
      expect(hasPermission(role, {}, PERMISSIONS.apiManage)).toBe(role === "owner");
    }
  });

  it("never lets a non-owner preset out-grant the admin preset", () => {
    const admin = new Set(roleBasePermissions("admin"));
    for (const role of ROLES) {
      if (role === "owner" || role === "admin") continue;
      for (const key of roleBasePermissions(role)) {
        expect(admin.has(key)).toBe(true);
      }
    }
  });
});

describe("backward compatibility with the roles that existed before the refactor", () => {
  /**
   * The refactor split several role-only gates into graded permission keys.
   * Splitting a gate must never be the thing that takes access away, so these
   * assert that each legacy role still holds a key for every area it could
   * already reach.
   */
  it("keeps the manager's website access after the role gate became four keys", () => {
    // Was requireRole("owner", "manager") on all 26 /api/cms/website/* guards.
    expect(hasPermission("manager", {}, PERMISSIONS.websiteView)).toBe(true);
    expect(hasPermission("manager", {}, PERMISSIONS.cmsView)).toBe(true);
    expect(hasPermission("manager", {}, PERMISSIONS.cmsContentManage)).toBe(true);
    expect(hasPermission("manager", {}, PERMISSIONS.cmsPublish)).toBe(true);
    expect(hasPermission("manager", {}, PERMISSIONS.cmsConfigure)).toBe(true);
  });

  it("keeps the growth reads the accountant and cashier already had", () => {
    // Deliberately two capability pairs, not one. `/api/growth/customers` was
    // owner/manager/accountant and the loyalty lookups were
    // owner/manager/cashier; collapsing both into a single `growth.view` would
    // have handed each of them the other's screens.
    // /api/growth/accounting and /api/growth/customers were open to accountants.
    expect(hasPermission("accountant", {}, PERMISSIONS.growthView)).toBe(true);
    // The loyalty lookups the till uses were open to cashiers.
    expect(hasPermission("cashier", {}, PERMISSIONS.loyaltyView)).toBe(true);
    expect(hasPermission("accountant", {}, PERMISSIONS.loyaltyView)).toBe(false);
    expect(hasPermission("accountant", {}, PERMISSIONS.campaignsManage)).toBe(false);
    expect(hasPermission("cashier", {}, PERMISSIONS.campaignsManage)).toBe(false);
    expect(hasPermission("accountant", {}, PERMISSIONS.loyaltyManage)).toBe(false);
  });

  it("keeps management, compensation and liability-creating Growth acts off the cashier (issue #764)", () => {
    // The cashier still earns and spends points and looks a gift card up.
    for (const key of [PERMISSIONS.loyaltyView, PERMISSIONS.loyaltyRedeem, PERMISSIONS.giftCardsView]) {
      expect(hasPermission("cashier", {}, key), key).toBe(true);
    }
    // Everything else needs an explicit grant of that exact key.
    for (const key of [
      PERMISSIONS.growthView, PERMISSIONS.commissionView, PERMISSIONS.commissionManage,
      PERMISSIONS.campaignsView, PERMISSIONS.campaignsManage, PERMISSIONS.loyaltyManage,
      PERMISSIONS.storeCreditIssue, PERMISSIONS.storeCreditPayout,
      PERMISSIONS.giftCardsIssue, PERMISSIONS.giftCardsRedeem, PERMISSIONS.marketingConfigure,
    ]) {
      expect(hasPermission("cashier", {}, key), key).toBe(false);
    }
  });

  it("grants one Growth capability without dragging the management dashboard along", () => {
    // A write implies its own read, never growth.view: a senior cashier given
    // gift-card issuing must not also receive the business's KPIs.
    const granted = effectivePermissions("cashier", { granted: [PERMISSIONS.giftCardsIssue, PERMISSIONS.storeCreditPayout] });
    expect(granted.has(PERMISSIONS.giftCardsIssue)).toBe(true);
    expect(granted.has(PERMISSIONS.storeCreditPayout)).toBe(true);
    expect(granted.has(PERMISSIONS.growthView)).toBe(false);
    expect(granted.has(PERMISSIONS.storeCreditIssue)).toBe(false);
    // Revoking the read takes the dependent writes with it.
    const revoked = effectivePermissions("manager", { revoked: [PERMISSIONS.giftCardsView, PERMISSIONS.commissionView] });
    expect(revoked.has(PERMISSIONS.giftCardsIssue)).toBe(false);
    expect(revoked.has(PERMISSIONS.giftCardsRedeem)).toBe(false);
    expect(revoked.has(PERMISSIONS.commissionManage)).toBe(false);
  });
});

describe("member overrides", () => {
  it("adds a permission the role does not include", () => {
    expect(
      hasPermission("cashier", { granted: ["reports.view"] }, PERMISSIONS.reportsView),
    ).toBe(true);
  });

  it("removes a permission the role does include", () => {
    expect(
      hasPermission("cashier", { revoked: ["orders.discount"] }, PERMISSIONS.ordersDiscount),
    ).toBe(false);
  });

  it("lets revocation win when a key is both granted and revoked", () => {
    expect(
      hasPermission(
        "cashier",
        { granted: ["payments.refund"], revoked: ["payments.refund"] },
        PERMISSIONS.paymentsRefund,
      ),
    ).toBe(false);
  });

  it("refuses to delegate an owner-only permission through a member grant", () => {
    expect(hasPermission("manager", { granted: ["api.manage"] }, PERMISSIONS.apiManage)).toBe(false);
    // …and strips it at the parsing boundary too, so it never even reaches storage.
    expect(parseOverrides({ granted: ["api.manage", "reports.view"] }).granted).toEqual([
      "reports.view",
    ]);
  });

  it("cannot reduce an owner", () => {
    expect(
      hasPermission("owner", { revoked: [...ALL_PERMISSIONS] }, PERMISSIONS.teamManage),
    ).toBe(true);
  });

  it("CAN reduce an admin — the role is delegated, not absolute", () => {
    // The whole point of Admin being distinct from Owner: an owner can hand out
    // tenant administration and still carve pieces back out of it.
    expect(
      hasPermission("admin", { revoked: ["backup.manage"] }, PERMISSIONS.backupManage),
    ).toBe(false);
  });

  it("ignores permission keys it does not recognise rather than throwing", () => {
    // A stored override naming a key a later release removed must not break
    // every request that member makes.
    expect(() =>
      effectivePermissions("cashier", { granted: ["nope.gone"], revoked: ["also.gone"] }),
    ).not.toThrow();
    expect(hasPermission("cashier", { granted: ["nope.gone"] }, PERMISSIONS.menuView)).toBe(true);
  });
});
