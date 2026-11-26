import { describe, expect, it } from "vitest";
import {
  decideOtpAssurance,
  decidePasswordAssurance,
  decideSensitiveStepUp,
  DISTINCT_FACTOR_STEP_UP_METHODS,
  otpOnlyAssuranceAfterStepUp,
  stepUpProvesDistinctFactor,
} from "./login-assurance";

/**
 * #1386 — the approved policy, pinned as behaviour.
 *
 * The regression these tests exist for is subtle: before #1386 an account whose
 * only factor was SMS was challenged for a second factor on the OTP path. There
 * was no distinct method left to offer, so the member either met a dead end or
 * was asked for the same factor twice. The rule is now explicit.
 */
function otp(overrides: Partial<Parameters<typeof decideOtpAssurance>[0]> = {}) {
  return decideOtpAssurance({
    role: "cashier",
    policy: {},
    distinctFactors: [],
    hasConfirmedEnrolment: false,
    requirement: "not_required",
    deviceTrusted: false,
    ...overrides,
  });
}

describe("phone-OTP login assurance", () => {
  it("lets a routine cashier with only an SMS factor in with one code", () => {
    expect(otp({ hasConfirmedEnrolment: true })).toEqual({
      challengeRequired: false,
      enrolmentRequired: false,
      reason: null,
    });
  });

  it("does not treat SMS as a distinct second factor (no duplicate routine challenge)", () => {
    // `distinctSecondFactorMethods(..., "phone_otp")` already removes SMS. This
    // asserts the policy's own contract: an empty distinct list means the OTP
    // was the whole ceremony, not that a factor is missing.
    const decision = otp({ role: "manager", hasConfirmedEnrolment: true });

    expect(decision.challengeRequired).toBe(false);
    expect(decision.enrolmentRequired).toBe(false);
  });

  it("requires an enrolled TOTP on a new device for an ordinary account", () => {
    expect(
      otp({
        role: "cashier",
        distinctFactors: ["totp"],
        hasConfirmedEnrolment: true,
        requirement: "not_required",
      }),
    ).toEqual({
      challengeRequired: true,
      enrolmentRequired: false,
      reason: "untrusted_device",
    });
  });

  it("keeps the existing trusted-device exemption for a routine challenge", () => {
    const decision = otp({
      role: "cashier",
      distinctFactors: ["totp"],
      hasConfirmedEnrolment: true,
      deviceTrusted: true,
    });

    expect(decision.challengeRequired).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it("does not let a privileged owner skip the mandatory distinct factor on a new device", () => {
    expect(
      otp({
        role: "owner",
        distinctFactors: ["totp"],
        hasConfirmedEnrolment: true,
        requirement: "not_required",
      }),
    ).toEqual({
      challengeRequired: true,
      enrolmentRequired: false,
      reason: "privileged_role",
    });
  });

  it("forces a distinct factor when a privileged account holds only SMS", () => {
    // The SMS code opened the door; it cannot also be the mandatory second
    // factor. There is nothing stronger to prove yet, so the step must enrol.
    expect(
      otp({
        role: "admin",
        hasConfirmedEnrolment: true,
        requirement: "not_required",
      }),
    ).toEqual({
      challengeRequired: true,
      enrolmentRequired: true,
      reason: "privileged_role",
    });
  });

  it("keeps the first-run grace window for a privileged account with no factor yet", () => {
    expect(
      otp({
        role: "owner",
        hasConfirmedEnrolment: false,
        requirement: "grace",
      }).challengeRequired,
    ).toBe(false);
  });

  it("requires enrolment for a privileged account after the grace window closes", () => {
    expect(
      otp({
        role: "owner",
        hasConfirmedEnrolment: false,
        requirement: "required",
      }),
    ).toEqual({
      challengeRequired: true,
      enrolmentRequired: true,
      reason: "privileged_role",
    });
  });

  it("honours a business opt-in for managers and accountants", () => {
    for (const role of ["manager", "accountant"] as const) {
      expect(
        otp({
          role,
          policy:
            role === "manager"
              ? { requireForManagers: true }
              : { requireForAccountants: true },
          hasConfirmedEnrolment: true,
        }).challengeRequired,
      ).toBe(true);
    }
  });

  it("keeps the existing trusted-device exemption for a privileged account", () => {
    // The exemption predates #1386 and is explicitly earned by a completed
    // ceremony. This test records that the policy change did not silently
    // tighten or widen it.
    const decision = otp({
      role: "owner",
      distinctFactors: ["totp"],
      hasConfirmedEnrolment: true,
      deviceTrusted: true,
    });

    expect(decision.challengeRequired).toBe(false);
  });
});

describe("password login assurance (unchanged by #1386)", () => {
  it("always challenges when a confirmed factor exists", () => {
    expect(
      decidePasswordAssurance({
        hasConfirmedEnrolment: true,
        appliesToRole: false,
        requirement: "not_required",
      }),
    ).toBe(true);
  });

  it("challenges a mandatory role once the grace window has expired", () => {
    expect(
      decidePasswordAssurance({
        hasConfirmedEnrolment: false,
        appliesToRole: true,
        requirement: "required",
      }),
    ).toBe(true);
  });

  it("does not force a factor on an ordinary role with none enrolled", () => {
    expect(
      decidePasswordAssurance({
        hasConfirmedEnrolment: false,
        appliesToRole: false,
        requirement: "not_required",
      }),
    ).toBe(false);
  });
});

/**
 * #1386 Scenario 8 — what an OTP-only session may change.
 *
 * Routine OTP sign-in is complete on the SMS proof (above). These pin the
 * other half of the owner-approved policy: that proof can never *by itself*
 * strip, replace or add a credential on an account holding a separately
 * enrolled authenticator.
 */
describe("sensitive-action step-up after an OTP-only sign-in", () => {
  it("demands the distinct factor when the account holds a TOTP", () => {
    expect(decideSensitiveStepUp({ otpOnlyAssurance: true, distinctFactors: ["totp"] })).toEqual({
      distinctFactorRequired: true,
      allowedMethods: ["totp", "recovery"],
    });
  });

  it("leaves a phone-first account with nothing stronger to its SMS proof", () => {
    // Refusing here would lock the member out of enrolling the very factor
    // that would protect them.
    expect(decideSensitiveStepUp({ otpOnlyAssurance: true, distinctFactors: [] })).toEqual({
      distinctFactorRequired: false,
      allowedMethods: [],
    });
  });

  it("never bites a session that did not come from an OTP-only proof", () => {
    for (const claim of [undefined, false]) {
      expect(
        decideSensitiveStepUp({ otpOnlyAssurance: claim, distinctFactors: ["totp"] })
          .distinctFactorRequired,
      ).toBe(false);
    }
  });

  it("does not count SMS, password or PIN as the distinct factor", () => {
    expect(DISTINCT_FACTOR_STEP_UP_METHODS).toEqual(["totp", "recovery"]);
    for (const method of ["sms_otp", "password", "pin", "webauthn"]) {
      expect(stepUpProvesDistinctFactor(method)).toBe(false);
    }
    expect(stepUpProvesDistinctFactor("totp")).toBe(true);
    expect(stepUpProvesDistinctFactor("recovery")).toBe(true);
  });

  it("records what each step-up proved on the session", () => {
    // Distinct factor upgrades an OTP-only session.
    expect(otpOnlyAssuranceAfterStepUp("totp", true)).toBe(false);
    expect(otpOnlyAssuranceAfterStepUp("recovery", true)).toBe(false);
    // An SMS step-up is SMS-only, even on a session that started stronger:
    // two SMS codes are one factor, not two.
    expect(otpOnlyAssuranceAfterStepUp("sms_otp", undefined)).toBe(true);
    expect(otpOnlyAssuranceAfterStepUp("sms_otp", false)).toBe(true);
    // Password / PIN refresh the clock but cannot upgrade an OTP-only session…
    expect(otpOnlyAssuranceAfterStepUp("password", true)).toBe(true);
    expect(otpOnlyAssuranceAfterStepUp("pin", true)).toBe(true);
    // …and do not downgrade a session that never was one.
    expect(otpOnlyAssuranceAfterStepUp("password", undefined)).toBe(false);
    expect(otpOnlyAssuranceAfterStepUp("pin", false)).toBe(false);
  });
});
