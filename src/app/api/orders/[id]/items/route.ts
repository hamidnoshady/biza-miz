import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import type { CartItemInput } from "@/lib/order-cart";
import { addItemsToOrder } from "@/lib/order-mutations";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

/** Add one or more items to an already-submitted order, while it's still 'open'. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { items?: CartItemInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await addItemsToOrder({
    locationId: location.id,
    orderId: id,
    items: body.items ?? [],
    actor: { userId: session.sub, role: session.role },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  broadcast(location.id, { type: "order.updated", orderId: id });
  return NextResponse.json({ ok: true, ...result.data });
});
