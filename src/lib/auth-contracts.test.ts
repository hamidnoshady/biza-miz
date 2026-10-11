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
 *   - `availableStepUpMethods` returning the PIN door is P1.6.
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  authErrorMessage,
  availableStepUpMethods,
  isAuthErrorCode,
  isNeedsBusinessSelection,
  isStepUpMethod,
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
  hasWebauthn: false,
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

  it("carries recovery and challengeToken through without inventing them", () => {
    expect(parseStepUpRequest({ method: "recovery", credential: "abc", recovery: false })).toEqual({
      ok: true,
      request: { method: "recovery", credential: "abc" },
    });
    expect(
      parseStepUpRequest({ method: "webauthn", credential: "{}", challengeToken: "t" }),
    ).toEqual({
      ok: true,
      request: { method: "webauthn", credential: "{}", challengeToken: "t" },
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
      hasWebauthn: false,
    });
    expect(methods).toEqual(["password", "totp", "sms_otp", "recovery"]);
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
