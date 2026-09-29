/**
 * The pure half of owner activation (issue #755 §14).
 *
 * The database-touching half is covered by integration/owner-activation, which
 * needs Postgres. These are the pieces that decide things on their own and are
 * cheap to get subtly wrong:
 *
 *   - a token is only ever stored as a hash, and two tokens never collide;
 *   - the status of a link is derived, not stored, so an expired link is
 *     recognised without a background job — and "expired" must not be
 *     reachable while a link is still inside its window;
 *   - the masked phone on the public preview must never be the whole number.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_TTL_DAYS,
  MIN_OWNER_PASSWORD_LENGTH,
  activationExpiry,
  activationStatus,
  generateActivationToken,
  hashActivationToken,
  maskPhone,
} from "./owner-activation";

describe("activation tokens", () => {
  it("stores a hash, never the plaintext, and never collides", () => {
    const a = generateActivationToken();
    const b = generateActivationToken();

    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
    expect(a.tokenHash).toBe(hashActivationToken(a.token));
    expect(a.tokenHash).not.toContain(a.token);
    // Recognisable in a log or a paste, like every other one-time token here.
    expect(a.token.startsWith("act_")).toBe(true);
    // 32 bytes of entropy, hex-encoded.
    expect(a.token.length).toBe("act_".length + 64);
  });

  it("hashes deterministically, so a presented token can be looked up", () => {
    expect(hashActivationToken("act_abc")).toBe(hashActivationToken("act_abc"));
    expect(hashActivationToken("act_abc")).not.toBe(hashActivationToken("act_abd"));
  });
});

describe("activation expiry", () => {
  it("is the documented window from the given moment", () => {
    const now = new Date("2026-09-29T00:00:00.000Z");
    const expiry = activationExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(ACTIVATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("activation status", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");

  it("is pending inside the window", () => {
    expect(
      activationStatus({ expiresAt: new Date(now.getTime() + 1000), acceptedAt: null, revokedAt: null }, now),
    ).toBe("pending");
  });

  it("expires at the boundary rather than a moment after it", () => {
    expect(activationStatus({ expiresAt: now, acceptedAt: null, revokedAt: null }, now)).toBe("expired");
  });

  it("reports use and revocation ahead of expiry", () => {
    const past = new Date(now.getTime() - 1000);
    expect(activationStatus({ expiresAt: past, acceptedAt: now, revokedAt: null }, now)).toBe("accepted");
    expect(activationStatus({ expiresAt: past, acceptedAt: null, revokedAt: now }, now)).toBe("revoked");
    // A used link that was also later revoked reads as used — the first thing
    // that happened is the honest answer to "why can't I use this".
    expect(activationStatus({ expiresAt: past, acceptedAt: now, revokedAt: now }, now)).toBe("accepted");
  });

  it("accepts the ISO strings a JSON round trip produces", () => {
    const iso = new Date(now.getTime() + 60_000).toISOString();
    expect(activationStatus({ expiresAt: iso, acceptedAt: null, revokedAt: null }, now)).toBe("pending");
  });
});

describe("maskPhone", () => {
  it("shows only the last four digits", () => {
    expect(maskPhone("+989121234567")).toBe("••••4567");
    expect(maskPhone("09121234567")).toBe("••••4567");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("")).toBeNull();
    // Nothing to hide means nothing to show, rather than three "digits".
    expect(maskPhone("12")).toBeNull();
  });
});

describe("the password policy the owner is held to", () => {
  it("requires a real password, not a formality", () => {
    // Low on purpose: activation passwords are the tenant owner's own, and the
    // strength that matters is re-set at every door login anyway.
    expect(MIN_OWNER_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });
});
