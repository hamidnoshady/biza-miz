import { beforeEach, describe, expect, it, vi } from "vitest";
import { announceKitchenOrderReady } from "./kitchen-order-ready";

const { queryMock, coworkerMock, notifyMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  coworkerMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock("./db", () => ({ query: queryMock }));
vi.mock("./ai-coworker-events", () => ({ recordCoworkerEvent: coworkerMock }));
vi.mock("./kavenegar/lookup-triggers", () => ({ notifyOrderReady: notifyMock }));

const input = { businessId: "biz-1", locationId: "loc-1", orderId: "order-1" };

beforeEach(() => {
  vi.clearAllMocks();
  coworkerMock.mockResolvedValue(undefined);
  notifyMock.mockResolvedValue(undefined);
});

describe("announceKitchenOrderReady", () => {
  it("fires the coworker event and customer message once the order is fully ready", async () => {
    queryMock.mockResolvedValue({
      rows: [{ customer_id: "customer-1", item_statuses: ["ready", "served", "voided"] }],
    });

    await announceKitchenOrderReady(input);

    expect(coworkerMock).toHaveBeenCalledWith({
      businessId: "biz-1",
      locationId: "loc-1",
      kind: "order_ready",
      payload: { customerId: "customer-1", orderId: "order-1" },
      dedupeKey: "order-ready:order-1",
    });
    expect(notifyMock).toHaveBeenCalledWith(input);
  });

  it("does nothing while any non-voided line is still being prepared", async () => {
    queryMock.mockResolvedValue({
      rows: [{ customer_id: "customer-1", item_statuses: ["ready", "sent", "voided"] }],
    });

    await announceKitchenOrderReady(input);

    expect(coworkerMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not notify an anonymous order", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await announceKitchenOrderReady(input);
    expect(coworkerMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("still attempts the customer message when the coworker automation fails", async () => {
    queryMock.mockResolvedValue({
      rows: [{ customer_id: "customer-1", item_statuses: ["ready"] }],
    });
    coworkerMock.mockRejectedValue(new Error("automation down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await announceKitchenOrderReady(input);

    expect(notifyMock).toHaveBeenCalledWith(input);
  });
});
