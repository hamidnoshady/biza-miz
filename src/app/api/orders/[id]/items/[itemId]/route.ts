import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateOrderItem } from "@/lib/order-mutations";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { isUuid } from "@/lib/customer-return-domain";

const MAX_NOTE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Change an item's quantity, re-pick its add-ons, edit its note, or void it —
 * only while the order is still 'open'.
 *
 * The transaction itself lives in order-mutations.ts (`updateOrderItem`),
 * next to the intake path whose rules it has to match; this handler is the
 * guard, the body shape, and the realtime broadcast.
 */
export const PATCH = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string; itemId: string }> },
  ) => {
    const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
    if (error) return error;
    const { id, itemId } = await context.params;
    if (!isUuid(id) || !isUuid(itemId)) {
      return NextResponse.json({ error: "invalid_order_item_id" }, { status: 400 });
    }

    const location = await resolveActiveLocation(session);
    if (!location)
      return NextResponse.json({ error: "no_location" }, { status: 409 });

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!isRecord(rawBody) || Object.keys(rawBody).length === 0) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const allowedKeys = new Set(["quantity", "note", "modifierIds", "modifiers", "void"]);
    if (Object.keys(rawBody).some((key) => !allowedKeys.has(key))) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (rawBody.void !== undefined && Object.keys(rawBody).some((key) => key !== "void")) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const quantity = rawBody.quantity;
    if (quantity !== undefined && (typeof quantity !== "number" || !Number.isSafeInteger(quantity))) {
      return NextResponse.json({ error: "invalid_item" }, { status: 400 });
    }
    const note = rawBody.note;
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > MAX_NOTE)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const modifierIds = rawBody.modifierIds;
    if (modifierIds !== undefined && (!Array.isArray(modifierIds) || modifierIds.some((value) => !isUuid(value)))) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    let modifiers: { id: string; quantity?: number }[] | undefined;
    if (rawBody.modifiers !== undefined) {
      if (!Array.isArray(rawBody.modifiers)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      modifiers = [];
      for (const pick of rawBody.modifiers) {
        if (!isRecord(pick) || Object.keys(pick).some((key) => key !== "id" && key !== "quantity") || !isUuid(pick.id)) {
          return NextResponse.json({ error: "bad_request" }, { status: 400 });
        }
        const pickedQuantity = pick.quantity;
        if (pickedQuantity !== undefined && (typeof pickedQuantity !== "number" || !Number.isSafeInteger(pickedQuantity) || pickedQuantity < 1)) {
          return NextResponse.json({ error: "invalid_modifier_quantity" }, { status: 400 });
        }
        modifiers.push({ id: pick.id, quantity: pickedQuantity as number | undefined });
      }
    }

    let voidInput: { reason?: string } | undefined;
    if (rawBody.void !== undefined) {
      if (!isRecord(rawBody.void) || Object.keys(rawBody.void).some((key) => key !== "reason") ||
          (rawBody.void.reason !== undefined && typeof rawBody.void.reason !== "string")) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      voidInput = { reason: rawBody.void.reason as string | undefined };
    }

    const result = await updateOrderItem({
      locationId: location.id,
      orderId: id,
      orderItemId: itemId,
      quantity,
      note: note as string | null | undefined,
      modifiers,
      modifierIds: modifierIds as string[] | undefined,
      void: voidInput,
      actor: { userId: session.sub, role: session.role, businessId: session.businessId },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    broadcast(
      location.id,
      result.data.voided
        ? { type: "order.item_status", orderId: id, itemId, status: "voided" }
        : { type: "order.updated", orderId: id },
    );
    return NextResponse.json({ ok: true, totals: result.data.totals });
  },
);
