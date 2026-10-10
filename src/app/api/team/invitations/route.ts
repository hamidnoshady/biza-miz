import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isPasswordRole, sanitizeOverrides } from "@/lib/team";
import { TeamError, createInvitation, listInvitations } from "@/lib/team-service";
import type { Role } from "@/lib/auth";
import {
  grantRefusalMessage,
  loadCustomRole,
  membershipGrantRefusal,
  projectGrantedPermissions,
  resolveMembershipAuthority,
} from "@/lib/membership-authority";
import { isLocationScope } from "@/lib/location-access";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  return NextResponse.json({ invitations: await listInvitations(session.businessId) });
});

/**
 * Invites someone to join this business.
 *
 * Returns the token exactly once, as a link for the owner to pass on — no
 * email is sent (Phase 13 decision: there is no mail transport in this system,
 * and adding one is a deployment concern). Only the token's hash is stored, so
 * it cannot be recovered afterwards; re-inviting issues a fresh one and
 * supersedes any invitation still pending for that address.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  let body: {
    email?: string;
    fullName?: string;
    role?: Role;
    locationIds?: string[];
    /** Issue #854 (P2.11) — the explicit branch policy; never inferred. */
    locationScope?: string;
    defaultLocationId?: string | null;
    permissions?: unknown;
    customRoleId?: string | null;
    /** Issue #854 (P2.4) — required when the invite grants extra access. */
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  // PIN roles work a shared device and have no email — they're created
  // directly on /api/team instead.
  if (!body.role || !isPasswordRole(body.role)) {
    return NextResponse.json({ error: "role_not_invitable" }, { status: 400 });
  }

  /**
   * Issue #854 (P0.2) — the same anti-escalation rule as member creation.
   *
   * This route required only `team.manage`. It did not compare the invited
   * role or the invitation's permission overrides against the inviter's
   * authority, so a delegated manager could invite an `owner`, invite an
   * `admin`, or attach `granted` overrides for capabilities they did not hold —
   * and the invitee would arrive with access the inviter was never allowed to
   * grant. An invitation is a *future membership*, so it is authorised by the
   * same decision that authorises one.
   */
  const actor = await resolveMembershipAuthority(session.businessId, session.sub);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const overrides = sanitizeOverrides(body.permissions);
  const customRole = body.customRoleId
    ? await loadCustomRole(session.businessId, body.customRoleId)
    : null;
  if (body.customRoleId && !customRole) {
    return NextResponse.json({ error: "custom_role_not_found" }, { status: 400 });
  }

  const refusal = membershipGrantRefusal({
    actor,
    nextRole: body.role,
    nextPermissions: projectGrantedPermissions({
      role: body.role,
      overrides,
      customRolePermissions: customRole?.permissions ?? null,
    }),
    customRole,
    isSelf: false,
    isCreation: true,
    roleChanges: true,
    changesAccess: true,
  });
  if (refusal) {
    return NextResponse.json(
      { error: refusal, message: grantRefusalMessage(refusal) },
      { status: 403 },
    );
  }

  // Issue #854 (P2.10 / P2.11): the branch policy is explicit, and the
  // invariants are checked before the row is stored.
  if (body.locationScope !== undefined && !isLocationScope(body.locationScope)) {
    return NextResponse.json({ error: "invalid_location_scope" }, { status: 400 });
  }
  if (body.locationScope === "selected" && (body.locationIds?.length ?? 0) === 0) {
    return NextResponse.json({ error: "selected_locations_required" }, { status: 400 });
  }
  if (body.locationScope === "home" && !body.defaultLocationId) {
    return NextResponse.json({ error: "home_location_required" }, { status: 400 });
  }

  try {
    const { token, invitationId } = await createInvitation({
      businessId: session.businessId,
      email,
      role: body.role,
      fullName: body.fullName ?? "",
      locationIds: body.locationIds ?? [],
      locationScope: isLocationScope(body.locationScope) ? body.locationScope : null,
      defaultLocationId: body.defaultLocationId ?? null,
      overrides,
      customRoleId: body.customRoleId ?? null,
      reason: body.reason,
      actorId: session.sub,
    });

    const url = new URL(`/invite/${token}`, request.nextUrl.origin).toString();
    return NextResponse.json({ id: invitationId, token, url }, { status: 201 });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
