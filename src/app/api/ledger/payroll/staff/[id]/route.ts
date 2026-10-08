import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PayrollError, setStaffPayTerms, type StaffPayTermsPatch } from "@/lib/payroll-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** The standing monthly figures besides the wage, all integer Rial ≥ 0. */
const AMOUNT_KEYS = ["taxableAllowance", "nonTaxableAllowance", "fixedDeduction"] as const;

export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  /*
   * `Number(…)` used to coerce the body, which quietly accepted values that
   * are not amounts: `true` became 1 rial, `[]` and `""` became 0, and a
   * missing key became `null` — so a malformed request silently *cleared* or
   * mangled somebody's wage instead of being refused. Only a real number (or
   * an explicit null, meaning «no wage set») is a wage; the service still
   * range-checks it. Only the keys present are written.
   */
  const patch: StaffPayTermsPatch = {};
  if ("monthlyWage" in body) {
    const raw = body.monthlyWage;
    if (raw === null || raw === undefined) patch.monthlyWage = null;
    else if (typeof raw === "number") patch.monthlyWage = raw;
    else return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }
  for (const key of AMOUNT_KEYS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (typeof raw !== "number") return NextResponse.json({ error: "invalid_amount", field: key }, { status: 400 });
    patch[key] = raw;
  }
  // A body naming none of the terms used to clear the wage; now it changes nothing and says so.
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    await setStaffPayTerms(session.businessId, id, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PayrollError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: err.status });
    }
    throw err;
  }
});
