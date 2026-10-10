import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { TeamError, rehireMembership } from "@/lib/team-service";
import { lockoutMessage } from "@/lib/team";

/**
 * Issue #854 (pass 4, gap 4) — the rehire ceremony for an offboarded member.
 *
 * Offboarding severed the identity linkage, revoked the credentials and wiped
 * the branch assignments; a plain «فعال‌سازی» cannot put those back. This
 * endpoint runs the explicit restore (`rehireMembership`): the same
 * `team.manage` gate as every membership write plus `team.permissions.manage`,
 * because a rehire re-grants the stored role and permission set and the
 * service re-checks the whole grant against the actor's own capabilities.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;
  const escalation = await requirePermission(PERMISSIONS.teamPermissionsManage);
  if (escalation.error) return escalation.error;

  const { id } = await context.params;

  let body: {
    locationIds?: string[];
    defaultLocationId?: string | null;
    locationScope?: "all" | "selected" | "home" | "none";
    pin?: string;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.locationScope !== undefined && !["all", "selected", "home", "none"].includes(body.locationScope)) {
    return NextResponse.json({ error: "invalid_location_scope" }, { status: 400 });
  }
  if (body.locationScope === "selected" && (!body.locationIds || body.locationIds.length === 0)) {
    return NextResponse.json({ error: "selected_locations_required" }, { status: 400 });
  }

  try {
    await rehireMembership({
      businessId: session.businessId,
      userId: id,
      actorId: session.sub,
      locationIds: body.locationIds,
      defaultLocationId: body.defaultLocationId,
      locationScope: body.locationScope,
      pin: body.pin,
      reason: body.reason,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamError) {
      const reasonText = err.message === "last_owner" ? lockoutMessage("last_owner") : undefined;
      return NextResponse.json({ error: err.message, reason: reasonText }, { status: err.status });
    }
    throw err;
  }
});
