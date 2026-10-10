import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { retrySubmission } from "@/lib/tax-invoice-service";
import { taxErrorResponse } from "@/lib/tax-invoice-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** `error` → `queued`, then send. The uid is the one the first attempt used, so the authority deduplicates. */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxSend);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    const status = await retrySubmission({ businessId: session.businessId, userId: session.sub }, id);
    return NextResponse.json({ status });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
