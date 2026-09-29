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
 * The replacement is a single-use activation link **plus a one-time code sent to
 * the owner's own mobile**. That second half is not decoration. There is no mail
 * transport in this system, so the operator is the one who carries the token —
 * and a token that were sufficient on its own would make the whole thing
 * theatre: the operator could redeem their own link, choose a password, collect
 * the recovery codes and keep permanent access. So the code goes to the number
 * the owner controls, which the operator can trigger but cannot read, and the
 * two halves have to be held by two different people.
 *
 * Redeeming is then where the owner sets their *own* password, and where the
 * second factor and the recovery codes are minted — in the owner's browser,
 * shown only to them, never in the operator's response.
 *
 * The link follows the same one-way rule as invitations (0022) and pairing
 * codes (0048): only the sha-256 is stored, so a database read can never yield
 * a usable link. The code is stored the same way (an HMAC), never in the clear.
 *
 * Nothing here imports `business-provisioning.ts`; the dependency runs one way,
 * because provisioning creates the activation inside its transaction and this
 * module must stay importable from the public acceptance route.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "./password-hashing";
import { getPool, withoutTenantScope } from "./db";
import { issueRecoveryCodes } from "./mfa-recovery";
import { getPublicSmsConfig, getSmsProvider } from "./sms-config";
import { checkMfaChallengeRateLimit, recordMfaChallenge } from "./mfa-rate-limit";
import { getRealmSecret } from "./jwt-secret";

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

/** How long a texted activation code stays usable. */
export const ACTIVATION_CODE_TTL_MINUTES = 10;

/** How many wrong guesses before the code is dead and a new one must be sent. */
export const MAX_ACTIVATION_CODE_ATTEMPTS = 5;

/**
 * The code's stored form: an HMAC under the platform realm secret, exactly like
 * `mfa_challenges` (`verifySmsOtp` in mfa-verify.ts computes the same thing).
 * Reusing the construction keeps one rule for one-time codes in this codebase,
 * while living on the activation row rather than in that table — an activation
 * code must never be presentable as a login OTP.
 */
async function hashActivationCode(code: string): Promise<string> {
  const secretKey = await getRealmSecret("platform");
  return createHmac("sha256", secretKey).update(code).digest("hex");
}

/** Constant-time compare, so a wrong code cannot be narrowed down by timing. */
async function codeMatches(stored: string, offered: string): Promise<boolean> {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(await hashActivationCode(offered), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
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

/**
 * The six-digit code, texted to the owner's mobile.
 *
 * Sent through the same provider the login OTP uses, and refused outright when
 * no provider is configured: `getSmsProvider()` falls back to a no-op that
 * *logs* the code, which would leave the owner unable to activate and the code
 * sitting in a server log. No channel, no handover.
 *
 * Rate-limited per identity with the login's own limiter, because the two are
 * the same abuse — someone making a phone ring.
 */
export async function requestActivationCode(token: string): Promise<{
  phoneHint: string;
  expiresAt: string;
}> {
  return withoutTenantScope("login", async () => {
    const client = await getPool().connect();
    try {
      const { rows } = (await client.query(
        `SELECT a.id, a.email, a.expires_at, a.accepted_at, a.revoked_at,
                u.phone_e164 AS owner_phone
           FROM owner_activations a
           JOIN users u ON u.id = a.user_id
          WHERE a.token_hash = $1`,
        [hashActivationToken(token)],
      )) as {
        rows: {
          id: string;
          email: string;
          owner_phone: string | null;
          expires_at: Date;
          accepted_at: Date | null;
          revoked_at: Date | null;
        }[];
      };

      const row = rows[0];
      if (!row) throw new OwnerActivationError("invalid_activation", 404);

      // Sending a code to a link that is already used, revoked or expired would
      // be a text message nobody can act on — and, for a link the operator is
      // holding, a way to keep a channel warm after the fact.
      const status = activationStatus({
        expiresAt: row.expires_at,
        acceptedAt: row.accepted_at,
        revokedAt: row.revoked_at,
      });
      if (status !== "pending") throw new OwnerActivationError(`activation_${status}`, 409);

      // The console requires a mobile when it provisions, so a missing one here
      // means the record was changed underneath us — and without a channel there
      // is no way to prove the owner controls anything.
      if (!row.owner_phone) throw new OwnerActivationError("activation_phone_missing", 409);

      const config = await getPublicSmsConfig();
      if (!config.configured) throw new OwnerActivationError("sms_not_configured", 503);

      const limit = await checkMfaChallengeRateLimit(row.email);
      if (!limit.allowed) throw new OwnerActivationError("rate_limited", 429);

      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      await client.query(
        `UPDATE owner_activations
            SET code_hash = $2, code_expires_at = now() + ($3 || ' minutes')::interval,
                code_attempts = 0, code_sent_at = now()
          WHERE id = $1`,
        [row.id, await hashActivationCode(code), String(ACTIVATION_CODE_TTL_MINUTES)],
      );

      await recordMfaChallenge(row.email);

      const provider = await getSmsProvider();
      await provider.sendOtp(row.owner_phone, code);

      const expiresAt = new Date(Date.now() + ACTIVATION_CODE_TTL_MINUTES * 60_000);
      return { phoneHint: maskPhone(row.owner_phone) ?? "", expiresAt: expiresAt.toISOString() };
    } finally {
      client.release();
    }
  });
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
  code_hash: string | null;
  code_expires_at: Date | null;
  code_attempts: number;
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
    /** Which factor protects this login from now on. */
    method: "sms_otp" | "totp";
    phoneE164: string | null;
    /**
     * True when the identity already had a factor and this activation left it
     * alone. Nothing was enrolled and nothing re-issued: its existing codes and
     * secret belong to the person, and replacing them would invalidate the paper
     * they already keep.
     */
    existing: boolean;
    /**
     * Empty when the identity already had a second factor, for the same reason.
     * Otherwise the ten codes, shown here — in the owner's own browser — once.
     */
    recoveryCodes: string[];
  };
}

/**
 * Redeems an activation link: the owner sets their own password, and their
 * second factor and recovery codes are minted here and returned to them.
 *
 * **The `code` is required, and it is what makes this the owner's act rather
 * than the operator's.** The token travels by hand — there is no mail transport —
 * so a token that sufficed alone could be redeemed by whoever provisioned the
 * business, handing them a password and a set of recovery codes for a tenant
 * they are supposed to be administering, not holding. The code goes to the
 * owner's mobile, which the operator can trigger and cannot read.
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
  code: string,
): Promise<OwnerActivationResult> {
  if (password.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new OwnerActivationError("weak_password", 400);
  }
  if (!code.trim()) throw new OwnerActivationError("activation_code_required", 400);

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
                a.code_hash, a.code_expires_at, a.code_attempts,
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

      // **The proof of control, and the reason the operator cannot do this.**
      // The token above proves only possession of a link, which the person who
      // provisioned the business is holding. The code proves control of the
      // mobile the owner was provisioned with — a channel the operator can make
      // ring and cannot read. Without this check the whole flow would be theatre:
      // the operator could redeem their own link, choose a password, collect the
      // recovery codes and keep permanent access to a tenant they are meant to be
      // administering rather than holding.
      //
      // A wrong code burns one of a handful of tries. That accounting has to
      // survive the refusal, so it is committed *before* the throw: rolling it
      // back inside the catch would let an attacker guess forever.
      if (!row.code_hash || !row.code_expires_at) {
        throw new OwnerActivationError("activation_code_required", 409);
      }
      if (row.code_attempts >= MAX_ACTIVATION_CODE_ATTEMPTS) {
        throw new OwnerActivationError("activation_code_attempts_exceeded", 429);
      }
      if (new Date(row.code_expires_at).getTime() <= Date.now()) {
        throw new OwnerActivationError("activation_code_expired", 409);
      }
      if (!(await codeMatches(row.code_hash, code.trim()))) {
        await client.query(
          `UPDATE owner_activations SET code_attempts = code_attempts + 1 WHERE id = $1`,
          [row.id],
        );
        await client.query("COMMIT");
        throw new OwnerActivationError("activation_code_invalid", 400);
      }

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
        // Reachable only if the number was removed between the code being sent
        // and this redemption, which can't happen inside one activation — but a
        // silent TOTP enrolment here used to paper over exactly this state, and a
        // second factor nobody agreed to is worse than a refusal the operator can
        // read. Without a channel there is no owner-controlled half, so there is
        // no activation either.
        throw new OwnerActivationError("activation_phone_missing", 409);
      }

      if (!already) {
        recoveryCodes = await issueRecoveryCodes("platform_user", row.platform_user_id, client);
      }

      // The code is spent with the link: keeping the hash would leave a texted
      // six-digit code valid against an activation that is already accepted.
      await client.query(
        `UPDATE owner_activations
            SET accepted_at = now(), code_hash = NULL, code_expires_at = NULL,
                code_attempts = 0
          WHERE id = $1`,
        [row.id],
      );

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
        mfa: { method, phoneE164, existing: Boolean(already), recoveryCodes },
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
