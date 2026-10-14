import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { validWaiterId } from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Create a floor section (a zone on the map, optionally owned by a waiter). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;

  let body: { name?: string; color?: string | null; assignedWaiterId?: string | null };
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

  const waiterId = await validWaiterId(location.id, body.assignedWaiterId);
  if (waiterId === false) return NextResponse.json({ error: "waiter_not_found" }, { status: 400 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO floor_sections (location_id, name, color, assigned_waiter_id, sort_order)
     SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order) + 1, 0)
       FROM floor_sections WHERE location_id = $1
     RETURNING id`,
    [location.id, name, body.color?.trim() || null, waiterId],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
});
