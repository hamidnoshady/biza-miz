/**
 * Issue #854 (P0.1 / P0.2 / P0.5 / P1.12 / P2.10) — one authorization decision
 * for every way a membership can be granted.
 *
 * Before this module the anti-escalation rule lived inside a single route:
 * `PATCH /api/team/[id]` compared the actor's effective permissions against the
 * target's *next* effective permissions and called `escalationRefusal`. Member
 * **creation** (`POST /api/team`), **invitation** creation
 * (`POST /api/team/invitations`) and **custom-role assignment** each took their
 * own, narrower path — every one of them guarded `owner` specially and none of
 * them compared capabilities at all. So a delegated team manager, who could not
 * *edit* a colleague into `payments.refund` they did not hold, could simply
 * *create* one that had it, or invite one. Same authority, different door
 * (#854 P0.1, P0.2).
 *
 * The fix is not "copy `escalationRefusal` into two more routes" — that is how
 * the divergence happened. It is to name the decision once
 * (`membershipGrantRefusal`), have one reader answer "what is this actor allowed
 * to hand out?" (`resolveMembershipAuthority`), and make create, update and
 * invite all ask the same question with the same shape of input.
 *
 * Pure rules are at the bottom and unit-tested in `membership-authority.test.ts`
 * without a database. The two database readers at the top are thin: they load
 * the actor and (for custom roles) the role being offered.
 */
import { query } from "./db";
import type { Role } from "./auth-edge";
import {
  effectivePermissions,
  isOwnerOnlyPermission,
  parseOverrides,
  PERMISSIONS,
  type Permission,
  type PermissionOverrides,
} from "./permissions";

// ---------------------------------------------------------------------------
// Reading the actor
// ---------------------------------------------------------------------------

export interface MembershipActorAuthority {
  actorId: string;
  /** The actor's role as the **database** holds it, never `session.role`. */
  actorRole: Role;
  /** Everything the actor can currently exercise. */
  actorPermissions: ReadonlySet<Permission>;
  /** The custom role the actor wears, if any. */
  actorCustomRoleId: string | null;
  actorCustomRolePermissions: readonly string[] | null;
}

export interface MembershipTargetSnapshot {
  targetId: string;
  targetRole: Role;
  targetCustomRoleId: string | null;
  targetCustomRolePermissions: readonly string[] | null;
  targetPermissions: ReadonlySet<Permission>;
}

/**
 * Load an active member's authority from the database.
 *
 * Deliberately reads `users.role` rather than trusting `session.role`:
 * a token minted before a demotion would otherwise still spend the access it
 * was minted with, which is the same reasoning `PATCH /api/team/[id]` already
 * documented for its own read. Returns null when the actor is not an active
 * member of `businessId`.
 */
export async function resolveMembershipAuthority(
  businessId: string,
  actorId: string,
): Promise<MembershipActorAuthority | null> {
  const { rows } = await query<{
    role: Role;
    permissions: unknown;
    custom_role_id: string | null;
    custom_role_permissions: string[] | null;
  }>(
    `SELECT u.role, u.permissions, u.custom_role_id,
            CASE WHEN r.is_active THEN ARRAY(SELECT jsonb_array_elements_text(r.permissions)) END
              AS custom_role_permissions
       FROM users u
       LEFT JOIN tenant_roles r ON r.id = u.custom_role_id AND r.business_id = u.business_id
      WHERE u.id = $1 AND u.business_id = $2 AND u.is_active = true`,
    [actorId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    actorId,
    actorRole: row.role,
    actorPermissions: effectivePermissions(
      row.role,
      parseOverrides(row.permissions),
      row.custom_role_permissions,
    ),
    actorCustomRoleId: row.custom_role_id,
    actorCustomRolePermissions: row.custom_role_permissions,
  };
}

/** A live custom role in this business, reduced to what the decision needs. */
export interface CustomRoleSnapshot {
  id: string;
  name: string;
  permissions: readonly string[];
  defaultLocationScope: "all" | "selected" | "home" | "none" | null;
}

export async function loadCustomRole(
  businessId: string,
  customRoleId: string,
): Promise<CustomRoleSnapshot | null> {
  const { rows } = await query<{
    id: string;
    name: string;
    permissions: string[];
    default_location_scope: CustomRoleSnapshot["defaultLocationScope"];
  }>(
    `SELECT id, name,
            ARRAY(SELECT jsonb_array_elements_text(permissions)) AS permissions,
            default_location_scope
       FROM tenant_roles
      WHERE id = $1 AND business_id = $2 AND is_active = true`,
    [customRoleId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    permissions: row.permissions,
    defaultLocationScope: row.default_location_scope,
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Why a grant of membership/access was refused.
 *
 * One vocabulary for create, update and invite, so the route can translate it
 * into a Persian explanation in one place (`grantRefusalMessage`) instead of
 * three routes inventing three error strings for the same refusal.
 */
export type MembershipGrantRefusal =
  /** The actor may not act on permissions at all. */
  | "permissions_manage_required"
  /** Owner-level change (creating/moving to `owner`, or editing an owner). */
  | "owner_only"
  /** The actor tried to change their own role. */
  | "self_role_change"
  /** The grant would hand out a capability the actor does not hold. */
  | "grants_beyond_actor"
  /** The named custom role does not exist / is not active in this business. */
  | "custom_role_not_found"
  /** The named custom role carries capabilities beyond the actor. */
  | "custom_role_beyond_actor"
  /** A custom role may not be worn by `owner` — ownership is a system role. */
  | "custom_role_not_for_owner";

export interface MembershipGrantCheck {
  actor: MembershipActorAuthority;
  /** The role the target would hold after the change. */
  nextRole: Role;
  /** The target's effective permissions *before* the change (update only). */
  currentPermissions?: ReadonlySet<Permission>;
  /** The target's effective permissions *after* the change. */
  nextPermissions: ReadonlySet<Permission>;
  /** The custom role being assigned, when the request names one. */
  customRole?: CustomRoleSnapshot | null;
  /** The custom role the target currently wears (update only). */
  currentCustomRole?: CustomRoleSnapshot | null;
  /** True when the actor is acting on their own membership. */
  isSelf: boolean;
  /**
   * True when this operation creates a brand-new membership. A creation can
   * never be a *reduction*, so the "taking access away is never an escalation"
   * carve-out below does not apply to it.
   */
  isCreation: boolean;
  /**
   * True only when the request would actually move the target's role. A no-op
   * re-send of the current role is not a self-promotion.
   */
  roleChanges: boolean;
  /** Whether the request touches role / permissions / custom role at all. */
  changesAccess: boolean;
}

/**
 * Whether a membership grant is an escalation, and so must be refused.
 *
 * The rules, in the order they are decided:
 *
 * 1. **Owners are exempt.** They already hold the full set, so no grant can
 *    gain them anything, and the last-owner rule protects the business from an
 *    owner demoting themselves. This keeps an owner able to run their business.
 * 2. **Touching access at all needs `team.permissions.manage`.** Without this,
 *    `team.manage` — a key that exists for "add people and set their branches" —
 *    would be enough to hand out capabilities.
 * 3. **Owner is special.** Creating an owner, moving somebody *to* owner, or
 *    editing an owner requires the actor to *be* an owner. There is no
 *    capability that substitutes, because ownership is not a capability set.
 * 4. **Self role change is refused outright.** A handful of decisions are made
 *    on role *identity* rather than capability (autonomous-AI approval gates,
 *    the first-run wizard), so someone could move themselves to a role whose
 *    permission set is a strict subset of their current one and still cross one
 *    of those gates. `escalationRefusal` already reasoned this way for edits;
 *    the same reasoning covers the create path, where "self" cannot happen, and
 *    the invite path, where the actor is not yet a member.
 * 5. **Additions must be a subset of the actor's own capabilities.** Only
 *    additions are tested. Removing access is never an escalation, and checking
 *    the whole resulting set would wrongly block a manager from adjusting an
 *    accountant whose preset contains `ledger.post` the manager lacks. For a
 *    **creation** the whole set is new, so every permission in it is an
 *    addition — which is exactly the hole #854 P0.1 described.
 * 6. **A custom role must not out-rank its assigner.** The role's permissions
 *    are the grant, so they are tested the same way; plus an owner wearing a
 *    custom role is refused (ownership is the full set by construction and a
 *    custom role would be a silent demotion).
 *
 * Pure. `membership-authority.test.ts` pins the whole matrix.
 */
export function membershipGrantRefusal(
  check: MembershipGrantCheck,
): MembershipGrantRefusal | null {
  const { actor } = check;

  // 1.
  if (actor.actorRole === "owner") return null;

  // 2.
  if (check.changesAccess && !actor.actorPermissions.has(PERMISSIONS.teamPermissionsManage)) {
    return "permissions_manage_required";
  }

  // 3.
  if (check.nextRole === "owner") return "owner_only";

  // 4.
  if (check.isSelf && check.roleChanges) return "self_role_change";

  // 6.
  if (check.customRole) {
    // `nextRole === "owner"` already returned above, so a custom role can never
    // be attached to ownership by the time we get here.
    for (const permission of check.customRole.permissions) {
      if (isOwnerOnlyPermission(permission as Permission)) return "custom_role_beyond_actor";
      if (!actor.actorPermissions.has(permission as Permission)) {
        return "custom_role_beyond_actor";
      }
    }
  }

  // 5.
  if (!check.isCreation && check.currentPermissions) {
    for (const permission of check.nextPermissions) {
      if (check.currentPermissions.has(permission)) continue;
      if (!actor.actorPermissions.has(permission)) return "grants_beyond_actor";
    }
    return null;
  }

  // A creation grants the whole set at once — every member of it is an addition.
  for (const permission of check.nextPermissions) {
    if (!actor.actorPermissions.has(permission)) return "grants_beyond_actor";
  }
  return null;
}

/**
 * Persian explanation for a refusal, for the routes that surface it to a
 * person. Kept beside the rule so the two cannot disagree about what happened.
 */
export function grantRefusalMessage(reason: MembershipGrantRefusal): string {
  switch (reason) {
    case "permissions_manage_required":
      return "برای تغییر نقش یا دسترسی‌ها، مجوز «مدیریت دسترسی‌های تیم» لازم است.";
    case "owner_only":
      return "فقط مالک کسب‌وکار می‌تواند مالک اضافه یا ویرایش کند.";
    case "self_role_change":
      return "تغییر نقش خودتان مجاز نیست؛ از مالک کسب‌وکار بخواهید.";
    case "grants_beyond_actor":
      return "نمی‌توانید دسترسی‌ای بدهید که خودتان آن را ندارید.";
    case "custom_role_not_found":
      return "نقش سفارشی انتخاب‌شده در این کسب‌وکار فعال نیست.";
    case "custom_role_beyond_actor":
      return "این نقش سفارشی دسترسی‌هایی دارد که شما ندارید.";
    case "custom_role_not_for_owner":
      return "مالک کسب‌وکار نمی‌تواند نقش سفارشی داشته باشد.";
  }
}

/**
 * The effective permissions a membership *would* have after a grant, given the
 * role, the override payload and the custom role being assigned.
 *
 * One helper rather than three, because create/update/invite all need the same
 * answer and each previously computed it slightly differently — which is how
 * the invite path ended up not computing it at all.
 */
export function projectGrantedPermissions(input: {
  role: Role;
  overrides: PermissionOverrides;
  customRolePermissions?: readonly string[] | null;
}): Set<Permission> {
  return effectivePermissions(
    input.role,
    input.overrides,
    input.customRolePermissions ?? null,
  );
}

// ---------------------------------------------------------------------------
// Reasons (#854 P2.4)
// ---------------------------------------------------------------------------

/**
 * How long a stored reason may be. Generous for a sentence, short enough that
 * nobody can paste a document into an audit row.
 */
export const ACCESS_CHANGE_REASON_MAX = 500;

/** Below this, the text is not an explanation — it is a keypress. */
export const ACCESS_CHANGE_REASON_MIN = 8;

export type AccessChangeReasonResult =
  | { ok: true; reason: string }
  | { ok: false; error: "reason_required" | "reason_too_short" | "reason_too_long" };

/**
 * Issue #854 (P2.4) — a sensitive access change needs a reason a human wrote.
 *
 * The requirement was implemented as *permission gating* (only
 * `team.permissions.manage` may change capabilities, which is a different rule)
 * and the fields that existed were optional everywhere: `createTenantRole` and
 * `updateTenantRole` accept a `reason` and write `reason ?? null`, and
 * `PATCH /api/team/[id]` had no reason field at all. So the audit trail could
 * say *that* somebody gained `payments.refund` but never *why*, and "why" is the
 * only question an access review actually asks.
 *
 * Deliberately not a free-form "optional string" check:
 *
 *  - **Blank is not a reason.** Whitespace-only, or a keypress (`"."`, `"x"`,
 *    `"-"`), is refused by length rather than by a dictionary — any allowlist of
 *    valid words would be wrong the first time somebody had a real reason that
 *    was not on it.
 *  - **Length is capped**, and the cap is enforced on the stored value, not only
 *    on the request, so the column cannot grow an essay through a different
 *    caller.
 *  - **Nothing about the reason is optional.** The rule is applied by the
 *    function that decides, not by each route remembering to check.
 */
export function validateAccessChangeReason(reason: unknown): AccessChangeReasonResult {
  if (typeof reason !== "string") return { ok: false, error: "reason_required" };
  // Collapse internal runs and trim: "  needs   the  refund  flag  " is one
  // sentence, and storing its original spacing makes audit diffs noisy for no
  // gain.
  const normalized = reason.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return { ok: false, error: "reason_required" };
  if (normalized.length < ACCESS_CHANGE_REASON_MIN) return { ok: false, error: "reason_too_short" };
  if (normalized.length > ACCESS_CHANGE_REASON_MAX) return { ok: false, error: "reason_too_long" };
  return { ok: true, reason: normalized };
}

/**
 * Whether a change to a membership counts as an *access* change, and therefore
 * needs a reason.
 *
 * The list is the same one `PATCH /api/team/[id]` uses to decide that a request
 * has to hold `team.permissions.manage`: a capability change, a custom-role
 * assignment, and the role itself (which re-bases the whole permission preset).
 * A rename, a branch move or a suspension is an administrative edit, not an
 * access grant, and demanding prose for those would train people to type filler
 * — which is how "required reason" features die.
 *
 * Crucially the test is about what the *request changes*, not what it contains:
 * a `PATCH` that sends the same role and the same overrides back is not a grant,
 * and an admin pressing save twice should not have to justify themselves twice.
 */
export function isSensitiveAccessChange(input: {
  /** The fields the request named. */
  changesRole: boolean;
  changesCustomRole: boolean;
  changesPermissions: boolean;
}): boolean {
  return input.changesRole || input.changesCustomRole || input.changesPermissions;
}
