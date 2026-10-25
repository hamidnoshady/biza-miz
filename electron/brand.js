"use strict";

/**
 * The platform's name for the desktop shell.
 *
 * Mirrors src/lib/brand.ts (the Electron main process cannot import the web
 * app's TypeScript); src/lib/brand.test.ts pins the two copies together.
 * Persian Windows shows «بیزامیز», every other locale shows "Bizamiz".
 */

const BRAND_NAME_FA = "بیزامیز";
const BRAND_NAME_EN = "Bizamiz";

/** `fa`, `fa-IR`, … → Persian. Anything else → English. Empty → Persian (Persian-first product). */
function brandLocale(locale) {
  const tag = String(locale ?? "").trim().toLowerCase();
  if (!tag || tag.startsWith("fa")) return "fa";
  return "en";
}

function brandName(locale) {
  return brandLocale(locale) === "fa" ? BRAND_NAME_FA : BRAND_NAME_EN;
}

/** Picks the Persian or English variant of a message by locale. */
function byLocale(locale, variants) {
  return brandLocale(locale) === "fa" ? variants.fa : variants.en;
}

module.exports = { BRAND_NAME_FA, BRAND_NAME_EN, brandLocale, brandName, byLocale };
