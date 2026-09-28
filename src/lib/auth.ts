import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionHours,
  signSession,
  verifySession,
  type Role,
  type SessionPayload,
} from "./auth-edge";
import { appForApiPath } from "./app-availability";
import { isAppAvailable } from "./app-availability-service";
import { query, withoutTenantScope } from "./db";
import { sessionStatus } from "./employee";
import { featureForApiPath, isFeatureEnabled } from "./features";
import { isModuleEnabled } from "./industry-guard";
import { moduleForApiPath } from "./industry-profile";
import { holooGuardedEntityType, holooLocalIdFromPath, holooOwnedIds, HOLOO_GUARDED_PREFIXES } from "./integrations/holoo/holoo-ownership";
import { PERMISSIONS, type Permission } from "./permissions";
import { authorize, denialResponse, withAuthorizationMemo } from "./authorize";
import { activeGrant } from "./platform-service";
import { platformAudit } from "./platform-auth";
import { businessScope, enterTenantScope, NO_SCOPE, runInTenantScope } from "./tenant-context";
import { capabilityForApiPath, capabilityHttpStatus, resolveCapability } from "./capabilities";
import { readDeploymentProfile } from "./deployment-mode";
import { deploymentRole } from "./deployment-role";
import { isSupportSessionExitRequest, supportMutationAllowed } from "./support-session";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Phase 17 security review — `imp.grantId`'s own doc comment (auth-edge.ts)
 * says it is "re-checked live on the server, never trusted alone," but
 * nothing ever actually called `activeGrant` outside its own definition:
 * ending or revoking an impersonation window stamped the grant row but the
 * already-minted tenant token kept working, completely unaffected, until its
 * own SESSION_HOURS expiry. This is what makes the revoke "kill switch"
 * (Phase 15's exit criterion) actually kill something — a session whose
 * grant is no longer live is treated exactly like an invalid token.
 */
async function checkImpersonation(session: SessionPayload | null): Promise<SessionPayload | null> {
  if (!session?.imp) return session;
  const grant = await activeGrant(session.imp.grantId, session.imp.adminId, session.businessId);
  if (!grant || grant.mode !== session.imp.mode) return null;
  return { ...session, imp: { ...session.imp, allowedCapabilities: grant.allowedCapabilities } };
}

/**
 * Phase 20 Wave 2 — the counterpart of checkImpersonation for
 * `employeeSessionId`: a JWT alone is not enough to keep using a PIN login
 * once its `employee_sessions` row has been revoked or has expired, so that
 * row is re-checked live on every request rather than trusted for the
 * token's full 12-hour lifetime. Runs with `withoutTenantScope` for the same
 * structural reason `checkImpersonation`'s `activeGrant` call does: this is
 * called from `getSession()` before `enterTenantScope` has run for the
 * request, so there is no ambient tenant scope yet to run an ordinary query
 * in — see the "employee-session-auth" entry in db.ts's `withoutTenantScope`
 * doc comment.
 */
async function checkEmployeeSession(session: SessionPayload | null): Promise<SessionPayload | null> {
  if (!session?.employeeSessionId) return session;
  const sessionId = session.employeeSessionId;

  const status = await withoutTenantScope("employee-session-auth", async () => {
    const { rows } = await query<{ expires_at: Date; revoked_at: Date | null }>(
      `SELECT expires_at, revoked_at FROM employee_sessions WHERE id = $1 AND business_id = $2`,
      [sessionId, session.businessId],
    );
    if (!rows[0]) return null;
    return sessionStatus({ expiresAt: rows[0].expires_at, revokedAt: rows[0].revoked_at });
  });
  if (status !== "active") return null;

  // Best-effort activity marker for the sessions list — never blocks the request.
  void withoutTenantScope("employee-session-auth", () =>
    query(`UPDATE employee_sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]),
  ).catch(() => {});

  return session;
}

// Re-exported so the ~93 route handlers that import these from "@/lib/auth"
// keep working; the definitions live in auth-edge.ts because src/middleware.ts
// needs them without dragging in the tenant context or the database pool.
export {
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionHours,
  signSession,
  verifySession,
  type Role,
  type SessionPayload,
};

/**
 * Reads and verifies the session cookie, and — since Phase 12 — establishes
 * the tenant context for the rest of the request.
 *
 * The context is set on EVERY call, including to `none` when there is no valid
 * session. That unconditional set is what makes it safe to establish the scope
 * here rather than wrapping every handler body: a request can never inherit
 * whatever business the previous request on this worker happened to be for.
 * See the header comment in src/lib/tenant-context.ts.
 *
 * Server components / route handlers only.
 */
export async function resolveSessionFromToken(token: string | null | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  return checkEmployeeSession(await checkImpersonation(await verifySession(token)));
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const session = await resolveSessionFromToken(token);

  enterTenantScope(
    session ? businessScope(session.businessId, session.locationId, session.sub) : NO_SCOPE,
  );

  return session;
}

/**
 * The support-session claims on this request's tenant cookie, verified for
 * signature and expiry only — *not* for whether the grant is still live.
 *
 * Exactly one caller needs the unvalidated view: ending the session. Leaving
 * must still work (and still clear the cookie) after the grant has expired or
 * been revoked elsewhere, which is precisely when `getSession()` returns null.
 * The ids come from a token this server signed, never from the request body,
 * so a browser cannot point the close at somebody else's grant.
 */
export async function supportSessionClaims(): Promise<(SessionPayload & { imp: NonNullable<SessionPayload["imp"]> }) | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const claims = token ? await verifySession(token) : null;
  return claims?.imp ? { ...claims, imp: claims.imp } : null;
}

/** A support cookie whose grant is over: the page should send the operator back to the console, not to /login. */
export async function endedSupportSessionClaims() {
  const claims = await supportSessionClaims();
  if (!claims) return null;
  const live = await activeGrant(claims.imp.grantId, claims.imp.adminId, claims.businessId);
  return live && live.mode === claims.imp.mode ? null : claims;
}

/**
 * Wraps a route handler so its tenant scope survives for its *entire*
 * execution, including every query any guard or service call makes along the
 * way — not just the moment `getSession()` runs.
 *
 * `getSession()`'s own `enterTenantScope()` call (via `AsyncLocalStorage.enterWith`)
 * only reliably affects code that runs before this request's continuation is
 * next interrupted by a concurrent `AsyncLocalStorage.run()` elsewhere in the
 * process — and the background ticks in `server.ts` (rollup, backup,
 * server-sync) call `withTenant()`/`withoutTenantScope()` (`.run()`) on a timer
 * for the whole lifetime of the server. The instant one of those fires while
 * this request is in flight, `enterWith()`'s effect is lost for the rest of
 * the request: reads silently come back empty (RLS fails closed) and writes
 * throw a row-level-security violation — non-deterministically, since it
 * depends on exactly when a tick happens to interleave.
 *
 * `run()` does not have this problem — establishing the scope for a route
 * handler's whole execution here, once, up front, is what everything else
 * (`getSession()`'s later `enterTenantScope()` calls included) then correctly
 * inherits for the rest of the request, tick interleaving or not. Every route
 * handler that reaches `getSession()`, `requireRole()`, `requirePermission()`,
 * or `requireManager()` needs to be wrapped in this (or the platform
 * equivalent, `withPlatformScope` in platform-auth.ts) for that reason — see
 * docs/phases/Phase-17-Feature-Gating-Hardening.md.
 */
export function withTenantScope<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    const unvalidatedSession = token ? await verifySession(token) : null;
    const session = await checkImpersonation(unvalidatedSession);
    const scope = session
      ? businessScope(session.businessId, session.locationId, session.sub)
      : NO_SCOPE;
    return runInTenantScope(scope, () => withAuthorizationMemo(async () => {
      const request = args[0] as NextRequest | undefined;

      if (session?.imp && request && MUTATING_METHODS.has(request.method) && !supportMutationAllowed(session, request.method, request.nextUrl.pathname)) {
        return NextResponse.json(
          { error: session.imp.mode === "read_only" ? "impersonation_read_only" : "support_capability_denied" },
          { status: 403 },
        );
      }

      // Phase 17 — feature-flag enforcement. Only checked once a session
      // exists: an unauthenticated request still gets its ordinary 401 from
      // the handler's own requireRole/requirePermission call, unchanged.
      if (session) {
        const pathname = request?.nextUrl.pathname ?? "";
        // Deployment support is independent from plan entitlement. Resolve it
        // first so Local-only says "connect to cloud", never "upgrade plan".
        const capability = capabilityForApiPath(pathname);
        const deployment = capability ? await readDeploymentProfile(session.businessId) : null;
        if (capability && deployment) {
          const resolved = resolveCapability(capability, { deployment: deployment.profile, runtimeRole: deploymentRole() });
          if (!resolved.available) {
            return NextResponse.json(
              { error: "capability_unavailable", code: resolved.code, capability, status: resolved.status },
              { status: capabilityHttpStatus(resolved.code) },
            );
          }
        }

        const flag = request ? featureForApiPath(pathname) : null;
        if (flag && !(await isFeatureEnabled(session.businessId, flag))) {
          return NextResponse.json(
            { error: "feature_disabled", code: "FEATURE_NOT_IN_PLAN", flag },
            { status: 403 },
          );
        }

        // Phase 25 — the same enforcement, keyed on the industry's module set
        // rather than a togglable flag. A feature flag is something an
        // operator turns off; a module a trade does not have is something it
        // never had, so a jewellery business asking /api/tables is refused
        // here rather than relying on the nav not linking to it.
        const module = request ? moduleForApiPath(request.nextUrl.pathname) : null;
        if (module && !(await isModuleEnabled(session.businessId, module))) {
          return NextResponse.json({ error: "module_unavailable", module }, { status: 403 });
        }

        // App availability — the third axis, and the newest (migration 0128).
        // A flag answers "is this business entitled to it", a module "does this
        // trade have it at all"; this answers "is the app working right now" —
        // «به‌زودی», «در حال تعمیر», «غیرفعال». Refused here rather than left to
        // the UI for the same reason the two guards above are: an app that is
        // down for maintenance must be down for the fetch a page fires on
        // mount, not merely badged in the sidebar. `beta` is usable and so
        // never reaches this branch.
        const app = request ? appForApiPath(request.nextUrl.pathname) : null;
        if (app && !(await isAppAvailable(session.businessId, app))) {
          return NextResponse.json({ error: "app_unavailable", app }, { status: 503 });
        }

        // Phase 26 Wave 7 — Holoo ownership guard. A row the companion mirror
        // pulled from Holoo is owned by Holoo: mutating it from this app would
        // fork the books away from Holoo. Answered from integration_mappings,
        // enforced here — one guard in one file, no CRUD route edited. When the
        // companion flag is off this short-circuits before any lookup.
        if (
          request &&
          MUTATING_METHODS.has(request.method) &&
          (await isFeatureEnabled(session.businessId, "holoo_companion"))
        ) {
          const entityType = holooGuardedEntityType(request.nextUrl.pathname);
          if (entityType) {
            const prefix = HOLOO_GUARDED_PREFIXES.find(
              ([p]) => request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(`${p}/`),
            )![0];
            const localId = holooLocalIdFromPath(request.nextUrl.pathname, prefix);
            if (localId) {
              const owned = await holooOwnedIds(session.businessId, entityType, [localId]);
              if (owned.has(localId)) {
                return NextResponse.json({ error: "holoo_owned", entityType }, { status: 409 });
              }
            }
          }
        }
      }

      // Phase 17 security review — "every impersonated action tagged in
      // platform_audit_log" (Phase 15's stated goal) previously only covered
      // the start/end/revoke of a grant, not what was actually done with it.
      // read_only mode never reaches here for a mutating method (middleware
      // 403s it first), so this fires only for the higher-trust `full` mode —
      // exactly the case that can change a customer's data.
      if (
        session?.imp &&
        request &&
        MUTATING_METHODS.has(request.method) &&
        !isSupportSessionExitRequest(request.method, request.nextUrl.pathname)
      ) {
        await platformAudit({
          adminId: session.imp.adminId,
          businessId: session.businessId,
          action: "impersonation.request",
          entity: null,
          entityId: null,
          payload: { method: request.method, path: request.nextUrl.pathname },
        });
      }

      return handler(...args);
    }));
  };
}

type GuardResult =
  | { session: SessionPayload; error: null; membership: import("./authorize").MembershipContext }
  | { session: null; error: NextResponse; membership?: never };

/**
 * Session guard with no role restriction — any signed-in member of a business.
 *
 * Deliberately narrow in what it may be used for: endpoints where every member
 * acts only on **their own** rows, so the role that would gate the screen has
 * nothing left to gate. Phase 35's notification devices, rules and inbox are
 * the case it exists for — a kitchen member choosing which of their own alerts
 * reach their own phone is not a manager-level act, and listing all six roles
 * to say "everyone" reads as an oversight rather than as a decision.
 *
 * The handler is still responsible for scoping every query to
 * `session.sub`; this guard proves who is asking, not what they may touch.
 */
export async function requireMember(): Promise<GuardResult> {
  // Goes through `authorize()` with no capability requirement so that "any
  // signed-in member" still means an *active* member of an *active* business
  // holding a *non-revoked* identity. Before the consolidation it meant only
  // "a token that verifies", which let a deactivated member keep managing
  // their notification rules and reading their own inbox.
  const decision = await authorize(await getSession());
  if (!decision.ok) return { session: null, error: denialResponse(decision) };
  return { session: decision.session, membership: decision.membership, error: null };
}

/**
 * Session + role guard for API routes.
 *
 * ## This is no longer a role comparison against the JWT
 *
 * It used to be, and that was the single largest security hole in the
 * platform: `session.role` is the role that was baked into the token *at
 * login*, so across the ~500 endpoints guarded this way a member who had since
 * been deactivated, demoted, or whose business had been suspended kept the
 * access they had that morning until their token expired. The guard never
 * looked at `users.is_active`, never looked at `businesses.status`, and never
 * re-read the role.
 *
 * It now delegates to `authorize()` like every other guard, which re-reads the
 * membership and enforces the full chain (identity → membership → tenant →
 * role/permission). The `roles` list still does what it always did — the
 * signature and the semantics of the *allow* case are unchanged, so no call
 * site needed editing — but the *deny* cases it was missing are now covered.
 *
 * New code should prefer `requirePermission`. This remains for role identity
 * that is genuinely semantic, and for the legacy endpoints not yet migrated;
 * both are inventoried in docs/authorization/ARCHITECTURE.md.
 */
export async function requireRole(...roles: Role[]): Promise<GuardResult> {
  const decision = await authorize(await getSession(), { roles });
  if (!decision.ok) return { session: null, error: denialResponse(decision) };
  return { session: decision.session, membership: decision.membership, error: null };
}

/**
 * Fine-grained guard: does this member hold `permission` right now?
 *
 * The preferred guard. It re-reads the membership through `authorize()`, so a
 * revocation, a role change, a suspended tenant and a reset password all take
 * effect on the next request.
 */
export async function requirePermission(permission: Permission): Promise<GuardResult> {
  const decision = await authorize(await getSession(), { permission });
  if (!decision.ok) return { session: null, error: denialResponse(decision) };
  return { session: decision.session, membership: decision.membership, error: null };
}

/** All listed capabilities are required; useful for bulk transfer boundaries. */
export async function requirePermissions(...permissions: Permission[]): Promise<GuardResult> {
  const decision = await authorize(await getSession(), { allPermissions: permissions });
  if (!decision.ok) return { session: null, error: denialResponse(decision) };
  return { session: decision.session, membership: decision.membership, error: null };
}


/**
 * As `requirePermission`, but any one of `permissions` is enough.
 *
 * For endpoints that serve both a reader and an editor: `GET /api/team` wants
 * `team.view`, but a member who holds only the broader `team.manage` must not
 * be locked out of the list they are allowed to edit.
 */
export async function requireAnyPermission(...permissions: Permission[]): Promise<GuardResult> {
  const decision = await authorize(await getSession(), { anyPermission: permissions });
  if (!decision.ok) return { session: null, error: denialResponse(decision) };
  return { session: decision.session, membership: decision.membership, error: null };
}

/**
 * Wave 3 floor-assistant guard. It is intentionally separate from
 * requireManager: only current cashier/waiter memberships with menu-view
 * access may use the narrow, read-only assistant.
 */
export async function requireFloorAssistant(): Promise<GuardResult> {
  const guard = await requirePermission(PERMISSIONS.menuView);
  if (guard.error) return guard;
  if (guard.session.role !== "cashier" && guard.session.role !== "waiter") {
    return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return guard;
}
