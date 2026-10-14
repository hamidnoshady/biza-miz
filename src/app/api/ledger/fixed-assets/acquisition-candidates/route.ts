import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listAcquisitionCandidates } from "@/lib/fixed-assets-service";

/** Posted entries that debit the fixed-asset accounts and still hold cost no registered asset claims. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const candidates = await listAcquisitionCandidates(session.businessId);
  return NextResponse.json({ candidates });
});
