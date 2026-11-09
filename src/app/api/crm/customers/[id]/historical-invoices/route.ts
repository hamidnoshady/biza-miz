import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { listHistoricalInvoices } from "@/lib/data-transfer/historical-invoice-archive-service";

/** Historical evidence is separate from the customer's operational timeline. */
export const GET = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesView);
    if (error) return error;
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
    // Never accept a location from the client: the same active-branch resolver
    // used by sales chooses the member's authorized location.
    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
    const rawOffset = Number(request.nextUrl.searchParams.get("offset") ?? 0);
    const offset = Number.isSafeInteger(rawOffset) ? Math.min(Math.max(rawOffset, 0), 1_000_000) : 0;
    const search = request.nextUrl.searchParams.get("q") ?? "";
    const invoices = await listHistoricalInvoices({
      businessId: session.businessId, locationId: location.id, partyId: id,
      search, limit: 51, offset,
    });
    return NextResponse.json({ invoices: invoices.slice(0, 50), hasMore: invoices.length > 50 }, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);
