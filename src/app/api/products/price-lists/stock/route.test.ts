/**
 * Issue #924 F04/F08 — the stock price route's edge contract.
 *
 * `saveStockPrices` is unit- and integration-tested; this pins the HTTP gate:
 * which permission each method demands, and that malformed cells are refused
 * before any service call (a bad batch must not half-apply or silently no-op).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as service from "@/lib/price-lists-service";
import { GET, PUT } from "./route";

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
  return { ...actual, saveStockPrices: vi.fn() };
});
const query = vi.fn();
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: (...args: unknown[]) => query(...args) };
});

const ITEM_ID = "8f14e45f-ceea-467a-9c04-9dbb1f4f6a3c";
const SESSION = { businessId: "biz-1", sub: "user-1" };

/** The exported handlers are wrapped by `withTenantScope`; tests call them directly. */
const handler = PUT as unknown as (req: NextRequest) => Promise<Response>;
const readHandler = GET as unknown as () => Promise<Response>;

async function put(body: unknown) {
  const request = { json: async () => body } as unknown as NextRequest;
  const response = await handler(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(service.saveStockPrices).mockResolvedValue({ touched: 1, conflicts: [], skipped: [] });
  query.mockResolvedValue({ rows: [] });
});

describe("PUT /api/products/price-lists/stock", () => {
  it("demands inventory.adjust rather than a menu permission", async () => {
    await put({ updates: [{ itemId: ITEM_ID, kind: "sale", price: 12_000 }] });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
  });

  it("saves a valid versioned cell", async () => {
    const { status, body } = await put({
      updates: [{ itemId: ITEM_ID, kind: "sale", price: 12_000, expectedVersion: "1761354000123456" }],
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, touched: 1 });
    expect(service.saveStockPrices).toHaveBeenCalledWith(
      [
        {
          itemId: ITEM_ID,
          kind: "sale",
          price: 12_000,
          expectedVersion: "1761354000123456",
        },
      ],
      { locationId: "loc-1", businessId: "biz-1", userId: "user-1" },
    );
  });

  it("rejects a malformed version before the service sees the batch", async () => {
    const { status, body } = await put({
      updates: [{ itemId: ITEM_ID, kind: "sale", price: 12_000, expectedVersion: "12abc" }],
    });
    expect(status).toBe(400);
    expect(body.error).toBe("bad_request");
    expect(service.saveStockPrices).not.toHaveBeenCalled();
  });

  it("rejects fractional, negative, non-finite and oversized prices", async () => {
    for (const price of [1.5, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      const { status } = await put({ updates: [{ itemId: ITEM_ID, kind: "sale", price }] });
      expect(status, String(price)).toBe(400);
    }
    expect(service.saveStockPrices).not.toHaveBeenCalled();
  });

  it("refuses to unprice a sale cell", async () => {
    const { status, body } = await put({ updates: [{ itemId: ITEM_ID, kind: "sale", price: 0 }] });
    expect(status).toBe(400);
    expect(body.error).toBe("sale_price_must_be_positive");
    expect(service.saveStockPrices).not.toHaveBeenCalled();
  });

  it("accepts a purchase cost of zero — a genuinely free item", async () => {
    const { status } = await put({ updates: [{ itemId: ITEM_ID, kind: "purchase", price: 0 }] });
    expect(status).toBe(200);
  });

  it("rejects unknown cells and oversized batches", async () => {
    const badKind = await put({ updates: [{ itemId: ITEM_ID, kind: "retail", price: 1_000 }] });
    expect(badKind.status).toBe(400);
    const badId = await put({ updates: [{ itemId: "nope", kind: "sale", price: 1_000 }] });
    expect(badId.status).toBe(400);
    const huge = await put({
      updates: Array.from({ length: 2_001 }, () => ({ itemId: ITEM_ID, kind: "sale", price: 1_000 })),
    });
    expect(huge.status).toBe(400);
  });

  it("returns no location as a conflict rather than a successful no-op", async () => {
    vi.mocked(setup.resolveActiveLocation).mockResolvedValue(null);
    const { status, body } = await put({ updates: [{ itemId: ITEM_ID, kind: "sale", price: 1_000 }] });
    expect(status).toBe(409);
    expect(body.error).toBe("no_location");
  });
});

describe("GET /api/products/price-lists/stock", () => {
  it("reads on inventory.view, not a menu permission", async () => {
    const response = await readHandler();
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryView);
    await expect(response.json()).resolves.toEqual({ items: [] });
  });

  it("returns an empty list when no branch is active", async () => {
    vi.mocked(setup.resolveActiveLocation).mockResolvedValue(null);
    const response = await readHandler();
    await expect(response.json()).resolves.toEqual({ items: [] });
    expect(query).not.toHaveBeenCalled();
  });
});
