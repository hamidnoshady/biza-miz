import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS, effectivePermissions, parseOverrides } from "@/lib/permissions";
import { isLocationScope } from "@/lib/location-access";
import { escalationRefusal, lockoutMessage, sanitizeOverrides } from "@/lib/team";
import {
  TeamError,
  removeMembership,
  setMemberPhone,
  updateMembership,
} from "@/lib/team-service";
import { canonicalMemberPhone } from "@/lib/phone-otp";
import { query } from "@/lib/db";
import { ASSIGNABLE_ROLES } from "@/lib/roles";
import type { Role } from "@/lib/auth";

function errorResponse(err: unknown): NextResponse {
  if (err instanceof TeamError) {
    // The lockout refusal carries a Persian explanation; the UI shows it as-is.
    const reason = err.message === "last_owner" ? lockoutMessage("last_owner") : undefined;
    return NextResponse.json({ error: err.message, reason }, { status: err.status });
  }
  throw err;
}

/** Change a member's role, name, branches, permission overrides, or active state. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { id } = await context.params;

  let body: {
    role?: Role;
    customRoleId?: string | null;
    fullName?: string;
    isActive?: boolean;
    locationIds?: string[];
    defaultLocationId?: string | null;
    locationScope?: "all" | "selected" | "home" | "none";
    permissions?: unknown;
    /** Phase 42 — set (or, with "", clear) the member's login phone. Stored unverified. */
    phone?: string;
    /**
     * Issue #854 (P2.4) — why this access change is being made. Required by the
     * service whenever the write changes the role, the custom role or an
     * override; the validation and the storage both live there, so this route
     * only has to forward it honestly.
     */
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.role !== undefined && !ASSIGNABLE_ROLES.includes(body.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  if (body.locationScope !== undefined && !["all", "selected", "home", "none"].includes(body.locationScope)) {
    return NextResponse.json({ error: "invalid_location_scope" }, { status: 400 });
  }
  if (body.locationScope === "selected" && (!body.locationIds || body.locationIds.length === 0)) {
    return NextResponse.json({ error: "selected_locations_required" }, { status: 400 });
  }

  const changesAccess = body.role !== undefined || body.permissions !== undefined || body.customRoleId !== undefined;
  if (changesAccess) {
    const escalation = await requirePermission(PERMISSIONS.teamPermissionsManage);
    if (escalation.error) return escalation.error;
  }

  // Managing routine team details may be delegated; managing an owner or
  // granting ownership may not. Enforce this server-side, not merely in UI.
  const { rows: roleRows } = await query<{
    actor_role: Role;
    actor_permissions: unknown;
    target_role: Role;
    target_permissions: unknown;
    actor_custom_permissions: string[] | null;
    target_custom_permissions: string[] | null;
    selected_custom_permissions: string[] | null;
  }>(
    `SELECT actor.role AS actor_role, actor.permissions AS actor_permissions,
            target.role AS target_role, target.permissions AS target_permissions,
            CASE WHEN ar.is_active THEN ARRAY(SELECT jsonb_array_elements_text(ar.permissions)) END actor_custom_permissions,
            CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) END target_custom_permissions,
            CASE WHEN sr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(sr.permissions)) END selected_custom_permissions
       FROM users actor
       JOIN users target ON target.id = $3 AND target.business_id = actor.business_id
       LEFT JOIN tenant_roles ar ON ar.id=actor.custom_role_id AND ar.business_id=actor.business_id
       LEFT JOIN tenant_roles tr ON tr.id=target.custom_role_id AND tr.business_id=target.business_id
       LEFT JOIN tenant_roles sr ON sr.id=$4::uuid AND sr.business_id=actor.business_id
      WHERE actor.id = $1 AND actor.business_id = $2 AND actor.is_active = true`,
    [session.sub, session.businessId, id, body.customRoleId ?? null],
  );
  const roles = roleRows[0];
  if (!roles) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (roles.actor_role !== "owner" && (roles.target_role === "owner" || body.role === "owner")) {
    return NextResponse.json({ error: "owner_only" }, { status: 403 });
  }

  // `team.permissions.manage` delegates access administration; it must not be
  // usable to out-rank the owner who delegated it. The rule and its reasoning
  // live in `escalationRefusal` — refuse an edit that hands out a capability
  // the editor lacks, or that moves the editor's own role.
  //
  // This runs on the role as the *database* holds it, never `session.role`:
  // a token minted before a demotion would otherwise still spend the access
  // it was minted with.
  if (changesAccess) {
    const nextOverrides =
      body.permissions === undefined
        ? parseOverrides(roles.target_permissions)
        : sanitizeOverrides(body.permissions);
    const refusal = escalationRefusal({
      actorRole: roles.actor_role,
      actorPermissions: effectivePermissions(
        roles.actor_role,
        parseOverrides(roles.actor_permissions),
        roles.actor_custom_permissions,
      ),
      isSelf: id === session.sub,
      currentPermissions: effectivePermissions(
        roles.target_role,
        parseOverrides(roles.target_permissions),
        roles.target_custom_permissions,
      ),
      nextPermissions: effectivePermissions(body.role ?? roles.target_role, nextOverrides,
        body.customRoleId === undefined ? roles.target_custom_permissions : roles.selected_custom_permissions),
      roleChanges: body.role !== undefined && body.role !== roles.target_role,
    });
    if (refusal) {
      return NextResponse.json({ error: "forbidden", code: refusal }, { status: 403 });
    }
  }

  // A phone change is its own action rather than a field on updateMembership:
  // it carries its own guards (mobile shape, per-business uniqueness) and its
  // own audit entry, and an owner typing somebody's number must never look
  // like a verified number.
  if (body.phone !== undefined) {
    const trimmed = String(body.phone).trim();
    const phone = trimmed ? canonicalMemberPhone(trimmed) : null;
    if (trimmed && !phone) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
    try {
      await setMemberPhone(session.businessId, id, phone, session.sub);
    } catch (err) {
      return errorResponse(err);
    }
  }

  try {
    await updateMembership({
      businessId: session.businessId,
      userId: id,
      actorId: session.sub,
      role: body.role,
      customRoleId: body.customRoleId,
      fullName: body.fullName,
      isActive: body.isActive,
      locationIds: body.locationIds,
      defaultLocationId: body.defaultLocationId,
      locationScope: body.locationScope,
      overrides: body.permissions === undefined ? undefined : sanitizeOverrides(body.permissions),
      reason: body.reason,
    });
    /*
     * Same best-effort party as on create, and here for the repair case: a member
     * whose account was made before the party existed (or whose name was blank at
     * the time) gets their personnel file on the next edit of the membership. It
     * runs after the update has committed and its failure is not the member's
     * problem — the edit they asked for is already saved.
     *
     * Only a request that actually names the member renames the file: the call
     * doubles as the repair path in parties-service now (it updates an existing
     * party's name, not just creates the missing one), and a suspend or a
     * permission change — which sends no name — must not stamp the party with
     * whatever stale label the body happened to omit.
     */
    const renameTo = body.fullName?.trim();
    if (renameTo) {
      try {
        const { ensureEmployeeParty } = await import("@/lib/parties-service");
        await ensureEmployeeParty(session.businessId, id, { displayName: renameTo });
      } catch {
        /* no party row for this member yet */
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});

/**
 * Removes a member.
 *
 * Deactivates and strips credentials rather than deleting the row: every
 * foreign key to `users` is ON DELETE SET NULL, so a real delete would orphan
 * "who opened this order" throughout the ledger and audit trail.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { id } = await context.params;
  const { rows } = await query<{ actor_role: Role; target_role: Role }>(
    `SELECT actor.role AS actor_role, target.role AS target_role FROM users actor
       JOIN users target ON target.id = $3 AND target.business_id = actor.business_id
      WHERE actor.id = $1 AND actor.business_id = $2 AND actor.is_active = true`,
    [session.sub, session.businessId, id],
  );
  if (!rows[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (rows[0].actor_role !== "owner" && rows[0].target_role === "owner") {
    return NextResponse.json({ error: "owner_only" }, { status: 403 });
  }
  try {
    await removeMembership(session.businessId, id, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});
