/**
 * The canonical authorization layer.
 *
 * ## Why this file exists
 *
 * The platform had grown four different answers to "may this request proceed",
 * and they did not agree with each other:
 *
 *   * `requireRole(...roles)` (auth.ts, ~500 call sites) — compared
 *     `session.role`, the role baked into the JWT at login, against a literal
 *     list. It checked `platform_users.token_version`, and nothing else.
 *   * `requirePermission(key)` (auth.ts, ~105 call sites) — re-read the
 *     membership from the database and checked `is_active`, the business's
 *     status and the *current* role, but did NOT check `token_version`.
 *   * `requireManager()` (setup-state.ts, ~57 call sites) — compared
 *     `session.role` against `"owner" | "manager"` and checked nothing at all.
 *   * `requireMember()` (auth.ts, ~22 call sites) — proved only that a token
 *     verified.
 *
 * The consequences were concrete, not theoretical:
 *
 *   1. A member who was **deactivated** kept full access to every
 *      `requireRole`- and `requireManager`-guarded endpoint — roughly 560 of
 *      them, including backup restore and the entire website admin — until
 *      their JWT expired, because neither guard ever looked at `is_active`.
 *   2. A member whose **role was changed** (manager → cashier) kept their old
 *      role's access on those same endpoints, because the guard read the role
 *      from the token rather than from the database.
 *   3. A **suspended business** kept serving those endpoints for the lifetime
 *      of already-issued tokens.
 *   4. `requirePermission`, the *newer* and supposedly stricter guard, was the
 *      only one that skipped the `token_version` check — so the password-reset
 *      kill switch worked on legacy endpoints and not on modern ones.
 *
 * Every one of those is a different guard forgetting a different check. The
 * fix is not to remember harder in 560 places; it is to have one place. This
 * file is that place, and the four helpers above are now thin wrappers over
 * it, so a security property added here is added everywhere at once.
 *
 * ## The evaluation order
 *
 * Authenticated identity → current tenant membership → membership active? →
 * tenant active? → role preset → member grants/revokes → effective permissions
 * → owner rules → branch scope → decision.
 *
 * Deny by default: every path that is not an explicit allow returns a denial
 * with a machine-readable reason.
 *
 * ## What it deliberately does not do
 *
 * It does not cache across requests. The whole point of re-reading the
 * membership is that a suspension, a role change or a revoked permission takes
 * effect on the member's *next request*; a cross-request cache would reinstate
 * exactly the staleness this file exists to remove. It memoises within a
 * single request only (see `requestMemo`), which is safe because a request
 * cannot outlive itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { NextResponse } from "next/server";
import type { Role, SessionPayload } from "./auth-edge";
import { query, withoutTenantScope } from "./db";
import {
  accessibleLocationIds,
  isLocationScope,
  type LocationAccessContext,
  type LocationScope,
} from "./location-access";
import {
  effectivePermissions,
  isOwnerOnlyPermission,
  parseOverrides,
  type Permission,
  type PermissionOverrides,
} from "./permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a request was refused. Returned to the client as `code` so the UI can
 * render a specific, localised message instead of a generic «دسترسی ندارید»,
 * and asserted on in tests so that a guard silently changing *which* check
 * refused is a visible diff.
 */
export type DenialCode =
  | "UNAUTHENTICATED"
  | "MEMBERSHIP_NOT_FOUND"
  | "MEMBERSHIP_INACTIVE"
  | "SESSION_REVOKED"
  | "BUSINESS_NOT_ACTIVE"
  | "MISSING_PERMISSION"
  | "MISSING_ROLE"
  | "OWNER_ONLY"
  | "LOCATION_FORBIDDEN";

/** The membership behind the request, as the database holds it *right now*. */
export interface MembershipContext {
  /** users.id — the membership acting, not the person. */
  userId: string;
  businessId: string;
  /** The current database role. The token's copy can lag; this one cannot. */
  role: Role;
  isActive: boolean;
  businessStatus: string;
  overrides: PermissionOverrides;
  permissions: Set<Permission>;
  locationScope: LocationScope;
  homeLocationId: string | null;
  /** Resolved lazily — only the checks that need branches pay for the query. */
  assignedLocationIds: () => Promise<string[]>;
}

export interface AccessAllowed {
  ok: true;
  session: SessionPayload;
  membership: MembershipContext;
}

export interface AccessDenied {
  ok: false;
  code: DenialCode;
  /** The permission that was missing, when the denial was a permission check. */
  permission?: Permission;
  status: 401 | 403;
}

export type AccessDecision = AccessAllowed | AccessDenied;

export interface AuthorizeRequest {
  /** The capability being exercised. The normal case. */
  permission?: Permission;
  /** Every listed capability is required. */
  allPermissions?: readonly Permission[];
  /**
   * Any one of these permissions is enough. For endpoints that serve both a
   * reader and an editor — `team.view` OR `team.manage` — where demanding the
   * narrower key alone would lock out the member who holds only the wider one.
   */
  anyPermission?: readonly Permission[];
  /**
   * Role identity, when the role itself is semantically required rather than
   * standing in for a capability. Every use must be justified in
   * docs/authorization/ARCHITECTURE.md — the audit is what stops this becoming
   * a back door to the pattern the refactor removed.
   */
  roles?: readonly Role[];
  /**
   * A branch the request names. Checked against the member's branch scope AND
   * against the business, so a client-supplied id from another tenant is
   * refused rather than silently accepted.
   */
  locationId?: string | null;
}

// ---------------------------------------------------------------------------
// Request-scoped memoisation
// ---------------------------------------------------------------------------

/**
 * One membership read per request, not one per guard call.
 *
 * A route handler commonly authorizes twice (a guard at the top, a finer check
 * before a specific action) and server components several times as the page
 * builds. Without this, each of those is a round trip. The store is entered by
 * `withAuthorizationMemo`, which `withTenantScope` wraps every handler in; when
 * no store is active — a background job, a unit test — the read simply runs
 * uncached, which is correct, just slower.
 *
 * Scoped to the request, so it cannot delay a revocation: the next request
 * re-reads.
 */
const memoStore = new AsyncLocalStorage<Map<string, Promise<MembershipContext | null>>>();

export function withAuthorizationMemo<T>(fn: () => Promise<T>): Promise<T> {
  return memoStore.run(new Map(), fn);
}

function requestMemo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = memoStore.getStore();
  if (!store) return load();
  const existing = store.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = load() as Promise<MembershipContext | null>;
  store.set(key, promise);
  return promise as Promise<T>;
}

// ---------------------------------------------------------------------------
// Loading the membership
// ---------------------------------------------------------------------------

interface MembershipRow extends Record<string, unknown> {
  role: Role;
  permissions: unknown;
  is_active: boolean;
  membership_status: string | null;
  location_id: string | null;
  location_scope: unknown;
  business_status: string;
  custom_role_permissions: string[] | null;
  deployment_profile: string | null;
  site_permission_denies: string[] | null;
  site_allowed_location_ids: string[] | null;
  is_locally_suspended: boolean | null;
  local_login_locked: boolean | null;
}

/**
 * The membership behind a session, read fresh.
 *
 * Runs under `withoutTenantScope` because a guard is frequently the *first*
 * thing a request does — before `withTenantScope` has established the ambient
 * scope — and because the question "is this membership still valid" is asked
 * about a tenant rather than from inside one. The query is nevertheless
 * explicitly keyed on BOTH `users.id` and `users.business_id` from the session,
 * so it can only ever return the one row the session already names: the
 * unscoped read widens nothing.
 */
export async function loadMembership(
  session: SessionPayload,
): Promise<MembershipContext | null> {
  return requestMemo(`${session.sub}:${session.businessId}`, async () => {
    const { rows } = await withoutTenantScope("authorization-membership", () =>
      query<MembershipRow>(
        `SELECT u.role,
                u.permissions,
                u.is_active,
                u.membership_status::text AS membership_status,
                u.location_id,
                u.location_scope::text AS location_scope,
                b.status::text          AS business_status,
                CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) ELSE NULL END AS custom_role_permissions,
                dp.value->>'profile' AS deployment_profile,
                CASE WHEN sma.id IS NOT NULL THEN ARRAY(SELECT jsonb_array_elements_text(sma.permission_denies)) ELSE NULL END AS site_permission_denies,
                sma.allowed_location_ids AS site_allowed_location_ids,
                sma.is_locally_suspended, sma.local_login_locked
           FROM users u
           JOIN businesses b ON b.id = u.business_id
           LEFT JOIN tenant_roles tr ON tr.id = u.custom_role_id AND tr.business_id = u.business_id
           LEFT JOIN settings dp ON dp.business_id=u.business_id AND dp.location_id IS NULL AND dp.key='deployment.profile'
           LEFT JOIN settings sc ON sc.business_id=u.business_id AND sc.location_id IS NULL AND sc.key='server_sync.config'
           LEFT JOIN site_member_access sma ON sma.business_id=u.business_id AND sma.user_id=u.id
             AND sma.site_device_id=(sc.value->>'siteDeviceId')::uuid
          WHERE u.id = $1 AND u.business_id = $2`,
        [session.sub, session.businessId],
      ),
    );

    const row = rows[0];
    if (!row) return null;

    const overrides = parseOverrides(row.permissions);
    const isHybrid = row.deployment_profile === "hybrid";
    const permissions = effectivePermissions(row.role, overrides, row.custom_role_permissions);
    if (isHybrid) for (const denied of row.site_permission_denies ?? []) permissions.delete(denied as Permission);
    const active = row.is_active && (row.membership_status == null || row.membership_status === "active")
      && !(isHybrid && (row.is_locally_suspended || row.local_login_locked));
    const canonicalScope = isLocationScope(row.location_scope) ? row.location_scope : "home";
    const hasSiteLocationRestriction = isHybrid && row.site_allowed_location_ids !== null;
    return {
      userId: session.sub,
      businessId: session.businessId,
      role: row.role,
      isActive: active,
      businessStatus: row.business_status,
      overrides,
      permissions,
      locationScope: hasSiteLocationRestriction ? "selected" : canonicalScope,
      homeLocationId: row.location_id,
      assignedLocationIds: () => loadAssignedLocations(session.sub, session.businessId, canonicalScope, row.location_id, hasSiteLocationRestriction ? row.site_allowed_location_ids : null),
    } satisfies MembershipContext;
  });
}

async function loadAssignedLocations(userId: string, businessId: string, canonicalScope: LocationScope = "selected", homeLocationId: string | null = null, siteAllowed: string[] | null = null): Promise<string[]> {
  return requestMemo(`locations:${userId}:${canonicalScope}:${siteAllowed?.join(",") ?? "all"}`, async () => {
    const { rows } = await withoutTenantScope("authorization-membership", () =>
      query<{ location_id: string }>(
        // Joined to `locations` on business_id so a `user_locations` row that
        // somehow points at another tenant's branch contributes nothing. Branch
        // access is never taken on the assignment row's word alone.
        `SELECT ul.location_id
           FROM user_locations ul
           JOIN locations l ON l.id = ul.location_id AND l.business_id = $2
          WHERE ul.user_id = $1 AND l.is_active`,
        [userId, businessId],
      ),
    );
    let canonical = rows.map((r) => r.location_id);
    if (canonicalScope === "all") {
      const all = await withoutTenantScope("authorization-membership", () => query<{ id: string }>(
        "SELECT id FROM locations WHERE business_id=$1 AND is_active", [businessId]));
      canonical = all.rows.map((r) => r.id);
    } else if (canonicalScope === "home") canonical = homeLocationId ? [homeLocationId] : [];
    else if (canonicalScope === "none") canonical = [];
    if (siteAllowed !== null) { const allowed = new Set(siteAllowed); canonical = canonical.filter((id) => allowed.has(id)); }
    return canonical;
  });
}

/**
 * Whether the platform identity behind this session has been revoked.
 *
 * `platform_users.token_version` is bumped by a password reset, an explicit
 * "sign out everywhere" and the security kill switch. `requireRole` checked
 * this and `requirePermission` did not, which is why it is here: the canonical
 * path must hold the union of the properties the guards it replaces held, never
 * the intersection.
 *
 * PIN-only staff have no `platformUserId` and legitimately skip this — their
 * revocation is the `employee_sessions` row, re-checked in `getSession()`.
 */
async function platformIdentityRevoked(session: SessionPayload): Promise<boolean> {
  if (!session.platformUserId) return false;
  if (!session.tokenVersion) return true;
  const { rows } = await withoutTenantScope("authorization-membership", () =>
    query<{ token_version: number; is_active: boolean }>(
      `SELECT token_version, is_active FROM platform_users WHERE id = $1`,
      [session.platformUserId],
    ),
  );
  return rows.length === 0 || !rows[0].is_active || rows[0].token_version !== session.tokenVersion;
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

/**
 * The one decision function. Everything else in the codebase that asks "may
 * this happen" should end up here.
 *
 * Order matters and is the order of the architecture diagram: identity, then
 * membership, then tenant, then capability, then scope. An earlier failure
 * hides a later one on purpose — a suspended business should answer
 * "business_not_active", not "you lack ledger.post".
 */
export async function authorize(
  session: SessionPayload | null,
  request: AuthorizeRequest = {},
): Promise<AccessDecision> {
  if (!session) return { ok: false, code: "UNAUTHENTICATED", status: 401 };

  // 1. Is the identity behind the token still valid?
  if (await platformIdentityRevoked(session)) {
    return { ok: false, code: "SESSION_REVOKED", status: 401 };
  }

  // 2. Does the membership still exist, and is it usable?
  const membership = await loadMembership(session);
  if (!membership) return { ok: false, code: "MEMBERSHIP_NOT_FOUND", status: 401 };
  if (!membership.isActive) return { ok: false, code: "MEMBERSHIP_INACTIVE", status: 401 };

  // 3. Is the tenant itself usable? Suspended and archived businesses stop
  //    serving immediately rather than at token expiry.
  if (membership.businessStatus !== "active") {
    return { ok: false, code: "BUSINESS_NOT_ACTIVE", status: 403 };
  }

  // The session handed onward always carries the *database* role, never the
  // token's. A handler that branches on `session.role` after a guard therefore
  // branches on current truth even if the token predates a role change.
  const current: SessionPayload = { ...session, role: membership.role };

  // 4. Role identity, where it is genuinely required.
  if (request.roles && !request.roles.includes(membership.role)) {
    return { ok: false, code: "MISSING_ROLE", status: 403 };
  }

  // 5. Capability.
  if (request.permission && !membership.permissions.has(request.permission)) {
    return {
      ok: false,
      code: isOwnerOnlyPermission(request.permission) ? "OWNER_ONLY" : "MISSING_PERMISSION",
      permission: request.permission,
      status: 403,
    };
  }
  if (request.allPermissions && request.allPermissions.length > 0) {
    const missing = request.allPermissions.find((p) => !membership.permissions.has(p));
    if (missing) {
      return {
        ok: false,
        code: isOwnerOnlyPermission(missing) ? "OWNER_ONLY" : "MISSING_PERMISSION",
        permission: missing,
        status: 403,
      };
    }
  }
  if (request.anyPermission && request.anyPermission.length > 0) {
    const held = request.anyPermission.some((p) => membership.permissions.has(p));
    if (!held) {
      return {
        ok: false,
        code: "MISSING_PERMISSION",
        permission: request.anyPermission[0],
        status: 403,
      };
    }
  }

  // 6. Branch scope, when the request names a branch.
  if (request.locationId) {
    if (!(await canActInLocation(membership, request.locationId))) {
      return { ok: false, code: "LOCATION_FORBIDDEN", status: 403 };
    }
  }

  return { ok: true, session: current, membership };
}

/**
 * Whether this membership may act in this branch.
 *
 * Verifies the branch belongs to the membership's own business before asking
 * whether the scope reaches it, so a client-supplied `locationId` from another
 * tenant is refused at the tenant boundary rather than at the scope check —
 * the two are different failures and conflating them is how a cross-tenant id
 * ends up merely "not in your list" instead of "not yours".
 */
export async function canActInLocation(
  membership: MembershipContext,
  locationId: string,
): Promise<boolean> {
  const { rows } = await withoutTenantScope("authorization-membership", () =>
    query<{ id: string }>(
      `SELECT id FROM locations WHERE id = $1 AND business_id = $2 AND is_active`,
      [locationId, membership.businessId],
    ),
  );
  if (rows.length === 0) return false;

  const ctx: LocationAccessContext = {
    role: membership.role,
    defaultLocationId: membership.homeLocationId,
    assignedLocationIds:
      membership.locationScope === "selected" ? await membership.assignedLocationIds() : [],
    locationScope: membership.locationScope,
  };
  return accessibleLocationIds(ctx, [locationId]).includes(locationId);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The standard refusal body.
 *
 * `error` stays `"unauthorized"` / `"forbidden"` because a large amount of
 * existing client code and a large number of existing tests branch on exactly
 * those two strings; changing them would be a breaking API change dressed up
 * as a refactor. `code` and `permission` are additive, and are what new code
 * and the localised UI messages read.
 *
 * Nothing internal leaks: the client learns *which capability* it lacks (it
 * needs that to render «شما مجوز ... را ندارید» and to decide whether to show a
 * request-access affordance) but never the role, the preset, or why.
 */
export function denialResponse(denied: AccessDenied): NextResponse {
  return NextResponse.json(
    {
      // `business_suspended` is preserved verbatim: the dashboard shell maps
      // exactly that string to «دسترسی این کسب‌وکار موقتاً معلق شده است.».
      error:
        denied.code === "BUSINESS_NOT_ACTIVE"
          ? "business_suspended"
          : denied.status === 401
            ? "unauthorized"
            : "forbidden",
      code: denied.code,
      ...(denied.permission ? { permission: denied.permission } : {}),
    },
    { status: denied.status },
  );
}
