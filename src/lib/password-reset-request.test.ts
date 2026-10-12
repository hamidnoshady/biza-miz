import { describe, expect, it } from "vitest";
import {
  passwordResetBudgetDecision,
  passwordResetEmail,
  PASSWORD_RESET_REQUEST_LIMITS,
} from "./password-reset-request";

/**
 * Issue #885 L10 — the forgotten-password request flow.
 *
 * The two things worth pinning are the ones an endpoint like this gets wrong
 * quietly:
 *
 *   1. The rate limit. Too loose and the endpoint is a mail cannon pointed at
 *      one inbox; too tight and a user who mistyped twice cannot recover
 *      their own account.
 *   2. The link and the copy. A reset email is a credential in transit, so
 *      the URL has to be the single-use token and nothing else, and the
 *      message must not imply the password has already changed.
 *
 * The anti-enumeration contract itself — that the route answers every outcome
 * identically — is tested against the handler, since that is where the
 * response is built.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

describe("passwordResetBudgetDecision", () => {
  it("allows a first request", () => {
    expect(passwordResetBudgetDecision([], NOW)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("allows up to the hourly cap and refuses the next one", () => {
    const hourly = PASSWORD_RESET_REQUEST_LIMITS[0];
    // The decision runs *before* the new row is written, so its input is the
    // count of requests already made: `max - 1` leaves room for this one,
    // `max` means the cap is already spent.
    const roomForOne = Array.from({ length: hourly.max - 1 }, (_, i) => minutesAgo(i + 1));
    expect(passwordResetBudgetDecision(roomForOne, NOW).allowed).toBe(true);

    const atCap = [...roomForOne, minutesAgo(0.5)];
    expect(atCap).toHaveLength(hourly.max);
    const decision = passwordResetBudgetDecision(atCap, NOW);
    expect(decision.allowed).toBe(false);
    // The wait is until the oldest send in the window ages out, not a fixed
    // penalty, so it shrinks as time passes.
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(hourly.windowMs);
  });

  it("enforces the daily cap independently of the hourly one", () => {
    const hourly = PASSWORD_RESET_REQUEST_LIMITS[0];
    const daily = PASSWORD_RESET_REQUEST_LIMITS[1];
    // Two hours apart, so at most one ever lands in an hourly window and the
    // hourly cap cannot be what refuses here.
    const spread = Array.from({ length: daily.max - 1 }, (_, i) => hoursAgo(i * 2 + 1));
    expect(hourly.windowMs).toBeLessThan(2 * 3_600_000);
    // ...and all of them still sit inside the daily window.
    expect((daily.max - 1) * 2 + 1).toBeLessThan(daily.windowMs / 3_600_000);

    expect(passwordResetBudgetDecision(spread, NOW).allowed).toBe(true);

    const overDaily = [...spread, minutesAgo(1)];
    expect(overDaily).toHaveLength(daily.max);
    expect(passwordResetBudgetDecision(overDaily, NOW).allowed).toBe(false);
  });

  it("ignores sends that have aged out of every window", () => {
    const stale = [hoursAgo(25), hoursAgo(30), hoursAgo(48)];
    expect(passwordResetBudgetDecision(stale, NOW)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("is order-independent", () => {
    const stamps = [minutesAgo(5), hoursAgo(3), minutesAgo(1), hoursAgo(10)];
    const forward = passwordResetBudgetDecision(stamps, NOW);
    const backward = passwordResetBudgetDecision([...stamps].reverse(), NOW);
    expect(forward).toEqual(backward);
  });

  it("accepts strings as well as Dates", () => {
    // Postgres returns timestamptz as a string through some drivers.
    const asStrings = [minutesAgo(1).toISOString(), minutesAgo(2).toISOString()];
    const asDates = [minutesAgo(1), minutesAgo(2)];
    expect(passwordResetBudgetDecision(asStrings, NOW)).toEqual(
      passwordResetBudgetDecision(asDates, NOW),
    );
  });

  it("ignores unparseable and future stamps rather than counting them", () => {
    // A corrupt row, or a node whose clock is ahead, must not lock a user out
    // of their own recovery.
    const noisy = [null, undefined, "not a date", new Date(NOW.getTime() + 60_000)];
    expect(passwordResetBudgetDecision(noisy, NOW)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("never returns a negative wait", () => {
    const hourly = PASSWORD_RESET_REQUEST_LIMITS[0];
    // Every send is on the far edge of the window, so the computed wait is
    // close to zero.
    const edge = Array.from({ length: hourly.max + 1 }, () =>
      new Date(NOW.getTime() - hourly.windowMs + 1),
    );
    const decision = passwordResetBudgetDecision(edge, NOW);
    expect(decision.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(decision.retryAfterMs)).toBe(true);
  });

  it("has limits tight enough to matter", () => {
    // A guard against someone loosening these to make a test pass.
    const hourly = PASSWORD_RESET_REQUEST_LIMITS.find((l) => l.windowMs === 3_600_000);
    expect(hourly).toBeDefined();
    expect(hourly!.max).toBeLessThanOrEqual(5);
  });
});

describe("passwordResetEmail", () => {
  it("carries the reset URL verbatim", () => {
    const url = "https://pos.example.com/reset-password?token=abc123";
    expect(passwordResetEmail(url).body).toContain(url);
  });

  it("does not claim the password has changed", () => {
    // The recipient may not have asked for this. The message has to say the
    // current password still works, or a phishing-shaped email becomes a
    // panic that leads somewhere worse.
    const { body } = passwordResetEmail("https://pos.example.com/reset-password?token=x");
    expect(body).toContain("تغییر نکرده است");
  });

  it("states the link is single-use and time-limited", () => {
    const { body } = passwordResetEmail("https://pos.example.com/reset-password?token=x");
    expect(body).toContain("یک‌بار مصرف");
    expect(body).toContain("۲۴ ساعت");
  });

  it("has a subject", () => {
    expect(passwordResetEmail("https://x.test/r").subject.length).toBeGreaterThan(0);
  });
});
