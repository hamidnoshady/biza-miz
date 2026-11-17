import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { eligibleTourById } from "@/lib/tours-service";
import { unassignTourFromStaff } from "@/lib/tours-service";

/**
 * Unassign a tour from a staff member (issue #972, item 9 — staff assignments).
 * Requires `team.manage`.
 */
export const DELETE = withTenantScope(
  async (
    _request: Request,
    context: { params: Promise<{ tourId: string; userId: string }> },
  ) => {
    const guard = await requirePermission(PERMISSIONS.teamManage);
    if (guard.error) return guard.error;

    const { tourId, userId } = await context.params;
    const tour = await eligibleTourById(
      tourId,
      guard.session.businessId,
      guard.membership.permissions,
    );
    if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const removed = await unassignTourFromStaff(
      guard.session.businessId,
      tourId,
      userId,
    );
    return NextResponse.json({ removed });
  },
);
