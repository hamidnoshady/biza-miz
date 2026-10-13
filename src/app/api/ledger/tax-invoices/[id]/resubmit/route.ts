import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resubmitSubmission } from "@/lib/tax-invoice-service";
import { taxErrorResponse } from "@/lib/tax-invoice-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * A refused record is not resent. Its sale is re-read as it stands now and a new
 * revision is prepared, with a new reference and a new uid. The refused record stays.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxPrepare);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    const result = await resubmitSubmission({ businessId: session.businessId, userId: session.sub }, id);
    return NextResponse.json({ result });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
