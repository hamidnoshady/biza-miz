import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { todayIsoDate } from "@/lib/jalali";
import { parseCreateReconciliationRequest, parseReconciliationAccountSelector } from "@/lib/bank-reconciliation";
import { financialReportAccess } from "@/lib/financial-report-access";
import {
  createReconciliation,
  ReconciliationError,
  listReconciliations,
  listReconciliationAccounts,
} from "@/lib/reconciliation-service";

/** List eligible account choices, or one registered/legacy account's history. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const access = await financialReportAccess(session);
  try {
    if (search.get("accounts") === "1") {
      return NextResponse.json(await listReconciliationAccounts(session.businessId, access));
    }
    const selector = parseReconciliationAccountSelector(search.get("accountCode"), search.get("financialAccountId"));
    if (!selector) return NextResponse.json({ error: "invalid_account" }, { status: 400 });
    return NextResponse.json({ reconciliations: await listReconciliations(session.businessId, selector, access) });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/** Starts a reconciliation for the selected GL. Only one may be in progress. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReconciliationManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseCreateReconciliationRequest(body, { todayIso: todayIsoDate() });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const reconciliation = await createReconciliation({
      businessId: session.businessId,
      ...parsed.value,
      ...await financialReportAccess(session),
      createdBy: session.sub,
    });
    return NextResponse.json({ reconciliation }, { status: 201 });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
