import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import * as floor from "@/lib/floor";
import { broadcast } from "@/lib/realtime";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownSection(locationId: string, id: string) {
  const { rows } = await query<{
    id: string;
    name?: string;
    color?: string | null;
    assigned_waiter_id?: string | null;
    sort_order?: number;
  }>("SELECT id, name, color, assigned_waiter_id, sort_order FROM floor_sections WHERE id = $1 AND location_id = $2", [
    id,
    locationId,
  ]);
  return rows[0] ?? null;
}

/** Rename / recolor / (re)assign waiter / reorder a section. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const existing = await ownSection(location.id, id);
  if (!existing) return NextResponse.json({ error: "section_not_found" }, { status: 404 });

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
    const waiterId = await floor.validWaiterId(session.businessId, location.id, body.assignedWaiterId);
    if (waiterId === false) return NextResponse.json({ error: "waiter_not_found" }, { status: 400 });
    set("assigned_waiter_id", waiterId);
  }
  if (body.sortOrder !== undefined) {
    const so = Number(body.sortOrder);
    if (!Number.isFinite(so) || so < -10000 || so > 100000) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    set("sort_order", Math.round(so));
  }

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await query(`UPDATE floor_sections SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);

  await floor.recordFloorAudit?.({
    businessId: session.businessId,
    locationId: location.id,
    userId: session.sub,
    action: "floor_section.updated",
    entity: "floor_section",
    entityId: id,
    payload: { before: existing, changes: body },
  }).catch(() => {});

  broadcast(location.id, {
    type: "floor.updated",
    entity: "floor_section",
    entityId: id,
  });

  return NextResponse.json({ ok: true });
});

/**
 * Delete a section.
 *
 * Issue #916 (Finding 27): Deleting a section that still holds active tables
 * cannot silently drop their section/waiter assignment unless the caller
 * either passes `reassignToSectionId` (which moves the tables to that section
 * first) or explicitly confirms `allowUnassign: true`.
 */
export const DELETE = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const existing = await ownSection(location.id, id);
  if (!existing) return NextResponse.json({ error: "section_not_found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const rawReassign =
    body.reassignToSectionId ?? url.searchParams.get("reassignToSectionId") ?? undefined;
  const allowUnassign =
    body.allowUnassign === true || url.searchParams.get("allowUnassign") === "true";

  if (rawReassign !== undefined && rawReassign !== null && rawReassign !== "") {
    const targetId = String(rawReassign).trim();
    if (targetId === id || !(await ownSection(location.id, targetId))) {
      return NextResponse.json({ error: "section_not_found" }, { status: 404 });
    }
    await query(
      `UPDATE dining_tables SET section_id = $1 WHERE section_id = $2 AND location_id = $3`,
      [targetId, id, location.id],
    );
  } else if (!allowUnassign) {
    const tableCheck = await query<{ count?: number }>(
      `SELECT COUNT(*)::int AS count FROM dining_tables WHERE section_id = $1 AND location_id = $2 AND is_active`,
      [id, location.id],
    );
    const activeTableCount = Number(tableCheck?.rows?.[0]?.count ?? 0);
    if (activeTableCount > 0) {
      return NextResponse.json(
        { error: "section_has_tables", tableCount: activeTableCount },
        { status: 409 },
      );
    }
  }

  await query("DELETE FROM floor_sections WHERE id = $1", [id]);

  await floor.recordFloorAudit?.({
    businessId: session.businessId,
    locationId: location.id,
    userId: session.sub,
    action: "floor_section.deleted",
    entity: "floor_section",
    entityId: id,
    payload: {
      before: existing,
      reassignedToSectionId: rawReassign ?? null,
      allowUnassign,
    },
  }).catch(() => {});

  broadcast(location.id, {
    type: "floor.updated",
    entity: "floor_section",
    entityId: id,
  });

  return NextResponse.json({ ok: true });
});
