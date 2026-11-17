import { describe, expect, it } from "vitest";
import {
  cmsOrderItemProductId,
  cmsOrderServiceMode,
  cmsOrderTableToken,
  isCafeCmsOrder,
} from "./cafe-order-intake-service";
import type { CmsOrder } from "./types";

function baseOrder(overrides: Partial<CmsOrder> = {}): CmsOrder {
  return {
    id: "ord-1",
    reference: "ORD-1001",
    status: "pending",
    total: 500_000,
    currency: "IRT",
    buyer: { name: "علی رضایی", phone: "09120000000", email: null, note: null },
    createdAt: "2026-11-14T12:00:00.000Z",
    updatedAt: "2026-11-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("cafe-order-intake-service wire shape helpers", () => {
  it("recognizes flat café test/webhook payloads", () => {
    const order = baseOrder({
      serviceMode: "dine_in",
      tableToken: "tqr_test_token",
      items: [{ productId: "prod-1", quantity: 2, modifierIds: ["mod-1"] }],
    });
    expect(isCafeCmsOrder(order)).toBe(true);
    expect(cmsOrderServiceMode(order)).toBe("dine_in");
    expect(cmsOrderTableToken(order)).toBe("tqr_test_token");
    expect(cmsOrderItemProductId(order.items![0])).toBe("prod-1");
  });

  it("recognizes nested eshobe-cms Payload `cafe` + populated product shapes", () => {
    const order = baseOrder({
      cafe: {
        serviceMode: "takeaway",
        tableToken: null,
        paymentChoice: "counter",
        fulfillment: "awaiting_approval",
      },
      items: [{ product: { id: "prod-2", title: "اسپرسو" }, quantity: 1 }],
    });
    expect(isCafeCmsOrder(order)).toBe(true);
    expect(cmsOrderServiceMode(order)).toBe("takeaway");
    expect(cmsOrderTableToken(order)).toBeNull();
    expect(cmsOrderItemProductId(order.items![0])).toBe("prod-2");
  });

  it("treats single-product store orders without items or cafe metadata as non-café", () => {
    const storeOrder = baseOrder({
      status: "paid",
      product: "prod-99",
      productTitle: "کیف چرم",
      quantity: 1,
    });
    expect(isCafeCmsOrder(storeOrder)).toBe(false);
  });
});
