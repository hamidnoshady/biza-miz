import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return { ...actual, authorize: vi.fn().mockResolvedValue({ ok: true }), denialResponse: vi.fn() };
});

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12", role: "owner" };
const LOCATION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: LOCATION_ID } as never);
});

function getRequest(url: string) {
  return { url } as unknown as NextRequest;
}

describe("GET /api/stock/stock-levels", () => {
  it("returns retail stock items and classifies low/out/ok status", async () => {
    const mockRows = [
      {
        id: "item-1",
        name: "عطر ادکلن دیور",
        sku: "PRF-01",
        tracking: "batch",
        quantity: "5",
        unit_cost: "1200000",
        reorder_point: "10",
      },
      {
        id: "item-2",
        name: "ساعت مچی نقره‌ای",
        sku: "WTC-01",
        tracking: "serial",
        quantity: "0",
        unit_cost: "5000000",
        reorder_point: "1",
      },
      {
        id: "item-3",
        name: "دستبند چرم",
        sku: "ACC-01",
        tracking: "none",
        quantity: "20",
        unit_cost: "300000",
        reorder_point: "5",
      },
    ];

    vi.mocked(db.query).mockResolvedValueOnce({ rows: mockRows } as never);

    const response = await GET(getRequest("http://localhost:3000/api/stock/stock-levels"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.locationId).toBe(LOCATION_ID);
    expect(body.items).toHaveLength(3);

    // Item 1: qty 5, reorder 10 -> low
    expect(body.items[0].level).toBe("low");
    expect(body.items[0].valueRial).toBe(6000000);

    // Item 2: qty 0, reorder 1 -> out
    expect(body.items[1].level).toBe("out");
    expect(body.items[1].valueRial).toBe(0);

    // Item 3: qty 20, reorder 5 -> ok
    expect(body.items[2].level).toBe("ok");
    expect(body.items[2].valueRial).toBe(6000000);

    // Totals
    expect(body.totals).toEqual({
      count: 3,
      lowStockCount: 1,
      outOfStockCount: 1,
      totalUnits: "25",
      totalValueRial: "12000000",
    });
  });

  it("handles empty location or when no location is resolved", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET(getRequest("http://localhost:3000/api/stock/stock-levels"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.items).toEqual([]);
    expect(body.totals.count).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns bad_request for invalid uuid locationId", async () => {
    const response = await GET(getRequest("http://localhost:3000/api/stock/stock-levels?locationId=not-a-uuid"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
  });
});
