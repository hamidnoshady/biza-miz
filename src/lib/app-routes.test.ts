/**
 * The canonical URL table and the legacy redirects.
 *
 * These are the rules the whole move rides on, and each of the cases below is
 * a bug that actually shipped: an app URL that 404'd because middleware
 * rewrote the pathname instead of serving a real route, a bare app prefix that
 * landed on nothing, a section path that had `/overview` appended to it until
 * `/crm/overview` became `/crm/overview/overview`, and deep links that lost
 * their query string on the way through.
 */
import { describe, expect, it } from "vitest";
import {
  APP_HOME_HREFS,
  APP_ROUTE_PREFIXES,
  APP_SETTINGS_HREFS,
  ACCOUNTING_WORKSPACE_HREFS,
  accountingProductsHref,
  DASHBOARD_HOME,
  PLATFORM_BILLING_HREF,
  PLATFORM_ROUTES,
  PLATFORM_SETTINGS_HOME,
  PLATFORM_SUBSCRIPTION_HREF,
  appPrefixForPathname,
  canonicalPathForLegacy,
  isCanonicalAppPathname,
  isPlatformSettingsPathname,
  isWorkspacePathname,
  legacyRedirectTarget,
} from "./app-routes";

describe("canonical routes", () => {
  it("gives every app a top-level prefix and an overview home", () => {
    for (const prefix of APP_ROUTE_PREFIXES) {
      // Top level: an app is not a folder of the dashboard any more.
      expect(prefix.startsWith("/dashboard")).toBe(false);
      expect(prefix.split("/")).toHaveLength(2);
      // …and its home is its overview page, not the bare prefix, so the app
      // front page has exactly one address.
      expect(APP_HOME_HREFS[prefix]).toBe(`${prefix}/overview`);
    }
  });

  it("recognizes My Workspace from its canonical root, not the retired projects alias", () => {
    expect(isWorkspacePathname("/workspace")).toBe(true);
    expect(isWorkspacePathname("/workspace/projects/42")).toBe(true);
    expect(isWorkspacePathname("/projects")).toBe(false);
    expect(isWorkspacePathname("/workspace-tools")).toBe(false);
  });

  it("gives every app its own settings route, never the platform's", () => {
    for (const prefix of APP_ROUTE_PREFIXES) {
      const href = APP_SETTINGS_HREFS[prefix];
      expect(href).toBe(`${prefix}/settings`);
      // The rule the whole settings split exists for: an app's settings page
      // is inside the app, and is never the platform settings page.
      expect(href).not.toBe(PLATFORM_SETTINGS_HOME);
      expect(isPlatformSettingsPathname(href)).toBe(false);
    }
  });

  it("keeps billing and subscription platform-owned", () => {
    // An app may *link* to these; it must never own a copy of them.
    expect(isPlatformSettingsPathname(PLATFORM_BILLING_HREF)).toBe(true);
    expect(isPlatformSettingsPathname(PLATFORM_SUBSCRIPTION_HREF)).toBe(true);
    expect(appPrefixForPathname(PLATFORM_BILLING_HREF)).toBeNull();
    expect(appPrefixForPathname(PLATFORM_SUBSCRIPTION_HREF)).toBeNull();
    expect(PLATFORM_ROUTES).toContain(PLATFORM_BILLING_HREF);
    expect(PLATFORM_ROUTES).toContain(PLATFORM_SUBSCRIPTION_HREF);
  });

  it("keeps every moved work area inside Accounting", () => {
    for (const href of Object.values(ACCOUNTING_WORKSPACE_HREFS)) {
      expect(href.startsWith("/accounting/")).toBe(true);
      expect(href.startsWith("/dashboard/")).toBe(false);
      expect(isCanonicalAppPathname(href)).toBe(true);
    }
    expect(accountingProductsHref("new")).toBe("/accounting/products/new");
  });

  it("leaves the workspace home where it is", () => {
    expect(DASHBOARD_HOME).toBe("/dashboard");
    expect(appPrefixForPathname(DASHBOARD_HOME)).toBeNull();
    expect(canonicalPathForLegacy(DASHBOARD_HOME)).toBeNull();
  });
});

describe("appPrefixForPathname", () => {
  it("matches whole segments, not string prefixes", () => {
    expect(appPrefixForPathname("/crm")).toBe("/crm");
    expect(appPrefixForPathname("/crm/persons/42")).toBe("/crm");
    expect(appPrefixForPathname("/growthlab")).toBeNull();
    expect(appPrefixForPathname("/accounting-extra")).toBeNull();
    expect(appPrefixForPathname("/login")).toBeNull();
  });
});

describe("legacy redirects", () => {
  it("sends a bare app prefix to that app's overview", () => {
    expect(canonicalPathForLegacy("/dashboard/accounting")).toBe("/accounting/overview");
    expect(canonicalPathForLegacy("/dashboard/growth")).toBe("/growth/overview");
    expect(canonicalPathForLegacy("/dashboard/crm")).toBe("/crm/overview");
    expect(canonicalPathForLegacy("/dashboard/website")).toBe("/websites/overview");
  });

  it("carries a section suffix through verbatim", () => {
    expect(canonicalPathForLegacy("/dashboard/crm/segments")).toBe("/crm/segments");
    expect(canonicalPathForLegacy("/dashboard/growth/gift-cards")).toBe("/growth/gift-cards");
    expect(canonicalPathForLegacy("/dashboard/accounting/entries")).toBe("/accounting/entries");
    // Nested paths and route params survive too — the CRM's customer file was
    // one of the URLs the rewrite table simply did not know about.
    expect(canonicalPathForLegacy("/dashboard/crm/persons/42")).toBe("/crm/persons/42");
    expect(canonicalPathForLegacy("/dashboard/website/wp/orders/7")).toBe("/websites/wp/orders/7");
  });

  it("never appends the home segment to a path that already names a section", () => {
    // The exact regression: `/crm/overview` must not become
    // `/crm/overview/overview`, and it must not be treated as legacy at all.
    expect(canonicalPathForLegacy("/crm/overview")).toBeNull();
    expect(canonicalPathForLegacy("/accounting/overview")).toBeNull();
    expect(canonicalPathForLegacy("/growth/overview")).toBeNull();
    expect(canonicalPathForLegacy("/websites/overview")).toBeNull();
    expect(canonicalPathForLegacy("/dashboard/crm/overview")).toBe("/crm/overview");
    // …and doing it twice is a fixed point, which is what stops a redirect loop.
    for (const home of Object.values(APP_HOME_HREFS)) {
      expect(legacyRedirectTarget(home)).toBeNull();
      expect(isCanonicalAppPathname(home)).toBe(true);
    }
  });

  it("moves every retired dashboard work area to Accounting, retaining nested paths and queries", () => {
    const moved: readonly (readonly [string, string])[] = [
      ["/dashboard/pos", ACCOUNTING_WORKSPACE_HREFS.pos],
      ["/dashboard/stock", ACCOUNTING_WORKSPACE_HREFS.inventory],
      ["/dashboard/inventory", ACCOUNTING_WORKSPACE_HREFS.inventory],
      ["/dashboard/products", ACCOUNTING_WORKSPACE_HREFS.products],
      ["/dashboard/products/new", accountingProductsHref("new")],
      ["/dashboard/products/prices", accountingProductsHref("prices")],
      ["/dashboard/products/attributes", accountingProductsHref("attributes")],
      ["/dashboard/cosmetics", ACCOUNTING_WORKSPACE_HREFS.cosmetics],
      ["/dashboard/reports", ACCOUNTING_WORKSPACE_HREFS.reports],
      ["/dashboard/floor", ACCOUNTING_WORKSPACE_HREFS.floor],
      ["/dashboard/kitchen", ACCOUNTING_WORKSPACE_HREFS.kitchen],
      ["/dashboard/reservations", ACCOUNTING_WORKSPACE_HREFS.reservations],
      ["/dashboard/delivery", ACCOUNTING_WORKSPACE_HREFS.delivery],
    ];
    for (const [legacy, canonical] of moved) {
      expect(canonicalPathForLegacy(legacy), legacy).toBe(canonical);
      expect(legacyRedirectTarget(legacy, "?tab=details"), legacy).toBe(`${canonical}?tab=details`);
    }
  });

  it("moves the platform's own pages into the settings area", () => {
    expect(canonicalPathForLegacy("/dashboard/settings")).toBe("/settings");
    expect(canonicalPathForLegacy("/dashboard/settings/team")).toBe("/settings/team");
    // Phase G — «پروژه‌ها» is a section of «میز کار من» now, so the two old
    // addresses both forward into it and keep their suffix.
    expect(canonicalPathForLegacy("/dashboard/projects")).toBe("/workspace/projects");
    expect(canonicalPathForLegacy("/projects")).toBe("/workspace/projects");
    expect(canonicalPathForLegacy("/projects/42")).toBe("/workspace/projects/42");
    expect(canonicalPathForLegacy("/dashboard/billing")).toBe(PLATFORM_BILLING_HREF);
    expect(canonicalPathForLegacy("/dashboard/connections")).toBe("/settings/connections");
    expect(canonicalPathForLegacy("/dashboard/connections/holoo")).toBe("/settings/connections/holoo");
  });

  it("leaves the workspace home and the non-dashboard routes alone", () => {
    for (const pathname of ["/dashboard", "/login", "/api/orders"]) {
      expect(canonicalPathForLegacy(pathname)).toBeNull();
      expect(legacyRedirectTarget(pathname)).toBeNull();
    }
  });

  it("moves the workspace's own pages to their top-level routes", () => {
    const moved: readonly (readonly [string, string])[] = [
      ["/dashboard/media", "/media"],
      ["/dashboard/knowledge", "/knowledge"],
      ["/dashboard/knowledge/a/pos-basics", "/knowledge/a/pos-basics"],
      ["/dashboard/support", "/support"],
      ["/dashboard/guides", "/knowledge"],
      ["/dashboard/help", "/knowledge"],
    ];
    for (const [legacy, canonical] of moved) {
      expect(canonicalPathForLegacy(legacy), legacy).toBe(canonical);
      // …and the new address is canonical: running it through the table again
      // is a no-op, which is what stops a redirect loop.
      expect(canonicalPathForLegacy(canonical), canonical).toBeNull();
      expect(isCanonicalAppPathname(canonical), canonical).toBe(true);
    }
  });

  it("resolves the retired dashboard and assistant addresses back onto /dashboard", () => {
    // The old quick-report dashboard and the second AI application are gone;
    // every one of their addresses lands on the chat home. Section suffixes
    // of the retired `/dashboard/ai` tree name the management panel's key
    // instead, and an unknown suffix falls back to the home rather than 404.
    const cases: readonly (readonly [string, string])[] = [
      ["/dashboard/overview", "/dashboard"],
      ["/dashboard/ai", "/dashboard"],
      ["/dashboard/ai/agents", "/dashboard?aiPanel=agents"],
      ["/dashboard/ai/coworkers", "/dashboard?aiPanel=coworkers"],
      ["/dashboard/ai/usage", "/dashboard?aiPanel=usage"],
      ["/dashboard/ai/not-a-section", "/dashboard"],
    ];
    for (const [legacy, canonical] of cases) {
      const [path, query] = canonical.split("?");
      const search = query ? `?${query}` : "";
      expect(legacyRedirectTarget(legacy, ""), legacy).toBe(`${path}${search}`);
      // The target is the workspace home itself — never re-routed, so no
      // redirect chain is possible.
      expect(canonicalPathForLegacy(path), canonical).toBeNull();
      expect(legacyRedirectTarget(canonical, ""), canonical).toBeNull();
      void search;
    }
  });

  it("keeps the assistant's deep-link params across the redirect", () => {
    expect(legacyRedirectTarget("/dashboard/ai", "?conversation=abc-123")).toBe(
      "/dashboard?conversation=abc-123",
    );
    expect(legacyRedirectTarget("/dashboard/overview", "?ctx=pos")).toBe("/dashboard?ctx=pos");
    expect(legacyRedirectTarget("/dashboard/ai/coworkers", "?project=p-1")).toBe(
      "/dashboard?aiPanel=coworkers&project=p-1",
    );
  });

  it("moves the second-wave work areas into Accounting", () => {
    const moved: readonly (readonly [string, string])[] = [
      ["/dashboard/orders", ACCOUNTING_WORKSPACE_HREFS.orders],
      ["/dashboard/orders/ord-7", `${ACCOUNTING_WORKSPACE_HREFS.orders}/ord-7`],
      ["/dashboard/waiter", ACCOUNTING_WORKSPACE_HREFS.waiter],
      ["/dashboard/jewelry", ACCOUNTING_WORKSPACE_HREFS.jewelry],
      ["/dashboard/watch", ACCOUNTING_WORKSPACE_HREFS.watch],
      ["/dashboard/accessories", ACCOUNTING_WORKSPACE_HREFS.products],
      ["/dashboard/wholesale", ACCOUNTING_WORKSPACE_HREFS.products],
      ["/dashboard/tools-fittings", ACCOUNTING_WORKSPACE_HREFS.products],
      ["/dashboard/haberdashery", ACCOUNTING_WORKSPACE_HREFS.products],
    ];
    for (const [legacy, canonical] of moved) {
      expect(canonicalPathForLegacy(legacy), legacy).toBe(canonical);
    }
  });

  it("moves the last flat pages into the apps and the settings area", () => {
    const moved: readonly (readonly [string, string])[] = [
      ["/dashboard/loyalty", "/growth/loyalty"],
      ["/dashboard/promotions", "/growth/campaigns"],
      ["/dashboard/commission", "/growth/commission"],
      ["/dashboard/customers", "/crm/directory"],
      ["/dashboard/persons", "/crm/directory"],
      ["/dashboard/menu", "/settings/menu"],
      ["/dashboard/team", "/settings/team"],
      ["/dashboard/backup", "/settings/backup"],
    ];
    for (const [legacy, canonical] of moved) {
      expect(canonicalPathForLegacy(legacy), legacy).toBe(canonical);
    }
    // The two branch pages carry the tab that names what they were.
    expect(legacyRedirectTarget("/dashboard/branches")).toBe(
      "/settings/branch-management?branchTab=branches",
    );
    expect(legacyRedirectTarget("/dashboard/locations")).toBe(
      "/settings/branch-management?branchTab=sync",
    );
    // The old integrations pages land on the connections hub; the visitor's
    // own query is kept alongside the target's tab.
    expect(legacyRedirectTarget("/dashboard/integrations")).toBe(
      "/settings/connections?tab=woocommerce",
    );
    expect(legacyRedirectTarget("/dashboard/integrations/holoo", "?connectionId=c1")).toBe(
      "/settings/connections/holoo?connectionId=c1",
    );
  });

  it("forwards the tabbed ledger address to the section each tab names now", () => {
    expect(legacyRedirectTarget("/dashboard/ledger")).toBe("/accounting/overview");
    expect(legacyRedirectTarget("/dashboard/ledger", "?tab=expenses")).toBe(
      "/accounting/expenses",
    );
    expect(legacyRedirectTarget("/dashboard/ledger", "?tab=ar")).toBe(
      "/accounting/receivables",
    );
    expect(legacyRedirectTarget("/dashboard/ledger", "?tab=parties")).toBe(
      "/accounting/directory",
    );
    // The per-role tabs carry which list was asked for; `?party=` survives.
    expect(legacyRedirectTarget("/dashboard/ledger", "?tab=suppliers&party=42")).toBe(
      "/accounting/directory?view=suppliers&party=42",
    );
    // An unknown tab is the app's home — never a dead end.
    expect(legacyRedirectTarget("/dashboard/ledger", "?tab=nonsense")).toBe(
      "/accounting/overview",
    );
  });

  it("splits the old WordPress manager between the website app and the hub", () => {
    expect(legacyRedirectTarget("/dashboard/wp")).toBe("/websites/wp");
    expect(legacyRedirectTarget("/dashboard/wp/orders")).toBe("/websites/wp/orders");
    expect(legacyRedirectTarget("/dashboard/wp/connections")).toBe(
      "/settings/connections?tab=woocommerce",
    );
    // An unknown section lands on the manager's front page, not a 404.
    expect(legacyRedirectTarget("/dashboard/wp/retired-section")).toBe("/websites/wp");
  });

  it("matches whole segments, so a lookalike route is not redirected", () => {
    expect(canonicalPathForLegacy("/dashboard/crmx")).toBeNull();
    expect(canonicalPathForLegacy("/dashboard/settings-export")).toBeNull();
  });
});

describe("legacyRedirectTarget", () => {
  it("preserves the query string of a deep link", () => {
    expect(legacyRedirectTarget("/dashboard/crm/persons", "?party=42")).toBe("/crm/persons?party=42");
    expect(legacyRedirectTarget("/dashboard/accounting", "?tab=entries")).toBe(
      "/accounting/overview?tab=entries",
    );
    expect(legacyRedirectTarget("/dashboard/settings", "?tab=team")).toBe("/settings?tab=team");
    // Several params, and one carrying an encoded value.
    expect(legacyRedirectTarget("/dashboard/growth/campaigns", "?from=1404-01-01&q=%DA%A9")).toBe(
      "/growth/campaigns?from=1404-01-01&q=%DA%A9",
    );
  });

  it("adds nothing when there is no query string", () => {
    expect(legacyRedirectTarget("/dashboard/crm/segments")).toBe("/crm/segments");
    expect(legacyRedirectTarget("/dashboard/crm/segments", "")).toBe("/crm/segments");
  });

  it("forwards retired CMS grouped sections to their split routes", () => {
    expect(legacyRedirectTarget("/websites/cms/content")).toBe("/websites/cms/pages");
    expect(legacyRedirectTarget("/websites/cms/store")).toBe("/websites/cms/products");
  });
});

describe("isCanonicalAppPathname", () => {
  it("knows the app prefixes, platform settings and the workspace module", () => {
    expect(isCanonicalAppPathname("/accounting/expenses")).toBe(true);
    expect(isCanonicalAppPathname("/websites/cms/pages")).toBe(true);
    expect(isCanonicalAppPathname("/websites/cms/content")).toBe(false);
    expect(isCanonicalAppPathname("/settings")).toBe(true);
    expect(isCanonicalAppPathname("/settings/billing")).toBe(true);
    expect(isCanonicalAppPathname("/workspace")).toBe(true);
    expect(isCanonicalAppPathname("/workspace/projects/42")).toBe(true);
    // The pre-Phase-G address is legacy now — it redirects, so claiming it as
    // canonical would make the redirect unreachable.
    expect(isCanonicalAppPathname("/projects")).toBe(false);
  });

  it("does not claim the workspace's own routes", () => {
    expect(isCanonicalAppPathname("/dashboard")).toBe(false);
    expect(isCanonicalAppPathname("/dashboard/orders")).toBe(false);
    expect(isCanonicalAppPathname("/login")).toBe(false);
  });
});
