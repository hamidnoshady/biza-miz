/**
 * Owner activation — issue #755 §14.
 *
 * Provisioning used to hand the platform operator two things they should never
 * have: the tenant owner's permanent password (the operator *chose* it) and the
 * owner's second factor and recovery codes (the operator *printed* them). That
 * makes every operator a holder of a permanent credential to every business
 * they create, and it routes one-time secrets through whatever channel two
 * colleagues happen to share.
 *
 * The replacement is a single-use activation link. The operator can hand it
 * over but cannot use it: redeeming it is where the owner sets their *own*
 * password, and where the second factor and the recovery codes are minted — in
 * the owner's browser, shown only to them, never in the operator's response.
 *
 * The link follows the same one-way rule as invitations (0022) and pairing
 * codes (0048): only the sha-256 is stored, so a database read can never yield
 * a usable link.
 *
 * Nothing here imports `business-provisioning.ts`; the dependency runs one way,
 * because provisioning creates the activation inside its transaction and this
 * module must stay importable from the public acceptance route.
 */
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { generateSecret, generateURI } from "otplib";
import { BCRYPT_COST } from "./password-hashing";
import { getPool, withoutTenantScope } from "./db";
import { issueRecoveryCodes } from "./mfa-recovery";
import { provisionMfaEnrolment } from "./mfa-service";
import { totpQrDataUrl } from "./totp-qr";

/** How long an activation link stays usable — the same week an invitation gets. */
export const ACTIVATION_TTL_DAYS = 7;

/** Prefix makes a leaked token recognisable in a log or a paste. */
const TOKEN_PREFIX = "act_";

/**
 * The shortest password an owner may set for themselves.
 *
 * Deliberately the same number `business-provisioning.ts` enforces on the
 * password-choosing paths; stated here as well so this module needs nothing
 * from provisioning (see the note at the top of the file).
 */
export const MIN_OWNER_PASSWORD_LENGTH = 8;

export function generateActivationToken(): { token: string; tokenHash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  return { token, tokenHash: hashActivationToken(token) };
}

export function hashActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function activationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + ACTIVATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface ActivationState {
  expiresAt: Date | string;
  acceptedAt: Date | string | null;
  revokedAt: Date | string | null;
}

export type ActivationStatus = "pending" | "accepted" | "revoked" | "expired";

/** Why an activation link can't be used, or "pending" when it can. */
export function activationStatus(
  activation: ActivationState,
  now: Date = new Date(),
): ActivationStatus {
  if (activation.acceptedAt) return "accepted";
  if (activation.revokedAt) return "revoked";
  if (new Date(activation.expiresAt).getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** Anything that can run a parameterised query — the pool, or a transaction client. */
interface Executor {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class OwnerActivationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

export interface OwnerActivationInput {
  businessId: string;
  platformUserId: string;
  userId: string;
  email: string;
  /** The platform admin who provisioned the business, for the audit trail. */
  createdBy: string | null;
}

/**
 * Mints an activation link, inside the caller's transaction.
 *
 * Same transactional rule the old recovery-code handover followed: an
 * activation for a business that was never created must not survive the
 * rollback. Re-issuing revokes any pending link for the same person first, so
 * two working links to one account can never exist.
 */
export async function createOwnerActivation(
  client: Executor,
  input: OwnerActivationInput,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash } = generateActivationToken();
  const expiresAt = activationExpiry();

  await client.query(
    `UPDATE owner_activations SET revoked_at = now()
      WHERE business_id = $1 AND platform_user_id = $2
        AND accepted_at IS NULL AND revoked_at IS NULL`,
    [input.businessId, input.platformUserId],
  );

  await client.query(
    `INSERT INTO owner_activations
       (business_id, platform_user_id, user_id, email, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.businessId,
      input.platformUserId,
      input.userId,
      input.email,
      tokenHash,
      expiresAt,
      input.createdBy,
    ],
  );

  return { token, expiresAt };
}

export interface OwnerActivationPreview {
  businessName: string;
  businessSubdomain: string;
  ownerName: string;
  email: string;
  /**
   * The mobile this business's SMS second factor will be bound to, masked. The
   * owner sees enough to recognise their own number — never the whole thing,
   * because the page is reachable by whoever holds the link.
   */
  phoneHint: string | null;
  expiresAt: string;
}

/** Shows just enough of a number to recognise it: `••••4567`. */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `••••${digits.slice(-4)}`;
}

interface ActivationRow {
  id: string;
  business_id: string;
  platform_user_id: string;
  user_id: string;
  email: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  business_name: string;
  business_slug: string;
  business_subdomain: string;
  owner_name: string;
  owner_phone: string | null;
}

/** The row's column names as the pure status helper's shapes. */
function stateOf(row: ActivationRow): ActivationState {
  return { expiresAt: row.expires_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at };
}

/**
 * Looks up an activation by its presented token.
 *
 * Runs bypassed: whoever is activating has no session, and by definition no
 * membership of the business that issued the link. The token is the credential.
 */
export async function previewOwnerActivation(token: string): Promise<OwnerActivationPreview> {
  return withoutTenantScope("login", async () => {
    const client = await getPool().connect();
    try {
      const { rows } = await client.query(
        `SELECT a.id, a.business_id, a.platform_user_id, a.user_id, a.email,
                a.expires_at, a.accepted_at, a.revoked_at,
                b.name AS business_name, b.slug::text AS business_slug,
                b.subdomain::text AS business_subdomain,
                u.full_name AS owner_name, u.phone_e164 AS owner_phone
           FROM owner_activations a
           JOIN businesses b ON b.id = a.business_id
           JOIN users u ON u.id = a.user_id
          WHERE a.token_hash = $1`,
        [hashActivationToken(token)],
      ) as { rows: ActivationRow[] };

      const row = rows[0];
      if (!row) throw new OwnerActivationError("invalid_activation", 404);

      const status = activationStatus(stateOf(row));
      if (status !== "pending") throw new OwnerActivationError(`activation_${status}`, 409);

      return {
        businessName: row.business_name,
        businessSubdomain: row.business_subdomain,
        ownerName: row.owner_name,
        email: row.email,
        phoneHint: maskPhone(row.owner_phone),
        expiresAt: row.expires_at.toISOString(),
      };
    } finally {
      client.release();
    }
  });
}

export interface OwnerActivationResult {
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessSubdomain: string;
  email: string;
  mfa: {
    method: "sms_otp" | "totp";
    phoneE164: string | null;
    /** Present only on the TOTP path, and only for a brand-new identity. */
    totpSecret: string | null;
    totpQr: string | null;
    /**
     * Empty when the identity already had a second factor: its existing codes
     * belong to the person and re-issuing them would silently invalidate the
     * paper they already keep.
     */
    recoveryCodes: string[];
  };
}

/**
 * Redeems an activation link: the owner sets their own password, and their
 * second factor and recovery codes are minted here and returned to them.
 *
 * One transaction against the row locked `FOR UPDATE`, so two browsers racing
 * the same link produce one activation and one refusal rather than two
 * passwords.
 *
 * The password is always the *owner's* choice — nothing in this file ever
 * accepts a password from a platform operator, and the console route that
 * creates the business no longer has a field for one.
 */
export async function acceptOwnerActivation(
  token: string,
  password: string,
): Promise<OwnerActivationResult> {
  if (password.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new OwnerActivationError("weak_password", 400);
  }

  return withoutTenantScope("login", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // The acceptance necessarily crosses the tenant boundary: the activator
      // is not yet a member of the business whose link they hold.
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

      const { rows } = (await client.query(
        `SELECT a.id, a.business_id, a.platform_user_id, a.user_id, a.email,
                a.expires_at, a.accepted_at, a.revoked_at,
                b.name AS business_name, b.slug::text AS business_slug,
                b.subdomain::text AS business_subdomain,
                u.full_name AS owner_name, u.phone_e164 AS owner_phone
           FROM owner_activations a
           JOIN businesses b ON b.id = a.business_id
           JOIN users u ON u.id = a.user_id
          WHERE a.token_hash = $1
          FOR UPDATE OF a`,
        [hashActivationToken(token)],
      )) as { rows: ActivationRow[] };

      const row = rows[0];
      if (!row) throw new OwnerActivationError("invalid_activation", 404);
      const status = activationStatus(stateOf(row));
      if (status !== "pending") throw new OwnerActivationError(`activation_${status}`, 409);

      // The password is theirs from here on. `token_version` moves so any
      // session minted against the throwaway hash is invalidated.
      await client.query(
        `UPDATE platform_users
            SET password_hash = $2, token_version = token_version + 1, updated_at = now()
          WHERE id = $1`,
        [row.platform_user_id, await bcrypt.hash(password, BCRYPT_COST)],
      );

      const existing = await client.query(
        `SELECT method, phone_e164 FROM mfa_enrolments
          WHERE subject_realm = 'platform_user' AND subject_id = $1
          ORDER BY is_primary DESC, method
          LIMIT 1`,
        [row.platform_user_id],
      );

      let method: "sms_otp" | "totp";
      let phoneE164: string | null = null;
      let totpSecret: string | null = null;
      let totpQr: string | null = null;
      let recoveryCodes: string[] = [];

      const already = existing.rows[0] as { method: string; phone_e164: string | null } | undefined;
      if (already) {
        // A person who already has a second factor keeps it, and keeps the
        // recovery codes to it. Re-enrolling here would be a downgrade: the
        // codes they printed when they enrolled would stop working.
        method = already.method === "totp" ? "totp" : "sms_otp";
        phoneE164 = already.phone_e164;
      } else if (row.owner_phone) {
        // The number came from the operator, so it is stored *unconfirmed*: the
        // owner proves it with an OTP at their first login. (An unconfirmed SMS
        // enrolment still works — `verifySmsOtp` stamps `confirmed_at` on the
        // first successful code — so this is a bookkeeping difference, not a
        // locked door.)
        method = "sms_otp";
        phoneE164 = row.owner_phone;
        await client.query(
          `INSERT INTO mfa_enrolments
             (subject_realm, subject_id, method, is_primary, phone_e164, confirmed_at)
           VALUES ('platform_user', $1, 'sms_otp', true, $2, NULL)
           ON CONFLICT (subject_realm, subject_id, method) DO NOTHING`,
          [row.platform_user_id, row.owner_phone],
        );
      } else {
        // No mobile to send to — an offline install, or simply no number. TOTP
        // is the only factor that works without a network, and the secret is
        // shown to the owner here and nowhere else.
        method = "totp";
        const secret = generateSecret();
        totpSecret = secret;
        const url = generateURI({
          label: row.email,
          issuer: row.business_name,
          secret,
          strategy: "totp",
        });
        totpQr = await totpQrDataUrl(url);
        await provisionMfaEnrolment(
          client,
          "platform_user",
          row.platform_user_id,
          "totp",
          true,
          null,
          Buffer.from(secret),
        );
      }

      if (!already) {
        recoveryCodes = await issueRecoveryCodes("platform_user", row.platform_user_id, client);
      }

      await client.query(`UPDATE owner_activations SET accepted_at = now() WHERE id = $1`, [
        row.id,
      ]);

      await client.query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'owner.activated', 'platform_user', $3, $4)`,
        [
          row.business_id,
          row.user_id,
          row.platform_user_id,
          JSON.stringify({ email: row.email, mfaMethod: method }),
        ],
      );

      await client.query("COMMIT");
      return {
        businessId: row.business_id,
        businessName: row.business_name,
        businessSlug: row.business_slug,
        businessSubdomain: row.business_subdomain,
        email: row.email,
        mfa: { method, phoneE164, totpSecret, totpQr, recoveryCodes },
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
