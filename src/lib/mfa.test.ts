import { describe, expect, it } from "vitest";
import {
  distinctSecondFactorMethods,
  mayConfirmPendingEnrolmentAtLogin,
  enrolmentRequirement,
  graceDaysRemaining,
  isMfaEnrolmentConfirmed,
  mfaAppliesToRole,
  selectPrimaryMfaEnrolment,
  shouldChallengeMfaOnLogin,
  sortMfaEnrolments,
} from "./mfa";

const NOW = new Date("2026-04-06T12:00:00Z");

describe("enrolmentRequirement", () => {
  it("says not_required once a primary method is enrolled", () => {
    expect(
      enrolmentRequirement(
        {
          hasPrimary: true,
          graceUntil: "2026-04-01T00:00:00Z", // even if the grace window is in the past
          hasGraceRecord: true,
          role: "owner",
        },
        NOW,
      ),
    ).toBe("not_required");
  });

  it("says grace when the account has never been evaluated (no grace row yet)", () => {
    // First password login for a brand-new Owner: the caller will stamp the
    // 14-day window right after this and let them in with the banner.
    expect(
      enrolmentRequirement(
        { hasPrimary: false, graceUntil: null, hasGraceRecord: false, role: "owner" },
        NOW,
      ),
    ).toBe("grace");
  });

  it("says grace while the window is still open", () => {
    expect(
      enrolmentRequirement(
        {
          hasPrimary: false,
          graceUntil: "2026-04-10T12:00:00Z",
          hasGraceRecord: true,
          role: "owner",
        },
        NOW,
      ),
    ).toBe("grace");
  });

  it("says required the moment the window closes", () => {
    expect(
      enrolmentRequirement(
        {
          hasPrimary: false,
          graceUntil: "2026-04-06T12:00:00Z", // exact boundary -> closed
          hasGraceRecord: true,
          role: "owner",
        },
        NOW,
      ),
    ).toBe("required");
    expect(
      enrolmentRequirement(
        {
          hasPrimary: false,
          graceUntil: "2026-04-05T00:00:00Z",
          hasGraceRecord: true,
          role: "owner",
        },
        NOW,
      ),
    ).toBe("required");
  });

  it("says required when a grace row exists with graceUntil = null", () => {
    // The explicit "skip the window, enforce immediately" shape used by tests
    // and by platform security actions.
    expect(
      enrolmentRequirement(
        { hasPrimary: false, graceUntil: null, hasGraceRecord: true, role: "owner" },
        NOW,
      ),
    ).toBe("required");
  });
});

describe("graceDaysRemaining", () => {
  it("rounds partial days up so the banner never says 0 while login still works", () => {
    // 11 hours left -> still 1 day on the counter.
    expect(graceDaysRemaining("2026-04-06T23:00:00Z", NOW)).toBe(1);
    // 3 days and 1 second left -> 4 days.
    expect(graceDaysRemaining("2026-04-09T12:00:01Z", NOW)).toBe(4);
  });

  it("floors at zero once the window has passed and returns null when unset", () => {
    expect(graceDaysRemaining("2026-04-01T00:00:00Z", NOW)).toBe(0);
    expect(graceDaysRemaining(null, NOW)).toBeNull();
  });
});

describe("mfaAppliesToRole", () => {
  it("always applies to owner and never to floor staff", () => {
    expect(mfaAppliesToRole("owner")).toBe(true);
    expect(mfaAppliesToRole("cashier")).toBe(false);
    expect(mfaAppliesToRole("waiter")).toBe(false);
    expect(mfaAppliesToRole("kitchen")).toBe(false);
  });

  it("applies to manager only when the business opts in", () => {
    expect(mfaAppliesToRole("manager", { requireForManagers: false })).toBe(false);
    expect(mfaAppliesToRole("manager", { requireForManagers: true })).toBe(true);
    /**
     * Issue #854 (P1.1) — the accountant knob travels in the same object. It
     * did not before: the signature took a single `extendToManager` boolean and
     * every login door passed only the manager key, so `requireForAccountants`
     * was stored, rendered and audited without ever changing an outcome.
     */
    expect(mfaAppliesToRole("accountant", { requireForAccountants: false })).toBe(false);
    expect(mfaAppliesToRole("accountant", { requireForAccountants: true })).toBe(true);
    expect(mfaAppliesToRole("accountant", { requireForManagers: true })).toBe(false);
  });
});

describe("selectPrimaryMfaEnrolment & sortMfaEnrolments", () => {
  it("prefers confirmed explicit primary, ignoring unconfirmed enrolments", () => {
    const rows = [
      {
        id: "1",
        method: "sms_otp" as const,
        is_primary: true,
        confirmed_at: null,
        created_at: "2026-04-01T00:00:00Z",
      },
      {
        id: "2",
        method: "sms_otp" as const,
        is_primary: true,
        confirmed_at: "2026-04-02T00:00:00Z",
        created_at: "2026-04-02T00:00:00Z",
      },
      {
        id: "3",
        method: "totp" as const,
        is_primary: false,
        confirmed_at: "2026-04-01T00:00:00Z",
        created_at: "2026-04-01T00:00:00Z",
      },
    ];
    expect(isMfaEnrolmentConfirmed(rows[0])).toBe(false);
    expect(isMfaEnrolmentConfirmed(rows[1])).toBe(true);
    expect(selectPrimaryMfaEnrolment(rows)?.id).toBe("2");
  });

  it("breaks ties deterministically (totp before sms_otp, then created_at, then id)", () => {
    const rows = [
      {
        id: "b",
        method: "sms_otp" as const,
        is_primary: false,
        confirmed_at: "2026-04-01T00:00:00Z",
        created_at: "2026-04-01T00:00:00Z",
      },
      {
        id: "a",
        method: "totp" as const,
        is_primary: false,
        confirmed_at: "2026-04-02T00:00:00Z",
        created_at: "2026-04-02T00:00:00Z",
      },
    ];
    expect(sortMfaEnrolments(rows).map((r) => r.id)).toEqual(["a", "b"]);
    expect(selectPrimaryMfaEnrolment(rows)?.id).toBe("a");
  });

  it("returns null when only unconfirmed enrolments exist unless fallback is requested", () => {
    const rows = [
      {
        id: "u1",
        method: "totp" as const,
        is_primary: false,
        confirmed_at: null,
        created_at: "2026-04-01T00:00:00Z",
      },
    ];
    expect(selectPrimaryMfaEnrolment(rows)).toBeNull();
    expect(selectPrimaryMfaEnrolment(rows, { allowUnconfirmedFallback: true })?.id).toBe("u1");
  });
});

describe("distinctSecondFactorMethods & shouldChallengeMfaOnLogin", () => {
  it("excludes sms_otp when primaryAuth is phone_otp so SMS is not counted twice", () => {
    const enrolments = [
      {
        id: "1",
        method: "sms_otp" as const,
        is_primary: true,
        confirmed_at: "2026-04-01T00:00:00Z",
      },
      {
        id: "2",
        method: "totp" as const,
        is_primary: false,
        confirmed_at: "2026-04-02T00:00:00Z",
      },
    ];
    expect(distinctSecondFactorMethods(enrolments, "password")).toEqual(["sms_otp", "totp"]);
    expect(distinctSecondFactorMethods(enrolments, "phone_otp")).toEqual(["totp"]);
  });

  it("challenges MFA on login whenever confirmed enrolment exists OR grace has expired", () => {
    expect(
      shouldChallengeMfaOnLogin({
        hasConfirmedEnrolment: true,
        appliesToRole: true,
        requirement: "not_required",
      }),
    ).toBe(true);
    expect(
      shouldChallengeMfaOnLogin({
        hasConfirmedEnrolment: false,
        appliesToRole: true,
        requirement: "grace",
      }),
    ).toBe(false);
    expect(
      shouldChallengeMfaOnLogin({
        hasConfirmedEnrolment: false,
        appliesToRole: true,
        requirement: "required",
      }),
    ).toBe(true);
  });
});

/**
 * Issue #854 (P1.11) — one gate for the mid-enrolment login case.
 *
 * The rule has two halves, and both matter: an account with nothing confirmed
 * must be able to finish enrolling while signing in, and an account that already
 * has a confirmed factor must never let a half-finished row stand in as its
 * second factor.
 */
describe("mayConfirmPendingEnrolmentAtLogin", () => {
  const pendingTotp = {
    id: "p1",
    method: "totp" as const,
    is_primary: true,
    confirmed_at: null,
  };
  const liveTotp = {
    id: "c1",
    method: "totp" as const,
    is_primary: true,
    confirmed_at: "2026-04-01T00:00:00Z",
  };
  const liveSms = {
    id: "c2",
    method: "sms_otp" as const,
    is_primary: false,
    confirmed_at: "2026-04-01T00:00:00Z",
  };

  it("opens for an account that is mid-enrolment with nothing confirmed", () => {
    expect(mayConfirmPendingEnrolmentAtLogin([pendingTotp], "totp")).toBe(true);
  });

  it("stays shut once any factor is confirmed, even one of another method", () => {
    expect(mayConfirmPendingEnrolmentAtLogin([pendingTotp, liveSms], "totp")).toBe(false);
    expect(mayConfirmPendingEnrolmentAtLogin([pendingTotp, liveTotp], "totp")).toBe(false);
  });

  it("stays shut when the pending row is for a different method than the code", () => {
    expect(mayConfirmPendingEnrolmentAtLogin([pendingTotp], "sms_otp")).toBe(false);
  });

  it("stays shut when there is no method to confirm (recovery-code path)", () => {
    expect(mayConfirmPendingEnrolmentAtLogin([pendingTotp], null)).toBe(false);
  });

  it("stays shut for an account with no enrolments at all", () => {
    expect(mayConfirmPendingEnrolmentAtLogin([], "totp")).toBe(false);
  });
});
