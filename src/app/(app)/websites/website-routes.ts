/**
 * «مدیریت وب‌سایت» — the app's two managers and their sections.
 *
 * The app answers one question for a business — "where does my website live,
 * and how do I run it?" — and there are exactly two answers today:
 *
 *   cms — the platform's own site builder (Eshobe CMS, a separate deployment
 *         this app holds one encrypted credential for; see
 *         docs/eshobe-cms-integration.md).
 *   wp  — a WordPress/WooCommerce site the business already runs, managed
 *         through the plugin or the REST API (Phase 40).
 *
 * They are peers and they never merge: a section of one is never rendered
 * inside the other, and neither is a tab of the technical connections hub.
 * What this module owns is the *routing* half of that — which sections exist,
 * what their URLs are, who may open them, and (the part that is new) **which
 * of them a business actually sees**, which depends on the connections it has
 * made rather than on a flag somebody set.
 *
 * That last rule is why `visibleSections` takes a state rather than a role
 * alone. A business with no site at all should be offered the two ways to get
 * one and nothing else — a «سفارش‌ها» menu entry over a site that does not
 * exist is a dead end with a number on it. Once a manager is connected, its
 * whole menu appears.
 *
 * Framework-free (no React, no db, no next) so the rule is unit-tested in
 * `website-routes.test.ts` and can be imported by the server layout, the
 * client sidebar and the app home alike — the same split `crm-routes.ts` and
 * `growth-routes.ts` keep.
 */
import { WP_SECTION_KEYS, type WpSectionKey } from "./wp/wp-routes";
import type { Permission } from "@/lib/permissions";

/** The app's public prefix. Every route below lives under it. */
export const WEBSITE_HOME = "/websites";

/**
 * The app's home page. `/websites` itself redirects here, so the front page has
 * one address — and, because the overview is a real route rather than the bare
 * prefix, nothing ever appends a second `/overview` to it.
 */
export const WEBSITE_OVERVIEW_HREF = `${WEBSITE_HOME}/overview`;

/**
 * The website app's *own* settings — which manager is the business's primary
 * site, and the app-level defaults over both. Not `/settings`: that is the
 * platform's settings area, and the CMS's per-site sync settings
 * (`/websites/cms/settings`) are a third, narrower thing again.
 */
export const WEBSITE_SETTINGS_HREF = `${WEBSITE_HOME}/settings`;

export const WEBSITE_MANAGER_KEYS = ["cms", "wp"] as const;
export type WebsiteManagerKey = (typeof WEBSITE_MANAGER_KEYS)[number];

/** The Eshobe CMS manager's sections, in menu order. */
export const CMS_SECTION_KEYS = [
  "overview",
  "setup",
  "pages",
  "posts",
  "media",
  "products",
  "orders",
  "design",
  "domain",
  "settings",
  "billing",
] as const;
export type CmsSectionKey = (typeof CMS_SECTION_KEYS)[number];

export type CmsSiteType = "business" | "portfolio" | "store";

const PORTFOLIO_HIDDEN_SECTIONS = new Set<CmsSectionKey>(["products", "orders"]);

/** The route for a CMS section. The overview is the manager's root. */
export function cmsSectionHref(key: CmsSectionKey): string {
  return key === "overview" ? `${WEBSITE_HOME}/cms` : `${WEBSITE_HOME}/cms/${key}`;
}

/** The route for a WordPress section, now that the manager lives inside this app. */
export function wpSectionHref(key: WpSectionKey): string {
  return key === "overview" ? `${WEBSITE_HOME}/wp` : `${WEBSITE_HOME}/wp/${key}`;
}

/** Whether a dashboard path is a given CMS section — the sidebar's active state. */
export function isCmsSectionPathname(pathname: string, key: CmsSectionKey): boolean {
  const href = cmsSectionHref(key);
  return key === "overview"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

/** The same, for a WordPress section. */
export function isWpSectionPathname(pathname: string, key: WpSectionKey): boolean {
  const href = wpSectionHref(key);
  return key === "overview"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Role gate. Both managers write to a live public site and read the whole
 * order book behind it, so both are owner/manager work — the same line the WP
 * Manager drew for itself and the connections hub draws for a machine
 * credential. A cashier sees the launcher and lands back on the dashboard.
 */
export function canOpenWebsiteApp(permissions: ReadonlySet<Permission>): boolean {
  return permissions.has("website.view") || permissions.has("cms.view") || permissions.has("woocommerce.view");
}

/**
 * What the app knows about a business's two website systems.
 *
 * Deliberately small and *observed*: whether each manager has a live
 * connection, and how far the CMS site-building wizard has got. It is filled
 * from `GET /api/website/managers`, which reads the two connection stores; a
 * screen never infers "connected" from the absence of an error.
 */
export interface WebsiteManagersState {
  cms: {
    connected: boolean;
    /** The site's domain, once there is one. */
    domain: string | null;
    /** How far the build wizard has got — `built` once the site exists. */
    setupStep: "domain" | "cdn" | "type" | "build" | "built" | null;
    /** From setup while disconnected; from the live descriptor when connected. */
    siteType: CmsSiteType | null;
  };
  wp: {
    connected: boolean;
    /** How many WooCommerce/WordPress stores are linked. */
    storeCount: number;
  };
}

export const EMPTY_WEBSITE_MANAGERS_STATE: WebsiteManagersState = {
  cms: { connected: false, domain: null, setupStep: null, siteType: null },
  wp: { connected: false, storeCount: 0 },
};

/**
 * The CMS sections this business can currently use.
 *
 * With no site, the manager is one thing — the wizard that builds one — plus
 * its own front page. Content, store, settings and billing are all *about* a
 * site, so they arrive with it.
 */
export function visibleCmsSections(state: WebsiteManagersState): CmsSectionKey[] {
  if (!state.cms.connected) return ["overview", "setup"];
  if (state.cms.siteType === "portfolio") {
    return CMS_SECTION_KEYS.filter((key) => !PORTFOLIO_HIDDEN_SECTIONS.has(key));
  }
  return [...CMS_SECTION_KEYS];
}

/**
 * The WordPress sections this business can currently use. With no store
 * linked, only the overview has anything to show — every other section reads
 * the mirror of a store that is not there yet — and the overview itself links
 * to the «اتصال‌های فنی» hub, where the connection is made.
 */
export function visibleWpSections(state: WebsiteManagersState): WpSectionKey[] {
  if (!state.wp.connected) return ["overview"];
  return [...WP_SECTION_KEYS];
}

/** Whether either manager has been set up at all — what the app home branches on. */
export function hasAnyWebsite(state: WebsiteManagersState): boolean {
  return state.cms.connected || state.wp.connected;
}

/** Which manager a path belongs to, or null for the app's own pages (home, settings). */
export function managerForPathname(pathname: string): WebsiteManagerKey | null {
  if (pathname === `${WEBSITE_HOME}/cms` || pathname.startsWith(`${WEBSITE_HOME}/cms/`)) return "cms";
  if (pathname === `${WEBSITE_HOME}/wp` || pathname.startsWith(`${WEBSITE_HOME}/wp/`)) return "wp";
  return null;
}
