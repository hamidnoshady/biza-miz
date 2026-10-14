import { getPool, query, withoutTenantScope, type PoolClient } from "./db";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { isActiveMfaEnrolment, enrolmentRequirement, isMfaEnrolmentConfirmed, privilegedMfaBaseline, selectPrimaryMfaEnrolment, sortMfaEnrolments, type MfaMethod, type MfaRequirement, type PrimaryAuthMethod } from "./mfa";
import { normalizeMfaPolicy } from "./mfa-policy";
import { SETTING_KEYS } from "./settings";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "./mfa-recovery";
import {
  SECURITY_AUDIT_ACTIONS,
  recordSecurityAudit,
  type SecurityAuditAttribution,
} from "./security-audit";

export interface MfaPendingEmployeeSession {
  userId: string;
  businessId: string;
  locationId: string | null;
  role: string;
  employeeSessionId: string;
}

/**
 * Issue #854 (GAP 8) — the validated completion context of a phone-OTP login
 * that is waiting on its second factor.
 *
 * Phone-primary login defers its verification stamps (`phone_verified_at` and
 * — the important one — `otp_login_at`, which opens the 7-day window in which
 * the PIN door signs in without any OTP) until MFA succeeds. Before this
 * existed, `/api/auth/mfa/verify` knew only that the primary factor was
 * `phone_otp`; it minted the session and never committed the stamps, so a
 * member who finished the ceremony properly was never credited — and any
 * attempt to fix that by stamping from the client's claims would have been a
 * forgeable shortcut. Every field here was verified *at the phone-OTP door*,
 * and it travels inside the signed pending token, so the generic MFA route
 * commits exactly the ceremony that actually happened, and only after the
 * second factor passes.
 */
export interface MfaPendingPhoneCompletion {
  /** The membership being signed into (`users.id`). */
  membershipId: string;
  /**
   * The number that was proven by the redeemed OTP challenge. The commit step
   * re-checks the membership still holds it (or receives `attachPhone`), so a
   * number changed between the two halves of the ceremony cannot inherit a
   * verification it never earned.
   */
  provenPhone: string | null;
  /** Set when the ceremony was `verify_login_phone`: the number to attach. */
  attachPhone?: string | null;
}

export interface MfaPendingPayload {
  sub: string;
  method: MfaMethod | null;
  authRealm: "tenant_password" | "platform_admin";
  businessId?: string;
  /** Which primary factor minted this pending token (defaults to "password"). */
  primaryAuth?: PrimaryAuthMethod;
  /** Present when primaryAuth === "phone_otp" on the employee/tenant door. */
  employeeSession?: MfaPendingEmployeeSession;
  /**
   * Issue #854 (P0.4) — set when this pending token is an invitation
   * acceptance waiting on its second factor. The success path of
   * `/api/auth/mfa/verify` completes that acceptance before minting a session,
   * so the membership is written only after every factor is proven.
   */
  invitationId?: string;
  /** Issue #854 (GAP 8) — see `MfaPendingPhoneCompletion`. */
  phoneCompletion?: MfaPendingPhoneCompletion;
}

export interface MfaEnrolmentRow extends Record<string, unknown> {
  id: string;
  method: MfaMethod;
  is_primary: boolean;
  phone_e164: string | null;
  confirmed_at: Date | null;
  created_at: Date;
}

export async function signMfaPendingToken(payload: MfaPendingPayload): Promise<string> {
  const secret = await getRealmSecret("mfa");
  return new SignJWT({ ...payload, realm: "mfa" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyMfaPendingToken(token: string): Promise<MfaPendingPayload | null> {
  try {
    const payload = await verifyWithRealmSecret<{
      realm?: string;
      sub?: string;
      method?: string;
      authRealm?: string;
    }>(token, "mfa");
    if (!payload || payload.realm !== "mfa") return null;
    return payload as unknown as MfaPendingPayload;
  } catch {
    return null;
  }
}

export async function getAccountMfaEnrolments(
  subjectRealm: string,
  subjectId: string,
): Promise<MfaEnrolmentRow[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<MfaEnrolmentRow>(
      `SELECT id, method, is_primary, phone_e164, confirmed_at, created_at
       FROM mfa_enrolments
       WHERE subject_realm = $1 AND subject_id = $2`,
      [subjectRealm, subjectId],
    ),
  );
  return sortMfaEnrolments(rows);
}

/**
 * Returns only confirmed MFA enrolments (`confirmed_at IS NOT NULL`), plus any
 * explicit owner-activation bootstrap SMS enrolment (`method = 'sms_otp'` with
 * `is_primary = true` created during owner activation before first login).
 * Interactive pending enrolments (`is_primary = false AND confirmed_at IS NULL`)
 * are excluded so abandoned setups never act as active factors.
 */
export function filterActiveMfaEnrolments(
  enrolments: readonly MfaEnrolmentRow[],
): MfaEnrolmentRow[] {
  // The rule itself is `isActiveMfaEnrolment` in `./mfa` — one definition shared
  // with the SMS challenge issuer and the strict verifier (#854), so "which rows
  // count as a factor" cannot drift between the screen, the sender and the
  // checker.
  return sortMfaEnrolments(enrolments.filter((e) => isActiveMfaEnrolment(e)));
}

/**
 * Canonical primary-factor selector for an account (Issue #809 — Finding 9).
 */
export async function getPrimaryMfaEnrolment(
  subjectRealm: string,
  subjectId: string,
  options: { allowUnconfirmedFallback?: boolean } = {},
): Promise<MfaEnrolmentRow | null> {
  const enrolments = await getAccountMfaEnrolments(subjectRealm, subjectId);
  const confirmedChoice = selectPrimaryMfaEnrolment(enrolments, options);
  if (confirmedChoice) return confirmedChoice;
  // Owner-activation bootstrap SMS row (is_primary = true, confirmed_at = NULL)
  const active = filterActiveMfaEnrolments(enrolments);
  return active[0] ?? null;
}

export async function getMfaGracePeriod(
  subjectRealm: string,
  subjectId: string,
): Promise<Date | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ grace_until: Date }>(
      `SELECT grace_until FROM mfa_grace_periods WHERE subject_realm = $1 AND subject_id = $2`,
      [subjectRealm, subjectId],
    ),
  );
  return rows.length > 0 ? rows[0].grace_until : null;
}

export async function markMfaGracePeriod(
  subjectRealm: string,
  subjectId: string,
  graceDays: number,
) {
  await withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO mfa_grace_periods (subject_realm, subject_id, grace_until)
       VALUES ($1, $2, now() + interval '1 day' * $3)
       ON CONFLICT (subject_realm, subject_id) DO NOTHING`,
      [subjectRealm, subjectId, graceDays],
    );
  });
}

/**
 * Push one account's grace window out — the super-admin's documented escape
 * valve for the person whose stored mobile is wrong, or who is mid-holiday
 * when the deadline lands.
 */
export async function extendMfaGracePeriod(
  subjectRealm: string,
  subjectId: string,
  graceDays: number,
): Promise<Date | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ grace_until: Date }>(
      `INSERT INTO mfa_grace_periods (subject_realm, subject_id, grace_until)
       VALUES ($1, $2, now() + interval '1 day' * $3)
       ON CONFLICT (subject_realm, subject_id)
       DO UPDATE SET grace_until = now() + interval '1 day' * $3
       RETURNING grace_until`,
      [subjectRealm, subjectId, graceDays],
    ),
  );
  return rows[0]?.grace_until ?? null;
}

/**
 * Clear every second factor an account holds — enrolments, live challenges and
 * unspent recovery codes — and re-stamp a fresh grace window so the next login
 * enrols instead of hard-gating.
 */
export async function resetAccountMfa(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  graceDays: number,
  /**
   * Issue #854 (invariant 12) — the audit row, in this transaction.
   *
   * A reset is the most destructive lifecycle operation there is: it removes
   * every factor, every challenge and every recovery code at once. It already
   * wrote a platform audit row after the fact; writing it *here* means the
   * console's record of the reset and the reset itself are the same commit.
   */
  options: { audit?: SecurityAuditAttribution; auditRealm?: "tenant" | "platform" } = {},
): Promise<void> {
  await withoutTenantScope("platform", () =>
    withMfaAccountLock(subjectRealm, subjectId, async (client) => {
      await client.query(`DELETE FROM mfa_enrolments WHERE subject_realm = $1 AND subject_id = $2`, [
        subjectRealm,
        subjectId,
      ]);
      await client.query(`DELETE FROM mfa_challenges WHERE subject_realm = $1 AND subject_id = $2`, [
        subjectRealm,
        subjectId,
      ]);
      await client.query(
        `DELETE FROM mfa_recovery_codes WHERE subject_realm = $1 AND subject_id = $2`,
        [subjectRealm, subjectId],
      );
      await client.query(
        `INSERT INTO mfa_grace_periods (subject_realm, subject_id, grace_until)
         VALUES ($1, $2, now() + interval '1 day' * $3)
         ON CONFLICT (subject_realm, subject_id)
         DO UPDATE SET grace_until = now() + interval '1 day' * $3`,
        [subjectRealm, subjectId, graceDays],
      );

      if (options.audit) {
        await recordSecurityAudit(
          {
            ...options.audit,
            realm: options.auditRealm ?? "platform",
            action: "mfa.reset",
            entity: subjectRealm,
            entityId: subjectId,
            payload: { ...options.audit.payload, graceDays, factorsRemoved: true },
          },
          client,
        );
      }
    }),
  );
}

/** Wrap a TOTP secret for storage: IV(12) ‖ TAG(16) ‖ ciphertext, AES-256-GCM under this server's key. */
export async function encryptTotpSecret(plain: Buffer | string): Promise<Buffer> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await getMfaSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Inverse of encryptTotpSecret; null when this server's key cannot open it. */
export async function decryptTotpSecret(data: Buffer): Promise<string | null> {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      await getMfaSecretKey(),
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("Failed to decrypt TOTP secret", err);
    return null;
  }
}

export async function provisionMfaEnrolment(
  client: { query(text: string, params?: unknown[]): Promise<unknown> },
  subjectRealm: string,
  subjectId: string,
  method: "sms_otp" | "totp",
  isPrimary: boolean,
  phoneE164?: string | null,
  totpSecretPlain?: Buffer | null,
  options: { confirmed?: boolean } = {},
) {
  const confirmed = options.confirmed ?? true;
  const totpSecretEncrypted =
    method === "totp" && totpSecretPlain ? await encryptTotpSecret(totpSecretPlain) : null;

  if (confirmed) {
    if (isPrimary) {
      await client.query(
        `UPDATE mfa_enrolments
            SET is_primary = false
          WHERE subject_realm = $1 AND subject_id = $2 AND method <> $3 AND is_primary = true`,
        [subjectRealm, subjectId, method],
      );
    }
    await client.query(
      `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, totp_secret, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (subject_realm, subject_id, method) DO UPDATE SET
         is_primary = EXCLUDED.is_primary,
         phone_e164 = COALESCE(EXCLUDED.phone_e164, mfa_enrolments.phone_e164),
         totp_secret = COALESCE(EXCLUDED.totp_secret, mfa_enrolments.totp_secret),
         confirmed_at = COALESCE(mfa_enrolments.confirmed_at, now())`,
      [subjectRealm, subjectId, method, isPrimary, phoneE164 || null, totpSecretEncrypted],
    );
  } else {
    // Stage as pending (unconfirmed, non-primary) and allow re-staging if a
    // previous attempt for this method was never confirmed (Issue #809 — Finding 4).
    await client.query(
      `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, totp_secret, confirmed_at)
       VALUES ($1, $2, $3, false, $4, $5, NULL)
       ON CONFLICT (subject_realm, subject_id, method)
       DO UPDATE SET
         phone_e164 = EXCLUDED.phone_e164,
         totp_secret = EXCLUDED.totp_secret,
         is_primary = false,
         confirmed_at = NULL
       WHERE mfa_enrolments.confirmed_at IS NULL`,
      [subjectRealm, subjectId, method, phoneE164 || null, totpSecretEncrypted],
    );
  }
}

/**
 * Confirm a pending (or bootstrap) MFA enrolment after code verification.
 *
 * Sets `confirmed_at = COALESCE(confirmed_at, now())`, promotes `is_primary`
 * if the account has no confirmed primary enrolment yet, and issues initial
 * recovery codes if the account currently has none.
 */
export async function confirmMfaEnrolment(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  method: MfaMethod,
  /**
   * Issue #854 — the audit row for this confirmation, written on the same
   * connection and inside the same transaction as the change it records.
   */
  options: {
    audit?: SecurityAuditAttribution;
    auditRealm?: "tenant" | "platform";
    /**
     * Issue #854 (P2.21) — the number the just-redeemed challenge was bound
     * to. When the factor is already confirmed and names a different number,
     * this confirmation is a *replacement*: the swap happens here, inside the
     * same account lock, after proof — never before it, so the account is
     * never factorless mid-flight and no code is ever sent to a number nobody
     * proved.
     */
    provenPhoneE164?: string | null;
  } = {},
): Promise<{
  confirmed: boolean;
  wasUnconfirmed: boolean;
  isPrimary: boolean;
  recoveryCodes: string[];
}> {
  return withoutTenantScope("platform", () =>
    withMfaAccountLock(subjectRealm, subjectId, async (client) => {
      // Read on the locked client: the decision below (is this the only
      // confirmed factor? does it become primary?) must see the state the lock
      // is holding still, not a snapshot taken before it was taken.
      const { rows } = await client.query<MfaEnrolmentRow>(
        `SELECT id, method, is_primary, phone_e164, confirmed_at, created_at
           FROM mfa_enrolments
          WHERE subject_realm = $1 AND subject_id = $2`,
        [subjectRealm, subjectId],
      );
      const existing = sortMfaEnrolments(rows);
      const target = existing.find((e) => e.method === method);
      if (!target) {
        return { confirmed: false, wasUnconfirmed: false, isPrimary: false, recoveryCodes: [] };
      }

      const wasUnconfirmed = target.confirmed_at === null;
      const otherConfirmedPrimary = existing.some(
        (e) => e.method !== method && e.confirmed_at !== null && e.is_primary,
      );
      const shouldBePrimary = !otherConfirmedPrimary;

      if (shouldBePrimary) {
        await client.query(
          `UPDATE mfa_enrolments
              SET is_primary = false
            WHERE subject_realm = $1 AND subject_id = $2 AND method <> $3`,
          [subjectRealm, subjectId, method],
        );
      }

      await client.query(
        `UPDATE mfa_enrolments
            SET confirmed_at = COALESCE(confirmed_at, now()),
                is_primary = CASE WHEN $4::boolean THEN true ELSE is_primary END
          WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
        [subjectRealm, subjectId, method, shouldBePrimary],
      );

      /**
       * Issue #854 (P2.21) — the atomic half of "replace the only SMS
       * factor". The row never stops being a factor: it stays confirmed the
       * whole time, and its destination swaps only now, after the new number
       * redeemed its own challenge. Before this, a required account simply
       * could not change its SMS number — removal refused the last factor and
       * re-enrolment refused the confirmed row.
       */
      const provenPhone = options.provenPhoneE164 ?? null;
      const replacedPhone =
        method === "sms_otp" &&
        provenPhone !== null &&
        target.confirmed_at !== null &&
        (target.phone_e164 ?? null) !== provenPhone;
      if (replacedPhone) {
        await client.query(
          `UPDATE mfa_enrolments
              SET phone_e164 = $4
            WHERE subject_realm = $1 AND subject_id = $2 AND method = $3
              AND confirmed_at IS NOT NULL`,
          [subjectRealm, subjectId, method, provenPhone],
        );
      }

      let recoveryCodes: string[] = [];
      if (wasUnconfirmed) {
        const remaining = await countRemainingRecoveryCodes(subjectRealm, subjectId);
        if (remaining === 0) {
          recoveryCodes = await issueRecoveryCodes(subjectRealm, subjectId, client);
        }
      }

      if (options.audit && wasUnconfirmed) {
        await recordSecurityAudit(
          {
            ...options.audit,
            realm: options.auditRealm ?? "tenant",
            action: SECURITY_AUDIT_ACTIONS.mfaEnrolConfirmed,
            entity: "platform_user",
            entityId: subjectId,
            payload: {
              ...options.audit.payload,
              method,
              recoveryCodesIssued: recoveryCodes.length,
              becamePrimary: shouldBePrimary,
            },
          },
          client,
        );
      }

      if (options.audit && replacedPhone) {
        await recordSecurityAudit(
          {
            ...options.audit,
            realm: options.auditRealm ?? "tenant",
            action: SECURITY_AUDIT_ACTIONS.mfaFactorReplaced,
            entity: "platform_user",
            entityId: subjectId,
            payload: { ...options.audit.payload, method },
          },
          client,
        );
      }

      return {
        confirmed: true,
        wasUnconfirmed,
        isPrimary: shouldBePrimary || target.is_primary,
        recoveryCodes,
      };
    }),
  );
}

/**
 * Explicitly switch the primary MFA method among confirmed enrolments.
 */
export async function setPrimaryMfaEnrolment(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  method: MfaMethod,
  options: { audit?: SecurityAuditAttribution; auditRealm?: "tenant" | "platform" } = {},
): Promise<{ ok: true } | { ok: false; error: "not_enrolled" | "not_confirmed" }> {
  return withoutTenantScope("platform", () =>
    withMfaAccountLock(subjectRealm, subjectId, async (client) => {
      const { rows } = await client.query<MfaEnrolmentRow>(
        `SELECT id, method, is_primary, phone_e164, confirmed_at, created_at
           FROM mfa_enrolments
          WHERE subject_realm = $1 AND subject_id = $2`,
        [subjectRealm, subjectId],
      );
      const target = sortMfaEnrolments(rows).find((e) => e.method === method);
      if (!target) return { ok: false, error: "not_enrolled" } as const;
      if (!isActiveMfaEnrolment(target)) return { ok: false, error: "not_confirmed" } as const;

      await client.query(
        `UPDATE mfa_enrolments
            SET is_primary = false
          WHERE subject_realm = $1 AND subject_id = $2 AND method <> $3`,
        [subjectRealm, subjectId, method],
      );
      await client.query(
        `UPDATE mfa_enrolments
            SET is_primary = true
          WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
        [subjectRealm, subjectId, method],
      );

      if (options.audit) {
        await recordSecurityAudit(
          {
            ...options.audit,
            realm: options.auditRealm ?? "tenant",
            action: SECURITY_AUDIT_ACTIONS.mfaPrimaryChanged,
            entity: "platform_user",
            entityId: subjectId,
            payload: { ...options.audit.payload, method },
          },
          client,
        );
      }
      return { ok: true } as const;
    }),
  );
}

/**
 * Remove a specific MFA enrolment from an account.
 *
 * Refuses to remove the last confirmed factor when MFA is mandatory for the
 * caller (`allowRemoveLast = false`), while always permitting removal of an
 * unconfirmed pending enrolment or a secondary confirmed factor.
 */
/**
 * Serialize every mutation of one account's MFA state (#854).
 *
 * The lifecycle operations here are read-decide-write against shared state, and
 * each of them was deciding on its own connection with no lock holding the state
 * still. Two concurrent `remove` calls for an account with exactly two
 * factors — TOTP and SMS — are the minimal case: both read "two confirmed, this
 * one is not the last", both delete, and an account whose memberships mandate
 * MFA is left with **zero** factors. Neither call was wrong on the data it saw;
 * the data moved between its read and its write.
 *
 * A transaction alone does not fix that under READ COMMITTED — each statement
 * takes a fresh snapshot, so a plain `SELECT` inside a transaction shows the
 * other transaction's committed middle state rather than blocking. What
 * serializes them is a **lock on the account**, which is why the primitive is a
 * transaction-scoped advisory lock keyed on the subject:
 *
 *     pg_advisory_xact_lock(hashtext(subject_realm), hashtext(subject_id))
 *
 * Every path that reads-then-writes an account's factors takes it, so the state
 * cannot change under a decision. The lock is released at COMMIT/ROLLBACK and
 * is keyed by *subject*, not by business: an identity with memberships in three
 * businesses has one MFA state and therefore one lock, which is the whole point
 * of the cross-membership rule (P0.9).
 *
 * Locks are always taken on the subject first and on nothing else afterwards in
 * a different order, so two concurrent operations cannot deadlock against each
 * other. Nested calls reuse the same transaction through `isPinnedToTransaction`
 * semantics — see `runMfaAccountTransaction`.
 */
export async function withMfaAccountLock<T>(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    /**
     * Two `int4` keys: the realm and the subject. `hashtext` is stable for the
     * life of a server build and the pair is collision-resistant enough for a
     * lock whose worst case is two unrelated accounts serializing.
     */
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      subjectRealm,
      subjectId,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lock the membership rows and policy rows a cross-membership decision reads.
 *
 * `FOR SHARE` rather than `FOR UPDATE`: a concurrent role change or policy write
 * is welcome to proceed — it just has to wait until this decision has committed,
 * so it cannot slip between the read and the write. Taking `FOR UPDATE` here
 * would make the removal block every unrelated edit to the same membership for
 * the duration, and would order the two operations the wrong way round (the
 * policy writer is the one that has to see the removal's result).
 */
async function lockBindingMembershipState(
  client: PoolClient,
  platformUserId: string,
): Promise<void> {
  await client.query(
    `SELECT u.id FROM users u WHERE u.platform_user_id = $1 FOR SHARE OF u`,
    [platformUserId],
  );
  await client.query(
    `SELECT s.business_id
       FROM settings s
      WHERE s.business_id IN (SELECT business_id FROM users WHERE platform_user_id = $1)
        AND s.location_id IS NULL
        AND s.key = $2
      FOR SHARE OF s`,
    [platformUserId, SETTING_KEYS.mfaPolicy],
  );
}

export async function removeMfaEnrolment(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  method: MfaMethod,
  options: { allowRemoveLast?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: "not_enrolled" | "cannot_remove_last_factor" }> {
  return withoutTenantScope("platform", async () => {
    const enrolments = await getAccountMfaEnrolments(subjectRealm, subjectId);
    const target = enrolments.find((e) => e.method === method);
    if (!target) return { ok: false, error: "not_enrolled" };

    const confirmed = enrolments.filter((e) => e.confirmed_at !== null);
    if (
      target.confirmed_at !== null &&
      confirmed.length <= 1 &&
      !options.allowRemoveLast
    ) {
      return { ok: false, error: "cannot_remove_last_factor" };
    }

    await withoutTenantScope("identity", () =>
      removeMfaEnrolmentAtomic(subjectRealm, subjectId, method, confirmed),
    );

    return { ok: true };
  });
}

/**
 * The delete + primary-promotion, on its own locked transaction.
 *
 * Split out so both `removeMfaEnrolment` and `removeMfaFactorChecked` share one
 * write path: the delete, the promotion of a surviving factor to primary, and
 * (in the checked variant) the invariant re-read all happen under the account
 * lock, so a concurrent removal cannot interleave between them.
 */
async function removeMfaEnrolmentAtomic(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  method: MfaMethod,
  confirmedBefore: readonly MfaEnrolmentRow[],
): Promise<void> {
  return withMfaAccountLock(subjectRealm, subjectId, async (client) => {
    await client.query(
      `DELETE FROM mfa_enrolments
        WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
      [subjectRealm, subjectId, method],
    );

    const remainingConfirmed = confirmedBefore.filter(
      (e) => e.method !== method && e.confirmed_at !== null,
    );
    if (remainingConfirmed.length > 0 && !remainingConfirmed.some((e) => e.is_primary)) {
      const nextPrimary = selectPrimaryMfaEnrolment(remainingConfirmed);
      if (nextPrimary) {
        await client.query(
          `UPDATE mfa_enrolments
              SET is_primary = true
            WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
          [subjectRealm, subjectId, nextPrimary.method],
        );
      }
    }
  });
}

export type RemoveMfaFactorResult =
  | { ok: true }
  | { ok: false; error: "not_enrolled" }
  | { ok: false; error: "cannot_remove_last_factor"; reason: string | null };

/**
 * Remove a factor, deciding the last-factor question **inside** the lock (#854).
 *
 * The route used to do this in three hops — read the factors, ask
 * `mayRemoveGlobalMfaFactor`, call `removeMfaEnrolment` — each on its own
 * connection. The answer to "is this the last factor?" is a property of the
 * account at the instant of the delete, and nothing held the account still
 * across those hops: two parallel removals of a two-factor account each saw two
 * factors and each deleted one, leaving an account whose memberships mandate MFA
 * with none. The same read-decide-write shape is why the cross-membership check
 * could pass and the deletion still be wrong.
 *
 * This function is one transaction:
 *
 *  1. take the account lock, then `FOR SHARE` the membership and policy rows the
 *     cross-membership rule reads (`lockBindingMembershipState`), so a role or
 *     policy change already in flight commits *before* or *after* this decision,
 *     never through the middle of it;
 *  2. read the factors;
 *  3. evaluate the requirement across every active membership;
 *  4. refuse, or delete;
 *  5. **re-read the factors and assert the invariant before COMMIT** — if the
 *     account is still required to have a factor and now has none, the whole
 *     thing rolls back rather than committing a factorless privileged account.
 *
 * `allowRemoveLast` short-circuits steps 3–5: a caller that has already
 * established the removal is legitimate (an administrator deactivating the
 * account, a reset) does not need the cross-membership veto, and that flag is
 * exactly what the route forgot to pass, so a member whose only *binding*
 * membership did not require MFA was still refused by the service default.
 */
export async function removeMfaFactorChecked(input: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  method: MfaMethod;
  /**
   * Whether the last confirmed factor may be removed at all. When false
   * (default) the last factor is refused outright, whatever the memberships say.
   */
  allowRemoveLast?: boolean;
  /**
   * Whether to evaluate the requirement across the identity's memberships. Set
   * for a `platform_user` subject, whose memberships are what make its factors
   * mandatory; a `platform_admin` has no memberships and is judged by the
   * caller's own policy.
   */
  evaluateGlobalRequirement?: boolean;
  /**
   * Issue #854 (invariant 12) — the audit row, written **inside this
   * transaction**. A factor cannot be removed without the row that says so:
   * the two commit together or neither does.
   */
  audit?: SecurityAuditAttribution;
  auditRealm?: "tenant" | "platform";
}): Promise<RemoveMfaFactorResult> {
  const { subjectRealm, subjectId, method } = input;
  return withoutTenantScope("identity", () =>
    withMfaAccountLock(subjectRealm, subjectId, async (client) => {
      const loadEnrolments = async () => {
        const { rows } = await client.query<MfaEnrolmentRow>(
          `SELECT id, method, is_primary, phone_e164, confirmed_at, created_at
             FROM mfa_enrolments
            WHERE subject_realm = $1 AND subject_id = $2`,
          [subjectRealm, subjectId],
        );
        return sortMfaEnrolments(rows);
      };

      const enrolments = await loadEnrolments();
      const target = enrolments.find((e) => e.method === method);
      if (!target) return { ok: false, error: "not_enrolled" } as const;

      const confirmedBefore = enrolments.filter((e) => e.confirmed_at !== null);
      const isTargetConfirmed = target.confirmed_at !== null;
      const isLastConfirmedFactor = isTargetConfirmed && confirmedBefore.length <= 1;

      if (!isLastConfirmedFactor) {
        await removeMfaInsideTransaction(client, subjectRealm, subjectId, method, confirmedBefore);
        await writeRemovalAudit(client, input, method, { lastFactor: false });
        return { ok: true } as const;
      }

      if (!input.allowRemoveLast) {
        return { ok: false, error: "cannot_remove_last_factor", reason: null } as const;
      }

      if (input.evaluateGlobalRequirement) {
        await lockBindingMembershipState(client, subjectId);
        const requirement = await globalMfaRequirementForPlatformUser(subjectId);
        if (requirement.required) {
          // Nothing has been written yet, so the transaction simply ends.
          return {
            ok: false,
            error: "cannot_remove_last_factor",
            reason: requirement.reason,
          } as const;
        }
      }

      await removeMfaInsideTransaction(client, subjectRealm, subjectId, method, confirmedBefore);

      /**
       * The invariant, re-read inside the lock before COMMIT.
       *
       * Belt and braces on purpose: every path that could have made the factor
       * required has already committed or is blocked on the locks above, so this
       * should be unreachable — which is exactly why it is worth asserting. A
       * future edit that adds a write between the decision and the delete turns
       * a silent privilege hole into a failed request, and the counter it fails
       * on is a query a reviewer can read.
       */
      if (input.evaluateGlobalRequirement) {
        const after = await loadEnrolments();
        const stillHasFactor = after.some((e) => isActiveMfaEnrolment(e));
        if (!stillHasFactor) {
          const requirement = await globalMfaRequirementForPlatformUser(subjectId);
          if (requirement.required) {
            throw new Error("mfa_invariant_violation: required account left without a factor");
          }
        }
      }

      await writeRemovalAudit(client, input, method, { lastFactor: true });
      return { ok: true } as const;
    }),
  );
}

/**
 * The removal's audit row, on the removal's transaction (#854 invariant 12).
 *
 * `lastFactor` is recorded because it is the fact an investigator needs: losing
 * the only factor is a different event from losing one of two, and the row must
 * say which happened without anybody having to reconstruct the enrolment table
 * as it stood at the time.
 */
async function writeRemovalAudit(
  client: PoolClient,
  input: {
    subjectRealm: MfaSubjectRealm;
    subjectId: string;
    audit?: SecurityAuditAttribution;
    auditRealm?: "tenant" | "platform";
  },
  method: MfaMethod,
  detail: { lastFactor: boolean },
): Promise<void> {
  if (!input.audit) return;
  await recordSecurityAudit(
    {
      ...input.audit,
      realm: input.auditRealm ?? "tenant",
      action: SECURITY_AUDIT_ACTIONS.mfaFactorRemoved,
      entity: input.auditRealm === "platform" ? "platform_admin" : "platform_user",
      entityId: input.subjectId,
      payload: { ...input.audit.payload, method, lastFactorRemoved: detail.lastFactor },
    },
    client,
  );
}

/** The delete + primary promotion, on the caller's locked transaction. */
async function removeMfaInsideTransaction(
  client: PoolClient,
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  method: MfaMethod,
  confirmedBefore: readonly MfaEnrolmentRow[],
): Promise<void> {
  await client.query(
    `DELETE FROM mfa_enrolments
      WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
    [subjectRealm, subjectId, method],
  );

  const remainingConfirmed = confirmedBefore.filter(
    (e) => e.method !== method && e.confirmed_at !== null,
  );
  if (remainingConfirmed.length > 0 && !remainingConfirmed.some((e) => e.is_primary)) {
    const nextPrimary = selectPrimaryMfaEnrolment(remainingConfirmed);
    if (nextPrimary) {
      await client.query(
        `UPDATE mfa_enrolments
            SET is_primary = true
          WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
        [subjectRealm, subjectId, nextPrimary.method],
      );
    }
  }
}

export async function getMfaSecretKey(): Promise<Buffer> {
  const envKey = process.env.MFA_SECRET_KEY;
  if (envKey) {
    return Buffer.from(envKey, "hex");
  }
  return Buffer.from(await getRealmSecret("mfa"));
}

export type MfaSubjectRealm = "platform_user" | "platform_admin";

/** One row of the console's «وضعیت ورود دومرحله‌ای» readout. */
export interface MfaAccountStatus {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  email: string;
  fullName: string;
  /** A platform-admin role, or the business role(s) this identity holds. */
  role: string;
  /** The businesses this identity is gated in — empty for a platform admin. */
  businesses: { id: string; name: string }[];
  methods: ("totp" | "sms_otp")[];
  enrolledAt: string | null;
  graceUntil: string | null;
  recoveryCodesRemaining: number;
  requirement: MfaRequirement;
}

interface MfaFacts {
  methods: ("totp" | "sms_otp")[];
  enrolledAt: Date | null;
  graceUntil: Date | null;
  recoveryRemaining: number;
}

async function mfaFactsFor(
  subjectRealm: MfaSubjectRealm,
  subjectIds: string[],
): Promise<Map<string, MfaFacts>> {
  const facts = new Map<string, MfaFacts>();
  if (subjectIds.length === 0) return facts;

  const blank = (): MfaFacts => ({
    methods: [],
    enrolledAt: null,
    graceUntil: null,
    recoveryRemaining: 0,
  });
  for (const id of subjectIds) facts.set(id, blank());

  const { rows: enrolments } = await query<{
    subject_id: string;
    method: "totp" | "sms_otp";
    is_primary: boolean;
    confirmed_at: Date | null;
    created_at: Date;
  }>(
    `SELECT subject_id, method, is_primary, confirmed_at, created_at
       FROM mfa_enrolments
      WHERE subject_realm = $1 AND subject_id = ANY($2::uuid[])
        AND (confirmed_at IS NOT NULL OR (method = 'sms_otp' AND is_primary = true))
      ORDER BY is_primary DESC, method`,
    [subjectRealm, subjectIds],
  );
  for (const row of enrolments) {
    const entry = facts.get(row.subject_id);
    if (!entry) continue;
    entry.methods.push(row.method);
    const at = new Date(row.created_at);
    if (!entry.enrolledAt || at < entry.enrolledAt) entry.enrolledAt = at;
  }

  const { rows: graces } = await query<{ subject_id: string; grace_until: Date }>(
    `SELECT subject_id, grace_until FROM mfa_grace_periods
      WHERE subject_realm = $1 AND subject_id = ANY($2::uuid[])`,
    [subjectRealm, subjectIds],
  );
  for (const row of graces) {
    const entry = facts.get(row.subject_id);
    if (entry) entry.graceUntil = new Date(row.grace_until);
  }

  const { rows: recovery } = await query<{ subject_id: string; remaining: string }>(
    `SELECT subject_id, count(*) AS remaining FROM mfa_recovery_codes
      WHERE subject_realm = $1 AND subject_id = ANY($2::uuid[]) AND used_at IS NULL
      GROUP BY subject_id`,
    [subjectRealm, subjectIds],
  );
  for (const row of recovery) {
    const entry = facts.get(row.subject_id);
    if (entry) entry.recoveryRemaining = Number(row.remaining);
  }

  return facts;
}

function toStatus(
  subjectRealm: MfaSubjectRealm,
  identity: {
    subjectId: string;
    email: string;
    fullName: string;
    role: string;
    businesses: { id: string; name: string }[];
  },
  facts: MfaFacts,
  now: Date,
): MfaAccountStatus {
  return {
    subjectRealm,
    ...identity,
    methods: facts.methods,
    enrolledAt: facts.enrolledAt?.toISOString() ?? null,
    graceUntil: facts.graceUntil?.toISOString() ?? null,
    recoveryCodesRemaining: facts.recoveryRemaining,
    requirement: enrolmentRequirement(
      {
        hasPrimary: facts.methods.length > 0,
        graceUntil: facts.graceUntil,
        hasGraceRecord: facts.graceUntil !== null,
        role: identity.role,
      },
      now,
    ),
  };
}

export async function listMfaAccountStatus(now: Date = new Date()): Promise<MfaAccountStatus[]> {
  return withoutTenantScope("platform", async () => {
    const { rows: admins } = await query<{
      id: string;
      email: string;
      full_name: string;
      role: string;
    }>(
      `SELECT id, email::text AS email, full_name, role::text AS role
         FROM platform_admins WHERE is_active ORDER BY email`,
    );

    const { rows: owners } = await query<{
      id: string;
      email: string;
      full_name: string;
      roles: string[];
      businesses: { id: string; name: string }[];
    }>(
      `SELECT s.id,
              s.email::text AS email,
              s.full_name,
              array_agg(DISTINCT u.role::text) AS roles,
              jsonb_agg(DISTINCT jsonb_build_object('id', b.id, 'name', b.name)) AS businesses
         FROM platform_users s
         JOIN users u ON u.platform_user_id = s.id
         JOIN businesses b ON b.id = u.business_id
        WHERE s.is_active
          AND b.status <> 'archived'
          AND (
            u.role = 'owner'
            OR u.role = 'admin'
            OR (u.role = 'manager' AND COALESCE((
                 SELECT (st.value ->> 'requireForManagers')::boolean
                   FROM settings st
                  WHERE st.business_id = b.id
                    AND st.location_id IS NULL
                    AND st.key = $1
               ), false))
            OR (u.role = 'accountant' AND COALESCE((
                 SELECT (st.value ->> 'requireForAccountants')::boolean
                   FROM settings st
                  WHERE st.business_id = b.id
                    AND st.location_id IS NULL
                    AND st.key = $1
               ), false))
          )
        GROUP BY s.id, s.email, s.full_name
        ORDER BY s.email`,
      /**
       * Issue #854 (P1.1): the key is bound from `SETTING_KEYS` rather than
       * spelled out. The sibling query below used to say `security.mfaPolicy`,
       * which nothing in the repository writes — so this roster listed
       * owner/manager only, and an `admin` with a mandatory factor was missing
       * from the console's own MFA report.
       */
      [SETTING_KEYS.mfaPolicy],
    );

    const [adminFacts, ownerFacts] = await Promise.all([
      mfaFactsFor("platform_admin", admins.map((a) => a.id)),
      mfaFactsFor("platform_user", owners.map((o) => o.id)),
    ]);

    const blank: MfaFacts = {
      methods: [],
      enrolledAt: null,
      graceUntil: null,
      recoveryRemaining: 0,
    };

    return [
      ...admins.map((a) =>
        toStatus(
          "platform_admin",
          {
            subjectId: a.id,
            email: a.email,
            fullName: a.full_name,
            role: a.role,
            businesses: [],
          },
          adminFacts.get(a.id) ?? blank,
          now,
        ),
      ),
      ...owners.map((o) =>
        toStatus(
          "platform_user",
          {
            subjectId: o.id,
            email: o.email,
            fullName: o.full_name,
            role: [...new Set(o.roles ?? [])].sort().join("، "),
            businesses: o.businesses ?? [],
          },
          ownerFacts.get(o.id) ?? blank,
          now,
        ),
      ),
    ];
  });
}

// ---------------------------------------------------------------------------
// Global MFA requirement across every membership (issue #854 — P0.9)
// ---------------------------------------------------------------------------

/** One active membership's contribution to the global requirement. */
export interface MembershipMfaRequirement {
  membershipId: string;
  businessId: string;
  businessName: string;
  role: string;
  /** True when this membership's policy makes a factor non-negotiable. */
  requires: boolean;
  /** The policy that decided it, for the explanation the UI shows. */
  requireForManagers: boolean;
  requireForAccountants: boolean;
  /** True when the business itself is archived/suspended (its rule does not bind). */
  businessInactive: boolean;
}

export interface GlobalMfaRequirement {
  /**
   * The strictest active requirement wins. When true, the last confirmed factor
   * may not be removed from this global identity, wherever the user is standing.
   */
  required: boolean;
  /** Every active membership considered, newest requirement first. */
  memberships: MembershipMfaRequirement[];
  /** The membership whose rule is the binding one (null when none requires). */
  bindingMembershipId: string | null;
  /** Persian explanation naming the business that requires the factor. */
  reason: string | null;
}

/**
 * Compute the MFA requirement for a **global** identity across **all** of its
 * active memberships.
 *
 * The defect this closes (#854 P0.9): MFA belongs to a `platform_user`, but the
 * decision to remove the last factor was made in the context of whichever
 * business the person was standing in. The same identity could be an Owner in
 * Business A (where MFA is mandatory) and an Accountant in Business B (where it
 * is not), so entering B and removing the factor there quietly removed it
 * everywhere — including for the owner-level access in A.
 *
 * The rule is "the strictest active requirement wins": if *any* active
 * membership makes a factor non-negotiable, the factor is non-negotiable. An
 * inactive or suspended membership does not bind, because it cannot be used to
 * reach anything.
 *
 * Reads bypassed: the question is definitionally cross-tenant.
 */
export async function globalMfaRequirementForPlatformUser(
  platformUserId: string,
): Promise<GlobalMfaRequirement> {
  return withoutTenantScope("identity", async () => {
    const { rows } = await query<{
      membership_id: string;
      business_id: string;
      business_name: string;
      business_status: string;
      role: string;
      mfa_policy: unknown;
    }>(
      `SELECT u.id AS membership_id,
              u.business_id,
              b.name AS business_name,
              b.status::text AS business_status,
              u.role::text AS role,
              s.value AS mfa_policy
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         LEFT JOIN settings s
                ON s.business_id = u.business_id
               AND s.location_id IS NULL
               AND s.key = $2
        WHERE u.platform_user_id = $1
          AND u.is_active = true
        ORDER BY u.created_at`,
      /**
       * The key is bound, not spelled. This join previously named
       * `security.mfaPolicy` — a key **nothing in the repository writes** — so
       * the policy always read as null, `normalizeMfaPolicy` returned the
       * defaults, and the "strictest active requirement wins" rule only ever
       * saw the role baseline (owner/admin). A business that had turned the
       * manager or accountant knob on was invisible here, which is exactly the
       * P0.9 hole this function exists to close.
       */
      [platformUserId, SETTING_KEYS.mfaPolicy],
    );

    const memberships: MembershipMfaRequirement[] = rows.map((row) => {
      const policy = normalizeMfaPolicy(row.mfa_policy);
      const businessInactive = row.business_status !== "active";
      return {
        membershipId: row.membership_id,
        businessId: row.business_id,
        businessName: row.business_name,
        role: row.role,
        requires: !businessInactive && privilegedMfaBaseline(row.role, policy),
        requireForManagers: policy.requireForManagers,
        requireForAccountants: policy.requireForAccountants,
        businessInactive,
      };
    });

    const binding = memberships.find((m) => m.requires) ?? null;
    return {
      required: binding !== null,
      memberships,
      bindingMembershipId: binding?.membershipId ?? null,
      reason: binding
        ? `ورود دومرحله‌ای برای نقش «${binding.role}» در کسب‌وکار «${binding.businessName}» اجباری است؛ تا زمانی که آن عضویت فعال است، آخرین روش ورود دومرحله‌ای حذف نمی‌شود.`
        : null,
    };
  });
}

/**
 * Whether the **last confirmed factor** may be removed for a global identity.
 *
 * A single call so every removal surface (`/api/auth/mfa/self`, the platform
 * console, `/api/auth/mfa/enrol` confirmation) asks the same question, and none
 * of them can decide it from the current business alone.
 *
 * Removing a *secondary* factor, or an unconfirmed pending enrolment, is always
 * allowed — neither reduces the account's protection.
 */
export async function mayRemoveGlobalMfaFactor(
  platformUserId: string,
  options: { isLastConfirmedFactor: boolean },
): Promise<{ allowed: boolean; reason: string | null }> {
  if (!options.isLastConfirmedFactor) return { allowed: true, reason: null };
  const requirement = await globalMfaRequirementForPlatformUser(platformUserId);
  if (!requirement.required) return { allowed: true, reason: null };
  return { allowed: false, reason: requirement.reason };
}
