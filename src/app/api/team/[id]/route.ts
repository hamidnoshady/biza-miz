import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS, effectivePermissions, parseOverrides } from "@/lib/permissions";
import { isLocationScope } from "@/lib/location-access";
import { escalationRefusal, lockoutMessage, sanitizeOverrides } from "@/lib/team";
import {
  TeamError,
  deleteMembership,
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
    // Issue #1007: refusals that can say more than their code (which history
    // blocks a hard delete) carry their own `reason`, same treatment.
    const reason =
      err.reason ?? (err.message === "last_owner" ? lockoutMessage("last_owner") : undefined);
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

  // Issue #1125 (P0): the UI sends "" (empty string) to mean «clear the custom
  // role». Normalize before any UUID casts or lookups so an empty string cannot
  // reach a $n::uuid placeholder or be mistaken for a real role id. A value
  // that is a non-empty, non-UUID string is refused rather than forwarded.
  if (body.customRoleId !== undefined) {
    if (body.customRoleId === "") {
      body.customRoleId = null;
    } else if (body.customRoleId !== null) {
      if (typeof body.customRoleId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.customRoleId)) {
        return NextResponse.json({ error: "invalid_custom_role" }, { status: 400 });
      }
    }
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
            CASE WHEN actor.custom_role_id IS NULL THEN NULL WHEN ar.is_active THEN ARRAY(SELECT jsonb_array_elements_text(ar.permissions)) ELSE ARRAY[]::text[] END actor_custom_permissions,
            CASE WHEN target.custom_role_id IS NULL THEN NULL WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) ELSE ARRAY[]::text[] END target_custom_permissions,
            CASE WHEN $4::uuid IS NULL THEN NULL WHEN sr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(sr.permissions)) ELSE ARRAY[]::text[] END selected_custom_permissions
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
     * Same repair as on create, and no longer a route-local side effect (issue #947,
     * F04/F05): `updateMembership` itself brings the personnel file in line — for a
     * rename it propagates the new canonical identity, and for every other edit it
     * repairs a file that is missing or stale, recording the failure durably if the
     * write cannot happen. Only the membership's own fields travel; a suspend or a
     * permission change cannot stamp the file with a label the request omitted,
     * because the values are read from the membership row rather than the body.
     */
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});

/**
 * Removes a member — two ways, chosen by the request (issue #1007).
 *
 * - **`DELETE /api/team/[id]`** is the offboarding path: deactivate and strip
 *   credentials rather than deleting the row, because every foreign key to
 *   `users` is ON DELETE SET NULL and a real delete would orphan "who opened
 *   this order" throughout the ledger and audit trail. This is the soft
 *   removal («قطع همکاری» / بایگانی) the screen offers for every member.
 *
 * - **`DELETE /api/team/[id]?hard=1`** is the hard removal («حذف عضو»): the
 *   membership row, the login-identity link and the empty personnel file are
 *   deleted outright — but only for a member with **no business history** (no
 *   orders, shifts, journal entries, payroll, audit references), never the
 *   actor themselves and never the last active owner. `deleteMembership` owns
 *   those rules. Hard mode is additionally **owner-only at this route**
 *   (403 `owner_only`): offboarding stays open to any `team.manage` holder,
 *   but erasing a row is the owner's call. A refusal answers with a
 *   Persian `reason` the screen shows as-is.
 */
export const DELETE = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
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
  const hard = new URL(request.url).searchParams.get("hard");
  try {
    if (hard === "1" || hard === "true") {
      // Erasing a row is the owner's call (issue #1007): a manager with
      // team.manage can offboard anyone, but the hard removal is owner-only.
      // `deleteMembership` still re-checks self / last owner / history.
      if (rows[0].actor_role !== "owner") {
        return NextResponse.json({ error: "owner_only" }, { status: 403 });
      }
      await deleteMembership(session.businessId, id, session.sub);
      return NextResponse.json({ ok: true, result: "deleted" });
    }
    await removeMembership(session.businessId, id, session.sub);
    return NextResponse.json({ ok: true, result: "offboarded" });
  } catch (err) {
    return errorResponse(err);
  }
});
