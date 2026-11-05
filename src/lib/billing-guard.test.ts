/**
 * Unit tests for the API billing gate. The billing facade is mocked so we can
 * drive the guard's success / no-credits / not-entitled / unexpected-error
 * branches without a database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the facade the guard calls.
vi.mock("./billing-service", () => ({
  billFeatureUse: vi.fn(),
  previewFeatureUse: vi.fn(),
  FeatureNotEntitledError: class FeatureNotEntitledError extends Error {
    featureKey: string;
    constructor(featureKey: string) {
      super("feature_not_entitled");
      this.featureKey = featureKey;
    }
  },
}));
// next/server is used only for NextResponse; import the real one.
import { billFeatureUse, FeatureNotEntitledError, previewFeatureUse } from "./billing-service";
import { chargeForFeature, preflightFeatureUse } from "./billing-guard";
import { WalletInsufficientFundsError } from "./wallet-service";

afterEach(() => vi.restoreAllMocks());

describe("chargeForFeature", () => {
  it("returns ok with the charged flag on a successful paid use", async () => {
    vi.mocked(billFeatureUse).mockResolvedValue({
      charged: true,
      priceRial: 50_000,
      balanceRial: 950_000,
      access: {} as never,
    });
    const r = await chargeForFeature("b1", "backup", { note: "n" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.charged).toBe(true);
      expect(r.balanceRial).toBe(950_000);
    }
  });

  it("returns ok with charged=false on a free use", async () => {
    vi.mocked(billFeatureUse).mockResolvedValue({
      charged: false,
      priceRial: 0,
      balanceRial: 1000,
      access: {} as never,
    });
    const r = await chargeForFeature("b1", "backup");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.charged).toBe(false);
  });

  it("maps insufficient credits to a 402 response with a top-up URL", async () => {
    vi.mocked(billFeatureUse).mockRejectedValue(
      new WalletInsufficientFundsError(50_000, 10_000),
    );
    const r = await chargeForFeature("b1", "backup");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("insufficient_credits");
      expect(r.response).toBeTruthy();
      expect(r.response.status).toBe(402);
      const body = await r.response.json();
      expect(body.topUpUrl).toBe("/settings/billing");
      expect(body.balanceRial).toBe(10_000);
      expect(body.requiredRial).toBe(50_000);
    }
  });

  it("maps a missing entitlement to a 403 response", async () => {
    vi.mocked(billFeatureUse).mockRejectedValue(new FeatureNotEntitledError("integrations"));
    const r = await chargeForFeature("b1", "integrations");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("feature_not_entitled");
      expect(r.response.status).toBe(403);
      const body = await r.response.json();
      expect(body.topUpUrl).toContain("/settings/billing");
    }
  });

  it("rethrows an unexpected error rather than letting work through free", async () => {
    vi.mocked(billFeatureUse).mockRejectedValue(new Error("db exploded"));
    await expect(chargeForFeature("b1", "backup")).rejects.toThrow("db exploded");
  });
});

describe("preflightFeatureUse (issue #903)", () => {
  it("approves a chargeable use without debiting anything", async () => {
    vi.mocked(previewFeatureUse).mockResolvedValue({
      entitled: true,
      metered: true,
      priceRial: 5_000,
      balanceRial: 50_000,
      promoActive: false,
      freeUsesRemaining: null,
    });
    const r = await preflightFeatureUse("b1", "backup");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.willCharge).toBe(true);
      expect(r.priceRial).toBe(5_000);
    }
    expect(billFeatureUse).not.toHaveBeenCalled();
  });

  it("treats an unpriced or promo use as free but still allowed", async () => {
    vi.mocked(previewFeatureUse).mockResolvedValue({
      entitled: true,
      metered: true,
      priceRial: 0,
      balanceRial: 0,
      promoActive: true,
      freeUsesRemaining: 3,
    });
    const r = await preflightFeatureUse("b1", "backup");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.willCharge).toBe(false);
  });

  it("refuses an unentitled feature with 403 and an unaffordable one with 402", async () => {
    vi.mocked(previewFeatureUse).mockResolvedValue({
      entitled: false,
      metered: false,
      priceRial: 0,
      balanceRial: 0,
      promoActive: false,
      freeUsesRemaining: null,
    });
    const denied = await preflightFeatureUse("b1", "backup");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);

    vi.mocked(previewFeatureUse).mockResolvedValue({
      entitled: true,
      metered: true,
      priceRial: 50_000,
      balanceRial: 10_000,
      promoActive: false,
      freeUsesRemaining: null,
    });
    const poor = await preflightFeatureUse("b1", "backup");
    expect(poor.ok).toBe(false);
    if (!poor.ok) {
      expect(poor.response.status).toBe(402);
      expect(poor.balanceRial).toBe(10_000);
      expect(poor.priceRial).toBe(50_000);
    }
  });

  it("rethrows an entitlement read failure instead of running the work free", async () => {
    vi.mocked(previewFeatureUse).mockRejectedValue(new Error("db down"));
    await expect(preflightFeatureUse("b1", "backup")).rejects.toThrow("db down");
  });
});
