import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveSectionId } from "@/lib/floor";
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
    `SELECT id, name, zone, section_id, capacity, status, sort_order,
            pos_x, pos_y, width, height, shape
       FROM dining_tables
      WHERE location_id = $1 AND is_active ORDER BY sort_order, name`,
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
    posX?: number;
    posY?: number;
    width?: number;
    height?: number;
    shape?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  const capacity = Number.isFinite(body.capacity) ? Number(body.capacity) : 2;
  if (!name || capacity <= 0) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const shape = body.shape === "circle" ? "circle" : "rect";

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: dup } = await query("SELECT id FROM dining_tables WHERE location_id = $1 AND name = $2", [
    location.id,
    name,
  ]);
  if (dup.length > 0) return NextResponse.json({ error: "table_exists" }, { status: 409 });

  const sectionId = await resolveSectionId(location.id, body.sectionId);
  if (sectionId === false) return NextResponse.json({ error: "section_not_found" }, { status: 400 });

  const clampPos = (v: unknown, def: number) => (Number.isFinite(v) ? Math.max(0, Math.round(Number(v))) : def);
  const clampSize = (v: unknown, def: number) =>
    Number.isFinite(v) ? Math.min(400, Math.max(30, Math.round(Number(v)))) : def;

  const { rows } = await query<{ id: string }>(
    `INSERT INTO dining_tables (location_id, name, zone, section_id, capacity, sort_order,
            pos_x, pos_y, width, height, shape)
     SELECT $1, $2, $3, $4, $5, COALESCE(MAX(sort_order) + 1, 0), $6, $7, $8, $9, $10
       FROM dining_tables WHERE location_id = $1
     RETURNING id`,
    [
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
    ],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
});
