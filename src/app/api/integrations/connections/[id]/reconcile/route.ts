import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { runHolooReconciliation } from "@/lib/integrations/holoo/reconciliation-service";
import { runReconciliation } from "@/lib/integrations/reconciliation-service";

/** Reconcile a period, dispatching on provider (WooCommerce or Holoo). */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { periodStart?: string; periodEnd?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const now = new Date();
  const periodEnd = body.periodEnd ?? now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const periodStart = body.periodStart ?? start.toISOString().slice(0, 10);

  if (isHoloo(connection)) {
    const result = await runHolooReconciliation(session.businessId, id, session.sub, periodStart, periodEnd);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, reconciliation: result });
  }

  const result = await runReconciliation(session.businessId, id, session.sub, periodStart, periodEnd);
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, reconciliation: result });
});
