import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getWorkspaceDashboard } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../guard";

/**
 * GET — the «نمای کلی» roll-up: the four headline counters, my open tasks, the
 * upcoming deadlines, my pending approvals and the recent-activity strip.
 *
 * Read-only and gated on `workspace.view`, the same permission that opens the
 * module; every counter and list is scoped to the projects the caller can
 * see, and the personal lists to the caller's own user id.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const horizon = Number(new URL(request.url).searchParams.get("days") ?? 14);
  try {
    const dashboard = await getWorkspaceDashboard(owner, {
      horizonDays: Number.isFinite(horizon) ? Math.min(Math.max(horizon, 1), 90) : 14,
    });
    return NextResponse.json({ dashboard });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
