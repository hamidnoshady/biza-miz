import { effectivePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth-edge";
import { describe, expect, it } from "vitest";
import {
  CRM_NAV_GROUPS,
  CRM_NAV_ITEMS,
  CRM_SUB_SECTIONS,
  crmNavGroupsForPermissions,
  crmNavItemsForPermissions,
} from "./crm-nav";
import {
  canOpenCrm,
  canViewCrmSection,
  crmCustomerHref,
  crmFallbackHref,
  CRM_SECTION_KEYS,
  crmSectionHref,
  isCrmSectionPathname,
} from "./crm-routes";

const permissionsFor = (role: string) => role ? effectivePermissions(role as Role, null) : new Set<import("@/lib/permissions").Permission>();

describe("CRM_NAV_ITEMS", () => {
  it("lists every navigation destination once and keeps detail pages out of the rail", () => {
    const keys = CRM_NAV_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("persons");
    // Every permanent item remains a real CRM route; the person profile is
    // reached from Contacts and therefore intentionally is not one.
    for (const key of keys) expect(CRM_SECTION_KEYS).toContain(key);
  });

  it("gives each entry a label and a line of help", () => {
    for (const item of CRM_NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
    const labels = CRM_NAV_ITEMS.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is the app's own menu and nothing else's", () => {
    // The CRM owns the sidebar while you are inside it. Its menu must therefore
    // hold only its own routes — no ledger, no growth page, no reports.
    for (const item of CRM_NAV_ITEMS) {
      const href = crmSectionHref(item.key);
      expect(href === "/crm/overview" || href.startsWith("/crm/")).toBe(true);
      expect(href).not.toContain("ledger");
      expect(href).not.toContain("growth");
      expect(href).not.toContain("reports");
    }
  });
});

describe("crmNavItemsForPermissions", () => {
  it("shows owner and manager every permanent CRM destination", () => {
    // `persons` is one customer's file rather than a destination, and a
    // sub-section is reached inside its workspace — neither is a rail entry, and
    // both are still real sections with their own gates.
    const permanentKeys = CRM_SECTION_KEYS.filter(
      (key) => key !== "persons" && !CRM_SUB_SECTIONS.includes(key),
    );
    for (const role of ["owner", "manager"]) {
      const shown = crmNavItemsForPermissions(permissionsFor(role)).map((item) => item.key);
      // As a *set*, not in section-key order: the menu is grouped into the six
      // Relationship OS destinations, so its order is the product's reading
      // order and deliberately not the order the keys happen to be declared in.
      expect([...shown].sort()).toEqual([...permanentKeys].sort());
      expect(new Set(shown).size).toBe(shown.length);
    }
  });

  it("groups every visible entry exactly once", () => {
    // The sidebar renders groups, and `AppSectionNav` silently ignores a key it
    // was not given. A section added to the nav but to no group would vanish
    // from the menu with nothing failing, so pin coverage in both directions.
    for (const role of ["owner", "manager", "cashier"]) {
      const items = crmNavItemsForPermissions(permissionsFor(role));
      const groups = crmNavGroupsForPermissions(items);
      const grouped = groups.flatMap((group) => [...group.keys]);
      expect([...grouped].sort()).toEqual(items.map((item) => item.key).sort());
      expect(new Set(grouped).size).toBe(grouped.length);
      for (const group of groups) {
        expect(group.label.trim().length).toBeGreaterThan(0);
        expect(group.keys.length).toBeGreaterThan(0);
      }
    }
  });

  it("names every section in exactly one group", () => {
    for (const key of CRM_NAV_ITEMS.map((item) => item.key)) {
      const homes = CRM_NAV_GROUPS.filter((group) => group.keys.includes(key));
      expect(homes.length, `${key} should have one group`).toBe(1);
    }
  });

  it("shows a cashier the floor surface only", () => {
    // The floor keeps exactly what the old flat «مشتریان» page gave it, plus the
    // service desk — the counter is where a complaint is actually heard. It does
    // not get segments, the pipeline, merge or the consent register.
    expect(crmNavItemsForPermissions(effectivePermissions("cashier" as Role, null)).map((item) => item.key)).toEqual([
      "directory",
      "activities",
      "cases",
    ]);
  });

  it("shows a role the app does not admit nothing at all", () => {
    // `crm/layout.tsx` redirects these roles out of the app entirely; a menu of
    // entries that all redirect away would be the same locked door with extra
    // steps. Accountants are on this list on purpose: the CRM posts no journal
    // entries, so there is no accounting reason to read customers' personal data.
    for (const role of ["accountant", "waiter", "kitchen", ""]) {
      expect(crmNavItemsForPermissions(permissionsFor(role))).toEqual([]);
      expect(canOpenCrm(permissionsFor(role))).toBe(false);
    }
  });

  it("is permission-honest while treating person files as a Contacts detail", () => {
    for (const role of ["owner", "manager", "cashier", "accountant"]) {
      const shown = new Set(crmNavItemsForPermissions(permissionsFor(role)).map((item) => item.key));
      for (const key of CRM_SECTION_KEYS.filter(
        (key) => key !== "persons" && !CRM_SUB_SECTIONS.includes(key),
      )) {
        expect(shown.has(key)).toBe(canViewCrmSection(permissionsFor(role), key));
      }
      expect(shown.has("persons")).toBe(false);
      // A sub-section is absent from the rail whoever is signed in — that is the
      // IA decision, not a permission one, which is why the loop above skips it.
      for (const key of CRM_SUB_SECTIONS) expect(shown.has(key)).toBe(false);
    }
  });
});

describe("crmFallbackHref", () => {
  it("keeps a cashier inside the app when they land on a management page", () => {
    // Being thrown to `/dashboard` from a link someone sent you reads as a bug
    // rather than as a permission boundary.
    expect(crmFallbackHref(effectivePermissions("cashier" as Role, null))).toBe("/crm/directory");
  });

  it("sends a role with no business here back to the dashboard", () => {
    expect(crmFallbackHref(effectivePermissions("accountant" as Role, null))).toBe("/dashboard");
  });
});

describe("isCrmSectionPathname", () => {
  it("lights the overview only on the app's root", () => {
    // Every section lives under the root path, so a prefix match would leave
    // «میز کار ارتباط با مشتری» active on all nine pages.
    expect(isCrmSectionPathname("/crm/overview", "overview")).toBe(true);
    expect(isCrmSectionPathname("/crm/segments", "overview")).toBe(false);
  });

  it("keeps a section active on its page and anything nested under it", () => {
    expect(isCrmSectionPathname("/crm/deals", "deals")).toBe(true);
    expect(isCrmSectionPathname("/crm/segments", "deals")).toBe(false);
    expect(isCrmSectionPathname("/dashboard/ledger", "directory")).toBe(false);
  });

  it("keeps Contacts lit on one customer's file", () => {
    // A profile is a detail of Contacts, not a permanent peer in the sidebar.
    const href = crmCustomerHref("c-42");
    expect(href).toBe("/crm/persons/c-42");
    expect(isCrmSectionPathname(href, "persons")).toBe(true);
    expect(isCrmSectionPathname(href, "directory")).toBe(true);
  });
});
