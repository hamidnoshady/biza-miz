import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { deleteMenuItem, updateMenuItem } from "@/lib/menu-service";
import { isUuid, validateMenuItemPatch } from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";
import type { PriceChangeSource } from "@/lib/menu-price-service";

/**
 * Whether this id is an item of the branch at all.
 *
 * A path id reaches a uuid column, so it is checked for uuid shape
 * *before* the query: «not a uuid» means there is no such item in this
 * branch and must never become an invalid-input database error (issue #911).
 */
async function ownedItem(locationId: string, id: string): Promise<boolean | "bad_id"> {
  if (!isUuid(id)) return "bad_id";
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] != null;
}

/** The response for an `ownedItem` answer that is not «yes»: a malformed id, or another branch's item. */
function ownershipError(owned: "bad_id" | false) {
  return owned === "bad_id"
    ? NextResponse.json({ error: "bad_request" }, { status: 400 })
    : NextResponse.json({ error: "item_not_found" }, { status: 404 });
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
  const ownership = await ownedItem(location.id, id);
  if (ownership !== true) return ownershipError(ownership);

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

/**
 * Delete an item — or deactivate it, when an order or its price history must
 * keep pointing at it.
 *
 * The rule, the audit row and the transaction are the service's; this handler
 * only resolves the branch, rejects an id that cannot be one, and reports
 * which of the two outcomes happened.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  // The rule lives in the service now (delete, or deactivate when an order
  // line or a price-history row must keep pointing at the item), together
  // with the audit row that records which of the two happened.
  const result = await deleteMenuItem(location.id, id, session.businessId, {
    changedBy: session.sub,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, deactivated: result.deactivated === true });
});
