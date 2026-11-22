/**
 * ESH-200 / #1385 — the pure rules of the signup door.
 *
 * What is pinned here is what a public endpoint must never get wrong: the three
 * accepted fields, Persian-digit normalisation, a mobile-only destination (a
 * landline cannot receive the code the whole flow rests on), and the fact that
 * the pending-request token is stored only as a hash.
 */
import { describe, expect, it } from "vitest";
import {
  SIGNUP_NAME_MAX,
  hashSignupRequestToken,
  normalizeSignupName,
  normalizeSignupRequestToken,
  signupFullName,
  signupRateLimitKey,
  validateSignupDetails,
} from "./public-signup";

describe("signup names", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSignupName("  نگار   احمدی  ")).toBe("نگار احمدی");
  });

  it("rejects empty, non-string and over-long names", () => {
    expect(normalizeSignupName("   ")).toBeNull();
    expect(normalizeSignupName(42)).toBeNull();
    expect(normalizeSignupName("x".repeat(SIGNUP_NAME_MAX + 1))).toBeNull();
  });

  it("composes the identity display name once", () => {
    expect(signupFullName({ firstName: "نگار", lastName: "احمدی" })).toBe("نگار احمدی");
  });
});

describe("signup details", () => {
  it("accepts exactly first name, last name and a mobile", () => {
    const result = validateSignupDetails({
      firstName: "نگار",
      lastName: "احمدی",
      phone: "09121234567",
    });
    expect(result).toEqual({
      ok: true,
      details: { firstName: "نگار", lastName: "احمدی", phoneE164: "+989121234567" },
    });
  });

  it("normalises Persian digits and international spellings to one canonical number", () => {
    const persian = validateSignupDetails({
      firstName: "الف",
      lastName: "ب",
      phone: "۰۹۱۲۱۲۳۴۵۶۷",
    });
    const international = validateSignupDetails({
      firstName: "الف",
      lastName: "ب",
      phone: "+98 912 123 4567",
    });
    expect(persian).toEqual(international);
  });

  it("refuses a landline: the signup proof is an SMS", () => {
    expect(
      validateSignupDetails({ firstName: "الف", lastName: "ب", phone: "02112345678" }),
    ).toEqual({ ok: false, error: "invalid_phone" });
  });

  it("refuses a missing or junk name before looking at the phone", () => {
    expect(validateSignupDetails({ firstName: "", lastName: "ب", phone: "09121234567" })).toEqual({
      ok: false,
      error: "invalid_name",
    });
    expect(validateSignupDetails({ firstName: "الف", phone: "09121234567" })).toEqual({
      ok: false,
      error: "invalid_name",
    });
  });

  it("ignores every field the signup contract does not ask for", () => {
    const result = validateSignupDetails({
      firstName: "نگار",
      lastName: "احمدی",
      phone: "09121234567",
      email: "ignored@example.com",
      password: "ignored-password",
      nationalId: "0012345678",
      businessName: "ignored",
    } as {
      firstName: unknown;
      lastName: unknown;
      phone: unknown;
    });
    expect(result.ok).toBe(true);
  });
});

describe("the pending-request token", () => {
  it("accepts the base64url token the service mints and nothing ordinary", () => {
    expect(normalizeSignupRequestToken("a".repeat(43))).toBe("a".repeat(43));
    expect(normalizeSignupRequestToken("  " + "a".repeat(43) + "  ")).toBe("a".repeat(43));
    for (const bad of ["short", "", undefined, 123, "has spaces in it"]) {
      expect(normalizeSignupRequestToken(bad as unknown)).toBeNull();
    }
  });

  it("stores a SHA-256 hash, never the token", () => {
    const token = "a".repeat(43);
    const hash = hashSignupRequestToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSignupRequestToken(token + "b")).not.toBe(hash);
  });

  it("hashes the limiter key so a table read is not a phone directory", () => {
    const key = signupRateLimitKey("+989121234567");
    expect(key).toMatch(/^signup:[0-9a-f]{64}$/);
    expect(key).not.toContain("989121234567");
    expect(signupRateLimitKey("+989121234567")).toBe(key);
  });
});
