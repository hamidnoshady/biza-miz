import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as floor from "@/lib/floor";
import * as setup from "@/lib/setup-state";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requireAnyPermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/floor", () => ({ resolveFloorSectionAccessScope: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));

const session = {
  businessId: "00000000-0000-0000-0000-000000000001",
  sub: "00000000-0000-0000-0000-000000000002",
  role: "waiter",
};
const locationId = "00000000-0000-0000-0000-000000000010";
const tableId = "00000000-0000-0000-0000-000000000020";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({
    session,
    error: null,
  } as never);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({
    id: locationId,
  } as never);
  vi.mocked(floor.resolveFloorSectionAccessScope).mockResolvedValue({
    mode: "all",
    hasFullFloorAccess: true,
    assignedSectionIds: [],
    permissions: new Set(["tables.manage", "orders.create"]),
  });
});

describe("GET /api/waiter/board", () => {
  it("returns all simultaneous open/held orders on a table and sums item_status_counts across them", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000030",
            name: "سالن اصلی",
            color: "#0f766e",
            assigned_waiter_id: null,
            waiter_name: null,
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: tableId,
            name: "میز ۱",
            section_id: "00000000-0000-0000-0000-000000000030",
            capacity: 4,
            status: "seated",
            session_id: "00000000-0000-0000-0000-000000000040",
            party_size: 4,
            guest_name: "علی",
            session_opened_at: "2026-10-19T12:00:00Z",
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000102",
            table_id: tableId,
            table_session_id: "00000000-0000-0000-0000-000000000040",
            order_number: 102,
            status: "open",
            total: "250000",
            opened_at: new Date("2026-10-19T12:15:00Z"),
            customer_id: null,
            customer_name: "مریم",
          },
          {
            id: "00000000-0000-0000-0000-000000000101",
            table_id: tableId,
            table_session_id: "00000000-0000-0000-0000-000000000040",
            order_number: 101,
            status: "held",
            total: "180000",
            opened_at: new Date("2026-10-19T12:05:00Z"),
            customer_id: null,
            customer_name: "علی",
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            order_id: "00000000-0000-0000-0000-000000000101",
            status: "ready",
            n: "2",
          },
          {
            order_id: "00000000-0000-0000-0000-000000000102",
            status: "preparing",
            n: "3",
          },
          {
            order_id: "00000000-0000-0000-0000-000000000102",
            status: "ready",
            n: "1",
          },
        ],
      } as never);

    const res = await GET(new NextRequest("http://localhost/api/waiter/board"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tables).toHaveLength(1);
    const table = body.tables[0];
    expect(table.active_order_count).toBe(2);
    expect(table.orders).toHaveLength(2);
    expect(table.orders.map((o: { order_number: number }) => o.order_number)).toEqual([
      102, 101,
    ]);
    // Summed across BOTH active orders so ready items on order #101 are never hidden by order #102
    expect(table.item_status_counts).toEqual({
      ready: 3,
      preparing: 3,
    });
  });
});
