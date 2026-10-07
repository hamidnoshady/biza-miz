import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getCustomerStatement, UNKNOWN_CUSTOMER_KEY } from "@/lib/ar-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One customer's full AR activity (invoices + receipts) with a running balance
 * and the source metadata behind each line. `id` may be "unknown" for
 * unattributed lines.
 *
 * An id that is neither a uuid nor the unknown sentinel answers 404 rather
 * than an empty statement: an empty statement says "this customer has no
 * activity", which is a different (and false) claim about a typo.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (id !== UNKNOWN_CUSTOMER_KEY && !isUuid(id)) {
    return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  }
  return NextResponse.json({ lines: await getCustomerStatement(session.businessId, id) });
});
