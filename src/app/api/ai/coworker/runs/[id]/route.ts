import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";
import { coworkerErrorMessage } from "@/lib/ai-coworker";
import { decideCoworkerRun, getCoworkerRun } from "@/lib/ai-coworker-service";

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requirePermission(PERMISSIONS.aiManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;
    const run = await getCoworkerRun(guard.session.businessId, id);
    if (!run) return NextResponse.json({ error: "coworker_run_not_found" }, { status: 404 });
    return NextResponse.json({ run });
  },
);

/**
 * The owner's answer to an inbox card. Approving applies the still-pending
 * actions through the identical executor an auto-applied one used — which is
 * what makes "held for approval" a delay rather than a different outcome.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requirePermission(PERMISSIONS.aiManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;

    let body: { decision?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.decision !== "approve" && body.decision !== "reject") {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }

    const result = await decideCoworkerRun({
      businessId: guard.session.businessId,
      runId: id,
      decision: body.decision,
      actorUserId: guard.session.sub,
    });
    if (!result.ok) {
      const status = result.error === "coworker_run_not_found" ? 404 : 409;
      return NextResponse.json(
        { error: result.error, message: coworkerErrorMessage(result.error) },
        { status },
      );
    }
    return NextResponse.json({ run: result.run });
  },
);
