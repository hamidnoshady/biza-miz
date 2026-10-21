import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setup from "@/lib/setup-state";
import * as industry from "@/lib/industry-guard";
import * as creation from "@/lib/product-creation-service";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCT_CREATE_REQUEST_MAX_BYTES } from "@/lib/product-attributes";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));
vi.mock("@/lib/product-creation-service", () => ({
  createProductRecord: vi.fn(),
  ProductAttributeValidationError: class ProductAttributeValidationError extends Error {},
}));
vi.mock("@/lib/item-barcodes-service", () => ({
  BarcodeConflictError: class BarcodeConflictError extends Error {},
}));

const session = { businessId: "business-1", locationId: "branch-a", activeLocationId: "branch-a" };

function request(body: string, headers?: HeadersInit): NextRequest {
  return new NextRequest("http://localhost/api/products/items", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(industry.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "branch-a" } as never);
  vi.mocked(creation.createProductRecord).mockResolvedValue({ item: { id: "item-1" }, variants: [] } as never);
});

describe("POST /api/products/items request bounds", () => {
  it("rejects oversized JSON before parsing or creating a product", async () => {
    const response = await POST(request("{}", {
      "content-length": String(PRODUCT_CREATE_REQUEST_MAX_BYTES + 1),
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
    expect(creation.createProductRecord).not.toHaveBeenCalled();
  });

  it("rejects unknown product fields before resolving a branch or writing", async () => {
    const response = await POST(request(JSON.stringify({ name: "کالا", internal: true })));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "validation_failed",
      issues: [expect.objectContaining({ field: "internal", code: "unknown_field" })],
    });
    expect(setup.resolveActiveLocation).not.toHaveBeenCalled();
    expect(creation.createProductRecord).not.toHaveBeenCalled();
  });
});
