import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireMember, sessionCookieOptions, signSession, withTenantScope } from "@/lib/auth";
import { businessLocations } from "@/lib/setup-state";
import { canAccessLocation } from "@/lib/location-access";
import { query } from "@/lib/db";
import type { Role } from "@/lib/auth";

/**
 * Moves the session's active branch to another one the member can reach.
 *
 * Re-issues the session cookie with `activeLocationId` set, so the tenant
 * scope (business) is untouched but every screen that resolves the caller's
 * branch via `resolveActiveLocation` picks up the new one on the very next
 * request — there is nothing else to invalidate.
 *
 * Role and branch assignment are re-read from the database rather than
 * trusted from the token, matching `requirePermission`: a membership's
 * assignment can change after login, and this is the one request where using
 * a stale token's role would let someone switch into a branch they were just
 * unassigned from.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  const { session } = guard;

  let body: { locationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.locationId) return NextResponse.json({ error: "missing_location" }, { status: 400 });

  const { rows } = await query<{
    role: Role;
    location_id: string | null;
    location_scope: "all" | "selected" | "home" | "none";
    is_active: boolean;
  }>(
    "SELECT role, location_id, location_scope, is_active FROM users WHERE id = $1",
    [session.sub],
  );
  const { rows: assignmentRows } = await query<{ location_id: string }>(
    "SELECT location_id FROM user_locations WHERE user_id = $1",
    [session.sub],
  );
  const membership = rows[0];
  // A membership deleted or deactivated since login must not be able to keep
  // moving between branches on the strength of a still-valid cookie.
  if (!membership || !membership.is_active) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const locations = await businessLocations(session.businessId);
  const ctx = {
    role: membership.role,
    locationScope: membership.location_scope,
    defaultLocationId: membership.location_id,
    assignedLocationIds: assignmentRows.map((r) => r.location_id),
  };

  if (!canAccessLocation(ctx, locations.map((l) => l.id), body.locationId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const token = await signSession({
    sub: session.sub,
    // The freshly-read role and home branch, not the token's copies. The
    // access check above already ran on the database's answer, so re-signing
    // the stale ones would hand back a cookie that disagrees with the
    // decision that was just made — a member demoted from manager to cashier
    // since login would keep a `manager` token for another full session
    // lifetime, and every screen reading `session.role` would believe it.
    role: membership.role,
    businessId: session.businessId,
    businessSlug: session.businessSlug,
    businessSubdomain: session.businessSubdomain,
    locationId: membership.location_id,
    activeLocationId: body.locationId,
    fullName: session.fullName,
    platformUserId: session.platformUserId ?? null,
    tokenVersion: session.tokenVersion,
    employeeSessionId: session.employeeSessionId,
    mfaVerified: session.mfaVerified,
    recentAuthAt: session.recentAuthAt,
    imp: session.imp,
  });

  const res = NextResponse.json({ ok: true, locationId: body.locationId });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
