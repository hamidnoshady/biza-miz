/**
 * ESH-200 / #1385 — the onboarding continuation is short-lived and
 * purpose-bound, not a second session.
 *
 * These are the properties the cookie's security rests on: it names one
 * platform identity, it cannot be edited, it cannot be replayed as another
 * realm, and an expired token is worth nothing.
 */
import { EncryptJWT } from "jose";
import { describe, expect, it } from "vitest";
import { getRealmSecret } from "../jwt-secret";
import { ONBOARDING_TTL_SECONDS, signOnboardingToken, verifyOnboardingToken } from "./onboarding-session";

const PLATFORM_USER_ID = "11111111-1111-4111-8111-111111111111";

describe("the onboarding continuation", () => {
  it("encrypts one identity and verifies it back for thirty minutes", async () => {
    const token = await signOnboardingToken(PLATFORM_USER_ID);
    expect(token).not.toContain(PLATFORM_USER_ID);
    expect(ONBOARDING_TTL_SECONDS).toBe(30 * 60);
    expect(await verifyOnboardingToken(token)).toBe(PLATFORM_USER_ID);
  });

  it("refuses a tampered or malformed token", async () => {
    const token = await signOnboardingToken(PLATFORM_USER_ID);
    expect(await verifyOnboardingToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(await verifyOnboardingToken("not-a-token")).toBeNull();
    expect(await verifyOnboardingToken(null)).toBeNull();
    expect(await verifyOnboardingToken("x".repeat(5000))).toBeNull();
  });

  it("refuses an expired token and a token minted for another realm", async () => {
    const secret = await getRealmSecret("platform");
    const expired = await new EncryptJWT({ puid: PLATFORM_USER_ID, realm: "onboarding" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt(1)
      .setExpirationTime(2)
      .encrypt(secret);
    expect(await verifyOnboardingToken(expired)).toBeNull();

    const wrongRealm = await new EncryptJWT({ puid: PLATFORM_USER_ID, realm: "phone" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime("30m")
      .encrypt(secret);
    expect(await verifyOnboardingToken(wrongRealm)).toBeNull();
  });
});
