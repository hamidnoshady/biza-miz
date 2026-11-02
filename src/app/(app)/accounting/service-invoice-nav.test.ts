/**
 * The Accounting sidebar of the three service trades has a sales group.
 *
 * The «فروش و درآمد» group is not declared per trade: it is assembled from the
 * business nav entries the trade's modules allow. An engineering/contracting
 * business used to have neither `orders` nor `pos`, so the group was absent and
 * a contractor could not bill a client from Accounting. These pin the fix: the
 * invoice entry is there, under the trade's own word for it, and the café and
 * stock entries are still not. Issue #1128's advertising agency is the third
 * trade in the list for the same reason — §D asks for estimates, milestones,
 * retainers and change requests, and the document those become is a service
 * invoice, so its Accounting sidebar has to reach the screen that writes one.
 */
import { describe, expect, it } from "vitest";
import { accessibleNavItemsFor } from "@/lib/tenant-navigation";
import { roleBasePermissions } from "@/lib/permissions";
import { accountingWorkspaceGroups } from "./accounting-workspace";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";

const features = new Proxy({} as Record<string, boolean>, { get: () => true });

function groupsFor(
  industry: "architecture_construction" | "service_saas" | "advertising_agency" | "food_service",
  role: "owner" | "accountant",
) {
  const permissions = new Set(roleBasePermissions(role));
  const navItems = accessibleNavItemsFor(industry, { settingsTabs: [] }, role, permissions, features).flatMap((item) => [
    item,
    ...(item.children ?? []),
  ]);
  return accountingWorkspaceGroups({
    permissions,
    navItems: navItems.filter((item): item is typeof item & { href: string } => Boolean(item.href)),
  });
}

describe("Accounting sidebar of the service trades", () => {
  it("gives an engineering/contracting owner the invoice entry under its own word", () => {
    const sales = groupsFor("architecture_construction", "owner").find((group) => group.key === "sales");
    expect(sales?.entries).toEqual([
      expect.objectContaining({ label: "صورتحساب و دریافت", href: ACCOUNTING_WORKSPACE_HREFS.pos }),
    ]);
  });

  it("gives a service company the same entry, labelled صورتحساب خدمات", () => {
    const sales = groupsFor("service_saas", "owner").find((group) => group.key === "sales");
    expect(sales?.entries.map((entry) => [entry.label, entry.href])).toEqual([
      ["صورتحساب خدمات", ACCOUNTING_WORKSPACE_HREFS.pos],
    ]);
  });

  it("gives an advertising agency the same entry, labelled صورتحساب و دریافت", () => {
    // Issue #1128 — the agency's `pos` is only the address of its invoice
    // screen, so the entry it buys is the one a contractor gets, under the
    // agency's own noun for a sale document (AGENCY_LABELS, never «فاکتور» of a
    // shop or «صندوق» of a café).
    const sales = groupsFor("advertising_agency", "owner").find((group) => group.key === "sales");
    expect(sales?.entries).toEqual([
      expect.objectContaining({ label: "صورتحساب و دریافت", href: ACCOUNTING_WORKSPACE_HREFS.pos }),
    ]);
  });

  it("does not add a café, stock or open-orders entry to any of the three", () => {
    for (const industry of ["architecture_construction", "service_saas", "advertising_agency"] as const) {
      const hrefs = groupsFor(industry, "owner").flatMap((group) => group.entries.map((entry) => entry.href));
      expect(hrefs, industry).not.toContain("/accounting/orders");
      expect(hrefs, industry).not.toContain(ACCOUNTING_WORKSPACE_HREFS.inventory);
      expect(hrefs, industry).not.toContain(ACCOUNTING_WORKSPACE_HREFS.kitchen);
      expect(hrefs, industry).not.toContain(ACCOUNTING_WORKSPACE_HREFS.floor);
    }
  });

  it("keeps the ledger workspace link for the accountant, who cannot take payments", () => {
    const groups = groupsFor("architecture_construction", "accountant");
    expect(groups.some((group) => group.key === "ledger")).toBe(true);
    // An accountant holds neither orders.create nor payments.take, so the till
    // gate (`canUsePos`) still keeps the invoice screen away from them.
    expect(groups.find((group) => group.key === "sales")).toBeUndefined();
  });
});
