import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { previewStockAuthority } from "@/lib/duplicate-items-stock-authority-service";

/**
 * Issue #1592 — the read-only stock-authority preview for historical duplicate
 * pairs whose older row still holds quantity.
 *
 * GET only. There is no POST: no endpoint, button or script may archive a
 * stocked row or move stock from this evidence. The payload carries the exact
 * per-SKU comparison (orphan / surviving row / newest store quantity) and an
 * `approvalToken` over the rows the evidence says are safe; an owner approves
 * that token separately, and a production write remains a separate change.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  // The evidence is integration data (store quantity, remote ids).
  const integrationAccess = await requirePermission(PERMISSIONS.integrationsView);
  if (integrationAccess.error) return integrationAccess.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  const sku = request.nextUrl.searchParams.get("sku")?.trim() || null;
  if (sku && sku.length > 120) return NextResponse.json({ error: "invalid_sku" }, { status: 400 });

  const preview = await previewStockAuthority(session.businessId, {
    sku,
    locationId: location?.id ?? null,
  });
  return NextResponse.json({ preview });
});
