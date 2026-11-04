/**
 * The official, installable release of the WooCommerce plugin.
 *
 * One source of truth: the overview's onboarding and the technical connection
 * panel must hand the owner the *same* artifact. It is the release zip whose
 * root is `pos-accounting-connector/` (WordPress installs it as-is) — never the
 * GitHub source zip and never the `update.json` manifest, which is what a
 * self-hosted auto-update points at, not something a person installs.
 *
 * Release runbook: docs/deployment/wordpress-plugin-updates.md.
 */
export const WORDPRESS_PLUGIN_ZIP_URL =
  "https://updates.eshobe.app/wordpress/pos-accounting-connector/pos-accounting-connector.zip";

/** The manifest the installed plugin polls for updates — shown, never installed. */
export const WORDPRESS_PLUGIN_UPDATE_MANIFEST_URL =
  "https://updates.eshobe.app/wordpress/pos-accounting-connector/update.json";
