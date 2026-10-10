import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MulticurrencyError, listOpenLots } from "@/lib/multicurrency-service";

/**
 * The open foreign lots for one party — the settlement screen's selection
 * list. Read-only: what a settlement MAY consume, per direction and currency,
 * with the remaining foreign and booked-base amounts. Reversed documents and
 * reversed settlements never appear (the first no longer represent money
 * owed, the second no longer consumes anything).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const url = new URL(request.url);
  const direction = url.searchParams.get("direction");
  const currencyCode = url.searchParams.get("currency");
  const partyId = url.searchParams.get("partyId");
  if (direction !== "receivable" && direction !== "payable") {
    return NextResponse.json({ error: "invalid_direction" }, { status: 400 });
  }
  if (!currencyCode || !partyId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const lots = await listOpenLots({
      businessId: session.businessId,
      direction,
      currencyCode,
      partyId,
    });
    return NextResponse.json({ lots });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
