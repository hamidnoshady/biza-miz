import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listAdvances, MissingLedgerAccountError, PayrollError, recordAdvance } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

const METHODS = ["cash", "bank"] as const;

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const advances = await listAdvances(session.businessId);
  return NextResponse.json({ advances });
});

/**
 * Pays a salary advance (مساعده) to a member: Debit staff advances / Credit
 * Cash or Bank-Clearing — the same payout choice a run's payment offers. The
 * next payroll run recovers it from the member's pay.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  let body: { userId?: unknown; amount?: unknown; method?: unknown; advanceDate?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.userId !== "string") return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (typeof body.amount !== "number") return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  // An unrecognised method is refused rather than defaulted, for the same
  // reason the run's payment refuses one: cash and bank are different accounts.
  if (body.method !== undefined && !METHODS.includes(body.method as (typeof METHODS)[number])) {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }
  if (body.advanceDate !== undefined && body.advanceDate !== null && typeof body.advanceDate !== "string") {
    return NextResponse.json({ error: "invalid_advance_date" }, { status: 400 });
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const advance = await recordAdvance({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      userId: body.userId,
      amount: body.amount,
      method: (body.method as "cash" | "bank" | undefined) ?? "cash",
      advanceDate: body.advanceDate as string | null | undefined,
      note: body.note as string | null | undefined,
      createdBy: session.sub,
    });
    return NextResponse.json({ advance }, { status: 201 });
  } catch (err) {
    if (err instanceof PayrollError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
