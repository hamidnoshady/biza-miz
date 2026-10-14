import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { changeMenuItemPrice } from "@/lib/menu-price-service";
import { parsePrice } from "@/lib/menu-validation";

/**
 * The dedicated, audited price-change action — issue #844.
 *
 * Selling price is a domain operation, not an ordinary patch field: this
 * endpoint is the only way the menu workspace changes an existing item's
 * price, and it always goes through `changeMenuItemPrice` (lock → validate →
 * update current → append immutable history → audit → commit, one
 * transaction). `old == new` is a no-op with no history row.
 *
 * The request body may carry `reason`/`note` for the operator's own record —
 * it may NOT carry a source. `source` is decided here as `manual` because the
 * only callers of this route are people in the price-change dialog; every
 * other writer (import, AI, integration, sync) calls the service from its own
 * path with its own server-side source.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
    if (error) return error;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const { rows } = await query("SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $2", [
      id,
      location.id,
    ]);
    if (rows.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const raw = body as { price?: unknown; reason?: unknown; note?: unknown };
    const price = parsePrice(raw.price);
    if (!price.ok) return NextResponse.json({ error: price.error }, { status: 400 });
    const reason =
      typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim().slice(0, 300) : null;
    const note =
      typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 500) : null;

    const result = await changeMenuItemPrice({
      businessId: session.businessId,
      locationId: location.id,
      menuItemId: id,
      newPrice: price.value,
      source: "manual",
      changedBy: session.sub,
      sourceRef: null,
      reason,
      note,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      ok: true,
      changed: result.changed,
      oldPrice: result.oldPrice ?? null,
      newPrice: result.newPrice ?? price.value,
    });
  },
);
