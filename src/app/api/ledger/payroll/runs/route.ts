import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { accruePayroll, listPayrollRuns, MissingLedgerAccountError, PayrollError } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const runs = await listPayrollRuns(session.businessId);
  return NextResponse.json({ runs });
});

/**
 * Accrues one Jalali month's payroll (`periodKey`, `YYYY-MM`) for every active
 * staff member with a wage: gross-to-net against the business's own payroll
 * settings, posted as one balanced accrual. `overtime` is this month's
 * overtime per member, in Rial.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  let body: { periodKey?: unknown; accrualDate?: unknown; overtime?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // The period is a Jalali month picked from a selector, not a heading
  // somebody types: anything that is not a `YYYY-MM` string is refused here,
  // and the service refuses a malformed or future one.
  if (typeof body.periodKey !== "string") {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }
  if (body.accrualDate !== undefined && body.accrualDate !== null && typeof body.accrualDate !== "string") {
    return NextResponse.json({ error: "invalid_accrual_date" }, { status: 400 });
  }
  if (
    body.overtime !== undefined &&
    body.overtime !== null &&
    (typeof body.overtime !== "object" || Array.isArray(body.overtime))
  ) {
    return NextResponse.json({ error: "invalid_overtime" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const run = await accruePayroll({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      periodKey: body.periodKey,
      accrualDate: body.accrualDate as string | null | undefined,
      overtime: (body.overtime as Record<string, unknown> | null | undefined) ?? null,
      createdBy: session.sub,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    if (err instanceof PayrollError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: err.status });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
