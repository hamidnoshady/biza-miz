import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { previewAutomation } from "@/lib/ai-automations-service";

/**
 * A dry run: report whether this automation's conditions hold RIGHT NOW and
 * what it would propose — without proposing anything. The editor uses it to
 * answer "would this fire today?".
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;
    const preview = await previewAutomation(guard.session.businessId, id);
    if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ preview });
  },
);
