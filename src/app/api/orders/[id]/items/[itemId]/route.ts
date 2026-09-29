import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateOrderItem } from "@/lib/order-mutations";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

const MAX_NOTE = 200;

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

    const location = await resolveActiveLocation(session);
    if (!location)
      return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: {
      quantity?: number;
      note?: string | null;
      /** The pre-quantity shape — still accepted; see `modifiers`. */
      modifierIds?: string[];
      /** The line's add-ons after the edit, each with its own repeat count. */
      modifiers?: { id?: unknown; quantity?: unknown }[];
      void?: { reason?: string };
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (
      body.modifierIds !== undefined &&
      (!Array.isArray(body.modifierIds) ||
        body.modifierIds.some((value) => typeof value !== "string"))
    ) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    let modifiers: { id: string; quantity?: number }[] | undefined;
    if (body.modifiers !== undefined) {
      if (!Array.isArray(body.modifiers)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      modifiers = [];
      for (const pick of body.modifiers) {
        if (pick === null || typeof pick !== "object" || typeof pick.id !== "string") {
          return NextResponse.json({ error: "bad_request" }, { status: 400 });
        }
        const quantity = pick.quantity === undefined ? undefined : Number(pick.quantity);
        if (
          quantity !== undefined &&
          (!Number.isSafeInteger(quantity) || quantity < 1)
        ) {
          return NextResponse.json({ error: "invalid_modifier_quantity" }, { status: 400 });
        }
        modifiers.push({ id: pick.id, quantity });
      }
    }
    if (
      body.note !== undefined &&
      body.note !== null &&
      (typeof body.note !== "string" || body.note.length > MAX_NOTE)
    ) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const result = await updateOrderItem({
      locationId: location.id,
      orderId: id,
      orderItemId: itemId,
      quantity: body.quantity,
      note: body.note,
      modifiers,
      modifierIds: body.modifierIds,
      void: body.void,
      actor: { userId: session.sub, role: session.role },
    });
    if (!result.ok)
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );

    broadcast(
      location.id,
      result.data.voided
        ? { type: "order.item_status", orderId: id, itemId, status: "voided" }
        : { type: "order.updated", orderId: id },
    );
    return NextResponse.json({ ok: true, totals: result.data.totals });
  },
);
