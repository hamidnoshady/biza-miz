import { describe, it, expect } from "vitest";
import {
  DEFAULT_PHONE_OTP_POLICY,
  employeeLoginMode,
  memberPhoneState,
  normalizePhoneOtpPolicy,
  phoneOtpDaysRemaining,
  phoneOtpEnforcement,
  pinWindowActive,
  otpSendBudgetDecision,
} from "./phone-otp-policy";

describe("normalizePhoneOtpPolicy", () => {
  it("keeps a parseable enforcedAt verbatim", () => {
    expect(normalizePhoneOtpPolicy({ enforcedAt: "2026-09-22T12:00:00+00:00" })).toEqual({
      enforcedAt: "2026-09-22T12:00:00+00:00",
    });
  });

  it("treats junk as absent — a typo'd date must never read as enforced", () => {
    expect(normalizePhoneOtpPolicy({ enforcedAt: "soon" })).toEqual(DEFAULT_PHONE_OTP_POLICY);
    expect(normalizePhoneOtpPolicy(null)).toEqual(DEFAULT_PHONE_OTP_POLICY);
    expect(normalizePhoneOtpPolicy({ enforcedAt: 42 })).toEqual(DEFAULT_PHONE_OTP_POLICY);
  });
});

describe("phoneOtpEnforcement", () => {
  const future = new Date("2026-09-22T12:00:00Z");
  const past = new Date("2026-08-22T12:00:00Z");
  const now = new Date("2026-09-08T12:00:00Z");

  it("is off with no enforcedAt at all — the business was never switched on", () => {
    expect(phoneOtpEnforcement({ enforcedAt: null }, true, now)).toBe("off");
  });

  it("is grace inside the adoption window — the PIN door behaves as before", () => {
    expect(phoneOtpEnforcement({ enforcedAt: future.toISOString() }, true, now)).toBe("grace");
    expect(phoneOtpEnforcement({ enforcedAt: future.toISOString() }, false, now)).toBe("grace");
  });

  it("is enforced only once the date has passed AND SMS is configured", () => {
    expect(phoneOtpEnforcement({ enforcedAt: past.toISOString() }, true, now)).toBe("enforced");
  });

  it("waits as pending_sms past the date when no OTP could be delivered — never a lockout", () => {
    expect(phoneOtpEnforcement({ enforcedAt: past.toISOString() }, false, now)).toBe("pending_sms");
  });

  it("ignores an unparseable date rather than guessing", () => {
    expect(phoneOtpEnforcement({ enforcedAt: "not-a-date" }, true, now)).toBe("off");
  });
});

describe("phoneOtpDaysRemaining", () => {
  it("counts whole days, rounded up, floored at zero", () => {
    const now = new Date("2026-09-08T12:00:00Z");
    expect(phoneOtpDaysRemaining({ enforcedAt: "2026-09-11T12:00:00Z" }, now)).toBe(3);
    // Eleven hours left must not read as zero while login still works.
    expect(phoneOtpDaysRemaining({ enforcedAt: "2026-09-08T23:00:00Z" }, now)).toBe(1);
    expect(phoneOtpDaysRemaining({ enforcedAt: "2026-09-01T00:00:00Z" }, now)).toBe(0);
  });

  it("is null with no window to count", () => {
    expect(phoneOtpDaysRemaining({ enforcedAt: null })).toBeNull();
  });
});

describe("pinWindowActive", () => {
  const verifiedAt = new Date("2026-09-08T12:00:00Z");

  it("is open inside the 7-day window after the OTP verification", () => {
    expect(pinWindowActive(verifiedAt, new Date("2026-09-14T11:59:00Z"))).toBe(true);
    expect(pinWindowActive(verifiedAt, new Date("2026-09-15T11:59:00Z"))).toBe(true);
    // Exactly seven days later the window has closed — the member owes the
    // door an OTP again on their next login.
    expect(pinWindowActive(verifiedAt, new Date("2026-09-15T12:00:00Z"))).toBe(false);
    expect(pinWindowActive(verifiedAt, new Date("2026-09-16T12:00:00Z"))).toBe(false);
  });

  it("is closed when there is nothing to anchor it on", () => {
    expect(pinWindowActive(null, verifiedAt)).toBe(false);
  });

  it("accepts the ISO-string form the database row arrives as", () => {
    expect(pinWindowActive("2026-09-10T00:00:00Z", new Date("2026-09-11T00:00:00Z"))).toBe(true);
  });
});

describe("memberPhoneState", () => {
  it("distinguishes no number, an unproven number and a verified one", () => {
    expect(memberPhoneState(null, null)).toBe("none");
    expect(memberPhoneState("+989121234567", null)).toBe("unverified");
    expect(memberPhoneState("+989121234567", new Date())).toBe("verified");
  });
});

describe("employeeLoginMode", () => {
  it("keeps the plain PIN pad whenever the requirement is not enforced", () => {
    for (const state of ["off", "grace", "pending_sms"] as const) {
      expect(
        employeeLoginMode({ enforcement: state, phoneState: "none", pinWindow: false }),
      ).toBe("pin");
    }
  });

  it("asks PIN first only when no number is on file — PIN proves who, then the number is set", () => {
    expect(employeeLoginMode({ enforcement: "enforced", phoneState: "none", pinWindow: false }))
      .toBe("pin_then_otp");
  });

  it("goes straight to the OTP when a number is on file but unproven or the window closed", () => {
    expect(employeeLoginMode({ enforcement: "enforced", phoneState: "unverified", pinWindow: false }))
      .toBe("otp");
    expect(employeeLoginMode({ enforcement: "enforced", phoneState: "verified", pinWindow: false }))
      .toBe("otp");
  });

  it("honours the 7-day PIN shortcut once the phone is verified and the window open", () => {
    expect(employeeLoginMode({ enforcement: "enforced", phoneState: "verified", pinWindow: true }))
      .toBe("pin");
  });
});

/**
 * Issue #885 L03 — the send budget.
 *
 * The arithmetic was never the problem; *when* it was evaluated was. The
 * caller read the budget, compared, and only recorded the send on the way
 * back, so two simultaneous requests both read "under the limit" and both
 * spent a message. `reserveOtpSend` now takes the check and the record inside
 * one transaction behind an advisory lock (proved against a real database in
 * `integration/phone-otp.integration.test.ts`); this pins the rule that
 * decision applies.
 */
describe("otpSendBudgetDecision", () => {
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const MINUTE = 60_000;
  const HOUR = 3_600_000;

  it("allows a first send", () => {
    expect(otpSendBudgetDecision([], NOW)).toEqual({ allowed: true });
    expect(otpSendBudgetDecision([ago(2 * MINUTE)], NOW)).toEqual({ allowed: true });
  });

  it("refuses a second send inside the minute", () => {
    const decision = otpSendBudgetDecision([ago(10_000)], NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // The wait is until the oldest send ages out of the window, not a fixed
      // cool-down — a fixed one would be wrong in both directions for a member
      // who has been sending steadily.
      expect(decision.retryAfterMs).toBe(MINUTE - 10_000);
    }
  });

  it("refuses the sixth send inside the hour and names when it clears", () => {
    const sends = [ago(1 * MINUTE), ago(10 * MINUTE), ago(20 * MINUTE), ago(30 * MINUTE), ago(40 * MINUTE)];
    const decision = otpSendBudgetDecision(sends, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // The oldest of the five holds the window closed.
      expect(decision.retryAfterMs).toBe(HOUR - 40 * MINUTE);
    }
  });

  it("is order-independent, so a caller cannot get it wrong by sorting wrong", () => {
    const sends = [ago(40 * MINUTE), ago(1 * MINUTE), ago(30 * MINUTE), ago(10 * MINUTE), ago(20 * MINUTE)];
    expect(otpSendBudgetDecision(sends, NOW)).toEqual(
      otpSendBudgetDecision([...sends].reverse(), NOW),
    );
  });

  it("ignores timestamps outside every window, and unparseable ones", () => {
    expect(otpSendBudgetDecision([ago(2 * HOUR), ago(3 * HOUR)], NOW)).toEqual({
      allowed: true,
    });
    expect(otpSendBudgetDecision(["not a date", ago(2 * HOUR)], NOW)).toEqual({
      allowed: true,
    });
  });

  it("never returns a negative wait", () => {
    // A send stamped in the future by clock skew must not produce a negative
    // countdown, which the UI would render as "ready 0 seconds ago".
    const decision = otpSendBudgetDecision([new Date(NOW.getTime() + 5_000)], NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it("applies the tightest breached ceiling, not the first one it meets", () => {
    // Four sends this hour, none inside the last minute: the hour ceiling is
    // not breached yet, so the answer is still yes.
    const sends = [ago(2 * MINUTE), ago(10 * MINUTE), ago(20 * MINUTE), ago(30 * MINUTE)];
    expect(otpSendBudgetDecision(sends, NOW)).toEqual({ allowed: true });
  });
});
