import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import * as floor from "@/lib/floor";
import { broadcast } from "@/lib/realtime";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Operational table list for the dine-in picker. Reading/using tables stays
 * available to floor roles with `tables.manage`; creating a table is a
 * structural floor-plan edit and uses `tables.edit` below.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ tables: [] });

  const { rows: tables } = await query(
    `SELECT dt.id, dt.name, dt.zone, dt.section_id, dt.capacity, dt.status, dt.sort_order,
            dt.pos_x, dt.pos_y, dt.width, dt.height, dt.shape, dt.note,
            (SELECT COUNT(*)::int
               FROM orders o
              WHERE o.location_id = dt.location_id
                AND o.table_id = dt.id
                AND o.status IN ('open', 'held')
            ) AS active_order_count
       FROM dining_tables dt
      WHERE dt.location_id = $1 AND dt.is_active
      ORDER BY dt.sort_order, dt.name`,
    [location.id],
  );
  return NextResponse.json({ tables });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;

  let body: {
    name?: string;
    zone?: string;
    sectionId?: string | null;
    capacity?: number;
    sortOrder?: number;
    posX?: number;
    posY?: number;
    width?: number;
    height?: number;
    shape?: string;
    note?: string | null;
    restoreArchived?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  const capacity = Number.isFinite(body.capacity) ? Math.round(Number(body.capacity)) : 2;
  if (!name || capacity <= 0 || capacity > 200) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (body.shape !== undefined && body.shape !== "rect" && body.shape !== "circle") {
    return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
  }
  const shape = body.shape === "circle" ? "circle" : "rect";

  if (
    (body.posX !== undefined && (!Number.isFinite(body.posX) || Number(body.posX) < 0 || Number(body.posX) > 5000)) ||
    (body.posY !== undefined && (!Number.isFinite(body.posY) || Number(body.posY) < 0 || Number(body.posY) > 5000)) ||
    (body.width !== undefined && (!Number.isFinite(body.width) || Number(body.width) < 30 || Number(body.width) > 400)) ||
    (body.height !== undefined && (!Number.isFinite(body.height) || Number(body.height) < 30 || Number(body.height) > 400)) ||
    (body.sortOrder !== undefined && (!Number.isFinite(body.sortOrder) || Number(body.sortOrder) < -10000 || Number(body.sortOrder) > 100000))
  ) {
    return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const sectionId = await floor.resolveSectionId(location.id, body.sectionId);
  if (sectionId === false) return NextResponse.json({ error: "section_not_found" }, { status: 400 });

  const clampPos = (v: unknown, def: number) => (Number.isFinite(v) ? Math.max(0, Math.round(Number(v))) : def);
  const clampSize = (v: unknown, def: number) =>
    Number.isFinite(v) ? Math.min(400, Math.max(30, Math.round(Number(v)))) : def;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;

  const { rows: dup } = await query<{ id: string; name?: string; is_active?: boolean }>(
    "SELECT id, name, is_active FROM dining_tables WHERE location_id = $1 AND name = $2",
    [location.id, name],
  );
  if (dup.length > 0) {
    if (dup[0].is_active === false) {
      if (body.restoreArchived === true) {
        await query(
          `UPDATE dining_tables
              SET is_active = TRUE,
                  status = 'free',
                  zone = $2,
                  section_id = $3,
                  capacity = $4,
                  pos_x = $5,
                  pos_y = $6,
                  width = $7,
                  height = $8,
                  shape = $9,
                  note = $10
            WHERE id = $1 AND location_id = $11`,
          [
            dup[0].id,
            body.zone?.trim() || null,
            sectionId,
            capacity,
            clampPos(body.posX, 20),
            clampPos(body.posY, 20),
            clampSize(body.width, 80),
            clampSize(body.height, 80),
            shape,
            note,
            location.id,
          ],
        );
        await floor.recordFloorAudit?.({
          businessId: session.businessId,
          locationId: location.id,
          userId: session.sub,
          action: "table.restored",
          entity: "dining_table",
          entityId: dup[0].id,
          payload: { name, capacity, sectionId },
        }).catch(() => {});
        broadcast(location.id, {
          type: "floor.updated",
          entity: "dining_table",
          entityId: dup[0].id,
        });
        return NextResponse.json({ ok: true, id: dup[0].id, restored: true });
      }
      return NextResponse.json(
        {
          error: "table_exists_archived",
          archivedTableId: dup[0].id,
          archivedTableName: dup[0].name ?? name,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "table_exists" }, { status: 409 });
  }

  const explicitSortOrder =
    body.sortOrder !== undefined && Number.isFinite(body.sortOrder)
      ? Math.round(Number(body.sortOrder))
      : null;

  const { rows } = await query<{ id: string }>(
    explicitSortOrder !== null
      ? `INSERT INTO dining_tables (location_id, name, zone, section_id, capacity, sort_order,
                pos_x, pos_y, width, height, shape, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`
      : `INSERT INTO dining_tables (location_id, name, zone, section_id, capacity, sort_order,
                pos_x, pos_y, width, height, shape, note)
         SELECT $1, $2, $3, $4, $5, COALESCE(MAX(sort_order) + 1, 0), $6, $7, $8, $9, $10, $11
           FROM dining_tables WHERE location_id = $1
         RETURNING id`,
    explicitSortOrder !== null
      ? [
          location.id,
          name,
          body.zone?.trim() || null,
          sectionId,
          capacity,
          explicitSortOrder,
          clampPos(body.posX, 20),
          clampPos(body.posY, 20),
          clampSize(body.width, 80),
          clampSize(body.height, 80),
          shape,
          note,
        ]
      : [
          location.id,
          name,
          body.zone?.trim() || null,
          sectionId,
          capacity,
          clampPos(body.posX, 20),
          clampPos(body.posY, 20),
          clampSize(body.width, 80),
          clampSize(body.height, 80),
          shape,
          note,
        ],
  );

  await floor.recordFloorAudit?.({
    businessId: session.businessId,
    locationId: location.id,
    userId: session.sub,
    action: "table.created",
    entity: "dining_table",
    entityId: rows[0].id,
    payload: { name, capacity, sectionId, shape },
  }).catch(() => {});

  broadcast(location.id, {
    type: "floor.updated",
    entity: "dining_table",
    entityId: rows[0].id,
  });

  return NextResponse.json({ ok: true, id: rows[0].id });
});
