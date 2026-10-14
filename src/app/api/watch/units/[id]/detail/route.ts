import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, getSerial } from "@/lib/items-service";
import { serialUnitDetail } from "@/lib/watch-serial-detail";

/**
 * Issue #795 Phase 6 — the serial detail view: the unit's whole file
 * (identity, model attributes, warranty, owner, provenance + media,
 * repair history, live hold, transfer history) in one request.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    const serial = await getSerial(id);
    if (!location || !serial) {
      return NextResponse.json({ error: "serial_not_found" }, { status: 404 });
    }
    const item = await getItem(serial.itemId);
    if (!item || item.locationId !== location.id) {
      return NextResponse.json({ error: "serial_not_found" }, { status: 404 });
    }

    const detail = await serialUnitDetail(id);
    if (!detail) return NextResponse.json({ error: "serial_not_found" }, { status: 404 });
    return NextResponse.json({ detail });
  },
);
