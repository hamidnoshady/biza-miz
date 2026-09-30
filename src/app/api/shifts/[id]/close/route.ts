import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidCashFloat } from "@/lib/shift";
import { ShiftError, closeShiftById } from "@/lib/shift-service";

/**
 * Admin force-close (Phase 20 Wave 5) — for a shift an employee left open
 * (forgot to clock out, device died, etc.). `team.manage`-gated, same as
 * resetting a member's own credentials.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;
  const { id } = await context.params;

  let body: { closingFloat?: number };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (body.closingFloat !== undefined && !isValidCashFloat(body.closingFloat)) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  try {
    const result = await closeShiftById(id, session.businessId, session.sub, body.closingFloat ?? null, session.role);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ShiftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
