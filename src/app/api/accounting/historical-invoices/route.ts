import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listHistoricalInvoices } from "@/lib/data-transfer/historical-invoice-archive-service";

/** Read-only archive alongside sales; it is never part of orders or reports. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const rawOffset = Number(request.nextUrl.searchParams.get("offset") ?? 0);
  const offset = Number.isSafeInteger(rawOffset) ? Math.min(Math.max(rawOffset, 0), 1_000_000) : 0;
  const search = request.nextUrl.searchParams.get("q") ?? "";
  const invoices = await listHistoricalInvoices({ businessId: session.businessId, locationId: location.id, search, limit: 51, offset });
  return NextResponse.json({ invoices: invoices.slice(0, 50), hasMore: invoices.length > 50 }, { headers: { "Cache-Control": "no-store" } });
});
