/**
 * The platform's canonical public URLs, and what the old ones become.
 *
 * The product used to serve every app out of one route tree — `/dashboard/crm`,
 * `/dashboard/growth`, `/dashboard/website`, `/dashboard/settings` — and a
 * later attempt to give each app a top-level address did it by rewriting the
 * public URL back onto that tree inside middleware. A rewrite is the wrong tool
 * for this: it mutates `request.nextUrl.pathname`, so the server renders one
 * pathname while the browser's history (and therefore `usePathname`, every
 * active-nav rule and every client-side `Link` prefetch) holds another. The
 * pages 404'd or resolved to the wrong route depending on whether a visit was
 * a fresh document load or a client navigation.
 *
 * The apps are real route directories now — `src/app/(app)/<app>` — so nothing
 * is rewritten anywhere: the address bar, the server's route resolution and
 * the client router all agree. What is left is a *redirect* table for the URLs
 * that used to work, which is what this module is.
 *
 * Framework-free (no `next`, no `db`) so the Edge middleware, the route
 * helpers and the unit tests all read the same rules. The two app-side route
 * modules imported here are framework-free by the same rule, so the Edge
 * middleware can carry them.
 */

import { partyDirectoryHref } from "./party-directory";
import { WORKSPACE_SECTIONS, type WorkspaceSection } from "./workspace-shared";
import { aiPanelHref, isAiPanelSectionKey } from "./ai-panel";
import {
  accountingDirectoryViewForLegacySection,
  accountingSectionForLegacyTab,
  accountingSectionHref,
} from "@/app/(app)/accounting/accounting-routes";
import { WP_SECTION_KEYS } from "@/app/(app)/websites/wp/wp-routes";

/** The main platform home. Unchanged — it is the business's own workspace. */
export const DASHBOARD_HOME = "/dashboard";

/**
 * The workspace's own pages, each at a top-level public URL.
 *
 * These used to live under `/dashboard/<page>`; the dashboard route tree now
 * holds exactly one page — `/dashboard` itself, the assistant chat home — and
 * everything else is a top-level route (or an app section). The old addresses
 * are middleware redirects in `LEGACY_PREFIX_MAP` below, so no bookmark ever
 * 404s. `/overview` and `/ai` once stood beside these as top-level routes;
 * both are retired (the old quick-report dashboard and the second AI
 * application), and their addresses now resolve to `/dashboard` itself — see
 * `legacyAssistantTarget`. They have **no route files of their own**: the
 * redirect-only `page.tsx` files that used to answer them were a second
 * implementation of a rule this table already owns, so the redirect is issued
 * here, in middleware, like every other legacy address.
 */
export const WORKSPACE_TOP_HREFS = {
  media: "/media",
  knowledge: "/knowledge",
  support: "/support",
} as const;

/** The top-level workspace routes, for canonical-pathname checks. */
const WORKSPACE_TOP_ROUTES: readonly string[] = Object.values(WORKSPACE_TOP_HREFS);

/**
 * Phase G — «میز کار من» (My Workspace).
 *
 * The module that used to be one page at `/projects` is a ten-section platform
 * area now, so it gets a prefix of its own and `/projects` joins the legacy
 * table below (`/projects/42` → `/workspace/projects/42`). It is deliberately
 * NOT an entry in `APP_ROUTE_PREFIXES`: the four apps there are
 * availability-gated products a business can be without, while the workspace
 * is platform furniture like `/settings` — every business has it, and
 * `appForPagePath` must keep returning null for it so it can never be switched
 * off. See `docs/phases/Phase-G-My-Workspace.md`.
 */
export const WORKSPACE_MODULE_HOME = "/workspace";

/**
 * Whether a pathname belongs to My Workspace.
 *
 * Keep this segment-aware check beside the module home instead of scattering
 * `startsWith("/workspace")` checks through shells. In particular,
 * `/workspace-tools` is not the workspace, while project/detail URLs remain
 * inside it. The tenant shell uses this to replace global navigation with the
 * Workspace's contextual navigation.
 */
export function isWorkspacePathname(pathname: string): boolean {
  return pathname === WORKSPACE_MODULE_HOME || pathname.startsWith(`${WORKSPACE_MODULE_HOME}/`);
}

/** One workspace section's canonical URL. The home is the overview. */
export function workspaceSectionHref(section: WorkspaceSection): string {
  return `${WORKSPACE_MODULE_HOME}/${section}`;
}

/** One project's page, inside the workspace's projects section. */
export function workspaceProjectHref(projectId: string): string {
  return `${WORKSPACE_MODULE_HOME}/projects/${projectId}`;
}

/**
 * The business work areas that belong to the primary Accounting workspace.
 *
 * These are public paths, not aliases. Every sidebar entry, link and redirect
 * that opens one of these areas must use this table; `/dashboard/<section>` is
 * retained only as a middleware redirect for a saved bookmark. Keeping the
 * canonical names here gives the nav, route tree and redirect table one source
 * of truth instead of letting a second dashboard URL slip back into the app.
 */
export const ACCOUNTING_WORKSPACE_HREFS = {
  pos: "/accounting/pos",
  inventory: "/accounting/inventory",
  products: "/accounting/products",
  cosmetics: "/accounting/cosmetics",
  reports: "/accounting/reports",
  floor: "/accounting/floor",
  kitchen: "/accounting/kitchen",
  reservations: "/accounting/reservations",
  delivery: "/accounting/delivery",
  // The second wave of the same move: the orders queue, the waiter board and
  // the two industry managers were the last operational pages still living
  // under `/dashboard/…`; they are Accounting work areas like the rest.
  orders: "/accounting/orders",
  waiter: "/accounting/waiter",
  jewelry: "/accounting/jewelry",
  watch: "/accounting/watch",
} as const;

/** One products-workspace sub-section, under the one canonical products door. */
export function accountingProductsHref(section?: string): string {
  return section ? `${ACCOUNTING_WORKSPACE_HREFS.products}/${section}` : ACCOUNTING_WORKSPACE_HREFS.products;
}

/** The platform settings area. Never an app's settings — see `APP_SETTINGS_HREFS`. */
export const PLATFORM_SETTINGS_HOME = "/settings";

/** Platform-owned pages that live beside settings rather than inside an app. */
export const PLATFORM_ROUTES = [
  PLATFORM_SETTINGS_HOME,
  "/settings/profile",
  "/settings/billing",
  "/settings/subscription",
  "/settings/team",
  "/settings/security",
  "/settings/notifications",
  "/settings/business",
  // Technical connections are a platform utility, not an app section: every
  // connection surface inside an app links here rather than keeping a copy.
  "/settings/connections",
  // Phase G — the workspace module's ten sections. Platform routes, not an
  // app: available to every business, never availability-gated.
  WORKSPACE_MODULE_HOME,
  ...WORKSPACE_SECTIONS.map((section) => `${WORKSPACE_MODULE_HOME}/${section}`),
] as const;

/** The apps with a top-level public prefix of their own. */
export const APP_ROUTE_PREFIXES = ["/accounting", "/growth", "/crm", "/websites"] as const;
export type AppRoutePrefix = (typeof APP_ROUTE_PREFIXES)[number];

/** Every app's home, which is always its overview — never the bare prefix. */
export const APP_HOME_HREFS: Record<AppRoutePrefix, string> = {
  "/accounting": "/accounting/overview",
  "/growth": "/growth/overview",
  "/crm": "/crm/overview",
  "/websites": "/websites/overview",
};

/**
 * Each app's own settings page. These are separate routes with their own
 * components, titles and descriptions: an app's settings must never render the
 * platform settings page, and must never redirect to `/settings` unless the
 * thing being configured is genuinely platform-owned (billing, subscription,
 * team, security — see `PLATFORM_ROUTES`).
 */
export const APP_SETTINGS_HREFS: Record<AppRoutePrefix, string> = {
  "/accounting": "/accounting/settings",
  "/growth": "/growth/settings",
  "/crm": "/crm/settings",
  "/websites": "/websites/settings",
};

/** Platform billing and subscription, the two money surfaces an app may link to. */
export const PLATFORM_BILLING_HREF = "/settings/billing";
export const PLATFORM_SUBSCRIPTION_HREF = "/settings/subscription";

/**
 * Whether a pathname is inside one of the apps, and which one.
 *
 * Matched on whole path segments: `/growthlab` is not inside `/growth`.
 */
export function appPrefixForPathname(pathname: string): AppRoutePrefix | null {
  for (const prefix of APP_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/** Whether a pathname is the platform settings area (and not an app's settings). */
export function isPlatformSettingsPathname(pathname: string): boolean {
  return pathname === PLATFORM_SETTINGS_HOME || pathname.startsWith(`${PLATFORM_SETTINGS_HOME}/`);
}

/**
 * The legacy `/dashboard/*` prefixes and the canonical prefix each becomes.
 *
 * Longest first: `/dashboard/website/wp` has to be answered before
 * `/dashboard/website`, or the `wp` manager's URLs lose their manager.
 */
const LEGACY_PREFIX_MAP: readonly (readonly [string, string])[] = [
  ["/dashboard/accounting", "/accounting"],
  // The workspace's own pages, now top-level routes. `knowledge` first serves
  // its own prefix; the two older aliases (`guides`, `help`) grew into it.
  // `/dashboard/overview` and `/dashboard/ai` are deliberately NOT rows here:
  // their targets depend on the path suffix (an AI section name), so
  // `legacyAssistantTarget` answers them the way `legacyLedgerTarget` answers
  // the old tabbed ledger page.
  ["/dashboard/media", WORKSPACE_TOP_HREFS.media],
  ["/dashboard/knowledge", WORKSPACE_TOP_HREFS.knowledge],
  ["/dashboard/support", WORKSPACE_TOP_HREFS.support],
  ["/dashboard/guides", WORKSPACE_TOP_HREFS.knowledge],
  ["/dashboard/help", WORKSPACE_TOP_HREFS.knowledge],
  // The second wave of work areas into Accounting: the orders queue (its
  // `/dashboard/orders/<id>` deep links keep their suffix and land on the
  // `[id]` route, which opens the order's dialog), the waiter board and the
  // two industry managers.
  ["/dashboard/orders", ACCOUNTING_WORKSPACE_HREFS.orders],
  ["/dashboard/waiter", ACCOUNTING_WORKSPACE_HREFS.waiter],
  ["/dashboard/jewelry", ACCOUNTING_WORKSPACE_HREFS.jewelry],
  ["/dashboard/watch", ACCOUNTING_WORKSPACE_HREFS.watch],
  // Phase 42 — the retail trade-goods catalogues live in the shared products
  // workspace; their four old pages were pure redirects and are now rows here.
  ["/dashboard/accessories", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/wholesale", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/tools-fittings", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/haberdashery", ACCOUNTING_WORKSPACE_HREFS.products],
  // Growth & Marketing absorbed the three flat pages (Phase 36b).
  ["/dashboard/loyalty", "/growth/loyalty"],
  ["/dashboard/promotions", "/growth/campaigns"],
  ["/dashboard/commission", "/growth/commission"],
  // The flat persons/customers pages both land on the CRM's directory; a role
  // the CRM does not admit is re-routed by the directory page itself (see
  // `crmFallbackHref` — the accountant lands on Accounting's own directory).
  ["/dashboard/customers", "/crm/directory"],
  ["/dashboard/persons", "/crm/directory"],
  // Platform-owned pages that live in the settings area.
  ["/dashboard/menu", "/settings/menu"],
  ["/dashboard/team", "/settings/team"],
  ["/dashboard/backup", "/settings/backup"],
  ["/dashboard/branches", "/settings/branch-management?branchTab=branches"],
  ["/dashboard/locations", "/settings/branch-management?branchTab=sync"],
  // The old generic integrations pages. Longest first, so the Holoo wizard's
  // URL keeps its own destination (its `?connectionId=` travels as the query).
  ["/dashboard/integrations/holoo", "/settings/connections/holoo"],
  ["/dashboard/integrations", "/settings/connections?tab=woocommerce"],
  // The business work areas now live inside the primary Accounting workspace.
  // These are redirects only: there is no `page.tsx` left below the old
  // dashboard paths, so a stale URL cannot render a second copy of a page.
  // Products owns nested public sections, hence the prefix entry rather than
  // one row per child route. Retail's old `stock` alias intentionally joins
  // the same single inventory door.
  ["/dashboard/pos", ACCOUNTING_WORKSPACE_HREFS.pos],
  ["/dashboard/stock", ACCOUNTING_WORKSPACE_HREFS.inventory],
  ["/dashboard/inventory", ACCOUNTING_WORKSPACE_HREFS.inventory],
  ["/dashboard/products", ACCOUNTING_WORKSPACE_HREFS.products],
  ["/dashboard/cosmetics", ACCOUNTING_WORKSPACE_HREFS.cosmetics],
  ["/dashboard/reports", ACCOUNTING_WORKSPACE_HREFS.reports],
  ["/dashboard/floor", ACCOUNTING_WORKSPACE_HREFS.floor],
  ["/dashboard/kitchen", ACCOUNTING_WORKSPACE_HREFS.kitchen],
  ["/dashboard/reservations", ACCOUNTING_WORKSPACE_HREFS.reservations],
  ["/dashboard/delivery", ACCOUNTING_WORKSPACE_HREFS.delivery],
  // The two platform surfaces that moved into the settings area: money and
  // the technical connections hub. They were never app pages, and they are
  // not app pages now — they are platform settings, addressed as such.
  ["/dashboard/billing", PLATFORM_BILLING_HREF],
  ["/dashboard/connections", "/settings/connections"],
  ["/dashboard/growth", "/growth"],
  ["/dashboard/crm", "/crm"],
  ["/dashboard/website", "/websites"],
  // Phase G — «پروژه‌ها» became the Projects SECTION of «میز کار من», so both
  // the old top-level address and the older dashboard one land on it, suffix
  // intact: /projects/42 → /workspace/projects/42.
  ["/dashboard/projects", "/workspace/projects"],
  ["/projects", "/workspace/projects"],
  ["/dashboard/settings", "/settings"],
  // Phase F — CMS manager sections split; old grouped URLs forward only.
  ["/websites/cms/content", "/websites/cms/pages"],
  ["/websites/cms/store", "/websites/cms/products"],
];

/**
 * Where an old URL goes now, or null when it is not a legacy app URL.
 *
 * Two rules earn their own lines:
 *
 *  - A *bare* app prefix (`/dashboard/crm`) lands on the app's overview,
 *    because the app's home is its overview page.
 *  - A prefix with a suffix keeps the suffix verbatim
 *    (`/dashboard/crm/segments` → `/crm/segments`). It is emphatically **not**
 *    given an extra `/overview`: appending the home segment to a path that
 *    already names a section is what produced `/crm/overview/overview`.
 *
 * The query string is the caller's to carry (see `legacyRedirectTarget`).
 */
export function canonicalPathForLegacy(pathname: string): string | null {
  for (const [legacy, canonical] of LEGACY_PREFIX_MAP) {
    if (pathname === legacy) {
      // The bare app prefix is the app's home page.
      const home = APP_HOME_HREFS[canonical as AppRoutePrefix];
      return home ?? canonical;
    }
    if (pathname.startsWith(`${legacy}/`)) {
      // A target that carries its own query (`/settings/connections?tab=…`)
      // takes the suffix on the path, before its `?`.
      const query = canonical.indexOf("?");
      const suffix = pathname.slice(legacy.length);
      return query === -1
        ? `${canonical}${suffix}`
        : `${canonical.slice(0, query)}${suffix}${canonical.slice(query)}`;
    }
  }
  return null;
}

/**
 * Joins a redirect target that may already carry a query string with the
 * query string the visitor arrived with. The visitor's parameters win a
 * collision: a `/dashboard/integrations?tab=x` deep link keeps its own tab.
 */
function withSearch(canonical: string, search: string): string {
  if (!search || search === "?") return canonical;
  const extra = search.startsWith("?") ? search.slice(1) : search;
  if (!extra) return canonical;
  return canonical.includes("?") ? `${canonical}&${extra}` : `${canonical}?${extra}`;
}

/**
 * The Accounting app's oldest address — one tabbed page at
 * `/dashboard/ledger?tab=…` — forwarded to the section each tab names now.
 * `parties`/`customers`/`suppliers`/`vendors` became the one directory, so
 * those tabs carry *which list* was asked for, and a `?party=` deep link
 * travels with its file-opening parameter intact.
 */
function legacyLedgerTarget(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  const party = params.get("party");
  const view = accountingDirectoryViewForLegacySection(tab);
  const section = accountingSectionForLegacyTab(tab);
  if (section === "directory") {
    return partyDirectoryHref(view ?? "all", { party: party ?? null });
  }
  const href = accountingSectionHref(section);
  return party ? `${href}?party=${encodeURIComponent(party)}` : href;
}

/**
 * The standalone WordPress manager's old home (`/dashboard/wp/*`, Phase 40).
 * Every section forwards into «مدیریت وب‌سایت» — except `connections`, the
 * store's technical connection, which lives in the «اتصال‌های فنی» hub. An
 * unknown trailing segment lands on the manager's front page rather than a
 * 404: a URL that used to work never becomes a dead end.
 */
function legacyWpTarget(pathname: string, search: string): string {
  const rest = pathname.slice("/dashboard/wp".length).replace(/^\//, "");
  const [first] = rest.split("/");
  if (first === "connections") return withSearch("/settings/connections?tab=woocommerce", search);
  const known = first && (WP_SECTION_KEYS as readonly string[]).includes(first);
  return withSearch(known ? `/websites/wp/${rest}` : "/websites/wp", search);
}

/**
 * The retired second homes of the assistant and the old quick-report
 * dashboard. Both resolve to the one home — `/dashboard`, the assistant chat —
 * and nowhere else:
 *
 *  - `/dashboard/overview` was the old operational dashboard the `workspace`
 *    rollout replaced. It once forwarded to `/overview`; now that the
 *    quick-report dashboard is gone entirely, it lands on the chat home
 *    itself. It never had sub-paths, so only the exact address maps.
 *  - `/dashboard/ai` was the assistant's own address while `/dashboard` was
 *    still the old dashboard. A section suffix names an assistant management
 *    section, which now opens as the chat home's panel (`/dashboard/ai/agents`
 *    → `/dashboard?aiPanel=agents`, the same address the `ai-panel.ts`
 *    registry gives out). An unknown suffix degrades to the chat home rather
 *    than to a 404: a URL that used to work never becomes a dead end.
 *
 * The visitor's query string survives via `withSearch`, so a
 * `?conversation=` deep link still opens its thread after the hop.
 */
function legacyAssistantTarget(pathname: string, search: string): string {
  if (pathname === "/dashboard/overview" || pathname === "/overview") {
    return withSearch("/dashboard", search);
  }
  const prefix = pathname.startsWith("/dashboard/ai") ? "/dashboard/ai" : "/ai";
  const rest = pathname.slice(prefix.length).replace(/^\//, "");
  const [first] = rest.split("/");
  const canonical = isAiPanelSectionKey(first) ? aiPanelHref(first) : "/dashboard";
  return withSearch(canonical, search);
}

/**
 * The full redirect target for a legacy URL, query string preserved.
 *
 * `search` is the raw `?a=b` string (empty when there is none), exactly as
 * `URL.search` gives it, so a deep link's parameters survive the move.
 */
export function legacyRedirectTarget(pathname: string, search = ""): string | null {
  // The three old addresses whose targets depend on more than the path: the
  // tabbed ledger page, the standalone WordPress manager, and the retired
  // assistant/overview homes.
  if (pathname === "/dashboard/ledger" || pathname.startsWith("/dashboard/ledger/")) {
    return legacyLedgerTarget(search);
  }
  if (pathname === "/dashboard/wp" || pathname.startsWith("/dashboard/wp/")) {
    return legacyWpTarget(pathname, search);
  }
  if (
    pathname === "/dashboard/overview" ||
    pathname === "/dashboard/ai" ||
    pathname.startsWith("/dashboard/ai/") ||
    // The same two retired homes at their top-level addresses. These used to
    // be answered by redirect-only `page.tsx` files under `(app)/overview` and
    // `(app)/ai/*` — a second, duplicate implementation of a rule this table
    // already owns. The pages are gone; the compatibility promise is not.
    pathname === "/overview" ||
    pathname === "/ai" ||
    pathname.startsWith("/ai/")
  ) {
    return legacyAssistantTarget(pathname, search);
  }
  const canonical = canonicalPathForLegacy(pathname);
  return canonical === null ? null : withSearch(canonical, search);
}

/**
 * A canonical URL must never be treated as legacy — the guard that makes
 * `/crm/overview → /crm/overview/overview` unrepresentable rather than merely
 * absent. Exported because it is exactly what the route tests assert.
 */
export function isCanonicalAppPathname(pathname: string): boolean {
  // A path that still exists only to redirect (Phase F CMS splits, retired
  // dashboard prefixes, …) must not be treated as canonical app surface.
  if (canonicalPathForLegacy(pathname) !== null) return false;
  return (
    appPrefixForPathname(pathname) !== null ||
    isPlatformSettingsPathname(pathname) ||
    isWorkspacePathname(pathname) ||
    WORKSPACE_TOP_ROUTES.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    )
  );
}
