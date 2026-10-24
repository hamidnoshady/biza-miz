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
vi.mock("@/lib/retail-stock-service", async () => {
  return {
    lowStockReportPage: vi.fn().mockResolvedValue({
      rows: [{ itemId: "1", itemName: "Test", sku: "SKU", quantity: "0", reorderPoint: "5", level: "out", unit: null, category: null, unitCost: null, hasMissingCost: false, valueRialText: "0" }],
      total: 1,
      pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
      summary: { totalValueRialText: "0", missingCostCount: 0, outCount: 1, lowCount: 0 },
    }),
    deadStockReportPage: vi.fn().mockResolvedValue({
      rows: [],
      total: 0,
      pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
      summary: { totalValueRialText: "0", missingCostCount: 0 },
    }),
  };
});

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12", role: "owner" };
const LOCATION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const OTHER_LOCATION = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: LOCATION_ID } as never);
  // default: warehouse belongs to business
  vi.mocked(db.query).mockResolvedValue({ rows: [{ id: LOCATION_ID }] } as never);
});

function getRequest(url: string) {
  return { url } as unknown as NextRequest;
}

describe("GET /api/stock/reports", () => {
  it("returns low and dead reports with applied metadata (no legacy, real cutoff)", async () => {
    const res = await GET(getRequest(`http://localhost/api/stock/reports?days=90`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied.daysApplied).toBe(90);
    expect(body.applied.locationId).toBe(LOCATION_ID);
    expect(body.low).toBeDefined();
    expect(body.dead).toBeDefined();
    expect(body.legacy).toBeUndefined();
    expect(body.applied.cutoff).toBeDefined();
    expect(typeof body.applied.cutoff).toBe("string");
  });

  it("rejects invalid days with 400", async () => {
    for (const bad of ["0", "-1", "4000", "abc", "NaN", "Infinity", "90.5"]) {
      const res = await GET(getRequest(`http://localhost/api/stock/reports?days=${bad}`));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/invalid_days|days_out_of_range/);
    }
  });

  it("accepts 30/60/90/180 and custom bounded days", async () => {
    for (const good of ["1", "30", "60", "90", "180", "3650"]) {
      const res = await GET(getRequest(`http://localhost/api/stock/reports?days=${good}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied.daysApplied).toBe(Number(good));
    }
  });

  it("defaults to 90 when days absent", async () => {
    const res = await GET(getRequest(`http://localhost/api/stock/reports`));
    expect(res.status).toBe(200);
    expect((await res.json()).applied.daysApplied).toBe(90);
  });

  it("validates warehouse UUID and ownership (business_id + location scope)", async () => {
    const resBad = await GET(getRequest(`http://localhost/api/stock/reports?locationId=not-a-uuid`));
    expect(resBad.status).toBe(400);

    // Valid UUID but not belonging to business -> 404 (single business_id check)
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never);
    const resNotFound = await GET(getRequest(`http://localhost/api/stock/reports?locationId=${OTHER_LOCATION}`));
    expect(resNotFound.status).toBe(404);
  });

  it("supports pagination params", async () => {
    const res = await GET(getRequest(`http://localhost/api/stock/reports?lowPage=2&deadPage=3`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.low.pagination.page).toBe(1); // mocked returns page 1
  });

  it("handles unauthorized and returns error for permission failure", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null as unknown as typeof SESSION, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as never);
    const res = await GET(getRequest(`http://localhost/api/stock/reports`));
    expect(res.status).toBe(401);
  });

  it("resolves active location when no warehouse specified", async () => {
    const res = await GET(getRequest(`http://localhost/api/stock/reports`));
    expect(vi.mocked(setupState.resolveActiveLocation)).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("exposes applied filters mirror including category/valuation/cutoff", async () => {
    const res = await GET(getRequest(`http://localhost/api/stock/reports?search=test&includeInactive=true&severity=out&sortBy=value&sortDir=desc&category=TESTCAT&valuation=missing`));
    const body = await res.json();
    expect(body.applied.search).toBe("test");
    expect(body.applied.includeInactive).toBe(true);
    expect(body.applied.severity).toBe("out");
    expect(body.applied.category).toBe("TESTCAT");
    expect(body.applied.valuation).toBe("missing");
    expect(body.applied.cutoff).toBeDefined();
    expect(body.legacy).toBeUndefined();
  });
});
