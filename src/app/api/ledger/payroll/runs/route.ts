import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accruePayroll, listPayrollRuns } from "@/lib/payroll-service";
import { parseListPayrollRunsQuery } from "@/lib/payroll-history-query";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

/**
 * The payroll history — newest first, filtered, bounded and cursor-paginated
 * (`?limit=&cursor=&status=&from=&to=&period=`, see `payroll-history-query.ts`).
 * A page carries run summaries only; a run's lines are
 * `GET /api/ledger/payroll/runs/:id`. Gated on `payroll.view`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  try {
    const options = parseListPayrollRunsQuery(request.nextUrl.searchParams);
    return NextResponse.json(await listPayrollRuns(session.businessId, options));
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});

/**
 * Accrues one Jalali month's payroll (`periodKey`, `YYYY-MM`) for every active
 * staff member with a wage: gross-to-net against the business's own payroll
 * settings, posted as one balanced accrual, plus the commission it settles.
 * Gated on `payroll.manage`.
 *
 * Business-wide: the run is not attributed to the caller's active branch, and
 * the branch selector cannot move it.
 *
 * Body: `periodKey`, plus optional `accrualDate` (ISO; default the month's last
 * day, or today while the month is running), `overtime` (`{ [userId]: amount }`,
 * this month's overtime per member), `includeCommission` (default true) and an
 * idempotency key (`Idempotency-Key` header or `idempotencyKey`). A second
 * standing run for the same month is `409 period_already_accrued` naming the
 * run; the same key with the same month replays the run it created (`200`,
 * `idempotentReplay: true`), and with a different one is
 * `409 idempotency_key_conflict`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body) return badRequest();

  // The period is a Jalali month picked from a selector, not a heading somebody
  // types: anything that is not a string is refused here, and the service
  // refuses one that is not a real month, or has not started.
  if (typeof body.periodKey !== "string") return badRequest("invalid_period");
  if (body.accrualDate !== undefined && body.accrualDate !== null && typeof body.accrualDate !== "string") {
    return badRequest("invalid_accrual_date");
  }
  if (body.overtime !== undefined && body.overtime !== null && (typeof body.overtime !== "object" || Array.isArray(body.overtime))) {
    return badRequest("invalid_overtime");
  }
  if (body.includeCommission !== undefined && typeof body.includeCommission !== "boolean") {
    return badRequest();
  }

  const headerKey = request.headers.get("idempotency-key");
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null && typeof body.idempotencyKey !== "string") {
    return badRequest("idempotency_key_invalid");
  }
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
  if (headerKey !== null && bodyKey !== null && headerKey.trim() !== bodyKey.trim()) {
    return badRequest("idempotency_key_invalid");
  }

  try {
    const run = await accruePayroll({
      businessId: session.businessId,
      createdBy: session.sub,
      periodKey: body.periodKey,
      accrualDate: body.accrualDate as string | null | undefined,
      overtime: (body.overtime as Record<string, unknown> | null | undefined) ?? null,
      idempotencyKey: headerKey ?? bodyKey,
      includeCommission: body.includeCommission as boolean | undefined,
    });
    const { idempotentReplay, ...rest } = run;
    return NextResponse.json({ run: rest, idempotentReplay }, { status: idempotentReplay ? 200 : 201 });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
