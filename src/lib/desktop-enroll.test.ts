import { describe, expect, it } from "vitest";
import {
  canApprove,
  deviceSecretMatches,
  ENROLLMENT_TTL_SECONDS,
  enrollmentPollKey,
  enrollmentVerificationUrl,
  formatUserCode,
  generateUserCode,
  hashDeviceSecret,
  isDeviceSecret,
  isEnrollmentRequestId,
  isInstallationId,
  isVerificationUrlFor,
  newDeviceSecret,
  normalizeUserCode,
  pollEnrollment,
} from "./desktop-enroll";

const REQUEST_ID = "6f1d5a7e-2b3c-4d5e-8f90-1a2b3c4d5e6f";
const NOT_FOUND_ID = "00000000-0000-4000-8000-000000000000";

describe("device secret", () => {
  it("mints 32-byte base64url secrets", () => {
    const secret = newDeviceSecret();
    expect(isDeviceSecret(secret)).toBe(true);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newDeviceSecret()).not.toBe(secret);
  });

  it("rejects short, empty and non-string values", () => {
    for (const value of ["", "short", "x".repeat(39), null, undefined, 42, {}]) {
      expect(isDeviceSecret(value)).toBe(false);
    }
  });

  it("matches only the secret whose hash was stored", () => {
    const secret = newDeviceSecret();
    const stored = hashDeviceSecret(secret);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceSecretMatches(secret, stored)).toBe(true);
    expect(deviceSecretMatches(newDeviceSecret(), stored)).toBe(false);
    expect(deviceSecretMatches(secret, hashDeviceSecret(newDeviceSecret()))).toBe(false);
  });

  it("refuses malformed hashes instead of throwing", () => {
    const secret = newDeviceSecret();
    expect(deviceSecretMatches(secret, "")).toBe(false);
    expect(deviceSecretMatches(secret, "not-a-hash")).toBe(false);
    expect(deviceSecretMatches("nope", hashDeviceSecret(secret))).toBe(false);
  });
});

describe("user code", () => {
  it("issues eight characters from the pairing alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateUserCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
      expect(normalizeUserCode(code)).toBe(code);
    }
  });

  it("shows and folds the code a person reads back", () => {
    expect(formatUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeUserCode("ABCD EFGH")).toBe("ABCDEFGH");
    // Persian digits and the O/0, I/1 look-alikes the alphabet avoids.
    expect(normalizeUserCode("01234567")).toBe("OI234567");
    // Persian digits fold to Latin, and 1 folds onto I like the pairing alphabet.
    expect(normalizeUserCode("۱۲۳۴۵۶۷۸")).toBe("I2345678");
    expect(formatUserCode("oi234567")).toBe("OI23-4567");
  });
});

describe("verification url", () => {
  it("builds exactly this request's page over HTTPS", () => {
    expect(enrollmentVerificationUrl("https://cafe.example.com", REQUEST_ID)).toBe(
      `https://cafe.example.com/desktop-enroll/${REQUEST_ID}`,
    );
    // A trailing root path is still a root origin.
    expect(enrollmentVerificationUrl("https://cafe.example.com/", REQUEST_ID)).toBe(
      `https://cafe.example.com/desktop-enroll/${REQUEST_ID}`,
    );
  });

  it("refuses insecure, pathed, query-bearing or non-UUID targets", () => {
    expect(enrollmentVerificationUrl("http://cafe.example.com", REQUEST_ID)).toBeNull();
    expect(enrollmentVerificationUrl("https://cafe.example.com/dashboard", REQUEST_ID)).toBeNull();
    expect(enrollmentVerificationUrl("https://cafe.example.com/?x=1", REQUEST_ID)).toBeNull();
    expect(enrollmentVerificationUrl("https://user:pw@cafe.example.com", REQUEST_ID)).toBeNull();
    expect(enrollmentVerificationUrl("not a url", REQUEST_ID)).toBeNull();
    expect(enrollmentVerificationUrl("https://cafe.example.com", "not-a-uuid")).toBeNull();
  });

  it("checks the Cloud's answer against the origin the owner typed", () => {
    const url = `https://cafe.example.com/desktop-enroll/${REQUEST_ID}`;
    expect(isVerificationUrlFor(url, "https://cafe.example.com", REQUEST_ID)).toBe(true);
    expect(isVerificationUrlFor(url, "https://other.example.com", REQUEST_ID)).toBe(false);
    expect(
      isVerificationUrlFor(`https://evil.example.com/desktop-enroll/${REQUEST_ID}`, "https://cafe.example.com", REQUEST_ID),
    ).toBe(false);
    expect(isVerificationUrlFor(url, "https://cafe.example.com", NOT_FOUND_ID)).toBe(false);
    expect(isVerificationUrlFor(null, "https://cafe.example.com", REQUEST_ID)).toBe(false);
  });
});

describe("identifiers", () => {
  it("accepts only canonical request ids and installation ids", () => {
    expect(isEnrollmentRequestId(REQUEST_ID)).toBe(true);
    expect(isEnrollmentRequestId("not-a-uuid")).toBe(false);
    expect(isEnrollmentRequestId(null)).toBe(false);
    expect(isInstallationId("desktop-instance-1")).toBe(true);
    expect(isInstallationId("short")).toBe(false);
    expect(isInstallationId("x".repeat(201))).toBe(false);
    expect(isInstallationId("has space in it")).toBe(false);
  });
});

describe("poll answers", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const live = new Date("2026-11-18T10:10:00Z");
  const past = new Date("2026-11-18T09:59:59Z");

  it("answers not_found for a row that is not there", () => {
    expect(pollEnrollment(null, null, now)).toEqual({ status: "not_found" });
  });

  it("answers pending while the owner has not acted", () => {
    expect(pollEnrollment({ state: "pending", expiresAt: live, hasPairingCode: false }, null, now)).toEqual({
      status: "pending",
      expiresAt: live.toISOString(),
    });
  });

  it("never treats an unfinished approval as approved", () => {
    expect(pollEnrollment({ state: "approved", expiresAt: live, hasPairingCode: false }, null, now)).toEqual({
      status: "pending",
      expiresAt: live.toISOString(),
    });
    expect(pollEnrollment({ state: "approved", expiresAt: live, hasPairingCode: true }, null, now)).toEqual({
      status: "pending",
      expiresAt: live.toISOString(),
    });
  });

  it("hands over the code exactly when it is sealed and live", () => {
    expect(
      pollEnrollment({ state: "approved", expiresAt: live, hasPairingCode: true }, "ABCD-EFGH-JKLM", now),
    ).toEqual({ status: "approved", pairingCode: "ABCD-EFGH-JKLM", expiresAt: live.toISOString() });
  });

  it("expires whatever the columns still say", () => {
    expect(pollEnrollment({ state: "pending", expiresAt: past, hasPairingCode: false }, null, now)).toEqual({
      status: "expired",
    });
    expect(
      pollEnrollment({ state: "approved", expiresAt: past, hasPairingCode: true }, "ABCD-EFGH-JKLM", now),
    ).toEqual({ status: "expired" });
  });

  it("reports a refusal as a refusal", () => {
    expect(pollEnrollment({ state: "denied", expiresAt: live, hasPairingCode: false }, null, now)).toEqual({
      status: "denied",
    });
  });
});

describe("approval claim", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const live = new Date("2026-11-18T10:10:00Z");
  const past = new Date("2026-11-18T09:59:59Z");

  it("accepts a live pending request", () => {
    expect(canApprove({ state: "pending", expiresAt: live, hasPairingCode: false }, now)).toBe(true);
  });

  it("lets a retry finish an interrupted approval", () => {
    expect(canApprove({ state: "approved", expiresAt: live, hasPairingCode: false }, now)).toBe(true);
  });

  it("refuses to mint a second code for an approval that already has one", () => {
    expect(canApprove({ state: "approved", expiresAt: live, hasPairingCode: true }, now)).toBe(false);
  });

  it("refuses expired, refused and missing requests", () => {
    expect(canApprove({ state: "pending", expiresAt: past, hasPairingCode: false }, now)).toBe(false);
    expect(canApprove({ state: "denied", expiresAt: live, hasPairingCode: false }, now)).toBe(false);
    expect(canApprove({ state: "expired", expiresAt: live, hasPairingCode: false }, now)).toBe(false);
    expect(canApprove(null, now)).toBe(false);
  });
});

describe("constants", () => {
  it("keeps the reservation short-lived and per-request", () => {
    expect(ENROLLMENT_TTL_SECONDS).toBe(600);
    expect(enrollmentPollKey(REQUEST_ID)).toContain(REQUEST_ID);
    expect(enrollmentPollKey(REQUEST_ID)).not.toBe(enrollmentPollKey(NOT_FOUND_ID));
  });
});
