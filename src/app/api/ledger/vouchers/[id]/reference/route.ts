import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse, badRequest, readJsonObject } from "@/lib/accounting-http";
import { setVoucherReference } from "@/lib/voucher-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Sets, changes or clears a document's own reference number. Needs a reason; audited. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { id } = await ctx.params;
  try {
    const result = await setVoucherReference(session.businessId, session.sub, id, {
      reference: body.reference,
      reason: body.reason,
    });
    return NextResponse.json(result);
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
