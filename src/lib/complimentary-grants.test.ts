import { describe, expect, it } from "vitest";
import {
  SignupPolicyError,
  coveredSecondsForGrant,
  dueGrantNotices,
  grantExpiryFor,
  grantNoticeKey,
  grantStatusAt,
  isComplimentaryMode,
  normalizeSignupPolicyInput,
  quoteComplimentaryActivation,
  resolveSignupAppPolicy,
  type ComplimentaryGrant,
  type SignupAppPolicy,
} from "./complimentary-grants";

function policy(overrides: Partial<SignupAppPolicy> = {}): SignupAppPolicy {
  return {
    id: "p1",
    serviceKind: "app",
    serviceKey: "accounting",
    version: 1,
    scope: "global",
    businessType: null,
    businessId: null,
    mode: "free_days",
    freeDays: 30,
    waiveSetup: true,
    waiveRental: true,
    status: "active",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    reason: "",
    ...overrides,
  };
}

function grant(overrides: Partial<ComplimentaryGrant> = {}): ComplimentaryGrant {
  return {
    id: "g1",
    businessId: "b1",
    serviceKind: "app",
    serviceKey: "accounting",
    runtimeInstanceId: "",
    policyId: "p1",
    policyVersion: 1,
    source: "signup_policy",
    scope: "global",
    status: "active",
    startsAt: "2026-12-01T10:00:00.000Z",
    expiresAt: "2026-12-31T10:00:00.000Z",
    waiveSetup: true,
    waiveRental: true,
    activationId: "a1",
    ...overrides,
  };
}

const target = (overrides: Partial<Parameters<typeof resolveSignupAppPolicy>[1]> = {}) => ({
  businessId: "b1",
  businessType: "food_service",
  serviceKind: "app" as const,
  serviceKey: "accounting",
  at: "2026-06-01T00:00:00.000Z",
  ...overrides,
});

describe("signup policy precedence", () => {
  it("uses ordinary commercial pricing when no policy applies", () => {
    expect(resolveSignupAppPolicy([], target())).toBeNull();
  });

  it("applies a global free policy", () => {
    const resolved = resolveSignupAppPolicy([policy()], target());
    expect(resolved?.mode).toBe("free_days");
    expect(resolved?.freeDays).toBe(30);
  });

  it("prefers business over business-type over global even when the lower scope is newer", () => {
    const policies = [
      policy({ id: "global", scope: "global", version: 9 }),
      policy({ id: "type", scope: "business_type", businessType: "food_service", version: 20, mode: "free_indefinite" }),
      policy({ id: "biz", scope: "business", businessId: "b1", version: 1, mode: "standard" }),
    ];
    expect(resolveSignupAppPolicy(policies, target())?.id).toBe("biz");
  });

  it("does not fall through a higher-scope not_selectable decision", () => {
    const policies = [
      policy({ id: "global", scope: "global", mode: "free_days" }),
      policy({ id: "type", scope: "business_type", businessType: "food_service", mode: "not_selectable" }),
    ];
    expect(resolveSignupAppPolicy(policies, target())?.mode).toBe("not_selectable");
  });

  it("ignores a policy for another business type and an out-of-force revision", () => {
    const policies = [
      policy({ id: "other", scope: "business_type", businessType: "retail" }),
      policy({ id: "future", effectiveFrom: "2027-01-01T00:00:00.000Z" }),
      policy({ id: "closed", effectiveUntil: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(resolveSignupAppPolicy(policies, target())).toBeNull();
  });

  it("only accepts complimentary modes as free", () => {
    expect(isComplimentaryMode("free_days")).toBe(true);
    expect(isComplimentaryMode("free_indefinite")).toBe(true);
    expect(isComplimentaryMode("standard")).toBe(false);
    expect(isComplimentaryMode("not_selectable")).toBe(false);
  });
});

describe("policy validation", () => {
  const base = {
    serviceKind: "app" as const,
    serviceKey: "accounting",
    scope: "global" as const,
    mode: "free_days" as const,
    freeDays: 30,
  };

  it("rejects a non-positive duration", () => {
    expect(() => normalizeSignupPolicyInput({ ...base, freeDays: 0 })).toThrow(SignupPolicyError);
    expect(() => normalizeSignupPolicyInput({ ...base, freeDays: -5 })).toThrow(SignupPolicyError);
    expect(() => normalizeSignupPolicyInput({ ...base, freeDays: 1.5 })).toThrow(SignupPolicyError);
  });

  it("rejects a duration on a non-duration mode", () => {
    expect(() =>
      normalizeSignupPolicyInput({ ...base, mode: "free_indefinite", freeDays: 7 }),
    ).toThrow(SignupPolicyError);
  });

  it("requires the scope's exact target", () => {
    expect(() =>
      normalizeSignupPolicyInput({ ...base, scope: "business_type" }),
    ).toThrow(SignupPolicyError);
    expect(() => normalizeSignupPolicyInput({ ...base, scope: "business" })).toThrow(
      SignupPolicyError,
    );
    expect(() =>
      normalizeSignupPolicyInput({ ...base, scope: "global", businessType: "food_service" }),
    ).toThrow(SignupPolicyError);
  });

  it("refuses a free mode that waives neither charge", () => {
    expect(() =>
      normalizeSignupPolicyInput({ ...base, waiveSetup: false, waiveRental: false }),
    ).toThrow(SignupPolicyError);
  });

  it("keeps a partial waiver (setup only) valid", () => {
    const normalized = normalizeSignupPolicyInput({
      ...base,
      waiveSetup: true,
      waiveRental: false,
    });
    expect(normalized.waiveSetup).toBe(true);
    expect(normalized.waiveRental).toBe(false);
  });
});

describe("grant lifecycle and exact expiry", () => {
  it("ends a 30-day grant at the same UTC instant 30 days later", () => {
    expect(grantExpiryFor(policy({ freeDays: 30 }), "2026-12-01T10:00:00.000Z")).toBe(
      "2026-12-31T10:00:00.000Z",
    );
  });

  it("has no expiry for an indefinite grant", () => {
    expect(
      grantExpiryFor(policy({ mode: "free_indefinite", freeDays: null }), "2026-12-01T10:00:00.000Z"),
    ).toBeNull();
  });

  it("derives pending/active/expired/revoked from the stored window", () => {
    const g = grant();
    expect(grantStatusAt(g, "2026-11-30T00:00:00.000Z")).toBe("pending");
    expect(grantStatusAt(g, "2026-12-15T00:00:00.000Z")).toBe("active");
    expect(grantStatusAt(g, "2026-12-31T10:00:00.000Z")).toBe("expired");
    expect(grantStatusAt(grant({ status: "revoked" }), "2026-12-15T00:00:00.000Z")).toBe(
      "revoked",
    );
  });

  it("never keeps an indefinite grant free after revocation", () => {
    const indefinite = grant({ expiresAt: null, status: "revoked" });
    expect(grantStatusAt(indefinite, "2030-01-01T00:00:00.000Z")).toBe("revoked");
  });

  it("covers only the seconds inside the grant when a settlement crosses expiry", () => {
    // Interval 09:00 → 11:00 on the expiry day; grant ends at 10:00 → 1 hour free.
    expect(
      coveredSecondsForGrant(grant(), {
        start: "2026-12-31T09:00:00.000Z",
        end: "2026-12-31T11:00:00.000Z",
      }),
    ).toBe(3600);
    expect(
      coveredSecondsForGrant(grant(), {
        start: "2026-12-31T11:00:00.000Z",
        end: "2026-12-31T12:00:00.000Z",
      }),
    ).toBe(0);
  });

  it("covers the whole segment for an indefinite grant", () => {
    expect(
      coveredSecondsForGrant(grant({ expiresAt: null }), {
        start: "2030-01-01T00:00:00.000Z",
        end: "2030-01-01T01:00:00.000Z",
      }),
    ).toBe(3600);
  });
});

describe("complimentary quote", () => {
  it("waives setup and rental, needs no wallet deposit or subscription", () => {
    const quote = quoteComplimentaryActivation({
      publishedSetupRial: 5_000_000,
      hourlyRial: 120_000,
      grant: grant(),
      additionalCharges: ["ai"],
    });
    expect(quote.publishedSetupRial).toBe(5_000_000);
    expect(quote.setupWaivedRial).toBe(5_000_000);
    expect(quote.netSetupRial).toBe(0);
    expect(quote.rentalWaived).toBe(true);
    expect(quote.walletDepositRequiredRial).toBe(0);
    expect(quote.subscriptionRequired).toBe(false);
    expect(quote.freeDays).toBe(30);
    expect(quote.expiresAt).toBe("2026-12-31T10:00:00.000Z");
  });

  it("retains a setup charge when only rental is waived", () => {
    const quote = quoteComplimentaryActivation({
      publishedSetupRial: 2_000_000,
      hourlyRial: 100_000,
      grant: grant({ waiveSetup: false }),
      additionalCharges: [],
    });
    expect(quote.netSetupRial).toBe(2_000_000);
    expect(quote.setupWaivedRial).toBe(0);
    expect(quote.rentalWaived).toBe(true);
  });
});

describe("expiry notifications", () => {
  it("skips a 7-day reminder for a 3-day grant", () => {
    const notices = dueGrantNotices({
      grantId: "g1",
      startsAt: "2026-12-01T00:00:00.000Z",
      expiresAt: "2026-12-04T00:00:00.000Z",
      now: "2026-12-04T00:00:00.000Z",
    });
    expect(notices.map((n) => n.thresholdDays)).toEqual([3, 1, 0]);
  });

  it("sends nothing for an indefinite grant", () => {
    expect(
      dueGrantNotices({
        grantId: "g1",
        startsAt: "2026-12-01T00:00:00.000Z",
        expiresAt: null,
        now: "2026-12-20T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("is idempotent through the delivery key", () => {
    const base = {
      grantId: "g1",
      startsAt: "2026-12-01T00:00:00.000Z",
      expiresAt: "2026-12-31T00:00:00.000Z",
      now: "2026-12-31T00:00:00.000Z",
    };
    const sent = new Set([grantNoticeKey("g1", 7), grantNoticeKey("g1", 3)]);
    const notices = dueGrantNotices({ ...base, alreadySent: sent });
    expect(notices.map((n) => n.thresholdDays)).toEqual([1, 0]);
    expect(new Set(notices.map((n) => n.deliveryKey)).size).toBe(2);
  });

  it("does not deliver a notice before its due instant", () => {
    const notices = dueGrantNotices({
      grantId: "g1",
      startsAt: "2026-12-01T00:00:00.000Z",
      expiresAt: "2026-12-31T00:00:00.000Z",
      now: "2026-12-20T00:00:00.000Z",
    });
    expect(notices).toEqual([]);
  });
});
