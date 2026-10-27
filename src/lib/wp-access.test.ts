/**
 * Issue #944 / OVR-01 — the WordPress & WooCommerce manager's permission
 * matrix, asserted against the role presets and against the route handlers
 * that enforce it, so page, sidebar, store list and sync buttons cannot
 * drift apart again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Role } from "./auth-edge";
import { PERMISSIONS, roleBasePermissions, type Permission } from "./permissions";
import { canWp, WEBSITE_MANAGERS_READ_PERMISSIONS, WP_ABILITY_PERMISSIONS, wpAbilitiesOf } from "./wp-access";
import { canViewWpSection } from "@/app/(app)/websites/wp/wp-routes";
import { canOpenWebsiteApp } from "@/app/(app)/websites/website-routes";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function of(role: Role | "none"): Set<Permission> {
  return new Set<Permission>(role === "none" ? [] : roleBasePermissions(role));
}

describe("WP ability matrix", () => {
  it("owner, admin and manager hold every WP ability", () => {
    for (const role of ["owner", "admin", "manager"] as const) {
      expect(wpAbilitiesOf(of(role)), role).toEqual(["view", "sync", "content_manage", "store_manage", "configure"]);
    }
  });

  it("a custom `woocommerce.view`-only grant opens the manager and its reads but no sync or edit", () => {
    const viewer = new Set<Permission>([PERMISSIONS.woocommerceView]);
    expect(canViewWpSection(viewer, "overview")).toBe(true);
    expect(canWp(viewer, "view")).toBe(true);
    expect(canWp(viewer, "sync")).toBe(false);
    expect(canWp(viewer, "content_manage")).toBe(false);
    expect(canWp(viewer, "store_manage")).toBe(false);
    expect(canWp(viewer, "configure")).toBe(false);
    // The viewer never needs the technical hub's keys to see the store list.
    expect(viewer.has(PERMISSIONS.integrationsView)).toBe(false);
    expect(viewer.has(PERMISSIONS.websiteView)).toBe(false);
  });

  it("`woocommerce.sync` grants exactly the sync ability — never integration configuration", () => {
    const syncer = new Set<Permission>([PERMISSIONS.woocommerceView, PERMISSIONS.woocommerceSync]);
    expect(canWp(syncer, "sync")).toBe(true);
    expect(canWp(syncer, "configure")).toBe(false);
    expect(canWp(syncer, "store_manage")).toBe(false);
    expect(syncer.has(PERMISSIONS.integrationsManage)).toBe(false);
  });

  it("`integrations.manage` keeps the sync access it always had, but is never implied by any WP key", () => {
    const technician = new Set<Permission>([PERMISSIONS.integrationsView, PERMISSIONS.integrationsManage]);
    expect(canWp(technician, "sync")).toBe(true);
    // `view` is the only ability `woocommerce.view` grants: it must never
    // appear in a mutating ability's list, which is what "elevating view
    // into integrations.manage" would look like in this file.
    for (const ability of ["sync", "content_manage", "store_manage", "configure"] as const) {
      expect(WP_ABILITY_PERMISSIONS[ability], ability).not.toContain(PERMISSIONS.woocommerceView);
    }
    expect(WP_ABILITY_PERMISSIONS.view).toEqual([PERMISSIONS.woocommerceView]);
  });

  it("a revoked grant closes the door; roles without the key never had it", () => {
    for (const role of ["cashier", "waiter", "kitchen", "accountant", "none"] as const) {
      expect(wpAbilitiesOf(of(role)), role).toEqual([]);
    }
    const revoked = new Set<Permission>([...of("manager")].filter((p) => !p.startsWith("woocommerce.") && p !== PERMISSIONS.integrationsManage));
    expect(canWp(revoked, "view")).toBe(false);
    expect(canWp(revoked, "sync")).toBe(false);
  });

  it("accepts a permission array as well as a set (the shape handed to client components)", () => {
    expect(canWp([PERMISSIONS.woocommerceSync], "sync")).toBe(true);
    expect(canWp([], "sync")).toBe(false);
  });

  it("the sidebar's managers read is open to exactly the keys that open the Website app", () => {
    for (const permission of WEBSITE_MANAGERS_READ_PERMISSIONS) {
      expect(canOpenWebsiteApp(new Set([permission])), permission).toBe(true);
    }
    expect(canOpenWebsiteApp(new Set([PERMISSIONS.integrationsView]))).toBe(false);
    expect(WEBSITE_MANAGERS_READ_PERMISSIONS).toHaveLength(3);
  });
});

describe("WP routes enforce the matrix", () => {
  const syncRoutes = [
    "src/app/api/integrations/connections/[id]/sync/products/route.ts",
    "src/app/api/integrations/connections/[id]/sync/orders/route.ts",
    "src/app/api/integrations/connections/[id]/sync/customers/route.ts",
  ];

  it("products/orders/customers sync routes accept the sync ability (any-of) rather than only integrations.manage", () => {
    for (const route of syncRoutes) {
      const source = read(route);
      expect(source, route).toContain("requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync)");
      expect(source, route).not.toContain("requirePermission(PERMISSIONS.integrationsManage)");
    }
  });

  it("content sync POST accepts the sync ability; content GET stays a view read", () => {
    const source = read("src/app/api/integrations/wp-manager/content/route.ts");
    expect(source).toContain("requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync, PERMISSIONS.woocommerceManage)");
    expect(source).toContain("requirePermission(PERMISSIONS.woocommerceView)");
  });

  it("the WP-scoped connection list asks for woocommerce.view and respects live location access", () => {
    const source = read("src/app/api/integrations/wp-manager/connections/route.ts");
    expect(source).toContain("requirePermission(PERMISSIONS.woocommerceView)");
    expect(source).toContain('connection.provider === "woocommerce"');
    expect(source).toContain("listAccessibleConnections(session)");
    expect(source).not.toContain("listConnections(session.businessId)");
  });

  it("the website managers read accepts any app-opening key", () => {
    const source = read("src/app/api/website/managers/route.ts");
    expect(source).toContain("requireAnyPermission(...WEBSITE_MANAGERS_READ_PERMISSIONS)");
  });

  it("the shared connections list scopes Woo view to its filtered picker and keeps unfiltered access on integrations.view", () => {
    const source = read("src/app/api/integrations/connections/route.ts");
    expect(source).toContain("requireAnyPermission(PERMISSIONS.integrationsView, PERMISSIONS.woocommerceView)");
    expect(source).toContain("requirePermission(PERMISSIONS.integrationsView)");
    expect(source).toContain("listAccessibleConnections(session)");
    expect(source).toContain("connection.provider === provider");
    expect(read("src/app/(app)/websites/wp/wp-store-context.tsx")).not.toContain("provider=woocommerce");
  });
});

describe("WP media routes enforce the matrix (#941)", () => {
  // Every media route: [file, the guard it must call, whether a write path is paused-store aware].
  const mediaRoutes: { route: string; guards: string[]; paused: boolean }[] = [
    {
      route: "src/app/api/integrations/wp-manager/media/route.ts",
      guards: ["requirePermission(PERMISSIONS.woocommerceManage)"],
      paused: true,
    },
    {
      route: "src/app/api/integrations/wp-manager/media/[id]/route.ts",
      guards: ["requirePermission(PERMISSIONS.woocommerceView)", "requirePermission(PERMISSIONS.woocommerceManage)"],
      paused: true,
    },
    {
      route: "src/app/api/integrations/wp-manager/media/[id]/link/route.ts",
      guards: ["requirePermissions(PERMISSIONS.mediaView, PERMISSIONS.mediaManage, PERMISSIONS.woocommerceManage)"],
      paused: true,
    },
    {
      route: "src/app/api/media/[id]/wordpress/route.ts",
      guards: [
        "requirePermissions(PERMISSIONS.mediaView, PERMISSIONS.woocommerceView)",
        "requirePermissions(PERMISSIONS.mediaManage, PERMISSIONS.woocommerceManage)",
      ],
      paused: true,
    },
  ];

  it("each route asks for the keys the matrix names, and never a bare role", () => {
    for (const { route, guards } of mediaRoutes) {
      const source = read(route);
      for (const guard of guards) expect(source, `${route} ${guard}`).toContain(guard);
      expect(source, route).not.toContain("requireRole(");
    }
  });

  it("each route resolves the store through the member's branch-scoped access and refuses a paused one", () => {
    for (const { route, paused } of mediaRoutes) {
      const source = read(route);
      expect(source, route).toMatch(/getAccessibleConnection|listAccessibleConnections/);
      expect(source, route).not.toMatch(/getConnection\(/);
      if (paused) expect(source, route).toContain("connection_paused");
    }
  });

  it("a write needs `woocommerce.manage` — a view-only or sync-only member can read but not push, edit or import", () => {
    const viewer = new Set<Permission>([PERMISSIONS.woocommerceView, PERMISSIONS.mediaView]);
    const syncer = new Set<Permission>([PERMISSIONS.woocommerceView, PERMISSIONS.woocommerceSync]);
    expect(canWp(viewer, "content_manage")).toBe(false);
    expect(canWp(syncer, "content_manage")).toBe(false);
    expect(WP_ABILITY_PERMISSIONS.content_manage).toEqual([PERMISSIONS.woocommerceManage]);
    // A canonical push also needs the media library's own manage key: neither half alone is enough.
    const woo = new Set<Permission>([PERMISSIONS.woocommerceManage]);
    expect(woo.has(PERMISSIONS.mediaManage)).toBe(false);
  });
});
