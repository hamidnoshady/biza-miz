import { describe, expect, it } from "vitest";
import { orderIdFromEvent } from "./order-poll-service";

describe("orderIdFromEvent", () => {
  it("reads orderId from event data and poll id shape", () => {
    expect(orderIdFromEvent({ id: "x", data: { orderId: "ord-9" } })).toBe("ord-9");
    expect(orderIdFromEvent({ id: "order:paid:abc:2026-01-01T00:00:00.000Z", data: {} })).toBe("abc");
  });
});
