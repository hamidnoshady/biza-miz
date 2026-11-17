/**
 * ESH-199 / #1384 — the phone rules that need no database.
 *
 * The race and the stamps are proved in
 * `integration/global-identity.integration.test.ts`; this file pins the decision
 * every door shares before it touches one: what a typed number becomes, and
 * what is refused outright.
 */
import { describe, expect, it } from "vitest";
import { preparePhoneClaim } from "./global-identity-service";

describe("preparePhoneClaim", () => {
  it("canonicalises every way an Iranian types the same mobile", () => {
    for (const typed of [
      "۰۹۱۲ ۱۲۳ ۴۵۶۷",
      "09121234567",
      "+989121234567",
      "00989121234567",
      "9121234567",
    ]) {
      expect(preparePhoneClaim(typed)).toEqual({ ok: true, phoneE164: "+989121234567" });
    }
  });

  it("refuses a landline — verified, but unable to receive the code", () => {
    expect(preparePhoneClaim("02112345678")).toEqual({ ok: false, error: "not_mobile" });
  });

  it("refuses junk rather than storing digits it cannot prove", () => {
    expect(preparePhoneClaim("call me")).toEqual({ ok: false, error: "invalid_phone" });
    expect(preparePhoneClaim("12345")).toEqual({ ok: false, error: "invalid_phone" });
  });

  it("refuses empty and whitespace-only input", () => {
    expect(preparePhoneClaim("")).toEqual({ ok: false, error: "invalid_phone" });
    expect(preparePhoneClaim("   ")).toEqual({ ok: false, error: "invalid_phone" });
    expect(preparePhoneClaim(null)).toEqual({ ok: false, error: "invalid_phone" });
    expect(preparePhoneClaim(undefined)).toEqual({ ok: false, error: "invalid_phone" });
  });
});
