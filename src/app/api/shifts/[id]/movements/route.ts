import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ShiftError, recordCashMovement } from "@/lib/shift-service";
import { accessibleLocationIdsForUserIncludingInactive } from "@/lib/setup-state";
import { readJsonObject } from "@/lib/request-json";

/**
 * Issue #933 item 3 — cash in / cash out on a shift.
 *
 * Expected cash used to be "opening float + cash sales", which pretends a
 * drawer only ever changes through a sale. A paid-out, a safe drop or a float
 * handed to a colleague is real, and without it the variance is wrong by that
 * amount with nothing explaining why.
 *
 * A movement needs a direction, an amount and a reason; it is audited and
 * append-only (`shift_cash_movements` refuses UPDATE). The shift owner may
 * record one on their own open shift with `shifts.self`; anybody else needs
 * `shifts.manage`.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error, membership } = await requireAnyPermission(
      PERMISSIONS.shiftsSelf,
      PERMISSIONS.shiftsManage,
    );
    if (error) return error;
    const { id } = await context.params;

    const body = await readJsonObject(request);
    if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });

    const direction = body.value.direction;
    const amount = body.value.amount;
    const reason = body.value.reason;
    if (direction !== "in" && direction !== "out") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof amount !== "number") {
      return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
    }
    if (typeof reason !== "string") {
      return NextResponse.json({ error: "reason_required" }, { status: 400 });
    }

    const canManage = membership?.permissions.has(PERMISSIONS.shiftsManage) ?? false;
    try {
      const movement = await recordCashMovement({
        businessId: session.businessId,
        shiftId: id,
        actorId: session.sub,
        direction,
        amount,
        reason,
        allowedLocationIds: canManage
          ? await accessibleLocationIdsForUserIncludingInactive(session.businessId, session.sub)
          : null,
        // Without `shifts.manage`, only the member's own shift is reachable.
        employeeId: canManage ? undefined : session.sub,
      });
      return NextResponse.json({ movement }, { status: 201 });
    } catch (err) {
      if (err instanceof ShiftError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
