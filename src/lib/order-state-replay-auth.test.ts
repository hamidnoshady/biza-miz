import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { orderStateReplayPermissions } from "./order-state-replay-auth";

function client(rows: unknown[][]): PoolClient {
  const query = vi.fn();
  for (const resultRows of rows) query.mockResolvedValueOnce({ rows: resultRows });
  return { query } as unknown as PoolClient;
}

const openedAt = new Date("2026-10-20T08:00:00.000Z");
const currentOrder = {
  type: "dine_in", status: "open", order_number: "12", table_id: "table-1", customer_id: null,
  guest_count: 2, note: null, discount_type: null, discount_value: null, subtotal: "500",
  discount: "0", service_charge: "0", tax: "0", total: "500", opened_at: openedAt,
  opened_by: "member-1", voided_reason: null, closed_by: null, closed_at: null,
};
const currentItem = {
  id: "line-1", menu_item_id: "menu-1", name_snapshot: "چای", unit_price: "500", quantity: 1,
  status: "preparing", note: null, sent_to_kitchen_at: new Date("2026-10-20T08:00:00.000Z"),
  ready_at: null, created_at: new Date("2026-10-20T08:00:00.000Z"), void_reason: null,
};
const state = (overrides: Record<string, unknown> = {}) => ({
  orderId: "order-1",
  order: {
    type: "dine_in", status: "open", orderNumber: "12", tableId: "table-1", customerId: null,
    guestCount: 2, note: null, discountType: null, discountValue: null, subtotal: "500",
    discount: "0", serviceCharge: "0", tax: "0", total: "500", openedAt: openedAt.toISOString(),
    openedBy: "member-1", voidedReason: null, closedBy: null, closedAt: null,
  },
  items: [{
    id: "line-1", menuItemId: "menu-1", nameSnapshot: "چای", unitPrice: "500", quantity: 1,
    status: "ready", note: null, sentToKitchenAt: openedAt.toISOString(),
    readyAt: openedAt.toISOString(), createdAt: openedAt.toISOString(), voidReason: null, modifiers: [],
  }],
  ...overrides,
});

describe("orderStateReplayPermissions", () => {
  it("authorizes a pure fulfillment snapshot with kitchen.view, not the registry's orders.create", async () => {
    await expect(orderStateReplayPermissions(client([[currentOrder], [currentItem], []]), "loc-1", state()))
      .resolves.toEqual(["kitchen.view"]);
  });

  it("compares PostgreSQL decimals with numeric JSON snapshot fields without escalating fulfillment", async () => {
    const orderWithDecimals = { ...currentOrder, subtotal: "500.00", total: "500.00" };
    const itemWithDecimal = { ...currentItem, unit_price: "500.00" };
    const numericSnapshot = state({
      order: { ...state().order, subtotal: 500, total: 500 },
      items: [{ ...state().items[0], unitPrice: 500, status: "ready" }],
    });
    await expect(orderStateReplayPermissions(
      client([[orderWithDecimals], [itemWithDecimal], []]), "loc-1", numericSnapshot,
    )).resolves.toEqual(["kitchen.view"]);
  });

  it("requires orders.create if a fulfillment event also changes order content", async () => {
    const changed = state({ items: [{ ...state().items[0], status: "ready", quantity: 2 }] });
    await expect(orderStateReplayPermissions(client([[currentOrder], [currentItem], []]), "loc-1", changed))
      .resolves.toEqual(["kitchen.view", "orders.create"]);
  });

  it("requires orders.view for a serve-only snapshot and orders.create for voiding", async () => {
    const served = state({ items: [{ ...state().items[0], status: "served", readyAt: null }] });
    await expect(orderStateReplayPermissions(client([[currentOrder], [currentItem], []]), "loc-1", served))
      .resolves.toEqual(["orders.view"]);
    const voided = state({ items: [{ ...state().items[0], status: "voided", readyAt: null }] });
    await expect(orderStateReplayPermissions(client([[currentOrder], [currentItem], []]), "loc-1", voided))
      .resolves.toEqual(["orders.create"]);
  });

  it("requires order mutation permission for a missing aggregate or malformed snapshot", async () => {
    await expect(orderStateReplayPermissions(client([[]]), "loc-1", state())).resolves.toEqual(["orders.create"]);
    await expect(orderStateReplayPermissions(client([]), "loc-1", {})).resolves.toEqual(["orders.create"]);
  });
});
