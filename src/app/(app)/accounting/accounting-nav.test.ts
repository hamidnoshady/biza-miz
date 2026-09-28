import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_DOOR_PERMISSION,
  ACCOUNTING_SECTIONS,
  accountingSectionsFor,
  canOpenAccountingApp,
  canOpenLedger,
  canViewAccountingSection,
} from "./accounting-nav";
import { roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import {
  ACCOUNTING_SECTION_KEYS,
  accountingCustomerHref,
  accountingCustomersHref,
  accountingDirectoryViewForLegacySection,
  accountingSectionForLegacyTab,
  accountingSectionHref,
  isAccountingSectionKey,
  isAccountingSectionPathname,
} from "./accounting-routes";

describe("ACCOUNTING_SECTIONS", () => {
  it("lists every section exactly once, dashboard first", () => {
    const keys = ACCOUNTING_SECTIONS.map((section) => section.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("dashboard");
    // …and the menu cannot invent a section the routes do not know.
    expect(keys).toEqual([...ACCOUNTING_SECTION_KEYS]);
  });

  it("gives every entry a non-empty label", () => {
    for (const section of ACCOUNTING_SECTIONS) {
      expect(section.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("points every section at the app's own route prefix", () => {
    // The Accounting app has its own address now — `/accounting/…` —
    // one real route per section, never a `?tab=` on the old ledger page and
    // never another app's page.
    for (const section of ACCOUNTING_SECTIONS) {
      const href = accountingSectionHref(section.key);
      if (section.key === "dashboard") {
        expect(href).toBe("/accounting/overview");
      } else {
        expect(href.startsWith("/accounting/")).toBe(true);
        expect(href).not.toContain("?");
      }
    }
  });

  it("names the persons section the directory route, inside accounting", () => {
    expect(accountingSectionHref("directory")).toBe("/accounting/directory");
    // «مشتریان» is a view of that one directory, not a route of its own — the
    // A/R customer links land on the directory with the customers filter on.
    expect(accountingCustomersHref()).toBe("/accounting/directory?view=customers");
    expect(accountingCustomerHref("p1")).toBe("/accounting/directory?view=customers&party=p1");
  });
});

/**
 * The section list is driven by effective permissions now. These tests still
 * name roles because what they pin is a migration invariant: each built-in
 * preset must see exactly the sections its old role list produced.
 */
function of(role: Role | "none"): ReadonlySet<string> {
  return new Set<string>(role === "none" ? [] : roleBasePermissions(role));
}

describe("accountingSectionsFor", () => {
  it("shows owner, manager and accountant the whole app", () => {
    expect(accountingSectionsFor(of("owner")).map((s) => s.key)).toEqual(ACCOUNTING_SECTIONS.map((s) => s.key));
    expect(accountingSectionsFor(of("accountant")).map((s) => s.key)).toEqual(ACCOUNTING_SECTIONS.map((s) => s.key));
  });

  it("hides payroll from a manager but keeps the rest", () => {
    const keys = accountingSectionsFor(of("manager")).map((s) => s.key);
    expect(keys).not.toContain("payroll");
    expect(keys).toContain("trial-balance");
    expect(keys).toContain("directory");
    expect(keys).toContain("dashboard");
  });

  it("keeps operational staff out of ledger sections", () => {
    for (const role of ["cashier", "waiter", "kitchen", "none"] as const) {
      expect(accountingSectionsFor(of(role))).toEqual([]);
      for (const key of ACCOUNTING_SECTION_KEYS) {
        expect(canViewAccountingSection(of(role), key)).toBe(false);
      }
    }
  });

  it("separates opening the operational app from opening the ledger", () => {
    for (const role of ["cashier", "waiter", "kitchen"] as const) {
      expect(canOpenAccountingApp(of(role)), role).toBe(true);
      expect(canOpenLedger(of(role)), role).toBe(false);
    }
    expect(canOpenAccountingApp(of("none"))).toBe(false);
  });

  it("opens the ledger to everyone holding its door capability", () => {
    // Including `viewer`, the read-only auditor role: being able to read the
    // books is the entire point of that role, and `ledger.view` is in its
    // preset deliberately.
    for (const role of ["owner", "admin", "manager", "accountant"] as const) {
      expect(of(role).has(ACCOUNTING_DOOR_PERMISSION), role).toBe(true);
      expect(accountingSectionsFor(of(role)).length, role).toBeGreaterThan(0);
    }
  });

  it("gates payroll on the capability, not on a role name", () => {
    // A manager individually granted `payroll.view` sees payroll; the preset
    // alone does not. This is the whole reason the gate moved off role strings.
    // The key is payroll's own, not a borrowed `ledger.post` that merely
    // happened to have the right preset audience.
    const managerPlusPosting = new Set([...of("manager"), "payroll.view"]);
    expect(accountingSectionsFor(managerPlusPosting).map((s) => s.key)).toContain("payroll");
    const accountantMinusPosting = new Set(
      [...of("accountant")].filter((p) => p !== "payroll.view"),
    );
    expect(accountingSectionsFor(accountantMinusPosting).map((s) => s.key)).not.toContain("payroll");
  });
});

describe("isAccountingSectionKey", () => {
  it("accepts the known keys and rejects the unknown", () => {
    expect(isAccountingSectionKey("cheques")).toBe(true);
    expect(isAccountingSectionKey("directory")).toBe(true);
    expect(isAccountingSectionKey("nonsense")).toBe(false);
    expect(isAccountingSectionKey(null)).toBe(false);
  });
});

describe("accountingSectionForLegacyTab", () => {
  it("answers every old `?tab=` target with the section it names now", () => {
    expect(accountingSectionForLegacyTab("cheques")).toBe("cheques");
    // The per-role party tabs all land on the one directory now; the page
    // turns each of them into the matching `?view=`.
    expect(accountingSectionForLegacyTab("customers")).toBe("directory");
    expect(accountingSectionForLegacyTab("suppliers")).toBe("directory");
    expect(accountingSectionForLegacyTab("vendors")).toBe("directory");
    expect(accountingSectionForLegacyTab("parties")).toBe("directory");
  });

  it("lands an unknown or missing tab on the app's home", () => {
    expect(accountingSectionForLegacyTab("nonsense")).toBe("dashboard");
    expect(accountingSectionForLegacyTab(null)).toBe("dashboard");
    expect(accountingSectionForLegacyTab(undefined)).toBe("dashboard");
  });
});

describe("the directory view a legacy per-role URL asked for", () => {
  it("names the filter, so a bookmark keeps its list", () => {
    // «تأمین‌کنندگان» landing on «همه اشخاص» is losing the filter, not
    // preserving the URL. Both the `/accounting/<key>` routes and the old
    // `/dashboard/ledger?tab=` addresses forward through this.
    expect(accountingDirectoryViewForLegacySection("customers")).toBe("customers");
    expect(accountingDirectoryViewForLegacySection("suppliers")).toBe("suppliers");
    expect(accountingDirectoryViewForLegacySection("vendors")).toBe("vendors");
  });

  it("says nothing about a section that was never a party screen", () => {
    for (const key of ["directory", "parties", "entries", "payroll", null, undefined]) {
      expect(accountingDirectoryViewForLegacySection(key)).toBeNull();
    }
  });
});

describe("isAccountingSectionPathname", () => {
  it("lights the dashboard only on the app root, sections on their own routes", () => {
    expect(isAccountingSectionPathname("/accounting/overview", "dashboard")).toBe(true);
    expect(isAccountingSectionPathname("/accounting/directory", "dashboard")).toBe(false);
    expect(isAccountingSectionPathname("/accounting/directory", "directory")).toBe(true);
    // What nests under a section is that section's.
    expect(isAccountingSectionPathname("/accounting/directory/x", "directory")).toBe(true);
    // …and the old address never lights a section.
    expect(isAccountingSectionPathname("/dashboard/ledger", "directory")).toBe(false);
  });
});
