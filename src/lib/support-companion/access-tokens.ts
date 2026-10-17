/**
 * Issue #984 — ticket-issued on-site access tokens.
 *
 * Two purposes, one discipline (hash-only storage, mirroring
 * `site-device-service.ts`):
 *
 * - `online_code`: a short one-time human code. Only its sha256 is stored;
 *   redeeming is one atomic UPDATE, so a code can never be consumed twice.
 *   It redeems server-side into a ticket-bound support session JWT.
 * - `offline_onsite`: an ES256-signed JWT the mini app validates locally
 *   against approved public keys — no main DB, no internet. Bound to the
 *   installation's generation and the technician's proof-of-possession
 *   fingerprint. There is no universal password and no self-issued token:
 *   without valid signed authority the companion stays locked.
 *
 * The ticket keeps the token id/fingerprint, scope, expiry and redemption
 * state — reusable plaintext is shown once at issuance and never stored,
 * logged, embedded in tickets/reports, or put in URLs.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { importJWK, SignJWT, jwtVerify, generateKeyPair, exportJWK, type JWK } from "jose";
import { query, withTenant } from "../db";
import type { PlatformCapability } from "../platform-admin";
import {
  SUPPORT_TOKEN_MAX_MINUTES,
  SUPPORT_TOKEN_REDEMPTION_MINUTES,
  isSupportOperation,
  type SupportOperation,
  type SupportTokenPurpose,
  type SupportTokenState,
} from "./types";
import { getInstallation } from "./installations";

export const SUPPORT_TOKEN_AUDIENCE_ONSITE = "support-companion-onsite";
export const SUPPORT_TOKEN_AUDIENCE_SESSION = "support-companion-session";
export const SUPPORT_TOKEN_ISSUER = "biza-miz-support";
export const SUPPORT_SESSION_MINUTES = 15;

/** Capability → token operation mapping: issuance can never exceed the operator's own authority. */
export function grantableOperations(caps: readonly PlatformCapability[]): SupportOperation[] {
  const ops: SupportOperation[] = [];
  const has = (cap: PlatformCapability) => caps.includes(cap);
  if (has("support.diagnostics.request")) ops.push("diagnostics.run", "report.upload");
  if (has("support.repair.propose")) ops.push("repair.propose");
  if (has("support.repair.execute")) ops.push("repair.execute");
  if (has("support.assist.view")) ops.push("remote.view");
  if (has("support.assist.control")) ops.push("remote.control");
  if (has("support.ai.use")) ops.push("ai.assist");
  return ops;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ── Signing keys (server-only; never in tokens, reports or tickets) ─────────

export interface SupportTokenKeys {
  kid: string;
  privateJwk: JWK;
  publicJwks: JWK[];
}

export function resolveSupportTokenKeys(env: Record<string, string | undefined>): SupportTokenKeys {
  const kid = env.SUPPORT_TOKEN_KEY_ID?.trim() || "v1";
  const raw = env.SUPPORT_TOKEN_SIGNING_KEY?.trim();
  if (!raw) throw new Error("SUPPORT_TOKEN_SIGNING_KEY is not set");
  let privateJwk: JWK;
  try {
    privateJwk = JSON.parse(raw) as JWK;
  } catch {
    throw new Error("SUPPORT_TOKEN_SIGNING_KEY must be a JWK JSON object");
  }
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.d !== "string") {
    throw new Error("SUPPORT_TOKEN_SIGNING_KEY must be an Ed25519 private JWK");
  }
  let publicJwks: JWK[] = [];
  const rawPublic = env.SUPPORT_TOKEN_PUBLIC_KEYS?.trim();
  if (rawPublic) {
    try {
      const parsed = JSON.parse(rawPublic) as JWK[];
      if (!Array.isArray(parsed)) throw new Error("not an array");
      publicJwks = parsed;
    } catch {
      throw new Error("SUPPORT_TOKEN_PUBLIC_KEYS must be a JSON array of JWKs");
    }
  } else {
    const { d: _d, ...pub } = privateJwk;
    publicJwks = [pub];
  }
  return { kid, privateJwk, publicJwks };
}

/** Test/CLI helper: mints an ephemeral Ed25519 pair (never persisted). */
export async function generateSupportTokenKeys(): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const [privateJwk, publicJwk] = await Promise.all([exportJWK(privateKey), exportJWK(publicKey)]);
  return { privateJwk, publicJwk };
}

// ── Offline on-site tokens: ES256 (P-256) ────────────────────────────────────
// The Windows companion verifies these locally with only the .NET base
// framework (no third-party crypto packages), which offers ECDSA but not
// Ed25519 — so offline tokens use ES256 while the server-minted,
// server-verified session JWTs above stay Ed25519. The two key sets are
// independent (`SUPPORT_TOKEN_*` vs `SUPPORT_OFFLINE_TOKEN_*`).

export interface OfflineTokenKeys {
  kid: string;
  privateJwk: JWK;
  publicJwks: JWK[];
}

export function resolveOfflineTokenKeys(env: Record<string, string | undefined>): OfflineTokenKeys {
  const kid = env.SUPPORT_OFFLINE_TOKEN_KEY_ID?.trim() || "offline-v1";
  const raw = env.SUPPORT_OFFLINE_TOKEN_SIGNING_KEY?.trim();
  if (!raw) throw new Error("SUPPORT_OFFLINE_TOKEN_SIGNING_KEY is not set");
  let privateJwk: JWK;
  try {
    privateJwk = JSON.parse(raw) as JWK;
  } catch {
    throw new Error("SUPPORT_OFFLINE_TOKEN_SIGNING_KEY must be a JWK JSON object");
  }
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || typeof privateJwk.d !== "string") {
    throw new Error("SUPPORT_OFFLINE_TOKEN_SIGNING_KEY must be a P-256 private JWK");
  }
  let publicJwks: JWK[] = [];
  const rawPublic = env.SUPPORT_OFFLINE_TOKEN_PUBLIC_KEYS?.trim();
  if (rawPublic) {
    try {
      const parsed = JSON.parse(rawPublic) as JWK[];
      if (!Array.isArray(parsed)) throw new Error("not an array");
      publicJwks = parsed;
    } catch {
      throw new Error("SUPPORT_OFFLINE_TOKEN_PUBLIC_KEYS must be a JSON array of JWKs");
    }
  } else {
    const { d: _d, ...pub } = privateJwk;
    publicJwks = [pub];
  }
  return { kid, privateJwk, publicJwks };
}

/** Test/CLI helper: mints an ephemeral P-256 pair (never persisted). */
export async function generateOfflineTokenKeys(): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const [privateJwk, publicJwk] = await Promise.all([exportJWK(privateKey), exportJWK(publicKey)]);
  return { privateJwk, publicJwk };
}

// ── Online one-time codes ────────────────────────────────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateOnlineCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i === 3) code += "-";
  }
  return code;
}

export function normalizeOnlineCode(value: string): string {
  return value.trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

// ── Issuance records ─────────────────────────────────────────────────────────

export interface SupportAccessToken {
  id: string;
  businessId: string;
  ticketId: string;
  installationId: string;
  installationGeneration: number;
  issuerAdminId: string;
  fingerprint: string;
  purpose: SupportTokenPurpose;
  scope: SupportOperation[];
  reason: string;
  keyId: string | null;
  notBefore: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  state: SupportTokenState;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TokenRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  ticket_id: string;
  installation_id: string;
  installation_generation: number;
  issuer_admin_id: string;
  fingerprint: string;
  purpose: SupportTokenPurpose;
  scope: SupportOperation[];
  reason: string;
  key_id: string | null;
  not_before: string;
  expires_at: string;
  max_uses: number;
  use_count: number;
  state: SupportTokenState;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

const TOKEN_SELECT = `
  SELECT id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
         installation_id::text AS installation_id, installation_generation,
         issuer_admin_id::text AS issuer_admin_id, fingerprint, purpose, scope, reason,
         key_id, not_before, expires_at, max_uses, use_count, state, revoked_at,
         created_at, updated_at
    FROM support_access_tokens
`;

function toToken(row: TokenRow): SupportAccessToken {
  const scope = (Array.isArray(row.scope) ? row.scope : []).filter(isSupportOperation);
  return {
    id: row.id,
    businessId: row.business_id,
    ticketId: row.ticket_id,
    installationId: row.installation_id,
    installationGeneration: row.installation_generation,
    issuerAdminId: row.issuer_admin_id,
    fingerprint: row.fingerprint,
    purpose: row.purpose,
    scope,
    reason: row.reason,
    keyId: row.key_id,
    notBefore: row.not_before,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    state: row.state,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type IssueTokenResult =
  | { ok: true; record: SupportAccessToken; plaintext: string }
  | {
      ok: false;
      error:
        | "ticket_not_found"
        | "installation_not_found"
        | "installation_not_active"
        | "reason_required"
        | "scope_empty"
        | "signing_unavailable";
    };

async function ticketBusinessId(ticketId: string): Promise<string | null> {
  const { rows } = await query<{ business_id: string }>(
    `SELECT business_id::text AS business_id FROM support_tickets WHERE id = $1::uuid`,
    [ticketId],
  );
  return rows[0]?.business_id ?? null;
}

function clampValidityMinutes(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return SUPPORT_TOKEN_REDEMPTION_MINUTES;
  }
  return Math.min(Math.floor(requested), SUPPORT_TOKEN_MAX_MINUTES);
}

async function insertIssuance(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  installationGeneration: number;
  issuerAdminId: string;
  fingerprint: string;
  purpose: SupportTokenPurpose;
  scope: SupportOperation[];
  reason: string;
  onlineCodeHash: string | null;
  keyId: string | null;
  validityMinutes: number;
}): Promise<SupportAccessToken> {
  const { rows } = await query<TokenRow>(
    `INSERT INTO support_access_tokens
       (business_id, ticket_id, installation_id, installation_generation,
        issuer_admin_id, fingerprint, purpose, scope, reason, online_code_hash,
        key_id, expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8, $9, $10, $11,
             now() + make_interval(mins => $12))
     RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
       installation_id::text AS installation_id, installation_generation,
       issuer_admin_id::text AS issuer_admin_id, fingerprint, purpose, scope, reason,
       key_id, not_before, expires_at, max_uses, use_count, state, revoked_at,
       created_at, updated_at`,
    [
      input.businessId,
      input.ticketId,
      input.installationId,
      input.installationGeneration,
      input.issuerAdminId,
      input.fingerprint,
      input.purpose,
      // jsonb: pg would serialize a raw array as a Postgres array literal.
      JSON.stringify(input.scope),
      input.reason,
      input.onlineCodeHash,
      input.keyId,
      input.validityMinutes,
    ],
  );
  return toToken(rows[0]);
}

export interface OfflineTokenClaims {
  jti: string;
  ticketId: string;
  businessId: string;
  installationId: string;
  installationGeneration: number;
  operatorAdminId: string;
  scope: SupportOperation[];
  /** sha256 of the technician's device-key proof (possession verified locally). */
  technicianBindingHash: string;
  /** Fresh installation challenge/nonce this token answers. */
  challenge: string;
  policyVersion: string;
}

/**
 * Issues a short one-time online code. The code redeems server-side only —
 * a short code can never independently authorize an offline session.
 */
export async function issueOnlineCode(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  issuerAdminId: string;
  issuerCapabilities: readonly PlatformCapability[];
  requestedScope: unknown;
  reason: string;
  validityMinutes?: number;
}): Promise<IssueTokenResult> {
  return issueToken({ ...input, purpose: "online_code" });
}

/**
 * Issues a signed offline on-site token (compact JWS for QR/import). The
 * mini app validates it locally against approved public keys; the server
 * records only the fingerprint/scope/expiry/redemption.
 */
export async function issueOfflineToken(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  issuerAdminId: string;
  issuerCapabilities: readonly PlatformCapability[];
  requestedScope: unknown;
  reason: string;
  validityMinutes?: number;
  technicianBindingHash: string;
  challenge: string;
  offlineKeys?: OfflineTokenKeys;
}): Promise<IssueTokenResult> {
  return issueToken({ ...input, purpose: "offline_onsite" });
}

async function issueToken(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  issuerAdminId: string;
  issuerCapabilities: readonly PlatformCapability[];
  requestedScope: unknown;
  reason: string;
  validityMinutes?: number;
  purpose: SupportTokenPurpose;
  technicianBindingHash?: string;
  challenge?: string;
  offlineKeys?: OfflineTokenKeys;
}): Promise<IssueTokenResult> {
  if (!input.reason.trim()) return { ok: false, error: "reason_required" };
  const ownerBusinessId = await ticketBusinessId(input.ticketId);
  if (!ownerBusinessId || ownerBusinessId !== input.businessId) {
    return { ok: false, error: "ticket_not_found" };
  }
  const installation = await getInstallation(input.businessId, input.installationId);
  if (!installation) return { ok: false, error: "installation_not_found" };
  if (installation.enrollmentState !== "active") return { ok: false, error: "installation_not_active" };

  // The issuance intersection: requested scope ∩ operator's own authority.
  // An operator can never mint what they could not use themselves.
  const grantable = new Set(grantableOperations(input.issuerCapabilities));
  const requested = Array.isArray(input.requestedScope)
    ? (input.requestedScope as unknown[]).filter(isSupportOperation)
    : [];
  const scope = [...new Set(requested)].filter((op) => grantable.has(op));
  if (scope.length === 0) return { ok: false, error: "scope_empty" };

  const validityMinutes = clampValidityMinutes(input.validityMinutes);
  const reason = input.reason.trim().slice(0, 2000);

  if (input.purpose === "online_code") {
    const code = generateOnlineCode();
    const record = await insertIssuance({
      businessId: input.businessId,
      ticketId: input.ticketId,
      installationId: input.installationId,
      installationGeneration: installation.generation,
      issuerAdminId: input.issuerAdminId,
      fingerprint: sha256Hex(normalizeOnlineCode(code)),
      purpose: "online_code",
      scope,
      reason,
      onlineCodeHash: sha256Hex(normalizeOnlineCode(code)),
      keyId: null,
      validityMinutes,
    });
    return { ok: true, record, plaintext: code };
  }

  let keys = input.offlineKeys;
  if (!keys) {
    try {
      keys = resolveOfflineTokenKeys(process.env);
    } catch {
      return { ok: false, error: "signing_unavailable" };
    }
  }
  const jti = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importJWK(keys.privateJwk, "ES256");
  const plaintext = await new SignJWT({
    ticket_id: input.ticketId,
    business_id: input.businessId,
    installation_id: input.installationId,
    installation_generation: installation.generation,
    operator_admin_id: input.issuerAdminId,
    scope,
    technician_binding_hash: (input.technicianBindingHash ?? "").slice(0, 128),
    challenge: (input.challenge ?? "").slice(0, 128),
    policy_version: "v1",
  })
    .setProtectedHeader({ alg: "ES256", kid: keys.kid })
    .setIssuer(SUPPORT_TOKEN_ISSUER)
    .setAudience(SUPPORT_TOKEN_AUDIENCE_ONSITE)
    .setJti(jti)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + validityMinutes * 60)
    .sign(privateKey);
  const record = await insertIssuance({
    businessId: input.businessId,
    ticketId: input.ticketId,
    installationId: input.installationId,
    installationGeneration: installation.generation,
    issuerAdminId: input.issuerAdminId,
    fingerprint: sha256Hex(plaintext),
    purpose: "offline_onsite",
    scope,
    reason,
    onlineCodeHash: null,
    keyId: keys.kid,
    validityMinutes,
  });
  return { ok: true, record, plaintext };
}

// ── Verification (offline-capable shape) ─────────────────────────────────────

export type VerifyOfflineTokenResult =
  | { ok: true; claims: OfflineTokenClaims; kid: string }
  | {
      ok: false;
      error:
        | "invalid_signature"
        | "expired"
        | "not_yet_valid"
        | "wrong_audience"
        | "malformed"
        | "unknown_key";
    };

/**
 * Verifies a signed offline token against approved public keys — the same
 * checks the mini app performs locally (signature, audience, expiry,
 * not-before, claim shape). Binding to the live installation generation and
 * revocation reconciliation happen separately, because a disconnected app
 * cannot learn immediate revocation: it enforces the signed local deadline.
 */
export async function verifyOfflineToken(
  token: string,
  keys: OfflineTokenKeys,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyOfflineTokenResult> {
  const header = decodeProtectedHeader(token);
  if (!header) return { ok: false, error: "malformed" };
  if (header.alg !== "ES256") return { ok: false, error: "invalid_signature" };
  const candidates =
    typeof header.kid === "string" && header.kid
      ? keys.publicJwks.filter((k) => (k.kid ?? keys.kid) === header.kid)
      : keys.publicJwks;
  // A token naming an unknown kid fails closed — never verified against a
  // guessed or supplied key.
  const keysToTry = candidates.length > 0 ? candidates : [];
  if (keysToTry.length === 0) return { ok: false, error: "unknown_key" };

  let payload: Record<string, unknown> | null = null;
  let verified = false;
  for (const jwk of keysToTry) {
    try {
      const key = await importJWK({ ...jwk, kid: header.kid }, "ES256");
      const { payload: p } = await jwtVerify(token, key, {
        issuer: SUPPORT_TOKEN_ISSUER,
        audience: SUPPORT_TOKEN_AUDIENCE_ONSITE,
        currentDate: new Date(nowSeconds * 1000),
      });
      payload = p as Record<string, unknown>;
      verified = true;
      break;
    } catch {
      // Try the next approved key before failing.
    }
  }
  if (!verified || !payload) {
    // Distinguish expiry from a bad signature for honest local UI states
    // (both still fail closed). Expiry is re-checked without enforcement.
    const reason = await softExpiryReason(token, keysToTry, nowSeconds);
    return { ok: false, error: reason };
  }
  const claims = readOfflineClaims(payload);
  if (!claims) return { ok: false, error: "malformed" };
  return { ok: true, claims, kid: typeof header.kid === "string" ? header.kid : keys.kid };
}

function decodeProtectedHeader(token: string): { alg?: string; kid?: string } | null {
  try {
    const [encoded] = token.split(".");
    if (!encoded) return null;
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      alg?: string;
      kid?: string;
    };
  } catch {
    return null;
  }
}

function readOfflineClaims(payload: Record<string, unknown>): OfflineTokenClaims | null {
  const {
    jti,
    ticket_id: ticketId,
    business_id: businessId,
    installation_id: installationId,
    installation_generation: generation,
    operator_admin_id: operatorAdminId,
    scope,
    technician_binding_hash: binding,
    challenge,
    policy_version: policyVersion,
  } = payload;
  if (
    typeof jti !== "string" ||
    typeof ticketId !== "string" ||
    typeof businessId !== "string" ||
    typeof installationId !== "string" ||
    typeof generation !== "number" ||
    typeof operatorAdminId !== "string" ||
    !Array.isArray(scope) ||
    !(scope as unknown[]).every(isSupportOperation) ||
    typeof binding !== "string" ||
    typeof challenge !== "string"
  ) {
    return null;
  }
  return {
    jti,
    ticketId,
    businessId,
    installationId,
    installationGeneration: generation,
    operatorAdminId,
    scope: (scope as unknown[]).filter(isSupportOperation),
    technicianBindingHash: binding,
    challenge,
    policyVersion: typeof policyVersion === "string" ? policyVersion : "v1",
  };
}

async function softExpiryReason(
  token: string,
  keys: JWK[],
  nowSeconds: number,
): Promise<"expired" | "not_yet_valid" | "wrong_audience" | "invalid_signature"> {
  for (const jwk of keys) {
    try {
      const key = await importJWK(jwk, "ES256");
      const { payload } = await jwtVerify(token, key, {
        issuer: SUPPORT_TOKEN_ISSUER,
        audience: SUPPORT_TOKEN_AUDIENCE_ONSITE,
        currentDate: new Date(nowSeconds * 1000),
      });
      void payload;
      return "invalid_signature";
    } catch (err) {
      const typed = err as { code?: string; claim?: string } | null;
      const code = typed?.code ?? "";
      if (code === "ERR_JWT_EXPIRED") return "expired";
      if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
        // A premature nbf/iat vs an audience/issuer mismatch: the error names
        // the failing claim, so read it instead of guessing.
        if (typed?.claim === "nbf" || typed?.claim === "iat") return "not_yet_valid";
        // Audience/issuer mismatch vs bad signature: re-verify the signature
        // alone to tell them apart.
        try {
          const key = await importJWK(jwk, "ES256");
          await jwtVerify(token, key);
          return "wrong_audience";
        } catch {
          return "invalid_signature";
        }
      }
    }
  }
  return "invalid_signature";
}

// ── Redemption (online, atomic) ──────────────────────────────────────────────

export interface CompanionSession {
  tokenId: string;
  ticketId: string;
  businessId: string;
  installationId: string;
  installationGeneration: number;
  operatorAdminId: string;
  scope: SupportOperation[];
  /** Compact session JWT the companion presents on later calls. */
  sessionJwt: string;
  expiresAt: string;
}

export type RedeemTokenResult =
  | { ok: true; session: CompanionSession }
  | {
      ok: false;
      error:
        | "token_not_found"
        | "token_expired"
        | "token_revoked"
        | "token_consumed"
        | "installation_not_active"
        | "generation_mismatch"
        | "binding_mismatch"
        | "signing_unavailable";
    };

async function mintSessionJwt(
  record: SupportAccessToken,
  keys: SupportTokenKeys,
): Promise<{ jwt: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + SUPPORT_SESSION_MINUTES * 60) * 1000).toISOString();
  const privateKey = await importJWK(keys.privateJwk, "EdDSA");
  const jwt = await new SignJWT({
    support_token_id: record.id,
    ticket_id: record.ticketId,
    business_id: record.businessId,
    installation_id: record.installationId,
    installation_generation: record.installationGeneration,
    operator_admin_id: record.issuerAdminId,
    scope: record.scope,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid })
    .setIssuer(SUPPORT_TOKEN_ISSUER)
    .setAudience(SUPPORT_TOKEN_AUDIENCE_SESSION)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + SUPPORT_SESSION_MINUTES * 60)
    .sign(privateKey);
  return { jwt, expiresAt };
}

async function journalRedemption(input: {
  businessId: string;
  tokenId: string;
  technicianBindingHash: string | null;
  challenge: string | null;
  result: "accepted" | "rejected";
  rejectReason: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO support_token_redemptions
       (business_id, token_id, technician_binding_hash, installation_challenge, result, reject_reason)
     VALUES ($1, $2::uuid, $3, $4, $5, $6)`,
    [
      input.businessId,
      input.tokenId,
      input.technicianBindingHash,
      input.challenge,
      input.result,
      input.rejectReason,
    ],
  );
}

async function liveInstallationCheck(record: {
  businessId: string;
  installationId: string;
  installationGeneration: number;
}): Promise<"ok" | "installation_not_active" | "generation_mismatch"> {
  const installation = await getInstallation(record.businessId, record.installationId);
  if (!installation || installation.enrollmentState !== "active") return "installation_not_active";
  if (installation.generation !== record.installationGeneration) return "generation_mismatch";
  return "ok";
}

/**
 * Redeems an online code into a ticket-bound companion session. The consume
 * is one atomic UPDATE — two concurrent redeems cannot both win.
 */
export async function redeemOnlineCode(input: {
  code: string;
  technicianBindingHash?: string | null;
  keys?: SupportTokenKeys;
}): Promise<RedeemTokenResult> {
  const normalized = normalizeOnlineCode(input.code);
  if (!normalized) return { ok: false, error: "token_not_found" };
  const hash = sha256Hex(normalized);

  // Resolve signing keys BEFORE the irreversible consume: if minting is
  // impossible the code must stay redeemable for a retry, not burn.
  let keys = input.keys;
  if (!keys) {
    try {
      keys = resolveSupportTokenKeys(process.env);
    } catch {
      return { ok: false, error: "signing_unavailable" };
    }
  }

  const { rows } = await query<TokenRow>(
    `UPDATE support_access_tokens
        SET state = 'consumed', use_count = use_count + 1, updated_at = now()
      WHERE online_code_hash = $1 AND purpose = 'online_code' AND state = 'pending'
        AND use_count < max_uses AND expires_at > now() AND not_before <= now()
      RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
        installation_id::text AS installation_id, installation_generation,
        issuer_admin_id::text AS issuer_admin_id, fingerprint, purpose, scope, reason,
        key_id, not_before, expires_at, max_uses, use_count, state, revoked_at,
        created_at, updated_at`,
    [hash],
  );
  const record = rows[0] ? toToken(rows[0]) : null;
  if (!record) {
    // Honest failure reason without leaking which codes exist: distinguish
    // only states the presenter could legitimately hit.
    const { rows: probe } = await query<{ state: SupportTokenState; expires_at: string }>(
      `SELECT state, expires_at FROM support_access_tokens WHERE online_code_hash = $1 AND purpose = 'online_code'`,
      [hash],
    );
    const found = probe[0];
    if (!found) return { ok: false, error: "token_not_found" };
    if (found.state === "revoked") return { ok: false, error: "token_revoked" };
    if (found.state === "consumed" || found.state === "redeemed") return { ok: false, error: "token_consumed" };
    return { ok: false, error: "token_expired" };
  }

  const live = await liveInstallationCheck(record);
  if (live !== "ok") {
    await journalRedemption({
      businessId: record.businessId,
      tokenId: record.id,
      technicianBindingHash: input.technicianBindingHash ?? null,
      challenge: null,
      result: "rejected",
      rejectReason: live,
    });
    return { ok: false, error: live };
  }

  const { jwt, expiresAt } = await mintSessionJwt(record, keys);
  await journalRedemption({
    businessId: record.businessId,
    tokenId: record.id,
    technicianBindingHash: input.technicianBindingHash ?? null,
    challenge: null,
    result: "accepted",
    rejectReason: null,
  });
  return {
    ok: true,
    session: {
      tokenId: record.id,
      ticketId: record.ticketId,
      businessId: record.businessId,
      installationId: record.installationId,
      installationGeneration: record.installationGeneration,
      operatorAdminId: record.issuerAdminId,
      scope: record.scope,
      sessionJwt: jwt,
      expiresAt,
    },
  };
}

export type RedeemOfflineTokenResult = RedeemTokenResult;

/**
 * Server-side bootstrap for a signed offline token: verifies the signature
 * and claim shape, then atomically consumes the issuance row and checks the
 * live installation/generation. The companion's *local* offline use follows
 * the same verification (`verifyOfflineToken`) plus its durable one-use
 * journal; this endpoint reconciles that use when connectivity returns and
 * hands out the online session JWT.
 */
export async function redeemOfflineToken(input: {
  token: string;
  technicianBindingHash: string;
  challenge: string;
  keys?: SupportTokenKeys;
  offlineKeys?: OfflineTokenKeys;
}): Promise<RedeemOfflineTokenResult> {
  let keys = input.keys;
  if (!keys) {
    try {
      keys = resolveSupportTokenKeys(process.env);
    } catch {
      return { ok: false, error: "signing_unavailable" };
    }
  }
  let offlineKeys = input.offlineKeys;
  if (!offlineKeys) {
    try {
      offlineKeys = resolveOfflineTokenKeys(process.env);
    } catch {
      return { ok: false, error: "signing_unavailable" };
    }
  }
  const verified = await verifyOfflineToken(input.token, offlineKeys);
  if (!verified.ok) {
    if (verified.error === "expired") return { ok: false, error: "token_expired" };
    return { ok: false, error: "token_not_found" };
  }
  const claims = verified.claims;
  // Challenge + technician binding must match the presented proof exactly —
  // a copied token without the technician's proof of possession is useless.
  if (claims.challenge !== input.challenge || claims.technicianBindingHash !== input.technicianBindingHash) {
    return { ok: false, error: "binding_mismatch" };
  }

  const { rows } = await query<TokenRow>(
    `UPDATE support_access_tokens
        SET state = 'consumed', use_count = use_count + 1, updated_at = now()
      WHERE fingerprint = $1 AND purpose = 'offline_onsite' AND state = 'pending'
        AND use_count < max_uses AND expires_at > now() AND not_before <= now()
      RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
        installation_id::text AS installation_id, installation_generation,
        issuer_admin_id::text AS issuer_admin_id, fingerprint, purpose, scope, reason,
        key_id, not_before, expires_at, max_uses, use_count, state, revoked_at,
        created_at, updated_at`,
    [sha256Hex(input.token)],
  );
  const record = rows[0] ? toToken(rows[0]) : null;
  if (!record) {
    const { rows: probe } = await query<{ state: SupportTokenState }>(
      `SELECT state FROM support_access_tokens WHERE fingerprint = $1 AND purpose = 'offline_onsite'`,
      [sha256Hex(input.token)],
    );
    const found = probe[0];
    if (!found) return { ok: false, error: "token_not_found" };
    if (found.state === "revoked") return { ok: false, error: "token_revoked" };
    if (found.state === "consumed" || found.state === "redeemed") return { ok: false, error: "token_consumed" };
    return { ok: false, error: "token_expired" };
  }
  // The issuance row is authoritative for scope: the signed claims must agree
  // with what was issued (a token edited after issuance fails its signature
  // above; this guards issuance-row drift).
  if (
    record.ticketId !== claims.ticketId ||
    record.businessId !== claims.businessId ||
    record.installationId !== claims.installationId ||
    record.installationGeneration !== claims.installationGeneration
  ) {
    return { ok: false, error: "binding_mismatch" };
  }

  const live = await liveInstallationCheck(record);
  if (live !== "ok") {
    await journalRedemption({
      businessId: record.businessId,
      tokenId: record.id,
      technicianBindingHash: sha256Hex(input.technicianBindingHash),
      challenge: input.challenge,
      result: "rejected",
      rejectReason: live,
    });
    return { ok: false, error: live };
  }

  const { jwt, expiresAt } = await mintSessionJwt(record, keys);
  await journalRedemption({
    businessId: record.businessId,
    tokenId: record.id,
    technicianBindingHash: sha256Hex(input.technicianBindingHash),
    challenge: input.challenge,
    result: "accepted",
    rejectReason: null,
  });
  return {
    ok: true,
    session: {
      tokenId: record.id,
      ticketId: record.ticketId,
      businessId: record.businessId,
      installationId: record.installationId,
      installationGeneration: record.installationGeneration,
      operatorAdminId: record.issuerAdminId,
      scope: record.scope,
      sessionJwt: jwt,
      expiresAt,
    },
  };
}

// ── Companion session verification ───────────────────────────────────────────

export interface VerifiedCompanionSession {
  tokenId: string;
  ticketId: string;
  businessId: string;
  installationId: string;
  installationGeneration: number;
  operatorAdminId: string;
  scope: SupportOperation[];
}

export type VerifySessionResult =
  | { ok: true; session: VerifiedCompanionSession }
  | { ok: false; error: "invalid" | "expired" | "revoked" | "installation_not_active" | "generation_mismatch" };

/**
 * Verifies a companion session JWT on every call and re-checks the live
 * installation/generation plus the issuance row's revocation state, so
 * Central revocation lands on the next connected call.
 */
export async function verifyCompanionSession(
  jwt: string,
  keys: SupportTokenKeys,
): Promise<VerifySessionResult> {
  // Sessions verify against the approved public keys only — verification
  // never needs the private key, so a verifier holds no signing power.
  let payload: Record<string, unknown> | null = null;
  let sawExpired = false;
  for (const jwk of keys.publicJwks) {
    try {
      const { payload: p } = await jwtVerify(jwt, await importJWK(jwk, "EdDSA"), {
        issuer: SUPPORT_TOKEN_ISSUER,
        audience: SUPPORT_TOKEN_AUDIENCE_SESSION,
      });
      payload = p as Record<string, unknown>;
      break;
    } catch (err) {
      if ((err as { code?: string })?.code === "ERR_JWT_EXPIRED") sawExpired = true;
    }
  }
  if (!payload) return { ok: false, error: sawExpired ? "expired" : "invalid" };
  const {
    support_token_id: tokenId,
    ticket_id: ticketId,
    business_id: businessId,
    installation_id: installationId,
    installation_generation: generation,
    operator_admin_id: operatorAdminId,
    scope,
  } = payload;
  if (
    typeof tokenId !== "string" ||
    typeof ticketId !== "string" ||
    typeof businessId !== "string" ||
    typeof installationId !== "string" ||
    typeof generation !== "number" ||
    typeof operatorAdminId !== "string" ||
    !Array.isArray(scope) ||
    !(scope as unknown[]).every(isSupportOperation)
  ) {
    return { ok: false, error: "invalid" };
  }
  // The JWT signature is verified above, so businessId is trustworthy — and
  // required: under the production FORCE RLS role these rows are invisible
  // without a tenant scope, which would misreport valid sessions as revoked.
  const live = await withTenant(businessId, async () => {
    const { rows } = await query<{ state: SupportTokenState }>(
      `SELECT state FROM support_access_tokens WHERE id = $1::uuid AND business_id = $2`,
      [tokenId, businessId],
    );
    if (!rows[0] || rows[0].state === "revoked") return "revoked" as const;
    return liveInstallationCheck({ businessId, installationId, installationGeneration: generation });
  });
  if (live === "revoked") return { ok: false, error: "revoked" };
  if (live !== "ok") return { ok: false, error: live };
  return {
    ok: true,
    session: {
      tokenId,
      ticketId,
      businessId,
      installationId,
      installationGeneration: generation,
      operatorAdminId,
      scope: (scope as unknown[]).filter(isSupportOperation),
    },
  };
}

// ── Listing + revocation ─────────────────────────────────────────────────────

export async function listTicketAccessTokens(
  businessId: string,
  ticketId: string,
): Promise<SupportAccessToken[]> {
  const { rows } = await query<TokenRow>(
    `${TOKEN_SELECT} WHERE business_id = $1 AND ticket_id = $2::uuid ORDER BY created_at DESC`,
    [businessId, ticketId],
  );
  return rows.map(toToken);
}

export type RevokeTokenResult =
  | { ok: true; alreadyTerminal: boolean }
  | { ok: false; error: "token_not_found" };

/**
 * Revokes a token in any live state — pending, redeemed, or consumed (a
 * consumed issuance backs a live session, which must stay revocable).
 * Connected sessions presenting it fail on their next verification; a
 * disconnected on-site app enforces its signed local deadline and
 * reconciles on reconnect.
 */
export async function revokeAccessToken(businessId: string, tokenId: string): Promise<RevokeTokenResult> {
  const { rows } = await query<{ state: SupportTokenState }>(
    `UPDATE support_access_tokens
        SET state = 'revoked', revoked_at = now(), updated_at = now()
      WHERE id = $1::uuid AND business_id = $2 AND state IN ('pending', 'redeemed', 'consumed')
      RETURNING state`,
    [tokenId, businessId],
  );
  if (rows[0]) return { ok: true, alreadyTerminal: false };
  const { rows: probe } = await query<{ id: string }>(
    `SELECT id FROM support_access_tokens WHERE id = $1::uuid AND business_id = $2`,
    [tokenId, businessId],
  );
  if (!probe[0]) return { ok: false, error: "token_not_found" };
  return { ok: true, alreadyTerminal: true };
}
