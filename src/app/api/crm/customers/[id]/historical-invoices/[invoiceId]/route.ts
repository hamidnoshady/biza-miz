import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { listHistoricalInvoiceLines } from "@/lib/data-transfer/historical-invoice-archive-service";

export const GET = withTenantScope(async (request: NextRequest, { params }: { params: Promise<{ id: string; invoiceId: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesView);
  if (error) return error;
  const { id, invoiceId } = await params;
  if (!isUuid(id) || !isUuid(invoiceId)) return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const rawOffset = Number(request.nextUrl.searchParams.get("offset") ?? 0);
  const page = await listHistoricalInvoiceLines({ businessId: session.businessId, locationId: location.id, invoiceId, partyId: id, offset: rawOffset });
  if (!page) return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
});
