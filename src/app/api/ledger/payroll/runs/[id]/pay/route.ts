import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { payPayroll } from "@/lib/payroll-service";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

const METHODS = ["cash", "bank"] as const;

/**
 * Pays out an accrued payroll run — wage and commission together: Debit
 * salaries payable / Credit the payment account. Gated on `payroll.manage`.
 *
 * Body (all optional): `paymentAccountId` — one of the business's cash, bank or
 * petty-cash accounts (`GET /api/ledger/payroll/preview` lists them); `method`
 * (`cash` → صندوق, `bank` → بانک, the shorthand when no account is named);
 * `paidDate` (ISO, default today, never before the accrual date).
 *
 * The payment is posted with the run's own location, not the caller's active
 * branch — it cannot land on a different branch than the accrual.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const { id } = await ctx.params;
  // An empty body is fine (cash, today); a body that is present and is not a
  // JSON object is not — it used to be ignored, silently paying out of cash.
  const body = await readJsonObject(request, { emptyIsObject: true });
  if (!body) return badRequest();

  /*
   * An unrecognised method used to fall back to `cash` silently, so a typo or
   * a stale client posted the wage bill out of the till while the caller
   * believed it went out of the bank — the two credit different accounts and
   * the entry cannot be told apart afterwards. Absent still means cash (the
   * documented default); a *wrong* value is refused.
   */
  if (body.method !== undefined && !METHODS.includes(body.method as (typeof METHODS)[number])) {
    return badRequest("invalid_method");
  }
  if (body.paymentAccountId !== undefined && body.paymentAccountId !== null && typeof body.paymentAccountId !== "string") {
    return badRequest("invalid_payment_account");
  }
  if (body.paidDate !== undefined && body.paidDate !== null && typeof body.paidDate !== "string") {
    return badRequest("invalid_paid_date");
  }

  try {
    const run = await payPayroll({
      businessId: session.businessId,
      runId: id,
      method: (body.method as "cash" | "bank" | undefined) ?? "cash",
      paymentAccountId: (body.paymentAccountId as string | null | undefined) ?? null,
      paidDate: body.paidDate as string | null | undefined,
      actorId: session.sub,
    });
    return NextResponse.json({ run });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
