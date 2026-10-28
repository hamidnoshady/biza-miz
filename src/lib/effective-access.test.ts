import { describe, expect, it } from "vitest";
import { resolveCommercialLayer, resolveFlagLayer } from "./effective-access";

describe("resolveFlagLayer", () => {
  it("uses the catalogue default when nothing overrides it", () => {
    expect(resolveFlagLayer({ catalogueDefault: true, businessOverride: null, billingOverride: null })).toEqual({
      enabled: true,
      source: "catalogue_default",
    });
    expect(resolveFlagLayer({ catalogueDefault: false, businessOverride: null, billingOverride: null })).toEqual({
      enabled: false,
      source: "catalogue_default",
    });
  });

  it("lets a business override re-enable a globally-off flag and switch a default-on one off", () => {
    expect(resolveFlagLayer({ catalogueDefault: false, businessOverride: true, billingOverride: null }).enabled).toBe(true);
    expect(resolveFlagLayer({ catalogueDefault: true, businessOverride: false, billingOverride: null }).enabled).toBe(false);
  });

  it("makes the audited billing override outrank the legacy business row in both directions", () => {
    expect(
      resolveFlagLayer({ catalogueDefault: true, businessOverride: true, billingOverride: false }),
    ).toEqual({ enabled: false, source: "billing_override" });
    expect(
      resolveFlagLayer({ catalogueDefault: false, businessOverride: false, billingOverride: true }),
    ).toEqual({ enabled: true, source: "billing_override" });
  });

  it("does not gate a key that has no catalogue row", () => {
    expect(resolveFlagLayer({ catalogueDefault: null, businessOverride: null, billingOverride: null })).toEqual({
      enabled: true,
      source: "unregistered",
    });
    // …but an explicit switch-off on it is still honoured.
    expect(resolveFlagLayer({ catalogueDefault: null, businessOverride: false, billingOverride: null }).enabled).toBe(false);
  });
});

describe("resolveCommercialLayer", () => {
  it("leaves an unpriced capability to the flag layer alone", () => {
    expect(resolveCommercialLayer({ access: null })).toEqual({ allowed: true, priced: false, reason: null });
  });

  it("allows an entitled capability: plan inclusion, owned add-on, promo or manual grant", () => {
    for (const source of ["plan", "addon", "promo", "manual"] as const) {
      expect(resolveCommercialLayer({ access: { entitled: true, metered: false, source } })).toEqual({
        allowed: true,
        priced: true,
        reason: null,
      });
    }
  });

  it("refuses an add-on the business has not bought", () => {
    expect(
      resolveCommercialLayer({ access: { entitled: false, metered: false, source: null } }),
    ).toEqual({ allowed: false, priced: true, reason: "addon_required" });
  });

  it("names a lapsed subscription when a plan inclusion stopped carrying the business", () => {
    expect(
      resolveCommercialLayer({
        access: { entitled: false, metered: false, source: "plan" },
        subscriptionCarrying: false,
      }),
    ).toEqual({ allowed: false, priced: true, reason: "subscription_expired" });
  });

  it("falls back to addon_required when the caller never read the subscription", () => {
    expect(
      resolveCommercialLayer({ access: { entitled: false, metered: false, source: "plan" } }).reason,
    ).toBe("addon_required");
  });

  it("keeps pay-as-you-go reachable after the subscription lapsed", () => {
    expect(
      resolveCommercialLayer({
        access: { entitled: false, metered: true, source: "plan" },
        subscriptionCarrying: false,
      }),
    ).toEqual({ allowed: true, priced: true, reason: null });
  });
});
