/**
 * Issue #924 F04/F10 — the named-list entry route's edge contract.
 *
 * The service rounds and filters defensively, but a filtered cell used to mean
 * the screen reported "saved" and then showed the old value on the next read.
 * The route refuses the whole batch instead, so this pins which inputs are
 * refused and that nothing reaches the service when one cell is malformed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as service from "@/lib/price-lists-service";
import { PUT } from "./route";

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
  return { ...actual, savePriceEntries: vi.fn() };
});

const LIST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ITEM_ID = "8f14e45f-ceea-467a-9c04-9dbb1f4f6a3c";
const SESSION = { businessId: "biz-1", sub: "user-1" };

/** The exported handler is wrapped by `withTenantScope`; tests call it directly. */
const handler = PUT as unknown as (req: NextRequest) => Promise<Response>;

async function put(body: unknown) {
  const request = { json: async () => body } as unknown as NextRequest;
  const response = await handler(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const cell = (over: Record<string, unknown> = {}) => ({
  priceListId: LIST_ID,
  itemId: ITEM_ID,
  price: 50_000,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(service.savePriceEntries).mockResolvedValue({ touched: 1, conflicts: [] });
});

describe("PUT /api/products/price-lists/entries", () => {
  it("demands inventory.adjust rather than a menu permission", async () => {
    await put({ updates: [cell()] });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
  });

  it("saves a valid cell and answers the touched count", async () => {
    const { status, body } = await put({ updates: [cell({ expectedVersion: "1761354000123456" })] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, touched: 1 });
    expect(service.savePriceEntries).toHaveBeenCalledWith(
      [{ priceListId: LIST_ID, itemId: ITEM_ID, price: 50_000, expectedVersion: "1761354000123456" }],
      { locationId: "loc-1", businessId: "biz-1", userId: "user-1" },
    );
  });

  it("refuses a fractional, negative or oversized price instead of rounding it away", async () => {
    for (const price of [1.5, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      const { status } = await put({ updates: [cell({ price })] });
      expect(status).toBe(400);
    }
    expect(service.savePriceEntries).not.toHaveBeenCalled();
  });

  it("refuses one malformed cell in a batch rather than saving the rest", async () => {
    // A half-applied batch is the failure this route exists to prevent: the
    // screen reports one result, and the operator cannot tell which cells took.
    const { status } = await put({ updates: [cell(), cell({ price: 1.5 })] });
    expect(status).toBe(400);
    expect(service.savePriceEntries).not.toHaveBeenCalled();
  });

  it("refuses a malformed expectedVersion instead of downgrading the write", async () => {
    const { status } = await put({ updates: [cell({ expectedVersion: "not-a-version" })] });
    expect(status).toBe(400);
    expect(service.savePriceEntries).not.toHaveBeenCalled();
  });

  it("caps a single request at the documented ceiling", async () => {
    const updates = Array.from({ length: 2001 }, () => cell());
    const { status } = await put({ updates });
    expect(status).toBe(400);
    expect(service.savePriceEntries).not.toHaveBeenCalled();
  });

  it("still accepts an explicit null price — clearing a list cell is supported", async () => {
    const { status } = await put({ updates: [cell({ price: null })] });
    expect(status).toBe(200);
    expect(service.savePriceEntries).toHaveBeenCalledWith(
      [{ priceListId: LIST_ID, itemId: ITEM_ID, price: null }],
      { locationId: "loc-1", businessId: "biz-1", userId: "user-1" },
    );
  });
});
