import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { eligibleTourById } from "@/lib/tours-service";
import {
  assignTourToStaff,
  listTourAssignments,
} from "@/lib/tours-service";

/**
 * Assign a tour to a staff member, or list the staff assigned to a tour
 * (issue #972, item 9 — staff assignments).
 *
 * POST body: { userId } — the staff member to assign the tour to.
 * Requires `team.manage`.
 */
export const POST = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ tourId: string }> },
  ) => {
    const guard = await requirePermission(PERMISSIONS.teamManage);
    if (guard.error) return guard.error;

    const { tourId } = await context.params;
    const tour = await eligibleTourById(
      tourId,
      guard.session.businessId,
      guard.membership.permissions,
    );
    if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const body: unknown = await request.json().catch(() => null);
    const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const userId = raw?.userId;
    if (typeof userId !== "string" || !userId) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const created = await assignTourToStaff(
      guard.session.businessId,
      tourId,
      userId,
      guard.session.sub,
    );
    return NextResponse.json({ created });
  },
);

export const GET = withTenantScope(
  async (
    _request: NextRequest,
    context: { params: Promise<{ tourId: string }> },
  ) => {
    const guard = await requirePermission(PERMISSIONS.teamManage);
    if (guard.error) return guard.error;

    const { tourId } = await context.params;
    const tour = await eligibleTourById(
      tourId,
      guard.session.businessId,
      guard.membership.permissions,
    );
    if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const assignments = await listTourAssignments(
      guard.session.businessId,
      tourId,
    );
    return NextResponse.json({ assignments });
  },
);
