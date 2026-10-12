import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { setStaffPayTerms, type StaffPayTermsPatch } from "@/lib/payroll-service";
import { PAY_TERMS } from "@/lib/payroll-types";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Sets some of one member's standing pay terms — `monthlyWage`,
 * `taxableAllowance`, `nonTaxableAllowance`, `fixedDeduction` — and records
 * every change (who, when, from what to what, and the optional `reason`).
 * Gated on `payroll.manage`.
 *
 * Only the keys present are written, so saving the wage cannot zero an
 * allowance the caller did not send. Each present key must be a JSON number (a
 * whole, non-negative Rial amount up to 2^53 − 1) — or, for the wage alone, an
 * explicit `null`, meaning «no wage set». Nothing else is an amount: not a
 * string, not `true`, not `[]`, not `{}`.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const { id } = await ctx.params;
  const body = await readJsonObject(request);
  if (!body) return badRequest();

  /*
   * `Number(…)` used to coerce the body, which quietly accepted values that
   * are not amounts: `true` became 1 rial, `[]` and `""` became 0, and a
   * missing key became `null` — so a malformed request silently *cleared* or
   * mangled somebody's wage instead of being refused.
   */
  const patch: StaffPayTermsPatch = {};
  for (const term of PAY_TERMS) {
    if (!(term in body)) continue;
    const raw = body[term];
    if (raw === null && term === "monthlyWage") patch[term] = null;
    else if (typeof raw === "number") patch[term] = raw;
    else return NextResponse.json({ error: "invalid_amount", field: term }, { status: 400 });
  }
  // A body naming none of the terms used to clear the wage; now it changes nothing and says so.
  if (Object.keys(patch).length === 0) return badRequest();

  try {
    const result = await setStaffPayTerms({
      businessId: session.businessId,
      userId: id,
      patch,
      actorId: session.sub,
      reason: body.reason as string | null | undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
