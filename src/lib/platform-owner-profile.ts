/**
 * The owner / manager profile of one business, for the super-admin console
 * (issue #755 §1).
 *
 * Two records describe one person here, and the distinction is load-bearing:
 *
 *   - `users` is the **membership** — business-scoped, carries the role, the
 *     active flag, the branch, and (for PIN-only staff) the credential;
 *   - `platform_users` is the **global identity** — one row per email login,
 *     shared by every business that person belongs to, and the thing an email
 *     change actually moves.
 *
 * A console profile has to show both without conflating them, and an edit has
 * to say which one it touched. Changing the *email* is a global act: it follows
 * the person into their other businesses, so it needs explicit confirmation
 * and it invalidates their sessions everywhere. Changing the *name*, the
 * membership's active flag or the MFA phone is business-scoped.
 *
 * Nothing here ever reads or returns a credential: no `password_hash`, no
 * `totp_secret`, no recovery-code hash or plaintext, no token. What the console
 * may show about security state is *whether* MFA is enrolled, by which method,
 * where the OTP phone is, and how many unused recovery codes remain.
 *
 * Scope is `owner` + `manager`: those are the password-login roles (the
 * `user_role` enum has no "admin"), which is exactly the set that has an
 * identity to show and edit. PIN-only staff are people, but not this profile.
 */
import { getPool, withoutTenantScope } from "./db";
import { lockMembership } from "./membership-lock";
import { formatPersianNumber } from "./digits";
import { normalizePhone } from "./phone";

/** The login-holding roles whose profile this surface owns. */
const PROFILE_ROLES = ["owner", "manager"] as const;

export type OwnerProfileMfaMethod = "sms_otp" | "totp";

export interface OwnerProfileMfa {
  /** null when the identity has never enrolled a second factor. */
  method: OwnerProfileMfaMethod | null;
  /** Where an SMS OTP would go. Present only for an SMS enrolment. */
  phoneE164: string | null;
  /** null means the enrolment exists but was never confirmed — not active yet. */
  confirmedAt: string | null;
  graceUntil: string | null;
  /** Unused recovery codes. The codes themselves are never read. */
  recoveryCodesRemaining: number;
}

export interface OwnerProfile {
  membershipId: string;
  role: string;
  membershipActive: boolean;
  membershipCreatedAt: string;
  /** The membership's own name — what the tenant's screens show. */
  fullName: string;
  /** null for a membership with no email login (never the case for owner/manager). */
  platformUserId: string | null;
  /** The login identity, shared across every business this person belongs to. */
  email: string | null;
  identityActive: boolean;
  identityCreatedAt: string | null;
  lastLoginAt: string | null;
  /** How many businesses this identity belongs to — drives the email-change confirmation. */
  membershipCount: number;
  otherBusinesses: { id: string; name: string }[];
  mfa: OwnerProfileMfa;
  /** `location_id` null is an owner who roams every branch. */
  branchAccess: { locationId: string | null; locationName: string | null };
}

export type OwnerProfileError =
  | "member_not_found"
  | "missing_fields"
  | "invalid_email"
  | "email_taken"
  | "invalid_phone"
  | "cross_business_confirmation_required"
  | "identity_missing"
  | "no_changes";

export interface OwnerProfileUpdate {
  membershipId: string;
  fullName?: string;
  email?: string;
  phone?: string;
  isActive?: boolean;
  /**
   * Required when the email change reaches beyond this business (the identity
   * holds memberships elsewhere). The console asks for it explicitly rather
   * than a caller opting in by accident.
   */
  confirmCrossBusiness?: boolean;
}

export type OwnerProfileUpdateResult =
  | {
      ok: true;
      before: OwnerProfile;
      after: OwnerProfile;
      /** Human notes for the operator: what else the edit changed. */
      notices: string[];
    }
  | { ok: false; error: OwnerProfileError };

interface MemberRow extends Record<string, unknown> {
  membership_id: string;
  role: string;
  full_name: string;
  is_active: boolean;
  created_at: Date;
  location_id: string | null;
  location_name: string | null;
  platform_user_id: string | null;
  email: string | null;
  identity_active: boolean | null;
  last_login_at: Date | null;
  identity_created_at: Date | null;
  membership_count: string;
}

interface MfaRow extends Record<string, unknown> {
  subject_id: string;
  method: OwnerProfileMfaMethod;
  phone_e164: string | null;
  confirmed_at: Date | null;
  grace_until: Date | null;
  recovery_codes_remaining: string;
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Every owner/manager of one business with their profile.
 *
 * Three small reads rather than one join: the MFA and cross-business data hang
 * off the *identity*, not the membership, and joining them into the member
 * query would multiply rows per enrolment.
 */
export async function listBusinessOwnerProfiles(businessId: string): Promise<OwnerProfile[]> {
  return withoutTenantScope("platform", async () => {
    const { rows: members } = await getPool().query<MemberRow>(
      `SELECT u.id AS membership_id, u.role::text AS role, u.full_name, u.is_active,
              u.created_at, u.location_id, l.name AS location_name,
              u.platform_user_id,
              p.email::text AS email, p.is_active AS identity_active,
              p.last_login_at, p.created_at AS identity_created_at,
              (SELECT count(*) FROM users mu WHERE mu.platform_user_id = u.platform_user_id) AS membership_count
         FROM users u
         LEFT JOIN platform_users p ON p.id = u.platform_user_id
         LEFT JOIN locations l ON l.id = u.location_id AND l.business_id = u.business_id
        WHERE u.business_id = $1
          AND u.role::text = ANY($2::text[])
        ORDER BY (u.role = 'owner') DESC, u.created_at`,
      [businessId, [...PROFILE_ROLES]],
    );

    const identityIds = members
      .map((row) => row.platform_user_id)
      .filter((id): id is string => Boolean(id));
    if (identityIds.length === 0) {
      return members.map((row) => toProfile(row, new Map(), new Map()));
    }

    const [{ rows: mfaRows }, { rows: otherRows }] = await Promise.all([
      getPool().query<MfaRow>(
        // `totp_secret` is deliberately not in this projection: the profile
        // reports the method, never the material.
        `SELECT e.subject_id, e.method, e.phone_e164, e.confirmed_at, e.grace_until,
                (SELECT count(*) FROM mfa_recovery_codes c
                  WHERE c.subject_realm = e.subject_realm AND c.subject_id = e.subject_id
                    AND c.used_at IS NULL) AS recovery_codes_remaining
           FROM mfa_enrolments e
          WHERE e.subject_realm = 'platform_user' AND e.subject_id = ANY($1::uuid[])
          ORDER BY e.is_primary DESC, e.created_at`,
        [identityIds],
      ),
      getPool().query<{ platform_user_id: string; id: string; name: string }>(
        `SELECT mu.platform_user_id, b.id, b.name
           FROM users mu JOIN businesses b ON b.id = mu.business_id
          WHERE mu.platform_user_id = ANY($1::uuid[]) AND mu.business_id <> $2`,
        [identityIds, businessId],
      ),
    ]);

    const mfaBySubject = new Map<string, OwnerProfileMfa>();
    for (const row of mfaRows) {
      // Primary first (the ORDER BY), so the first row per subject wins.
      if (mfaBySubject.has(row.subject_id)) continue;
      mfaBySubject.set(row.subject_id, {
        method: row.method,
        phoneE164: row.method === "sms_otp" ? row.phone_e164 : null,
        confirmedAt: iso(row.confirmed_at),
        graceUntil: iso(row.grace_until),
        recoveryCodesRemaining: Number(row.recovery_codes_remaining ?? 0),
      });
    }

    const othersBySubject = new Map<string, { id: string; name: string }[]>();
    for (const row of otherRows) {
      const list = othersBySubject.get(row.platform_user_id) ?? [];
      list.push({ id: row.id, name: row.name });
      othersBySubject.set(row.platform_user_id, list);
    }

    return members.map((row) => toProfile(row, mfaBySubject, othersBySubject));
  });
}

function toProfile(
  row: MemberRow,
  mfa: Map<string, OwnerProfileMfa>,
  others: Map<string, { id: string; name: string }[]>,
): OwnerProfile {
  return {
    membershipId: row.membership_id,
    role: row.role,
    membershipActive: row.is_active,
    membershipCreatedAt: new Date(row.created_at).toISOString(),
    fullName: row.full_name,
    platformUserId: row.platform_user_id,
    email: row.email,
    identityActive: row.identity_active ?? true,
    identityCreatedAt: iso(row.identity_created_at),
    lastLoginAt: iso(row.last_login_at),
    membershipCount: Number(row.membership_count ?? 0),
    otherBusinesses: row.platform_user_id ? (others.get(row.platform_user_id) ?? []) : [],
    mfa: row.platform_user_id
      ? (mfa.get(row.platform_user_id) ?? {
          method: null,
          phoneE164: null,
          confirmedAt: null,
          graceUntil: null,
          recoveryCodesRemaining: 0,
        })
      : { method: null, phoneE164: null, confirmedAt: null, graceUntil: null, recoveryCodesRemaining: 0 },
    branchAccess: {
      locationId: row.location_id,
      locationName: row.location_name,
    },
  };
}

/** Deliberately permissive: the database's citext unique index is the real rule. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Apply a supported profile edit and report what it changed.
 *
 * The caller (the platform route) audits the returned before/after pair; this
 * function never writes an audit row of its own, so there is exactly one place
 * a console edit can be recorded and it is the same place as every other
 * console write.
 */
export async function updateBusinessOwnerProfile(
  businessId: string,
  update: OwnerProfileUpdate,
): Promise<OwnerProfileUpdateResult> {
  if (typeof update.membershipId !== "string" || !update.membershipId) {
    return { ok: false, error: "missing_fields" };
  }

  const before = (await listBusinessOwnerProfiles(businessId)).find(
    (profile) => profile.membershipId === update.membershipId,
  );
  if (!before) return { ok: false, error: "member_not_found" };

  const fullName = update.fullName === undefined ? undefined : update.fullName.trim();
  const email = update.email === undefined ? undefined : update.email.trim().toLowerCase();
  const phone = update.phone === undefined ? undefined : update.phone.trim();

  if (fullName !== undefined && !fullName) return { ok: false, error: "missing_fields" };
  if (email !== undefined && !looksLikeEmail(email)) return { ok: false, error: "invalid_email" };
  if (email !== undefined && !before.platformUserId) return { ok: false, error: "identity_missing" };

  let phoneE164: string | null = null;
  if (phone !== undefined) {
    if (!phone) {
      phoneE164 = null;
    } else {
      const normalized = normalizePhone(phone);
      if (!normalized.valid || !normalized.e164) return { ok: false, error: "invalid_phone" };
      phoneE164 = normalized.e164;
    }
  }

  const emailChanges = email !== undefined && email !== before.email;
  const phoneChanges =
    phone !== undefined && (phoneE164 ?? null) !== (before.mfa.phoneE164 ?? null);

  // Both the email and the SMS second factor live on the *platform user*, not on
  // the membership: one identity has one login and one factor, shared by every
  // business it belongs to. An operator editing this business can therefore
  // redirect or clear the number that protects the same person's *other*
  // businesses, and unprove a factor they had already confirmed. Same guard as
  // the email, for the same reason — and the phone was the gap, because it reads
  // like a per-business contact detail and is not one.
  if (
    (emailChanges || phoneChanges) &&
    before.membershipCount > 1 &&
    update.confirmCrossBusiness !== true
  ) {
    return { ok: false, error: "cross_business_confirmation_required" };
  }

  const changesNothing =
    (fullName === undefined || fullName === before.fullName) &&
    !emailChanges &&
    !phoneChanges &&
    (update.isActive === undefined || update.isActive === before.membershipActive);
  if (changesNothing) return { ok: false, error: "no_changes" };

  const notices: string[] = [];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Issue #854: suspension/reactivation changes the door, so it joins the
    // shared advisory-lock protocol before the rows are read (advisory lock
    // first, row lock second — the order every other path uses).
    await lockMembership(client, businessId, update.membershipId);

    const locked = await client.query<{ id: string; platform_user_id: string | null; is_active: boolean }>(
      `SELECT id, platform_user_id, is_active FROM users
        WHERE id = $1 AND business_id = $2 AND role::text = ANY($3::text[])
        FOR UPDATE`,
      [update.membershipId, businessId, [...PROFILE_ROLES]],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, error: "member_not_found" };
    }

    if (fullName !== undefined && fullName !== before.fullName) {
      await client.query(
        `UPDATE users SET full_name = $2, updated_at = now() WHERE id = $1`,
        [update.membershipId, fullName],
      );
      // The identity's name is the same person's name; leaving it behind makes
      // the login screen and the business switcher disagree with every tenant
      // screen. Kept in step deliberately, and audited as one change.
      if (before.platformUserId) {
        await client.query(`UPDATE platform_users SET full_name = $2, updated_at = now() WHERE id = $1`, [
          before.platformUserId,
          fullName,
        ]);
      }
    }

    if (update.isActive !== undefined && update.isActive !== before.membershipActive) {
      await client.query(`UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1`, [
        update.membershipId,
        update.isActive,
      ]);
      if (!update.isActive) {
        await client.query(
          `UPDATE employee_sessions
              SET revoked_at = now()
            WHERE business_id = $1 AND employee_id = $2 AND revoked_at IS NULL`,
          [businessId, update.membershipId],
        );
        await client.query(
          `UPDATE impersonation_grants
              SET revoked_at = now()
            WHERE business_id = $1 AND user_id = $2 AND ended_at IS NULL AND revoked_at IS NULL`,
          [businessId, update.membershipId],
        );
      }
      notices.push(
        update.isActive
          ? "عضویت دوباره فعال شد؛ فرد می‌تواند وارد شود."
          : "عضویت غیرفعال شد؛ دسترسی این کسب‌وکار بسته می‌شود، اما عضویت‌های دیگر او دست‌نخورده می‌مانند.",
      );
    }

    if (emailChanges && before.platformUserId) {
      try {
        await client.query(
          `UPDATE platform_users
              SET email = $2, token_version = token_version + 1, updated_at = now()
            WHERE id = $1`,
          [before.platformUserId, email],
        );
        await client.query(
          `UPDATE employee_sessions es
              SET revoked_at = now()
             FROM users u
            WHERE es.employee_id = u.id
              AND u.platform_user_id = $1
              AND es.revoked_at IS NULL`,
          [before.platformUserId],
        );
        await client.query(
          `UPDATE impersonation_grants ig
              SET revoked_at = now()
             FROM users u
            WHERE ig.user_id = u.id
              AND u.platform_user_id = $1
              AND ig.ended_at IS NULL
              AND ig.revoked_at IS NULL`,
          [before.platformUserId],
        );
      } catch (err) {
        await client.query("ROLLBACK");
        if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
          return { ok: false, error: "email_taken" };
        }
        throw err;
      }
      notices.push(
        "نشانی ورود تغییر کرد و همهٔ نشست‌های این هویت باطل شدند؛ ورود بعدی با نشانی تازه انجام می‌شود.",
      );
      if (before.membershipCount > 1) {
        notices.push(`این هویت در ${before.membershipCount} کسب‌وکار عضو است؛ ورود هر کدام با نشانی تازه است.`);
      }
    }

    if (phone !== undefined && (phoneE164 ?? null) !== (before.mfa.phoneE164 ?? null)) {
      if (phoneE164 === null) {
        await client.query(
          `UPDATE mfa_enrolments SET phone_e164 = NULL, confirmed_at = NULL
            WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'sms_otp'`,
          [before.platformUserId],
        );
      } else {
        // A changed second factor must be re-confirmed: keeping `confirmed_at`
        // would leave the account protected by a channel the owner never
        // proved control of.
        await client.query(
          `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, phone_e164, is_primary, confirmed_at)
           VALUES ('platform_user', $1, 'sms_otp', $2,
                   NOT EXISTS (SELECT 1 FROM mfa_enrolments
                                WHERE subject_realm = 'platform_user' AND subject_id = $1),
                   NULL)
           ON CONFLICT (subject_realm, subject_id, method)
           DO UPDATE SET phone_e164 = EXCLUDED.phone_e164, confirmed_at = NULL`,
          [before.platformUserId, phoneE164],
        );
      }
      notices.push("شمارهٔ پیامکی تغییر کرد و باید دوباره تأیید شود؛ تا آن زمان ورود دومرحله‌ای کامل نیست.");
      if (before.membershipCount > 1) {
        // Said out loud rather than left for the operator to infer: this number
        // is the second factor for every business this person belongs to.
        notices.push(
          `این شماره ورود دومرحله‌ای همهٔ ${formatPersianNumber(before.membershipCount)} کسب‌وکار این شخص بود و اکنون در همهٔ آن‌ها تغییر کرده است.`,
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const after = (await listBusinessOwnerProfiles(businessId)).find(
    (profile) => profile.membershipId === update.membershipId,
  );
  if (!after) return { ok: false, error: "member_not_found" };
  return { ok: true, before, after, notices };
}
