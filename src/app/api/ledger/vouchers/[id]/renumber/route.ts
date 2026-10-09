import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse, badRequest, readJsonObject } from "@/lib/accounting-http";
import { renumberVoucher } from "@/lib/voucher-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Moves a document into a gap in its year's sequence. Privileged: gated by
 * ledger.close_period, the critical, reason-required, audited accounting
 * authority, because a voucher's number is part of the audit trail. Every
 * change is audited with its reason.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerClosePeriod);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { id } = await ctx.params;
  try {
    const result = await renumberVoucher(session.businessId, session.sub, id, {
      toVoucherNumber: body.toVoucherNumber,
      reason: body.reason,
    });
    return NextResponse.json(result);
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
