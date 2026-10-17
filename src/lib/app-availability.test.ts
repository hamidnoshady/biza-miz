import { describe, expect, it } from "vitest";
import {
  APP_AVAILABILITY_META,
  APP_AVAILABILITY_STATES,
  DEFAULT_APP_AVAILABILITY,
  appForApiPath,
  appForPagePath,
  isAppAvailabilityState,
  isAppUsable,
  parseAppKey,
  resolveAppAvailability,
  type AppAvailabilityMap,
} from "./app-availability";
import { APP_KEYS } from "./apps";

describe("the availability vocabulary", () => {
  it("has metadata for every state, and only `available` is silent", () => {
    for (const state of APP_AVAILABILITY_STATES) {
      expect(APP_AVAILABILITY_META[state].state).toBe(state);
      expect(APP_AVAILABILITY_META[state].label).not.toBe("");
    }
    expect(APP_AVAILABILITY_META.available.badged).toBe(false);
    for (const state of APP_AVAILABILITY_STATES.filter(
      (s) => s !== "available",
    )) {
      expect(APP_AVAILABILITY_META[state].badged).toBe(true);
    }
  });

  it("blocks coming_soon / maintenance / disabled, and lets beta through", () => {
    expect(APP_AVAILABILITY_META.available.usable).toBe(true);
    // A beta is shipped software that merely wants labelling — blocking it
    // would make the state useless for the thing operators want it for.
    expect(APP_AVAILABILITY_META.beta.usable).toBe(true);
    expect(APP_AVAILABILITY_META.coming_soon.usable).toBe(false);
    expect(APP_AVAILABILITY_META.maintenance.usable).toBe(false);
    expect(APP_AVAILABILITY_META.disabled.usable).toBe(false);
  });

  it("gives every blocking state something to tell the business", () => {
    for (const state of APP_AVAILABILITY_STATES) {
      if (APP_AVAILABILITY_META[state].usable && state === "available")
        continue;
      expect(APP_AVAILABILITY_META[state].defaultNotice.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("accepts only the known states off the wire", () => {
    expect(isAppAvailabilityState("maintenance")).toBe(true);
    expect(isAppAvailabilityState("off")).toBe(false);
    expect(isAppAvailabilityState(null)).toBe(false);
    expect(isAppAvailabilityState(3)).toBe(false);
  });
});

describe("resolveAppAvailability", () => {
  it("defaults an app with no row anywhere to available and unbadged", () => {
    const resolved = resolveAppAvailability("accounting", null);
    expect(resolved).toMatchObject({
      app: "accounting",
      state: "available",
      source: "platform",
      usable: true,
      badged: false,
      notice: "",
    });
    expect(DEFAULT_APP_AVAILABILITY.state).toBe("available");
  });

  it("uses the platform row when the business has no override", () => {
    const resolved = resolveAppAvailability("crm", {
      state: "coming_soon",
      note: null,
      availableFrom: "2026-09-01",
    });
    expect(resolved.source).toBe("platform");
    expect(resolved.usable).toBe(false);
    expect(resolved.availableFrom).toBe("2026-09-01");
    // No operator note falls back to the state's stock sentence.
    expect(resolved.notice).toBe(
      APP_AVAILABILITY_META.coming_soon.defaultNotice,
    );
  });

  it("lets a per-business override replace the platform row wholesale", () => {
    const resolved = resolveAppAvailability(
      "growth",
      {
        state: "maintenance",
        note: "ارتقای سرور",
        availableFrom: "2026-09-01",
      },
      { state: "beta", note: null, availableFrom: null },
    );
    expect(resolved.source).toBe("business");
    expect(resolved.state).toBe("beta");
    expect(resolved.usable).toBe(true);
    // Nothing of the platform row leaks through — not the note, not the date.
    expect(resolved.availableFrom).toBeNull();
    expect(resolved.notice).toBe(APP_AVAILABILITY_META.beta.defaultNotice);
  });

  it("shows the operator's own words when they wrote some", () => {
    const resolved = resolveAppAvailability("accounting", {
      state: "maintenance",
      note: "  تا ساعت ۱۸ برمی‌گردیم  ",
      availableFrom: null,
    });
    expect(resolved.note).toBe("تا ساعت ۱۸ برمی‌گردیم");
    expect(resolved.notice).toBe("تا ساعت ۱۸ برمی‌گردیم");
  });

  it("treats a whitespace-only note as no note", () => {
    const resolved = resolveAppAvailability("accounting", {
      state: "disabled",
      note: "   ",
      availableFrom: null,
    });
    expect(resolved.note).toBeNull();
    expect(resolved.notice).toBe(APP_AVAILABILITY_META.disabled.defaultNotice);
  });
});

describe("isAppUsable", () => {
  const map = {
    accounting: resolveAppAvailability("accounting", {
      state: "maintenance",
      note: null,
      availableFrom: null,
    }),
  } as unknown as AppAvailabilityMap;

  it("blocks an app the map says is down", () => {
    expect(isAppUsable(map, "accounting")).toBe(false);
  });

  it("fails open for a route with no owning app, or an app the map lacks", () => {
    expect(isAppUsable(map, null)).toBe(true);
    expect(isAppUsable(map, "crm")).toBe(true);
    expect(isAppUsable(undefined, "accounting")).toBe(true);
  });
});

describe("route → app", () => {
  it("maps a canonical workspace page to the app that owns its module", () => {
    expect(appForPagePath("/accounting/inventory")).toBe("accounting");
    expect(appForPagePath("/accounting/pos")).toBe("accounting");
    expect(appForPagePath("/crm/segments")).toBe("crm");
    expect(appForPagePath("/growth")).toBe("growth");
    expect(appForPagePath("/websites/wp/products")).toBe("website");
  });

  it("maps an API route the same way", () => {
    expect(appForApiPath("/api/orders")).toBe("accounting");
    expect(appForApiPath("/api/inventory/purchases/1")).toBe("accounting");
    expect(
      appForApiPath("/api/accounting/shareholders/distributions"),
    ).toBe("accounting");
    expect(appForApiPath("/api/crm/cases")).toBe("crm");
    expect(appForApiPath("/api/integrations/wp-manager/overview")).toBe(
      "website",
    );
  });

  it("leaves the shell surfaces ungated — the explanation screen has to be reachable", () => {
    expect(appForPagePath("/dashboard")).toBeNull();
    // Phase G — «میز کار من» is platform furniture, not a product a business
    // can be sold without, so it is never availability-gated.
    expect(appForPagePath("/workspace")).toBeNull();
    expect(appForPagePath("/workspace/contracts")).toBeNull();
    expect(appForPagePath("/ai")).toBeNull();
    // The «اتصال‌های فنی» hub is a shell utility, not an app: turning a
    // platform off must never lock the page that holds its credentials.
    expect(appForPagePath("/settings/connections")).toBeNull();
    expect(appForPagePath("/settings")).toBeNull();
    expect(appForPagePath("/support")).toBeNull();
    expect(appForApiPath("/api/auth/login")).toBeNull();
  });
});

describe("parseAppKey", () => {
  it("accepts every key in the registry and nothing else", () => {
    for (const key of APP_KEYS) expect(parseAppKey(key)).toBe(key);
    expect(parseAppKey("nope")).toBeNull();
    expect(parseAppKey(null)).toBeNull();
    expect(parseAppKey(7)).toBeNull();
  });
});
