import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import type { CartItemInput } from "@/lib/order-cart";
import { addItemsToOrder } from "@/lib/order-mutations";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { isUuid } from "@/lib/customer-return-domain";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseItems(raw: unknown): { ok: true; items: CartItemInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) return { ok: false, error: "no_items" };
  const items: CartItemInput[] = [];
  for (const value of raw) {
    if (!isRecord(value) || Object.keys(value).some((key) => !["menuItemId", "quantity", "note", "modifiers", "modifierIds"].includes(key))) {
      return { ok: false, error: "invalid_item" };
    }
    if (!isUuid(value.menuItemId) || typeof value.quantity !== "number" || !Number.isSafeInteger(value.quantity)) {
      return { ok: false, error: "invalid_item" };
    }
    if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 200)) return { ok: false, error: "invalid_item" };
    if (value.modifierIds !== undefined &&
        (!Array.isArray(value.modifierIds) || value.modifierIds.some((id) => !isUuid(id)))) {
      return { ok: false, error: "invalid_modifier" };
    }
    let modifiers: CartItemInput["modifiers"];
    if (value.modifiers !== undefined) {
      if (!Array.isArray(value.modifiers)) return { ok: false, error: "invalid_modifier" };
      modifiers = [];
      for (const modifier of value.modifiers) {
        if (typeof modifier === "string" && isUuid(modifier)) {
          modifiers.push(modifier);
          continue;
        }
        if (!isRecord(modifier) || Object.keys(modifier).some((key) => key !== "id" && key !== "quantity") || !isUuid(modifier.id) ||
            modifier.quantity !== undefined &&
              (typeof modifier.quantity !== "number" || !Number.isSafeInteger(modifier.quantity) || modifier.quantity < 1)) {
          return { ok: false, error: "invalid_modifier" };
        }
        modifiers.push({ id: modifier.id, quantity: modifier.quantity as number | undefined });
      }
    }
    items.push({
      menuItemId: value.menuItemId,
      quantity: value.quantity,
      note: value.note as string | undefined,
      modifiers,
      modifierIds: value.modifierIds as string[] | undefined,
    });
  }
  return { ok: true, items };
}

/** Add one or more items to an already-submitted order, while it's still 'open'. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRecord(rawBody) || Object.keys(rawBody).some((key) => key !== "items")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseItems(rawBody.items);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const items = parsed.items;
  const result = await addItemsToOrder({
    locationId: location.id,
    orderId: id,
    items,
    actor: { userId: session.sub, role: session.role, businessId: session.businessId },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  broadcast(location.id, { type: "order.updated", orderId: id });
  return NextResponse.json({ ok: true, ...result.data });
});
