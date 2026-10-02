// src/lib/site-routes.ts
/**
 * Phase 45 — which screens a Hybrid desktop renders itself.
 *
 * The cloud is the system of record; the desktop is the till. Selling, floor
 * & kitchen, shifts and this computer's own settings run on the local server
 * and keep working offline. Every other screen is cloud-by-default: since
 * Phase 46 the desktop shows it in its own content area (`CloudPane`) under
 * the full menu, instead of a partial local copy that disagrees with the
 * cloud. A screen added later is therefore cloud unless someone adds it here
 * on purpose (and gives its writes a sync event).
 *
 * Framework-free and unit-tested; the dashboard gate, the cloud pane and the
 * home redirect all read this one list.
 */
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";
import type { ModuleKey } from "./industry-profile";
import { canUsePos, PERMISSIONS } from "./permissions";
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

/** What decides whether a member can open each till screen — the same checks those pages apply. */
export interface SiteHomeFacts {
  role: string;
  /** The trade's modules (`requireModuleForPage`). */
  hasModule: (module: ModuleKey) => boolean;
  /** The `reservations` feature, which «میزهای من» also requires. */
  reservations: boolean;
  permissions: ReadonlySet<string>;
}

/**
 * Where a signed-in member lands on the desktop (the assistant home is
 * cloud-only): their role's screen first, then the till, then the orders
 * list — the first one they can actually open. Null when none is: the home
 * explains instead of redirecting to a page that would bounce back.
 */
export function siteHomeFor(facts: SiteHomeFacts): string | null {
  const { hasModule, permissions } = facts;
  const openable: Record<string, boolean> = {
    [ACCOUNTING_WORKSPACE_HREFS.kitchen]: hasModule("kitchen") && permissions.has(PERMISSIONS.kitchenView),
    [ACCOUNTING_WORKSPACE_HREFS.waiter]:
      hasModule("waiter") && facts.reservations && permissions.has(PERMISSIONS.ordersCreate),
    [ACCOUNTING_WORKSPACE_HREFS.pos]: hasModule("pos") && canUsePos(permissions),
    [ACCOUNTING_WORKSPACE_HREFS.orders]: hasModule("orders") && permissions.has(PERMISSIONS.ordersView),
  };
  const roleHome =
    facts.role === "kitchen"
      ? ACCOUNTING_WORKSPACE_HREFS.kitchen
      : facts.role === "waiter"
        ? ACCOUNTING_WORKSPACE_HREFS.waiter
        : ACCOUNTING_WORKSPACE_HREFS.pos;
  return [roleHome, ACCOUNTING_WORKSPACE_HREFS.pos, ACCOUNTING_WORKSPACE_HREFS.orders].find((href) => openable[href]) ?? null;
}
