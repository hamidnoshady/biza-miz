import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PartyValidationError, bulkAssignMissingStaffAccountingCodes } from "@/lib/parties-service";

/**
 * POST /api/parties/assign-codes
 *
 * One-click bulk heal for Issue #1006: assign automatic accounting codes to
 * every Employee in this business whose accounting_code is still NULL.
 *
 * Gated by `parties.manage` (write), not a read-only ledger view permission:
 * it mutates the parties table en masse and is triggered by the directory's
 * own toolbar button. The API mirrors the same permission the directory's
 * «افزودن» button requires, so only members who can already create parties
 * can bulk-heal missing codes.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
  if (error) return error;

  try {
    const result = await bulkAssignMissingStaffAccountingCodes(session.businessId, {
      actorId: session.sub,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PartyValidationError) {
      return NextResponse.json(
        { error: err.code, fieldErrors: err.field ? { [err.field]: err.code } : undefined },
        { status: 409 },
      );
    }
    throw err;
  }
});
