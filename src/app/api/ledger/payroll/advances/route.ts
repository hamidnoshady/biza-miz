import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listAdvances, recordAdvance } from "@/lib/payroll-advances-service";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

const METHODS = ["cash", "bank"] as const;

/** The business's most recent salary advances (a bounded list). Gated on `payroll.view`. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const advances = await listAdvances(session.businessId);
  return NextResponse.json({ advances });
});

/**
 * Pays a salary advance (مساعده) to a member: Debit staff advances / Credit a
 * cash, bank or petty-cash account of the business's own chart — the same payout
 * choice a run's payment offers (`paymentAccountId`, or `method`: cash → صندوق,
 * bank → بانک). The next payroll run recovers it from the member's pay. Gated on
 * `payroll.manage`.
 *
 * Business-wide, like the run that recovers it: the entry is not attributed to
 * the caller's active branch. `amount` is a JSON number (a whole Rial amount up
 * to 2^53 − 1) — not a string, not `true`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body) return badRequest();

  if (typeof body.userId !== "string") return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (typeof body.amount !== "number") return badRequest("invalid_amount");
  // An unrecognised method is refused rather than defaulted, for the same
  // reason the run's payment refuses one: cash and bank are different accounts.
  if (body.method !== undefined && !METHODS.includes(body.method as (typeof METHODS)[number])) {
    return badRequest("invalid_method");
  }
  if (body.paymentAccountId !== undefined && body.paymentAccountId !== null && typeof body.paymentAccountId !== "string") {
    return badRequest("invalid_payment_account");
  }
  if (body.advanceDate !== undefined && body.advanceDate !== null && typeof body.advanceDate !== "string") {
    return badRequest("invalid_advance_date");
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return badRequest();
  }

  try {
    const advance = await recordAdvance({
      businessId: session.businessId,
      userId: body.userId,
      amount: body.amount,
      method: (body.method as "cash" | "bank" | undefined) ?? "cash",
      paymentAccountId: (body.paymentAccountId as string | null | undefined) ?? null,
      advanceDate: body.advanceDate as string | null | undefined,
      note: body.note as string | null | undefined,
      createdBy: session.sub,
    });
    return NextResponse.json({ advance }, { status: 201 });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
