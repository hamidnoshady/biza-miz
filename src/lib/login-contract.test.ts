import { describe, expect, it } from "vitest";
import {
  boundedString,
  isSafeLoginNextPath,
  loginEmailOrNull,
  loginErrorMessage,
  normalizeOtpCode,
  otpFromPastedText,
  normalizePinInput,
  safeLoginNextPath,
  uuidOrNull,
  withLoginNextParam,
} from "./login-contract";

/**
 * Issue #885 — the client-safe login contract.
 *
 * These are the rules every login consumer now shares. They are pinned here
 * rather than in the forms because the whole point of the module is that a
 * form and a route handler cannot disagree about them.
 */
describe("safeLoginNextPath", () => {
  it("accepts an ordinary same-site path, query string included", () => {
    expect(safeLoginNextPath("/settings/profile")).toBe("/settings/profile");
    expect(safeLoginNextPath("/mcp/consent?client=claude")).toBe("/mcp/consent?client=claude");
    expect(safeLoginNextPath("/dashboard")).toBe("/dashboard");
  });

  it("falls back when there is nothing to honour", () => {
    for (const bad of [null, undefined, "", "   ", 42, {}, []]) {
      expect(safeLoginNextPath(bad, "/dashboard")).toBe("/dashboard");
    }
  });

  it("rejects the absolute and protocol-relative forms", () => {
    expect(safeLoginNextPath("https://evil.example/x", "/")).toBe("/");
    expect(safeLoginNextPath("//evil.example/x", "/")).toBe("/");
    expect(safeLoginNextPath("evil.example/x", "/")).toBe("/");
    expect(safeLoginNextPath("javascript:alert(1)", "/")).toBe("/");
  });

  it("rejects the backslash authority form the tenant doors used to miss", () => {
    // The gap the audit found: `login-helpers.useNextPath` tested `//` but not
    // `/\`, while the desktop's own validator tested both. Browsers read `\`
    // as `/` in an authority, so this is the same open redirect.
    expect(safeLoginNextPath("/\\evil.example", "/")).toBe("/");
    expect(safeLoginNextPath("/\\\\evil.example", "/")).toBe("/");
    // No route in this app contains a backslash, so the blanket rejection
    // costs nothing and closes the deeper-position variants too.
    expect(safeLoginNextPath("/a\\b", "/")).toBe("/");
  });

  it("rejects control characters, which browsers strip before parsing", () => {
    // "/\t/evil.example" reaches the address bar as "//evil.example".
    expect(safeLoginNextPath("/\t/evil.example", "/")).toBe("/");
    expect(safeLoginNextPath("/\n/evil.example", "/")).toBe("/");
    expect(safeLoginNextPath("/\r/evil.example", "/")).toBe("/");
    expect(safeLoginNextPath("/\u0000/evil.example", "/")).toBe("/");
  });

  it("rejects the percent-encoded forms of either", () => {
    expect(safeLoginNextPath("/%2F%2Fevil.example", "/")).toBe("/");
    expect(safeLoginNextPath("/%2f%2fevil.example", "/")).toBe("/");
    expect(safeLoginNextPath("/%5Cevil.example", "/")).toBe("/");
    // A malformed escape sequence is not a destination anyone meant.
    expect(safeLoginNextPath("/%zz", "/")).toBe("/");
  });

  it("is bounded, so a pasted megabyte cannot be reflected anywhere", () => {
    expect(safeLoginNextPath(`/${"a".repeat(5000)}`, "/")).toBe("/");
    expect(safeLoginNextPath(`/${"a".repeat(2000)}`, "/")).toBe(`/${"a".repeat(2000)}`);
  });

  it("returns what it was given, never a re-encoded variant", () => {
    // The decoded form is only tested. A route must not receive a value that
    // differs from the one it validated.
    const input = "/settings/profile?tab=%D8%A7%D9%85%D9%86%DB%8C%D8%AA";
    expect(safeLoginNextPath(input, "/")).toBe(input);
  });

  it("agrees with isSafeLoginNextPath", () => {
    expect(isSafeLoginNextPath("/settings/profile")).toBe(true);
    expect(isSafeLoginNextPath("//evil.example")).toBe(false);
    expect(isSafeLoginNextPath("/\\evil.example")).toBe(false);
    expect(isSafeLoginNextPath(null)).toBe(false);
  });
});

/**
 * Issue #885 L06 — the destination used to be dropped at every door change,
 * because each link hard-coded its target.
 */
describe("withLoginNextParam", () => {
  it("carries a validated destination across a door change", () => {
    expect(withLoginNextParam("/admin", "/settings/profile")).toBe(
      "/admin?next=%2Fsettings%2Fprofile",
    );
    expect(withLoginNextParam("/login", "/mcp/consent?client=claude")).toContain("next=");
  });

  it("leaves the path alone when there is nothing safe to carry", () => {
    expect(withLoginNextParam("/admin", null)).toBe("/admin");
    expect(withLoginNextParam("/admin", "//evil.example")).toBe("/admin");
    expect(withLoginNextParam("/admin", "/\\evil.example")).toBe("/admin");
    expect(withLoginNextParam("/admin", "https://evil.example")).toBe("/admin");
  });

  it("does not build a loop when the destination is the page itself", () => {
    expect(withLoginNextParam("/admin", "/admin")).toBe("/admin");
  });

  it("keeps an existing query string on the target", () => {
    const href = withLoginNextParam("/admin?tab=users", "/settings/profile");
    expect(href.startsWith("/admin?")).toBe(true);
    expect(href).toContain("tab=users");
    expect(href).toContain("next=%2Fsettings%2Fprofile");
  });
});

/**
 * Issue #885 L11 — the OTP field used `replace(/\D/g, "")`, which *deletes*
 * Persian and Arabic-Indic digits instead of converting them, so a member
 * typing on a Persian keyboard watched their input disappear.
 */
describe("normalizeOtpCode", () => {
  it("converts Persian and Arabic-Indic digits rather than dropping them", () => {
    expect(normalizeOtpCode("۱۲۳۴۵۶")).toBe("123456");
    expect(normalizeOtpCode("١٢٣٤٥٦")).toBe("123456");
    expect(normalizeOtpCode("123456")).toBe("123456");
    // Mixed input, which is what a phone keyboard with a Persian layout gives.
    expect(normalizeOtpCode("۱2۳4۵6")).toBe("123456");
  });

  it("still strips anything that is not a digit, and bounds the length", () => {
    expect(normalizeOtpCode(" 12ab34 ")).toBe("1234");
    expect(normalizeOtpCode("1234567890")).toBe("123456");
    expect(normalizeOtpCode("1234567890", 4)).toBe("1234");
  });

  it("answers empty for anything that is not a string", () => {
    for (const bad of [null, undefined, 123456, {}, []]) {
      expect(normalizeOtpCode(bad)).toBe("");
    }
  });

  it("canonicalises a PIN the same way, bounded by the caller", () => {
    expect(normalizePinInput("۱۲۳۴", 12)).toBe("1234");
    expect(normalizePinInput("1234567890123456", 12)).toBe("123456789012");
    expect(normalizePinInput(null, 12)).toBe("");
  });
});

/**
 * Issue #885 L14 — a truthy non-string used to reach `.trim()` and bcrypt and
 * throw a 500 instead of answering 400.
 */
describe("boundedString / uuidOrNull / loginEmailOrNull", () => {
  it("refuses anything that is not a string, rather than throwing", () => {
    for (const bad of [123, true, {}, [], null, undefined]) {
      expect(boundedString(bad, { max: 10 })).toBeNull();
      expect(uuidOrNull(bad)).toBeNull();
      expect(loginEmailOrNull(bad)).toBeNull();
    }
  });

  it("enforces the ceiling", () => {
    expect(boundedString("abcdefgh", { max: 4 })).toBeNull();
    expect(boundedString("abcd", { max: 4 })).toBe("abcd");
    // bcrypt only considers 72 bytes; an over-long password must be refused,
    // not silently truncated into a different credential.
    expect(boundedString("a".repeat(73), { max: 72, trim: false })).toBeNull();
  });

  it("trims by default and can be told not to", () => {
    expect(boundedString("  ab  ", { max: 10 })).toBe("ab");
    expect(boundedString("  ab  ", { max: 10, trim: false })).toBe("  ab  ");
  });

  it("accepts only a canonical UUID", () => {
    expect(uuidOrNull("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(uuidOrNull("11111111111141118111111111111111")).toBeNull();
    expect(uuidOrNull("not-a-uuid")).toBeNull();
    expect(uuidOrNull("11111111-1111-4111-8111-11111111111g")).toBeNull();
  });

  it("lower-cases an email and refuses a shape that cannot match", () => {
    expect(loginEmailOrNull("  Owner@Example.COM ")).toBe("owner@example.com");
    expect(loginEmailOrNull("no-at-sign")).toBeNull();
    expect(loginEmailOrNull("a@b")).toBeNull();
    expect(loginEmailOrNull("a b@c.com")).toBeNull();
  });
});

/**
 * Issue #885 L09 — every non-423 failure used to read "wrong email or
 * password", which sent users to re-check a credential that was never the
 * problem.
 */
describe("loginErrorMessage", () => {
  it("keeps the anti-enumeration rule: no account-existence signal", () => {
    // The two answers a credential check may give must be identical.
    expect(loginErrorMessage({ status: 401, code: "invalid_credentials" })).toBe(
      loginErrorMessage({ status: 401, code: "bad_request" }),
    );
  });

  it("words the cases that are not a credential problem as themselves", () => {
    expect(loginErrorMessage({ status: 429, retryAfterMs: 120_000 })).toContain("۲");
    expect(loginErrorMessage({ status: 400, code: "wrong_origin" })).toContain("نشانی");
    expect(loginErrorMessage({ status: 403, code: "business_unavailable" })).toContain(
      "کسب‌وکار",
    );
    expect(loginErrorMessage({ status: 500 })).toContain("سرور");
  });

  it("falls back to something honest for a status it does not know", () => {
    expect(loginErrorMessage({ status: 418, code: "teapot" })).toContain("ورود ناموفق");
  });
});

describe("otpFromPastedText", () => {
  /**
   * Issue #885 L16 — `maxLength={6}` makes the browser truncate a paste
   * *before* onChange fires, so a whole SMS arrived as its first six
   * characters and normalised to an empty field. The member pasted their code
   * and the box stayed blank.
   */
  it("pulls the code out of a pasted SMS body", () => {
    expect(otpFromPastedText("Your code is 123456. Do not share it.")).toBe("123456");
    expect(otpFromPastedText("کد ورود شما: 123456")).toBe("123456");
  });

  it("accepts Persian and Arabic-Indic digits in the pasted text", () => {
    // The same keyboards the L11 fix was about; a paste path that only
    // understood ASCII would reintroduce the bug one gesture later.
    expect(otpFromPastedText("کد یک‌بارمصرف: ۱۲۳۴۵۶")).toBe("123456");
    expect(otpFromPastedText("رمز: ١٢٣٤٥٦")).toBe("123456");
  });

  it("accepts a bare code", () => {
    expect(otpFromPastedText("123456")).toBe("123456");
    expect(otpFromPastedText(" 123456 ")).toBe("123456");
  });

  it("takes the first run of exactly the right length, not the first digits", () => {
    // An SMS often carries other numbers: an expiry, a short code, a reference.
    expect(otpFromPastedText("Ref 42. Your code is 123456, valid 10 min.")).toBe("123456");
    expect(otpFromPastedText("Code 7 then 123456")).toBe("123456");
  });

  it("refuses to guess from a longer digit run", () => {
    // Lifting six digits out of a phone number or an order id would produce a
    // plausible wrong code and cost the member a failed attempt. An empty
    // result leaves the box untouched so they can retry.
    expect(otpFromPastedText("09121234567")).toBe("");
    expect(otpFromPastedText("ORDER-1234567890")).toBe("");
    expect(otpFromPastedText("12345")).toBe("");
  });

  it("returns empty for text with no code in it", () => {
    expect(otpFromPastedText("no digits here")).toBe("");
    expect(otpFromPastedText("")).toBe("");
    expect(otpFromPastedText(null)).toBe("");
    expect(otpFromPastedText(undefined)).toBe("");
    expect(otpFromPastedText(123456)).toBe("");
  });

  it("honours a different expected length", () => {
    expect(otpFromPastedText("code 1234", 4)).toBe("1234");
    // A six-digit run is not a four-digit code.
    expect(otpFromPastedText("code 123456", 4)).toBe("");
  });

  it("never returns anything longer than the bound", () => {
    expect(otpFromPastedText("1234567890", 6).length).toBeLessThanOrEqual(6);
  });
});
