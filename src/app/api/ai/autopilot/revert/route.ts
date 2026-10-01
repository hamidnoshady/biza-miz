import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { revertAutopilotAction } from "@/lib/ai-autopilot-service";

const STATUS: Record<string, number> = {
  not_found: 404,
  not_revertible: 400,
  not_revertible_status: 409,
};

/** Undo one applied autopilot action, restoring the state captured at execution time. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
  if (guard.error) return guard.error;

  let body: { auditId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.auditId !== "string" || !body.auditId) {
    return NextResponse.json({ error: "invalid_audit_id" }, { status: 400 });
  }

  const result = await revertAutopilotAction({
    businessId: guard.session.businessId,
    auditId: body.auditId,
    actorName: guard.session.fullName ?? guard.session.role,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: STATUS[result.error] ?? 422 });
  return NextResponse.json({ ok: true });
});
