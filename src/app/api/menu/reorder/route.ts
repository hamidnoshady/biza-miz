import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { reorderMenuCollection, isMenuReorderEntity } from "@/lib/menu-service";

/**
 * Persist a whole ordering in one request and one statement — issue #844.
 *
 * Body: `{ entity, ids }` where `ids` are the rows in their new display order.
 * The menu editor's old two-PATCH swap could fail halfway and leave two rows
 * on the same sort slot; this endpoint reassigns every position at once, so a
 * failure means the ordering did not change — never that it half-changed.
 *
 * `entity` is one of categories / items / modifierGroups / modifiers; every id
 * is verified to belong to the active branch before anything is written.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const raw = body as { entity?: unknown; ids?: unknown };
  if (!isMenuReorderEntity(raw.entity)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    !Array.isArray(raw.ids) ||
    raw.ids.length > 5000 ||
    raw.ids.some((id) => typeof id !== "string" || id.length > 64)
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await reorderMenuCollection(location.id, raw.entity, raw.ids as string[]);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});
