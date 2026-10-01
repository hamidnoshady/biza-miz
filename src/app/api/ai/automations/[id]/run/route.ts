import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { getAutomation, runAutomationNow } from "@/lib/ai-automations-service";

/**
 * Run an automation once, right now, on demand. Fires it through the identical
 * guarded path a scheduled or event firing takes: an `auto` automation still
 * passes the owner's per-category caps, and an over-cap payload is HELD as a
 * clickable proposal rather than forced through. Returns the run outcome.
 *
 * An `auto` automation writes unattended, so — like creating one — running it
 * on demand requires the owner, not just a manager.
 */
export const POST = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;

    const automation = await getAutomation(guard.session.businessId, id);
    if (!automation) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!automation.enabled) {
      return NextResponse.json({ error: "automation_disabled" }, { status: 409 });
    }
    if (automation.approvalMode === "auto" && guard.session.role !== "owner") {
      return NextResponse.json({ error: "owner_required" }, { status: 403 });
    }

    const result = await runAutomationNow(guard.session.businessId, id);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ run: result });
  },
);
