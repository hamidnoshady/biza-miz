import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listRenumberLog } from "@/lib/voucher-numbering-service";

/**
 * The renumber audit trail (issue #867): every renumber, newest first —
 * entry, book, old number, new number, reason, who. The append-only half of
 * the "privileged and auditable" pair.
 */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  return NextResponse.json(await listRenumberLog(session.businessId));
});
