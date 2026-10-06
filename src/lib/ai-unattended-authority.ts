/**
 * Issue #812 §13 — the central authority gate for unattended AI writes.
 *
 * An autopilot/coworker run stores `authorized_by`: the owner or manager who
 * switched that category on. Until now the *existence* of that id was treated
 * as enough authority for every later run, which is wrong in a way that matters:
 * the member can be suspended, their role can change, a permission can be
 * revoked, a branch can be taken away, or the whole app can be switched off —
 * and the scheduled run would still write.
 *
 * Stored authorization is therefore **revocable delegation**, and this module
 * is the one place that resolves it. Immediately before an unattended write it:
 *
 *   1. resolves the authorizing user
 *   2. verifies the user/member still exists and is active
 *   3. resolves their CURRENT role + permission overrides (never a cached copy)
 *   4. resolves their current business/location scope
 *   5. resolves the required action permission from the canonical
 *      `AI_ACTION_PERMISSION_MAP`
 *   6. verifies the business is active and the AI feature is still enabled
 *
 * and only then returns `ok: true`. Anything else returns a machine-readable
 * denial the caller must honour by NOT applying the action, deferring/revoking
 * the run with that reason, and keeping the audit evidence.
 *
 * Deliberately NOT imported here: any executor. One gate before executor
 * dispatch, rather than the same seven checks re-spelled inside every worker —
 * a duplicated check is a check that silently rots.
 */
import { query, withoutTenantScope } from "./db";
import {
  effectivePermissions,
  parseOverrides,
  type Permission,
} from "./permissions";
import { aiActionPermission } from "./ai-capabilities";
import type { ActionType } from "./ai";
import { isFeatureEnabled } from "./features";
import { accessibleLocationIds, isLocationScope, type LocationScope } from "./location-access";

/** Machine-readable reason an unattended write was refused. */
export type UnattendedDenialCode =
  | "no_authorizing_user"
  | "authorizer_not_found"
  | "authorizer_inactive"
  | "business_not_active"
  | "missing_permission"
  | "location_forbidden"
  | "feature_unavailable";

/** Persian explanation for each denial, for the run log and the audit row. */
export const UNATTENDED_DENIAL_FA: Record<UnattendedDenialCode, string> = {
  no_authorizing_user: "هیچ کاربر مجازی برای این اجرای خودکار ثبت نشده است.",
  authorizer_not_found: "کاربری که مجوز این اجرا را داده بود دیگر وجود ندارد.",
  authorizer_inactive: "کاربر مجوزدهنده غیرفعال یا معلق شده است.",
  business_not_active: "کسب‌وکار فعال نیست.",
  missing_permission: "مجوز فعلی کاربر مجوزدهنده برای این عملیات کافی نیست.",
  location_forbidden: "شعبهٔ هدف در دسترس کاربر مجوزدهنده نیست.",
  feature_unavailable: "قابلیت هوش مصنوعی برای این کسب‌وکار فعال نیست.",
};

export interface UnattendedAuthorityVerdict {
  ok: boolean;
  /** The authorizing user, when one was stored. Never invented. */
  userId: string | null;
  /** Their CURRENT effective permissions — the set the write is checked against. */
  permissions: ReadonlySet<Permission>;
  reasonCode: UnattendedDenialCode | null;
  reasonFa: string | null;
  /** The branch the write targets, when the caller resolved one. */
  targetLocationId: string | null;
}

interface AuthorizerRow extends Record<string, unknown> {
  role: string;
  permissions: unknown;
  is_active: boolean;
  membership_status: string | null;
  location_id: string | null;
  location_scope: unknown;
  business_status: string;
  custom_role_permissions: string[] | null;
}

function deny(
  reasonCode: UnattendedDenialCode,
  userId: string | null,
  targetLocationId: string | null = null,
): UnattendedAuthorityVerdict {
  return {
    ok: false,
    userId,
    permissions: new Set<Permission>(),
    reasonCode,
    reasonFa: UNATTENDED_DENIAL_FA[reasonCode],
    targetLocationId,
  };
}

/**
 * The member's explicit branch assignments, read fresh. A `user_locations`
 * row that points at another tenant's branch contributes nothing — branch
 * access is never taken on the assignment row's word alone.
 */
async function assignedLocationIdsFor(
  userId: string,
  businessId: string,
  scope: LocationScope,
  homeLocationId: string | null,
): Promise<string[]> {
  if (scope === "home") return homeLocationId ? [homeLocationId] : [];
  if (scope === "none") return [];
  const { rows } = await withoutTenantScope("ai-unattended-authority", () =>
    query<{ location_id: string }>(
      `SELECT ul.location_id
         FROM user_locations ul
         JOIN locations l ON l.id = ul.location_id AND l.business_id = $2
        WHERE ul.user_id = $1 AND l.is_active`,
      [userId, businessId],
    ),
  );
  return rows.map((row) => row.location_id);
}

/**
 * Resolves the CURRENT authority behind a stored `authorized_by` for one action.
 *
 * Never throws for an authorization problem — every failure is a verdict, so a
 * caller cannot accidentally turn "the member was suspended" into an exception
 * that a generic catch swallows into an applied write. It only throws for a
 * genuine infrastructure failure, which the caller's own error path handles.
 */
export async function verifyUnattendedAuthority(input: {
  businessId: string;
  authorizedByUserId: string | null;
  actionType: ActionType;
  /** The branch the write will land in, when the executor resolved one. */
  targetLocationId?: string | null;
}): Promise<UnattendedAuthorityVerdict> {
  const targetLocationId = input.targetLocationId ?? null;

  // Step 1 — a run with no stored authorizer was never delegated at all.
  if (!input.authorizedByUserId) {
    return deny("no_authorizing_user", null, targetLocationId);
  }

  // Step 6 (feature) is checked before the per-member reads so a business whose
  // AI was switched off is refused without pretending to authorize anything.
  if (!(await isFeatureEnabled(input.businessId, "ai"))) {
    return deny("feature_unavailable", input.authorizedByUserId, targetLocationId);
  }

  // Steps 2–4 — read the membership and the business fresh, keyed on BOTH ids
  // so the unscoped read can only ever return the one row it names.
  const membership = await withoutTenantScope("ai-unattended-authority", () =>
    query<AuthorizerRow>(
      `SELECT u.role::text AS role,
              u.permissions,
              u.is_active,
              u.membership_status::text AS membership_status,
              u.location_id,
              u.location_scope::text AS location_scope,
              b.status::text AS business_status,
              CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) ELSE NULL END AS custom_role_permissions
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         LEFT JOIN tenant_roles tr ON tr.id = u.custom_role_id AND tr.business_id = u.business_id
        WHERE u.id = $1 AND u.business_id = $2`,
      [input.authorizedByUserId, input.businessId],
    ),
  );
  const row = membership.rows[0];
  if (!row) return deny("authorizer_not_found", input.authorizedByUserId, targetLocationId);

  const active =
    row.is_active && (row.membership_status == null || row.membership_status === "active");
  if (!active) return deny("authorizer_inactive", input.authorizedByUserId, targetLocationId);
  if (row.business_status !== "active") {
    return deny("business_not_active", input.authorizedByUserId, targetLocationId);
  }

  // Step 3 — the CURRENT effective set: role preset, then this member's own
  // grants/revokes, then any active custom role. No cache, no stored copy.
  const permissions = effectivePermissions(
    row.role as Parameters<typeof effectivePermissions>[0],
    parseOverrides(row.permissions),
    row.custom_role_permissions,
  );

  // Step 5 — the canonical action-permission map decides what this write needs.
  // An action with no entry fails closed: an unmapped action is not authorized.
  const required = aiActionPermission(input.actionType);
  if (!required || !permissions.has(required)) {
    return deny("missing_permission", input.authorizedByUserId, targetLocationId);
  }

  // Step 4 — the branch the write lands in must still be one this member may
  // reach, under their CURRENT location scope.
  if (targetLocationId) {
    const scope: LocationScope = isLocationScope(row.location_scope) ? row.location_scope : "home";
    const { rows: locationRows } = await withoutTenantScope("ai-unattended-authority", () =>
      query<{ id: string }>(
        `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at`,
        [input.businessId],
      ),
    );
    const reachable = accessibleLocationIds(
      {
        role: row.role as Parameters<typeof accessibleLocationIds>[0]["role"],
        locationScope: scope,
        defaultLocationId: row.location_id,
        assignedLocationIds: await assignedLocationIdsFor(
          input.authorizedByUserId,
          input.businessId,
          scope,
          row.location_id,
        ),
      },
      locationRows.map((location) => location.id),
    );
    if (!reachable.includes(targetLocationId)) {
      return deny("location_forbidden", input.authorizedByUserId, targetLocationId);
    }
  }

  return {
    ok: true,
    userId: input.authorizedByUserId,
    permissions,
    reasonCode: null,
    reasonFa: null,
    targetLocationId,
  };
}

/**
 * True when a verdict's denial should DEFER the run (keep it for a human)
 * rather than hard-fail it. A revoked member is a configuration change the
 * owner can undo, so the run waits; a missing authorizer never had a
 * delegation and is failed outright.
 */
export function isDeferrableDenial(verdict: UnattendedAuthorityVerdict): boolean {
  return (
    !verdict.ok &&
    verdict.reasonCode !== null &&
    verdict.reasonCode !== "no_authorizing_user"
  );
}
