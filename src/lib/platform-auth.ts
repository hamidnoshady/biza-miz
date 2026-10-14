/**
 * Phase 15 — server-side platform-admin session + capability guards.
 *
 * The tenant equivalent is `src/lib/auth.ts`. This is its counterpart for the
 * super-admin realm: it reads the platform cookie, verifies the platform
 * token, and — critically — establishes a *bypass* tenant scope for the rest
 * of the request, because the console administers every business by definition
 * (the documented `withoutTenantScope('platform', …)` reason, see db.ts).
 *
 * The token primitives live in `platform-auth-edge.ts` so `src/middleware.ts`
 * can verify a session on Edge; this file adds the DB-touching parts (the
 * fresh is-still-active check, the audit writer) and re-exports the primitives
 * so route handlers only import from `@/lib/platform-auth`.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  platformSessionHours,
  signPlatformSession,
  verifyPlatformSession,
  type PlatformAdminRole,
  type PlatformSessionPayload,
} from "./platform-auth-edge";
import { platformCan, type PlatformCapability } from "./platform-admin";
import { query } from "./db";
import { enterTenantScope, runInTenantScope } from "./tenant-context";

export {
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  platformSessionHours,
  signPlatformSession,
  verifyPlatformSession,
  type PlatformAdminRole,
  type PlatformSessionPayload,
};

/**
 * Reads and verifies the platform session, and stands tenant isolation down
 * for the rest of the request.
 *
 * The bypass is set on EVERY call — to `bypass` when there is a platform
 * session, back to `none` when there isn't — for exactly the reason
 * `getSession()` sets the tenant scope unconditionally: a pooled connection
 * must never inherit the previous request's scope. A platform request that
 * fails auth therefore falls through to `none` (fail-closed), not to whatever
 * the last caller on this worker was scoped to.
 */
export async function getPlatformSession(): Promise<PlatformSessionPayload | null> {
  const store = await cookies();
  const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
  const session = token ? await verifyPlatformSession(token) : null;

  enterTenantScope(
    session ? { kind: "bypass", reason: "platform" } : { kind: "none" },
  );

  return session;
}

/**
 * Wraps a route handler so the bypass scope survives for its *entire*
 * execution, not just the moment `getPlatformSession()` runs.
 *
 * See the matching comment on `withTenantScope` in auth.ts for the full
 * explanation: `enterTenantScope()`'s `AsyncLocalStorage.enterWith()` call
 * only reliably persists until the next concurrent `AsyncLocalStorage.run()`
 * anywhere in the process — and `server.ts`'s background ticks call exactly
 * that, on a timer, for the server's whole lifetime. Establishing the scope
 * here with `run()`, once, up front, is what survives tick interleaving.
 */
export function withPlatformScope<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    const store = await cookies();
    const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
    const session = token ? await verifyPlatformSession(token) : null;
    const scope = session
      ? ({ kind: "bypass", reason: "platform" } as const)
      : ({ kind: "none" } as const);
    return runInTenantScope(scope, () => handler(...args));
  };
}

/**
 * The authoritative session: the token verified AND the admin still active in
 * the database. Re-reading costs one indexed lookup and means deactivating an
 * admin ends their session's usefulness on their next request rather than at
 * token expiry — the same bargain `requirePermission` makes for tenants.
 *
 * Returns the *current* role from the database, so a role change (e.g. an owner
 * demoting an engineer to support) takes effect immediately.
 */
async function activePlatformAdmin(
  session: PlatformSessionPayload,
): Promise<PlatformSessionPayload | null> {
  const { rows } = await query<{ role: PlatformAdminRole; is_active: boolean; token_version: number }>(
    `SELECT role, is_active, token_version FROM platform_admins WHERE id = $1`,
    [session.padmin],
  );
  const admin = rows[0];
  if (!admin || !admin.is_active) return null;
  const presentedVersion = session.tokenVersion ?? 1;
  if (admin.token_version !== presentedVersion) return null;
  if (session.sessionId) {
    const { rows: sessionRows } = await query<{ id: string }>(
      `UPDATE auth_admin_sessions
          SET last_seen_at = now()
        WHERE id = $1 AND admin_id = $2 AND revoked_at IS NULL AND expires_at > now()
        RETURNING id`,
      [session.sessionId, session.padmin],
    );
    if (!sessionRows[0]) return null;
  }
  return { ...session, role: admin.role, tokenVersion: admin.token_version };
}

export interface PlatformAdminSessionSummary {
  id: string;
  adminId: string;
  tokenVersion: number;
  mfaVerified: boolean;
  deviceLabel: string | null;
  ipAddress: string | null;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  isCurrent: boolean;
}

export async function createPlatformAdminSession(options: {
  adminId: string;
  tokenVersion: number;
  mfaVerified: boolean;
  deviceLabel?: string | null;
  ipAddress?: string | null;
}): Promise<string> {
  const expiresAt = new Date(Date.now() + platformSessionHours() * 60 * 60 * 1000);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO auth_admin_sessions
       (admin_id, token_version, mfa_verified, device_label, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      options.adminId,
      options.tokenVersion,
      options.mfaVerified,
      options.deviceLabel ? options.deviceLabel.slice(0, 120) : null,
      options.ipAddress ? options.ipAddress.slice(0, 64) : null,
      expiresAt,
    ],
  );
  return rows[0].id;
}

export async function listPlatformAdminSessions(
  adminId: string,
  currentSessionId?: string | null,
): Promise<PlatformAdminSessionSummary[]> {
  const { rows } = await query<{
    id: string;
    admin_id: string;
    token_version: number;
    mfa_verified: boolean;
    device_label: string | null;
    ip_address: string | null;
    issued_at: Date;
    expires_at: Date;
    last_seen_at: Date | null;
  }>(
    `SELECT s.id, s.admin_id, s.token_version, s.mfa_verified, s.device_label, s.ip_address,
            s.issued_at, s.expires_at, s.last_seen_at
       FROM auth_admin_sessions s
       JOIN platform_admins pa ON pa.id = s.admin_id AND pa.token_version = s.token_version
      WHERE s.admin_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
      ORDER BY s.issued_at DESC`,
    [adminId],
  );
  return rows.map((r) => ({
    id: r.id,
    adminId: r.admin_id,
    tokenVersion: r.token_version,
    mfaVerified: r.mfa_verified,
    deviceLabel: r.device_label,
    ipAddress: r.ip_address,
    issuedAt: r.issued_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    isCurrent: Boolean(currentSessionId && r.id === currentSessionId),
  }));
}

export async function revokePlatformAdminSession(
  adminId: string,
  sessionId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE auth_admin_sessions
        SET revoked_at = now()
      WHERE id = $1 AND admin_id = $2 AND revoked_at IS NULL`,
    [sessionId, adminId],
  );
  return (rowCount ?? 0) > 0;
}

export async function revokeOtherPlatformAdminSessions(
  adminId: string,
  keepSessionId?: string | null,
): Promise<{ tokenVersion: number; revokedSessions: number }> {
  const { rows: adminRows } = await query<{ token_version: number }>(
    `SELECT token_version FROM platform_admins WHERE id = $1`,
    [adminId],
  );
  const { rowCount } = keepSessionId
    ? await query(
        `UPDATE auth_admin_sessions
            SET revoked_at = now()
          WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [adminId, keepSessionId],
      )
    : await query(
        `UPDATE auth_admin_sessions
            SET revoked_at = now()
          WHERE admin_id = $1 AND revoked_at IS NULL`,
        [adminId],
      );
  return {
    tokenVersion: adminRows[0]?.token_version ?? 1,
    revokedSessions: rowCount ?? 0,
  };
}

export async function revokeAllPlatformAdminSessions(
  adminId: string,
): Promise<{ tokenVersion: number; revokedSessions: number }> {
  const { rows } = await query<{ token_version: number }>(
    `UPDATE platform_admins
        SET token_version = token_version + 1
      WHERE id = $1
      RETURNING token_version`,
    [adminId],
  );
  const { rowCount } = await query(
    `UPDATE auth_admin_sessions
        SET revoked_at = now()
      WHERE admin_id = $1 AND revoked_at IS NULL`,
    [adminId],
  );
  await query(
    `UPDATE impersonation_grants
        SET revoked_at = now()
      WHERE platform_admin_id = $1 AND ended_at IS NULL AND revoked_at IS NULL`,
    [adminId],
  );
  return {
    tokenVersion: rows[0]?.token_version ?? 1,
    revokedSessions: rowCount ?? 0,
  };
}

type Guarded =
  | { session: PlatformSessionPayload; error: null }
  | { session: null; error: NextResponse };

/** Session guard: any authenticated, still-active platform admin. */
export async function requirePlatformAdmin(): Promise<Guarded> {
  const session = await getPlatformSession();
  if (!session) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const fresh = await activePlatformAdmin(session);
  if (!fresh) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { session: fresh, error: null };
}

/**
 * Capability guard: an active admin whose *current* role holds `capability`.
 * This is the platform equivalent of `requirePermission` — the single check
 * every write route runs, so the danger of a surface is decided in one place
 * (`platform-admin.ts`) rather than re-argued per route.
 */
export async function requirePlatformCapability(capability: PlatformCapability): Promise<Guarded> {
  const guard = await requirePlatformAdmin();
  if (guard.error) return guard;
  if (!platformCan(guard.session.role, capability)) {
    return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return guard;
}

/**
 * Append a row to `platform_audit_log`. Every privileged cross-tenant action
 * flows through here; the console's whole accountability story is that no
 * write happens without one of these.
 *
 * Security Hardening (Phase 24): Audit log failures must be loud. If we cannot
 * record who did what, the action itself must fail rather than proceeding
 * silently.
 */
export async function platformAudit(entry: {
  adminId: string;
  businessId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO platform_audit_log
       (platform_admin_id, business_id, action, entity, entity_id, payload, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.adminId,
      entry.businessId ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.payload ? JSON.stringify(entry.payload) : null,
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
    ],
  ).catch((err) => {
    // Phase 24 Wave 5: "make platform-audit write failures loud instead of swallowed"
    console.error("platformAudit failed:", err);
    throw err;
  });
}
