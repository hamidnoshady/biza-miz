import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createSiteIssue, listProjectSiteIssues } from "@/lib/aec-site-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's site and quality register (issue #799 §14).
 *
 * GET  — every inspection request, inspection, NCR, corrective action, snag,
 *        HSE observation and handover item on the project, most severe first and
 *        then by due date, with overdue rows flagged by the service. Filters:
 *        `kind`, `status`, `severity`, `category`, `search`, `openOnly`,
 *        `overdueOnly`.
 * POST — raise one. `snag` and `hse_observation` are refused when the business's
 *        own preset leaves `snagging` or `hse` off (§14's "where enabled"), and
 *        the number (`SNG-004`) is generated inside the transaction under a
 *        project-scoped advisory lock unless the caller supplies one.
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    const params = request.nextUrl.searchParams;
    try {
      await requireProjectCapability(owner, id, "view");
      const issues = await listProjectSiteIssues(owner.businessId, id, {
        kind: params.get("kind") ?? undefined,
        status: params.get("status") ?? undefined,
        severity: params.get("severity") ?? undefined,
        category: params.get("category") ?? undefined,
        search: params.get("search") ?? undefined,
        openOnly: params.get("openOnly") === "1",
        overdueOnly: params.get("overdueOnly") === "1",
      });
      return NextResponse.json({ issues });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "manage");
      const issue = await createSiteIssue(owner, id, await readBody(request));
      return NextResponse.json({ issue }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
