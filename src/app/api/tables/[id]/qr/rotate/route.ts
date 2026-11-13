/**
 * ESH-147 (#1305) — rotate a table's printed QR.
 *
 * A separate action from `POST /api/tables/[id]/qr` because the consequences
 * differ: generating makes the table scannable for the first time, rotating
 * invalidates every photograph of the old print. Both are audited by prefix.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { recordFloorAudit } from "@/lib/floor";
import { PERMISSIONS } from "@/lib/permissions";
import { broadcast } from "@/lib/realtime";
import { resolveActiveLocation } from "@/lib/setup-state";
import { rotateTableQrToken, TableQrError } from "@/lib/table-qr-service";

type Params = { params: Promise<{ id: string }> };

export const POST = withTenantScope(async (_request: NextRequest, context: Params) => {
  const { id } = await context.params;
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const state = await rotateTableQrToken({
      businessId: session.businessId,
      locationId: location.id,
      tableId: id,
      userId: session.sub,
    });
    await recordFloorAudit({
      businessId: session.businessId,
      locationId: location.id,
      userId: session.sub,
      action: "table.qr_rotated",
      entity: "dining_table",
      entityId: id,
      payload: { prefix: state.prefix, rotatedFromPrefix: state.rotatedFromPrefix },
    }).catch(() => {});
    broadcast(location.id, { type: "floor.updated", entity: "dining_table", entityId: id });
    return NextResponse.json({ qr: state });
  } catch (err) {
    if (err instanceof TableQrError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
});
