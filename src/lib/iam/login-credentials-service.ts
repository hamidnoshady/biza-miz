/**
 * DB half of src/lib/iam/login-credentials.ts. Cloud side builds the payload a
 * paired site may read; site side applies it. Covered by
 * integration/iam-login-credentials.integration.test.ts.
 */
import { getPool, query, withTenant, withoutTenantScope } from "../db";
import { decryptTotpSecret, encryptTotpSecret } from "../mfa-service";
import {
  loginCredentialsFingerprint,
  planPinRemoval,
  planPinReplication,
  type LocalPinState,
  type ReplicatedLoginCredential,
  type ReplicatedPin,
  type SpentRecoveryCode,
} from "./login-credentials";

/** Cloud: every identity with a membership in this business. RLS limits platform_users to members. */
export async function buildLoginCredentials(businessId: string): Promise<ReplicatedLoginCredential[]> {
  return withTenant(businessId, async () => {
    const people = await query<{
      membership_id: string; platform_user_id: string; email: string; full_name: string;
      password_hash: string; is_active: boolean; token_version: number;
    }>(
      `SELECT u.id AS membership_id, p.id AS platform_user_id, p.email, p.full_name,
              p.password_hash, p.is_active, p.token_version
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
        email: person.email,
        fullName: person.full_name,
        passwordHash: person.password_hash,
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

/**
 * Site: make each member's local identity equal the cloud's. Writes
 * platform_users under the documented "identity" bypass — the same narrow
 * write a password reset makes, reached only through a membership row this
 * business owns. Compared against the site's *current* rows, so a local
 * change (a reset, a direct edit) is put back rather than silently diverging.
 * Returns false when the two already agree.
 */
export async function applyLoginCredentials(
  businessId: string,
  credentials: readonly ReplicatedLoginCredential[],
): Promise<boolean> {
  const wanted = new Set(credentials.map((c) => c.membershipId));
  const local = (await buildLoginCredentials(businessId)).filter((c) => wanted.has(c.membershipId));
  if (loginCredentialsFingerprint(local) === loginCredentialsFingerprint(credentials)) return false;

  const members = await query<{ id: string; platform_user_id: string | null }>(
    `SELECT id, platform_user_id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, credentials.map((c) => c.membershipId)],
  );
  const linked = new Map(members.rows.map((row) => [row.id, row.platform_user_id]));

  for (const credential of credentials) {
    // Not replicated yet (the IAM snapshot creates memberships); next tick.
    if (!linked.has(credential.membershipId)) continue;
    const mfa = await Promise.all(credential.mfa.map(async (m) => ({
      ...m,
      encrypted: m.totpSecret ? await encryptTotpSecret(m.totpSecret) : null,
    })));
    await withoutTenantScope("identity", async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const email = credential.email.trim().toLowerCase();
        const existing = await client.query<{ id: string; password_hash: string }>(
          `SELECT id, password_hash FROM platform_users WHERE id = $1 OR email = $2
            ORDER BY (id = $1) DESC LIMIT 1`,
          [linked.get(credential.membershipId) ?? "00000000-0000-0000-0000-000000000000", email],
        );
        let platformUserId = existing.rows[0]?.id;
        const incomingTokenVersion = credential.tokenVersion ?? 1;
        if (platformUserId) {
          // A changed password or bumped cloud token_version ends the sessions the old one opened.
          await client.query(
            `UPDATE platform_users SET email = $2, full_name = $3, password_hash = $4, is_active = $5,
                    token_version = GREATEST(
                      token_version + CASE WHEN password_hash IS DISTINCT FROM $4 THEN 1 ELSE 0 END,
                      $6
                    ),
                    updated_at = now()
              WHERE id = $1`,
            [platformUserId, email, credential.fullName, credential.passwordHash, credential.isActive, incomingTokenVersion],
          );
        } else {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO platform_users (email, password_hash, full_name, is_active, token_version)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [email, credential.passwordHash, credential.fullName, credential.isActive, incomingTokenVersion],
          );
          platformUserId = inserted.rows[0].id;
        }
        await client.query(
          `UPDATE users SET platform_user_id = $3 WHERE business_id = $1 AND id = $2`,
          [businessId, credential.membershipId, platformUserId],
        );

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
  }
  return true;
}

const ACTIVE_PIN = `LEFT JOIN LATERAL (
           SELECT secret_hash FROM employee_credentials
            WHERE employee_id = u.id AND business_id = u.business_id
              AND credential_type = 'pin' AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
         ) ec ON true`;

/** Roles whose PIN the cloud owns; the site never writes one for them. */
const STAFF_PIN_ROLES_SQL = `('cashier','waiter','kitchen')`;

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

/** Cloud: the active quick-login PIN of every active member that has one. */
export async function buildReplicatedPins(businessId: string): Promise<ReplicatedPin[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ id: string; pin_hash: string }>(
      `SELECT u.id, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash
         FROM users u ${ACTIVE_PIN}
        WHERE u.business_id = $1 AND u.is_active
          AND coalesce(ec.secret_hash, u.pin_hash) IS NOT NULL
        ORDER BY u.id`,
      [businessId],
    );
    return rows.map((row) => ({ membershipId: row.id, pinHash: row.pin_hash }));
  });
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
  const local = await query<{ id: string; role: string; pin_hash: string | null }>(
    `SELECT u.id, u.role::text AS role, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash
       FROM users u ${ACTIVE_PIN}
      WHERE u.business_id = $1 AND u.id = ANY($2::uuid[])`,
    [businessId, ids],
  );
  const localStates: LocalPinState[] = local.rows.map((row) => ({ membershipId: row.id, role: row.role, pinHash: row.pin_hash }));
  const plan = planPinReplication(pins, localStates);
  const removals = planPinRemoval({ pins, memberships, authoritative }, localStates);
  if (plan.length === 0 && removals.length === 0) return { applied: 0, removed: 0 };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
      await client.query(`INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [pin.membershipId, businessId]);
      await client.query(
        `UPDATE employee_credentials SET status = 'revoked', revoked_at = now()
          WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin' AND status = 'active'`,
        [pin.membershipId, businessId],
      );
      await client.query(
        `INSERT INTO employee_credentials (employee_id, business_id, credential_type, secret_hash) VALUES ($1, $2, 'pin', $3)`,
        [pin.membershipId, businessId, pin.pinHash],
      );
      await client.query(`UPDATE users SET pin_hash = NULL WHERE id = $1 AND business_id = $2 AND pin_hash IS NOT NULL`, [pin.membershipId, businessId]);
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
