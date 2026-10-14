import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updatePipeline } from "@/lib/crm-pipeline-service";

/**
 * One pipeline: rename it, describe it, make it the default, archive it.
 *
 * `PUT` is deliberately *not* the stage list. Stages are replaced as a whole
 * list on their own route (`./stages`), because ordering is a property of the
 * set: two people reordering at once through a per-field PUT interleave into a
 * board neither of them chose.
 *
 * 409 for the two refusals that mean "the state, not the request, is the
 * problem" — archiving the default pipeline, or one that still holds open
 * deals. The screen turns both into a sentence; a 400 would read as a typo.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
    if (error) return error;

    let body: { name?: string; description?: string; isDefault?: boolean; archived?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const { id } = await params;
    const result = await updatePipeline(
      session.businessId,
      id,
      {
        name: body.name,
        description: body.description,
        isDefault: body.isDefault,
        archived: body.archived,
      },
      { name: session.fullName, userId: session.sub },
    );
    if (!result.ok) {
      const status =
        result.error === "not_found"
          ? 404
          : result.error === "default_pipeline_required" || result.error === "pipeline_in_use"
            ? 409
            : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ pipeline: result.pipeline });
  },
);
