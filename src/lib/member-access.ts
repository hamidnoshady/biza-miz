/**
 * The signed-in member's effective access, resolved by the same canonical
 * authorization evaluator used by API guards. Server-rendered capability-aware
 * controls must not drift from hybrid/site denials, custom-role state, or live
 * membership changes that the mutation route will enforce.
 */
import type { SessionPayload } from "./auth-edge";
import { authorize, loadMembership } from "./authorize";
import type { Permission } from "./permissions";
import type { Role } from "./auth-edge";

export interface MemberAccess {
  /** The role as the database holds it right now — the token's can lag a change. */
  role: Role;
  isActive: boolean;
  /** The canonical effective permission set, including hybrid/site denials. */
  permissions: Set<Permission>;
}

/**
 * The member behind a session: their live role, active flag, and effective
 * permissions. Returns null when canonical authorization denies the member.
 */
export async function memberAccessFor(session: SessionPayload): Promise<MemberAccess | null> {
  const decision = await authorize(session);
  if (!decision.ok) return null;
  return {
    role: decision.membership.role,
    isActive: decision.membership.isActive,
    permissions: decision.membership.permissions,
  };
}

/**
 * The same canonical membership read for a non-session caller, such as an MCP
 * token's authorizing member: identified by (businessId, userId) with no live
 * session claims.
 *
 * Built on `loadMembership` — the very read `authorize()` runs — so there is
 * one permission resolver, not a parallel one; but the result is returned
 * even when the membership is *suspended*, because the MCP layer distinguishes
 * "authorizer no longer exists" (null → the connection's branch-pinned system
 * read consent) from "authorizer exists but is suspended" (a member with
 * `isActive: false` → reads nothing). Folding suspended into null would grant
 * the system read consent to suspended members.
 */
export async function memberAccessForUser(
  businessId: string,
  userId: string,
  locationId: string | null = null,
): Promise<MemberAccess | null> {
  const membership = await loadMembership({
    sub: userId,
    businessId,
    locationId,
    fullName: "",
  } as SessionPayload);
  if (!membership) return null;
  return {
    role: membership.role,
    isActive: membership.isActive,
    permissions: membership.permissions,
  };
}
