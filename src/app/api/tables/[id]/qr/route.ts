/**
 * ESH-147 (#1305) — staff table-QR identity.
 *
 * `GET` reads the active token's masked state; `POST` generates one (or
 * returns the existing one, idempotently); `DELETE` revokes it. Rotation has
 * its own route (`./rotate`) because it is a distinct, auditable action rather
 * than a flag on generate.
 *
 * The token never appears in any JSON response — only `prefix` does. The
 * printable value lives inside `./image`'s PNG/SVG, so copying this response
 * cannot be turned into a working table QR.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordFloorAudit } from "@/lib/floor";
import { PERMISSIONS } from "@/lib/permissions";
import { broadcast } from "@/lib/realtime";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  ensureTableQrToken,
  getTableQrState,
  revokeTableQrToken,
  TableQrError,
} from "@/lib/table-qr-service";

type Params = { params: Promise<{ id: string }> };

async function tableExists(locationId: string, tableId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2",
    [tableId, locationId],
  );
  return rows.length > 0;
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof TableQrError) {
    return NextResponse.json({ error: err.reason }, { status: err.status });
  }
  throw err;
}

export const GET = withTenantScope(async (_request: NextRequest, context: Params) => {
  const { id } = await context.params;
  const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await tableExists(location.id, id))) {
    return NextResponse.json({ error: "table_not_found" }, { status: 404 });
  }

  const state = await getTableQrState(session.businessId, location.id, id);
  // Null is a real answer: the table has never been printed. The panel uses it
  // to offer «ساخت QR» instead of a rotate button.
  return NextResponse.json({ qr: state });
});

export const POST = withTenantScope(async (_request: NextRequest, context: Params) => {
  const { id } = await context.params;
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const result = await ensureTableQrToken({
      businessId: session.businessId,
      locationId: location.id,
      tableId: id,
      userId: session.sub,
    });
    await recordFloorAudit({
      businessId: session.businessId,
      locationId: location.id,
      userId: session.sub,
      action: "table.qr_generated",
      entity: "dining_table",
      entityId: id,
      // The prefix identifies the print; the token itself is never audited.
      payload: { prefix: result.state.prefix, created: result.created },
    }).catch(() => {});
    if (result.created) {
      broadcast(location.id, { type: "floor.updated", entity: "dining_table", entityId: id });
    }
    return NextResponse.json({ qr: result.state, created: result.created });
  } catch (err) {
    return errorResponse(err);
  }
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: Params) => {
  const { id } = await context.params;
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const revoked = await revokeTableQrToken({
      businessId: session.businessId,
      locationId: location.id,
      tableId: id,
      userId: session.sub,
    });
    if (revoked) {
      await recordFloorAudit({
        businessId: session.businessId,
        locationId: location.id,
        userId: session.sub,
        action: "table.qr_revoked",
        entity: "dining_table",
        entityId: id,
        payload: {},
      }).catch(() => {});
      broadcast(location.id, { type: "floor.updated", entity: "dining_table", entityId: id });
    }
    return NextResponse.json({ ok: true, revoked });
  } catch (err) {
    return errorResponse(err);
  }
});
