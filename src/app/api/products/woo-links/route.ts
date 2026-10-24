import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listProductWooLinks } from "@/lib/integrations/product-links-service";

/**
 * Read-only per-branch Woo link and outbox health for Accounting products.
 * Integration details are only shown to members with integration-view access;
 * local product listing remains usable without it.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const integrationAccess = await requirePermission(PERMISSIONS.integrationsView);
  if (integrationAccess.error) return integrationAccess.error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ links: [] });

  const links = await listProductWooLinks(session.businessId, location.id);
  return NextResponse.json({ links });
});
