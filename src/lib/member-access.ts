/**
 * The signed-in member's effective access — one server-side read.
 *
 * Three pages used to carry their own copy of "SELECT role, permissions FROM
 * users …" plus the `effectivePermissions(parseOverrides(…))` resolution beside
 * it (the settings body, the workspace shell, the orders page), and every new
 * page that needed to gate a button by permission would have grown a fourth.
 * Copies of a security-relevant read are how one screen says «شما مجوز دارید»
 * while the route behind it says 403.
 *
 * The read runs inside an explicit `withTenant` scope, never the ambient one
 * `getSession()` sets: that scope was applied with `enterWith()`, which does not
 * survive a concurrent `withTenant()`/`withoutTenantScope()` `run()` call
 * elsewhere in the process, so an ambient-scope read can come back empty
 * non-deterministically — see the withTenantScope doc comment in auth.ts.
 *
 * Framework-free apart from `db`/`next` types: server components and route
 * handlers both call it; nothing client-side ever sees it.
 */
import type { SessionPayload } from "./auth-edge";
import { query, withTenant } from "./db";
import { effectivePermissions, parseOverrides, type Permission } from "./permissions";
import type { Role } from "./auth-edge";

export interface MemberAccess {
  /** The role as the database holds it right now — the token's can lag a change. */
  role: Role;
  isActive: boolean;
  /** The preset ∪ granted \ revoked set, resolved once, ready to hand to a UI. */
  permissions: Set<Permission>;
}

/**
 * The member behind a session: their role, their active flag, and their
 * effective permissions. `null` when the membership is gone — a removed
 * member, a stale token — which callers should treat as "signed out" rather
 * than as "no permissions at all".
 */
export async function memberAccessFor(
  session: SessionPayload,
): Promise<MemberAccess | null> {
  return memberAccessForUser(session.businessId, session.sub, session.locationId);
}

/** The same live access lookup for a non-session caller, such as an MCP token's authorizing member. */
export async function memberAccessForUser(
  businessId: string,
  userId: string,
  locationId: string | null = null,
): Promise<MemberAccess | null> {
  const { rows } = await withTenant(
    businessId,
    () =>
      query<{ role: Role; permissions: unknown; is_active: boolean; custom_role_permissions: string[] | null }>(
        `SELECT u.role, u.permissions, u.is_active,
                CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) ELSE NULL END AS custom_role_permissions
           FROM users u
           LEFT JOIN tenant_roles tr ON tr.id = u.custom_role_id AND tr.business_id = u.business_id
          WHERE u.id = $1 AND u.business_id = $2`,
        [userId, businessId],
      ),
    { locationId, userId },
  );
  const member = rows[0];
  if (!member) return null;
  return {
    role: member.role,
    isActive: member.is_active,
    permissions: effectivePermissions(
      member.role,
      parseOverrides(member.permissions),
      member.custom_role_permissions,
    ),
  };
}
