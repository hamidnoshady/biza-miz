import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getFiscalReadiness } from "@/lib/fiscal-periods-service";

/**
 * Fiscal-period readiness (audit F08): is a fiscal year configured, is the
 * business's today covered, how many entries sit outside every period, and
 * whether coverage lets a year be closed. Read-only — it reports, it never
 * rejects or moves an entry. Same read gate as the fiscal-year list.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  return NextResponse.json({ readiness: await getFiscalReadiness(session.businessId) });
});
