import { query, withoutTenantScope } from "./db";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { enrolmentRequirement, type MfaRequirement } from "./mfa";

export interface MfaPendingPayload {
  sub: string;
  method: "sms_otp" | "totp" | null;
  authRealm: "tenant_password" | "platform_admin";
  businessId?: string;
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
    const payload = await verifyWithRealmSecret<{ realm?: string; sub?: string; method?: string; authRealm?: string }>(token, "mfa");
    if (!payload || payload.realm !== "mfa") return null;
    return payload as unknown as MfaPendingPayload;
  } catch {
    return null;
  }
}

export async function getAccountMfaEnrolments(subjectRealm: string, subjectId: string) {
  const { rows } = await withoutTenantScope("platform", () => 
    query<{ method: "sms_otp" | "totp"; is_primary: boolean; phone_e164: string | null; confirmed_at: Date | null }>(
      `SELECT method, is_primary, phone_e164, confirmed_at 
       FROM mfa_enrolments 
       WHERE subject_realm = $1 AND subject_id = $2`,
      [subjectRealm, subjectId]
    )
  );
  return rows;
}

export async function getMfaGracePeriod(subjectRealm: string, subjectId: string): Promise<Date | null> {
  const { rows } = await withoutTenantScope("platform", () => 
    query<{ grace_until: Date }>(`SELECT grace_until FROM mfa_grace_periods WHERE subject_realm = $1 AND subject_id = $2`, [subjectRealm, subjectId])
  );
  return rows.length > 0 ? rows[0].grace_until : null;
}

export async function markMfaGracePeriod(subjectRealm: string, subjectId: string, graceDays: number) {
  await withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO mfa_grace_periods (subject_realm, subject_id, grace_until)
       VALUES ($1, $2, now() + interval '1 day' * $3)
       ON CONFLICT (subject_realm, subject_id) DO NOTHING`,
      [subjectRealm, subjectId, graceDays]
    );
  });
}

/**
 * Push one account's grace window out — the super-admin's documented escape
 * valve for the person whose stored mobile is wrong, or who is mid-holiday
 * when the deadline lands.
 *
 * Measured from *now*, not from the existing deadline: "give them another
 * week" is what the operator means, and adding a week to a window that expired
 * last month would grant nothing at all. Deliberately per-account rather than
 * platform-wide, so rescuing one person never quietly disarms the requirement
 * for everyone. The caller writes the audit row; this only moves the date.
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
 *
 * The mechanism behind both the console's "reset a business Owner's 2FA"
 * button and `scripts/reset-platform-mfa.ts`. It is destructive by design: a
 * reset that left the old TOTP secret in place would leave the account still
 * locked out by the device it no longer has.
 */
export async function resetAccountMfa(
  subjectRealm: string,
  subjectId: string,
  graceDays: number,
): Promise<void> {
  await withoutTenantScope("platform", async () => {
    await query(`DELETE FROM mfa_enrolments WHERE subject_realm = $1 AND subject_id = $2`, [
      subjectRealm,
      subjectId,
    ]);
    await query(`DELETE FROM mfa_challenges WHERE subject_realm = $1 AND subject_id = $2`, [
      subjectRealm,
      subjectId,
    ]);
    await query(`DELETE FROM mfa_recovery_codes WHERE subject_realm = $1 AND subject_id = $2`, [
      subjectRealm,
      subjectId,
    ]);
    await query(
      `INSERT INTO mfa_grace_periods (subject_realm, subject_id, grace_until)
       VALUES ($1, $2, now() + interval '1 day' * $3)
       ON CONFLICT (subject_realm, subject_id)
       DO UPDATE SET grace_until = now() + interval '1 day' * $3`,
      [subjectRealm, subjectId, graceDays],
    );
  });
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
    const decipher = createDecipheriv("aes-256-gcm", await getMfaSecretKey(), data.subarray(0, 12));
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
  totpSecretPlain?: Buffer | null
) {
  const totpSecretEncrypted =
    method === "totp" && totpSecretPlain ? await encryptTotpSecret(totpSecretPlain) : null;

  await client.query(
    `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, totp_secret, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (subject_realm, subject_id, method) DO NOTHING`,
    [subjectRealm, subjectId, method, isPrimary, phoneE164 || null, totpSecretEncrypted]
  );
}

export async function getMfaSecretKey(): Promise<Buffer> {
  const envKey = process.env.MFA_SECRET_KEY;
  if (envKey) {
    return Buffer.from(envKey, "hex");
  }
  // No MFA_SECRET_KEY configured — derive a key from the dedicated "mfa"
  // signing realm (the same realm signMfaPendingToken uses) rather than
  // reusing the platform realm's secret for both session signing and
  // TOTP-secret-at-rest encryption.
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

/**
 * Enrolments, grace and unspent recovery codes for a set of subjects, in one
 * round trip per fact rather than one per account.
 *
 * Split out from the identity queries because the three MFA tables are keyed
 * on `(subject_realm, subject_id)` for both realms alike, while "who is an
 * Owner" and "who is a platform admin" are questions of two entirely different
 * tables. Joining them in a single statement means casting one realm's
 * vocabulary into the other's, which is how a security readout ends up quietly
 * wrong.
 */
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
    created_at: Date;
  }>(
    `SELECT subject_id, method, is_primary, created_at
       FROM mfa_enrolments
      WHERE subject_realm = $1 AND subject_id = ANY($2::uuid[])
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

/**
 * Every account the 2FA requirement applies to, and where each one stands —
 * the readout Phase 24 asks `/platform` for: "who is enrolled, who is in grace
 * and how long remains".
 *
 * The tenant side lists identities holding an `owner` membership, plus
 * `manager` memberships in businesses that opted in (settings key `mfa.policy`).
 * Those are exactly the accounts `enrolmentRequirement` will gate, so those are
 * the ones an operator needs to see *before* a deadline arrives rather than
 * after a support call.
 */
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
            OR (u.role = 'manager' AND COALESCE((
                 SELECT (st.value ->> 'requireForManagers')::boolean
                   FROM settings st
                  WHERE st.business_id = b.id
                    AND st.location_id IS NULL
                    AND st.key = 'mfa.policy'
               ), false))
          )
        GROUP BY s.id, s.email, s.full_name
        ORDER BY s.email`,
    );

    const [adminFacts, ownerFacts] = await Promise.all([
      mfaFactsFor("platform_admin", admins.map((a) => a.id)),
      mfaFactsFor("platform_user", owners.map((o) => o.id)),
    ]);

    const blank: MfaFacts = { methods: [], enrolledAt: null, graceUntil: null, recoveryRemaining: 0 };

    return [
      ...admins.map((a) =>
        toStatus(
          "platform_admin",
          { subjectId: a.id, email: a.email, fullName: a.full_name, role: a.role, businesses: [] },
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
