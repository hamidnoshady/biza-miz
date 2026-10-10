import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getTaxRecordDetail } from "@/lib/tax-invoice-queries";
import { taxErrorResponse } from "@/lib/tax-invoice-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One record in full: the stored snapshot exactly as it was sent, its payload hash,
 * its history, and the other records of the same sale. Read-only.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    const record = await getTaxRecordDetail(session.businessId, id);
    if (!record) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ record });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
