/**
 * The Growth & Marketing app's section routing (Phase 36b, revised).
 *
 * The app used to be one route with an in-page section rail. It is now a real
 * app with one page per section, and — since the sidebar was handed to it —
 * its own **main** menu in the dashboard's app slot (src/lib/app-shells.ts),
 * rather than a second menu drawn inside the page next to the accounting nav.
 *
 * The section keys and their permission gate come from the capability
 * contract in `src/lib/growth-access.ts` (issue #764): one key per section,
 * the same key the section's data endpoints check. A cashier opens loyalty and
 * the gift-card lookup; the management dashboard and the compensation data
 * need `growth.view` / `commission.view`, which no floor preset carries.
 */

import type { Permission } from "@/lib/permissions";
import { canViewGrowthSection, GROWTH_SECTION_KEYS, type GrowthSectionKey } from "@/lib/growth-access";

// The keys and the gate live in the framework-free capability contract
// (src/lib/growth-access.ts, issue #764) so the launcher in `apps.ts`, the
// API handlers and this menu all read one definition.
export { canOpenGrowth, canViewGrowthSection, GROWTH_SECTION_KEYS, type GrowthSectionKey } from "@/lib/growth-access";

/** Growth's own settings page — never the platform settings page. */
export const GROWTH_SETTINGS_HREF = "/growth/settings";

/** The route for a section. The overview is the app root; the rest nest under it. */
export function growthSectionHref(key: GrowthSectionKey): string {
  return key === "overview" ? "/growth/overview" : `/growth/${key}`;
}

export function growthFallbackHref(permissions: ReadonlySet<Permission>): string {
  const section = GROWTH_SECTION_KEYS.find((key) => canViewGrowthSection(permissions, key));
  return section ? growthSectionHref(section) : "/dashboard";
}

/**
 * Whether a dashboard path is a given section — the app's own sidebar's idea of
 * "you are here". The overview is the app root, so it is *only* active on
 * `/growth/overview` itself; a section lights up on its page and anything
 * nested under it. Without the exact match on the root, every section page would
 * highlight «میز کار رشد» as well and the menu would have two answers.
 */
export function isGrowthSectionPathname(pathname: string, key: GrowthSectionKey): boolean {
  const href = growthSectionHref(key);
  return key === "overview"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}
