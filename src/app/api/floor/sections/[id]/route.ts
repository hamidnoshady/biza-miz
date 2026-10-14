import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { validWaiterId } from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownSection(locationId: string, id: string) {
  const { rows } = await query("SELECT id FROM floor_sections WHERE id = $1 AND location_id = $2", [id, locationId]);
  return rows.length > 0;
}

/** Rename / recolor / (re)assign waiter / reorder a section. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownSection(location.id, id))) return NextResponse.json({ error: "section_not_found" }, { status: 404 });

  let body: { name?: string; color?: string | null; assignedWaiterId?: string | null; sortOrder?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const { rows: dup } = await query(
      "SELECT id FROM floor_sections WHERE location_id = $1 AND name = $2 AND id <> $3",
      [location.id, name, id],
    );
    if (dup.length > 0) return NextResponse.json({ error: "section_exists" }, { status: 409 });
    set("name", name);
  }
  if (body.color !== undefined) set("color", body.color?.trim() || null);
  if (body.assignedWaiterId !== undefined) {
    const waiterId = await validWaiterId(location.id, body.assignedWaiterId);
    if (waiterId === false) return NextResponse.json({ error: "waiter_not_found" }, { status: 400 });
    set("assigned_waiter_id", waiterId);
  }
  if (body.sortOrder !== undefined && Number.isFinite(body.sortOrder)) set("sort_order", Number(body.sortOrder));

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await query(`UPDATE floor_sections SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
});

/** Delete a section. Tables in it are detached (section_id → NULL), not deleted. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownSection(location.id, id))) return NextResponse.json({ error: "section_not_found" }, { status: 404 });

  await query("DELETE FROM floor_sections WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
});
