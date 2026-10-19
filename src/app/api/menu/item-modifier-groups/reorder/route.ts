import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/menu-validation";
import { reorderItemModifierGroups } from "@/lib/menu-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Reorder ONE menu item's attached add-on groups — atomically.
 *
 * Body: `{ menuItemId, groupIds }` with every group currently linked to the
 * item, in the new display order. The item editor's old arrow buttons sent
 * two PATCHes that exchanged their sort orders; a failure after the first
 * left both links on the same slot. This route reassigns every position in a
 * single UPDATE inside one transaction, so the item-specific order the POS
 * and waiter screens render is either fully stored or not changed at all.
 *
 * `groupIds` must be exactly the item's current links: a partial list is a
 * `reorder_mismatch`, not a silent renumbering of the links it omitted.
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

  const raw = body as { menuItemId?: unknown; groupIds?: unknown };
  if (!isUuid(raw.menuItemId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    !Array.isArray(raw.groupIds) ||
    raw.groupIds.length > 500 ||
    raw.groupIds.some((id) => !isUuid(id))
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await reorderItemModifierGroups(
    location.id,
    raw.menuItemId,
    raw.groupIds as string[],
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});
