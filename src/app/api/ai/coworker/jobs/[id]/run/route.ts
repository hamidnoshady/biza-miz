import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";
import { coworkerErrorMessage } from "@/lib/ai-coworker";
import { runCoworkerJobNow } from "@/lib/ai-coworker-service";

/** "Run it now" — the same firing path the tick uses, with a fresh dedupe key. */
export const POST = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requirePermission(PERMISSIONS.aiManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;

    const result = await runCoworkerJobNow(guard.session.businessId, id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, message: coworkerErrorMessage(result.error) },
        { status: 404 },
      );
    }
    return NextResponse.json({ runIds: result.runIds });
  },
);
