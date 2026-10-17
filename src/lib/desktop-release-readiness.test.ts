import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateReleaseReadiness, publicKeyFingerprint } from "./desktop-release-readiness";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const facts = { policyTablesReady: true, publishedReleaseCount: 2, lastRegistration: { at: "2026-10-16T10:00:00.000Z", version: "1.2.3" } };
const good = { DESKTOP_RELEASE_PUBLISH_TOKEN: "t".repeat(48), DESKTOP_RELEASE_PUBLIC_KEY_PEM: publicPem };
const status = (result: ReturnType<typeof evaluateReleaseReadiness>, id: string) => result.checks.find((check) => check.id === id)?.status;

describe("evaluateReleaseReadiness", () => {
  it("is ready with a token, a parseable public key and applied migrations", () => {
    const result = evaluateReleaseReadiness(good, facts);
    expect(result.ready).toBe(true);
    expect(result.publicKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the key the way Coolify stores a single-line variable (escaped newlines)", () => {
    expect(publicKeyFingerprint(publicPem.replaceAll("\n", "\\n"))).toBe(publicKeyFingerprint(publicPem));
  });

  it("fails — and names the layer — when the token or public key is missing or unparseable", () => {
    const result = evaluateReleaseReadiness({}, facts);
    expect(result.ready).toBe(false);
    expect(status(result, "publish_token")).toBe("fail");
    expect(status(result, "public_key")).toBe("fail");
    expect(result.checks.find((check) => check.id === "public_key")?.layer).toBe("central_config");
    expect(status(evaluateReleaseReadiness({ ...good, DESKTOP_RELEASE_PUBLIC_KEY_PEM: "not a key" }, facts), "public_key")).toBe("fail");
  });

  it("flags a short token and a missing migration", () => {
    expect(status(evaluateReleaseReadiness({ ...good, DESKTOP_RELEASE_PUBLISH_TOKEN: "short" }, facts), "publish_token")).toBe("warn");
    const result = evaluateReleaseReadiness(good, { ...facts, policyTablesReady: false });
    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.id === "policy_tables")?.layer).toBe("central_database");
  });

  it("fails when a credential that must never reach Central is there, without echoing it", () => {
    const secret = "do-not-print-this-value";
    const result = evaluateReleaseReadiness({
      ...good, DESKTOP_RELEASE_PRIVATE_KEY_PEM: privatePem, COOLIFY_API_TOKEN: secret, NEXT_PUBLIC_RELEASE_TOKEN: secret,
    }, facts);
    expect(result.ready).toBe(false);
    expect(status(result, "forbidden_desktop_release_private_key_pem")).toBe("fail");
    expect(status(result, "forbidden_coolify_api_token")).toBe("fail");
    expect(status(result, "public_env_secret")).toBe("fail");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain(good.DESKTOP_RELEASE_PUBLISH_TOKEN);
  });

  it("an empty catalogue or no registration is a warning, not a failure", () => {
    const result = evaluateReleaseReadiness(good, { ...facts, publishedReleaseCount: 0, lastRegistration: null });
    expect(result.ready).toBe(true);
    expect(status(result, "published_release")).toBe("warn");
    expect(status(result, "last_registration")).toBe("warn");
  });
});
