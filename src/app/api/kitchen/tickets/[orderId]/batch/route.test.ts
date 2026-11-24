import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { requirePermission } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { transitionKitchenTicketBatch } from "@/lib/kitchen-item-transition";
import { announceKitchenOrderReady } from "@/lib/kitchen-order-ready";
import { broadcast } from "@/lib/realtime";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/kitchen-item-transition", () => ({ transitionKitchenTicketBatch: vi.fn() }));
vi.mock("@/lib/kitchen-order-ready", () => ({ announceKitchenOrderReady: vi.fn() }));
vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));

const permissionMock = vi.mocked(requirePermission);
const locationMock = vi.mocked(resolveActiveLocation);
const batchMock = vi.mocked(transitionKitchenTicketBatch);
const readyMock = vi.mocked(announceKitchenOrderReady);
const broadcastMock = vi.mocked(broadcast);

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_A = "22222222-2222-4222-8222-222222222222";
const ITEM_B = "33333333-3333-4333-8333-333333333333";
const session = { businessId: "biz-1", sub: "member-1", role: "kitchen" };

function request(body: unknown) {
  return new NextRequest(`http://local/api/kitchen/tickets/${ORDER_ID}/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(orderId = ORDER_ID) {
  return { params: Promise.resolve({ orderId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  permissionMock.mockResolvedValue({ session, error: null } as never);
  locationMock.mockResolvedValue({ id: "loc-1" } as never);
  readyMock.mockResolvedValue(undefined);
  batchMock.mockResolvedValue({
    kind: "processed",
    orderId: ORDER_ID,
    requestedStatus: "ready",
    items: [
      {
        itemId: ITEM_A,
        outcome: "applied",
        currentStatus: "ready",
        nameSnapshot: "کوکو",
        quantity: 2,
      },
      {
        itemId: ITEM_B,
        outcome: "conflict",
        currentStatus: "served",
        nameSnapshot: "چای",
        quantity: 1,
      },
    ],
    summary: {
      total: 2,
      applied: 1,
      alreadyApplied: 0,
      conflict: 1,
      ineligible: 0,
      missing: 0,
    },
    appliedItemIds: [ITEM_A],
  } as never);
});

describe("POST /api/kitchen/tickets/[orderId]/batch", () => {
  it("returns item-level results, dedupes the selection and broadcasts only applied lines", async () => {
    const response = await POST(
      request({ status: "ready", itemIds: [ITEM_A, ITEM_A, ITEM_B] }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      orderId: ORDER_ID,
      requestedStatus: "ready",
      items: [
        { itemId: ITEM_A, outcome: "applied", currentStatus: "ready" },
        { itemId: ITEM_B, outcome: "conflict", currentStatus: "served" },
      ],
      summary: { total: 2, applied: 1, conflict: 1 },
    });
    expect(batchMock).toHaveBeenCalledWith({
      businessId: "biz-1",
      locationId: "loc-1",
      orderId: ORDER_ID,
      to: "ready",
      itemIds: [ITEM_A, ITEM_B],
      mayBumpKitchen: true,
      actorUserId: "member-1",
      syncActor: { userId: "member-1", role: "kitchen" },
    });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith("loc-1", {
      type: "order.item_status",
      orderId: ORDER_ID,
      itemId: ITEM_A,
      status: "ready",
    });
    expect(readyMock).toHaveBeenCalledWith({
      businessId: "biz-1",
      locationId: "loc-1",
      orderId: ORDER_ID,
    });
  });

  it("does not run the ready automation for a start-preparing batch", async () => {
    batchMock.mockResolvedValue({
      kind: "processed",
      orderId: ORDER_ID,
      requestedStatus: "preparing",
      items: [],
      summary: { total: 0, applied: 0, alreadyApplied: 0, conflict: 0, ineligible: 0, missing: 0 },
      appliedItemIds: [],
    } as never);

    const response = await POST(request({ status: "preparing" }), context());
    expect(response.status).toBe(200);
    expect(readyMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(batchMock).toHaveBeenCalledWith(expect.objectContaining({ itemIds: undefined }));
  });

  it("rejects an invalid status or an empty/invalid selection before touching the service", async () => {
    const badStatus = await POST(request({ status: "served" }), context());
    expect(badStatus.status).toBe(400);
    expect(await badStatus.json()).toEqual({ error: "invalid_status" });

    const emptySelection = await POST(request({ status: "ready", itemIds: [] }), context());
    expect(emptySelection.status).toBe(400);
    expect(await emptySelection.json()).toEqual({ error: "invalid_items" });

    const notAUuid = await POST(request({ status: "ready", itemIds: ["not-a-uuid"] }), context());
    expect(notAUuid.status).toBe(400);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("refuses without kitchen.view and never calls the batch service", async () => {
    permissionMock.mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    } as never);

    const response = await POST(request({ status: "ready" }), context());
    expect(response.status).toBe(403);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or cross-location ticket without leaking a partial success", async () => {
    batchMock.mockResolvedValue({
      kind: "missing_order",
      orderId: ORDER_ID,
      requestedStatus: "preparing",
      items: [],
      summary: { total: 0, applied: 0, alreadyApplied: 0, conflict: 0, ineligible: 0, missing: 0 },
      appliedItemIds: [],
    } as never);

    const response = await POST(request({ status: "preparing" }), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "ticket_not_found" });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("answers 409 when the member has no active location", async () => {
    locationMock.mockResolvedValue(null as never);
    const response = await POST(request({ status: "ready" }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_location" });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed ticket id before authorization", async () => {
    const response = await POST(request({ status: "ready" }), context("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(permissionMock).not.toHaveBeenCalled();
  });
});
