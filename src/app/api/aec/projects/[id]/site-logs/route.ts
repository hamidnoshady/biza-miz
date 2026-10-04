import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createSiteLog, listProjectSiteLogs } from "@/lib/aec-site-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's daily site logs (issue #799 §13).
 *
 * GET  — the days, newest first, with the numbers the register shows (workforce,
 *        deliveries, incidents) counted from the days' own lines rather than
 *        typed on a header. Filters: `from`, `to`, `status`, `search`.
 * POST — write a day. The date defaults to the business's today and is unique
 *        per project, so a second report on the same date is an edit of the day
 *        rather than a second day.
 *
 * Both run on top of `requireProjectCapability`, like every other AEC route, so
 * «میز کار من» narrows to the project and the project role decides who may
 * write. The capability behind the section is `site_operations`; a business
 * whose profile leaves it off is refused by the service with a sentence.
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    const params = request.nextUrl.searchParams;
    try {
      await requireProjectCapability(owner, id, "view", true);
      const logs = await listProjectSiteLogs(owner.businessId, id, {
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        status: params.get("status") ?? undefined,
        search: params.get("search") ?? undefined,
      });
      return NextResponse.json({ logs });
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
      await requireProjectCapability(owner, id, "manage", true);
      const log = await createSiteLog(owner, id, await readBody(request));
      return NextResponse.json({ log }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
