import { describe, expect, it } from "vitest";
import { CmsApiError, CmsNetworkError } from "./client";
import {
  CMS_ORDER_FULFILLMENT_STATES,
  CMS_ORDER_PAYMENT_STATES,
  axisForCmsOrderState,
  buildCmsOrderPatchBody,
  canEnqueueOrderStateTransition,
  classifyCmsOrderStateDeliveryError,
  deriveOrderFulfillmentState,
  isOutboxRowSupersededByExisting,
  versionForCmsOrderState,
  type ExistingOutboxStateEntry,
} from "./order-state-sync-policy";

describe("order-state-sync-policy", () => {
  it("maps fulfillment and payment states onto two independent monotonic axes", () => {
    expect(CMS_ORDER_FULFILLMENT_STATES).toEqual([
      "accepted",
      "rejected",
      "preparing",
      "ready",
      "served",
    ]);
    expect(CMS_ORDER_PAYMENT_STATES).toEqual(["paid", "cancelled", "refunded"]);

    expect(axisForCmsOrderState("accepted")).toBe("fulfillment");
    expect(axisForCmsOrderState("rejected")).toBe("fulfillment");
    expect(axisForCmsOrderState("paid")).toBe("payment");
    expect(axisForCmsOrderState("cancelled")).toBe("payment");
    expect(axisForCmsOrderState("refunded")).toBe("payment");

    expect(versionForCmsOrderState("accepted")).toBeLessThan(versionForCmsOrderState("preparing"));
    expect(versionForCmsOrderState("preparing")).toBeLessThan(versionForCmsOrderState("ready"));
    expect(versionForCmsOrderState("ready")).toBeLessThan(versionForCmsOrderState("served"));
    expect(versionForCmsOrderState("served")).toBeLessThan(versionForCmsOrderState("rejected"));

    expect(versionForCmsOrderState("paid")).toBeLessThan(versionForCmsOrderState("refunded"));
    expect(versionForCmsOrderState("refunded")).toBeLessThan(versionForCmsOrderState("cancelled"));
  });

  it("derives order-level fulfillment monotonically across active lines and ignores voided lines", () => {
    expect(
      deriveOrderFulfillmentState({
        approvalState: "pending",
        orderStatus: "open",
        itemStatuses: ["pending"],
      }),
    ).toBeNull();
    expect(
      deriveOrderFulfillmentState({
        approvalState: "rejected",
        orderStatus: "open",
        itemStatuses: ["pending"],
      }),
    ).toBe("rejected");
    expect(
      deriveOrderFulfillmentState({
        approvalState: "accepted",
        orderStatus: "voided",
        itemStatuses: ["sent"],
      }),
    ).toBeNull();
    expect(
      deriveOrderFulfillmentState({
        approvalState: "accepted",
        orderStatus: "open",
        itemStatuses: ["voided"],
      }),
    ).toBeNull();
    expect(
      deriveOrderFulfillmentState({
        approvalState: "accepted",
        orderStatus: "open",
        itemStatuses: ["sent", "preparing"],
      }),
    ).toBe("preparing");
    expect(
      deriveOrderFulfillmentState({
        approvalState: "accepted",
        orderStatus: "open",
        itemStatuses: ["preparing", "ready"],
      }),
    ).toBe("preparing");
    expect(
      deriveOrderFulfillmentState({
        approvalState: "accepted",
        orderStatus: "open",
        itemStatuses: ["ready", "served"],
      }),
    ).toBe("ready");
    expect(
      deriveOrderFulfillmentState({
        approvalState: "accepted",
        orderStatus: "open",
        itemStatuses: ["served", "voided"],
      }),
    ).toBe("served");
    // Voiding a lagging `sent` item advances the order to `ready`.
    expect(
      deriveOrderFulfillmentState({
        approvalState: "accepted",
        orderStatus: "open",
        itemStatuses: ["ready", "voided"],
      }),
    ).toBe("ready");
  });

  it("blocks lower/duplicate transitions and blocks counter payment after rejection while allowing refund/cancel", () => {
    const preparingRow: ExistingOutboxStateEntry = {
      axis: "fulfillment",
      state: "preparing",
      stateVersion: versionForCmsOrderState("preparing"),
      status: "sent",
    };
    expect(canEnqueueOrderStateTransition([preparingRow], "accepted")).toEqual({
      allowed: false,
      reason: "stale_or_duplicate_transition",
    });
    expect(canEnqueueOrderStateTransition([preparingRow], "preparing")).toEqual({
      allowed: false,
      reason: "stale_or_duplicate_transition",
    });
    expect(canEnqueueOrderStateTransition([preparingRow], "ready")).toEqual({
      allowed: true,
      axis: "fulfillment",
      stateVersion: versionForCmsOrderState("ready"),
    });

    const rejectedRow: ExistingOutboxStateEntry = {
      axis: "fulfillment",
      state: "rejected",
      stateVersion: versionForCmsOrderState("rejected"),
      status: "pending",
    };
    expect(canEnqueueOrderStateTransition([rejectedRow], "preparing")).toEqual({
      allowed: false,
      reason: "already_rejected",
    });
    expect(canEnqueueOrderStateTransition([rejectedRow], "paid")).toEqual({
      allowed: false,
      reason: "already_rejected",
    });
    expect(canEnqueueOrderStateTransition([rejectedRow], "refunded")).toEqual({
      allowed: true,
      axis: "payment",
      stateVersion: versionForCmsOrderState("refunded"),
    });
    expect(canEnqueueOrderStateTransition([rejectedRow], "cancelled")).toEqual({
      allowed: true,
      axis: "payment",
      stateVersion: versionForCmsOrderState("cancelled"),
    });

    const cancelledRow: ExistingOutboxStateEntry = {
      axis: "payment",
      state: "cancelled",
      stateVersion: versionForCmsOrderState("cancelled"),
      status: "sent",
    };
    expect(canEnqueueOrderStateTransition([cancelledRow], "ready")).toEqual({
      allowed: false,
      reason: "already_cancelled",
    });

    const refundedRow: ExistingOutboxStateEntry = {
      axis: "payment",
      state: "refunded",
      stateVersion: versionForCmsOrderState("refunded"),
      status: "sent",
    };
    expect(canEnqueueOrderStateTransition([refundedRow], "cancelled")).toEqual({
      allowed: false,
      reason: "already_refunded",
    });
  });

  it("detects superseded outbox rows before delayed retries send stale state", () => {
    const accepted: ExistingOutboxStateEntry = {
      axis: "fulfillment",
      state: "accepted",
      stateVersion: versionForCmsOrderState("accepted"),
      status: "failed",
    };
    const ready: ExistingOutboxStateEntry = {
      axis: "fulfillment",
      state: "ready",
      stateVersion: versionForCmsOrderState("ready"),
      status: "pending",
    };
    const cancelled: ExistingOutboxStateEntry = {
      axis: "payment",
      state: "cancelled",
      stateVersion: versionForCmsOrderState("cancelled"),
      status: "pending",
    };

    expect(isOutboxRowSupersededByExisting(accepted, [ready])).toBe(true);
    expect(isOutboxRowSupersededByExisting(ready, [cancelled])).toBe(true);
    expect(isOutboxRowSupersededByExisting(ready, [accepted])).toBe(false);
  });

  it("formats Payload wire PATCH bodies cleanly split by axis", () => {
    expect(buildCmsOrderPatchBody("accepted", "2026-11-14T10:00:00.000Z")).toEqual({
      cafe: {
        fulfillment: "accepted",
        fulfillmentAt: "2026-11-14T10:00:00.000Z",
      },
    });
    expect(buildCmsOrderPatchBody("paid", "2026-11-14T10:05:00.000Z")).toEqual({
      status: "paid",
    });
    expect(buildCmsOrderPatchBody("cancelled", "2026-11-14T10:10:00.000Z")).toEqual({
      status: "cancelled",
    });
  });

  it("classifies HTTP and network failures without exposing secrets or URLs", () => {
    expect(
      classifyCmsOrderStateDeliveryError(
        new CmsNetworkError("cms_timeout", "/api/orders/1"),
      ),
    ).toEqual({
      retryable: true,
      code: "cms_timeout",
      authFailure: false,
    });
    expect(
      classifyCmsOrderStateDeliveryError(
        new CmsApiError(400, "/api/orders/1", { message: "invalid" }),
      ),
    ).toEqual({
      retryable: false,
      code: "cms_validation_400",
      authFailure: false,
    });
    expect(
      classifyCmsOrderStateDeliveryError(
        new CmsApiError(401, "/api/orders/1", { message: "bad key" }),
      ),
    ).toEqual({
      retryable: false,
      code: "unauthorized",
      authFailure: true,
    });
    expect(
      classifyCmsOrderStateDeliveryError(
        new CmsApiError(403, "/api/orders/1", { message: "forbidden" }),
      ),
    ).toEqual({
      retryable: false,
      code: "forbidden",
      authFailure: true,
    });
    expect(
      classifyCmsOrderStateDeliveryError(
        new CmsApiError(404, "/api/orders/1", { message: "missing" }),
      ),
    ).toEqual({
      retryable: false,
      code: "cms_order_not_found",
      authFailure: false,
    });
    expect(
      classifyCmsOrderStateDeliveryError(
        new CmsApiError(502, "/api/orders/1", { message: "bad gateway" }),
      ),
    ).toEqual({
      retryable: true,
      code: "cms_http_502",
      authFailure: false,
    });
  });
});
