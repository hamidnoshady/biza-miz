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

describe("GET /api/inventory/stock-levels", () => {
  it("returns stock levels and totals for default location", async () => {
    const mockItems = [
      {
        id: "item-1",
        item_name: "شیر پرچرب",
        sku: "MLK-01",
        unit: "لیتر",
        quantity: "15.5",
        reorder_level: "5",
        value_rial: "775000",
        unit_cost: "50000",
      },
      {
        id: "item-2",
        item_name: "قهوه عربیکا",
        sku: "COF-01",
        unit: "کیلوگرم",
        quantity: "0",
        reorder_level: "2",
        value_rial: "0",
        unit_cost: "350000",
      },
    ];

    const mockTotals = [
      {
        count: "2",
        low: "0",
        out: "1",
        value: "775000",
      },
    ];

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: mockItems } as never)
      .mockResolvedValueOnce({ rows: mockTotals } as never);

    const response = await GET(getRequest("http://localhost:3000/api/inventory/stock-levels"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.locationId).toBe(LOCATION_ID);
    expect(body.items).toHaveLength(2);
    expect(body.totals).toEqual({
      count: 2,
      lowStockCount: 0,
      outOfStockCount: 1,
      totalValueRial: "775000",
    });
  });

  it("handles explicit locationId and search query parameter", async () => {
    const explicitLocationId = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ count: "0", low: "0", out: "0", value: "0" }] } as never);

    const response = await GET(
      getRequest(`http://localhost:3000/api/inventory/stock-levels?locationId=${explicitLocationId}&search=قهوه`),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.locationId).toBe(explicitLocationId);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("ILIKE"),
      expect.arrayContaining([explicitLocationId, SESSION.businessId, "%قهوه%"]),
    );
  });

  it("returns empty result when no location is found or resolved", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET(getRequest("http://localhost:3000/api/inventory/stock-levels"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.items).toEqual([]);
    expect(body.totals.count).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns bad_request for invalid uuid locationId", async () => {
    const response = await GET(getRequest("http://localhost:3000/api/inventory/stock-levels?locationId=invalid-uuid"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
  });

  it("returns authentication error when role check fails", async () => {
    const errorResponse = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: errorResponse } as never);

    const response = await GET(getRequest("http://localhost:3000/api/inventory/stock-levels"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});
