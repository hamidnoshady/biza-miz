import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateOrderInput } from "./order-mutations";

const mocks = vi.hoisted(() => ({
  businessIdForLocation: vi.fn(),
  isFeatureEnabled: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock("./plan-limits", () => ({
  businessIdForLocation: mocks.businessIdForLocation,
  monthlyOrderCount: vi.fn(),
}));
vi.mock("./features", () => ({ isFeatureEnabled: mocks.isFeatureEnabled }));
vi.mock("./db", () => ({
  getPool: mocks.getPool,
  query: vi.fn(),
}));
vi.mock("./entitlement-service", () => ({
  resolveLimitCeiling: vi.fn(async () => ({ limit: null })),
}));
vi.mock("./order-cart", () => ({
  validateItemShape: vi.fn(() => null),
  resolveCartItems: vi.fn(async () => ({ ok: false, error: "test_stop", status: 400 })),
  resolveLineModifiers: vi.fn(),
}));

const { createOrder } = await import("./order-mutations");

const input: CreateOrderInput = {
  locationId: "location-1",
  type: "dine_in",
  tableId: null,
  discount: { type: null },
  items: [{ menuItemId: "menu-item-1", quantity: 1 }],
  openedBy: "cashier-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.businessIdForLocation.mockResolvedValue("business-1");
  mocks.isFeatureEnabled.mockResolvedValue(false);
});

describe("createOrder table-service entitlement", () => {
  it("rejects direct and offline-replay dine-in creation when reservations are disabled", async () => {
    const result = await createOrder(input);

    expect(result).toEqual({ ok: false, error: "feature_disabled", status: 403 });
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith("business-1", "reservations");
    // The refusal happens before opening a transaction or resolving catalogue
    // items, so no direct caller can bypass the UI's hidden table affordance.
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("does not gate takeaway and keeps the existing delivery flag independent", async () => {
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await createOrder({ ...input, type: "takeaway" });
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalledWith("business-1", "reservations");

    vi.clearAllMocks();
    mocks.businessIdForLocation.mockResolvedValue("business-1");
    mocks.isFeatureEnabled.mockResolvedValue(true);
    await createOrder({ ...input, type: "delivery", delivery: { address: "تهران" } });
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith("business-1", "delivery");
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalledWith("business-1", "reservations");
  });
});
