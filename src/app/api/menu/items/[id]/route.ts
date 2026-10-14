import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { updateMenuItem } from "@/lib/menu-service";
import { validateMenuItemPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";
import type { PriceChangeSource } from "@/lib/menu-price-service";

async function ownedItem(locationId: string, id: string) {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] != null;
}

/**
 * Whether this patch arrived through the AI proposal-apply proxy.
 *
 * The proxy forwards `X-AI-Proposal-Audit` (the server-owned audit row it has
 * already claimed). A hand-rolled fetch can *send* that header, so the value
 * is additionally checked against this business's own audit rows — a forged
 * uuid does not exist, and another tenant's does not match `business_id`.
 * That makes the recorded source a server fact, not a client claim
 * (issue #844: source is not user-forgeable).
 */
async function aiProposalSource(
  businessId: string,
  headerValue: string | null,
): Promise<{ source: PriceChangeSource; sourceRef: string | null }> {
  if (!headerValue || headerValue.length > 100) return { source: "manual", sourceRef: null };
  // Guard the cast: a non-uuid header value would make `::uuid` throw.
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      headerValue,
    )
  ) {
    return { source: "manual", sourceRef: null };
  }
  const { rows } = await query(
    `SELECT 1 FROM ai_action_audit
      WHERE id = $1::uuid AND business_id = $2 AND action_type = 'menu.item.priceUpdate'`,
    [headerValue, businessId],
  );
  return rows[0]
    ? { source: "ai", sourceRef: headerValue }
    : { source: "manual", sourceRef: null };
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedItem(location.id, id)))
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateMenuItemPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  // A price inside this patch is routed by the service through the canonical
  // price-change operation; name it by how it arrived (AI vs the manual form).
  const origin = await aiProposalSource(
    session.businessId,
    request.headers.get("x-ai-proposal-audit"),
  );

  const result = await updateMenuItem(location.id, id, input.value, session.businessId, {
    changedBy: session.sub,
    ...origin,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/** Items referenced by an order are deactivated, not deleted, to keep order history intact. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownedItem(location.id, id)))
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const { rows: refs } = await query("SELECT id FROM order_items WHERE menu_item_id = $1 LIMIT 1", [id]);
  if (refs.length > 0) {
    await query("UPDATE menu_items SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  // Price history is append-only and must outlive the catalogue row (issue
  // #844): once a price has ever changed, «حذف» becomes deactivation instead —
  // otherwise the audit trail of the item would vanish with it. The history
  // rows for a business teardown still cascade away; the DB trigger tells the
  // two cases apart.
  const { rows: history } = await query(
    "SELECT id FROM menu_item_price_history WHERE menu_item_id = $1 LIMIT 1",
    [id],
  );
  if (history.length > 0) {
    await query("UPDATE menu_items SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM menu_items WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
