import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  transitionKitchenItem,
  transitionKitchenTicketBatch,
} from "./kitchen-item-transition";

const {
  queryMock,
  enqueueMock,
  recordOrderStateMock,
  scheduleMock,
  archiveMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  enqueueMock: vi.fn(),
  recordOrderStateMock: vi.fn(),
  scheduleMock: vi.fn(),
  archiveMock: vi.fn(),
}));

vi.mock("./db", () => ({
  query: queryMock,
  withTenantTransaction: vi.fn(
    async (_businessId: string, operation: (client: { query: typeof queryMock }) => Promise<unknown>) =>
      operation({ query: queryMock }),
  ),
}));

vi.mock("./cms/cafe-order-state-delivery", () => ({ enqueueCafeKitchenState: enqueueMock }));
vi.mock("./order-state-sync", () => ({ recordOrderState: recordOrderStateMock }));
vi.mock("./kitchen-workflow", () => ({
  scheduleKitchenTicket: scheduleMock,
  archivePaidKitchenTicket: archiveMock,
}));

const input = {
  businessId: "biz-1",
  locationId: "loc-1",
  itemId: "item-1",
  to: "ready" as const,
  mayBumpKitchen: true,
  mayServe: false,
  actorUserId: "member-1",
};

const orderLock = { rows: [{ id: "order-1" }] } as never;

function line(id: string, status: string, name = id) {
  return { id, status, name_snapshot: name, quantity: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueueMock.mockResolvedValue(undefined);
  recordOrderStateMock.mockResolvedValue(undefined);
  scheduleMock.mockResolvedValue(undefined);
  archiveMock.mockResolvedValue(undefined);
});

describe("transitionKitchenItem", () => {
  it("locks the parent order before the line and CAS-updates the authorized transition", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "order-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "item-1", status: "preparing", order_id: "order-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "item-1" }] } as never);

    await expect(transitionKitchenItem(input)).resolves.toEqual({ kind: "updated", orderId: "order-1" });
    expect(String(queryMock.mock.calls[0][0])).toContain("FROM orders o");
    expect(String(queryMock.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(queryMock.mock.calls[1][0])).toContain("FROM order_items oi");
    expect(String(queryMock.mock.calls[1][0])).toContain("FOR UPDATE");
    expect(String(queryMock.mock.calls[2][0])).toContain("oi.status=$4");
    expect(queryMock.mock.calls[2][1]).toEqual(["item-1", "loc-1", "ready", "preparing"]);
  });

  it("returns the canonical status when another device wins the compare-and-set", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "order-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "item-1", status: "preparing", order_id: "order-1" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ status: "ready" }] } as never);

    await expect(transitionKitchenItem(input)).resolves.toEqual({ kind: "conflict", currentStatus: "ready" });
  });

  it("does not permit a state change without the matching capability", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "order-1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "item-1", status: "preparing", order_id: "order-1" }] } as never);
    await expect(transitionKitchenItem({ ...input, mayBumpKitchen: false })).resolves.toEqual({
      kind: "conflict",
      currentStatus: "preparing",
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe("transitionKitchenTicketBatch", () => {
  const batchInput = {
    businessId: "biz-1",
    locationId: "loc-1",
    orderId: "order-1",
    mayBumpKitchen: true,
    actorUserId: "member-1",
  };

  it("applies only the exact source statuses and reports every ineligible or conflicting line", async () => {
    queryMock
      .mockResolvedValueOnce(orderLock)
      .mockResolvedValueOnce({
        rows: [
          line("line-sent", "sent"),
          line("line-preparing", "preparing"),
          line("line-ready", "ready"),
          line("line-served", "served"),
          line("line-voided", "voided"),
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: "line-sent" }] } as never);

    const result = await transitionKitchenTicketBatch({ ...batchInput, to: "preparing" });

    expect(result.kind).toBe("processed");
    expect(result.summary).toEqual({
      total: 5,
      applied: 1,
      alreadyApplied: 1,
      conflict: 1,
      ineligible: 2,
      missing: 0,
    });
    expect(result.appliedItemIds).toEqual(["line-sent"]);
    expect(result.items.find((item) => item.itemId === "line-sent")).toMatchObject({
      outcome: "applied",
      currentStatus: "preparing",
    });
    expect(result.items.find((item) => item.itemId === "line-served")?.outcome).toBe("ineligible");
    expect(result.items.find((item) => item.itemId === "line-voided")?.outcome).toBe("ineligible");
    expect(result.items.find((item) => item.itemId === "line-ready")?.outcome).toBe("conflict");
    expect(String(queryMock.mock.calls[2][0])).toContain("AND oi.status=$5");
    expect(queryMock.mock.calls[2][1]).toEqual([
      "order-1",
      "loc-1",
      "preparing",
      ["line-sent"],
      "sent",
    ]);
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), "order-1");
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it("honours an explicit line subset and reports requested lines that are not on the ticket", async () => {
    queryMock
      .mockResolvedValueOnce(orderLock)
      .mockResolvedValueOnce({
        rows: [line("line-preparing", "preparing"), line("line-served", "served")],
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: "line-preparing" }] } as never);

    const result = await transitionKitchenTicketBatch({
      ...batchInput,
      to: "ready",
      itemIds: ["line-preparing", "line-served", "line-from-another-ticket"],
    });

    expect(result.summary).toEqual({
      total: 3,
      applied: 1,
      alreadyApplied: 0,
      conflict: 0,
      ineligible: 1,
      missing: 1,
    });
    expect(result.items.find((item) => item.itemId === "line-from-another-ticket")?.outcome).toBe("missing");
    expect(queryMock.mock.calls[2][1]).toEqual([
      "order-1",
      "loc-1",
      "ready",
      ["line-preparing"],
      "preparing",
    ]);
    expect(scheduleMock).toHaveBeenCalledWith(expect.anything(), "loc-1", "order-1");
    expect(archiveMock).toHaveBeenCalledWith(expect.anything(), "loc-1", "order-1");
  });

  it("authorizes the whole batch as forbidden before reading any row", async () => {
    const result = await transitionKitchenTicketBatch({
      ...batchInput,
      to: "preparing",
      mayBumpKitchen: false,
    });
    expect(result.kind).toBe("forbidden");
    expect(result.items).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("treats a repeated batch as already applied and does not write twice", async () => {
    queryMock
      .mockResolvedValueOnce(orderLock)
      .mockResolvedValueOnce({
        rows: [line("line-a", "ready"), line("line-b", "ready")],
      } as never);

    const result = await transitionKitchenTicketBatch({ ...batchInput, to: "ready" });

    expect(result.summary.alreadyApplied).toBe(2);
    expect(result.summary.applied).toBe(0);
    expect(result.appliedItemIds).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(recordOrderStateMock).not.toHaveBeenCalled();
  });

  it("returns the canonical status when the CAS loses between lock and write", async () => {
    queryMock
      .mockResolvedValueOnce(orderLock)
      .mockResolvedValueOnce({ rows: [line("line-a", "preparing")] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "line-a", status: "ready" }] } as never);

    const result = await transitionKitchenTicketBatch({ ...batchInput, to: "ready" });

    expect(result.summary.conflict).toBe(1);
    expect(result.summary.applied).toBe(0);
    expect(result.items[0]).toMatchObject({ outcome: "conflict", currentStatus: "ready" });
    expect(result.appliedItemIds).toEqual([]);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("records one order-state audit event for the whole batch, not one per line", async () => {
    queryMock
      .mockResolvedValueOnce(orderLock)
      .mockResolvedValueOnce({
        rows: [line("line-a", "sent"), line("line-b", "sent")],
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: "line-a" }, { id: "line-b" }] } as never);

    await transitionKitchenTicketBatch({
      ...batchInput,
      to: "preparing",
      syncActor: { userId: "member-1", role: "kitchen" },
    });

    expect(recordOrderStateMock).toHaveBeenCalledTimes(1);
    expect(recordOrderStateMock).toHaveBeenCalledWith(expect.anything(), {
      locationId: "loc-1",
      orderId: "order-1",
      actor: { userId: "member-1", role: "kitchen" },
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
