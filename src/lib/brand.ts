/**
 * The platform's name, in one place.
 *
 * The product is «بیزامیز» in Persian and "Bizamiz" in English. Persian UI
 * (the web app, the WordPress admin on a Persian site, the desktop shell on a
 * Persian Windows) shows the Persian name; English UI shows the Latin one.
 * Anything that picks a language at runtime asks `brandName()` instead of
 * spelling either form, so a future rename is a change to this file.
 *
 * Deliberately import-free: client components, the Electron shell's docs and
 * the Android/WordPress copies all quote these exact strings
 * (`src/lib/brand.test.ts` pins them).
 *
 * What the name is NOT: a technical identifier. Package ids, bundle ids, the
 * `businesssuite://` protocol, the WordPress plugin slug, database names and
 * env var names keep their historical spelling (see docs/architecture/branding.md).
 */

export const BRAND_NAME_FA = "بیزامیز";
export const BRAND_NAME_EN = "Bizamiz";

export type BrandLocale = "fa" | "en";

/** The one-line descriptor used under the name in each language. */
export const BRAND_TAGLINE_FA = "پلتفرم مدیریت کسب‌وکار";
export const BRAND_TAGLINE_EN = "Business management platform";

/** Persian unless the locale is clearly something else — the product is Persian-first. */
export function brandLocale(locale: string | null | undefined): BrandLocale {
  const tag = (locale ?? "").trim().toLowerCase();
  if (!tag || tag.startsWith("fa")) return "fa";
  return "en";
}

/** The product name for a UI language (`fa`, `fa-IR`, `en`, `en-US`, …). */
export function brandName(locale?: string | null): string {
  return brandLocale(locale) === "fa" ? BRAND_NAME_FA : BRAND_NAME_EN;
}

export function brandTagline(locale?: string | null): string {
  return brandLocale(locale) === "fa" ? BRAND_TAGLINE_FA : BRAND_TAGLINE_EN;
}
