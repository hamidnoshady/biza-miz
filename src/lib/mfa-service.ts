import { query, withoutTenantScope } from "./db";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import {
  enrolmentRequirement,
  isMfaEnrolmentConfirmed,
  selectPrimaryMfaEnrolment,
  sortMfaEnrolments,
  type MfaMethod,
  type MfaRequirement,
  type PrimaryAuthMethod,
} from "./mfa";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "./mfa-recovery";

export interface MfaPendingEmployeeSession {
  userId: string;
  businessId: string;
  locationId: string | null;
  role: string;
  employeeSessionId: string;
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
  return sortMfaEnrolments(
    enrolments.filter(
      (e) => isMfaEnrolmentConfirmed(e) || (e.method === "sms_otp" && e.is_primary === true),
    ),
  );
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
): Promise<{
  confirmed: boolean;
  wasUnconfirmed: boolean;
  isPrimary: boolean;
  recoveryCodes: string[];
}> {
  return withoutTenantScope("platform", async () => {
    const existing = await getAccountMfaEnrolments(subjectRealm, subjectId);
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
      await query(
        `UPDATE mfa_enrolments
            SET is_primary = false
          WHERE subject_realm = $1 AND subject_id = $2 AND method <> $3`,
        [subjectRealm, subjectId, method],
      );
    }

    await query(
      `UPDATE mfa_enrolments
          SET confirmed_at = COALESCE(confirmed_at, now()),
              is_primary = CASE WHEN $4::boolean THEN true ELSE is_primary END
        WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
      [subjectRealm, subjectId, method, shouldBePrimary],
    );

    let recoveryCodes: string[] = [];
    if (wasUnconfirmed) {
      const remaining = await countRemainingRecoveryCodes(subjectRealm, subjectId);
      if (remaining === 0) {
        recoveryCodes = await issueRecoveryCodes(subjectRealm, subjectId);
      }
    }

    return {
      confirmed: true,
      wasUnconfirmed,
      isPrimary: shouldBePrimary || target.is_primary,
      recoveryCodes,
    };
  });
}

/**
 * Explicitly switch the primary MFA method among confirmed enrolments.
 */
export async function setPrimaryMfaEnrolment(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  method: MfaMethod,
): Promise<{ ok: true } | { ok: false; error: "not_enrolled" | "not_confirmed" }> {
  return withoutTenantScope("platform", async () => {
    const enrolments = await getAccountMfaEnrolments(subjectRealm, subjectId);
    const target = enrolments.find((e) => e.method === method);
    if (!target) return { ok: false, error: "not_enrolled" };
    if (!target.confirmed_at) return { ok: false, error: "not_confirmed" };

    await query(
      `UPDATE mfa_enrolments
          SET is_primary = false
        WHERE subject_realm = $1 AND subject_id = $2 AND method <> $3`,
      [subjectRealm, subjectId, method],
    );
    await query(
      `UPDATE mfa_enrolments
          SET is_primary = true
        WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
      [subjectRealm, subjectId, method],
    );
    return { ok: true };
  });
}

/**
 * Remove a specific MFA enrolment from an account.
 *
 * Refuses to remove the last confirmed factor when MFA is mandatory for the
 * caller (`allowRemoveLast = false`), while always permitting removal of an
 * unconfirmed pending enrolment or a secondary confirmed factor.
 */
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

    await query(
      `DELETE FROM mfa_enrolments
        WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
      [subjectRealm, subjectId, method],
    );

    const remainingConfirmed = confirmed.filter((e) => e.method !== method);
    if (remainingConfirmed.length > 0 && !remainingConfirmed.some((e) => e.is_primary)) {
      const nextPrimary = selectPrimaryMfaEnrolment(remainingConfirmed);
      if (nextPrimary) {
        await query(
          `UPDATE mfa_enrolments
              SET is_primary = true
            WHERE subject_realm = $1 AND subject_id = $2 AND method = $3`,
          [subjectRealm, subjectId, nextPrimary.method],
        );
      }
    }

    return { ok: true };
  });
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
