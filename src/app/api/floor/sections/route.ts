import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import * as floor from "@/lib/floor";
import { broadcast } from "@/lib/realtime";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Create a floor section (a zone on the map, optionally owned by a waiter/cashier). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;

  let body: { name?: string; color?: string | null; assignedWaiterId?: string | null; sortOrder?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: dup } = await query("SELECT id FROM floor_sections WHERE location_id = $1 AND name = $2", [
    location.id,
    name,
  ]);
  if (dup.length > 0) return NextResponse.json({ error: "section_exists" }, { status: 409 });

  const waiterId = await floor.validWaiterId(session.businessId, location.id, body.assignedWaiterId);
  if (waiterId === false) return NextResponse.json({ error: "waiter_not_found" }, { status: 400 });

  const explicitSortOrder =
    body.sortOrder !== undefined && Number.isFinite(body.sortOrder)
      ? Math.max(-10000, Math.min(100000, Math.round(Number(body.sortOrder))))
      : null;

  const { rows } = await query<{ id: string }>(
    explicitSortOrder !== null
      ? `INSERT INTO floor_sections (location_id, name, color, assigned_waiter_id, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`
      : `INSERT INTO floor_sections (location_id, name, color, assigned_waiter_id, sort_order)
         SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order) + 1, 0)
           FROM floor_sections WHERE location_id = $1
         RETURNING id`,
    explicitSortOrder !== null
      ? [location.id, name, body.color?.trim() || null, waiterId, explicitSortOrder]
      : [location.id, name, body.color?.trim() || null, waiterId],
  );

  await floor.recordFloorAudit?.({
    businessId: session.businessId,
    locationId: location.id,
    userId: session.sub,
    action: "floor_section.created",
    entity: "floor_section",
    entityId: rows[0].id,
    payload: { name, color: body.color?.trim() || null, assignedWaiterId: waiterId },
  }).catch(() => {});

  broadcast(location.id, {
    type: "floor.updated",
    entity: "floor_section",
    entityId: rows[0].id,
  });

  return NextResponse.json({ ok: true, id: rows[0].id });
});
