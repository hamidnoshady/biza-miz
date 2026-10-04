import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool, query, withoutTenantScope } from "./db";
import { clearAuthLockout } from "./login-lockout-service";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

export type PasswordSubjectRealm = "platform_user" | "platform_admin";

export type PasswordStrengthResult =
  | { ok: true }
  | {
      ok: false;
      error: "password_too_short" | "password_too_long" | "password_unchanged";
    };

export function validatePasswordStrength(
  newPassword: string,
  currentPassword?: string,
): PasswordStrengthResult {
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: "password_too_short" };
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: "password_too_long" };
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
 */
export async function changeOwnPassword(params: {
  subjectRealm: PasswordSubjectRealm;
  subjectId: string;
  currentPassword: string;
  newPassword: string;
  keepEmployeeSessionId?: string | null;
  keepAdminSessionId?: string | null;
}): Promise<
  | { ok: true; tokenVersion: number }
  | {
      ok: false;
      error:
        | "invalid_current_password"
        | "password_too_short"
        | "password_too_long"
        | "password_unchanged"
        | "not_found";
    }
> {
  const strength = validatePasswordStrength(params.newPassword, params.currentPassword);
  if (!strength.ok) return strength;

  return withoutTenantScope("identity", async () => {
    if (params.subjectRealm === "platform_user") {
      const { rows } = await query<{
        email: string;
        password_hash: string;
      }>(
        `SELECT email::text AS email, password_hash
           FROM platform_users
          WHERE id = $1 AND is_active = true`,
        [params.subjectId],
      );
      const user = rows[0];
      if (!user) return { ok: false, error: "not_found" };

      const valid = await bcrypt.compare(params.currentPassword, user.password_hash);
      if (!valid) return { ok: false, error: "invalid_current_password" };

      const nextHash = await bcrypt.hash(params.newPassword, BCRYPT_COST);
      const { rows: updated } = await query<{ token_version: number }>(
        `UPDATE platform_users
            SET password_hash = $2,
                token_version = token_version + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING token_version`,
        [params.subjectId, nextHash],
      );
      const tokenVersion = updated[0]?.token_version ?? 2;

      await revokePlatformUserSessions(params.subjectId, {
        bumpTokenVersion: false,
        keepEmployeeSessionId: params.keepEmployeeSessionId ?? null,
        endImpersonation: true,
      });

      await clearAuthLockout("tenant_password", user.email);

      return { ok: true, tokenVersion };
    }

    const { rows } = await query<{
      email: string;
      password_hash: string;
    }>(
      `SELECT email::text AS email, password_hash
         FROM platform_admins
        WHERE id = $1 AND is_active = true`,
      [params.subjectId],
    );
    const admin = rows[0];
    if (!admin) return { ok: false, error: "not_found" };

    const valid = await bcrypt.compare(params.currentPassword, admin.password_hash);
    if (!valid) return { ok: false, error: "invalid_current_password" };

    const nextHash = await bcrypt.hash(params.newPassword, BCRYPT_COST);
    const { rows: updated } = await query<{ token_version: number }>(
      `UPDATE platform_admins
          SET password_hash = $2,
              token_version = token_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING token_version`,
      [params.subjectId, nextHash],
    );
    const tokenVersion = updated[0]?.token_version ?? 2;

    await query(
      `UPDATE auth_admin_sessions
          SET revoked_at = now()
        WHERE admin_id = $1
          AND revoked_at IS NULL
          AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [params.subjectId, params.keepAdminSessionId ?? null],
    );

    if (params.keepAdminSessionId) {
      await query(
        `UPDATE auth_admin_sessions
            SET token_version = $2
          WHERE id = $1 AND admin_id = $3`,
        [params.keepAdminSessionId, tokenVersion, params.subjectId],
      );
    }

    await clearAuthLockout("platform_admin", admin.email);

    return { ok: true, tokenVersion };
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
  email: string;
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
         (subject_realm, subject_id, membership_id, email, token_hash, expires_at, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.subjectRealm,
        params.subjectId,
        params.membershipId ?? null,
        params.email.trim().toLowerCase(),
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
  email: string;
  expiresAt: string;
  status: "pending" | "expired" | "used" | "revoked";
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
      email: string;
      expires_at: Date;
      used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, subject_realm, subject_id, email::text AS email,
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
export async function consumePasswordResetToken(params: {
  token: string;
  newPassword: string;
}): Promise<
  | {
      ok: true;
      subjectRealm: PasswordSubjectRealm;
      subjectId: string;
      email: string;
      tokenVersion: number;
    }
  | {
      ok: false;
      error:
        | "invalid_token"
        | "token_expired"
        | "token_used"
        | "token_revoked"
        | "password_too_short"
        | "password_too_long";
    }
> {
  const strength = validatePasswordStrength(params.newPassword);
  if (!strength.ok) {
    return {
      ok: false,
      error: strength.error === "password_unchanged" ? "password_too_short" : strength.error,
    };
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

      const { rows } = await client.query<{
        id: string;
        subject_realm: PasswordSubjectRealm;
        subject_id: string;
        email: string;
        expires_at: Date;
        used_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT id, subject_realm, subject_id, email::text AS email,
                expires_at, used_at, revoked_at
           FROM auth_password_resets
          WHERE token_hash = $1
          FOR UPDATE`,
        [tokenHash],
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false, error: "invalid_token" };
      }
      if (row.used_at) {
        await client.query("ROLLBACK");
        return { ok: false, error: "token_used" };
      }
      if (row.revoked_at) {
        await client.query("ROLLBACK");
        return { ok: false, error: "token_revoked" };
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return { ok: false, error: "token_expired" };
      }

      let tokenVersion = 1;
      if (row.subject_realm === "platform_user") {
        const updated = await client.query<{ token_version: number }>(
          `UPDATE platform_users
              SET password_hash = $2,
                  token_version = token_version + 1,
                  updated_at = now()
            WHERE id = $1
            RETURNING token_version`,
          [row.subject_id, passwordHash],
        );
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
      } else {
        const updated = await client.query<{ token_version: number }>(
          `UPDATE platform_admins
              SET password_hash = $2,
                  token_version = token_version + 1,
                  updated_at = now()
            WHERE id = $1
            RETURNING token_version`,
          [row.subject_id, passwordHash],
        );
        tokenVersion = updated.rows[0]?.token_version ?? 2;

        await client.query(
          `UPDATE auth_admin_sessions
              SET revoked_at = now()
            WHERE admin_id = $1 AND revoked_at IS NULL`,
          [row.subject_id],
        );
      }

      await client.query(
        `UPDATE auth_password_resets
            SET used_at = now()
          WHERE id = $1`,
        [row.id],
      );

      await client.query("COMMIT");

      await clearAuthLockout(
        row.subject_realm === "platform_user" ? "tenant_password" : "platform_admin",
        row.email,
      );

      return {
        ok: true,
        subjectRealm: row.subject_realm,
        subjectId: row.subject_id,
        email: row.email,
        tokenVersion,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
