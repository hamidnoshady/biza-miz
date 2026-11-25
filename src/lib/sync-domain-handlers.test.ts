import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncEventDefinition } from "./sync-event-registry";

/*
 * Issue #1446 — a replayed payment that finds its order already settled must
 * be dead-lettered, not deferred forever. Mock only the money movement: the
 * classification contract under test is the sync handler's.
 */
const payments = vi.hoisted(() => ({
  completeOrderPayment: vi.fn(),
  completeSplitOrderPayment: vi.fn(),
}));

vi.mock("./payment-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./payment-service")>();
  return {
    ...actual,
    completeOrderPayment: payments.completeOrderPayment,
    completeSplitOrderPayment: payments.completeSplitOrderPayment,
  };
});

import {
  applySyncDomainHandler,
  SyncPayloadError,
  type SyncDomainContext,
} from "./sync-domain-handlers";
import { syncEventDefinition } from "./sync-event-registry";

const ORDER_ID = "0b3f5f4e-7c2a-4f8e-9a1d-2c6b8e0f4a11";

function notOpen() {
  return Object.assign(new Error("order_not_open"), {
    code: "order_not_open",
  });
}

function buildContext(
  status: string | undefined,
  definition: SyncEventDefinition,
  payload: Record<string, unknown>,
): { context: SyncDomainContext; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: status ? [{ status }] : [] });
  return {
    context: {
      client: { query } as never,
      businessId: "business-1",
      locationId: "location-1",
      actor: { userId: "user-1", role: "owner" },
      clientEventId: "event-1",
      payload,
      definition,
      occurredAt: "2026-10-20T16:54:12.103Z",
    },
    query,
  };
}

const paymentV1 = syncEventDefinition(
  "order.payment.completed",
  1,
) as SyncEventDefinition;
const paymentV2 = syncEventDefinition(
  "order.payment.completed",
  2,
) as SyncEventDefinition;

const payloadV1 = { orderId: ORDER_ID, method: "card" };
const payloadV2 = {
  orderId: ORDER_ID,
  tenders: [{ settlement: "card", amount: 3_700_000 }],
  entryDate: "2026-10-20",
};

describe("order.payment.completed replay against a settled order (issue #1446)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["completed", "voided"])(
    "turns a closed %s order into a terminal refusal instead of a dependency wait",
    async (status) => {
      payments.completeSplitOrderPayment.mockRejectedValueOnce(notOpen());
      const { context, query } = buildContext(status, paymentV2, payloadV2);

      await expect(applySyncDomainHandler(context)).rejects.toMatchObject({
        name: "SyncPayloadError",
        code: "order_already_settled",
      });
      expect(query).toHaveBeenCalledWith(
        "SELECT status FROM orders WHERE id=$1 AND location_id=$2",
        [ORDER_ID, "location-1"],
      );
    },
  );

  it("keeps a held order a deferrable dependency because it can be resumed", async () => {
    payments.completeSplitOrderPayment.mockRejectedValue(notOpen());
    const { context } = buildContext("held", paymentV2, payloadV2);

    const error = await applySyncDomainHandler(context).catch((thrown) => thrown);
    expect(error).toMatchObject({ code: "order_not_open" });
    expect(error).not.toBeInstanceOf(SyncPayloadError);
  });

  it("keeps a missing order a dependency — its create may still arrive", async () => {
    payments.completeSplitOrderPayment.mockRejectedValueOnce(notOpen());
    const { context } = buildContext(undefined, paymentV2, payloadV2);

    await expect(applySyncDomainHandler(context)).rejects.toMatchObject({
      code: "order_not_open",
    });
  });

  it("leaves every other refusal untouched", async () => {
    payments.completeSplitOrderPayment.mockRejectedValueOnce(
      Object.assign(new Error("customer_not_found"), {
        code: "customer_not_found",
      }),
    );
    const { context, query } = buildContext("completed", paymentV2, payloadV2);

    await expect(applySyncDomainHandler(context)).rejects.toMatchObject({
      code: "customer_not_found",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("applies the same rule to the legacy single-method handler", async () => {
    payments.completeOrderPayment.mockRejectedValueOnce(notOpen());
    const { context } = buildContext("completed", paymentV1, payloadV1);

    await expect(applySyncDomainHandler(context)).rejects.toMatchObject({
      name: "SyncPayloadError",
      code: "order_already_settled",
    });
  });
});
