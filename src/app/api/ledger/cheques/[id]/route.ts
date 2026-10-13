import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getChequeDetail } from "@/lib/cheques-service";
import { chequeErrorResponse } from "../errors";

/**
 * One cheque, with the cheque it replaces and the cheques issued to replace
 * it — enough for the detail view to stand on its own once the register page
 * it was opened from has been filtered or paged away.
 *
 * Read permission only; the service scopes every read to the session's
 * business, so another tenant's id is a 404 rather than a leak of its
 * existence.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
    if (error) return error;
    const { id } = await context.params;
    try {
      return NextResponse.json(await getChequeDetail(session.businessId, id));
    } catch (err) {
      return chequeErrorResponse(err);
    }
  },
);
