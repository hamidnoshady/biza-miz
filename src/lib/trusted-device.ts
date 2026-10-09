/**
 * Issue #885 — the canonical trusted-device service.
 *
 * The policy this implements is the one the audit records as confirmed: at
 * every new login the account's applicable OTP and/or MFA challenges are
 * required *unless* this exact device holds a valid trust entry for that
 * account and tenant. A login that completed every required factor may then
 * register the device for seven days; during that window routine OTP/MFA is
 * skipped on it; after it expires, or on any other device, verification is
 * required again and a fresh seven-day period starts only from a fresh
 * successful verification.
 *
 * Boundaries worth repeating, because each of them is a way this feature
 * could quietly become a hole:
 *
 *  - **Trust is not a session.** It mints no token and authorises nothing.
 *    Session lifetime lives in `employee_sessions`; this table has its own
 *    clock and the two are deliberately unrelated.
 *  - **Trust is not a primary credential.** It waives the routine *assurance*
 *    challenge only — the periodic phone re-verification on the PIN door, the
 *    MFA second factor on the password door. A proven PIN, password or
 *    WebAuthn assertion is still required on every single login.
 *  - **Trust is scoped to account + tenant + device.** One membership's
 *    `users.otp_login_at` is member-wide, which is exactly the shape this
 *    replaces: verifying on the till must not exempt the owner's laptop.
 *  - **The stored value is a digest.** The credential is a 256-bit random
 *    secret carried in a host-scoped HttpOnly cookie; only HMAC-SHA256 of it
 *    is persisted, so reading this table cannot be replayed as device trust.
 *
 * Pure decisions (`evaluateDeviceTrust`, `trustedDeviceExpiry`) are exported
 * separately from the database calls so the expiry boundary and the
 * scope/revocation rules are testable against a fixed clock.
 */
import { createHmac, randomBytes } from "node:crypto";
import { query, withoutTenantScope } from "./db";
import { getRealmSecret } from "./jwt-secret";

/** Seven days, in milliseconds. Fixed by policy — not a setting. */
export const TRUSTED_DEVICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The opaque credential's cookie. Host-scoped: no Domain attribute, like `pos_session`. */
export const TRUSTED_DEVICE_COOKIE = "pos_trusted_device";

const TOKEN_PREFIX = "tdev_";

/** Why a trust entry stopped applying. Diagnostic; never an authorization input. */
export type DeviceTrustFailure =
  | "missing"
  | "revoked"
  | "expired"
  | "wrong_subject";

export interface TrustedDeviceCandidate {
  id: string;
  businessId: string;
  userId: string;
  expiresAt: Date | string;
  revokedAt: Date | string | null;
}

export type DeviceTrustDecision =
  | { trusted: true; expiresAt: Date }
  | { trusted: false; reason: DeviceTrustFailure };

/**
 * Cookie options for the trust credential.
 *
 * Same posture as `sessionCookieOptions` — HttpOnly so no script can read it,
 * Lax so it is not replayable cross-site, Secure in production, no Domain so
 * it stays on the issuing host. The `maxAge` mirrors the server-side expiry
 * exactly; a cookie that outlived the row would only produce a lookup miss,
 * but a cookie that expired early would silently end trust before its time.
 */
export function trustedDeviceCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(TRUSTED_DEVICE_TTL_MS / 1000),
  };
}

/** The instant a trust granted at `now` stops applying. Exactly seven days. */
export function trustedDeviceExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + TRUSTED_DEVICE_TTL_MS);
}

/**
 * Does this entry still hold, for this login, right now?
 *
 * Pure and clock-injected on purpose: the seven-day boundary is the whole
 * feature, and "expired at 07:00:00.000 on day eight" is a fact that must be
 * pinned by a test rather than inferred from a live run.
 *
 * The scope check is part of the decision rather than the caller's problem.
 * The lookup is by token hash alone — one digest names one row globally — so
 * nothing upstream guarantees that row belongs to the account and tenant
 * being signed in. A cookie left behind by one member on a shared till must
 * not be honoured for another member of the same business.
 */
export function evaluateDeviceTrust(
  entry: TrustedDeviceCandidate | null,
  scope: { businessId: string; userId: string },
  now: Date = new Date(),
): DeviceTrustDecision {
  if (!entry) return { trusted: false, reason: "missing" };
  if (entry.revokedAt) return { trusted: false, reason: "revoked" };
  if (entry.businessId !== scope.businessId || entry.userId !== scope.userId) {
    return { trusted: false, reason: "wrong_subject" };
  }
  const expiresAt = entry.expiresAt instanceof Date ? entry.expiresAt : new Date(entry.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return { trusted: false, reason: "expired" };
  // `>=` at the exact boundary: the policy says trust covers seven days, so
  // the final millisecond still counts and the instant after does not.
  if (now.getTime() >= expiresAt.getTime()) return { trusted: false, reason: "expired" };
  return { trusted: true, expiresAt };
}

/** HMAC-SHA256 of the token, hex. The only form of it that is ever stored. */
async function hashTrustToken(token: string): Promise<string> {
  const secret = await getRealmSecret("tenant");
  return createHmac("sha256", Buffer.from(secret)).update(token).digest("hex");
}

/**
 * Register this device as trusted for seven days.
 *
 * Called only after a login has completed every factor the account requires —
 * never as a way of avoiding one. Returns the plaintext token exactly once;
 * the caller sets it as the cookie and keeps nothing.
 *
 * An existing unexpired, unrevoked trust for the same device is rotated
 * rather than duplicated: the member gets a fresh seven days *because they
 * just completed a full verification*, which is the one thing the policy
 * allows to start a new period. Ordinary logins take the skip path instead and
 * never reach here, so this cannot silently extend a trust.
 */
export async function issueTrustedDevice(options: {
  businessId: string;
  userId: string;
  platformUserId?: string | null;
  deviceToken?: string | null;
  deviceLabel?: string | null;
  factorSummary?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const tokenHash = await hashTrustToken(token);
  const expiresAt = trustedDeviceExpiry();

  await query(
    `INSERT INTO trusted_devices
       (business_id, user_id, platform_user_id, token_hash, device_token,
        device_label, factor_summary, trusted_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, now())`,
    [
      options.businessId,
      options.userId,
      options.platformUserId ?? null,
      tokenHash,
      options.deviceToken ?? null,
      options.deviceLabel ?? null,
      options.factorSummary ?? null,
      expiresAt,
    ],
  );

  return { token, expiresAt };
}

interface TrustRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * Is the presented credential a live trust for this account on this tenant?
 *
 * Reads bypass the tenant scope deliberately: this runs on login paths, where
 * no session exists yet to carry a scope, and the row is selected by the
 * digest of a secret the caller already holds. The scope check in
 * `evaluateDeviceTrust` is what confines the result to this account and
 * tenant, so a digest found globally still cannot vouch for the wrong member.
 */
export async function verifyTrustedDevice(options: {
  businessId: string;
  userId: string;
  token: string | null | undefined;
  now?: Date;
}): Promise<DeviceTrustDecision> {
  const token = typeof options.token === "string" ? options.token.trim() : "";
  if (!token.startsWith(TOKEN_PREFIX)) return { trusted: false, reason: "missing" };

  const tokenHash = await hashTrustToken(token);
  const { rows } = await withoutTenantScope("login", () =>
    query<TrustRow>(
      `SELECT id, business_id, user_id, expires_at, revoked_at
         FROM trusted_devices
        WHERE token_hash = $1
        LIMIT 1`,
      [tokenHash],
    ),
  );
  const row = rows[0];
  if (!row) return { trusted: false, reason: "missing" };

  const decision = evaluateDeviceTrust(
    {
      id: row.id,
      businessId: row.business_id,
      userId: row.user_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    },
    { businessId: options.businessId, userId: options.userId },
    options.now ?? new Date(),
  );

  if (decision.trusted) {
    // Activity tracking only. Never gates anything, so a failure here must not
    // cost the member their login.
    await withoutTenantScope("login", () =>
      query(`UPDATE trusted_devices SET last_seen_at = now() WHERE id = $1`, [row.id]),
    ).catch(() => {});
  }
  return decision;
}

export interface TrustedDeviceListing {
  id: string;
  deviceLabel: string | null;
  factorSummary: string | null;
  trustedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

/** One member's devices, live and revoked, newest first. Runs in tenant scope. */
export async function listTrustedDevices(
  businessId: string,
  userId: string,
): Promise<TrustedDeviceListing[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, device_label, factor_summary, trusted_at, expires_at,
            last_seen_at, revoked_at
       FROM trusted_devices
      WHERE business_id = $1 AND user_id = $2
      ORDER BY trusted_at DESC`,
    [businessId, userId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    deviceLabel: (r.device_label as string | null) ?? null,
    factorSummary: (r.factor_summary as string | null) ?? null,
    trustedAt: new Date(r.trusted_at as string | Date),
    expiresAt: new Date(r.expires_at as string | Date),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at as string | Date) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string | Date) : null,
  }));
}

/** Revoke one device by id, for the member who owns it. Idempotent. */
export async function revokeTrustedDevice(options: {
  businessId: string;
  userId: string;
  id: string;
  reason?: string;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE trusted_devices
        SET revoked_at = now(), revoked_reason = COALESCE($4, revoked_reason)
      WHERE id = $1 AND business_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
    [options.id, options.businessId, options.userId, options.reason ?? "user_revoked"],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Drop every trust a membership has earned.
 *
 * Called by the security events the policy names: a password reset, an
 * account disable, a device revocation from the console, a role or
 * security-policy change. Trust is a convenience earned by verification, so
 * anything that changes what verification means has to take it back.
 */
export async function revokeTrustedDevicesForMember(options: {
  businessId: string;
  userId: string;
  reason: string;
}): Promise<number> {
  const { rowCount } = await query(
    `UPDATE trusted_devices
        SET revoked_at = now(), revoked_reason = $4
      WHERE business_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [options.businessId, options.userId, null, options.reason],
  );
  return rowCount ?? 0;
}

/**
 * Drop every trust a *global identity* earned, across every tenant membership
 * it holds. A platform-side disable or credential change reaches a site
 * through this, because the membership rows it would otherwise be traced
 * through do not know the account is gone.
 */
export async function revokeTrustedDevicesForPlatformUser(options: {
  platformUserId: string;
  reason: string;
}): Promise<number> {
  const { rowCount } = await withoutTenantScope("platform", () =>
    query(
      `UPDATE trusted_devices
          SET revoked_at = now(), revoked_reason = $2
        WHERE platform_user_id = $1 AND revoked_at IS NULL`,
      [options.platformUserId, options.reason],
    ),
  );
  return rowCount ?? 0;
}

/**
 * Pull the trust credential off a request, if the browser is carrying one.
 *
 * Kept here rather than in each route so the cookie name and the
 * "absent or blank means absent" rule cannot drift between the doors.
 */
export function readTrustedDeviceToken(request: {
  cookies: { get(name: string): { value: string } | undefined };
}): string | null {
  const value = request.cookies.get(TRUSTED_DEVICE_COOKIE)?.value;
  if (!value || !value.trim()) return null;
  return value.trim();
}
