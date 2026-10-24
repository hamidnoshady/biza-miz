/**
 * Issue #974 — server-side cryptography, Ed25519 signed offline leases,
 * credential-at-rest sealing, and HTTPS/SSRF Cloud-origin validation for Full
 * Offline (`local`) installations.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomInt,
  sign,
  verify,
} from "node:crypto";
import { PAIRING_CODE_ALPHABET } from "./code-alphabet";
import {
  LOCAL_ENROLLMENT_CODE_PREFIX,
  LOCAL_INSTALLATION_TOKEN_PREFIX,
  normalizeLocalEnrollmentCode,
  normalizeServerAddress,
} from "./connection-code";
import { getMasterKey } from "./master-key";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";
import { assertPublicHttpsUrl } from "./ssrf";
import { LOCAL_ACTIVATION_PROTOCOL_VERSION } from "./local-activation-contract";

export const LOCAL_ENROLLMENT_CODE_TTL_HOURS = 24;
export const LOCAL_ENROLLMENT_SESSION_TTL_MINUTES = 30;
export const DEFAULT_OFFLINE_LEASE_DAYS = 30;

/** Generate a human-typable one-time Full Offline enrollment token: `OFL1-XXXX-XXXX-XXXX`. */
export function generateLocalEnrollmentCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g += 1) {
    let part = "";
    for (let i = 0; i < 4; i += 1) {
      part += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    groups.push(part);
  }
  return `${LOCAL_ENROLLMENT_CODE_PREFIX}-${groups.join("-")}`;
}

export function hashLocalEnrollmentCode(raw: string): string {
  return createHash("sha256")
    .update(normalizeLocalEnrollmentCode(raw), "utf8")
    .digest("hex");
}

/** Generate a scoped machine-to-cloud validation bearer secret (`LOC1-<48 b64url chars>`). */
export function generateLocalInstallationToken(): string {
  return `${LOCAL_INSTALLATION_TOKEN_PREFIX}-${randomBytes(36).toString("base64url")}`;
}

export function hashLocalInstallationToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/**
 * Encrypts the installation bearer credential at rest on the local database.
 *
 * Prefers `POS_MASTER_KEY` / OS-protected Desktop KEK (`mk1.`) and falls back to
 * `resolveEncryptionKey(process.env)` (`ek1.`) in test/dev environments where a
 * separate `POS_MASTER_KEY` was not configured. Plaintext is never stored.
 */
export function sealLocalCredential(
  plainToken: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const masterKey = getMasterKey();
  if (masterKey) {
    return `mk1.${encryptSecret(plainToken, masterKey)}`;
  }
  return `ek1.${encryptSecret(plainToken, resolveEncryptionKey(env))}`;
}

export function openLocalCredential(
  sealed: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const text = typeof sealed === "string" ? sealed.trim() : "";
  if (!text) return null;
  try {
    if (text.startsWith("mk1.")) {
      const masterKey = getMasterKey();
      if (!masterKey) return null;
      return decryptSecret(text.slice(4), masterKey);
    }
    if (text.startsWith("ek1.")) {
      return decryptSecret(text.slice(4), resolveEncryptionKey(env));
    }
    // Compatibility with unadorned v1 ciphertexts if ever written via encryptSecret.
    return decryptSecret(text, resolveEncryptionKey(env));
  } catch {
    return null;
  }
}

// ASN.1 PKCS#8 prefix for a 32-byte Ed25519 private key seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function deriveCloudLeaseKeyPair(env: Record<string, string | undefined> = process.env) {
  const baseKey = resolveEncryptionKey(env);
  const seed = createHash("sha256")
    .update("biza-local-activation-lease-ed25519-v1:", "utf8")
    .update(baseKey)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { privateKey, publicKeyPem };
}

export interface SignedOfflineLeasePayload {
  protocol: typeof LOCAL_ACTIVATION_PROTOCOL_VERSION;
  installationId: string;
  cloudBusinessId: string;
  issuedAt: string;
  expiresAt: string;
  enforceOfflineLease: boolean;
}

export interface SignedOfflineLease {
  payload: SignedOfflineLeasePayload;
  signature: string;
  publicKeyPem: string;
}

function canonicalLeaseBytes(payload: SignedOfflineLeasePayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      protocol: payload.protocol,
      installationId: payload.installationId,
      cloudBusinessId: payload.cloudBusinessId,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      enforceOfflineLease: payload.enforceOfflineLease,
    }),
    "utf8",
  );
}

export function signOfflineLease(
  input: {
    installationId: string;
    cloudBusinessId: string;
    issuedAt?: Date;
    leaseDays?: number | null;
    enforceOfflineLease?: boolean;
  },
  env: Record<string, string | undefined> = process.env,
): SignedOfflineLease {
  const issued = input.issuedAt ?? new Date();
  const days = input.leaseDays && input.leaseDays > 0 ? input.leaseDays : DEFAULT_OFFLINE_LEASE_DAYS;
  const expires = new Date(issued.getTime() + days * 24 * 60 * 60 * 1000);
  const payload: SignedOfflineLeasePayload = {
    protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
    installationId: input.installationId,
    cloudBusinessId: input.cloudBusinessId,
    issuedAt: issued.toISOString(),
    expiresAt: expires.toISOString(),
    enforceOfflineLease: Boolean(input.enforceOfflineLease),
  };
  const { privateKey, publicKeyPem } = deriveCloudLeaseKeyPair(env);
  const signature = sign(null, canonicalLeaseBytes(payload), privateKey).toString("base64url");
  return { payload, signature, publicKeyPem };
}

export type LeaseVerificationResult =
  | { valid: true; enforced: boolean; expiresAt: string }
  | {
      valid: false;
      reason:
        | "missing_lease"
        | "signature_invalid"
        | "binding_mismatch"
        | "clock_rollback_detected"
        | "lease_expired";
    };

/** Clock skew tolerance (5 minutes) for minor NTP adjustments. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export function verifyOfflineLease(input: {
  payload: SignedOfflineLeasePayload | null | undefined;
  signature: string | null | undefined;
  publicKeyPem: string | null | undefined;
  expectedInstallationId: string;
  expectedCloudBusinessId: string;
  enforceOfflineLease: boolean;
  maxObservedClockAt?: Date | string | null;
  now?: Date;
}): LeaseVerificationResult {
  if (!input.enforceOfflineLease) {
    return {
      valid: true,
      enforced: false,
      expiresAt: input.payload?.expiresAt ?? "",
    };
  }
  if (!input.payload || !input.signature || !input.publicKeyPem) {
    return { valid: false, reason: "missing_lease" };
  }
  if (
    input.payload.protocol !== LOCAL_ACTIVATION_PROTOCOL_VERSION ||
    input.payload.installationId !== input.expectedInstallationId ||
    input.payload.cloudBusinessId !== input.expectedCloudBusinessId
  ) {
    return { valid: false, reason: "binding_mismatch" };
  }
  try {
    const pub = createPublicKey(input.publicKeyPem);
    const sigOk = verify(
      null,
      canonicalLeaseBytes(input.payload),
      pub,
      Buffer.from(input.signature, "base64url"),
    );
    if (!sigOk) return { valid: false, reason: "signature_invalid" };
  } catch {
    return { valid: false, reason: "signature_invalid" };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const issuedMs = Date.parse(input.payload.issuedAt);
  const expiresMs = Date.parse(input.payload.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return { valid: false, reason: "signature_invalid" };
  }

  const maxObservedMs = input.maxObservedClockAt
    ? new Date(input.maxObservedClockAt).getTime()
    : 0;
  if (
    nowMs + CLOCK_SKEW_TOLERANCE_MS < issuedMs ||
    (Number.isFinite(maxObservedMs) && maxObservedMs > 0 && nowMs + CLOCK_SKEW_TOLERANCE_MS < maxObservedMs)
  ) {
    return { valid: false, reason: "clock_rollback_detected" };
  }

  if (nowMs > expiresMs) {
    return { valid: false, reason: "lease_expired" };
  }

  return { valid: true, enforced: true, expiresAt: input.payload.expiresAt };
}

export type CloudOriginValidationResult =
  | { ok: true; origin: string }
  | {
      ok: false;
      error:
        | "missing_cloud_url"
        | "invalid_cloud_url"
        | "https_required"
        | "private_or_loopback_forbidden";
    };

/**
 * Validates the Cloud server origin for Full Offline activation & validation:
 *   - Must normalize cleanly to an origin (`https://host[:port]`)
 *   - Must use `https://` and resolve only to public addresses (SSRF guard)
 *   - Loopback (`http://127.0.0.1:<port>`) is permitted ONLY when explicitly
 *     running inside automated tests (`NODE_ENV === "test"` or `"development"`)
 *     or packaged CI smoke mode (`DESKTOP_SMOKE_MARKER`), AND
 *     `LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK === "1"` — NEVER in normal
 *     production Desktop runs, and NEVER for RFC1918 LAN or metadata IPs.
 */
export async function validateCloudOriginForLocalActivation(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): Promise<CloudOriginValidationResult> {
  const normalized = normalizeServerAddress(rawUrl);
  if (!normalized.ok) {
    return {
      ok: false,
      error: normalized.error === "missing_address" ? "missing_cloud_url" : "invalid_cloud_url",
    };
  }

  const parsed = new URL(normalized.url);
  const allowTestLoopback =
    env.LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK === "1" &&
    (env.NODE_ENV === "test" ||
      env.NODE_ENV === "development" ||
      Boolean(env.DESKTOP_SMOKE_MARKER?.trim()));

  if (allowTestLoopback && parsed.hostname === "127.0.0.1") {
    return { ok: true, origin: normalized.url };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "https_required" };
  }

  const ssrf = await assertPublicHttpsUrl(normalized.url);
  if (!ssrf.ok) {
    return {
      ok: false,
      error: ssrf.reason === "not_https" ? "https_required" : "private_or_loopback_forbidden",
    };
  }

  return { ok: true, origin: normalized.url };
}
