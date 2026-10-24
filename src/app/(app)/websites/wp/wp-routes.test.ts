/**
 * The WP Manager's section gate asks for woocommerce.view, the same capability
 * the manager's read routes enforce.
 */
import { describe, expect, it } from "vitest";
import { WP_SECTION_KEYS, canEditWpSection, canSyncWpSection, canViewWpSection } from "./wp-routes";
import { roleBasePermissions, type Permission } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

function of(role: Role | "none"): ReadonlySet<Permission> {
  return new Set<Permission>(role === "none" ? [] : roleBasePermissions(role));
}

describe("canViewWpSection", () => {
  it("gives owner, admin and manager the whole manager", () => {
    for (const role of ["owner", "admin", "manager"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canViewWpSection(of(role), key), `${role}/${key}`).toBe(true);
      }
    }
  });

  it("refuses roles that do not hold woocommerce.view", () => {
    for (const role of ["cashier", "waiter", "kitchen", "accountant", "none"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canViewWpSection(of(role), key), `${role}/${key}`).toBe(false);
      }
    }
  });

  it("follows a woocommerce.view grant rather than the preset it came from", () => {
    const cashierPlusRead = new Set<Permission>([...of("cashier"), "woocommerce.view"]);
    expect(canViewWpSection(cashierPlusRead, "products")).toBe(true);
    expect(canViewWpSection(cashierPlusRead, "queue")).toBe(true);

    const managerMinusView = new Set<Permission>(
      [...of("manager")].filter((p) => p !== "woocommerce.view" && p !== "woocommerce.manage"),
    );
    // manage implies view, so stripping both is what closes the door.
    expect(canViewWpSection(managerMinusView, "overview")).toBe(false);
  });

  it("stays closed with an empty permission set", () => {
    for (const key of WP_SECTION_KEYS) {
      expect(canViewWpSection(new Set(), key), key).toBe(false);
    }
  });
});

describe("the sync/edit tiers (#944 OVR-01)", () => {
  it("preset roles that run a store hold both write tiers; floor roles hold neither", () => {
    for (const role of ["owner", "admin", "manager"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canSyncWpSection(of(role), key), `${role}/${key} sync`).toBe(true);
        expect(canEditWpSection(of(role), key), `${role}/${key} edit`).toBe(true);
      }
    }
    for (const role of ["cashier", "waiter", "kitchen", "accountant", "none"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canSyncWpSection(of(role), key), `${role}/${key} sync`).toBe(false);
        expect(canEditWpSection(of(role), key), `${role}/${key} edit`).toBe(false);
      }
    }
  });

  it("the tiers are independent abilities — view never implies them, and they do not imply each other", () => {
    const viewOnly = new Set<Permission>(["woocommerce.view"]);
    expect(canSyncWpSection(viewOnly, "queue")).toBe(false);
    expect(canEditWpSection(viewOnly, "content")).toBe(false);

    const syncOnly = new Set<Permission>(["woocommerce.sync"]);
    expect(canSyncWpSection(syncOnly, "customers")).toBe(true);
    expect(canEditWpSection(syncOnly, "customers")).toBe(false);

    // The technical hub's broad grant is not a WP tier: it must not open
    // sync or edit here (that coupling is what OVR-01 removes).
    const hubOnly = new Set<Permission>(["integrations.view", "integrations.manage"]);
    expect(canViewWpSection(hubOnly, "overview")).toBe(false);
    expect(canSyncWpSection(hubOnly, "overview")).toBe(false);
    expect(canEditWpSection(hubOnly, "overview")).toBe(false);
  });
});
