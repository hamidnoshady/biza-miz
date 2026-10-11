/**
 * The platform settings area's URLs.
 *
 * «تنظیمات» used to be one page with an in-page rail and a `?tab=` parameter,
 * which meant the whole platform settings area had a single address: a member
 * could not bookmark «تیم», a link in a guide could only point at the page and
 * hope, and an app's settings link had nothing more specific to aim at than
 * the whole thing. Each section is a real URL now — `/settings/team`,
 * `/settings/security` — and the rail navigates between them.
 *
 * Two kinds of entry live here:
 *
 *  - the tabs of the settings manager (`settings-tabs.ts`, `SETTINGS_TAB_KEYS`), whose
 *    slug is usually their key; `security` and `sync` are shorter, friendlier
 *    spellings of keys the code already had.
 *  - the platform sections that are **not** tabs — the member's own profile,
 *    platform billing, the subscription, the technical connections hub. They
 *    are listed here too because the point of this table is to answer "is this
 *    URL part of platform settings, and what is it called", which the sidebar,
 *    the middleware tests and every app's settings page all ask.
 *
 * What is emphatically *not* here: an app's own settings. `/accounting/settings`,
 * `/growth/settings`, `/crm/settings` and `/websites/settings` are the apps'
 * own routes with their own components (see `APP_SETTINGS_HREFS` in
 * `app-routes.ts`). Keeping the two tables apart is what makes "an app's
 * settings page must never be the platform settings page" checkable.
 *
 * Framework-free, so the Edge middleware, the server pages and the client rail
 * all read the same rules.
 */

import { PLATFORM_SETTINGS_HOME } from "./app-routes";
import { SETTINGS_TAB_KEYS, type SettingsTabKey } from "./settings-tabs";

/**
 * Slug → tab key, for the sections the settings manager renders.
 *
 * Only the ones whose slug differs from the key need an entry; every other tab
 * is its own slug, which `settingsTabForSlug` falls back to. Spelled out both
 * ways so a rename cannot leave one direction behind.
 */
const SLUG_TO_TAB: Record<string, SettingsTabKey> = {
  // «امنیت» is what the section is called; `security-center` is the key it was
  // given when it was a tab.
  security: "security-center",
  // Team membership has always been «تیم» in the URL people share.
  team: "team",
};

const TAB_TO_SLUG: Partial<Record<SettingsTabKey, string>> = {
  "security-center": "security",
};

/** The canonical URL of a settings tab. */
export function settingsTabHref(key: SettingsTabKey): string {
  return `${PLATFORM_SETTINGS_HOME}/${TAB_TO_SLUG[key] ?? key}`;
}

/** The tab a slug names, or null when the slug is not a settings tab. */
export function settingsTabForSlug(slug: string): SettingsTabKey | null {
  const mapped = SLUG_TO_TAB[slug];
  if (mapped) return mapped;
  return (SETTINGS_TAB_KEYS as readonly string[]).includes(slug) ? (slug as SettingsTabKey) : null;
}

/**
 * The platform sections that are not tabs of the settings manager.
 *
 * Each is a real page of its own. `billing` and `subscription` are here rather
 * than inside any app on purpose: money is platform-owned, so an app may link
 * to these URLs but must never grow its own copy of them.
 */
export const PLATFORM_SETTINGS_PAGES = [
  "profile",
  "billing",
  "subscription",
  "connections",
] as const;
export type PlatformSettingsPage = (typeof PLATFORM_SETTINGS_PAGES)[number];

export function isPlatformSettingsPage(slug: string): slug is PlatformSettingsPage {
  return (PLATFORM_SETTINGS_PAGES as readonly string[]).includes(slug);
}

/**
 * The old `?tab=` deep links, resolved to the canonical URL.
 *
 * `/settings?tab=team` → `/settings/team`, query otherwise untouched. Returns
 * null when there is nothing to canonicalise, so the caller can leave the URL
 * alone rather than bouncing every visit through a redirect.
 */
export function canonicalSettingsHrefForTabParam(tab: string | null): string | null {
  if (!tab) return null;
  // Two spellings the product renamed but kept answering.
  if (tab === "branch-sync") return settingsTabHref("branch-management");
  const key = settingsTabForSlug(tab);
  return key ? settingsTabHref(key) : null;
}
