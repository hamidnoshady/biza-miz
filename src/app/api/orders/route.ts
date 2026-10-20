import { memberAccessFor } from "@/lib/member-access";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { type CartItemInput } from "@/lib/order-cart";
import { createOrder } from "@/lib/order-mutations";
import { listOrders, listSettledOrdersInWindow } from "@/lib/order-read-service";
import { branchClosedOrdersWindow, type ClosedOrdersWindow } from "@/lib/shift-service";
import { listRecentShiftOptions } from "@/lib/shift-orders-service";
import type { DiscountInput } from "@/lib/orders";
import { checkTableSectionAuthorization } from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";

/**
 * Open orders for the cashier's "current orders" list.
 *
 * `?scope=shift` additionally returns the orders already settled in the
 * branch's current window (`closedOrders`, newest close first) plus the window
 * itself, for the orders screen — a closed order is otherwise invisible the
 * moment it is paid. Only that screen asks for it, so the POS and waiter
 * panels, which poll this route for their queue, keep paying for one query.
 *
 * Which orders those are is decided by when each was *opened*, not when it was
 * paid (see `listSettledOrdersInWindow`): a bill this shift opened stays in this
 * list however late it is settled, and a bill carried over from an earlier shift
 * or an already-closed day is left with the shift that opened it rather than
 * counted here a second time. The still-open queue above is unbounded either
 * way, so a carried-over table is always settleable — it simply files itself
 * back under its own shift once it is.
 *
 * The default window is today's business day at the branch, widened to a
 * still-running shift that began earlier (see branchClosedOrdersWindow);
 * `shiftStartedAt` is reported alongside so the screen can name which of the
 * two it is showing. A branch that has configured a business day (روز کاری)
 * gets that day's window instead, reported as `businessDay` so the screen can
 * say which trading day — and whether management has already closed it —
 * rather than calling it "today".
 *
 * An owner or manager may instead ask for one shift by id (`&shiftId=`), and
 * gets the branch's recent shifts back as that picker's options — reviewing a
 * shift someone else worked is a supervisory privilege, the same audience
 * /api/reports/shift-orders serves, so a cashier or waiter is answered with the
 * default window and no shift list. The id is resolved *within* the branch's
 * own list rather than by its own query, so an unknown or foreign id falls back
 * to the default window instead of reaching another branch's shift.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.ordersView);
  if (guard.error) return guard.error;
  const { session } = guard;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ orders: [], heldOrders: [], timeZone: "Asia/Tehran" });

  const [orders, heldOrders] = await Promise.all([
    listOrders(location.id, { status: "open" }),
    listOrders(location.id, { status: "held" }),
  ]);
  if (new URL(request.url).searchParams.get("scope") !== "shift") {
    return NextResponse.json({ orders, heldOrders, timeZone: location.timezone });
  }

  // The shift-review audience of /api/reports/shift-orders. `reports.view` is
  // what reviewing a past shift's takings actually is, and it is held by
  // exactly the roles that could reach this before plus the accountant — who
  // has no orders screen to render the picker on, so the list is built and
  // never displayed rather than being a new capability.
  const reviewer = await memberAccessFor(session);
  const canReviewShifts = reviewer?.permissions.has(PERMISSIONS.reportsView) ?? false;
  const shifts = canReviewShifts ? await listRecentShiftOptions(location.id) : [];
  const requestedShiftId = new URL(request.url).searchParams.get("shiftId");
  const selectedShift = requestedShiftId
    ? (shifts.find((shift) => shift.id === requestedShiftId) ?? null)
    : null;

  const window: ClosedOrdersWindow = selectedShift
    ? { since: selectedShift.startedAt, shiftStartedAt: selectedShift.startedAt, businessDay: null }
    : await branchClosedOrdersWindow(location.id);
  const closedOrders = await listSettledOrdersInWindow(location.id, window.since, {
    until: selectedShift?.endedAt ?? null,
  });

  return NextResponse.json({
    orders,
    heldOrders,
    closedOrders,
    closedSince: window.since,
    shiftStartedAt: window.shiftStartedAt,
    // Null unless the branch has a business day configured — the screen then
    // labels its window by that day instead of by "today"/the open shift.
    businessDay: window.businessDay,
    shifts,
    selectedShift,
    timeZone: location.timezone,
  });
});

interface CreateOrderBody {
  type?: "dine_in" | "takeaway" | "delivery";
  tableId?: string;
  customerId?: string;
  guestCount?: number;
  note?: string;
  discount?: { type?: "percent" | "amount"; value?: number };
  items?: CartItemInput[];
  delivery?: { address?: string; phone?: string; fee?: number; courierId?: string; note?: string };
  /**
   * Optional client-minted id for this submission attempt (see
   * order-mutations.ts's createOrder). Absent from an older/cached frontend
   * bundle, which is why it stays optional here rather than required.
   */
  clientRequestId?: string;
}

/** Builds the cart, computes totals, and creates Orders + OrderItems (+ modifiers) atomically. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;

  let body: CreateOrderBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.type !== "dine_in" && body.type !== "takeaway" && body.type !== "delivery") {
    return NextResponse.json({ error: "invalid_order_type" }, { status: 400 });
  }
  const items = body.items ?? [];

  const discountType = body.discount?.type === "percent" || body.discount?.type === "amount" ? body.discount.type : null;
  const discountValue = Number(body.discount?.value ?? 0);
  if (discountType && (!Number.isFinite(discountValue) || discountValue < 0 || (discountType === "percent" && discountValue > 100))) {
    return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
  }
  const discount: DiscountInput = discountType ? { type: discountType, value: discountValue } : { type: null };

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  if (body.type === "dine_in" && body.tableId) {
    const sectionAuth = await checkTableSectionAuthorization(session, location.id, [
      String(body.tableId),
    ]);
    if (!sectionAuth.allowed) {
      return NextResponse.json({ error: "section_not_assigned" }, { status: 403 });
    }
  }

  if (body.guestCount !== undefined && (!Number.isInteger(body.guestCount) || body.guestCount < 0)) {
    return NextResponse.json({ error: "invalid_guest_count" }, { status: 400 });
  }
  const guestCount = Number.isFinite(body.guestCount) ? Number(body.guestCount) : null;
  const result = await createOrder({
    locationId: location.id,
    type: body.type,
    tableId: body.tableId ?? null,
    customerId: body.customerId ?? null,
    guestCount,
    note: body.note ?? null,
    discount,
    items,
    openedBy: session.sub,
    actorRole: session.role,
    clientRequestId: body.clientRequestId ?? null,
    delivery: body.type === "delivery" && body.delivery
      ? {
          address: body.delivery.address ?? "",
          phone: body.delivery.phone ?? null,
          fee: body.delivery.fee ?? 0,
          courierId: body.delivery.courierId ?? null,
          note: body.delivery.note ?? null,
        }
      : null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  broadcast(location.id, { type: "order.created", orderId: result.data.id });
  return NextResponse.json({ ok: true, ...result.data });
});
