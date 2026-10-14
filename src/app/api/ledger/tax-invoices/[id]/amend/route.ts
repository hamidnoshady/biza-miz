import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { amendSubmission } from "@/lib/tax-invoice-service";
import { readJsonBody, taxErrorResponse } from "@/lib/tax-invoice-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** An accepted invoice is corrected by a new amendment prepared from the sale as it stands, with a stated reason. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxAmend);
  if (error) return error;
  const { id } = await ctx.params;
  const body = await readJsonBody<{ reason?: unknown }>(request);
  if (typeof body?.reason !== "string") return NextResponse.json({ error: "reason_required" }, { status: 400 });
  try {
    const result = await amendSubmission({ businessId: session.businessId, userId: session.sub }, id, body.reason);
    return NextResponse.json({ result });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
