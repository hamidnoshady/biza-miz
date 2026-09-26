import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getRetailInvoiceDetail } from "@/lib/retail-invoice/read-service";
import { getRetailInvoicePrintData } from "@/lib/retail-invoice/print-data";

/**
 * One retail invoice's detail — the dedicated read model behind
 * `RetailInvoiceDetailModal`, never `getOrderDetail` (that reads
 * tables/menu, neither of which a retail sale has; see
 * src/lib/retail-invoice/read-service.ts's header comment).
 *
 * `?view=print` returns the same document the first print used
 * (`getRetailInvoicePrintData` — one canonical builder for first print and
 * every later reprint), instead of the raw detail shape.
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const view = request.nextUrl.searchParams.get("view");
  if (view === "print") {
    const printData = await getRetailInvoicePrintData(session.businessId, location.id, id);
    if (!printData) return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
    return NextResponse.json(printData);
  }

  const invoice = await getRetailInvoiceDetail(session.businessId, location.id, id);
  if (!invoice) return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
  return NextResponse.json({ invoice });
});
