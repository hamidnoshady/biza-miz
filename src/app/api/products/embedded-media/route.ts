import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { embeddedMediaReport } from "@/lib/embedded-media-report-service";

/**
 * GH #1567 F5 — read-only list of legacy catalogue/menu rows that still carry
 * inline image bytes (written before the rule). Nothing is modified: the
 * owner fixes each row through the guarded product/menu form.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.menuView);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const rows = await embeddedMediaReport(session.businessId, location.id);
  return NextResponse.json({ rows });
});
