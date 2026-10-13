/**
 * The signed-in member's effective access, resolved by the same canonical
 * authorization evaluator used by API guards. Server-rendered capability-aware
 * controls must not drift from hybrid/site denials, custom-role state, or live
 * membership changes that the mutation route will enforce.
 */
import type { SessionPayload } from "./auth-edge";
import { authorize } from "./authorize";
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
