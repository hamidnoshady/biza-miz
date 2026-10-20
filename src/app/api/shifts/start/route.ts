import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidCashFloat } from "@/lib/shift";
import { ShiftError, openShift } from "@/lib/shift-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { idempotencyKey, readJsonObject } from "@/lib/request-json";

/**
 * Self-service clock-in (Phase 20 Wave 5).
 *
 * Gated on `shifts.self` since issue #933, not `orders.create`: a shift is
 * attendance, and the kitchen role — which the sidebar drew the button for —
 * does not hold the till's capability.
 *
 * `openingFloat` is optional (integer Rial): a cashier starting a till counts
 * it, a waiter/kitchen shift usually will not.
 *
 * The caller's **active** branch is passed down and is the shift's branch. It
 * used to be a fallback for the session row's own branch, so a member who
 * signed in at Branch A and switched to Branch B opened the shift at A.
 *
 * `Idempotency-Key` is honoured: a retried start returns the shift that key
 * already opened (`201`, same body) instead of `shift_already_open`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.shiftsSelf);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });

  const openingFloat = body.value.openingFloat;
  if (openingFloat !== undefined && openingFloat !== null &&
      (typeof openingFloat !== "number" || !isValidCashFloat(openingFloat))) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  const key = idempotencyKey(request);
  if (key === undefined) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
    const shift = await openShift(
      session.sub,
      session.businessId,
      session.employeeSessionId ?? null,
      typeof openingFloat === "number" ? openingFloat : null,
      location.id,
      session.role,
      key,
    );
    return NextResponse.json({ shift }, { status: 201 });
  } catch (err) {
    if (err instanceof ShiftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
