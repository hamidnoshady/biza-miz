import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createFiscalYear, FiscalPeriodError, listFiscalYears } from "@/lib/fiscal-periods-service";
import { isSupportedFiscalYear } from "@/lib/fiscal-periods";

/** Every fiscal year defined for this business. Readers need ledger.view; creation needs ledger.close_period. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  return NextResponse.json({ fiscalYears: await listFiscalYears(session.businessId) });
});

/**
 * Defines a fiscal year (the Jalali year `jy`) and its twelve periods.
 * `ledger.close_period` — the same effective capability that gates
 * soft-closing/locking a period, since defining a year is the same
 * kind of act: setting up the structure the rest of the phase's period
 * enforcement runs against.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerClosePeriod);
  if (error) return error;

  let body: { year?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // JSON numbers are the API contract. Coercing a string/boolean/object with
  // Number() made malformed requests look valid and let a future form drift
  // silently past its own validation.
  const jy = typeof body.year === "number" ? body.year : Number.NaN;
  if (!isSupportedFiscalYear(jy)) {
    return NextResponse.json({ error: "invalid_year" }, { status: 400 });
  }

  try {
    const fiscalYear = await createFiscalYear(session.businessId, jy, session.sub);
    return NextResponse.json({ fiscalYear }, { status: 201 });
  } catch (err) {
    if (err instanceof FiscalPeriodError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
