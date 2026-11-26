import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";
import { coworkerErrorMessage } from "@/lib/ai-coworker";
import { decideCoworkerRun, getCoworkerRun } from "@/lib/ai-coworker-service";
import { HUMAN_APPROVAL_REFUSAL_FA } from "@/lib/ai-human-approval";

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

    let body: { decision?: unknown; approvals?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.decision !== "approve" && body.decision !== "reject") {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }

    // GH #1567 F7 — the hashes the hub displayed, one per pending gated
    // action. Anything malformed is dropped, which then fails closed in
    // decideCoworkerRun as a missing binding.
    const approvals: Record<string, string> = {};
    if (body.approvals && typeof body.approvals === "object" && !Array.isArray(body.approvals)) {
      for (const [actionId, hash] of Object.entries(body.approvals as Record<string, unknown>)) {
        if (/^[0-9a-f-]{36}$/.test(actionId) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) approvals[actionId] = hash;
      }
    }

    const result = await decideCoworkerRun({
      businessId: guard.session.businessId,
      runId: id,
      decision: body.decision,
      actorUserId: guard.session.sub,
      approvals,
    });
    if (!result.ok) {
      const status = result.error === "coworker_run_not_found" ? 404 : 409;
      const message = (HUMAN_APPROVAL_REFUSAL_FA as Record<string, string>)[result.error] ?? coworkerErrorMessage(result.error);
      return NextResponse.json({ error: result.error, message }, { status });
    }
    return NextResponse.json({ run: result.run });
  },
);
