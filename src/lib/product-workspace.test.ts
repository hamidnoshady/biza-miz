import { describe, expect, it } from "vitest";
import { ENABLED_INDUSTRIES, RETAIL_CATALOGUE_INDUSTRIES, isRetailCatalogueIndustry } from "./industries";
import { catalogueAdapterFor, isProductWorkspaceIndustry, productApiBaseFor } from "./product-workspace";
import { hasCapability } from "./industry-profile";
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from "./permissions";
import { accessibleNavItemsFor } from "./tenant-navigation";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import type { NavItem } from "@/app/dashboard/dashboard-sidebar";

function flatten(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

const features = { inventory: true, ledger: true, reporting: true, reservations: true, delivery: true };

describe("retail catalogue entry adapters", () => {
  it("covers the canonical retail registry and excludes all other industries", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      expect(catalogueAdapterFor(industry) !== null, industry).toBe(isRetailCatalogueIndustry(industry));
      const items = flatten(accessibleNavItemsFor(industry, { settingsTabs: [] }, "owner", new Set(ALL_PERMISSIONS), features));
      expect(items.some((item) => item.href === ACCOUNTING_WORKSPACE_HREFS.products), industry)
        .toBe(isRetailCatalogueIndustry(industry));
      const labelEntry = items.find((item) => item.href === `${ACCOUNTING_WORKSPACE_HREFS.products}/barcode-templates`);
      expect(Boolean(labelEntry), industry).toBe(isRetailCatalogueIndustry(industry) && hasCapability(industry, "barcode"));
      if (labelEntry) expect(labelEntry.label).toBe("بارکد و برچسب محصولات");
    }
    expect(catalogueAdapterFor(null)).toBeNull();
  });

  it("never routes a specialist to the variant APIs", () => {
    expect(catalogueAdapterFor("jewelry")).toEqual({ kind: "specialist", href: "/accounting/jewelry", readPermission: PERMISSIONS.inventoryView });
    expect(catalogueAdapterFor("watch")).toEqual({ kind: "specialist", href: "/accounting/watch", readPermission: PERMISSIONS.inventoryView });
    expect(catalogueAdapterFor("automotive")).toEqual({ kind: "specialist", href: "/accounting/automotive", readPermission: PERMISSIONS.vehiclesView });
    for (const industry of RETAIL_CATALOGUE_INDUSTRIES) {
      const adapter = catalogueAdapterFor(industry);
      expect(adapter?.kind === "variants").toBe(isProductWorkspaceIndustry(industry));
      if (isProductWorkspaceIndustry(industry)) expect(adapter).toEqual({ kind: "variants", apiBase: productApiBaseFor(industry) });
    }
  });

  it("does not offer creation to a read-only variant catalogue member", () => {
    const permissions = new Set<Permission>([PERMISSIONS.inventoryView]);
    const items = flatten(accessibleNavItemsFor("accessories", { settingsTabs: [] }, "manager", permissions, features));
    expect(items.some((item) => item.href === ACCOUNTING_WORKSPACE_HREFS.products)).toBe(true);
    expect(items.some((item) => item.href === `${ACCOUNTING_WORKSPACE_HREFS.products}/new`)).toBe(false);
    permissions.add(PERMISSIONS.inventoryAdjust);
    const editorItems = flatten(accessibleNavItemsFor("accessories", { settingsTabs: [] }, "manager", permissions, features));
    expect(editorItems.some((item) => item.href === `${ACCOUNTING_WORKSPACE_HREFS.products}/new`)).toBe(true);
  });

  it("offers vehicle creation only with the vehicle view and create permissions", () => {
    const href = `${ACCOUNTING_WORKSPACE_HREFS.products}/new`;
    for (const permissions of [[], [PERMISSIONS.vehiclesView], [PERMISSIONS.vehiclesCreate]]) {
      const items = flatten(accessibleNavItemsFor("automotive", { settingsTabs: [] }, "manager", new Set(permissions), features));
      expect(items.some((item) => item.href === href)).toBe(false);
    }
    const items = flatten(accessibleNavItemsFor("automotive", { settingsTabs: [] }, "manager", new Set([PERMISSIONS.vehiclesView, PERMISSIONS.vehiclesCreate]), features));
    expect(items.some((item) => item.href === href)).toBe(true);
  });

  it("shows only implemented specialist pages with their native read permissions", () => {
    const jewelry = flatten(accessibleNavItemsFor("jewelry", { settingsTabs: [] }, "manager", new Set([PERMISSIONS.inventoryView]), features));
    expect(jewelry.some((item) => item.href === `${ACCOUNTING_WORKSPACE_HREFS.products}/prices`)).toBe(true);
    const watchReader = flatten(accessibleNavItemsFor("watch", { settingsTabs: [] }, "manager", new Set([PERMISSIONS.inventoryView]), features));
    expect(watchReader.some((item) => item.href === `${ACCOUNTING_WORKSPACE_HREFS.products}/reports`)).toBe(false);
    const watchReporter = flatten(accessibleNavItemsFor("watch", { settingsTabs: [] }, "manager", new Set([PERMISSIONS.inventoryView, PERMISSIONS.reportsView]), features));
    expect(watchReporter.some((item) => item.href === `${ACCOUNTING_WORKSPACE_HREFS.products}/reports`)).toBe(true);
  });

  it("hides specialist entry points without the native read permission", () => {
    for (const industry of RETAIL_CATALOGUE_INDUSTRIES) {
      const adapter = catalogueAdapterFor(industry);
      if (adapter?.kind !== "specialist") continue;
      const permissions = new Set<Permission>(ALL_PERMISSIONS);
      permissions.delete(adapter.readPermission);
      const items = flatten(accessibleNavItemsFor(industry, { settingsTabs: [] }, "owner", permissions, features));
      expect(items.some((item) => item.href === ACCOUNTING_WORKSPACE_HREFS.products), industry).toBe(false);
    }
  });
});
