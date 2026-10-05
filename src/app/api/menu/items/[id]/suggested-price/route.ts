import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermissions } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getSuggestedPrice } from "@/lib/pricing-service";
import { changeMenuItemPrice } from "@/lib/menu-price-service";

/**
 * The cost-plus suggestion — and its audited apply.
 *
 * The payload is financial: recipe/material cost, loaded cost, the target
 * margin and ledger-derived overhead. `menu.view` alone reaches cashiers,
 * waiters and the kitchen, none of whom may read the cost structure or the
 * ledger — so both directions now require `menu.edit` AND `ledger.view`
 * (issue #844: the old gate was only `menu.view`).
 *
 * POST computes the suggestion **server-side** and applies it through the
 * canonical price-change service with `source = 'suggested'`. The client
 * never sends the price it wants written: it asks, and the server decides
 * what the suggested price is — which is what makes the recorded source
 * trustworthy rather than a label the browser chose.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermissions(PERMISSIONS.menuEdit, PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query("SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $2", [id, location.id]);
  if (rows.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const breakdown = await getSuggestedPrice(session.businessId, id);
  if (!breakdown) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  return NextResponse.json({ suggestion: breakdown });
});

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermissions(PERMISSIONS.menuEdit, PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query("SELECT 1 FROM menu_items WHERE id = $1 AND location_id = $2", [id, location.id]);
  if (rows.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const breakdown = await getSuggestedPrice(session.businessId, id);
  if (!breakdown) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  if (typeof breakdown.suggestedPrice !== "number" || breakdown.suggestedPrice < 0) {
    return NextResponse.json({ error: "no_suggestion" }, { status: 409 });
  }

  const result = await changeMenuItemPrice({
    businessId: session.businessId,
    locationId: location.id,
    menuItemId: id,
    newPrice: breakdown.suggestedPrice,
    source: "suggested",
    changedBy: session.sub,
    sourceRef: `margin:${breakdown.marginPercent ?? "none"}`,
    reason: "اعمال قیمت پیشنهادی",
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    changed: result.changed,
    oldPrice: result.oldPrice ?? null,
    newPrice: result.newPrice ?? breakdown.suggestedPrice,
  });
});
