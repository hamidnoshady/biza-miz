import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { runAutomationForMember } from "@/lib/ai-automations-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_STATUS = { not_found: 404, automation_disabled: 409, owner_required: 403 } as const;

/** Manual calls use the same run claim and guarded executor as scheduled work. */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requirePermission(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const key = request.headers.get("Idempotency-Key");
    if (key !== null && !UUID.test(key)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    const { id } = await context.params;
    const result = await runAutomationForMember({
      businessId: guard.session.businessId,
      automationId: id,
      actorUserId: guard.session.sub,
      isOwner: guard.session.role === "owner",
      requestKey: key?.toLowerCase() ?? null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] });
    }
    return NextResponse.json({ run: result.run }, { status: result.run.outcome === "running" ? 202 : 200 });
  },
);
