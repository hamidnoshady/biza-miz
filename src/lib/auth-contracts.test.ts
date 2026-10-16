/**
 * Issue #854 — the typed auth contracts: one vocabulary for the step-up
 * request, the business-selection answer, and the error codes the UI translates.
 *
 * These are pinning tests rather than exploratory ones. Every case here
 * corresponds to a named finding, and each would have caught its finding:
 *
 *   - `parseStepUpRequest` refusing to *default* a missing method is P1.9;
 *   - reading `credential` as well as the legacy `code` is the same finding
 *     from the other side (the route read `code`, the UI sent `mfaCode`);
 *   - `availableStepUpMethods` returning the PIN door is P1.6;
 *   - WebAuthn being neither advertised nor parseable is the #854 follow-up F03
 *     (it used to be advertised, refused, and rendered as a text box).
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  STEP_UP_METHODS,
  VERIFIABLE_STEP_UP_METHODS,
  authErrorMessage,
  availableStepUpMethods,
  isAuthErrorCode,
  isNeedsBusinessSelection,
  isStepUpMethod,
  isVerifiableStepUpMethod,
  parseStepUpRequest,
  stepUpBody,
  type StepUpAvailability,
} from "./auth-contracts";

const nothing: StepUpAvailability = {
  hasPassword: false,
  hasPin: false,
  hasTotp: false,
  hasSms: false,
  hasRecoveryCodes: false,
};

describe("parseStepUpRequest", () => {
  it("refuses a body with no method instead of guessing totp", () => {
    /**
     * The old route defaulted to `totp`. That made an SMS-MFA member's code
     * unverifiable against a factor they do not have, and made "I forgot the
     * method" a silent choice of door.
     */
    expect(parseStepUpRequest({ password: "hunter2" })).toEqual({
      ok: false,
      error: "invalid_method",
    });
  });

  it("refuses an unknown method", () => {
    expect(parseStepUpRequest({ method: "sms", credential: "123456" })).toEqual({
      ok: false,
      error: "invalid_method",
    });
  });

  it("requires a credential", () => {
    expect(parseStepUpRequest({ method: "password" })).toEqual({
      ok: false,
      error: "missing_credentials",
    });
    expect(parseStepUpRequest({ method: "totp", credential: "   " })).toEqual({
      ok: false,
      error: "missing_credentials",
    });
  });

  it("accepts the credential under either name, so the old UI keeps working", () => {
    expect(parseStepUpRequest({ method: "totp", credential: "123456" })).toEqual({
      ok: true,
      request: { method: "totp", credential: "123456" },
    });
    expect(parseStepUpRequest({ method: "totp", code: "123456" })).toEqual({
      ok: true,
      request: { method: "totp", credential: "123456" },
    });
  });

  it("carries recovery through without inventing it", () => {
    expect(parseStepUpRequest({ method: "recovery", credential: "abc", recovery: false })).toEqual({
      ok: true,
      request: { method: "recovery", credential: "abc" },
    });
    expect(parseStepUpRequest({ method: "recovery", credential: "abc", recovery: true })).toEqual({
      ok: true,
      request: { method: "recovery", credential: "abc", recovery: true },
    });
  });

  it("#854 F03 — refuses WebAuthn as unsupported, whatever text rides along", () => {
    /**
     * There is no WebAuthn step-up ceremony (server challenge + verified
     * assertion). A body naming the method must never be accepted on the
     * strength of a typed string — not even a well-formed-looking one.
     */
    for (const body of [
      { method: "webauthn", credential: "{}" },
      { method: "webauthn", credential: "123456" },
      { method: "webauthn", credential: '{"id":"x","response":{}}', challengeToken: "t" },
      { method: "webauthn", code: "123456" },
    ]) {
      expect(parseStepUpRequest(body)).toEqual({ ok: false, error: "unsupported_method" });
    }
  });

  it("drops an unknown challengeToken instead of carrying it to a verifier", () => {
    expect(parseStepUpRequest({ method: "pin", credential: "4821", challengeToken: "t" })).toEqual({
      ok: true,
      request: { method: "pin", credential: "4821" },
    });
  });
});

describe("stepUpBody", () => {
  it("round-trips through the parser", () => {
    const body = stepUpBody({ method: "pin", credential: "4821" });
    expect(parseStepUpRequest(JSON.parse(body))).toEqual({
      ok: true,
      request: { method: "pin", credential: "4821" },
    });
  });
});

describe("availableStepUpMethods", () => {
  it("offers the PIN door to a PIN-only member", () => {
    expect(availableStepUpMethods({ ...nothing, hasPin: true })).toEqual(["pin"]);
  });

  it("offers nothing to an account with no credential at all", () => {
    expect(availableStepUpMethods(nothing)).toEqual([]);
  });

  it("puts recovery last, so it is never the default the picker lands on", () => {
    const methods = availableStepUpMethods({
      hasPassword: true,
      hasPin: false,
      hasTotp: true,
      hasSms: true,
      hasRecoveryCodes: true,
    });
    expect(methods).toEqual(["password", "totp", "sms_otp", "recovery"]);
  });

  it("#854 F03 — never advertises a method no ceremony can verify", () => {
    const everything = availableStepUpMethods({
      hasPassword: true,
      hasPin: true,
      hasTotp: true,
      hasSms: true,
      hasRecoveryCodes: true,
    });
    expect(everything).not.toContain("webauthn");
    for (const method of everything) expect(isVerifiableStepUpMethod(method)).toBe(true);
  });
});

describe("VERIFIABLE_STEP_UP_METHODS (#854 F03)", () => {
  it("is the vocabulary minus WebAuthn, and nothing else", () => {
    expect([...VERIFIABLE_STEP_UP_METHODS].sort()).toEqual(
      STEP_UP_METHODS.filter((m) => m !== "webauthn").sort(),
    );
    expect(isVerifiableStepUpMethod("webauthn")).toBe(false);
    expect(isVerifiableStepUpMethod("pin")).toBe(true);
    expect(isVerifiableStepUpMethod(undefined)).toBe(false);
  });

  it("has Persian copy for the unsupported-method and rolled-back-change refusals", () => {
    expect(authErrorMessage(AUTH_ERROR_CODES.unsupportedMethod)).toMatch(/پشتیبانی نمی‌شود/);
    expect(authErrorMessage(AUTH_ERROR_CODES.credentialChangeFailed)).toMatch(
      /هیچ تغییری اعمال نشد/,
    );
  });
});

describe("isStepUpMethod", () => {
  it("knows the vocabulary and nothing else", () => {
    expect(isStepUpMethod("pin")).toBe(true);
    expect(isStepUpMethod("mfaCode")).toBe(false);
    expect(isStepUpMethod(undefined)).toBe(false);
  });
});

describe("error codes", () => {
  it("translates every code it defines", () => {
    /**
     * The drift P2.17 was: a server emitting a code no client map knew, so the
     * user got a generic sentence for a specific refusal.
     */
    for (const code of Object.values(AUTH_ERROR_CODES)) {
      expect(isAuthErrorCode(code)).toBe(true);
      expect(authErrorMessage(code)).not.toContain("خطای غیرمنتظره");
    }
  });

  it("falls back rather than leaking a raw code into the UI", () => {
    expect(authErrorMessage("something_new")).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
    expect(authErrorMessage(undefined)).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
  });

  it("says which surface owns a cloud-managed value", () => {
    expect(authErrorMessage(AUTH_ERROR_CODES.loginManagedByCloud)).toBe(
      "این مورد در نسخهٔ ابری مدیریت می‌شود.",
    );
  });
});

describe("isNeedsBusinessSelection", () => {
  it("requires the list and ignores a stray token", () => {
    expect(
      isNeedsBusinessSelection({
        needsBusinessSelection: true,
        businesses: [{ id: "b1", name: "کافه", slug: "cafe", role: "owner" }],
      }),
    ).toBe(true);
    expect(isNeedsBusinessSelection({ needsBusinessSelection: true })).toBe(false);
    expect(isNeedsBusinessSelection({ businesses: [] })).toBe(false);
  });
});
