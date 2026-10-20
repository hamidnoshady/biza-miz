import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ShiftError, adjustShiftCashup } from "@/lib/shift-service";
import { accessibleLocationIdsForUserIncludingInactive } from "@/lib/setup-state";
import { readJsonObject } from "@/lib/request-json";

/**
 * Issue #933 item 2 — correcting a finalized cash-up, without rewriting it.
 *
 * `shift_cashups` is immutable at the database (an UPDATE is refused by the
 * trigger in migration 0233). A correction is a linked row with before/after
 * values, a mandatory reason and the actor, and it is audited. This is the only
 * supported way to change what a closed shift's variance is understood to be,
 * and it leaves the original figure visible.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.shiftsManage);
    if (error) return error;
    const { id } = await context.params;

    const body = await readJsonObject(request);
    if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });

    const delta = body.value.delta;
    const reason = body.value.reason;
    if (typeof delta !== "number" || !Number.isSafeInteger(delta)) {
      return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
    }
    if (typeof reason !== "string" || !reason.trim()) {
      return NextResponse.json({ error: "reason_required" }, { status: 400 });
    }

    try {
      const result = await adjustShiftCashup({
        businessId: session.businessId,
        shiftId: id,
        actorId: session.sub,
        actorRole: session.role,
        delta,
        reason,
        allowedLocationIds: await accessibleLocationIdsForUserIncludingInactive(session.businessId, session.sub),
      });
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof ShiftError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
