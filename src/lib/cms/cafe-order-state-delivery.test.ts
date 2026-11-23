import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCafeOrderStateDeliveryTick } from "./cafe-order-state-delivery";
import { CmsApiError } from "./client";

const { query, cmsRequest, finishDelivery } = vi.hoisted(() => ({
  query: vi.fn(),
  cmsRequest: vi.fn(),
  finishDelivery: vi.fn(),
}));

vi.mock("../db", () => ({
  query,
  withTenant: (_businessId: string, run: () => unknown) => run(),
}));
vi.mock("../integrations/secrets", () => ({ resolveEncryptionKey: vi.fn() }));
vi.mock("./connections", () => ({ cmsConfigFromRow: vi.fn() }));
vi.mock("./observability", () => ({ logCmsCall: vi.fn() }));
vi.mock("./platform-control-service", () => ({ inPlatformScope: (run: () => unknown) => run() }));
vi.mock("./client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./client")>(),
  cmsRequest,
}));

const event = {
  id: "outbox",
  business_id: "business",
  cms_connection_id: "connection",
  cms_order_id: "order",
  site_id: "site",
  payment_amount: "170000",
  payment_currency: "IRT",
  payment_reference: "settlement-reference",
  lease_token: "lease",
  attempts: 1,
};

function claim(
  state: "counter_payment" | "counter_refund" | "accepted" | "rejected",
  extra: Record<string, unknown> = {},
) {
  query
    .mockResolvedValueOnce({ rows: [{ ...event, state, ...extra }] })
    .mockResolvedValueOnce({ rows: [{ site_id: "site" }] })
    .mockImplementationOnce(finishDelivery);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("CMS counter payment delivery", () => {
  it.each([
    ["counter_payment", "paid"],
    ["counter_refund", "refunded"],
  ] as const)("sends %s using the flat payment contract", async (outboxState, paymentState) => {
    claim(outboxState);
    cmsRequest.mockResolvedValueOnce({ ok: true, result: "ignored_stale" });

    await runCafeOrderStateDeliveryTick();

    expect(cmsRequest).toHaveBeenCalledWith(undefined, {
      path: "/api/site/cafe-orders/order/state",
      method: "PATCH",
      body: {
        kind: "payment",
        state: paymentState,
        amount: 170000,
        currency: "IRT",
        reference: "settlement-reference",
      },
    });
    expect(finishDelivery).toHaveBeenCalledWith(expect.any(String), [
      event.id, event.lease_token, null, false, expect.any(Number),
    ]);
  });

  it("dead-letters an amount or currency mismatch on the first attempt", async () => {
    claim("counter_refund");
    cmsRequest.mockRejectedValueOnce(new CmsApiError(409, "/state", { code: "amount_mismatch" }));

    await runCafeOrderStateDeliveryTick();

    expect(finishDelivery).toHaveBeenCalledWith(expect.any(String), [
      event.id, event.lease_token, "amount_mismatch", true, expect.any(Number),
    ]);
  });
});

describe("CMS café fulfillment delivery", () => {
  it("sends the staff member's reason with a rejection, trimmed", async () => {
    claim("rejected", { reason: "  نداریم  " });
    cmsRequest.mockResolvedValueOnce({ ok: true, result: "applied" });

    await runCafeOrderStateDeliveryTick();

    expect(cmsRequest).toHaveBeenCalledWith(undefined, {
      path: "/api/site/cafe-orders/order/state",
      method: "PATCH",
      body: { kind: "fulfillment", fulfillment: "rejected", reason: "نداریم" },
    });
  });

  it("never attaches a reason to a state that is not a rejection", async () => {
    claim("accepted", { reason: "نگه دار" });
    cmsRequest.mockResolvedValueOnce({ ok: true, result: "applied" });

    await runCafeOrderStateDeliveryTick();

    expect(cmsRequest).toHaveBeenCalledWith(undefined, {
      path: "/api/site/cafe-orders/order/state",
      method: "PATCH",
      body: { kind: "fulfillment", fulfillment: "accepted" },
    });
  });

  it("sends a rejection with no reason when the row has none", async () => {
    claim("rejected", { reason: null });
    cmsRequest.mockResolvedValueOnce({ ok: true, result: "applied" });

    await runCafeOrderStateDeliveryTick();

    expect(cmsRequest).toHaveBeenCalledWith(undefined, {
      path: "/api/site/cafe-orders/order/state",
      method: "PATCH",
      body: { kind: "fulfillment", fulfillment: "rejected" },
    });
  });
});
