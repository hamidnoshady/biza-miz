import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as purchaseService from "@/lib/purchase-service";
import { POST } from "./route";

/**
 * Scoped to this session's change: `POST /api/inventory/purchases` passing
 * `invoiceAssetId` (migration 0179) through to `createDraftPurchase` — the
 * cross-tenant re-validation itself lives in, and is proven against a real
 * database by, `purchase-service.ts`
 * (`integration/purchase-invoice-asset.integration.test.ts`); this only pins
 * that the route forwards the right shape and maps the service's error back.
 * The route's pre-existing GET/line-validation behaviour is untouched by
 * this change and out of scope here.
 */

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));

vi.mock("@/lib/purchase-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/purchase-service")>();
  return { ...actual, createDraftPurchase: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const LOCATION = { id: "loc-1" };

function req(body: unknown): NextRequest {
  return new Request("http://localhost:3000/api/inventory/purchases", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(LOCATION as never);
  vi.mocked(purchaseService.createDraftPurchase).mockResolvedValue({ id: "purchase-1", total: "500000" } as never);
});

describe("POST /api/inventory/purchases — invoiceAssetId (migration 0179)", () => {
  it("forwards a string invoiceAssetId and this business's id to createDraftPurchase", async () => {
    const res = await POST(req({ items: [{ inventoryItemId: "i1", purchaseQty: "1", totalCost: "1000" }], invoiceAssetId: "asset-9" }));
    expect(res.status).toBe(200);
    expect(purchaseService.createDraftPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: SESSION.businessId, invoiceAssetId: "asset-9", locationId: LOCATION.id }),
    );
  });

  it("normalizes an absent or non-string invoiceAssetId to null rather than undefined", async () => {
    await POST(req({ items: [] }));
    expect(purchaseService.createDraftPurchase).toHaveBeenCalledWith(expect.objectContaining({ invoiceAssetId: null }));

    await POST(req({ items: [], invoiceAssetId: 12345 }));
    expect(purchaseService.createDraftPurchase).toHaveBeenCalledWith(expect.objectContaining({ invoiceAssetId: null }));
  });

  it("maps invoice_asset_not_found from the service to its own 404, same as any other PurchaseServiceError", async () => {
    const { PurchaseServiceError } = await import("@/lib/purchase-service");
    vi.mocked(purchaseService.createDraftPurchase).mockRejectedValue(
      new PurchaseServiceError("invoice_asset_not_found", 404),
    );
    const res = await POST(req({ items: [], invoiceAssetId: "cross-tenant-asset" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("invoice_asset_not_found");
  });

  it("409s no_location before ever calling createDraftPurchase", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null);
    const res = await POST(req({ items: [] }));
    expect(res.status).toBe(409);
    expect(purchaseService.createDraftPurchase).not.toHaveBeenCalled();
  });
});
