/**
 * Issue #924 F12 / code-review item 1 — the matrix read is bounded at the HTTP
 * edge.
 *
 * The screen used to receive every item plus every filled cell in one response.
 * The route now clamps `limit` (default 50, hard maximum 200), refuses to let a
 * caller widen it, and returns only the cells of the page it hands back. These
 * cases pin the contract a stale client or a hand-edited URL cannot break.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as service from "@/lib/price-lists-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, requireProductWorkspaceForApi: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/price-lists-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/price-lists-service")>();
  return {
    ...actual,
    listPriceLists: vi.fn(),
    listPriceMatrix: vi.fn(),
    createPriceList: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

const ITEMS = Array.from({ length: 3 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  name: `کالای ${i}`,
  sku: null,
  barcode: null,
  kind: "simple",
  parentName: null,
  unitPrice: 10_000,
  unitCost: null,
  isSellable: true,
  version: "1",
}));

function request(url: string): NextRequest {
  return { url } as unknown as NextRequest;
}

/** The exported handler is wrapped by `withTenantScope`; tests call it directly. */
const get = GET as unknown as (req: NextRequest) => Promise<Response>;
const post = POST as unknown as (req: NextRequest) => Promise<Response>;

async function callGet(url: string) {
  const response = await get(request(url));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(service.listPriceLists).mockResolvedValue([]);
  vi.mocked(service.listPriceMatrix).mockImplementation(async (_locationId, query) => ({
    items: ITEMS,
    entries: [],
    total: 120,
    limit: query.limit,
    offset: query.offset,
    hasMore: query.offset + ITEMS.length < 120,
  }));
});

describe("GET /api/products/price-lists — bounded matrix", () => {
  it("defaults to 50 rows and offset 0", async () => {
    const { status, body } = await callGet("http://localhost/api/products/price-lists");
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 120, limit: 50, offset: 0, hasMore: true });
    expect(service.listPriceMatrix).toHaveBeenCalledWith("loc-1", { q: null, limit: 50, offset: 0 });
  });

  it("passes a search term through and pages by offset", async () => {
    await callGet("http://localhost/api/products/price-lists?q=%DA%A9%D8%A7%D9%84%D8%A7&limit=25&offset=50");
    expect(service.listPriceMatrix).toHaveBeenCalledWith("loc-1", { q: "کالا", limit: 25, offset: 50 });
  });

  it("clamps a caller that asks for the whole catalogue", async () => {
    const { body } = await callGet("http://localhost/api/products/price-lists?limit=100000&offset=-5");
    expect(body).toMatchObject({
      limit: service.PRICE_MATRIX_MAX_LIMIT,
      offset: 0,
    });
  });

  it("answers an empty page without inventing rows", async () => {
    vi.mocked(service.listPriceMatrix).mockResolvedValue({
      items: [],
      entries: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    const { body } = await callGet("http://localhost/api/products/price-lists");
    expect(body).toMatchObject({ items: [], entries: [], total: 0, hasMore: false });
  });

  it("requires inventory.view, not a menu permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) as never,
    } as never);

    const response = await get(request("http://localhost/api/products/price-lists"));
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryView);
  });
});

describe("POST /api/products/price-lists — list management", () => {
  it("requires inventory.adjust to create a named list", async () => {
    vi.mocked(service.createPriceList).mockResolvedValue({ list: undefined, error: "unsupported_currency" });
    const response = await post({
      json: async () => ({ name: "عمده", currency: "GBP" }),
    } as unknown as NextRequest);

    expect(response.status).toBe(400);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
  });
});
