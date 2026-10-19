import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validateMenuItemCreate } from "@/lib/menu-validation";
import { createMenuItem } from "@/lib/menu-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Create a menu item.
 *
 * The same runtime schema the PATCH path uses (menu-validation.ts), so what a
 * create accepts is exactly what an edit accepts — name length, price shape,
 * SKU rules, image references. Creation carries everything a normal item
 * needs (description, SKU, canonical image) so an owner never has to save,
 * reopen and re-edit just to attach a photo.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateMenuItemCreate(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  // The actor is carried into the service so the item's first lifecycle audit
  // row names who created it.
  const result = await createMenuItem(location.id, session.businessId, input.value, {
    changedBy: session.sub,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id });
});
