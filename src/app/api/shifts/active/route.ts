import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getActiveShift, shiftCashSummary } from "@/lib/shift-service";
import { reconcileDrawer } from "@/lib/shift-cashup";

/**
 * The caller's own current shift (or null), plus a running cash summary — for
 * the clock-in/out panel.
 *
 * `expectedCash` is the running expectation, shown beside an empty count field:
 * the panel must never prefill the count with it (#933 item 10). `null` means
 * the shift did not track an opening float, so there is no expectation to show.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.shiftsSelf);
  if (error) return error;

  const shift = await getActiveShift(session.sub, session.businessId);
  if (!shift) return NextResponse.json({ shift: null });

  const cashSummary = await shiftCashSummary(session.sub, shift.startedAt, new Date(), shift.id);
  const drawer = reconcileDrawer({
    openingFloat: shift.openingFloat,
    cashSales: cashSummary.cashTotal,
    cashIn: cashSummary.cashMovementsIn,
    cashOut: cashSummary.cashMovementsOut,
    countedCash: null,
  });
  return NextResponse.json({
    shift,
    cashSummary,
    expectedCash: drawer.expectedCash,
    branchId: shift.locationId,
  });
});
