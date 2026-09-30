/**
 * DB half of src/lib/iam/login-credentials.ts. Cloud side builds the payload a
 * paired site may read; site side applies it. Covered by
 * integration/iam-login-credentials.integration.test.ts.
 */
import { getPool, query, withTenant, withoutTenantScope } from "../db";
import { decryptTotpSecret, encryptTotpSecret } from "../mfa-service";
import { getSetting, setSetting } from "../settings";
import { loginCredentialsFingerprint, type ReplicatedLoginCredential } from "./login-credentials";

const FINGERPRINT_KEY = "iam.login_credentials_fingerprint";

/** Cloud: every identity with a membership in this business. RLS limits platform_users to members. */
export async function buildLoginCredentials(businessId: string): Promise<ReplicatedLoginCredential[]> {
  return withTenant(businessId, async () => {
    const people = await query<{
      membership_id: string; platform_user_id: string; email: string; full_name: string;
      password_hash: string; is_active: boolean;
    }>(
      `SELECT u.id AS membership_id, p.id AS platform_user_id, p.email, p.full_name, p.password_hash, p.is_active
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
 * Site: make each member's local identity equal the cloud's. Writes
 * platform_users under the documented "identity" bypass — the same narrow
 * write a password reset makes, reached only through a membership row this
 * business owns. Returns false when nothing changed.
 */
export async function applyLoginCredentials(
  businessId: string,
  credentials: readonly ReplicatedLoginCredential[],
): Promise<boolean> {
  const fingerprint = loginCredentialsFingerprint(credentials);
  if ((await getSetting<{ value: string }>(businessId, FINGERPRINT_KEY))?.value === fingerprint) return false;

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
        if (platformUserId) {
          // A changed password ends the sessions the old one opened.
          await client.query(
            `UPDATE platform_users SET email = $2, full_name = $3, password_hash = $4, is_active = $5,
                    token_version = token_version + CASE WHEN password_hash IS DISTINCT FROM $4 THEN 1 ELSE 0 END,
                    updated_at = now()
              WHERE id = $1`,
            [platformUserId, email, credential.fullName, credential.passwordHash, credential.isActive],
          );
        } else {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO platform_users (email, password_hash, full_name, is_active) VALUES ($1, $2, $3, $4) RETURNING id`,
            [email, credential.passwordHash, credential.fullName, credential.isActive],
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
        for (const m of mfa) {
          await client.query(
            `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, totp_secret, confirmed_at)
             VALUES ('platform_user', $1, $2, $3, $4, $5, now())`,
            [platformUserId, m.method, m.isPrimary, m.phoneE164, m.encrypted],
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
  // Only remember a fully-applied set; a membership still missing retries next tick.
  if (credentials.every((c) => linked.has(c.membershipId))) {
    await setSetting(businessId, FINGERPRINT_KEY, { value: fingerprint });
  }
  return true;
}
