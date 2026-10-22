import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "./db";
import { transitionKitchenItem } from "./kitchen-item-transition";

vi.mock("./db", () => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(async (_businessId: string, operation: () => Promise<unknown>) => operation()),
}));

const queryMock = vi.mocked(query);
const input = {
  businessId: "biz-1",
  locationId: "loc-1",
  itemId: "item-1",
  to: "ready" as const,
  mayBumpKitchen: true,
  mayServe: false,
  actorUserId: "member-1",
};

beforeEach(() => vi.clearAllMocks());

describe("transitionKitchenItem", () => {
  it("locks the order and CAS-updates the authorized transition", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "item-1", status: "preparing", order_id: "order-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "item-1" }] } as never);

    await expect(transitionKitchenItem(input)).resolves.toEqual({ kind: "updated", orderId: "order-1" });
    expect(String(queryMock.mock.calls[0][0])).toContain("FOR UPDATE OF o,oi");
    expect(String(queryMock.mock.calls[1][0])).toContain("oi.status=$4");
    expect(queryMock.mock.calls[1][1]).toEqual(["item-1", "loc-1", "ready", "preparing"]);
  });

  it("returns the canonical status when another device wins the compare-and-set", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "item-1", status: "preparing", order_id: "order-1" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ status: "ready" }] } as never);

    await expect(transitionKitchenItem(input)).resolves.toEqual({ kind: "conflict", currentStatus: "ready" });
  });

  it("does not permit a state change without the matching capability", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "item-1", status: "preparing", order_id: "order-1" }] } as never);
    await expect(transitionKitchenItem({ ...input, mayBumpKitchen: false })).resolves.toEqual({
      kind: "conflict",
      currentStatus: "preparing",
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
