// @vitest-environment node
/**
 * Issue #913 item 3 — the HTTP boundary for the three financial order acts,
 * asserted as a role × override matrix at the routes themselves: a direct
 * POST/PATCH must not bypass what the screens hide.
 *
 *   * creating a sale            → orders.create        (unchanged)
 *   * initial/edit discount      → orders.discount      (was: any creator)
 *   * voiding a whole open bill  → orders.void          (was: any creator)
 *   * voiding one sent line      → orders.void_item     (new explicit key)
 *
 * The permission layer behind these routes is exercised exhaustively in
 * permission-matrix.test.ts (role presets + granted/revoked overrides); here
 * each request proves the ROUTE consults it before touching the domain, and
 * that the domain is reached the moment the key is held (or the edit is an
 * ordinary one — quantity/note changes must not need any of the new keys).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => unknown) => handler,
  };
});

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));

vi.mock("@/lib/realtime", () => ({
  broadcast: vi.fn(),
}));

vi.mock("@/lib/member-access", () => ({
  memberAccessFor: vi.fn(),
}));

vi.mock("@/lib/order-read-service", () => ({
  getOrderDetail: vi.fn(),
  listOrders: vi.fn(),
  listSettledOrdersInWindow: vi.fn(),
}));

vi.mock("@/lib/shift-service", () => ({
  branchClosedOrdersWindow: vi.fn(),
}));

vi.mock("@/lib/shift-orders-service", () => ({
  listRecentShiftOptions: vi.fn(),
}));

vi.mock("@/lib/order-mutations", () => ({
  createOrder: vi.fn(),
  updateOrderItem: vi.fn(),
  addItemsToOrder: vi.fn(),
}));

vi.mock("@/lib/order-totals", () => ({
  recomputeOrderTotals: vi.fn(),
}));

vi.mock("@/lib/order-discount-service", () => ({
  normalizeDiscountInput: vi.fn(),
}));

vi.mock("@/lib/order-lock", () => ({
  lockOpenOrder: vi.fn(),
}));

vi.mock("@/lib/table-session-service", () => ({
  ensureSessionForTable: vi.fn(),
  releaseSessionIfIdle: vi.fn(),
  releaseTableAfterOrderSettled: vi.fn(),
}));

vi.mock("@/lib/order-state-sync", () => ({
  recordOrderState: vi.fn(),
}));

vi.mock("@/lib/notification-events", () => ({
  recordNotification: vi.fn(),
}));

vi.mock("@/lib/notifications", () => ({
  notificationDedupeKey: vi.fn((...parts: string[]) => parts.join(":")),
}));

import * as setupState from "@/lib/setup-state";
import * as orderMutations from "@/lib/order-mutations";
import * as orderLock from "@/lib/order-lock";
import * as orderTotals from "@/lib/order-totals";
import * as orderDiscount from "@/lib/order-discount-service";
import * as db from "@/lib/db";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "cashier" };

/** Which keys the acting member holds for the next assertion. */
let allowed: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  allowed = new Set<string>();
  vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
    if (allowed.has(permission)) return { session: SESSION, error: null } as never;
    const { NextResponse } = await import("next/server");
    return {
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never;
  }) as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  const fakeClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  vi.mocked(db.getPool).mockReturnValue({ connect: async () => fakeClient } as never);
  // A permitted request that reaches the domain lands here; 404 proves the
  // guards passed without needing a database.
  vi.mocked(orderMutations.createOrder).mockResolvedValue({
    ok: false,
    error: "table_not_found",
    status: 404,
  } as never);
  vi.mocked(orderLock.lockOpenOrder).mockResolvedValue({
    ok: false,
    error: "order_not_open",
    status: 409,
  } as never);
  vi.mocked(orderMutations.updateOrderItem).mockResolvedValue({
    ok: false,
    error: "item_not_found",
    status: 404,
  } as never);
  vi.mocked(orderDiscount.normalizeDiscountInput).mockReturnValue({
    type: "percent",
    value: 5,
  } as never);
  vi.mocked(orderTotals.recomputeOrderTotals).mockResolvedValue({} as never);
});

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const ORDER_BODY = {
  type: "takeaway",
  items: [{ menuItemId: "m-1", quantity: 1 }],
};

describe("POST /api/orders — who may open a sale, who may discount it", () => {
  it("a create-only member opens a sale exactly as before", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate]);
    const { POST } = await import("./route");
    const res = await POST(request(ORDER_BODY));
    expect(res.status).toBe(404); // reached createOrder — refused only on data
    expect(orderMutations.createOrder).toHaveBeenCalledTimes(1);
  });

  it("a create-only member is refused an initial discount — and createOrder never runs", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate]);
    const { POST } = await import("./route");
    const res = await POST(
      request({ ...ORDER_BODY, discount: { type: "percent", value: 10 } }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(orderMutations.createOrder).not.toHaveBeenCalled();
  });

  it("holding orders.discount on top of create is what opens the door", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate, PERMISSIONS.ordersDiscount]);
    const { POST } = await import("./route");
    const res = await POST(
      request({ ...ORDER_BODY, discount: { type: "percent", value: 10 } }),
    );
    expect(res.status).toBe(404);
    expect(orderMutations.createOrder).toHaveBeenCalledTimes(1);
  });

  it("an override granting orders.discount to a create-only role is honoured", async () => {
    // The member-access override surface: hasPermission(granted: [orders.discount])
    // lands in the same requirePermission answer the route reads.
    allowed = new Set([PERMISSIONS.ordersCreate, PERMISSIONS.ordersDiscount]);
    const { POST } = await import("./route");
    const res = await POST(
      request({ ...ORDER_BODY, discount: { type: "amount", value: 1000 } }),
    );
    expect(res.status).not.toBe(403);
  });
});

describe("PATCH /api/orders/[id] — discount and whole-bill cancellation", () => {
  const ctx = { params: Promise.resolve({ id: "order-1" }) };

  it("create alone reaches neither the discount nor the void", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate]);
    const { PATCH } = await import("./[id]/route");

    const discountRes = await PATCH(
      request({ discount: { type: "percent", value: 5 } }),
      ctx as never,
    );
    expect(discountRes.status).toBe(403);
    expect(orderLock.lockOpenOrder).not.toHaveBeenCalled();

    const voidRes = await PATCH(request({ void: { reason: "changed my mind" } }), ctx as never);
    expect(voidRes.status).toBe(403);
    expect(orderLock.lockOpenOrder).not.toHaveBeenCalled();
  });

  it("orders.discount opens the discount edit; the order itself is then reached", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate, PERMISSIONS.ordersDiscount]);
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      request({ discount: { type: "percent", value: 5 } }),
      ctx as never,
    );
    expect(res.status).toBe(409); // lockOpenOrder's verdict — the guard passed
    expect(orderLock.lockOpenOrder).toHaveBeenCalledTimes(1);
  });

  it("orders.void opens the cancellation; a revoked void on a full manager does not", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate, PERMISSIONS.ordersVoid]);
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(request({ void: { reason: "spilled" } }), ctx as never);
    expect(res.status).toBe(409);
    expect(orderLock.lockOpenOrder).toHaveBeenCalledTimes(1);

    // …and the same body from create-only + void_item (the line-level key)
    // must still bounce: whole-bill cancellation is its own authority.
    allowed = new Set([PERMISSIONS.ordersCreate, PERMISSIONS.ordersVoidItem]);
    const res2 = await PATCH(request({ void: { reason: "spilled" } }), ctx as never);
    expect(res2.status).toBe(403);
    expect(orderLock.lockOpenOrder).toHaveBeenCalledTimes(1); // unchanged
  });

  it("ordinary edits (note, customer) need only orders.create", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate]);
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(request({ note: "no onions" }), ctx as never);
    expect(res.status).toBe(409); // reached the transaction, no permission bounce
    expect(orderLock.lockOpenOrder).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /api/orders/[id]/items/[itemId] — voiding a sent line", () => {
  const ctx = { params: Promise.resolve({ id: "order-1", itemId: "item-1" }) };

  it("create alone may edit quantity but may not void the line", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate]);
    const { PATCH } = await import("./[id]/items/[itemId]/route");

    const qtyRes = await PATCH(request({ quantity: 3 }), ctx as never);
    expect(qtyRes.status).toBe(404); // ordinary edit reaches updateOrderItem
    expect(orderMutations.updateOrderItem).toHaveBeenCalledTimes(1);

    const voidRes = await PATCH(request({ void: { reason: "wrong dish" } }), ctx as never);
    expect(voidRes.status).toBe(403);
    expect(orderMutations.updateOrderItem).toHaveBeenCalledTimes(1); // no second reach
  });

  it("orders.void_item opens the line void", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate, PERMISSIONS.ordersVoidItem]);
    const { PATCH } = await import("./[id]/items/[itemId]/route");
    const res = await PATCH(request({ void: { reason: "wrong dish" } }), ctx as never);
    expect(res.status).toBe(404);
    expect(orderMutations.updateOrderItem).toHaveBeenCalledTimes(1);
  });

  it("the whole-bill keys are not a substitute — orders.void alone does not void a line", async () => {
    allowed = new Set([PERMISSIONS.ordersCreate, PERMISSIONS.ordersVoid]);
    const { PATCH } = await import("./[id]/items/[itemId]/route");
    const res = await PATCH(request({ void: { reason: "wrong dish" } }), ctx as never);
    expect(res.status).toBe(403);
    expect(orderMutations.updateOrderItem).not.toHaveBeenCalled();
  });
});
