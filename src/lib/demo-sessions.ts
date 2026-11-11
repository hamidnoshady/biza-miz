import type { PoolClient } from "pg";
import { withTenantTransaction } from "./db";
import { assertDemoDatabase } from "./demo-database";
import {
  demoTokenHash,
  isDemoDeployment,
  parseDemoCredential,
  requireDemoDeployment,
} from "./demo-session-credentials";
import type { Industry } from "./industries";

export interface DemoSession {
  id: string;
  businessId: string;
  userId: string;
  locationId: string;
  platformUserId: string;
  businessSubdomain: string;
  industry: Industry;
  templateVersion: string;
  expiresAt: Date;
}

/** The optional business id only narrows the authenticated lookup. */
export async function findLiveDemoSession(client: PoolClient, hash: Buffer, businessId?: string) {
  const { rows } = await client.query<DemoSession>(
    `SELECT s.id, s.business_id AS "businessId", s.user_id AS "userId", s.location_id AS "locationId",
            s.platform_user_id AS "platformUserId", b.subdomain::text AS "businessSubdomain",
            s.industry, s.template_version AS "templateVersion", s.expires_at AS "expiresAt"
       FROM platform_demo_sessions s
       JOIN businesses b ON b.id = s.business_id AND b.ownership_kind = 'demo'
         AND b.industry = s.industry AND b.status = 'active'
       JOIN users u ON u.id = s.user_id AND u.business_id = b.id
         AND u.role = 'owner' AND u.is_active AND u.membership_status = 'active' AND u.platform_user_id = s.platform_user_id
       JOIN locations l ON l.id = s.location_id AND l.business_id = b.id AND l.is_active
       JOIN user_locations ul ON ul.user_id = u.id AND ul.location_id = l.id
       JOIN platform_users p ON p.id = u.platform_user_id AND NOT p.is_active
      WHERE s.token_hash = $1 AND ($2::uuid IS NULL OR s.business_id = $2)
        AND s.expires_at > clock_timestamp() AND s.revoked_at IS NULL
        AND s.provisioning_state = 'ready' AND s.cleanup_state = 'pending'`,
    [hash, businessId ?? null],
  );
  return rows[0] ?? null;
}

/** Server-side lookup for the dedicated demo auth entry point. */
export async function resolveDemoSession(token: string): Promise<DemoSession | null> {
  if (!isDemoDeployment()) return null;
  const parsed = parseDemoCredential(token);
  if (!parsed) return null;
  const config = requireDemoDeployment();

  // The prefix is a lookup hint only. No tenant work runs until the stored
  // credential hash and every part of the membership binding have matched.
  return withTenantTransaction(parsed.businessId, async (client) => {
    await assertDemoDatabase(client, config);
    return findLiveDemoSession(client, demoTokenHash(parsed.secret), parsed.businessId);
  });
}
