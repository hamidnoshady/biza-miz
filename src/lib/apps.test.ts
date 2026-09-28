import { describe, expect, it } from "vitest";
import {
  APPS,
  APP_KEYS,
  appForModule,
  appForKey,
  isAppKey,
  modulesForApp,
  resolveAccessibleAppLanding,
  canOpenApp,
  unassignedModules,
} from "./apps";
import { MODULE_KEYS } from "./industry-profile";
import { effectivePermissions, PERMISSIONS, roleBasePermissions } from "./permissions";

describe("appForModule", () => {
  it("groups loyalty, promotions and commission under Growth & Marketing", () => {
    // The headline of Wave 1: three separate sidebar entries become one app.
    expect(appForModule("loyalty")).toBe("growth");
    expect(appForModule("promotions")).toBe("growth");
    expect(appForModule("commission")).toBe("growth");
  });

  it("gives the customer record its own app and puts selling in Accounting", () => {
    // Phase 35 seated `crm` under Growth as a forward reference. Phase 36 built
    // it and moved it out, together with `customers`: the customer record is
    // read by every app (the POS creates it, Growth messages it, the service desk
    // argues with it), so it cannot live behind the door of the one department
    // that markets to them. One app owns the record; the rest read it.
    expect(appForModule("crm")).toBe("crm");
    expect(appForModule("customers")).toBe("crm");
    expect(appForModule("pos")).toBe("accounting");
    expect(appForModule("orders")).toBe("accounting");
  });

  it("keeps the still-unbuilt messaging key under Growth & Marketing", () => {
    // SMS/email acts *on* an audience rather than owning the customer record,
    // so it stays with the engines that will use it.
    expect(appForModule("messaging")).toBe("growth");
  });

  it("gives the website manager its own app, not a section of Growth", () => {
    // Originally seated under Growth (#378) as a forward reference; it is an
    // integration with an external system of record (eshobe-cms), not a
    // marketing engine, so it is a peer app instead.
    expect(appForModule("website")).toBe("website");
  });

  it("treats the assistant and the connections hub as not-apps", () => {
    // The assistant is the chat *home*, not an app in the rail — and the
    // «اتصال‌های فنی» hub is a technical utility of the shell, never listed
    // in the platform switchboard. Neither is a content area. (There is no
    // `workspace` module key at all: the shell needs no gateable module now
    // that it is the product's only shell.)
    expect(appForModule("ai")).toBeNull();
    expect(appForModule("connections")).toBeNull();
    expect(appForModule("settings")).toBeNull();
  });

  it("keeps every other module in exactly one app", () => {
    const assigned = MODULE_KEYS.filter((module) => appForModule(module) !== null);
    expect(assigned).not.toContain("ai");
    for (const module of assigned) {
      expect(APP_KEYS, module).toContain(appForModule(module));
    }
  });
});

describe("APPS registry integrity", () => {
  it("claims no module twice", () => {
    // Importing apps.ts already runs the map builder, which throws on a
    // duplicate; this is a belt-and-braces check the same module is never in
    // two apps.
    const seen = new Set<string>();
    for (const app of APPS) {
      for (const module of app.modules) {
        expect(seen.has(module), `module "${module}" claimed by two apps`).toBe(false);
        seen.add(module);
      }
    }
  });

  it("declares exactly the four standalone apps and resolves each to a def", () => {
    expect(APP_KEYS).toEqual(["accounting", "crm", "growth", "website"]);
    expect(APPS.map((app) => app.key)).toEqual([...APP_KEYS]);
    for (const key of APP_KEYS) {
      expect(appForKey(key).key).toBe(key);
    }
  });
});

describe("appForKey / modulesForApp", () => {
  it("returns the Growth & Marketing def with its modules", () => {
    const growth = appForKey("growth");
    expect(growth.label).toBe("رشد و بازاریابی");
    expect(modulesForApp("growth")).toEqual(
      expect.arrayContaining(["loyalty", "promotions", "commission", "messaging"]),
    );
    // The engines act on customers; they do not own the record. The website
    // manager is its own app now, not one of Growth's engines.
    expect(modulesForApp("growth")).not.toContain("crm");
    expect(modulesForApp("growth")).not.toContain("customers");
    expect(modulesForApp("growth")).not.toContain("website");
  });

  it("returns the one Website app owning both website managers", () => {
    // «مدیریت وب‌سایت» is one app with two managers — the Eshobe CMS site
    // builder and the WordPress/WooCommerce manager. Splitting them back into
    // two rail entries is the regression this pins.
    const website = appForKey("website");
    expect(website.label).toBe("مدیریت وب‌سایت");
    expect(modulesForApp("website")).toEqual(["website", "integrations"]);
  });

  it("returns the CRM app owning both the customer record and the CRM surfaces", () => {
    const crm = appForKey("crm");
    expect(crm.label).toBe("ارتباط با مشتری");
    expect(modulesForApp("crm")).toEqual(expect.arrayContaining(["crm", "customers"]));
  });

  it("puts selling and operations inside Accounting", () => {
    expect(modulesForApp("accounting")).toEqual(expect.arrayContaining([
      "dashboard", "orders", "pos", "inventory", "kitchen", "ledger", "reports",
    ]));
  });
});

describe("permission-driven app landing", () => {
  const route = (module: Parameters<typeof appForModule>[0], href: string) => ({ module, href });

  it("lands a food-service cashier on POS without granting ledger access", () => {
    const permissions = new Set(roleBasePermissions("cashier"));
    const nav = [
      route("orders", "/accounting/orders"),
      route("pos", "/accounting/pos"),
      route("tables", "/accounting/floor"),
    ];
    expect(canOpenApp("accounting", permissions)).toBe(true);
    expect(permissions.has(PERMISSIONS.ledgerView)).toBe(false);
    expect(resolveAccessibleAppLanding("accounting", nav)).toBe("/accounting/pos");
  });

  it("prefers the ledger overview for an accountant/manager when it is accessible", () => {
    const nav = [
      route("orders", "/accounting/orders"),
      route("ledger", "/accounting/overview"),
    ];
    expect(resolveAccessibleAppLanding("accounting", nav)).toBe("/accounting/overview");
  });

  it("is capability-driven for custom roles and honours revocations", () => {
    const custom = new Set<string>([PERMISSIONS.ordersView, PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake]);
    expect(canOpenApp("accounting", custom)).toBe(true);
    expect(custom.has(PERMISSIONS.ledgerView)).toBe(false);
    expect(resolveAccessibleAppLanding("accounting", [route("pos", "/accounting/pos")])).toBe("/accounting/pos");

    const revoked = effectivePermissions("cashier", { revoked: [PERMISSIONS.paymentsTake] });
    expect(revoked.has(PERMISSIONS.paymentsTake)).toBe(false);
    expect(resolveAccessibleAppLanding("accounting", [route("orders", "/accounting/orders")])).toBe("/accounting/orders");
  });

  it("does not invent an Accounting door for kitchen or unrelated routes", () => {
    expect(resolveAccessibleAppLanding("accounting", [])).toBeNull();
    expect(resolveAccessibleAppLanding("accounting", [route("customers", "/crm/overview")])).toBeNull();
  });
});

describe("isAppKey", () => {
  it("recognises exactly the declared keys", () => {
    expect(APP_KEYS.every((key) => isAppKey(key))).toBe(true);
    expect(isAppKey("loyalty")).toBe(false);
    // The connections hub is a shell utility, not a platform app: it must
    // never resolve as an app key or the switchboard would list it.
    expect(isAppKey("connections")).toBe(false);
    expect(isAppKey("sales")).toBe(false);
    expect(isAppKey("operations")).toBe(false);
    expect(isAppKey("settings")).toBe(false);
    expect(isAppKey(null)).toBe(false);
    expect(isAppKey(undefined)).toBe(false);
  });
});

describe("unassignedModules", () => {
  it("marks only the shell modules as intentionally not apps", () => {
    const unassigned = unassignedModules();
    expect(unassigned).toContain("ai");
    // The «اتصال‌های فنی» hub is a shell utility: its module stays
    // unassigned so the availability gate can never lock it.
    expect(unassigned).toContain("connections");
    expect(unassigned).toContain("settings");
    expect(unassigned).not.toContain("crm");
    expect(unassigned).not.toContain("loyalty");
  });
});
