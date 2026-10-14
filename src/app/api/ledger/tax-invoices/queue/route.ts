import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listPendingQueue } from "@/lib/tax-invoice-queries";
import { taxErrorResponse } from "@/lib/tax-invoice-http";

/** Records waiting to go out or waiting for the authority's answer. */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  try {
    const rows = await listPendingQueue(session.businessId);
    return NextResponse.json({ rows });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
