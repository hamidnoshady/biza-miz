import { describe, expect, it } from "vitest";
import { isCafeCmsOrder } from "./cafe-order-intake-service";
import type { CmsOrder } from "./types";

const legacy: CmsOrder = {
  id: "cms-1",
  reference: "REF-1",
  status: "paid",
  product: "prod-1",
  quantity: 1,
  unitPrice: 1000,
  total: 1000,
  currency: "IRR",
  buyer: { name: "مشتری", phone: "09120000000" },
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:00:00.000Z",
};

describe("isCafeCmsOrder", () => {
  it("keeps the legacy single-product storefront order on the Phase G path", () => {
    expect(isCafeCmsOrder(legacy)).toBe(false);
  });

  it("recognises a multi-line basket", () => {
    expect(
      isCafeCmsOrder({
        ...legacy,
        items: [{ productId: "prod-1", quantity: 2 }],
      }),
    ).toBe(true);
  });

  it("recognises an explicit service mode", () => {
    expect(isCafeCmsOrder({ ...legacy, serviceMode: "takeaway" })).toBe(true);
    expect(isCafeCmsOrder({ ...legacy, serviceMode: "dine_in" })).toBe(true);
  });

  it("recognises a table token even without the other markers", () => {
    expect(isCafeCmsOrder({ ...legacy, tableToken: "tqr_abc" })).toBe(true);
    // An explicit null is the legacy shape, not a café order.
    expect(isCafeCmsOrder({ ...legacy, tableToken: null, serviceMode: null })).toBe(false);
  });
});
