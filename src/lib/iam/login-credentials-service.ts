/**
 * DB half of src/lib/iam/login-credentials.ts. Cloud side builds the payload a
 * paired site may read; site side applies it. Covered by
 * integration/iam-login-credentials.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { STAFF_PIN_ROLES_SQL } from "../login-eligibility";
import { PIN_ROLES } from "../roles";
import { getPool, query, withTenant, withoutTenantScope } from "../db";
import { lockMembership, lockMemberships } from "../membership-lock";
import { syncMembershipIdentity } from "../membership-identity-sync";
import { decryptTotpSecret, encryptTotpSecret } from "../mfa-service";
import {
  loginCredentialsFingerprint,
  planIdentityBinding,
  planPinRemoval,
  planPinReplication,
  planSitePinAcceptance,
  type LocalPinState,
  type ReplicatedLoginCredential,
  type ReplicatedPin,
  type SpentRecoveryCode,
} from "./login-credentials";

/** Cloud: every identity with a membership in this business. RLS limits platform_users to members. */
export async function buildLoginCredentials(businessId: string): Promise<ReplicatedLoginCredential[]> {
  return withTenant(businessId, async () => {
    const people = await query<{
      membership_id: string;
      platform_user_id: string;
      email: string | null;
      full_name: string;
      password_hash: string | null;
      phone_e164: string | null;
      phone_verified: boolean;
      is_active: boolean;
      token_version: number;
    }>(
      `SELECT u.id AS membership_id, p.id AS platform_user_id, p.email::text AS email, p.full_name,
              p.password_hash, p.phone_e164, (p.phone_verified_at IS NOT NULL) AS phone_verified,
              p.is_active, p.token_version
         FROM users u JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.business_id = $1 ORDER BY u.id`,
      [businessId],
    );
    const ids = people.rows.map((row) => row.platform_user_id);
    const [enrolments, codes] = await Promise.all([
      query<{ subject_id: string; method: "totp" | "sms_otp"; is_primary: boolean; phone_e164: string | null; totp_secret: Buffer | null }>(
        `SELECT subject_id, method, is_primary, phone_e164, totp_secret FROM mfa_enrolments
          WHERE subject_realm = 'platform_user' AND subject_id = ANY($1::uuid[]) AND confirmed_at IS NOT NULL`,
        [ids],
      ),
      query<{ subject_id: string; code_hash: string; used_at: Date | null }>(
        `SELECT subject_id, code_hash, used_at FROM mfa_recovery_codes
          WHERE subject_realm = 'platform_user' AND subject_id = ANY($1::uuid[])`,
        [ids],
      ),
    ]);
    const credentials: ReplicatedLoginCredential[] = [];
    for (const person of people.rows) {
      const mfa: ReplicatedLoginCredential["mfa"] = [];
      for (const row of enrolments.rows.filter((e) => e.subject_id === person.platform_user_id)) {
        const totpSecret = row.method === "totp" && row.totp_secret ? await decryptTotpSecret(row.totp_secret) : null;
        // A TOTP row this server cannot open is useless to the site too.
        if (row.method === "totp" && !totpSecret) continue;
        mfa.push({ method: row.method, isPrimary: row.is_primary, phoneE164: row.phone_e164, totpSecret });
      }
      credentials.push({
        membershipId: person.membership_id,
        // Issue #948 P0-1 — the canonical global identity ID (contract v2).
        // `platform_users.id` is the same value on both replicas after the
        // site binds by it, which is exactly what the cloud-login readiness
        // check compares.
        platformUserId: person.platform_user_id,
        email: person.email ? person.email.trim().toLowerCase() : null,
        fullName: person.full_name,
        passwordHash: person.password_hash ?? null,
        ...(person.phone_e164
          ? { phoneE164: person.phone_e164, phoneVerified: person.phone_verified === true }
          : {}),
        isActive: person.is_active,
        tokenVersion: person.token_version,
        mfa,
        recoveryCodes: codes.rows
          .filter((c) => c.subject_id === person.platform_user_id)
          .map((c) => ({ codeHash: c.code_hash, usedAt: c.used_at?.toISOString() ?? null })),
      });
    }
    return credentials;
  });
}

/**
 * Site: every recovery code spent here, so the cloud can stop accepting it.
 * Sent before each fetch; the cloud keeps the first stamp it sees.
 */
export async function spentRecoveryCodes(businessId: string): Promise<SpentRecoveryCode[]> {
  const { rows } = await query<{ membership_id: string; code_hash: string; used_at: Date }>(
    `SELECT u.id AS membership_id, r.code_hash, r.used_at
       FROM users u JOIN mfa_recovery_codes r
         ON r.subject_realm = 'platform_user' AND r.subject_id = u.platform_user_id
      WHERE u.business_id = $1 AND r.used_at IS NOT NULL`,
    [businessId],
  );
  return rows.map((row) => ({ membershipId: row.membership_id, codeHash: row.code_hash, usedAt: row.used_at.toISOString() }));
}

/**
 * Cloud: mark codes a paired site reports as spent. Only codes of identities
 * holding a membership in *this* business, matched by exact hash.
 */
export async function recordSpentRecoveryCodes(businessId: string, spent: readonly SpentRecoveryCode[]): Promise<void> {
  if (spent.length === 0) return;
  await withTenant(businessId, () => query(
    `UPDATE mfa_recovery_codes r SET used_at = s.used_at
       FROM unnest($2::uuid[], $3::text[], $4::timestamptz[]) AS s(membership_id, code_hash, used_at)
       JOIN users u ON u.id = s.membership_id AND u.business_id = $1
      WHERE r.subject_realm = 'platform_user' AND r.subject_id = u.platform_user_id
        AND r.code_hash = s.code_hash AND r.used_at IS NULL`,
    [businessId, spent.map((c) => c.membershipId), spent.map((c) => c.codeHash), spent.map((c) => c.usedAt)],
  ));
}

/** What one `applyLoginCredentials()` pass changed — issue #948 diagnostics. */
export interface LoginCredentialApplyResult {
  /** True when this pass wrote at least one credential row or binding. */
  changed: boolean;
  /** Memberships whose password/MFA/recovery material was rewritten. */
  identitiesApplied: number;
  /** Memberships relinked onto the identity the cloud named (wrong/missing link). */
  bindingsRepaired: number;
  /**
   * Memberships the payload names a global identity for that are *still* not
   * bound to it after the pass — the measure that must never be reported
   * green. (Deliberately not "every password-role member without a link": a
   * PIN-eligible manager the cloud has no identity for is legitimate and is
   * not in the payload at all.)
   */
  bindingsStillBroken: number;
  /** Pre-v2 local UUIDs migrated onto the canonical cloud identity ID. */
  identitiesRekeyed: number;
  /**
   * Rows left untouched because updating the email would collide with a
   * different row. Reported, never resolved destructively.
   */
  identityEmailConflicts: number;
  /**
   * Verified phones left untouched because another identity row on the site
   * already holds the same verified number. Reported, never auto-merged.
   */
  identityPhoneConflicts: number;
}

/**
 * Site: make each member's local identity equal the cloud's. Writes
 * platform_users under the documented "identity" bypass — the same narrow
 * write a password reset makes, reached only through a membership row this
 * business owns. Compared against the site's *current* rows, so a local
 * change (a reset, a direct edit) is put back rather than silently diverging.
 *
 * Issue #948 P0-1 — the identity *binding* is part of that equality. Each
 * membership is bound to the cloud's canonical global identity ID
 * (`planIdentityBinding`): an existing row with that exact ID is updated; a
 * pre-v2 row found by its unique email is re-keyed onto the canonical ID with
 * every reference moved (password, MFA, recovery codes, token version and
 * revocation semantics preserved); otherwise the row is created under the
 * canonical ID — the site never mints a fresh local UUID for an identity the
 * cloud named. A legacy payload without IDs keeps the v1 email/link rules.
 * The fingerprint covers the identity ID, so a wrongly-bound membership can no
 * longer look converged and skip repair.
 */
export async function applyLoginCredentials(
  businessId: string,
  credentials: readonly ReplicatedLoginCredential[],
): Promise<LoginCredentialApplyResult> {
  const wanted = new Set(credentials.map((c) => c.membershipId));
  const local = (await buildLoginCredentials(businessId)).filter((c) => wanted.has(c.membershipId));
  // A legacy cloud names no identity IDs; compare against a local build masked
  // the same way, or every sync would rewrite perfectly converged rows.
  const legacyPayload = !credentials.some((c) => c.platformUserId != null);
  const legacyPhonePayload = !credentials.some((c) => c.phoneE164 !== undefined);
  // Token version compares as a *floor*, not byte equality: the write below
  // keeps `GREATEST(local, incoming)` for revocation monotonicity (a stale
  // cloud payload must never un-revoke sessions), so after a site-only
  // password put-back the local version legitimately stays above the cloud's.
  // Converged means "applying the payload now would be a no-op" — which is
  // exactly `min(local, incoming) == incoming`.
  const incomingByMembership = new Map(credentials.map((c) => [c.membershipId, c]));
  const comparableLocal = local.map((c) => ({
    ...c,
    platformUserId: legacyPayload ? undefined : c.platformUserId,
    ...(legacyPhonePayload ? { phoneE164: undefined, phoneVerified: undefined } : {}),
    tokenVersion: Math.min(c.tokenVersion ?? 1, incomingByMembership.get(c.membershipId)?.tokenVersion ?? 1),
  }));
  const result: LoginCredentialApplyResult = {
    changed: false, identitiesApplied: 0, bindingsRepaired: 0, bindingsStillBroken: 0,
    identitiesRekeyed: 0, identityEmailConflicts: 0, identityPhoneConflicts: 0,
  };
  if (loginCredentialsFingerprint(comparableLocal) === loginCredentialsFingerprint(credentials)) {
    // Converged — and for a canonical payload the fingerprint covers the
    // identity ID, so converged *means* correctly bound. A legacy payload
    // cannot verify bindings and keeps v1 behaviour.
    result.bindingsStillBroken = 0;
    return result;
  }

  const members = await query<{ id: string; platform_user_id: string | null }>(
    `SELECT id, platform_user_id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, credentials.map((c) => c.membershipId)],
  );
  const linked = new Map(members.rows.map((row) => [row.id, row.platform_user_id]));
  const candidateEmails = credentials
    .map((c) => (typeof c.email === "string" ? c.email.trim().toLowerCase() : null))
    .filter((e): e is string => Boolean(e));
  const candidatePhones = credentials
    .map((c) => (typeof c.phoneE164 === "string" && c.phoneE164.trim() ? c.phoneE164.trim() : null))
    .filter((p): p is string => Boolean(p));
  // `platform_users.email` is UNIQUE and verified `phone_e164` is UNIQUE, so
  // either match names at most one row — read under the identity bypass so
  // unlinked or cross-business local rows are visible before INSERT.
  const identityRows = await withoutTenantScope("identity", () =>
    query<{
      id: string;
      email: string | null;
      phone_e164: string | null;
      phone_verified: boolean;
    }>(
      `SELECT id, email::text AS email, phone_e164, (phone_verified_at IS NOT NULL) AS phone_verified
         FROM platform_users
        WHERE id = ANY($1::uuid[])
           OR email = ANY($2::citext[])
           OR (phone_verified_at IS NOT NULL AND phone_e164 = ANY($3::text[]))`,
      [
        credentials.map((c) => c.platformUserId).filter((id): id is string => typeof id === "string"),
        candidateEmails,
        candidatePhones,
      ],
    ),
  );
  const idExists = new Set(identityRows.rows.map((row) => row.id.toLowerCase()));
  const byEmail = new Map(
    identityRows.rows
      .filter((row): row is typeof row & { email: string } => typeof row.email === "string" && row.email.trim().length > 0)
      .map((row) => [row.email.trim().toLowerCase(), row.id]),
  );
  const byVerifiedPhone = new Map(
    identityRows.rows
      .filter((row): row is typeof row & { phone_e164: string } => row.phone_verified && typeof row.phone_e164 === "string")
      .map((row) => [row.phone_e164, row.id]),
  );
  // What each membership the payload speaks for *should* end up linked to.
  // Verified after the loop — "credential data synced" and "identity correctly
  // bound" are separate claims (issue #948).
  const expectedLinks = new Map<string, string>();

  for (const credential of credentials) {
    // Not replicated yet (the IAM snapshot creates memberships); next tick.
    if (!linked.has(credential.membershipId)) continue;
    const email =
      typeof credential.email === "string" && credential.email.trim().length > 0
        ? credential.email.trim().toLowerCase()
        : null;
    const phoneE164 =
      typeof credential.phoneE164 === "string" && credential.phoneE164.trim().length > 0
        ? credential.phoneE164.trim()
        : null;
    const phoneVerified = Boolean(phoneE164 && credential.phoneVerified === true);
    const plan = planIdentityBinding({
      platformUserId: credential.platformUserId ?? null,
      linkedPlatformUserId: linked.get(credential.membershipId) ?? null,
      canonicalRowExists: typeof credential.platformUserId === "string"
        && idExists.has(credential.platformUserId.toLowerCase()),
      emailRowId: email ? (byEmail.get(email) ?? null) : null,
      phoneRowId: phoneVerified && phoneE164 ? (byVerifiedPhone.get(phoneE164) ?? null) : null,
    });
    if (plan.platformUserId) expectedLinks.set(credential.membershipId, plan.platformUserId.toLowerCase());
    const mfa = await Promise.all(credential.mfa.map(async (m) => ({
      ...m,
      encrypted: m.totpSecret ? await encryptTotpSecret(m.totpSecret) : null,
    })));
    let skippedConflict = false;
    await withoutTenantScope("identity", async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        // Issue #854: this path rewrites the password door and the membership
        // link, so it takes the same advisory lock the login-path invariant
        // relies on — before reading any state it decides about.
        await lockMembership(client, businessId, credential.membershipId);
        const incomingTokenVersion = credential.tokenVersion ?? 1;
        let platformUserId: string;
        let writeFields = true;
        /** Whether this pass ends up writing the payload's email onto the identity. */
        let emailApplied = false;
        if (plan.rekeyFrom) {
          const old = plan.rekeyFrom;
          const to = plan.platformUserId as string;
          const created = await client.query(
            `INSERT INTO platform_users (id, email, password_hash, full_name, is_active, token_version)
             SELECT $2::uuid, $3::citext,
                    password_hash, full_name, is_active, token_version
               FROM platform_users WHERE id = $1`,
            [old, to, `__rekey__${to}@identity-rekey.invalid`],
          );
          if (created.rowCount !== 1) {
            throw new Error("identity_rekey_source_missing");
          }
          await client.query(`UPDATE users SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE owner_activations SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE install_pairing_codes SET issued_by = $2 WHERE issued_by = $1`, [old, to]);
          await client.query(`UPDATE trusted_devices SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE billing_quotes SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE business_commercial_policies SET enrolled_by = $2 WHERE enrolled_by = $1`, [old, to]);
          await client.query(`UPDATE business_service_terms SET purchased_by = $2 WHERE purchased_by = $1`, [old, to]);
          await client.query(`UPDATE platform_demo_sessions SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE platform_email_verifications SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE platform_onboarding_drafts SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE platform_signup_events SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE platform_signup_requests SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE telegram_identity_links SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          await client.query(`UPDATE telegram_link_challenges SET platform_user_id = $2 WHERE platform_user_id = $1`, [old, to]);
          for (const table of ["mfa_enrolments", "mfa_challenges", "mfa_recovery_codes", "mfa_grace_periods", "auth_password_resets"]) {
            await client.query(
              `UPDATE ${table} SET subject_id = $2 WHERE subject_realm = 'platform_user' AND subject_id = $1`,
              [old, to],
            );
          }
          await client.query(`DELETE FROM platform_users WHERE id = $1`, [old]);
          platformUserId = to;
          result.identitiesRekeyed += 1;
        } else if (plan.insert) {
          const emailClash = email
            ? await client.query<{ id: string }>(
                `SELECT id FROM platform_users WHERE email = $1`,
                [email],
              )
            : { rows: [] as { id: string }[] };
          const phoneClash = phoneVerified && phoneE164
            ? await client.query<{ id: string }>(
                `SELECT id FROM platform_users WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL`,
                [phoneE164],
              )
            : { rows: [] as { id: string }[] };
          if (emailClash.rows.length > 0) result.identityEmailConflicts += 1;
          if (phoneClash.rows.length > 0) result.identityPhoneConflicts += 1;
          const insertEmail = emailClash.rows.length === 0 ? email : null;
          const insertPhone = phoneClash.rows.length === 0 ? phoneE164 : null;
          const insertVerified = Boolean(insertPhone && phoneVerified);
          if (!insertEmail && !insertPhone) {
            // Every reachable channel collides with another identity on this
            // site; leave both untouched and report the conflict for a human.
            skippedConflict = true;
            await client.query("COMMIT");
            return;
          }
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO platform_users (
               id, email, password_hash, full_name, is_active, token_version, phone_e164, phone_verified_at
             )
             VALUES (
               COALESCE($1::uuid, gen_random_uuid()),
               $2,
               $3,
               $4,
               $5,
               $6,
               $7,
               CASE WHEN $8::boolean THEN now() ELSE NULL END
             )
             RETURNING id`,
            [
              plan.platformUserId,
              insertEmail,
              credential.passwordHash,
              credential.fullName,
              credential.isActive,
              incomingTokenVersion,
              insertPhone,
              insertVerified,
            ],
          );
          platformUserId = inserted.rows[0].id;
          writeFields = false;
          emailApplied = emailClash.rows.length === 0;
        } else {
          platformUserId = plan.platformUserId as string;
        }
        if (writeFields) {
          const currentRow = await client.query<{
            email: string | null;
            phone_e164: string | null;
            phone_verified_at: Date | null;
          }>(
            `SELECT email::text AS email, phone_e164, phone_verified_at
               FROM platform_users WHERE id = $1 FOR UPDATE`,
            [platformUserId],
          );
          const existing = currentRow.rows[0];
          const emailClash = email
            ? await client.query<{ id: string }>(
                `SELECT id FROM platform_users WHERE email = $1 AND id <> $2`,
                [email, platformUserId],
              )
            : { rows: [] as { id: string }[] };
          const phoneClash = phoneVerified && phoneE164
            ? await client.query<{ id: string }>(
                `SELECT id FROM platform_users WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL AND id <> $2`,
                [phoneE164, platformUserId],
              )
            : { rows: [] as { id: string }[] };
          if (emailClash.rows.length > 0) result.identityEmailConflicts += 1;
          if (phoneClash.rows.length > 0) result.identityPhoneConflicts += 1;

          const writePhoneField = credential.phoneE164 !== undefined && phoneClash.rows.length === 0;
          const nextPhone = writePhoneField ? phoneE164 : (existing?.phone_e164 ?? null);
          const nextPhoneVerified = writePhoneField
            ? phoneVerified
            : Boolean(existing?.phone_e164 && existing?.phone_verified_at);
          // Never clear `email` to NULL if the row would be left without any
          // reachable channel (`platform_users_credential_channel`).
          const writeEmail =
            emailClash.rows.length === 0 && (email !== null || nextPhone !== null);

          const effectiveEmail = writeEmail ? email : (existing?.email ?? null);
          await client.query(
            `UPDATE platform_users
                SET email = $2,
                    full_name = $3,
                    password_hash = $4,
                    is_active = $5,
                    phone_e164 = $6,
                    phone_verified_at = CASE
                      WHEN $6::text IS NULL OR NOT $7::boolean THEN NULL
                      ELSE COALESCE(phone_verified_at, now())
                    END,
                    token_version = GREATEST(
                      token_version + CASE WHEN password_hash IS DISTINCT FROM $4 THEN 1 ELSE 0 END,
                      $8
                    ),
                    updated_at = now()
              WHERE id = $1`,
            [
              platformUserId,
              effectiveEmail,
              credential.fullName,
              credential.passwordHash,
              credential.isActive,
              nextPhone,
              nextPhoneVerified,
              incomingTokenVersion,
            ],
          );
          emailApplied = writeEmail;
        }
        result.changed = true;
        // Bind (or re-bind) the membership to the identity the cloud named —
        // this is what repairs a wrong link even when every hash matches.
        const relinked = await client.query(
          `UPDATE users SET platform_user_id = $3
            WHERE business_id = $1 AND id = $2 AND platform_user_id IS DISTINCT FROM $3`,
          [businessId, credential.membershipId, platformUserId],
        );
        if (relinked.rowCount) {
          result.bindingsRepaired += relinked.rowCount;
          result.changed = true;
        }
        // Mirror only an accepted identity email. Run after relinking so new
        // memberships are included; per-business unique violations propagate.
        if (emailApplied) {
          await syncMembershipIdentity(client, platformUserId, { email });
        }

        await client.query(
          `DELETE FROM mfa_enrolments WHERE subject_realm = 'platform_user' AND subject_id = $1`,
          [platformUserId],
        );
        let primaryAssigned = false;
        for (const m of mfa) {
          const isPrimary = m.isPrimary && !primaryAssigned;
          if (isPrimary) primaryAssigned = true;
          await client.query(
            `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, totp_secret, confirmed_at)
             VALUES ('platform_user', $1, $2, $3, $4, $5, now())`,
            [platformUserId, m.method, isPrimary, m.phoneE164, m.encrypted],
          );
        }
        // A code already spent here stays spent even if the cloud has not heard yet.
        const spentHere = await client.query<{ code_hash: string; used_at: Date }>(
          `SELECT code_hash, used_at FROM mfa_recovery_codes
            WHERE subject_realm = 'platform_user' AND subject_id = $1 AND used_at IS NOT NULL`,
          [platformUserId],
        );
        const spent = new Map(spentHere.rows.map((row) => [row.code_hash, row.used_at]));
        await client.query(
          `DELETE FROM mfa_recovery_codes WHERE subject_realm = 'platform_user' AND subject_id = $1`,
          [platformUserId],
        );
        for (const code of credential.recoveryCodes) {
          await client.query(
            `INSERT INTO mfa_recovery_codes (subject_realm, subject_id, code_hash, used_at) VALUES ('platform_user', $1, $2, $3)`,
            [platformUserId, code.codeHash, code.usedAt ?? spent.get(code.codeHash) ?? null],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
    if (!skippedConflict) {
      result.identitiesApplied += 1;
    }
  }
  result.changed = result.changed || result.identitiesApplied > 0;
  // Post-pass verification: every membership the payload named must now be
  // linked to exactly the identity it named. What remains broken is the
  // "identity not correctly bound" count — never masked by converged hashes.
  if (expectedLinks.size > 0) {
    const bound = await query<{ id: string; platform_user_id: string | null }>(
      `SELECT id, platform_user_id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [businessId, [...expectedLinks.keys()]],
    );
    for (const row of bound.rows) {
      const expected = expectedLinks.get(row.id);
      const actual = row.platform_user_id?.toLowerCase() ?? null;
      if (expected !== actual) result.bindingsStillBroken += 1;
    }
  }
  return result;
}

const ACTIVE_PIN = `LEFT JOIN LATERAL (
           SELECT secret_hash, created_at FROM employee_credentials
            WHERE employee_id = u.id AND business_id = u.business_id
              AND credential_type = 'pin' AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
         ) ec ON true`;

// Issue #885 L13 — this list used to be redeclared here. It is the same set of
// roles as the login doors', so it is imported from `login-eligibility`
// instead. Note that the *question* is different (whose PIN the cloud is
// authoritative for, versus who may use a PIN door); only the role list is
// shared, so a change to one must not silently change the other.

/**
 * Cloud: the staff PIN roles the cloud knows about (issue #850).
 *
 * Sent next to `pins` so the site can tell "this staff member has no PIN"
 * apart from "this staff member is not the cloud's to speak for". Only the
 * PIN roles are listed; a password-role member's PIN is the desktop's own and
 * is never removed by a credential sync, whatever the cloud reports.
 */
export async function buildStaffPinMemberships(businessId: string): Promise<string[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM users
        WHERE business_id = $1 AND is_active AND membership_status = 'active'
          AND role IN ${STAFF_PIN_ROLES_SQL}
        ORDER BY id`,
      [businessId],
    );
    return rows.map((row) => row.id);
  });
}

/**
 * Cloud: the active quick-login PIN of every active member that has one.
 *
 * `updatedAt` is the moment the PIN was written (the credential row's
 * `created_at`, or the legacy `users` row's `updated_at`). Both replicas send
 * it so a diff can be resolved by "who wrote last" instead of by role — the
 * fix for an owner's setup PIN never matching the cloud's.
 */
export async function buildReplicatedPins(businessId: string): Promise<ReplicatedPin[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ id: string; pin_hash: string; updated_at: Date | null }>(
      `SELECT u.id, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash,
              coalesce(ec.created_at, u.updated_at) AS updated_at
         FROM users u ${ACTIVE_PIN}
        WHERE u.business_id = $1 AND u.is_active
          AND coalesce(ec.secret_hash, u.pin_hash) IS NOT NULL
        ORDER BY u.id`,
      [businessId],
    );
    return rows.map((row) => ({
      membershipId: row.id,
      pinHash: row.pin_hash,
      updatedAt: row.updated_at?.toISOString(),
    }));
  });
}

/**
 * Site: this replica's own PINs, for the push half of the sync.
 *
 * Sent before the cloud's payload is fetched, so the payload that comes back
 * already carries whichever write won. A PIN the site has and the cloud does
 * not is accepted on arrival; a differing one is compared by `updatedAt`.
 */
export async function sitePinSnapshot(businessId: string): Promise<ReplicatedPin[]> {
  // Same query and RLS scope as the cloud's own list; the two replicas hold the
  // same table shape, so a second copy of this SQL would only be able to drift.
  return buildReplicatedPins(businessId);
}

/**
 * Cloud: adopt the site's PIN writes that are newer than the cloud's own.
 *
 * The cloud is the merge point because it is the only replica both sides can
 * reach; a site may be offline for a day while a PIN is rotated on it, so the
 * write has to survive until the next uplink. Equal hashes are skipped, which
 * is what stops the stamp from being refreshed on both sides on every pass.
 */
export async function applySitePins(
  businessId: string,
  pins: readonly ReplicatedPin[],
): Promise<{ applied: number }> {
  if (pins.length === 0) return { applied: 0 };
  return withTenant(businessId, async () => {
    const ids = [...new Set(pins.map((pin) => pin.membershipId))];
    const cloud = await query<{ id: string; role: string; pin_hash: string | null; updated_at: Date | null }>(
      `SELECT u.id, u.role::text AS role, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash,
              coalesce(ec.created_at, u.updated_at) AS updated_at
         FROM users u ${ACTIVE_PIN}
        WHERE u.business_id = $1 AND u.is_active AND u.id = ANY($2::uuid[])`,
      [businessId, ids],
    );
    // The cloud's own state, in the payload's shape, plus the staff list it
    // owns — the same two facts a paired site gets from the GET.
    const cloudPins: ReplicatedPin[] = cloud.rows
      .filter((row): row is typeof row & { pin_hash: string } => row.pin_hash !== null)
      .map((row) => ({
        membershipId: row.id,
        pinHash: row.pin_hash,
        updatedAt: row.updated_at?.toISOString(),
      }));
    const staffIds = cloud.rows
      .filter((row) => (PIN_ROLES as readonly string[]).includes(row.role))
      .map((row) => row.id);
    const accepted = planSitePinAcceptance(pins, cloudPins, staffIds);
    if (accepted.length === 0) return { applied: 0 };

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await lockMemberships(client, businessId, accepted.map((pin) => pin.membershipId));
      for (const pin of accepted) await writeActivePin(client, businessId, pin.membershipId, pin.pinHash);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return { applied: accepted.length };
  });
}

/** One active PIN per member: revoke the old row, insert the new, drop the legacy copy. */
async function writeActivePin(
  client: PoolClient,
  businessId: string,
  membershipId: string,
  pinHash: string,
): Promise<void> {
  await client.query(`INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [membershipId, businessId]);
  await client.query(
    `UPDATE employee_credentials SET status = 'revoked', revoked_at = now()
      WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin' AND status = 'active'`,
    [membershipId, businessId],
  );
  await client.query(
    `INSERT INTO employee_credentials (employee_id, business_id, credential_type, secret_hash) VALUES ($1, $2, 'pin', $3)`,
    [membershipId, businessId, pinHash],
  );
  await client.query(`UPDATE users SET pin_hash = NULL WHERE id = $1 AND business_id = $2 AND pin_hash IS NOT NULL`, [membershipId, businessId]);
}

/**
 * Site: make each replicated member's PIN equal the cloud's — written when the
 * cloud has one (see planPinReplication), removed when the cloud owns staff
 * PINs and says it has none (see planPinRemoval, issue #850).
 *
 * Both decisions are computed against the members this call is told about, so
 * a member the site has not replicated yet is never touched, and a
 * password-role member's device-local PIN is never removed.
 */
export async function applyReplicatedPins(
  businessId: string,
  pins: readonly ReplicatedPin[],
  options: { staffPinMemberships?: readonly string[]; staffPinsAuthoritative?: boolean } = {},
): Promise<{ applied: number; removed: number }> {
  const authoritative = options.staffPinsAuthoritative === true;
  const memberships = options.staffPinMemberships ?? [];
  if (pins.length === 0 && !authoritative) return { applied: 0, removed: 0 };

  // Everything either rule could decide about: the members the payload carries
  // a PIN for, plus (when the cloud is authoritative) the staff memberships it
  // listed, so absence from `pins` can be resolved here in one pass.
  const ids = Array.from(new Set([...pins.map((pin) => pin.membershipId), ...(authoritative ? memberships : [])]));
  if (ids.length === 0) return { applied: 0, removed: 0 };
  const local = await query<{ id: string; role: string; pin_hash: string | null; updated_at: Date | null }>(
    `SELECT u.id, u.role::text AS role, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash,
            coalesce(ec.created_at, u.updated_at) AS updated_at
       FROM users u ${ACTIVE_PIN}
      WHERE u.business_id = $1 AND u.id = ANY($2::uuid[])`,
    [businessId, ids],
  );
  const localStates: LocalPinState[] = local.rows.map((row) => ({
    membershipId: row.id,
    role: row.role,
    pinHash: row.pin_hash,
    pinUpdatedAt: row.updated_at?.toISOString() ?? null,
  }));
  const plan = planPinReplication(pins, localStates);
  const removals = planPinRemoval({ pins, memberships, authoritative }, localStates);
  if (plan.length === 0 && removals.length === 0) return { applied: 0, removed: 0 };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Issue #854: PIN removal is exactly the "credential revoked" side of the
    // login-path invariant. Hold the membership locks (sorted + deduped inside
    // `lockMemberships`) so a concurrent role change or offboarding deciding
    // on these doors waits for this replication, and vice versa.
    await lockMemberships(client, businessId, ids);
    for (const membershipId of removals) {
      // Same effect a suspension/offboarding has: the credential stops being
      // active and the legacy compatibility copy goes with it. The member
      // stays a member — only the PIN the cloud removed disappears.
      await client.query(
        `UPDATE employee_credentials SET status = 'revoked', revoked_at = now()
          WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin' AND status = 'active'`,
        [membershipId, businessId],
      );
      await client.query(
        `UPDATE users SET pin_hash = NULL WHERE id = $1 AND business_id = $2 AND pin_hash IS NOT NULL`,
        [membershipId, businessId],
      );
    }
    for (const pin of plan) {
      await writeActivePin(client, businessId, pin.membershipId, pin.pinHash);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { applied: plan.length, removed: removals.length };
}
