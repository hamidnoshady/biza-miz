import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createEngineRun, listEngineRuns } from "@/lib/payroll-engine-runs";
import { resolvePayrollPeriodKey } from "@/lib/payroll-period";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

/** Issue #865 — statutory payroll runs, newest month first (`?period=YYYY-MM`). `payroll.view`. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  const period = request.nextUrl.searchParams.get("period");
  let periodKey: string | null = null;
  if (period) {
    const resolved = resolvePayrollPeriodKey(period);
    if (!resolved.ok) return badRequest("invalid_period");
    periodKey = resolved.period.key;
  }
  return NextResponse.json({ runs: await listEngineRuns(session.businessId, { periodKey }) });
});

/**
 * Opens a draft run: `periodKey` (Jalali `YYYY-MM`), `runType` (`regular` |
 * `supplemental`), `accrualDate?`, `includeCommission?`, `inputs?`
 * (`{ [userId]: { overtimeHours, unpaidLeaveDays, items: [{ code, amount }] } }`),
 * `note?`, idempotency key (`Idempotency-Key` header or body). `payroll.manage`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  try {
    const run = await createEngineRun({
      businessId: session.businessId,
      actorId: session.sub,
      periodKey: body.periodKey,
      runType: body.runType,
      accrualDate: body.accrualDate,
      includeCommission: body.includeCommission,
      inputs: body.inputs,
      note: body.note,
      idempotencyKey: request.headers.get("idempotency-key") ?? body.idempotencyKey,
    });
    const { idempotentReplay, ...rest } = run;
    return NextResponse.json({ run: rest, idempotentReplay }, { status: idempotentReplay ? 200 : 201 });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
