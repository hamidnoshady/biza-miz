import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { learningPathById } from "@/lib/learning-paths";
import { pathsForViewer } from "@/lib/learning-paths";
import { learningPathViewerFor } from "@/lib/learning-paths-service";
import {
  assignLearningPathToStaff,
  listLearningPathAssignments,
} from "@/lib/learning-paths-service";

/**
 * Assign a learning path to a staff member, or list the staff assigned to a
 * learning path (issue #972, item 9 — staff assignments).
 *
 * POST body: { userId } — the staff member to assign the path to.
 * Requires `team.manage`.
 */
export const POST = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ pathId: string }> },
  ) => {
    const guard = await requirePermission(PERMISSIONS.teamManage);
    if (guard.error) return guard.error;

    const { pathId } = await context.params;
    const path = learningPathById(pathId);
    if (!path) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const viewer = await learningPathViewerFor(
      guard.session.businessId,
      guard.membership.permissions,
    );
    const visible = pathsForViewer([path], {
      permissions: viewer.permissions,
      industry: viewer.industry,
    });
    if (visible.length === 0)
      return NextResponse.json({ error: "not_found" }, { status: 404 });

    const body: unknown = await request.json().catch(() => null);
    const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const userId = raw?.userId;
    if (typeof userId !== "string" || !userId) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const created = await assignLearningPathToStaff(
      guard.session.businessId,
      pathId,
      userId,
      guard.session.sub,
    );
    return NextResponse.json({ created });
  },
);

export const GET = withTenantScope(
  async (
    _request: NextRequest,
    context: { params: Promise<{ pathId: string }> },
  ) => {
    const guard = await requirePermission(PERMISSIONS.teamManage);
    if (guard.error) return guard.error;

    const { pathId } = await context.params;
    const path = learningPathById(pathId);
    if (!path) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const viewer = await learningPathViewerFor(
      guard.session.businessId,
      guard.membership.permissions,
    );
    const visible = pathsForViewer([path], {
      permissions: viewer.permissions,
      industry: viewer.industry,
    });
    if (visible.length === 0)
      return NextResponse.json({ error: "not_found" }, { status: 404 });

    const assignments = await listLearningPathAssignments(
      guard.session.businessId,
      pathId,
    );
    return NextResponse.json({ assignments });
  },
);
