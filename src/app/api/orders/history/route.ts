import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { parseOrderHistoryFilters } from "@/lib/order-history";
import { listOrderHistory } from "@/lib/order-history-service";

export const dynamic = "force-dynamic";

/** Branch-scoped, server-side searchable and paginated order history. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;

  const parsed = parseOrderHistoryFilters(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const access = await memberAccessFor(session);
  const canReviewShifts = access?.permissions.has(PERMISSIONS.reportsView) ?? false;
  if (parsed.filters.shiftId && !canReviewShifts) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const result = await listOrderHistory({
    businessId: session.businessId,
    locationId: location.id,
    timeZone: location.timezone,
    filters: parsed.filters,
    canReviewShifts,
  });
  return NextResponse.json({ ...result, timeZone: location.timezone });
});
