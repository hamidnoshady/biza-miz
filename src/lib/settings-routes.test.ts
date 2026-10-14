import { describe, expect, it } from "vitest";
import { APP_SETTINGS_HREFS, PLATFORM_SETTINGS_HOME } from "./app-routes";
import {
  PLATFORM_SETTINGS_PAGES,
  canonicalSettingsHrefForTabParam,
  isPlatformSettingsPage,
  settingsTabForSlug,
  settingsTabHref,
} from "./settings-routes";
import { SETTINGS_TAB_KEYS } from "./settings-tabs";

describe("settings section URLs", () => {
  it("gives every settings tab a real URL under /settings", () => {
    for (const key of SETTINGS_TAB_KEYS) {
      const href = settingsTabHref(key);
      expect(href.startsWith(`${PLATFORM_SETTINGS_HOME}/`)).toBe(true);
      // …and the URL resolves back to the tab it came from, so the rail's link
      // and the route's lookup cannot drift apart.
      expect(settingsTabForSlug(href.slice(PLATFORM_SETTINGS_HOME.length + 1))).toBe(key);
    }
  });

  it("gives every section a distinct URL", () => {
    const hrefs = SETTINGS_TAB_KEYS.map(settingsTabHref);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("spells the security centre «security»", () => {
    expect(settingsTabHref("security-center")).toBe("/settings/security");
    expect(settingsTabForSlug("security")).toBe("security-center");
    // The key itself still resolves, so an old link is not a dead end.
    expect(settingsTabForSlug("security-center")).toBe("security-center");
  });

  it("rejects a slug that is not a settings section", () => {
    expect(settingsTabForSlug("nope")).toBeNull();
    expect(settingsTabForSlug("")).toBeNull();
  });

  it("keeps the non-tab platform pages out of the tab table", () => {
    for (const page of PLATFORM_SETTINGS_PAGES) {
      expect(isPlatformSettingsPage(page)).toBe(true);
      // They are real pages of their own, not sections of the settings manager.
      expect(settingsTabForSlug(page)).toBeNull();
    }
    expect(PLATFORM_SETTINGS_PAGES).toContain("billing");
    expect(PLATFORM_SETTINGS_PAGES).toContain("subscription");
  });

  it("never names an app's settings page", () => {
    // The separation, stated as a test: no platform settings URL is an app's,
    // and no app's settings URL is a platform section.
    for (const href of Object.values(APP_SETTINGS_HREFS)) {
      expect(href.startsWith(`${PLATFORM_SETTINGS_HOME}/`)).toBe(false);
      const slug = href.split("/").pop()!;
      // «settings» is the last segment of every app settings route; it must not
      // be a platform section slug.
      expect(settingsTabForSlug(slug)).toBeNull();
      expect(isPlatformSettingsPage(slug)).toBe(false);
    }
  });
});

describe("canonicalSettingsHrefForTabParam", () => {
  it("turns an old ?tab= deep link into the section's URL", () => {
    expect(canonicalSettingsHrefForTabParam("team")).toBe("/settings/team");
    expect(canonicalSettingsHrefForTabParam("printers")).toBe("/settings/printers");
    expect(canonicalSettingsHrefForTabParam("security-center")).toBe("/settings/security");
  });

  it("keeps answering the tab names the product renamed", () => {
    expect(canonicalSettingsHrefForTabParam("branch-sync")).toBe("/settings/branch-management");
  });

  it("leaves an absent or unknown tab alone", () => {
    expect(canonicalSettingsHrefForTabParam(null)).toBeNull();
    expect(canonicalSettingsHrefForTabParam("")).toBeNull();
    expect(canonicalSettingsHrefForTabParam("nope")).toBeNull();
  });
});
