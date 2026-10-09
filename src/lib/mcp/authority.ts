/**
 * Issue #883 P0-1/P0-5 — the *current* authority behind an MCP connection.
 *
 * A connection is not a permission. It is a credential somebody authorized once;
 * what it may reach at any moment is bounded by what that person may reach *now*
 * — their present role, per-member overrides, custom role and active flag, read
 * fresh on every request. Before this module the dispatcher handed reads
 * `SYSTEM_AI_READ_PERMISSIONS` (all of them), so a connector authorized by a
 * cashier read payroll, and a write ran for an authorizer who had since lost the
 * matching domain permission. Both are the same bug: an authority snapshot taken
 * at grant time being spent forever.
 *
 * The read here deliberately mirrors `member-access.ts` (`memberAccessFor`) —
 * one indexed query, inside the tenant scope, never cached — so "the connector"
 * can never hold a capability the member's own session would be refused. A
 * separate module rather than a reuse of `memberAccessFor` because a connection
 * carries no session: building a SessionPayload to satisfy that signature would
 * assert claims (a role!) that have not been verified yet.
 */
import { query } from "../db";
import { effectivePermissions, parseOverrides, type Permission } from "../permissions";
import type { Role } from "../auth-edge";

export interface McpAuthority {
  /** users.id of the authorizing member — `mcp_connections.authorized_by`. */
  userId: string;
  role: Role;
  /** Preset ∪ granted \ revoked, including custom-role permissions. Fresh. */
  permissions: ReadonlySet<Permission>;
}

/**
 * The member behind `userId` inside `businessId`, or null when the membership
 * is gone or deactivated — which callers must treat as "the credential's
 * authority has lapsed", never as "no permissions at all".
 *
 * Runs in whatever tenant scope the caller established (`withMcpScope` enters
 * the connection's business before calling), exactly like `memberAccessFor`'s
 * explicit `withTenant` read: same table, same join, same resolution.
 */
export async function resolveMcpAuthority(
  businessId: string,
  userId: string,
): Promise<McpAuthority | null> {
  const { rows } = await query<{
    role: Role;
    permissions: unknown;
    is_active: boolean;
    custom_role_permissions: string[] | null;
  }>(
    `SELECT u.role, u.permissions, u.is_active,
            CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) ELSE NULL END AS custom_role_permissions
       FROM users u
       LEFT JOIN tenant_roles tr ON tr.id = u.custom_role_id AND tr.business_id = u.business_id
      WHERE u.id = $1 AND u.business_id = $2`,
    [userId, businessId],
  );
  const member = rows[0];
  if (!member || !member.is_active) return null;
  return {
    userId,
    role: member.role,
    permissions: effectivePermissions(
      member.role,
      parseOverrides(member.permissions),
      member.custom_role_permissions,
    ),
  };
}
