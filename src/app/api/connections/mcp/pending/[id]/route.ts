import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { decideMcpPendingAction } from "@/lib/mcp/write-service";

/**
 * An owner's verdict on a write an approval-mode connection asked for.
 *
 * Approving runs the *stored* payload unchanged — the connector gets no second
 * say, so the figure the owner read on screen is the figure that is written —
 * and the write then runs under the approver's own authority, because this is
 * the moment it becomes theirs.
 *
 * Owner-only: the whole reason `approve` mode exists is that someone with the
 * authority to say no is looking at it.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mcpManage);
    if (error) return error;
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

    const result = await decideMcpPendingAction({
      businessId: session.businessId,
      auditId: id,
      decision: body.decision,
      deciderUserId: session.sub,
    });
    if (!result.ok) {
      // approver_forbidden: the decider's *current* permissions do not cover
      // the queued action's domain permission, so the row went back to the
      // queue for a privileged approver rather than being executed or lost.
      const status =
        result.error === "not_found" ? 404 : result.error === "approver_forbidden" ? 403 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json(
      result.decision === "approve" ? { ok: true, outcome: result.outcome } : { ok: true },
    );
  },
);
