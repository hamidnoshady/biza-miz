import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  TOROB_PUBLIC_KEY_PEM,
  TOROB_TOKEN_VERSION,
  hostForAudience,
  torobAuthHeaders,
  torobPublicKey,
  verifyTorobToken,
} from "./auth";

/**
 * Issue #894 Wave 2 — verifying Torob's token.
 *
 * A private key is generated per run and its public half is what the platform
 * verifies with, so these are real Ed25519 signatures rather than a stubbed
 * verifier: the claim checks are only meaningful if the signature check in front
 * of them also works.
 */

let privateKey: CryptoKey;
let publicKeyPem: string;
let otherPublicKeyPem: string;

const SHOP_HOST = "shop.example.com";

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA");
  privateKey = pair.privateKey;
  publicKeyPem = await exportSPKI(pair.publicKey);
  const stranger = await generateKeyPair("EdDSA");
  otherPublicKeyPem = await exportSPKI(stranger.publicKey);
});

async function token(
  claims: Record<string, unknown>,
  options: {
    aud?: string;
    expseconds?: number;
    expiresIn?: string;
    notBefore?: number;
    key?: CryptoKey;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", v: 1 })
    .setAudience(options.aud ?? SHOP_HOST);
  if (options.notBefore) builder.setNotBefore(options.notBefore);
  else builder.setIssuedAt(now);
  if (options.expiresIn) builder.setExpirationTime(options.expiresIn);
  else builder.setExpirationTime(now + (options.expseconds ?? 300));
  return builder.sign(options.key ?? privateKey);
}

async function check(tokenValue: string | null, overrides: Partial<Parameters<typeof verifyTorobToken>[0]> = {}) {
  return verifyTorobToken({
    token: tokenValue,
    tokenVersion: TOROB_TOKEN_VERSION,
    expectedHost: SHOP_HOST,
    publicKeyPem,
    ...overrides,
  });
}

describe("a valid token", () => {
  it("is accepted and reports the shop's own audience", async () => {
    const result = await check(await token({}));
    expect(result).toMatchObject({ ok: true, audience: SHOP_HOST });
    expect(result.ok && typeof result.expiresAt).toBe("number");
  });

  it("tolerates a port in the audience, a trailing dot and odd casing", async () => {
    // The guide's own table shows `aud` with a port; the shop row stores a bare host.
    for (const aud of ["shop.example.com:8080", "SHOP.Example.COM", "shop.example.com."]) {
      expect(await check(await token({}, { aud })), aud).toMatchObject({ ok: true });
    }
  });
});

describe("missing credentials", () => {
  it("needs a token", async () => {
    expect(await check(null)).toEqual({ ok: false, reason: "missing_token" });
    expect(await check("   ")).toEqual({ ok: false, reason: "missing_token" });
  });

  it("needs a token version, because the guide's format is versioned", async () => {
    expect(await check(await token({}), { tokenVersion: null })).toEqual({
      ok: false,
      reason: "missing_token_version",
    });
    expect(await check(await token({}), { tokenVersion: "2" })).toEqual({
      ok: false,
      reason: "unsupported_token_version",
    });
  });
});

describe("the audience check", () => {
  it("rejects a token minted for another shop", async () => {
    // This is the whole point: a token for shop A must not open shop B.
    expect(await check(await token({}, { aud: "other-shop.example.com" }))).toEqual({
      ok: false,
      reason: "audience_mismatch",
    });
  });

  it("rejects a token with no audience at all", async () => {
    const naked = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", v: 1 })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
    expect(await check(naked)).toEqual({ ok: false, reason: "audience_mismatch" });
  });

  it("compares against the shop record, never against a header", () => {
    // `expectedHost` is the only input; there is no header path into the decision.
    expect(hostForAudience(" Shop.Example.COM. ")).toBe("shop.example.com");
    expect(hostForAudience("shop.example.com:443")).toBe("shop.example.com:443");
  });
});

describe("time", () => {
  it("rejects an expired token as expired, not as invalid", async () => {
    expect(await check(await token({}, { expiresIn: "-1s" }))).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token that is not valid yet as not_yet_valid", async () => {
    const later = Math.floor(Date.now() / 1000) + 60;
    expect(await check(await token({}, { notBefore: later }))).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
  });
});

describe("the signature", () => {
  it("rejects a token signed by anyone but Torob", async () => {
    const stranger = await generateKeyPair("EdDSA");
    expect(await check(await token({}, { key: stranger.privateKey }))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(await check(await token({}), { publicKeyPem: otherPublicKeyPem })).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("rejects a token that is not a JWT at all", async () => {
    expect(await check("not-a-token")).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a symmetric algorithm's token", async () => {
    // `alg: none`/HS256 is the classic downgrade; only EdDSA is allowed.
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT", v: 1 })
      .setAudience(SHOP_HOST)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode("secret"));
    const result = await check(hs);
    expect(result.ok).toBe(false);
    expect(["wrong_algorithm", "invalid_token"]).toContain(result.ok ? "" : result.reason);
  });
});

describe("the key and header plumbing", () => {
  it("falls back to Torob's documented key when nothing is configured", () => {
    expect(torobPublicKey({})).toBe(TOROB_PUBLIC_KEY_PEM);
    expect(TOROB_PUBLIC_KEY_PEM).toContain("BEGIN PUBLIC KEY");
  });

  it("accepts a bare base64 body from a dashboard, and a full PEM", () => {
    const body = TOROB_PUBLIC_KEY_PEM.split("\n")[1];
    expect(torobPublicKey({ TOROB_API_PUBLIC_KEY: body })).toBe(TOROB_PUBLIC_KEY_PEM);
    expect(torobPublicKey({ TOROB_API_PUBLIC_KEY: TOROB_PUBLIC_KEY_PEM })).toBe(TOROB_PUBLIC_KEY_PEM);
  });

  it("reads the two headers from a request exactly once", () => {
    const headers = new Headers({ "X-Torob-Token": "abc", "X-Torob-Token-Version": "1" });
    expect(torobAuthHeaders(headers)).toEqual({ token: "abc", tokenVersion: "1" });
    // `Headers.get` is case-insensitive, so a partner's spelling cannot break it.
    expect(torobAuthHeaders(new Headers({ "x-torob-token": "abc" })).token).toBe("abc");
    expect(torobAuthHeaders(new Headers())).toEqual({ token: null, tokenVersion: null });
  });
});
