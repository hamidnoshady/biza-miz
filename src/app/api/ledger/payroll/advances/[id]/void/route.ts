import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { voidAdvance } from "@/lib/payroll-advances-service";
import { payrollErrorResponse } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Voids a salary advance recorded by mistake: mirrors its entry, dated today,
 * under the location the original carried (never the caller's active branch).
 * Refused once a payroll run has recovered any of it. Gated on `payroll.manage`.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const { id } = await ctx.params;

  try {
    const advance = await voidAdvance({
      businessId: session.businessId,
      advanceId: id,
      actorId: session.sub,
    });
    return NextResponse.json({ advance });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
