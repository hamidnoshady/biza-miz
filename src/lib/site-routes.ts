// src/lib/site-routes.ts
/**
 * Phase 45 — which screens a Hybrid desktop renders itself.
 *
 * The cloud is the system of record; the desktop is the till. Selling, floor
 * & kitchen, shifts and this computer's own settings run on the local server
 * and keep working offline. Every other screen is cloud-by-default: the
 * desktop hands it to the «نسخهٔ ابری» window instead of showing a partial
 * local copy that disagrees with the cloud. A screen added later is therefore
 * cloud unless someone adds it here on purpose.
 *
 * Framework-free and unit-tested; the dashboard gate, the till menu and the
 * home redirect all read this one list.
 */
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";
import type { NavNode } from "./nav-tree";
import { settingsTabHref } from "./settings-routes";

export const SITE_LOCAL_ROUTES: readonly string[] = [
  ACCOUNTING_WORKSPACE_HREFS.pos,
  ACCOUNTING_WORKSPACE_HREFS.orders,
  ACCOUNTING_WORKSPACE_HREFS.waiter,
  ACCOUNTING_WORKSPACE_HREFS.floor,
  ACCOUNTING_WORKSPACE_HREFS.kitchen,
  ACCOUNTING_WORKSPACE_HREFS.reservations,
  ACCOUNTING_WORKSPACE_HREFS.delivery,
  settingsTabHref("shifts"),
  settingsTabHref("cloud-sync"),
  settingsTabHref("devices"),
  settingsTabHref("desktop"),
  settingsTabHref("printers"),
  settingsTabHref("backup"),
  settingsTabHref("logs"),
];

/** The desktop of a Hybrid business — the only place the till split applies. */
export function isHybridSite(profile: DeploymentProfile, runtimeRole: DeploymentRole): boolean {
  return profile === "hybrid" && runtimeRole === "site";
}

export function isSiteLocalRoute(pathname: string): boolean {
  return SITE_LOCAL_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** The dashboard nav reduced to till screens; a group survives only with a till entry in it. */
export function tillNavItems<T extends NavNode>(items: readonly T[]): T[] {
  return items.flatMap((item) => {
    const children = item.children ? tillNavItems(item.children as T[]) : undefined;
    const local = item.href ? isSiteLocalRoute(item.href.split("?")[0]) : false;
    if (local) return [children ? { ...item, children } : item];
    if (!children?.length) return [];
    // A cloud page with till pages under it stays only as their group heading.
    return [{ ...item, href: undefined, children }];
  });
}

/** Where a signed-in member lands on the desktop (the assistant home is cloud-only). */
export function siteHomeFor(role: string): string {
  if (role === "kitchen") return ACCOUNTING_WORKSPACE_HREFS.kitchen;
  if (role === "waiter") return ACCOUNTING_WORKSPACE_HREFS.waiter;
  return ACCOUNTING_WORKSPACE_HREFS.pos;
}
