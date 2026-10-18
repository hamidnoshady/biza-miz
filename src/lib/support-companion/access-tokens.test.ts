import { describe, expect, it } from "vitest";
import { SignJWT, importJWK } from "jose";
import {
  SUPPORT_TOKEN_AUDIENCE_ONSITE,
  SUPPORT_TOKEN_ISSUER,
  generateOfflineTokenKeys,
  generateOnlineCode,
  generateSupportTokenKeys,
  grantableOperations,
  normalizeOnlineCode,
  resolveOfflineTokenKeys,
  resolveSupportTokenKeys,
  sha256Hex,
  verifyOfflineToken,
  type OfflineTokenKeys,
} from "./access-tokens";

async function testKeys(kid = "test-k1"): Promise<OfflineTokenKeys> {
  const { privateJwk, publicJwk } = await generateOfflineTokenKeys();
  return { kid, privateJwk, publicJwks: [{ ...publicJwk, kid }] };
}

async function signOffline(input: {
  keys: OfflineTokenKeys;
  claims?: Record<string, unknown>;
  kid?: string;
  expiresInSeconds?: number;
  notBeforeSeconds?: number;
  audience?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    ticket_id: "ticket-1",
    business_id: "biz-1",
    installation_id: "inst-1",
    installation_generation: 3,
    operator_admin_id: "op-1",
    scope: ["diagnostics.run", "report.upload"],
    technician_binding_hash: "techhash",
    challenge: "nonce-1",
    policy_version: "v1",
    ...(input.claims ?? {}),
  })
    .setProtectedHeader({ alg: "ES256", kid: input.kid ?? input.keys.kid })
    .setIssuer(SUPPORT_TOKEN_ISSUER)
    .setAudience(input.audience ?? SUPPORT_TOKEN_AUDIENCE_ONSITE)
    .setJti("jti-1")
    .setIssuedAt(now)
    .setNotBefore(now + (input.notBeforeSeconds ?? 0))
    .setExpirationTime(now + (input.expiresInSeconds ?? 1800));
  return builder.sign(await importJWK(input.keys.privateJwk, "ES256"));
}

describe("support access tokens (issue #984)", () => {
  it("maps capabilities to grantable operations without widening", () => {
    expect(grantableOperations(["support.manage"])).toEqual([]);
    expect(grantableOperations(["support.diagnostics.request"])).toEqual([
      "diagnostics.run",
      "report.upload",
    ]);
    expect(
      grantableOperations(["support.repair.propose", "support.assist.view", "support.ai.use"]),
    ).toEqual(["repair.propose", "remote.view", "ai.assist"]);
    // Execution and control need their own (owner-only) capabilities.
    expect(grantableOperations(["support.repair.propose"])).not.toContain("repair.execute");
    expect(grantableOperations(["support.assist.view"])).not.toContain("remote.control");
  });

  it("generates unambiguous human codes and normalizes pasted input", () => {
    const code = generateOnlineCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01ILO]/);
    expect(normalizeOnlineCode("  abcd-1234 ")).toBe("ABCD1234");
    expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to resolve signing keys from a missing or wrong-shaped env", () => {
    expect(() => resolveSupportTokenKeys({})).toThrow("SUPPORT_TOKEN_SIGNING_KEY is not set");
    expect(() => resolveSupportTokenKeys({ SUPPORT_TOKEN_SIGNING_KEY: "nope" })).toThrow("JWK JSON");
    expect(() =>
      resolveSupportTokenKeys({
        SUPPORT_TOKEN_SIGNING_KEY: JSON.stringify({ kty: "oct", k: "x" }),
      }),
    ).toThrow("Ed25519 private JWK");
    // The offline key set is separate (P-256 for .NET base-framework verify).
    expect(() => resolveOfflineTokenKeys({})).toThrow("SUPPORT_OFFLINE_TOKEN_SIGNING_KEY is not set");
    expect(() => resolveOfflineTokenKeys({ SUPPORT_OFFLINE_TOKEN_SIGNING_KEY: "nope" })).toThrow(
      "JWK JSON",
    );
    expect(() =>
      resolveOfflineTokenKeys({
        SUPPORT_OFFLINE_TOKEN_SIGNING_KEY: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "x" }),
      }),
    ).toThrow("P-256 private JWK");
  });

  it("refuses an Ed25519 offline token: offline tokens must be ES256", async () => {
    const keys = await testKeys();
    const { privateJwk: edPrivate } = await generateSupportTokenKeys();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ticket_id: "ticket-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: keys.kid })
      .setIssuer(SUPPORT_TOKEN_ISSUER)
      .setAudience(SUPPORT_TOKEN_AUDIENCE_ONSITE)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(await importJWK(edPrivate, "EdDSA"));
    await expect(verifyOfflineToken(token, keys)).resolves.toEqual({
      ok: false,
      error: "invalid_signature",
    });
  });

  it("verifies a well-formed offline token and reads its claims", async () => {
    const keys = await testKeys();
    const token = await signOffline({ keys });
    const verified = await verifyOfflineToken(token, keys);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      jti: "jti-1",
      ticketId: "ticket-1",
      businessId: "biz-1",
      installationId: "inst-1",
      installationGeneration: 3,
      operatorAdminId: "op-1",
      technicianBindingHash: "techhash",
      challenge: "nonce-1",
    });
    expect(verified.claims.scope).toEqual(["diagnostics.run", "report.upload"]);
  });

  it("rejects tampered payloads", async () => {
    const keys = await testKeys();
    const token = await signOffline({ keys });
    const [header, payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        scope: ["remote.control"],
      }),
    ).toString("base64url");
    const verified = await verifyOfflineToken(`${header}.${tamperedPayload}.${signature}`, keys);
    expect(verified).toEqual({ ok: false, error: "invalid_signature" });
  });

  it("rejects tokens signed by an unknown key (no self-issued bypass)", async () => {
    const keys = await testKeys("approved-k1");
    const attacker = await testKeys("attacker-k9");
    const token = await signOffline({ keys: attacker });
    expect(await verifyOfflineToken(token, keys)).toEqual({ ok: false, error: "unknown_key" });
    // Even the right key id with the wrong key material fails the signature.
    const crossSigned = await signOffline({ keys: attacker, kid: "approved-k1" });
    const verdict = await verifyOfflineToken(crossSigned, keys);
    expect(verdict.ok).toBe(false);
  });

  it("rejects expired, premature and wrong-audience tokens", async () => {
    const keys = await testKeys();
    expect(await verifyOfflineToken(await signOffline({ keys, expiresInSeconds: -10 }), keys)).toEqual({
      ok: false,
      error: "expired",
    });
    expect(
      await verifyOfflineToken(await signOffline({ keys, notBeforeSeconds: 600 }), keys),
    ).toEqual({ ok: false, error: "not_yet_valid" });
    expect(
      await verifyOfflineToken(await signOffline({ keys, audience: "something-else" }), keys),
    ).toEqual({ ok: false, error: "wrong_audience" });
  });

  it("rejects malformed tokens and malformed claims", async () => {
    const keys = await testKeys();
    expect(await verifyOfflineToken("not-a-jwt", keys)).toEqual({ ok: false, error: "malformed" });
    const missingClaims = await signOffline({ keys, claims: { scope: ["diagnostics.run"] } });
    // Drop a required claim by re-signing without it.
    const now = Math.floor(Date.now() / 1000);
    const bad = await new SignJWT({ scope: ["diagnostics.run"] })
      .setProtectedHeader({ alg: "ES256", kid: keys.kid })
      .setIssuer(SUPPORT_TOKEN_ISSUER)
      .setAudience(SUPPORT_TOKEN_AUDIENCE_ONSITE)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(await importJWK(keys.privateJwk, "ES256"));
    expect(await verifyOfflineToken(bad, keys)).toEqual({ ok: false, error: "malformed" });
    expect(missingClaims.length).toBeGreaterThan(0);
  });
});
