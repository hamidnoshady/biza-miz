/**
 * Which pages sit in the mobile bottom bar.
 *
 * A per-device preference, stored in `localStorage` like the sidebar's
 * expanded/collapsed state — a POS tablet parked at the pass wants different
 * shortcuts from the owner's phone, and both belong to the *device*, not to the
 * business row. Nothing here touches the network.
 */

import { canonicalPathForLegacy } from "./app-routes";

/**
 * How many pages the bar can hold, and now all it holds: the «پروفایل» button
 * that used to sit in the last slot is gone, since the drawer it opened is
 * already one tap away from the header's hamburger on every screen.
 */
export const BOTTOM_NAV_MAX = 4;

export const BOTTOM_NAV_STORAGE_KEY = "dashboard-bottom-nav";

/** The bar before anyone configures it — the set that shipped before this was a choice. */
const DEFAULT_HREFS = [
  "/dashboard",
  "/accounting/orders",
  "/accounting/reports",
];
/** On the sell screen, the cashier tab replaces reports so the active workflow stays visible. */
const DEFAULT_POS_HREFS = [
  "/dashboard",
  "/accounting/pos",
  "/accounting/orders",
];

/** Reads the stored list, tolerating anything a hand-edited localStorage might hold. */
export function parseBottomNavHrefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((href): href is string => typeof href === "string");
  } catch {
    return null;
  }
}

/**
 * The hrefs the bar should render.
 *
 * `availableHrefs` is the nav the member can actually see — already filtered by
 * industry, feature flag, role and permission upstream — so a page that stops
 * being visible (a flag switched off, a role changed) silently drops out of a
 * saved bar instead of rendering a link to a 403.
 */
export function resolveBottomNavHrefs(
  stored: string[] | null,
  availableHrefs: string[],
  onSellScreen: boolean,
): string[] {
  const preferred = stored?.length
    ? stored
    : onSellScreen
      ? DEFAULT_POS_HREFS
      : DEFAULT_HREFS;
  // A saved pre-migration shortcut is client-side state, not a reason to emit
  // a retired Dashboard address again. Upgrade it before comparing against the
  // current nav so it keeps its place in the bar without a redirect round trip.
  const canonicalPreferred = preferred.map(
    (href) => canonicalPathForLegacy(href) ?? href,
  );
  const picked = canonicalPreferred.filter((href) =>
    availableHrefs.includes(href),
  );
  // Deduped because the stored value is user-writable and two identical hrefs
  // would render two links with the same React key.
  return [...new Set(picked)].slice(0, BOTTOM_NAV_MAX);
}

/** Checkbox behaviour for the picker: toggles off freely, refuses to add past the cap. */
export function toggleBottomNavHref(current: string[], href: string): string[] {
  if (current.includes(href)) return current.filter((entry) => entry !== href);
  if (current.length >= BOTTOM_NAV_MAX) return current;
  return [...current, href];
}

/**
 * Priority order for adaptive mobile module selection when a tenant enables
 * additional modules (POS, CRM, Inventory, Accounting) inside the Android TWA
 * or when filling remaining authorized slots.
 */
const ADAPTIVE_MODULE_PRIORITY_HREFS = [
  "/dashboard",
  "/accounting/pos",
  "/accounting/orders",
  "/crm/customers",
  "/crm",
  "/inventory/items",
  "/inventory",
  "/accounting/reports",
  "/accounting/invoices",
  "/settings",
];

/**
 * Resolves the primary bottom-navigation hrefs and the overflow ("More") hrefs
 * from the canonical authorized `availableHrefs` list, ensuring primary slots
 * never exceed `BOTTOM_NAV_MAX` and every remaining authorized destination is
 * reachable via the "More" sheet.
 */
export function resolveAdaptiveBottomNavHrefs(
  stored: string[] | null,
  availableHrefs: string[],
  onSellScreen: boolean,
): { primaryHrefs: string[]; moreHrefs: string[] } {
  const basePrimary = resolveBottomNavHrefs(stored, availableHrefs, onSellScreen);
  const picked = [...basePrimary];

  if (!stored?.length && picked.length < BOTTOM_NAV_MAX) {
    for (const candidate of ADAPTIVE_MODULE_PRIORITY_HREFS) {
      if (picked.length >= BOTTOM_NAV_MAX) break;
      if (availableHrefs.includes(candidate) && !picked.includes(candidate)) {
        picked.push(candidate);
      }
    }
  }

  const primaryHrefs = picked.slice(0, BOTTOM_NAV_MAX);
  const moreHrefs = availableHrefs.filter((href) => !primaryHrefs.includes(href));
  return { primaryHrefs, moreHrefs };
}

