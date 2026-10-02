/**
 * Phase 46 — the database half of «ورود با حساب ابری» (see desktop-cloud-login.ts).
 *
 * Every function runs inside the caller's tenant scope: the cloud routes name
 * the business from the signed-in session, the site bearer credential, or the
 * host, exactly as their neighbours do — this opens no new isolation hole.
 * Codes are claimed with a conditional UPDATE, so a replayed code is refused
 * however the requests interleave.
 */
import { query } from "./db";
import type { Role } from "./auth";
import { hashLoginCode, LOGIN_CODE_TTL_SECONDS, newLoginToken } from "./desktop-cloud-login";

/** Cloud: the signed-in member asks for a code for one paired install of their business. */
export async function issueDeviceLoginCode(input: {
  businessId: string;
  userId: string;
  devicePublicId: string;
  state: string;
  /** The branches this member may work in; the install's branch must be one of them. */
  accessibleLocationIds: readonly string[];
}): Promise<{ code: string } | { error: "device_not_found" | "branch_not_allowed" }> {
  const device = await query<{ id: string; location_id: string }>(
    `SELECT id, location_id FROM site_devices
      WHERE public_id = $1 AND business_id = $2 AND status = 'active' AND revoked_at IS NULL`,
    [input.devicePublicId, input.businessId],
  );
  const row = device.rows[0];
  if (!row) return { error: "device_not_found" };
  if (!input.accessibleLocationIds.includes(row.location_id)) return { error: "branch_not_allowed" };
  const code = newLoginToken();
  await query(
    `INSERT INTO desktop_login_codes (business_id, kind, code_hash, user_id, site_device_id, state, expires_at)
     VALUES ($1, 'device', $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [input.businessId, hashLoginCode(code), input.userId, row.id, input.state, LOGIN_CODE_TTL_SECONDS],
  );
  return { code };
}

/**
 * Cloud, bearer-authenticated: the install redeems its device code. Only the
 * device the code was minted for can redeem it. Answers the member and a
 * fresh session code for the desktop's embedded cloud pane.
 */
export async function redeemDeviceLoginCode(input: {
  businessId: string;
  siteDeviceId: string;
  code: string;
}): Promise<{ userId: string; sessionCode: string } | null> {
  const claimed = await query<{ user_id: string }>(
    `UPDATE desktop_login_codes c SET used_at = now()
       FROM users u
      WHERE c.code_hash = $1 AND c.kind = 'device' AND c.business_id = $2 AND c.site_device_id = $3
        AND c.used_at IS NULL AND c.expires_at > now()
        AND u.id = c.user_id AND u.is_active
      RETURNING c.user_id`,
    [hashLoginCode(input.code), input.businessId, input.siteDeviceId],
  );
  const userId = claimed.rows[0]?.user_id;
  if (!userId) return null;
  const sessionCode = newLoginToken();
  await query(
    `INSERT INTO desktop_login_codes (business_id, kind, code_hash, user_id, expires_at)
     VALUES ($1, 'session', $2, $3, now() + make_interval(secs => $4))`,
    [input.businessId, hashLoginCode(sessionCode), userId, LOGIN_CODE_TTL_SECONDS],
  );
  return { userId, sessionCode };
}

export interface DesktopSessionMember {
  userId: string;
  role: Role;
  fullName: string;
  locationId: string | null;
  businessSlug: string;
  businessSubdomain: string;
  platformUserId: string | null;
  tokenVersion: number | null;
}

/** Cloud, on the business's own origin: the embedded pane redeems its session code once. */
export async function redeemSessionLoginCode(businessId: string, code: string): Promise<DesktopSessionMember | null> {
  const { rows } = await query<{
    user_id: string;
    role: Role;
    full_name: string;
    location_id: string | null;
    business_slug: string;
    business_subdomain: string;
    platform_user_id: string | null;
    token_version: number | null;
  }>(
    `WITH claimed AS (
       UPDATE desktop_login_codes SET used_at = now()
        WHERE code_hash = $1 AND kind = 'session' AND business_id = $2
          AND used_at IS NULL AND expires_at > now()
        RETURNING user_id)
     SELECT u.id AS user_id, u.role, u.full_name, u.location_id,
            b.slug::text AS business_slug, b.subdomain::text AS business_subdomain,
            u.platform_user_id, pu.token_version
       FROM claimed
       JOIN users u ON u.id = claimed.user_id AND u.is_active
       JOIN businesses b ON b.id = u.business_id AND b.status = 'active'
       LEFT JOIN platform_users pu ON pu.id = u.platform_user_id`,
    [hashLoginCode(code), businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    role: row.role,
    fullName: row.full_name,
    locationId: row.location_id,
    businessSlug: row.business_slug,
    businessSubdomain: row.business_subdomain,
    platformUserId: row.platform_user_id,
    tokenVersion: row.token_version,
  };
}
