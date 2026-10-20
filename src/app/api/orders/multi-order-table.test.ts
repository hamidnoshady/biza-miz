import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as floor from "@/lib/floor";
import * as setup from "@/lib/setup-state";
import * as features from "@/lib/features";
import * as planLimits from "@/lib/plan-limits";
import * as entitlementService from "@/lib/entitlement-service";
import * as orderCart from "@/lib/order-cart";
import { POST as createOrderRoute } from "./route";
import { PATCH as patchOrderRoute } from "./[id]/route";
import { releaseTableAfterOrderSettled } from "@/lib/table-session-service";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock("@/lib/floor", () => ({
  checkTableSectionAuthorization: vi.fn(),
}));
vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));
vi.mock("@/lib/features", () => ({
  isFeatureEnabled: vi.fn(),
}));
vi.mock("@/lib/plan-limits", () => ({
  businessIdForLocation: vi.fn(),
  monthlyOrderCount: vi.fn(),
}));
vi.mock("@/lib/entitlement-service", () => ({
  resolveLimitCeiling: vi.fn(),
}));
vi.mock("@/lib/order-cart", () => ({
  validateItemShape: vi.fn(() => null),
  resolveCartItems: vi.fn(),
  resolveLineModifiers: vi.fn(),
}));
vi.mock("@/lib/order-state-sync", () => ({
  recordOrderState: vi.fn(async () => {}),
}));
vi.mock("@/lib/notification-events", () => ({
  recordNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/realtime", () => ({
  broadcast: vi.fn(),
}));

const session = {
  businessId: "00000000-0000-0000-0000-000000000001",
  sub: "00000000-0000-0000-0000-000000000002",
  role: "waiter",
};
const locationId = "00000000-0000-0000-0000-000000000010";
const table5Id = "00000000-0000-0000-0000-000000000005";
const table6Id = "00000000-0000-0000-0000-000000000006";
const session5Id = "00000000-0000-0000-0000-000000000055";
const session6Id = "00000000-0000-0000-0000-000000000066";
const menuItemId = "00000000-0000-0000-0000-000000000090";

interface OrderRecord {
  id: string;
  orderNumber: number;
  tableId: string | null;
  sessionId: string | null;
  status: "open" | "held" | "completed" | "voided";
  total: number;
  guestCount: number | null;
}

describe("Multiple simultaneous orders on Table 5 (Issue #916 regression)", () => {
  let tableStatus: Record<string, string>;
  let orders: Record<string, OrderRecord>;
  let nextOrderNumber: number;

  beforeEach(() => {
    vi.clearAllMocks();
    tableStatus = {
      [table5Id]: "seated",
      [table6Id]: "free",
    };
    orders = {
      "order-A": {
        id: "order-A",
        orderNumber: 101,
        tableId: table5Id,
        sessionId: session5Id,
        status: "open",
        total: 150000,
        guestCount: 2,
      },
      "order-B": {
        id: "order-B",
        orderNumber: 102,
        tableId: table5Id,
        sessionId: session5Id,
        status: "open",
        total: 220000,
        guestCount: 2,
      },
    };
    nextOrderNumber = 103;

    vi.mocked(auth.requirePermission).mockResolvedValue({
      session,
      error: null,
    } as never);
    vi.mocked(setup.resolveActiveLocation).mockResolvedValue({
      id: locationId,
    } as never);
    vi.mocked(floor.checkTableSectionAuthorization).mockResolvedValue({
      allowed: true,
      scope: {
        mode: "all",
        hasFullFloorAccess: true,
        assignedSectionIds: [],
        permissions: new Set(["orders.create", "tables.manage"]),
      },
    });
    vi.mocked(planLimits.businessIdForLocation).mockResolvedValue(session.businessId);
    vi.mocked(features.isFeatureEnabled).mockResolvedValue(true);
    vi.mocked(entitlementService.resolveLimitCeiling).mockResolvedValue({
      limit: null,
      source: "plan",
    } as never);
    vi.mocked(orderCart.resolveCartItems).mockResolvedValue({
      ok: true,
      cartLines: [{ unitPrice: 95000, quantity: 1, taxRatePercent: 0, modifierDeltas: [] }],
      preparedItems: [
        {
          menuItemId,
          nameSnapshot: "چلوکباب",
          unitPrice: 95000,
          quantity: 1,
          note: null,
          modifiers: [],
        },
      ],
    } as never);

    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, status FROM dining_tables")) {
        const tid = String(params?.[0] ?? "");
        return {
          rows: tableStatus[tid] ? [{ id: tid, status: tableStatus[tid] }] : [],
        } as never;
      }
      return { rows: [] } as never;
    });

    vi.mocked(db.getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          const normalized = sql.replace(/\s+/g, " ").trim();
          if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
            return { rows: [] };
          }
          if (normalized.startsWith("SELECT ts.id FROM table_sessions")) {
            const tid = String(params[1] ?? "");
            return { rows: [{ id: tid === table6Id ? session6Id : session5Id }] };
          }
          if (normalized.includes("next_number")) {
            return { rows: [{ next_number: String(nextOrderNumber) }] };
          }
          if (normalized.startsWith("INSERT INTO order_items")) {
            return { rows: [{ id: "item-C-1" }] };
          }
          if (normalized.startsWith("INSERT INTO orders")) {
            const createdId = "order-C";
            const orderNum = nextOrderNumber++;
            orders[createdId] = {
              id: createdId,
              orderNumber: orderNum,
              tableId: String(params[4] ?? table5Id),
              sessionId: String(params[5] ?? session5Id),
              status: "open",
              total: Number(params[14] ?? 95000),
              guestCount: 1,
            };
            return {
              rows: [
                {
                  id: createdId,
                  order_number: String(orderNum),
                  type: "dine_in",
                  subtotal: "95000",
                  discount: "0",
                  tax: "0",
                  total: "95000",
                },
              ],
            };
          }
          if (normalized.startsWith("WITH Requirements AS") || normalized.startsWith("WITH requirements AS")) {
            return { rows: [] };
          }
          if (normalized.startsWith("SELECT id, status, type, table_id, table_session_id, customer_id, guest_count")) {
            const oid = String(params[0] ?? "");
            const rec = orders[oid];
            if (!rec) return { rows: [] };
            return {
              rows: [
                {
                  id: rec.id,
                  status: rec.status,
                  type: "dine_in",
                  table_id: rec.tableId,
                  table_session_id: rec.sessionId,
                  customer_id: null,
                  guest_count: rec.guestCount,
                },
              ],
            };
          }
          if (normalized.startsWith("UPDATE orders SET status = 'voided'")) {
            const oid = String(params[0] ?? "");
            const rec = orders[oid];
            if (!rec || rec.status !== "open") return { rowCount: 0, rows: [] };
            rec.status = "voided";
            return {
              rowCount: 1,
              rows: [{ order_number: String(rec.orderNumber), total: String(rec.total) }],
            };
          }
          if (normalized.startsWith("SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active FOR UPDATE")) {
            const tid = String(params[0] ?? "");
            return {
              rows: tableStatus[tid] ? [{ id: tid, status: tableStatus[tid] }] : [],
            };
          }
          if (normalized.startsWith("UPDATE orders SET table_id = $2, table_session_id = $3 WHERE id = $1")) {
            const oid = String(params[0] ?? "");
            const newTid = String(params[1] ?? "");
            const newSid = String(params[2] ?? "");
            if (orders[oid]) {
              orders[oid].tableId = newTid;
              orders[oid].sessionId = newSid;
            }
            return { rowCount: 1, rows: [] };
          }
          if (normalized.startsWith("SELECT table_session_id FROM orders WHERE id = $1")) {
            const oid = String(params[0] ?? "");
            return {
              rows: orders[oid] ? [{ table_session_id: orders[oid].sessionId }] : [],
            };
          }
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn(),
      })),
    } as never);
  });

  it("creates order C on Table 5 alongside open orders A and B without appending to A/B or locking the table", async () => {
    const res = await createOrderRoute(
      new NextRequest("http://localhost/api/orders", {
        method: "POST",
        body: JSON.stringify({
          type: "dine_in",
          tableId: table5Id,
          guestCount: 1,
          items: [{ menuItemId, quantity: 1 }],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      id: "order-C",
      orderNumber: 103,
      type: "dine_in",
    });

    // Orders A, B, and C are three distinct open orders on Table 5; A and B totals are untouched
    expect(Object.keys(orders)).toEqual(["order-A", "order-B", "order-C"]);
    expect(orders["order-A"]).toMatchObject({ tableId: table5Id, status: "open", total: 150000 });
    expect(orders["order-B"]).toMatchObject({ tableId: table5Id, status: "open", total: 220000 });
    expect(orders["order-C"]).toMatchObject({ tableId: table5Id, status: "open", total: 95000 });
    expect(tableStatus[table5Id]).toBe("seated");
  });

  it("checkout, void, or move of order A leaves orders B and C and Table 5 manual status unchanged", async () => {
    // First create order C on Table 5 so A, B, and C are all open on Table 5
    await createOrderRoute(
      new NextRequest("http://localhost/api/orders", {
        method: "POST",
        body: JSON.stringify({
          type: "dine_in",
          tableId: table5Id,
          guestCount: 1,
          items: [{ menuItemId, quantity: 1 }],
        }),
      }),
    );

    // 1. Checkout of A (`releaseTableAfterOrderSettled`) leaves B and C open and Table 5 status 'seated'
    orders["order-A"].status = "completed";
    const pool = db.getPool();
    const client = await pool.connect();
    const settled = await releaseTableAfterOrderSettled(client, locationId, "order-A", session.sub);
    expect(settled).toEqual({ sessionId: session5Id, tableIds: [] });
    expect(orders["order-B"].status).toBe("open");
    expect(orders["order-C"].status).toBe("open");
    expect(tableStatus[table5Id]).toBe("seated");

    // Reset A to 'open' to test move of A to Table 6
    orders["order-A"].status = "open";
    const moveRes = await patchOrderRoute(
      new NextRequest("http://localhost/api/orders/order-A", {
        method: "PATCH",
        body: JSON.stringify({ tableId: table6Id }),
      }),
      { params: Promise.resolve({ id: "order-A" }) },
    );
    expect(moveRes.status).toBe(200);
    expect(orders["order-A"].tableId).toBe(table6Id);
    expect(orders["order-B"]).toMatchObject({ tableId: table5Id, status: "open", total: 220000 });
    expect(orders["order-C"]).toMatchObject({ tableId: table5Id, status: "open", total: 95000 });
    expect(tableStatus[table5Id]).toBe("seated");

    // 3. Void of A leaves B and C open on Table 5 and Table 5 manual status 'seated'
    const voidRes = await patchOrderRoute(
      new NextRequest("http://localhost/api/orders/order-A", {
        method: "PATCH",
        body: JSON.stringify({ void: { reason: "customer left" } }),
      }),
      { params: Promise.resolve({ id: "order-A" }) },
    );
    expect(voidRes.status).toBe(200);
    expect(orders["order-A"].status).toBe("voided");
    expect(orders["order-B"]).toMatchObject({ tableId: table5Id, status: "open", total: 220000 });
    expect(orders["order-C"]).toMatchObject({ tableId: table5Id, status: "open", total: 95000 });
    expect(tableStatus[table5Id]).toBe("seated");
  });
});
