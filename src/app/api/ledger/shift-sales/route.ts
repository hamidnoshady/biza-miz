import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { branchShiftSales } from "@/lib/shift-service";

/**
 * The Accounting home's quick report — the branch's running sales for the
 * shift now in progress.
 *
 * Unlike the rest of `/api/ledger/*` this reads orders/payments rather than
 * `journal_lines`, deliberately: the box reports the till, not the books, and
 * it goes back to zero at every shift close (`branchShiftSales` anchors the
 * window on the branch's most recent cash-up). It lives under the ledger
 * prefix because the ledger's own door gates it — owner/manager/accountant,
 * the Accounting app's line — and the `ledger` feature flag applies.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ shiftSales: null, reason: "no_location" });

  return NextResponse.json({ shiftSales: await branchShiftSales(location.id) });
});
