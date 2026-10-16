import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  setEmployeeDefaultDimensions,
  setStaffPayTerms,
  type StaffPayTermsPatch,
} from "@/lib/payroll-service";
import { PAY_TERMS } from "@/lib/payroll-types";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Sets some of one member's standing pay terms — `monthlyWage`,
 * `taxableAllowance`, `nonTaxableAllowance`, `fixedDeduction` — and records
 * every change (who, when, from what to what, and the optional `reason`).
 * Also sets the member's default dimension tuple (`defaultDimensions`, issue
 * #868). Gated on `payroll.manage`.
 *
 * Only the keys present are written, so saving the wage cannot zero an
 * allowance the caller did not send. Each present term key must be a JSON
 * number (a whole, non-negative Rial amount up to 2^53 − 1) — or, for the wage
 * alone, an explicit `null`, meaning «no wage set». Nothing else is an amount:
 * not a string, not `true`, not `[]`, not `{}`.
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
  // Issue #868 — the same door also sets the member's default dimension tuple
  // (`defaultDimensions`, explicit `null`/`{}` clears it). One PATCH per member,
  // one permission (`payroll.manage`), one audit surface.
  const hasDimensions = "defaultDimensions" in body;
  if (Object.keys(patch).length === 0 && !hasDimensions) return badRequest();

  try {
    const result =
      Object.keys(patch).length > 0
        ? await setStaffPayTerms({
            businessId: session.businessId,
            userId: id,
            patch,
            actorId: session.sub,
            reason: body.reason as string | null | undefined,
          })
        : { changed: false, changes: [] };
    const dimensions = hasDimensions
      ? await setEmployeeDefaultDimensions({
          businessId: session.businessId,
          userId: id,
          dimensions: body.defaultDimensions ?? {},
          actorId: session.sub,
        })
      : null;
    return NextResponse.json({ ok: true, ...result, ...(dimensions ?? {}) });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
