import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { updateCategory } from "@/lib/menu-service";
import { isUuid, validateCategoryPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Whether this id is a category of the branch at all.
 *
 * The id reaches a uuid column, so its shape is checked *before* the query:
 * «not a uuid» means there is no such category in this branch and must never
 * become an invalid-input database error (issue #911).
 */
async function ownedCategory(locationId: string, id: string): Promise<boolean | "bad_id"> {
  if (!isUuid(id)) return "bad_id";
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] != null;
}

/** The response for an `ownedCategory` answer that is not «yes». */
function ownershipError(owned: "bad_id" | false) {
  return owned === "bad_id"
    ? NextResponse.json({ error: "bad_request" }, { status: 400 })
    : NextResponse.json({ error: "category_not_found" }, { status: 404 });
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const ownership = await ownedCategory(location.id, id);
  if (ownership !== true) return ownershipError(ownership);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateCategoryPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updateCategory(location.id, id, input.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/**
 * Categories with items are deactivated, not deleted, so historical orders keep their references.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const ownership = await ownedCategory(location.id, id);
  if (ownership !== true) return ownershipError(ownership);

  const { rows: items } = await query("SELECT id FROM menu_items WHERE category_id = $1 LIMIT 1", [id]);
  if (items.length > 0) {
    await query("UPDATE menu_categories SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM menu_categories WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
