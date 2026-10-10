import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getSupplierStatement, UNKNOWN_SUPPLIER_KEY } from "@/lib/ap-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One supplier's full AP activity (bills + payments + returns) with a running
 * balance and the source metadata behind each line. `id` may be "unknown" for
 * unattributed lines; anything else that is not a uuid is a 404, not an empty
 * statement (see the A/R mirror).
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (id !== UNKNOWN_SUPPLIER_KEY && !isUuid(id)) {
    return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }
  return NextResponse.json({ lines: await getSupplierStatement(session.businessId, id) });
});
