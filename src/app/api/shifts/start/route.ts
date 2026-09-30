import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidCashFloat } from "@/lib/shift";
import { ShiftError, openShift } from "@/lib/shift-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Self-service clock-in (Phase 20 Wave 5) — the same PIN-role audience as
 * the lock screen and biometric-settings panel. `openingFloat` is optional
 * (Rial): a cashier starting a till counts it, a waiter/kitchen shift
 * usually won't.
 *
 * The caller's active branch is passed down so the shift is attributed to it
 * when the employee session carries no location of its own — an employee with
 * no default branch assigned would otherwise open a branch-less shift that no
 * branch-scoped read can see.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;

  let body: { openingFloat?: number };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (body.openingFloat !== undefined && !isValidCashFloat(body.openingFloat)) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  try {
    const location = await resolveActiveLocation(session);
    const shift = await openShift(
      session.sub,
      session.businessId,
      session.employeeSessionId ?? null,
      body.openingFloat ?? null,
      location?.id ?? null,
      session.role,
    );
    return NextResponse.json({ shift }, { status: 201 });
  } catch (err) {
    if (err instanceof ShiftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
