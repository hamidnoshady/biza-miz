import { describe, expect, it } from "vitest";
import {
  PARTY_COLUMNS,
  PARTY_SCOPES,
  PARTY_SCOPES_DEF,
  canEditAccountingInScope,
  canSeeAccountingInScope,
  canViewParties,
  defaultRoleForScope,
  partiesSectionAbilities,
  partyMatchesScope,
  partyOwnerScopeForRole,
  partyScopeFor,
  partyScopeForApp,
  partyStatementKind,
  roleLabelInScope,
  showsColumn,
} from "./parties-scopes";
import { roleBasePermissions } from "./permissions";

/**
 * The per-app view of one shared record.
 *
 * These assertions are the contract the party screens are built on, so they
 * are written as the promise each app makes: who it lists, what it shows about the
 * ledger, and — most importantly — that every app writes through the *same* form
 * and endpoint. A scope that drifts (the store keeping a private supplier name,
 * an app inventing its own party table) is exactly the bug this file exists to
 * refuse.
 */

const byKey = new Map(PARTY_SCOPES_DEF.map((def) => [def.key, def]));
const crm = byKey.get("crm")!;
const accounting = byKey.get("accounting")!;
const operations = byKey.get("operations")!;
const team = byKey.get("team")!;
const growth = byKey.get("growth")!;
const sales = byKey.get("sales")!;

describe("the scope list", () => {
  it("defines exactly the scopes it names", () => {
    expect(PARTY_SCOPES_DEF.map((def) => def.key)).toEqual([...PARTY_SCOPES]);
  });

  it("gives every scope an owning app or shared utility, roles and a route", () => {
    for (const def of PARTY_SCOPES_DEF) {
      expect(def.app === null || ["accounting", "growth", "crm", "website"].includes(def.app)).toBe(true);
      expect(def.roles.length).toBeGreaterThan(0);
      expect(def.roles).toContain(def.defaultRole);
      // A real, public place — an app's own prefix (`/accounting/directory`,
      // `/crm/directory`), the platform's settings (`/settings/team`) or a
      // workspace page. The apps left `/dashboard/<app>` behind.
      expect(def.href.startsWith("/")).toBe(true);
      expect(def.label).toBeTruthy();
      // A list with no name column is not a list of parties.
      expect(def.columns).toContain("displayName");
      for (const column of def.columns) expect(PARTY_COLUMNS).toContain(column);
    }
  });

  it("falls back to the narrowest view for an unknown key", () => {
    expect(partyScopeFor("nope").key).toBe("crm");
    expect(partyScopeFor(null).key).toBe("crm");
    expect(partyScopeFor("accounting").key).toBe("accounting");
  });

  it("answers a lookup by app, including the apps that have no party view", () => {
    expect(partyScopeForApp("crm")?.key).toBe("crm");
    expect(partyScopeForApp("accounting")?.key).toBe("accounting");
    expect(partyScopeForApp("growth")?.key).toBe("growth");
    // The website app publishes posts; it has no business listing who the
    // business pays, and `null` is what stops a nav entry being invented for it.
    // (Every other app mounts a scope. The «اتصال‌های فنی» hub asks no such
    // question: it is not an app, so it is not an argument here at all.)
    expect(partyScopeForApp("website")).toBeNull();
  });
});

describe("who each app lists", () => {
  it("the CRM lists customers, the store lists suppliers, the team lists staff", () => {
    expect(crm.roles).toEqual(["Customer"]);
    expect(operations.roles).toEqual(["Supplier"]);
    expect(team.roles).toEqual(["Employee"]);
    expect(defaultRoleForScope(operations)).toBe("Supplier");
    expect(defaultRoleForScope(team)).toBe("Employee");
  });

  it("accounting is the one view that sees all three", () => {
    expect(accounting.roles).toEqual(["Customer", "Employee", "Supplier"]);
  });

  it("keeps the ledger columns on the one directory", () => {
    // A/R links used to open a customers-only screen of their own. They open
    // the canonical directory filtered to customers now, so the columns an
    // accountant needs have to live on it.
    expect(accounting.columns).toContain("accountingCode");
    expect(accounting.columns).toContain("balance");
  });

  it("accounting's persons directory lives at the app's own route", () => {
    // The Accounting app has its own top-level prefix now (`/accounting/…`);
    // its «اشخاص» section is its persons directory — managed there, never by
    // sending the accountant into the CRM's.
    expect(accounting.app).toBe("accounting");
    expect(accounting.href).toBe("/accounting/directory");
  });

  it("keeps one canonical Accounting directory alongside its work-area views", () => {
    // «مشتریان»، «تأمین‌کنندگان» and «فروشندگان» used to be three scopes of
    // their own, three routes over the same table and three sidebar rows. They
    // are `?view=` filters of the one directory now (`party-directory.ts`), so
    // there is one screen, one add/edit form and one place a deep link lands.
    const accountingScopes = PARTY_SCOPES_DEF.filter((def) => def.app === "accounting");
    expect(accountingScopes.map((def) => def.key)).toEqual(["accounting", "operations", "sales"]);
    expect(accountingScopes.filter((def) => def.key === "accounting")).toHaveLength(1);
  });

  it("filters a shared list to what the scope is about", () => {
    expect(partyMatchesScope(crm, "Customer")).toBe(true);
    expect(partyMatchesScope(crm, "Supplier")).toBe(false);
    expect(partyMatchesScope(accounting, "Supplier")).toBe(true);
    expect(partyMatchesScope(crm, null)).toBe(false);
    expect(partyMatchesScope(crm, undefined)).toBe(false);
  });
});

describe("the ledger's numbers, per app", () => {
  it("only Accounting edits them", () => {
    expect(canEditAccountingInScope(accounting)).toBe(true);
    expect(canEditAccountingInScope(crm)).toBe(false);
    expect(canEditAccountingInScope(operations)).toBe(false);
    expect(canEditAccountingInScope(growth)).toBe(false);
  });

  it("Growth and the till do not even see them", () => {
    expect(canSeeAccountingInScope(growth)).toBe(false);
    expect(canSeeAccountingInScope(sales)).toBe(false);
    expect(canSeeAccountingInScope(crm)).toBe(true);
    expect(canSeeAccountingInScope(operations)).toBe(true);
  });

  it("the columns agree with the rights they are drawn from", () => {
    // A scope that hides accounting must not list its column, and a read-only one
    // must not be the place a code is typed.
    for (const def of PARTY_SCOPES_DEF) {
      expect(showsColumn(def, "accountingCode")).toBe(def.accounting !== "hidden");
      if (def.accounting !== "editable") {
        expect(def.columns).not.toContain("tax");
      }
    }
  });

  it("the role column only appears where more than one role is listed", () => {
    expect(showsColumn(accounting, "role")).toBe(true);
    expect(showsColumn(crm, "role")).toBe(false);
    expect(roleLabelInScope(crm, "Customer")).toBeNull();
    expect(roleLabelInScope(accounting, "Customer")).toBeTruthy();
  });
});

describe("one owner per role", () => {
  it("links a read-only row to the app that owns it", () => {
    expect(partyOwnerScopeForRole("Customer").key).toBe("crm");
    expect(partyOwnerScopeForRole("Supplier").key).toBe("operations");
    expect(partyOwnerScopeForRole("Employee").key).toBe("team");
  });

  it("never routes an edit to a read-only view", () => {
    for (const def of PARTY_SCOPES_DEF) {
      if (!def.readOnly) continue;
      const target = partyOwnerScopeForRole(def.defaultRole);
      expect(target.readOnly).toBe(false);
      expect(target.key).not.toBe(def.key);
    }
  });
});

describe("what a member may do on a party screen", () => {
  it("answers from the role presets when the page could not read permissions", () => {
    // The preset answer mirrors permissions.ts: a cashier manages parties, a
    // waiter does not, and only the back-office roles read the ledger.
    expect(partiesSectionAbilities("cashier")).toEqual({
      canManage: true,
      canSeeLedger: false,
      canOpenStatement: false,
    });
    expect(partiesSectionAbilities("waiter")).toEqual({
      canManage: false,
      canSeeLedger: false,
      canOpenStatement: false,
    });
    expect(partiesSectionAbilities("accountant")).toEqual({
      canManage: true,
      canSeeLedger: true,
      canOpenStatement: true,
    });
  });

  it("answers from the effective permissions when the page supplied them", () => {
    // A cashier whose parties.manage was revoked sees a read-only list — the
    // button would only answer 403.
    expect(partiesSectionAbilities("cashier", ["orders.create"])).toEqual({
      canManage: false,
      canSeeLedger: false,
      canOpenStatement: false,
    });
    // A waiter who was granted it sees a button that works.
    expect(partiesSectionAbilities("waiter", ["menu.view", "parties.manage"])).toEqual({
      canManage: true,
      canSeeLedger: false,
      canOpenStatement: false,
    });
    // The money gate is ledger.view, not the role.
    expect(partiesSectionAbilities("cashier", ["parties.manage", "ledger.view"])).toEqual({
      canManage: true,
      canSeeLedger: true,
      canOpenStatement: false,
    });
  });

  it("treats an explicitly empty permission set as «no permissions», not «unknown»", () => {
    // A member revoked down to nothing must not silently fall back to their
    // preset — that is exactly the member whose buttons would 403.
    expect(partiesSectionAbilities("manager", [])).toEqual({
      canManage: false,
      canSeeLedger: false,
      canOpenStatement: false,
    });
  });

  it("offers the statement only to the roles its route actually admits", () => {
    /*
     * The two statement routes (`/api/ledger/ar/customers/:id`,
     * `/api/ledger/ap/suppliers/:id`) are gated by
     * `requireRole("owner", "manager", "accountant")` — a role check, not a
     * permission one. So `ledger.view` alone is not enough: a cashier granted
     * that permission could read balances in the list but the statement
     * overlay would open onto a 403. The button has to know the same rule the
     * route enforces.
     */
    expect(partiesSectionAbilities("cashier", ["parties.manage", "ledger.view"]).canSeeLedger).toBe(true);
    expect(partiesSectionAbilities("cashier", ["parties.manage", "ledger.view"]).canOpenStatement).toBe(false);

    for (const role of ["owner", "manager", "accountant"] as const) {
      expect(partiesSectionAbilities(role, ["ledger.view"]).canOpenStatement, role).toBe(true);
    }
    // And the permission is still required on top of the role: an accountant
    // whose ledger.view was revoked sees neither the balance nor the statement.
    expect(partiesSectionAbilities("accountant", ["parties.view"]).canOpenStatement).toBe(false);
  });

  it("agrees with the presets it falls back to", () => {
    // The fallback and permissions.ts must never drift: for every role, the
    // preset answer equals the answer computed from that role's base set.
    for (const role of ["owner", "manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      const preset = roleBasePermissions(role);
      expect(partiesSectionAbilities(role), role).toEqual(
        partiesSectionAbilities(role, preset),
      );
    }
  });
});

describe("who may see a party directory at all (issue #854 pass 4)", () => {
  it("answers from the member's effective permissions when they are known", () => {
    expect(canViewParties("manager", ["parties.view"])).toBe(true);
    // `parties.manage` alone is not the read: the API gate is `parties.view`.
    expect(canViewParties("manager", ["parties.manage"])).toBe(false);
    expect(canViewParties("manager", [])).toBe(false);
    // A role with no preset grant sees the directory once granted…
    expect(canViewParties("waiter", ["parties.view"])).toBe(true);
    // …and a preset role loses it once revoked — the team manager who holds
    // team access without `parties.view` is exactly the case the Team tab
    // hides the personnel file for.
    expect(canViewParties("manager", ["team.view", "team.manage"])).toBe(false);
  });

  it("falls back to the presets when permissions are unknown", () => {
    for (const role of ["owner", "manager", "accountant", "cashier"] as const) {
      expect(canViewParties(role), role).toBe(true);
    }
    for (const role of ["waiter", "kitchen"] as const) {
      expect(canViewParties(role), role).toBe(false);
    }
  });

  it("agrees with the presets it falls back to", () => {
    // Same drift guard as the abilities fallback: for every built-in role, the
    // preset answer equals the answer computed from that role's base set.
    for (const role of ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      const preset = roleBasePermissions(role);
      expect(canViewParties(role), role).toBe(canViewParties(role, preset));
    }
  });
});

describe("which statement a party has", () => {
  /*
   * A party's roles decide which ledger it lives in, and therefore which
   * statement overlay the row may open. The directory shows every role in one
   * list, so this had to become a function rather than an assumption baked
   * into the section that happened to be mounted: the CRM directory can list a
   * supplier (a customer who also supplies), and opening the AR statement for
   * somebody who only exists in AP shows an empty ledger rather than an error.
   */
  it("routes a customer to the receivable ledger and a supplier to the payable one", () => {
    expect(partyStatementKind(["Customer"])).toBe("ar");
    expect(partyStatementKind(["Supplier"])).toBe("ap");
  });

  it("prefers the receivable statement for somebody who is both", () => {
    // A party who buys and sells has two ledgers; the row offers one button,
    // and «Customer» is first in the product's own role order.
    expect(partyStatementKind(["Customer", "Supplier"])).toBe("ar");
    expect(partyStatementKind(["Supplier", "Customer"])).toBe("ar");
  });

  it("offers nothing for a party with no ledger of their own", () => {
    // Payroll is not the payables ledger: an employee has no AP statement, and
    // a row with no roles at all (a record mid-migration) must not guess.
    expect(partyStatementKind(["Employee"])).toBeNull();
    expect(partyStatementKind([])).toBeNull();
  });

  it("ignores a role it does not know", () => {
    // The roles arrive from an API response, so an unrecognised string is a
    // deployment-skew question, not a crash.
    expect(partyStatementKind(["Partner" as never])).toBeNull();
    expect(partyStatementKind(["Partner" as never, "Supplier"])).toBe("ap");
  });
});
