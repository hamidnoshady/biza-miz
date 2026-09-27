/**
 * The end-to-end walk through the product's public URLs, as far as a test
 * without a browser can take it.
 *
 * It pairs with two neighbours rather than duplicating them:
 *
 *  - `route-tree.test.ts` proves each promised URL *resolves to a page file*,
 *    so it cannot 404;
 *  - `src/lib/platform-user-menu.test.ts` proves what the sidebar's drop-up
 *    contains and where each entry goes.
 *
 * What is left — and what this file does — is to run the **real middleware**
 * over the same list of URLs and check the answer a browser would actually
 * get: signed out, every one of them sends you to the login page carrying
 * where you were going; signed in, every one of them is served rather than
 * bounced; and every legacy address permanently redirects to its canonical
 * replacement with its query string intact. That is the login → dashboard →
 * each app overview → /workspace → /settings → each app's settings → the menu's
 * destinations → logout journey, expressed as status codes.
 *
 * The database-backed integration suite (`npm run test:db`) needs Postgres and
 * so cannot run everywhere; middleware is Edge code with no database access by
 * construction, which is exactly why the auth boundary can be tested here.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { middleware } from "@/middleware";
import { signSession, type SessionPayload } from "@/lib/auth-edge";
import {
  AI_PANEL_PARAM,
  AI_PANEL_SECTION_KEYS,
  aiPanelHref,
} from "@/lib/ai-panel";
import {
  APP_HOME_HREFS,
  APP_ROUTE_PREFIXES,
  APP_SETTINGS_HREFS,
  ACCOUNTING_WORKSPACE_HREFS,
  accountingProductsHref,
  DASHBOARD_HOME,
  PLATFORM_BILLING_HREF,
  PLATFORM_SETTINGS_HOME,
  PLATFORM_SUBSCRIPTION_HREF,
  WORKSPACE_MODULE_HOME,
  workspaceSectionHref,
} from "@/lib/app-routes";
import { WORKSPACE_SECTIONS } from "@/lib/workspace-shared";
import { platformUserMenuItems } from "@/lib/platform-user-menu";
import { PLATFORM_SETTINGS_PAGES, settingsTabHref } from "@/lib/settings-routes";
import { SETTINGS_TAB_KEYS } from "@/lib/settings-tabs";
import {
  ACCOUNTING_SECTION_KEYS,
  accountingSectionHref,
} from "./(app)/accounting/accounting-routes";
import { CRM_SECTION_KEYS, crmSectionHref } from "./(app)/crm/crm-routes";
import { GROWTH_SECTION_KEYS, growthSectionHref } from "./(app)/growth/growth-routes";
import {
  CMS_SECTION_KEYS,
  cmsSectionHref,
  wpSectionHref,
} from "./(app)/websites/website-routes";
import { WP_SECTION_KEYS } from "./(app)/websites/wp/wp-routes";

const ORIGIN = "http://localhost:3000";

const OWNER: SessionPayload = {
  sub: "user-1",
  role: "owner",
  businessId: "biz-1",
  locationId: null,
  fullName: "مالک",
};

let ownerCookie = "";

beforeAll(async () => {
  ownerCookie = await signSession(OWNER);
});

function request(
  pathname: string,
  { authed }: { authed: boolean },
): NextRequest {
  const req = new NextRequest(new URL(pathname, ORIGIN), { method: "GET" });
  if (authed) req.cookies.set("pos_session", ownerCookie);
  return req;
}

/** Status + Location, the two things a browser acts on. */
async function visit(pathname: string, options: { authed: boolean }) {
  const response = await middleware(request(pathname, options));
  const location = response.headers.get("location");
  return {
    status: response.status,
    location: location ? new URL(location, ORIGIN) : null,
  };
}

/**
 * `NextResponse.next()` carries this header. It is how "middleware let the
 * request through to the route" is told apart from "middleware answered it" —
 * both are status 200.
 */
async function isServed(pathname: string): Promise<boolean> {
  const response = await middleware(request(pathname, { authed: true }));
  return (
    response.status === 200 && response.headers.get("x-middleware-next") === "1"
  );
}

/** Every URL the product promises a signed-in member, in journey order. */
const JOURNEY: readonly string[] = [
  DASHBOARD_HOME,
  ...APP_ROUTE_PREFIXES.map((prefix) => APP_HOME_HREFS[prefix]),
  WORKSPACE_MODULE_HOME,
  ...WORKSPACE_SECTIONS.map(workspaceSectionHref),
  // Every contextual app-menu destination belongs to the signed-in journey,
  // not merely the app's home. Deriving these from each app's route source
  // catches a section that is listed in its sidebar but forgotten by a rewrite
  // or auth boundary.
  ...ACCOUNTING_SECTION_KEYS.map(accountingSectionHref),
  ...CRM_SECTION_KEYS.map(crmSectionHref),
  ...GROWTH_SECTION_KEYS.map(growthSectionHref),
  ...CMS_SECTION_KEYS.map(cmsSectionHref),
  ...WP_SECTION_KEYS.map(wpSectionHref),
  PLATFORM_SETTINGS_HOME,
  ...APP_ROUTE_PREFIXES.map((prefix) => APP_SETTINGS_HREFS[prefix]),
  ...SETTINGS_TAB_KEYS.map(settingsTabHref),
  ...PLATFORM_SETTINGS_PAGES.map((page) => `/settings/${page}`),
  ...Object.values(ACCOUNTING_WORKSPACE_HREFS),
  ...["new", "prices", "attributes", "barcode-templates", "reports"].map(
    accountingProductsHref,
  ),
  PLATFORM_BILLING_HREF,
  PLATFORM_SUBSCRIPTION_HREF,
  settingsTabHref("team"),
  "/settings/profile",
  "/settings/connections",
  // The workspace's own pages at top-level routes. The old `/overview` and
  // `/ai` addresses are not here: both are retired (the quick-report
  // dashboard and the second AI application) and now forward to `/dashboard`
  // — asserted among the legacy redirects below instead.
  "/media",
  "/knowledge",
  "/support",
];

describe("the signed-in journey", () => {
  it("serves the workspace home, every app overview, every workspace section and the settings areas", async () => {
    for (const pathname of JOURNEY) {
      expect(
        await isServed(pathname),
        `${pathname} should be served to a signed-in owner`,
      ).toBe(true);
    }
  });

  it("serves each app's own settings page — never a redirect into platform settings", async () => {
    for (const prefix of APP_ROUTE_PREFIXES) {
      const href = APP_SETTINGS_HREFS[prefix];
      const { status, location } = await visit(href, { authed: true });
      expect(status, `${href} should be served, not redirected`).toBe(200);
      expect(
        location,
        `${href} must not bounce to the platform settings page`,
      ).toBeNull();
      // ...and it must be an address *inside the app*, so the app's own shell
      // and sidebar render around it.
      expect(href.startsWith(`${prefix}/`)).toBe(true);
    }
  });

  it("serves the deeper app pages the old rewrite table never covered", async () => {
    for (const pathname of [
      "/accounting/expenses",
      "/accounting/receivables",
      "/accounting/payables",
      "/accounting/reports",
      // The one people directory, and the URLs of its views. All one route —
      // the middleware must serve it, not redirect it, filter or no filter.
      "/accounting/directory",
      // The retired per-role party screens. They are route-level redirects
      // inside the app (never middleware rewrites), so the middleware serves
      // them through and the page does the forwarding.
      "/accounting/customers",
      "/accounting/suppliers",
      "/accounting/vendors",
      "/crm/persons",
      "/crm/persons/00000000-0000-0000-0000-000000000000",
      "/crm/segments",
      "/growth/campaigns",
      "/growth/loyalty",
      "/websites/cms/pages",
      "/websites/wp/orders",
    ]) {
      expect(await isServed(pathname), `${pathname} should be served`).toBe(
        true,
      );
    }
  });

  it("keeps the query string on a page it serves", async () => {
    const { status, location } = await visit("/crm/persons?q=ali&page=2", {
      authed: true,
    });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("serves a filtered and deep-linked directory as one page, not a redirect", async () => {
    // A link from A/R («مشتریان در حسابداری») or from an AI answer lands here;
    // the filter and the opened file are query parameters on one route, so the
    // middleware must let both through untouched.
    for (const pathname of [
      "/accounting/directory?view=customers",
      "/accounting/directory?view=suppliers",
      "/accounting/directory?view=customers&party=00000000-0000-0000-0000-000000000000",
    ]) {
      const { status, location } = await visit(pathname, { authed: true });
      expect(status, `${pathname} should be served`).toBe(200);
      expect(
        location,
        `${pathname} must not be redirected by the middleware`,
      ).toBeNull();
    }
  });

  it("serves the canonical operational workspaces, never a Dashboard alias", async () => {
    for (const pathname of [
      ...Object.values(ACCOUNTING_WORKSPACE_HREFS),
      ...["new", "prices", "attributes", "barcode-templates", "reports"].map(
        accountingProductsHref,
      ),
    ]) {
      expect(await isServed(pathname), `${pathname} should be served`).toBe(
        true,
      );
      const { status, location } = await visit(pathname, { authed: true });
      expect(status, `${pathname} must not redirect`).toBe(200);
      expect(location).toBeNull();
    }
  });
});

describe("the signed-out journey", () => {
  it("sends every protected URL to the login page, carrying where it was going", async () => {
    for (const pathname of JOURNEY) {
      const { status, location } = await visit(pathname, { authed: false });
      expect(status, `${pathname} should redirect a signed-out visitor`).toBe(
        307,
      );
      expect(location?.pathname).toBe("/login");
      expect(location?.searchParams.get("next")).toBe(pathname);
    }
  });

  it("preserves a deep link's query string across the sign-in bounce", async () => {
    const { location } = await visit("/accounting/expenses?from=1404-01-01", {
      authed: false,
    });
    expect(location?.searchParams.get("next")).toBe(
      "/accounting/expenses?from=1404-01-01",
    );
  });

  it("still lets the login page itself through", async () => {
    const response = await middleware(request("/login", { authed: false }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("the legacy addresses", () => {
  const CASES: readonly (readonly [string, string])[] = [
    ["/dashboard/accounting", "/accounting/overview"],
    ["/dashboard/accounting/expenses", "/accounting/expenses"],
    ["/dashboard/pos", ACCOUNTING_WORKSPACE_HREFS.pos],
    ["/dashboard/stock", ACCOUNTING_WORKSPACE_HREFS.inventory],
    ["/dashboard/inventory", ACCOUNTING_WORKSPACE_HREFS.inventory],
    ["/dashboard/products", ACCOUNTING_WORKSPACE_HREFS.products],
    ["/dashboard/products/new", accountingProductsHref("new")],
    ["/dashboard/products/prices", accountingProductsHref("prices")],
    ["/dashboard/cosmetics", ACCOUNTING_WORKSPACE_HREFS.cosmetics],
    ["/dashboard/reports", ACCOUNTING_WORKSPACE_HREFS.reports],
    ["/dashboard/floor", ACCOUNTING_WORKSPACE_HREFS.floor],
    ["/dashboard/kitchen", ACCOUNTING_WORKSPACE_HREFS.kitchen],
    ["/dashboard/reservations", ACCOUNTING_WORKSPACE_HREFS.reservations],
    ["/dashboard/delivery", ACCOUNTING_WORKSPACE_HREFS.delivery],
    ["/dashboard/crm", "/crm/overview"],
    ["/dashboard/crm/segments", "/crm/segments"],
    ["/dashboard/growth", "/growth/overview"],
    ["/dashboard/growth/campaigns", "/growth/campaigns"],
    ["/dashboard/website", "/websites/overview"],
    ["/dashboard/website/wp/orders", "/websites/wp/orders"],
    ["/dashboard/projects", "/workspace/projects"],
    ["/projects", "/workspace/projects"],
    ["/projects/42", "/workspace/projects/42"],
    ["/dashboard/settings", "/settings"],
    ["/dashboard/billing", PLATFORM_BILLING_HREF],
    ["/dashboard/connections", "/settings/connections"],
    // The final wave: the workspace's own pages and the last flat dashboard
    // pages. Every one of them is a middleware 308 now — no page.tsx remains
    // under /dashboard except the home itself. The two retired homes — the
    // old quick-report dashboard and the standalone AI application — resolve
    // back onto the one home rather than onto a successor page.
    ["/dashboard/overview", "/dashboard"],
    ["/dashboard/ai", "/dashboard"],
    // The same two retired homes at their top-level addresses. These were
    // answered by redirect-only `page.tsx` files until the dead-code cleanup
    // removed that duplicate; the promise now lives where every other legacy
    // URL's does — the central table, applied by middleware. A `/ai/<section>`
    // bookmark still opens the assistant's management panel.
    ["/overview", "/dashboard"],
    ["/ai", "/dashboard"],
    ["/ai/agents", "/dashboard"],
    ["/ai/coworkers", "/dashboard"],
    ["/ai/automations", "/dashboard"],
    ["/ai/activity", "/dashboard"],
    ["/ai/knowledge", "/dashboard"],
    ["/ai/usage", "/dashboard"],
    ["/dashboard/media", "/media"],
    ["/dashboard/knowledge", "/knowledge"],
    ["/dashboard/knowledge/a/pos-basics", "/knowledge/a/pos-basics"],
    ["/dashboard/support", "/support"],
    ["/dashboard/guides", "/knowledge"],
    ["/dashboard/help", "/knowledge"],
    ["/dashboard/orders", ACCOUNTING_WORKSPACE_HREFS.orders],
    ["/dashboard/waiter", ACCOUNTING_WORKSPACE_HREFS.waiter],
    ["/dashboard/jewelry", ACCOUNTING_WORKSPACE_HREFS.jewelry],
    ["/dashboard/watch", ACCOUNTING_WORKSPACE_HREFS.watch],
    ["/dashboard/accessories", ACCOUNTING_WORKSPACE_HREFS.products],
    ["/dashboard/wholesale", ACCOUNTING_WORKSPACE_HREFS.products],
    ["/dashboard/tools-fittings", ACCOUNTING_WORKSPACE_HREFS.products],
    ["/dashboard/haberdashery", ACCOUNTING_WORKSPACE_HREFS.products],
    ["/dashboard/loyalty", "/growth/loyalty"],
    ["/dashboard/promotions", "/growth/campaigns"],
    ["/dashboard/commission", "/growth/commission"],
    ["/dashboard/customers", "/crm/directory"],
    ["/dashboard/persons", "/crm/directory"],
    ["/dashboard/menu", "/settings/menu"],
    ["/dashboard/team", "/settings/team"],
    ["/dashboard/backup", "/settings/backup"],
    ["/dashboard/ledger", "/accounting/overview"],
    ["/dashboard/wp", "/websites/wp"],
    ["/dashboard/wp/orders", "/websites/wp/orders"],
  ];

  it("permanently redirects each one to its canonical replacement", async () => {
    for (const [legacy, canonical] of CASES) {
      const { status, location } = await visit(legacy, { authed: true });
      expect(status, `${legacy} should be a permanent redirect`).toBe(308);
      expect(location?.pathname, `${legacy} → ${canonical}`).toBe(canonical);
    }
  });

  it("sends a signed-out visitor from every Accounting URL to the login page, not a 404", async () => {
    for (const pathname of [
      "/accounting",
      "/accounting/overview",
      "/accounting/directory",
      "/accounting/customers",
      "/accounting/suppliers",
      "/accounting/vendors",
      "/accounting/receivables",
      "/accounting/payables",
    ]) {
      const { status, location } = await visit(pathname, { authed: false });
      expect(status, `${pathname} should bounce a signed-out visitor`).toBe(
        307,
      );
      expect(location?.pathname).toBe("/login");
      expect(location?.searchParams.get("next")).toBe(pathname);
    }
  });

  it("carries a directory filter through the sign-in bounce", async () => {
    const { location } = await visit("/accounting/directory?view=suppliers", {
      authed: false,
    });
    expect(location?.searchParams.get("next")).toBe(
      "/accounting/directory?view=suppliers",
    );
  });

  it("opens each retired AI section as the dashboard's management panel, not a page", async () => {
    // The `?aiPanel=` value is the substance of these redirects — landing on a
    // bare `/dashboard` would silently lose the section the bookmark named.
    // `aiPanelHref` is the one producer of the address, so the assertion reads
    // it rather than re-spelling the query string.
    for (const section of AI_PANEL_SECTION_KEYS) {
      for (const legacy of [`/ai/${section}`, `/dashboard/ai/${section}`]) {
        const { status, location } = await visit(legacy, { authed: true });
        expect(status, `${legacy} should be a permanent redirect`).toBe(308);
        expect(location?.pathname).toBe("/dashboard");
        expect(
          location?.searchParams.get(AI_PANEL_PARAM),
          `${legacy} should open the ${section} panel`,
        ).toBe(section);
        expect(`${location?.pathname}${location?.search}`).toBe(
          aiPanelHref(section),
        );
      }
    }
  });

  it("carries an assistant deep link's query through the retired /ai address", async () => {
    // `/ai?conversation=…` was a real, working deep link into the standalone
    // application's chat. The hub on `/dashboard` reads the same parameter, so
    // the thread must survive the hop.
    const { status, location } = await visit("/ai?conversation=abc123", {
      authed: true,
    });
    expect(status).toBe(308);
    expect(location?.pathname).toBe("/dashboard");
    expect(location?.searchParams.get("conversation")).toBe("abc123");
  });

  it("redirects a signed-out visitor too, so the bookmark lands before the login bounce", async () => {
    const { status, location } = await visit("/dashboard/crm/segments", {
      authed: false,
    });
    expect(status).toBe(308);
    expect(location?.pathname).toBe("/crm/segments");
  });

  it("carries a nested operational URL and query string through the redirect", async () => {
    const { location } = await visit("/dashboard/products/new?tab=new&q=vip", {
      authed: true,
    });
    expect(location?.pathname).toBe(accountingProductsHref("new"));
    expect(location?.searchParams.get("tab")).toBe("new");
    expect(location?.searchParams.get("q")).toBe("vip");
  });

  it("forwards the old tabbed ledger address to the section each tab names now", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["/dashboard/ledger", "/accounting/overview"],
      ["/dashboard/ledger?tab=expenses", "/accounting/expenses"],
      ["/dashboard/ledger?tab=ar", "/accounting/receivables"],
      ["/dashboard/ledger?tab=parties", "/accounting/directory"],
      ["/dashboard/ledger?tab=nonsense", "/accounting/overview"],
    ];
    for (const [legacy, canonical] of cases) {
      const { status, location } = await visit(legacy, { authed: true });
      expect(status, `${legacy} should be a permanent redirect`).toBe(308);
      expect(location?.pathname, `${legacy} → ${canonical}`).toBe(canonical);
    }
    // The per-role tabs carry which list was asked for, and a `?party=` deep
    // link keeps its file-opening parameter.
    const suppliers = await visit("/dashboard/ledger?tab=suppliers&party=42", {
      authed: true,
    });
    expect(suppliers.location?.pathname).toBe("/accounting/directory");
    expect(suppliers.location?.searchParams.get("view")).toBe("suppliers");
    expect(suppliers.location?.searchParams.get("party")).toBe("42");
  });

  it("splits the old WordPress manager between the website app and the connections hub", async () => {
    const orders = await visit("/dashboard/wp/orders", { authed: true });
    expect(orders.status).toBe(308);
    expect(orders.location?.pathname).toBe("/websites/wp/orders");
    // The store's technical connection lives in the hub now.
    const connections = await visit("/dashboard/wp/connections", { authed: true });
    expect(connections.location?.pathname).toBe("/settings/connections");
    expect(connections.location?.searchParams.get("tab")).toBe("woocommerce");
    // An unknown trailing segment lands on the manager's front page, not a 404.
    const unknown = await visit("/dashboard/wp/definitely-retired", { authed: true });
    expect(unknown.location?.pathname).toBe("/websites/wp");
  });

  it("carries the branch-management tab of the two retired branch pages", async () => {
    const branches = await visit("/dashboard/branches", { authed: true });
    expect(branches.location?.pathname).toBe("/settings/branch-management");
    expect(branches.location?.searchParams.get("branchTab")).toBe("branches");
    const sync = await visit("/dashboard/locations", { authed: true });
    expect(sync.location?.pathname).toBe("/settings/branch-management");
    expect(sync.location?.searchParams.get("branchTab")).toBe("sync");
  });

  it("hands an old order deep link to the queue with the order open", async () => {
    const { status, location } = await visit("/dashboard/orders/ord-7", {
      authed: true,
    });
    expect(status).toBe(308);
    // The middleware forwards the path verbatim; the `[id]` route under
    // /accounting/orders then opens the dialog via `?order=`.
    expect(location?.pathname).toBe("/accounting/orders/ord-7");
  });

  it("never appends the home segment to a path that already names a section", async () => {
    // The `/crm/overview/overview` regression, checked through the middleware
    // rather than only through the table it consults.
    for (const [legacy] of CASES) {
      const { location } = await visit(legacy, { authed: true });
      expect(location?.pathname.endsWith("/overview/overview")).toBe(false);
    }
  });

  it("leaves a canonical URL alone — a redirect must not redirect again", async () => {
    for (const pathname of JOURNEY) {
      const { status } = await visit(pathname, { authed: true });
      expect(status, `${pathname} is canonical and must not redirect`).toBe(
        200,
      );
    }
  });
});

describe("the sidebar's platform menu, as URLs", () => {
  it("serves every link in the drop-up to a signed-in owner", async () => {
    for (const item of platformUserMenuItems("owner")) {
      if (item.kind !== "link") continue;
      expect(
        await isServed(item.href),
        `the menu's «${item.label}» link should be served`,
      ).toBe(true);
    }
  });

  it("offers the bug report as an action, so there is no route to check", () => {
    const bugReport = platformUserMenuItems("owner").find(
      (item) => item.key === "bug-report",
    );
    expect(bugReport?.kind).toBe("bug-report");
    expect(bugReport).not.toHaveProperty("href");
  });

  it("logs out to a door that needs no session", async () => {
    for (const role of ["owner", "manager", "cashier"]) {
      const logout = platformUserMenuItems(role).find(
        (item) => item.key === "logout",
      );
      if (logout?.kind !== "logout")
        throw new Error("the menu lost its sign-out");
      const response = await middleware(
        request(logout.returnTo, { authed: false }),
      );
      expect(
        response.status,
        `${logout.returnTo} must be reachable after signing out`,
      ).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("answers the sign-out call itself rather than bouncing it", async () => {
    const req = new NextRequest(new URL("/api/auth/logout", ORIGIN), {
      method: "POST",
      // Middleware's CSRF check: a state-changing request must come from this
      // origin. The menu's sign-out is a same-origin `fetch`, so it does.
      headers: { origin: ORIGIN, host: "localhost:3000" },
    });
    req.cookies.set("pos_session", ownerCookie);
    const response = await middleware(req);
    expect(response.status).toBe(200);
  });
});
