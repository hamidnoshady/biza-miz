import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseShiftCloseInput } from "@/lib/shift-cashup";
import { ShiftError, closeShiftById } from "@/lib/shift-service";
import { accessibleLocationIdsForUserIncludingInactive } from "@/lib/setup-state";
import { idempotencyKey, readJsonObject } from "@/lib/request-json";

/**
 * Admin force-close (Phase 20 Wave 5) — for a shift an employee left open
 * (forgot to clock out, device died, etc.).
 *
 * ## What changed in issue #933
 *
 *   * `shifts.manage`, not `team.manage` — the capability that owns the screen.
 *   * The caller's reachable branches are enforced: another branch's shift id is
 *     answered exactly like a missing one, so a constrained manager cannot use
 *     this route to probe or close it (#933 item 5).
 *   * `countedCash` is what a person counted. The screen no longer sends the
 *     expected figure as a default; an operator who has not counted sends
 *     `withoutCount: true` **and a reason**, and the close is stored
 *     `unresolved` with a NULL variance (#933 item 10).
 *   * A repeated request returns the committed cash-up rather than
 *     `no_active_shift`, so a timeout the browser retried is not a 500
 *     (#933 item 1).
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.shiftsManage);
    if (error) return error;
    const { id } = await context.params;

    const body = await readJsonObject(request);
    if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });

    // Parsed here *and* in the service: here to answer the field-level error
    // codes before touching the database, there so no other caller can skip the
    // "an uncounted force-close needs a reason" rule.
    const parsed = parseShiftCloseInput(body.value, { requireReasonWhenUncounted: true });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const key = idempotencyKey(request);
    if (key === undefined) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    const allowedLocationIds = await accessibleLocationIdsForUserIncludingInactive(session.businessId, session.sub);
    try {
      const result = await closeShiftById(
        id,
        session.businessId,
        session.sub,
        parsed.value.countedCash,
        session.role,
        { reason: parsed.value.reason, allowedLocationIds, requestId: key },
      );
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof ShiftError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
