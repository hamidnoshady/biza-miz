import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool, query, withoutTenantScope, withoutTenantScopeTransaction } from "./db";
import { clearAuthLockout, identityKeyFor } from "./login-lockout-service";
import {
  SECURITY_AUDIT_ACTIONS,
  recordSecurityAudit,
} from "./security-audit";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

export type PasswordSubjectRealm = "platform_user" | "platform_admin";

export type PasswordStrengthError =
  | "password_too_short"
  | "password_too_long"
  | "password_unchanged"
  | "password_blank"
  | "password_confirmation_mismatch"
  | "missing_current_password"
  | "missing_fields";

export type PasswordStrengthResult =
  | { ok: true }
  | { ok: false; error: PasswordStrengthError };

/**
 * The one password-change validator, server-side.
 *
 * Issue #854 (P2.15 / P2.16 / P2.17): the browser was doing work the server
 * must not trust, and the two sides disagreed about the vocabulary.
 *
 *  - **`confirmPassword` is verified here.** The Profile form sent it and the
 *    API ignored it, so a mismatch was a browser-only rule — which means any
 *    non-browser client (a script, an old bundle, a crafted request) could set
 *    a password the user did not mean to type. Credential invariants do not
 *    live in the DOM.
 *  - **Whitespace-only is rejected.** An eight-space password passed the length
 *    check, and the UI even shipped a `password_blank` message the backend
 *    could never emit. It can now.
 *  - **One error vocabulary.** `PasswordStrengthError` is the union the routes
 *    return and `src/lib/auth-error-messages.ts` translates, so
 *    `missing_fields`/`password_blank`/`password_confirmation_mismatch` mean
 *    the same thing wherever they surface.
 *
 * Note the deliberate asymmetry in the length rule: the *floor* counts the
 * password's own characters, while the *blank* test uses `trim()`. A password
 * of "  abcdefgh  " is accepted at its typed length (spaces are legitimate
 * entropy and stripping them would silently change the credential), but a
 * password that is *only* whitespace is not a password.
 */
export function validatePasswordStrength(
  newPassword: string,
  currentPassword?: string,
  confirmPassword?: string,
): PasswordStrengthResult {
  if (typeof newPassword !== "string") {
    return { ok: false, error: "password_too_short" };
  }
  if (newPassword.length === 0) return { ok: false, error: "password_too_short" };
  if (newPassword.trim().length === 0) return { ok: false, error: "password_blank" };
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: "password_too_short" };
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: "password_too_long" };
  }
  // Only enforced when the caller sent one. `undefined` means "this surface has
  // no confirmation field"; `""` means the user left it empty, which is a
  // mismatch rather than an absent rule.
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return { ok: false, error: "password_confirmation_mismatch" };
  }
  if (currentPassword !== undefined && newPassword === currentPassword) {
    return { ok: false, error: "password_unchanged" };
  }
  return { ok: true };
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function generatePasswordResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashPasswordResetToken(token) };
}

/**
 * Revoke employee_sessions and active support impersonations for a global
 * `platform_user` identity (optionally preserving the caller's current
 * `employee_sessions.id`), and optionally bump `platform_users.token_version`.
 */
export async function revokePlatformUserSessions(
  platformUserId: string,
  options: {
    bumpTokenVersion?: boolean;
    keepEmployeeSessionId?: string | null;
    endImpersonation?: boolean;
  } = {},
): Promise<{ tokenVersion: number | null; revokedEmployeeSessions: number }> {
  return withoutTenantScope("identity", async () => {
    let tokenVersion: number | null = null;
    if (options.bumpTokenVersion) {
      const { rows } = await query<{ token_version: number }>(
        `UPDATE platform_users
            SET token_version = token_version + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING token_version`,
        [platformUserId],
      );
      tokenVersion = rows[0]?.token_version ?? null;
    }

    const keepId = options.keepEmployeeSessionId ?? null;
    const { rowCount } = await query(
      `UPDATE employee_sessions es
          SET revoked_at = now()
         FROM users u
        WHERE es.employee_id = u.id
          AND u.platform_user_id = $1
          AND es.revoked_at IS NULL
          AND ($2::uuid IS NULL OR es.id <> $2::uuid)`,
      [platformUserId, keepId],
    );

    if (options.endImpersonation !== false) {
      await query(
        `UPDATE impersonation_grants ig
            SET revoked_at = now()
           FROM users u
          WHERE ig.user_id = u.id
            AND u.platform_user_id = $1
            AND ig.ended_at IS NULL
            AND ig.revoked_at IS NULL`,
        [platformUserId],
      );
    }

    return {
      tokenVersion,
      revokedEmployeeSessions: rowCount ?? 0,
    };
  });
}

/**
 * Revoke all employee_sessions and active support impersonations for a single
 * tenant membership (`users.id`).
 */
export async function revokeMembershipSessions(
  businessId: string,
  userId: string,
  options: { keepEmployeeSessionId?: string | null; endImpersonation?: boolean } = {},
): Promise<number> {
  return withoutTenantScope("identity", async () => {
    const keepId = options.keepEmployeeSessionId ?? null;
    const { rowCount } = await query(
      `UPDATE employee_sessions
          SET revoked_at = now()
        WHERE business_id = $1
          AND employee_id = $2
          AND revoked_at IS NULL
          AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [businessId, userId, keepId],
    );

    if (options.endImpersonation !== false) {
      await query(
        `UPDATE impersonation_grants
            SET revoked_at = now()
          WHERE business_id = $1
            AND user_id = $2
            AND ended_at IS NULL
            AND revoked_at IS NULL`,
        [businessId, userId],
      );
    }

    return rowCount ?? 0;
  });
}

/**
 * Self-service password change for either `platform_user` or `platform_admin`.
 *
 * Verifies `currentPassword`, validates `newPassword` strength, atomically
 * increments `token_version = token_version + 1`, and revokes other active
 * sessions so stolen or stale sessions are immediately invalidated (Issue #809
 * — Findings 3 & 5).
 *
 * ## One commit (#854 follow-up F04)
 *
 * The new hash, the token-version bump, the session revocations and the
 * lockout reset used to be separate autocommits, and the tenant route wrote its
 * audit row and signed the refreshed cookie only *after* all of them — so an
 * audit failure left the password changed and every other session revoked
 * while the caller got a 500 and kept a cookie the bumped token version had
 * already invalidated. Now:
 *
 *  - the slow, read-only part (load the row, bcrypt-verify the current
 *    password, hash the new one) runs before any transaction, so no row lock or
 *    pinned connection is held across bcrypt;
 *  - every write runs in one transaction, and the hash is swapped only if it is
 *    still the one that was just verified — a concurrent change answers
 *    `invalid_current_password` instead of being silently overwritten;
 *  - `beforeCommit` runs inside that transaction, after the writes, so a caller
 *    can make its audit row and its refreshed session part of the same unit:
 *    if the hook throws, the password change rolls back with it.
 */
export async function changeOwnPassword(params: {
  subjectRealm: PasswordSubjectRealm;
  subjectId: string;
  currentPassword: string;
  newPassword: string;
  /**
   * #1386 — the identifier the password door counts lockout under. Defaults to
   * the identity's email, then its verified phone for a phone-only identity.
   */
  lockoutKey?: string | null;
  keepEmployeeSessionId?: string | null;
  keepAdminSessionId?: string | null;
  /**
   * Runs inside the change's transaction (ambient `query()` is pinned to it),
   * after every write and before COMMIT. Throwing rolls the whole change back.
   */
  beforeCommit?: (outcome: { tokenVersion: number; revokedSessions: number }) => Promise<void>;
}): Promise<
  | { ok: true; tokenVersion: number }
  | {
      ok: false;
      error:
        | "invalid_current_password"
        | "not_found"
        /** Everything the shared strength validator can refuse (#854 P2.15). */
        | PasswordStrengthError;
    }
> {
  const strength = validatePasswordStrength(params.newPassword, params.currentPassword);
  if (!strength.ok) return strength;

  return withoutTenantScope("identity", async () => {
    const table = params.subjectRealm === "platform_user" ? "platform_users" : "platform_admins";
    const { rows } = await query<{
      email: string | null;
      phone_e164: string | null;
      password_hash: string | null;
    }>(
      `SELECT email::text AS email,
              ${params.subjectRealm === "platform_user" ? "phone_e164" : "NULL::text AS phone_e164"},
              password_hash
         FROM ${table}
        WHERE id = $1 AND is_active = true`,
      [params.subjectId],
    );
    const subject = rows[0];
    if (!subject) return { ok: false as const, error: "not_found" as const };
    // An identity without a password (never set, or cleared) has no current
    // password to prove; bcrypt would throw on the null hash.
    if (!subject.password_hash) {
      return { ok: false as const, error: "invalid_current_password" as const };
    }

    const valid = await bcrypt.compare(params.currentPassword, subject.password_hash);
    if (!valid) return { ok: false as const, error: "invalid_current_password" as const };

    const verifiedHash = subject.password_hash;
    const nextHash = await bcrypt.hash(params.newPassword, BCRYPT_COST);

    return withoutTenantScopeTransaction("identity", async () => {
      const { rows: updated } = await query<{ token_version: number }>(
        `UPDATE ${table}
            SET password_hash = $2,
                token_version = token_version + 1,
                updated_at = now()
          WHERE id = $1 AND is_active = true AND password_hash = $3
          RETURNING token_version`,
        [params.subjectId, nextHash, verifiedHash],
      );
      // The hash moved between the verify and this write: the password the
      // caller proved is no longer the current one.
      if (!updated[0]) return { ok: false as const, error: "invalid_current_password" as const };
      const tokenVersion = updated[0].token_version;

      let revokedSessions = 0;
      if (params.subjectRealm === "platform_user") {
        const revoked = await revokePlatformUserSessions(params.subjectId, {
          bumpTokenVersion: false,
          keepEmployeeSessionId: params.keepEmployeeSessionId ?? null,
          endImpersonation: true,
        });
        revokedSessions = revoked.revokedEmployeeSessions;
        const lockoutKey = params.lockoutKey ?? subject.email ?? subject.phone_e164;
        if (lockoutKey) await clearAuthLockout("tenant_password", lockoutKey);
        // Issue #885 — a changed password takes back every trusted device, in
        // this transaction, exactly as a reset does. The trust was earned by a
        // login that proved the old password, so the member's own change is
        // the moment to re-establish it (the device they are on now included,
        // by ticking the box again at their next second-factor step).
        await query(
          `UPDATE trusted_devices
              SET revoked_at = now(), revoked_reason = 'password_changed'
            WHERE platform_user_id = $1 AND revoked_at IS NULL`,
          [params.subjectId],
        );
      } else {
        const { rowCount } = await query(
          `UPDATE auth_admin_sessions
              SET revoked_at = now()
            WHERE admin_id = $1
              AND revoked_at IS NULL
              AND ($2::uuid IS NULL OR id <> $2::uuid)`,
          [params.subjectId, params.keepAdminSessionId ?? null],
        );
        revokedSessions = rowCount ?? 0;

        if (params.keepAdminSessionId) {
          await query(
            `UPDATE auth_admin_sessions
                SET token_version = $2
              WHERE id = $1 AND admin_id = $3`,
            [params.keepAdminSessionId, tokenVersion, params.subjectId],
          );
        }

        if (subject.email) await clearAuthLockout("platform_admin", subject.email);
      }

      if (params.beforeCommit) await params.beforeCommit({ tokenVersion, revokedSessions });

      return { ok: true as const, tokenVersion };
    });
  });
}

/**
 * Issue a single-use, time-bounded user-controlled password reset / recovery
 * token (Issue #809 — Findings 2 & 6).
 *
 * Replaces any previously unspent token for the same `(subjectRealm, subjectId)`
 * so at most one active link exists per account at any time.
 */
export async function issuePasswordResetToken(params: {
  subjectRealm: PasswordSubjectRealm;
  subjectId: string;
  /** NULL for a phone-only identity: the link travels by SMS. */
  email: string | null;
  /** The canonical verified phone the link is delivered to. */
  phoneE164?: string | null;
  membershipId?: string | null;
  createdById?: string | null;
  ttlMs?: number;
}): Promise<{ id: string; token: string; expiresAt: Date }> {
  const { token, tokenHash } = generatePasswordResetToken();
  const expiresAt = new Date(Date.now() + (params.ttlMs ?? PASSWORD_RESET_TTL_MS));

  return withoutTenantScope("identity", async () => {
    await query(
      `UPDATE auth_password_resets
          SET revoked_at = now()
        WHERE subject_realm = $1
          AND subject_id = $2
          AND used_at IS NULL
          AND revoked_at IS NULL`,
      [params.subjectRealm, params.subjectId],
    );

    const { rows } = await query<{ id: string }>(
      `INSERT INTO auth_password_resets
         (subject_realm, subject_id, membership_id, email, phone_e164,
          token_hash, expires_at, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        params.subjectRealm,
        params.subjectId,
        params.membershipId ?? null,
        params.email ? params.email.trim().toLowerCase() : null,
        params.phoneE164 ?? null,
        tokenHash,
        expiresAt,
        params.createdById ?? null,
      ],
    );

    return { id: rows[0].id, token, expiresAt };
  });
}

export interface PasswordResetPreview {
  id: string;
  subjectRealm: PasswordSubjectRealm;
  subjectId: string;
  /** NULL when the identity is phone-only (#1386). */
  email: string | null;
  /** Masked delivery number, for a phone-only identity's preview. */
  phoneMasked: string | null;
  expiresAt: string;
  status: "pending" | "expired" | "used" | "revoked";
}

/** `+989***0001`-shaped; never the full number on a pre-session screen. */
function maskRecipientPhone(e164: string | null): string | null {
  if (!e164) return null;
  return e164.length > 8 ? `+${e164.slice(1, 4)}***${e164.slice(-4)}` : "***";
}

export async function previewPasswordResetToken(
  token: string,
): Promise<PasswordResetPreview | null> {
  if (!token || typeof token !== "string") return null;
  const tokenHash = hashPasswordResetToken(token);

  return withoutTenantScope("identity", async () => {
    const { rows } = await query<{
      id: string;
      subject_realm: PasswordSubjectRealm;
      subject_id: string;
      email: string | null;
      phone_e164: string | null;
      expires_at: Date;
      used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, subject_realm, subject_id, email::text AS email, phone_e164,
              expires_at, used_at, revoked_at
         FROM auth_password_resets
        WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;

    let status: PasswordResetPreview["status"] = "pending";
    if (row.used_at) status = "used";
    else if (row.revoked_at) status = "revoked";
    else if (new Date(row.expires_at).getTime() <= Date.now()) status = "expired";

    return {
      id: row.id,
      subjectRealm: row.subject_realm,
      subjectId: row.subject_id,
      email: row.email,
      phoneMasked: maskRecipientPhone(row.phone_e164),
      expiresAt: new Date(row.expires_at).toISOString(),
      status,
    };
  });
}

/**
 * Redeem a single-use password reset token: the account holder chooses their
 * own password, `token_version` increments atomically, and all existing
 * sessions for that identity are revoked.
 */
/** The row shape every reset lookup produces. */
interface PasswordResetRow {
  id: string;
  subject_realm: PasswordSubjectRealm;
  subject_id: string;
  email: string | null;
  phone_e164: string | null;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

const RESET_ROW_SELECT = `SELECT id, subject_realm, subject_id, email::text AS email, phone_e164,
        expires_at, used_at, revoked_at`;

/**
 * Apply a verified reset to its subject, inside the caller's transaction.
 *
 * One implementation, used by both the token path and the SMS-code path, so the
 * two cannot drift on the parts that matter: `token_version` increments
 * atomically with the password write, every session for the identity is
 * revoked, and the reset row is burned. A second reset path that forgot the
 * session revocation would be a silent "changed my password, attacker still
 * logged in" bug.
 */
async function applyPasswordResetRow(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  row: PasswordResetRow,
  passwordHash: string,
): Promise<{
  subjectRealm: PasswordSubjectRealm;
  subjectId: string;
  email: string | null;
  phoneE164: string | null;
  tokenVersion: number;
}> {
  let tokenVersion = 1;
  if (row.subject_realm === "platform_user") {
    const updated = (await client.query(
      `UPDATE platform_users
          SET password_hash = $2,
              token_version = token_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING token_version`,
      [row.subject_id, passwordHash],
    )) as { rows: { token_version: number }[] };
    tokenVersion = updated.rows[0]?.token_version ?? 2;

    await client.query(
      `UPDATE employee_sessions es
          SET revoked_at = now()
         FROM users u
        WHERE es.employee_id = u.id
          AND u.platform_user_id = $1
          AND es.revoked_at IS NULL`,
      [row.subject_id],
    );
    await client.query(
      `UPDATE impersonation_grants ig
          SET revoked_at = now()
         FROM users u
        WHERE ig.user_id = u.id
          AND u.platform_user_id = $1
          AND ig.ended_at IS NULL
          AND ig.revoked_at IS NULL`,
      [row.subject_id],
    );

    // Issue #885 — a password reset invalidates the seven-day device trust, in
    // the same transaction as the credential change and the session
    // revocations above.
    //
    // The reasoning is the one that already revokes every session here: device
    // trust is a convenience *earned by a verification that included this
    // password*. Once the password is gone, nothing about the ceremony that
    // earned the trust is still true, and leaving the row live would let
    // whoever holds the device cookie keep skipping OTP and MFA on a
    // credential they never proved. Being inside the transaction matters — a
    // reset that commits while trust survives is exactly the half-applied
    // state the other revocations exist to avoid.
    await client.query(
      `UPDATE trusted_devices
          SET revoked_at = now(), revoked_reason = 'password_reset'
        WHERE platform_user_id = $1 AND revoked_at IS NULL`,
      [row.subject_id],
    );
  } else {
    const updated = (await client.query(
      `UPDATE platform_admins
          SET password_hash = $2,
              token_version = token_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING token_version`,
      [row.subject_id, passwordHash],
    )) as { rows: { token_version: number }[] };
    tokenVersion = updated.rows[0]?.token_version ?? 2;

    await client.query(
      `UPDATE auth_admin_sessions
          SET revoked_at = now()
        WHERE admin_id = $1 AND revoked_at IS NULL`,
      [row.subject_id],
    );
  }

  await client.query(`UPDATE auth_password_resets SET used_at = now() WHERE id = $1`, [row.id]);

  return {
    subjectRealm: row.subject_realm,
    subjectId: row.subject_id,
    email: row.email,
    phoneE164: row.phone_e164,
    tokenVersion,
  };
}

/**
 * #1386 — replace a password after the caller proved control of the verified
 * phone with a purpose-bound `password_recovery` OTP.
 *
 * This is the phone-native counterpart of the token reset above and keeps the
 * same invariants, in one transaction:
 *
 *  - the new bcrypt hash is written and `token_version` increments together;
 *  - every active `employee_sessions` row for the identity is revoked;
 *  - active support impersonations end;
 *  - trusted devices earned under the old password are revoked;
 *  - the password lockout for the identifier the password door uses is cleared;
 *  - the security audit row commits with the change or not at all.
 *
 * It intentionally does **not** create a session. Recovering a password proves
 * the phone, but the member still signs in afterwards like everyone else.
 */
export async function replacePlatformUserPassword(params: {
  platformUserId: string;
  newPassword: string;
  /** The identifier the password door counts lockout under (email, else phone). */
  lockoutKey: string;
  auditAction: string;
  auditPayload?: Record<string, unknown>;
  /** Keep the caller's current session row (a self-service change from this browser). */
  keepEmployeeSessionId?: string | null;
  /**
   * A first-password creation: fail closed if another writer set a password
   * between the route's read and this UPDATE. Never overwrite an existing
   * credential without proving it.
   */
  requirePasswordless?: boolean;
}): Promise<
  | { ok: true; tokenVersion: number; revokedSessions: number }
  | { ok: false; error: "password_strength"; detail: PasswordStrengthError }
  | { ok: false; error: "not_found" }
> {
  const strength = validatePasswordStrength(params.newPassword);
  if (!strength.ok) {
    return { ok: false, error: "password_strength", detail: strength.error };
  }

  const passwordHash = await bcrypt.hash(params.newPassword, BCRYPT_COST);
  const lockoutIdentityKey = await identityKeyFor(params.lockoutKey);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // These tables are global by design; the reviewed bypass is set on the
    // transaction's own connection rather than assumed from ambient scope.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const { rows } = await client.query<{ token_version: number }>(
      `UPDATE platform_users
          SET password_hash = $2,
              token_version = token_version + 1,
              updated_at = now()
        WHERE id = $1 AND is_active = true
          AND ($3::boolean IS NOT TRUE OR password_hash IS NULL)
        RETURNING token_version`,
      [params.platformUserId, passwordHash, params.requirePasswordless === true],
    );
    const updated = rows[0];
    if (!updated) {
      await client.query("ROLLBACK");
      return { ok: false, error: "not_found" };
    }

    const { rowCount } = await client.query(
      `UPDATE employee_sessions es
          SET revoked_at = now()
         FROM users u
        WHERE es.employee_id = u.id
          AND u.platform_user_id = $1
          AND es.revoked_at IS NULL
          AND ($2::uuid IS NULL OR es.id <> $2::uuid)`,
      [params.platformUserId, params.keepEmployeeSessionId ?? null],
    );

    await client.query(
      `UPDATE impersonation_grants ig
          SET revoked_at = now()
         FROM users u
        WHERE ig.user_id = u.id
          AND u.platform_user_id = $1
          AND ig.ended_at IS NULL
          AND ig.revoked_at IS NULL`,
      [params.platformUserId],
    );

    await client.query(
      `UPDATE trusted_devices
          SET revoked_at = now(), revoked_reason = 'password_reset'
        WHERE platform_user_id = $1 AND revoked_at IS NULL`,
      [params.platformUserId],
    );

    // Same key the password door counts failures under, in the same
    // transaction as the credential change.
    await client.query(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
       VALUES ('tenant_password', $1, 'unlocked')`,
      [lockoutIdentityKey],
    );

    await recordSecurityAudit(
      {
        realm: "platform",
        action: params.auditAction,
        entity: "platform_user",
        entityId: params.platformUserId,
        payload: {
          tokenVersion: updated.token_version,
          // `revokedSessions` is a count, not a credential.
          revokedSessions: rowCount ?? 0,
          // `platform_audit_log.platform_admin_id` has an FK to platform_admins,
          // and this actor is a tenant identity, so the id travels in the
          // payload/entity instead of that column.
          platformUserId: params.platformUserId,
          ...(params.auditPayload ?? {}),
        },
      },
      { query: (text, values) => client.query(text, values) },
    );

    await client.query("COMMIT");
    return {
      ok: true,
      tokenVersion: updated.token_version,
      revokedSessions: rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * #1386 — recovery after a purpose-bound `password_recovery` OTP.
 *
 * A thin, named wrapper around the atomic replacement above so the audit action
 * and the "this was recovery" fact cannot drift between callers.
 */
export async function resetPasswordForVerifiedPhone(params: {
  platformUserId: string;
  newPassword: string;
  lockoutKey: string;
}): ReturnType<typeof replacePlatformUserPassword> {
  return replacePlatformUserPassword({
    ...params,
    auditAction: SECURITY_AUDIT_ACTIONS.passwordRecoveredByPhone,
    auditPayload: { method: "phone_otp", recovery: true },
  });
}

/**
 * #1386 — a passwordless identity creating its first password.
 *
 * There is no current password to prove; the caller must already hold a
 * recent-auth session (the route enforces `requireRecentAuth`). Everything else
 * — version bump, session revocation, trust revocation, lockout clear and the
 * audit row — is the same unit as a change or a reset.
 */
export async function setInitialPasswordForPlatformUser(params: {
  platformUserId: string;
  newPassword: string;
  lockoutKey: string;
  keepEmployeeSessionId?: string | null;
}): ReturnType<typeof replacePlatformUserPassword> {
  return replacePlatformUserPassword({
    ...params,
    auditAction: SECURITY_AUDIT_ACTIONS.passwordCreatedSelf,
    // "firstSet", not "firstPassword": the audit payload refuses key names
    // that look like a credential (security-audit's secret-free rule).
    auditPayload: { firstSet: true },
    // Race-safe: another request may have set a password between the route's
    // read and this write. Refuse rather than overwrite without proof.
    requirePasswordless: true,
  });
}

/**
 * Redeem a single-use password reset token: the account holder chooses their
 * own password, `token_version` increments atomically, and all existing
 * sessions for that identity are revoked.
 */
export async function consumePasswordResetToken(params: {
  token: string;
  newPassword: string;
  confirmPassword?: string;
}): Promise<
  | {
      ok: true;
      subjectRealm: PasswordSubjectRealm;
      subjectId: string;
      email: string | null;
      tokenVersion: number;
    }
  | {
      ok: false;
      error:
        | "invalid_token"
        | "token_expired"
        | "token_used"
        | "token_revoked"
        | PasswordStrengthError;
    }
> {
  const strength = validatePasswordStrength(params.newPassword, undefined, params.confirmPassword);
  if (!strength.ok) {
    return { ok: false, error: strength.error };
  }
  if (!params.token || typeof params.token !== "string") {
    return { ok: false, error: "invalid_token" };
  }

  const tokenHash = hashPasswordResetToken(params.token);
  const passwordHash = await bcrypt.hash(params.newPassword, BCRYPT_COST);

  return withoutTenantScope("identity", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

      const { rows } = await client.query<PasswordResetRow>(
        `${RESET_ROW_SELECT}
           FROM auth_password_resets
          WHERE token_hash = $1
          FOR UPDATE`,
        [tokenHash],
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false, error: "invalid_token" as const };
      }
      if (row.used_at) {
        await client.query("ROLLBACK");
        return { ok: false, error: "token_used" as const };
      }
      if (row.revoked_at) {
        await client.query("ROLLBACK");
        return { ok: false, error: "token_revoked" as const };
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return { ok: false, error: "token_expired" as const };
      }

      const applied = await applyPasswordResetRow(client, row, passwordHash);
      await client.query("COMMIT");

      const lockoutKey = row.email ?? row.phone_e164;
      if (lockoutKey) {
        await clearAuthLockout(
          row.subject_realm === "platform_user" ? "tenant_password" : "platform_admin",
          lockoutKey,
        );
      }

      return { ok: true, ...applied };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Issue a reset whose credential is delivered **by SMS to the account holder**.
 *
 * Issue #854 (P0.3) is the reason this exists. `requestMemberPasswordReset`
 * used to return the plaintext reset token, its URL and the target email to
 * whichever tenant administrator triggered it — and that token is directly
 * spendable to change the shared `platform_users` password. An administrator in
 * Business A could therefore start recovery for a shared identity and then
 * redeem their own token, taking over that person's account in Businesses B and
 * C. The user-controlled boundary #809 introduced was real in intent and absent
 * in practice.
 *
 * There is no mail transport in this system, so "deliver to the account holder"
 * means the one channel only they hold: a **verified phone number**. The reset
 * link is texted to it, and the tenant administrator receives back only a masked
 * destination and an expiry — never the token. If the identity has no verified
 * number anywhere, the recovery is refused (`no_verified_channel`) rather than
 * falling back to handing the credential to the person requesting it, because
 * that fallback *is* the vulnerability.
 */
export async function issueDeliveredPasswordReset(params: {
  subjectRealm: PasswordSubjectRealm;
  subjectId: string;
  /** NULL for a phone-only identity (#1386). */
  email: string | null;
  membershipId?: string | null;
  createdById?: string | null;
  /** The canonical verified number the link will be sent to. */
  phoneE164: string;
  /** Absolute origin to build the link from. */
  origin: string;
}): Promise<{ id: string; expiresAt: Date; maskedPhone: string }> {
  const issued = await issuePasswordResetToken({
    subjectRealm: params.subjectRealm,
    subjectId: params.subjectId,
    email: params.email,
    phoneE164: params.phoneE164,
    membershipId: params.membershipId,
    createdById: params.createdById,
    // Short-lived: the credential travels over SMS, so the window it is
    // spendable in is the window an intercepted message is worth anything.
    ttlMs: 30 * 60 * 1000,
  });

  const maskedPhone =
    params.phoneE164.length > 8
      ? `+${params.phoneE164.slice(1, 4)}***${params.phoneE164.slice(-4)}`
      : "***";

  const link = `${params.origin.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(issued.token)}`;

  await withoutTenantScope("identity", () =>
    query(
      `UPDATE auth_password_resets
          SET delivery_channel = 'sms',
              delivery_target_masked = $2,
              delivered_at = now()
        WHERE id = $1`,
      [issued.id, maskedPhone],
    ),
  );

  const { getSmsProvider } = await import("./sms-config");
  const provider = await getSmsProvider();
  try {
    // Kavenegar's verify/lookup template takes one token, which is why the
    // link (not a bare code) is what travels: the account holder taps it and
    // lands on the reset form with the token already in hand.
    await provider.sendOtp(params.phoneE164, link);
  } catch (err) {
    // A link that was never delivered must not stay live.
    await withoutTenantScope("identity", () =>
      query(`UPDATE auth_password_resets SET revoked_at = now() WHERE id = $1`, [issued.id]),
    ).catch(() => {});
    throw err;
  }

  return { id: issued.id, expiresAt: issued.expiresAt, maskedPhone };
}
