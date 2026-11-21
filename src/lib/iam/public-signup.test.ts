/**
 * ESH-200 / #1385 — the pure rules of the signup door.
 *
 * What is pinned here is what a public endpoint must never get wrong: the three
 * accepted fields, Persian-digit normalisation, and a mobile-only destination
 * (a landline cannot receive the code the whole flow rests on).
 */
import { describe, expect, it } from "vitest";
import {
  SIGNUP_NAME_MAX,
  normalizeSignupName,
  signupFullName,
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
});
