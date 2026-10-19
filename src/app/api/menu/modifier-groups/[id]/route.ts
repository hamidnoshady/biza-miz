import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { deleteModifierGroup, updateModifierGroup } from "@/lib/menu-service";
import { validateModifierGroupPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedGroup(locationId: string, id: string) {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] != null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedGroup(location.id, id)))
    return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateModifierGroupPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updateModifierGroup(location.id, id, input.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/**
 * Delete a modifier group.
 *
 * A group with any option, item attachment, recipe dependency or sold
 * reference is *disabled* instead of deleted: a destructive DELETE cascades
 * its options and every item attachment, and that configuration loss is not
 * something a menu screen may do silently. Only a truly empty, unreferenced
 * group is removed. Disabling (PATCH `{ isActive: false }`) is always the
 * reversible way to take a group off the menu; order history keeps its own
 * snapshots either way.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedGroup(location.id, id)))
    return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  const result = await deleteModifierGroup(location.id, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    deactivated: result.deactivated ?? false,
    affected: result.affected ?? { items: 0, options: 0 },
  });
});
