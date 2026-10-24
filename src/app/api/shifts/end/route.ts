import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseShiftCloseInput } from "@/lib/shift-cashup";
import { ShiftError, closeOwnShift } from "@/lib/shift-service";
import { idempotencyKey, readJsonObject } from "@/lib/request-json";

/**
 * Self-service clock-out (Phase 20 Wave 5) — ends the caller's own open shift.
 *
 * A count is optional: a waiter's shift has no drawer. A shift closed without
 * one is stored `unresolved` (NULL variance), never as a zero-variance count
 * nobody performed (#933 items 2 and 10).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.shiftsSelf);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const parsed = parseShiftCloseInput(body.value, {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const key = idempotencyKey(request);
  if (key === undefined) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const result = await closeOwnShift(
      session.sub,
      session.businessId,
      parsed.value.countedCash,
      session.role,
      parsed.value.reason,
      key,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ShiftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
