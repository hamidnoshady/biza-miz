import { describe, expect, it } from "vitest";
import {
  EMPTY_SITE_PROFILE_STATE,
  siteProfileFailed,
  siteProfileHash,
  siteProfileSucceeded,
  validateSiteProfile,
  type SiteProfile,
} from "./site-profile";

const profile: SiteProfile = {
  schemaVersion: 1,
  location: {
    id: "b74b6234-5af6-4ba2-9cc7-1c6492c3e04b",
    name: "شعبه مرکزی",
    address: null,
    phone: "02100000000",
    timezone: "Asia/Tehran",
    businessDayStartMinutes: 1080,
    isActive: true,
  },
  features: { ai_assistant: false, reservations: true },
  apps: { growth: { state: "maintenance", note: null, availableFrom: null } },
};

describe("validateSiteProfile", () => {
  it("accepts what the cloud sends", () => {
    expect(validateSiteProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it("refuses a body it cannot trust, rather than applying part of it", () => {
    const bad = [
      null,
      { ...profile, schemaVersion: 2 },
      { ...profile, location: { ...profile.location, id: "x" } },
      { ...profile, location: { ...profile.location, businessDayStartMinutes: 1440 } },
      { ...profile, location: { ...profile.location, timezone: "" } },
      { ...profile, features: { ai_assistant: "no" } },
      { ...profile, apps: { growth: { state: 3, note: null, availableFrom: null } } },
      { ...profile, apps: { growth: { state: "available", note: 5, availableFrom: null } } },
      { ...profile, apps: { growth: "maintenance" } },
      { ...profile, apps: { growth: { state: "coming_soon", note: null, availableFrom: "1405-07-08" } } },
    ];
    for (const raw of bad) expect(validateSiteProfile(raw)).toBeNull();
  });

  it("drops an app the desktop does not know yet, and keeps the rest", () => {
    const newer = { ...profile, apps: { ...profile.apps, nosuchapp: { state: "available", note: null, availableFrom: null } } };
    expect(validateSiteProfile(newer)).toEqual(profile);
  });

  it("drops a state the desktop does not know yet, and keeps the rest", () => {
    const newer = { ...profile, apps: { ...profile.apps, crm: { state: "sunsetting", note: null, availableFrom: null } } };
    expect(validateSiteProfile(newer)).toEqual(profile);
  });

  it("accepts a feature switch the desktop does not know yet (the apply skips it)", () => {
    const newer = { ...profile, features: { ...profile.features, brand_new_flag: true } };
    expect(validateSiteProfile(newer)?.features).toEqual({ ...profile.features, brand_new_flag: true });
  });
});

describe("siteProfileHash", () => {
  it("does not depend on key order", () => {
    const reordered = { ...profile, features: { reservations: true, ai_assistant: false } };
    expect(siteProfileHash(reordered)).toBe(siteProfileHash(profile));
    expect(siteProfileHash({ ...profile, features: { ...profile.features, ai_assistant: true } })).not.toBe(siteProfileHash(profile));
  });
});

describe("site profile state", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");

  it("records when a changed profile was applied and clears a failure", () => {
    const failed = siteProfileFailed(EMPTY_SITE_PROFILE_STATE, "HTTP 502", now, () => 0.5);
    const next = siteProfileSucceeded(failed, "h1", true, now);
    expect(next).toEqual({ hash: "h1", appliedAt: now.toISOString(), checkedAt: now.toISOString(), lastError: null, failures: 0, nextAttemptAt: null });
  });

  it("keeps the old applied time when nothing changed", () => {
    const applied = siteProfileSucceeded(EMPTY_SITE_PROFILE_STATE, "h1", true, new Date("2026-09-29T00:00:00.000Z"));
    expect(siteProfileSucceeded(applied, "h1", false, now).appliedAt).toBe("2026-09-29T00:00:00.000Z");
  });

  it("keeps the last copy and backs off on failure", () => {
    const applied = siteProfileSucceeded(EMPTY_SITE_PROFILE_STATE, "h1", true, now);
    const failed = siteProfileFailed(applied, "site_profile_rejected: HTTP 404", now, () => 0.5);
    expect(failed.hash).toBe("h1");
    expect(failed.failures).toBe(1);
    expect(failed.lastError).toBe("site_profile_rejected: HTTP 404");
    expect(Date.parse(failed.nextAttemptAt!)).toBeGreaterThan(now.getTime());
  });
});
