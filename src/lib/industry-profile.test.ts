import { describe, expect, it } from "vitest";
import { isServiceInvoiceIndustry, SERVICE_INVOICE_INDUSTRIES } from "./service-invoice";
import { APPS, APP_KEYS } from "./apps";
import { ENABLED_INDUSTRIES, INDUSTRIES, INDUSTRY_LABELS, isIndustry, type Industry } from "./industries";
import {
  defaultGoldMakingChargePercent,
  defaultGoldProfitPercent,
  hasModule,
  industryProfile,
  labelFor,
  moduleForApiPath,
  moduleForPagePath,
  hasCapability,
  INDUSTRY_PROFILES,
  MODULE_KEYS,
  PAGE_MODULE_PREFIXES,
  CAPABILITY_KEYS,
  type LabelKey,
  type ModuleKey,
} from "./industry-profile";

const LABEL_KEYS: LabelKey[] = [
  "saleDocument",
  "saleDocumentPlural",
  "sellScreen",
  "catalogue",
  "catalogueItem",
];

const RETAIL_INDUSTRIES: Industry[] = [
  "jewelry",
  "watch",
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
  "automotive",
];

describe("INDUSTRY_PROFILES", () => {
  it("covers every industry the app can create", () => {
    for (const industry of INDUSTRIES) {
      expect(INDUSTRY_PROFILES[industry], industry).toBeDefined();
    }
  });

  it("names only modules that exist", () => {
    for (const industry of INDUSTRIES) {
      for (const module of industryProfile(industry).modules) {
        expect(MODULE_KEYS, `${industry}/${module}`).toContain(module);
      }
    }
  });

  it("lists no module twice", () => {
    for (const industry of INDUSTRIES) {
      const modules = industryProfile(industry).modules;
      expect(new Set(modules).size, industry).toBe(modules.length);
    }
  });

  it("gives every industry a brand of its own, never the café's", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(industryProfile(industry).brandTitle, industry).not.toBe("کافه و رستوران");
    }
  });
});

describe("module sets", () => {
  it("gives food_service everything the app has today", () => {
    // The regression that matters most: Wave 2 must not remove anything from
    // the café, which is the only industry that was ever complete.
    const modules = industryProfile("food_service").modules;
    for (const module of MODULE_KEYS) {
      // Retail-only: the four industry pages, and `stock` (F&B's equivalent is `inventory`).
      if (
        module === "jewelry" ||
        module === "watch" ||
        module === "accessories" ||
        module === "cosmetics" ||
        module === "wholesale" ||
        module === "tools_fittings" ||
        module === "haberdashery" ||
        module === "automotive" ||
        module === "stock"
      )
        continue;
      // `website` and `messaging` are core but deliberately not in the
      // original F&B baseline this loop pins.
      if (module === "website" || module === "messaging") continue;
      expect(modules, module).toContain(module);
    }
  });

  it("gives no retail industry the F&B-only modules", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      for (const module of ["tables", "waiter", "kitchen", "reservations", "delivery", "inventory", "menu"] as ModuleKey[]) {
        expect(hasModule(industry, module), `${industry}/${module}`).toBe(false);
      }
    }
  });

  it("gives each retail industry exactly its own industry page", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(hasModule(industry, industry as ModuleKey), industry).toBe(true);
      for (const other of RETAIL_INDUSTRIES) {
        if (other === industry) continue;
        expect(hasModule(industry, other as ModuleKey), `${industry} sees ${other}`).toBe(false);
      }
    }
    // F&B has none of the retail industry pages.
    for (const other of RETAIL_INDUSTRIES) {
      expect(hasModule("food_service", other as ModuleKey), `food_service sees ${other}`).toBe(false);
    }
  });

  it("gives every industry the core platform", () => {
    for (const industry of INDUSTRIES) {
      for (const module of ["dashboard", "customers", "ledger", "reports", "settings"] as ModuleKey[]) {
        expect(hasModule(industry, module), `${industry}/${module}`).toBe(true);
      }
    }
  });

  it("gives every trade a selling screen — a counter for goods, an invoice for services", () => {
    // Every trade sells from `/accounting/pos`; the profile's `salesModel`
    // picks the workflow. The three service trades — `service_saas`, issue
    // #799's AEC trade and issue #1128's advertising agency — carry `pos` only
    // as the address of the invoice screen: their lines are described services
    // (`service-invoice.ts`), and they get none of the stock modules the counter
    // trades have.
    for (const industry of INDUSTRIES) {
      expect(hasModule(industry, "pos"), industry).toBe(true);
    }
    for (const industry of SERVICE_INVOICE_INDUSTRIES) {
      expect(industryProfile(industry).salesModel, industry).toBe("retail_invoice");
      expect(hasModule(industry, "stock"), industry).toBe(false);
    }
  });

  it("gives no non-F&B industry a restaurant module", () => {
    // Issue #799's "no restaurant-specific module leaks into the AEC tenant"
    // rule, stated for every trade at once: these modules exist because a café
    // has tables, a kitchen and a menu, and no other business type inherits
    // them. A future industry that genuinely needs one adds itself here with a
    // note, rather than getting it by accident.
    const RESTAURANT_MODULES: ModuleKey[] = [
      "tables", "waiter", "kitchen", "reservations", "delivery", "inventory", "menu", "orders",
    ];
    for (const industry of INDUSTRIES.filter((value) => value !== "food_service")) {
      for (const module of RESTAURANT_MODULES) {
        expect(hasModule(industry, module), `${industry}/${module}`).toBe(false);
      }
    }
  });

  it("keeps the open-orders board to F&B", () => {
    // /dashboard/orders is a board of open tickets with kitchen statuses and a
    // realtime feed. A retail invoice is settled the moment it is written, so
    // it would never appear there; the shop's history lives on its selling
    // screen instead. AEC is further still from it — no tickets at all.
    expect(hasModule("food_service", "orders")).toBe(true);
    for (const industry of INDUSTRIES.filter((value) => value !== "food_service")) {
      expect(hasModule(industry, "orders"), industry).toBe(false);
    }
  });
});

describe("architecture_construction (issue #799)", () => {
  const AEC = industryProfile("architecture_construction");

  it("brands itself as the AEC trade and not as a café or a shop", () => {
    expect(AEC.brandTitle).toBe("عمران، معماری و پیمانکاری");
    expect(AEC.brandSubtitle).not.toContain("کافه");
    expect(AEC.brandTitle).not.toBe(industryProfile("food_service").brandTitle);
  });

  it("gets the core platform plus the invoice screen — no café, no retail stock", () => {
    const forbidden: ModuleKey[] = [
      "orders", "tables", "waiter", "kitchen", "reservations", "delivery",
      "inventory", "menu", "stock", "jewelry", "watch", "accessories", "cosmetics",
      "wholesale", "tools_fittings", "haberdashery",
    ];
    for (const module of forbidden) {
      expect(hasModule("architecture_construction", module), module).toBe(false);
    }
    // The operational centre (projects, tasks, documents) has no module key of
    // its own — see the MODULE_KEYS note in industry-profile.ts — so the trade
    // reaches My Workspace through the shell, exactly like every other trade.
    for (const module of ["dashboard", "customers", "crm", "ledger", "reports", "media", "ai", "settings", "pos"] as ModuleKey[]) {
      expect(hasModule("architecture_construction", module), module).toBe(true);
    }
  });

  it("calls its commercial document a صورتحساب, never a فاکتور or a سفارش", () => {
    expect(labelFor("architecture_construction", "saleDocument")).toBe("صورتحساب");
    expect(labelFor("architecture_construction", "saleDocumentPlural")).toBe("صورتحساب‌ها");
    for (const key of LABEL_KEYS) {
      expect(labelFor("architecture_construction", key), key).not.toContain("منو");
      expect(labelFor("architecture_construction", key), key).not.toContain("سفارش");
    }
  });

  it("seeds the restaurant-shaped features off at provision time", () => {
    expect(AEC.defaultDisabledFeatures).toEqual(
      expect.arrayContaining(["inventory", "reservations", "delivery"]),
    );
    expect(AEC.capabilities).toEqual([]);
    expect(AEC.salesModel).toBe("retail_invoice");
  });

  it("is registered everywhere the app offers an industry", () => {
    expect(ENABLED_INDUSTRIES).toContain("architecture_construction");
    expect(INDUSTRY_LABELS.architecture_construction).toBe("مهندسی عمران، معماری و پیمانکاری");
    expect(isIndustry("architecture_construction")).toBe(true);
  });
});

describe("advertising_agency (issue #1128)", () => {
  const AGENCY = industryProfile("advertising_agency");

  it("brands itself as the agency trade, not as a café, a shop or a contractor", () => {
    expect(AGENCY.brandTitle).toBe("آژانس تبلیغاتی");
    expect(AGENCY.brandSubtitle.trim().length).toBeGreaterThan(0);
    expect(AGENCY.brandSubtitle).not.toContain("کافه");
    for (const other of ["food_service", "service_saas", "architecture_construction", "jewelry"] as const) {
      expect(AGENCY.brandTitle, other).not.toBe(industryProfile(other).brandTitle);
    }
  });

  it("gets the core platform plus the invoice screen — no café, no till, no goods catalogue", () => {
    const forbidden: ModuleKey[] = [
      "orders", "tables", "waiter", "kitchen", "reservations", "delivery",
      "inventory", "menu", "stock", "jewelry", "watch", "accessories", "cosmetics",
      "wholesale", "tools_fittings", "haberdashery", "automotive",
    ];
    for (const module of forbidden) {
      expect(hasModule("advertising_agency", module), module).toBe(false);
    }
    // What it does get is the four apps' work areas: Accounting's ledger,
    // dashboard and reports; CRM's customer record; Growth's campaign engines;
    // the website manager; plus the media library for deliverables and the
    // assistant. Nothing here is a new module for the trade.
    for (const module of [
      "dashboard", "customers", "crm", "loyalty", "promotions", "commission",
      "messaging", "website", "integrations", "ledger", "reports", "media", "ai", "settings",
    ] as ModuleKey[]) {
      expect(hasModule("advertising_agency", module), module).toBe(true);
    }
    // `pos` is here because it is *the address of the invoice screen*
    // (`/accounting/pos` in invoice mode, `/api/sales`) — the same reason
    // `service_saas` and issue #799's contracting trade have it, and the same
    // reason the Accounting sidebar of all three gains a sales group. Without it
    // the trade could not bill a client at all, and §D's estimates, milestones
    // and retainers would have no document to be. What it must never bring with
    // it is the counter around that address: no orders board, no till, no stock
    // and no line kind that names a shelf — the agency's lines are described
    // services (`service-invoice.ts`).
    expect(hasModule("advertising_agency", "pos")).toBe(true);
    expect(isServiceInvoiceIndustry("advertising_agency")).toBe(true);
    expect(AGENCY.modules.filter((module) => ["orders", "stock", "menu", "inventory"].includes(module))).toEqual([]);
  });

  it("reaches all four tenant apps, and My Workspace through no module of its own", () => {
    // The issue's "preserve exactly four tenant apps" line, made executable:
    // the profile's module set opens every app the platform has and adds no
    // fifth, because there is no fifth to add.
    const reachable = APPS.filter((app) =>
      app.modules.some((module) => AGENCY.modules.includes(module)),
    ).map((app) => app.key);
    expect([...reachable].sort()).toEqual([...APP_KEYS].sort());
    // My Workspace stays a conditional work area: no module key exists for it,
    // so nav visibility can never be mistaken for the eligibility, service
    // state, permission and project-membership checks #1110 owns.
    expect(MODULE_KEYS as readonly string[]).not.toContain("workspace");
    expect(MODULE_KEYS as readonly string[]).not.toContain("projects");
  });

  it("calls its document a صورتحساب and its catalogue خدمات, never a منو, a سفارش or a کالا", () => {
    expect(labelFor("advertising_agency", "saleDocument")).toBe("صورتحساب");
    expect(labelFor("advertising_agency", "saleDocumentPlural")).toBe("صورتحساب‌ها");
    expect(labelFor("advertising_agency", "catalogue")).toBe("خدمات و بسته‌های تبلیغاتی");
    for (const key of LABEL_KEYS) {
      const label = labelFor("advertising_agency", key);
      expect(label, key).not.toContain("منو");
      expect(label, key).not.toContain("سفارش");
      expect(label, key).not.toContain("کالا");
    }
  });

  it("seeds the restaurant-shaped features off and claims no goods capability", () => {
    expect(AGENCY.defaultDisabledFeatures).toEqual(
      expect.arrayContaining(["inventory", "reservations", "delivery"]),
    );
    // No barcode, no batch expiry, no repairs: all three are goods-catalogue
    // capabilities and the trade has no catalogue.
    expect(AGENCY.capabilities).toEqual([]);
    expect(AGENCY.salesModel).toBe("retail_invoice");
    // No retail pricing defaults either — there is no gold line to price.
    expect(AGENCY.retailDefaults).toBeUndefined();
  });

  it("is registered everywhere the app offers an industry", () => {
    expect(ENABLED_INDUSTRIES).toContain("advertising_agency");
    expect(INDUSTRY_LABELS.advertising_agency).toBe("آژانس تبلیغاتی");
    expect(isIndustry("advertising_agency")).toBe(true);
    expect(isIndustry("advertising-agency")).toBe(false);
    expect(isIndustry("agency")).toBe(false);
  });
});

describe("labelFor", () => {
  it("resolves every label for every industry", () => {
    for (const industry of INDUSTRIES) {
      for (const key of LABEL_KEYS) {
        expect(labelFor(industry, key), `${industry}/${key}`).toBeTruthy();
      }
    }
  });

  it("falls back to the F&B word when an industry has no opinion", () => {
    // food_service overrides nothing, so it is the fallback by construction.
    expect(industryProfile("food_service").labels).toEqual({});
    expect(labelFor("food_service", "saleDocument")).toBe("سفارش");
    expect(labelFor("food_service", "catalogue")).toBe("منو");
  });

  it("calls a retail sale a فاکتور, not a سفارش", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(labelFor(industry, "saleDocument"), industry).toBe("فاکتور");
      expect(labelFor(industry, "saleDocumentPlural"), industry).toBe("فاکتورها");
    }
  });

  it("never shows a retail business menu wording", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      for (const key of LABEL_KEYS) {
        expect(labelFor(industry, key), `${industry}/${key}`).not.toContain("منو");
      }
    }
  });
});

describe("capabilities", () => {
  it("names only declared capabilities", () => {
    for (const industry of INDUSTRIES) {
      for (const capability of industryProfile(industry).capabilities) {
        expect(CAPABILITY_KEYS, `${industry}/${capability}`).toContain(capability);
      }
    }
  });

  it("hasCapability reflects the profile", () => {
    for (const industry of INDUSTRIES) {
      for (const capability of CAPABILITY_KEYS) {
        expect(hasCapability(industry, capability), `${industry}/${capability}`).toBe(
          industryProfile(industry).capabilities.includes(capability),
        );
      }
    }
  });
});

describe("salesModel", () => {
  it("keeps F&B on order tickets and puts retail on invoices", () => {
    expect(industryProfile("food_service").salesModel).toBe("order_ticket");
    for (const industry of RETAIL_INDUSTRIES) {
      expect(industryProfile(industry).salesModel, industry).toBe("retail_invoice");
    }
  });
});

describe("defaultDisabledFeatures", () => {
  it("turns nothing off for food_service", () => {
    expect(industryProfile("food_service").defaultDisabledFeatures).toEqual([]);
  });

  it("turns off the F&B-shaped features for retail", () => {
    for (const industry of RETAIL_INDUSTRIES) {
      expect(industryProfile(industry).defaultDisabledFeatures, industry).toContain("inventory");
      expect(industryProfile(industry).defaultDisabledFeatures, industry).toContain("reservations");
    }
  });
});

describe("Phase 35 module keys", () => {
  it("gives every trade messaging, now that /growth/messaging is a real section (issue #764)", () => {
    // It used to be a forward reference no trade had, so the page fell through
    // to the `loyalty` module and /api/messaging answered no module at all:
    // a Growth «در حال تعمیر» badged the page and left the sends' API open.
    for (const industry of INDUSTRIES) {
      expect(hasModule(industry, "messaging"), `${industry} should have messaging`).toBe(true);
    }
  });

  it("gives every trade the CRM, now that Phase 36 has built it", () => {
    // The CRM is core, like `customers`: it is built on records every profile
    // already has, and a jeweller keeps a customer file exactly as a café does.
    // A trade that lost this key would 403 on every /api/crm route.
    for (const industry of INDUSTRIES) {
      expect(hasModule(industry, "crm"), `${industry} should have crm`).toBe(true);
    }
  });

  it("gives every trade the website manager, now that it is its own app", () => {
    // Every trade wants a web presence — a jeweller's storefront as much as a
    // café's menu site — and the module gates the one CMS connection this app
    // holds (src/lib/apps.ts's "website" app), not a trade-specific screen.
    // A trade that lost this key would 403 on every /api/cms/website route.
    for (const industry of INDUSTRIES) {
      expect(hasModule(industry, "website"), `${industry} should have website`).toBe(true);
    }
  });
});

describe("moduleForApiPath", () => {
  it("directly gates online-platform settings by the F&B delivery module", () => {
    const module = moduleForApiPath("/api/settings/online-platforms");
    expect(module).toBe("delivery");
    expect(module && hasModule("food_service", module)).toBe(true);
    expect(module && hasModule("jewelry", module)).toBe(false);
  });

  it("maps a route and everything under it", () => {
    expect(moduleForApiPath("/api/tables")).toBe("tables");
    expect(moduleForApiPath("/api/tables/abc/close")).toBe("tables");
    expect(moduleForApiPath("/api/menu/items")).toBe("menu");
    expect(moduleForApiPath("/api/inventory/counts")).toBe("inventory");
    expect(
      moduleForApiPath("/api/accounting/shareholders/distributions"),
    ).toBe("ledger");
    expect(moduleForApiPath("/api/integrations/wp-manager/overview")).toBe("integrations");
  });

  it("keeps buying and renewing a domain in the website app, and the credential in the hub", () => {
    // `/api/cms/website/domain` (the site-domain change) is the connections
    // hub's; everything under it that spends money or reads the registrar is
    // the website manager's, so it must be listed above the shorter prefix.
    expect(moduleForApiPath("/api/cms/website/domain")).toBe("connections");
    expect(moduleForApiPath("/api/cms/website/domain/quote")).toBe("website");
    expect(moduleForApiPath("/api/cms/website/domain/order")).toBe("website");
    expect(moduleForApiPath("/api/cms/website/domain/registrar")).toBe("website");
    expect(moduleForApiPath("/api/cms/website/products/abc/publish")).toBe("website");
  });

  it("does not match a prefix that is only a string prefix", () => {
    // "/api/ordersomething" is not under "/api/orders".
    expect(moduleForApiPath("/api/ordersomething")).toBeNull();
  });

  it("leaves cross-industry routes ungated", () => {
    for (const path of ["/api/auth/login", "/api/customers", "/api/locations/active"]) {
      expect(moduleForApiPath(path), path).toBeNull();
    }
  });

  it("attributes the app-owned APIs to their modules, so a به‌زودی blocks the API with the page", () => {
    // The consistency rule: the module a nav entry is badged by must be the
    // module its API answers under — otherwise an app «به‌زودی» blocks the
    // pages while the APIs keep answering.
    expect(moduleForApiPath("/api/ledger/entries")).toBe("ledger");
    expect(moduleForApiPath("/api/reports/sales")).toBe("reports");
    expect(moduleForApiPath("/api/settings/pricing")).toBe("menu");
    expect(moduleForApiPath("/api/settings/online-platforms")).toBe("delivery");
    expect(moduleForApiPath("/api/settings/online-platforms/snapfood")).toBe("delivery");
    expect(hasModule("food_service", "delivery")).toBe(true);
    expect(hasModule("jewelry", "delivery")).toBe(false);
    expect(moduleForApiPath("/api/settings/business")).toBe("settings");
    expect(moduleForApiPath("/api/dashboard/overview")).toBe("dashboard");
    expect(moduleForApiPath("/api/waiter/board")).toBe("waiter");
    expect(moduleForApiPath("/api/sales/invoices")).toBe("pos");
  });

  it("attributes the industry routes to their modules on top of their stricter guard", () => {
    // requireIndustryForApi still checks these against the exact industry in
    // the handler; the module row is what lets an operations «به‌زودی» refuse
    // them the way it refuses their pages.
    expect(moduleForApiPath("/api/jewelry/items")).toBe("jewelry");
    expect(moduleForApiPath("/api/watch/units")).toBe("watch");
    expect(moduleForApiPath("/api/accessories/items")).toBe("accessories");
  });
});

describe("moduleForPagePath", () => {
  it("maps a page and its children", () => {
    expect(moduleForPagePath("/accounting/floor")).toBe("tables");
    expect(moduleForPagePath("/accounting/orders/abc")).toBe("orders");
    expect(moduleForPagePath("/websites/wp/connections")).toBe("integrations");
    expect(moduleForPagePath("/settings/connections")).toBe("connections");
  });

  it("leaves the dashboard root ungated and attributes settings to its module", () => {
    expect(moduleForPagePath("/dashboard")).toBeNull();
    // The settings family belongs to the settings app — a settings «به‌زودی»
    // must block these pages rather than let them through unbadged.
    expect(moduleForPagePath("/settings")).toBe("settings");
    expect(moduleForPagePath("/settings/team")).toBe("settings");
  });

  it("names only modules that exist", () => {
    for (const [, module] of PAGE_MODULE_PREFIXES) {
      expect(MODULE_KEYS).toContain(module);
    }
  });
});

describe("retail POS pricing defaults — one place, not hardcoded in the screen", () => {
  it("gives jewelry its configured اجرت/سود defaults, not a literal in the POS component", () => {
    expect(defaultGoldMakingChargePercent("jewelry")).toBe(
      INDUSTRY_PROFILES.jewelry.retailDefaults?.goldMakingChargePercent,
    );
    expect(defaultGoldProfitPercent("jewelry")).toBe(INDUSTRY_PROFILES.jewelry.retailDefaults?.goldProfitPercent);
  });

  it("falls back to 7%/7% gold defaults for an industry with no retailDefaults opinion", () => {
    const noOpinion = Object.entries(INDUSTRY_PROFILES).find(([, p]) => !p.retailDefaults)?.[0] as
      | Industry
      | undefined;
    if (!noOpinion) return; // every industry has opted in — nothing to assert
    expect(defaultGoldMakingChargePercent(noOpinion)).toBe(7);
    expect(defaultGoldProfitPercent(noOpinion)).toBe(7);
  });

  it("assumes no VAT rate per trade — VAT is the business's own setting (audit F05)", () => {
    for (const industry of INDUSTRIES) {
      expect(INDUSTRY_PROFILES[industry].retailDefaults ?? {}).not.toHaveProperty("vatPercent");
    }
  });
});
