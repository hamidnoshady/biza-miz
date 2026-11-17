/**
 * ESH-148 (biza-miz#1306) — pure policy & monotonic state machine for syncing
 * POS café order fulfillment and payment/lifecycle states back to `eshobe-cms`.
 *
 * Zero database or network I/O here: every decision (axis selection, monotonic
 * state rank, aggregate fulfillment derivation, transition eligibility, Payload
 * PATCH shape, and retry/dead-letter classification) is deterministic and
 * unit-tested directly.
 */
import type { OrderItemStatus } from "../order-item-status";
import { CmsApiError, CmsNetworkError, type CmsOrderStatePatch } from "./client";
import type { CmsCafeFulfillmentState, CmsOrder } from "./types";

export const CMS_ORDER_FULFILLMENT_STATES = [
  "accepted",
  "rejected",
  "preparing",
  "ready",
  "served",
] as const;
export type CmsOrderOutboxFulfillmentState =
  (typeof CMS_ORDER_FULFILLMENT_STATES)[number];

export const CMS_ORDER_PAYMENT_STATES = [
  "paid",
  "cancelled",
  "refunded",
] as const;
export type CmsOrderOutboxPaymentState =
  (typeof CMS_ORDER_PAYMENT_STATES)[number];

export const CMS_ORDER_OUTBOX_STATES = [
  ...CMS_ORDER_FULFILLMENT_STATES,
  ...CMS_ORDER_PAYMENT_STATES,
] as const;
export type CmsOrderOutboxState = (typeof CMS_ORDER_OUTBOX_STATES)[number];

export type CmsOrderOutboxAxis = "fulfillment" | "payment";

export const CMS_ORDER_OUTBOX_STATUSES = [
  "pending",
  "processing",
  "sent",
  "failed",
  "dead",
  "superseded",
] as const;
export type CmsOrderOutboxStatus = (typeof CMS_ORDER_OUTBOX_STATUSES)[number];

export function isCmsOrderOutboxState(value: string): value is CmsOrderOutboxState {
  return (CMS_ORDER_OUTBOX_STATES as readonly string[]).includes(value);
}

export function axisForCmsOrderState(state: CmsOrderOutboxState): CmsOrderOutboxAxis {
  return (CMS_ORDER_FULFILLMENT_STATES as readonly string[]).includes(state)
    ? "fulfillment"
    : "payment";
}

/**
 * Monotonic version rank within each axis.
 *
 * Fulfillment progression is strictly forward:
 *   accepted (10) -> preparing (20) -> ready (30) -> served (40)
 *   or terminal rejected (100) from pending/accepted.
 *
 * Payment/lifecycle progression is strictly forward:
 *   paid (10) -> refunded (20) | cancelled (30).
 */
const STATE_VERSION: Record<CmsOrderOutboxState, number> = {
  accepted: 10,
  preparing: 20,
  ready: 30,
  served: 40,
  rejected: 100,
  paid: 10,
  refunded: 20,
  cancelled: 30,
};

export function versionForCmsOrderState(state: CmsOrderOutboxState): number {
  return STATE_VERSION[state];
}

export interface DeriveOrderFulfillmentInput {
  approvalState: "pending" | "accepted" | "rejected" | null;
  orderStatus: string;
  itemStatuses: readonly OrderItemStatus[];
}

/**
 * Derive the whole-order CMS fulfillment state from POS approval, order
 * status, and non-voided item kitchen states.
 *
 * - An unapproved order (`pending`) never exposes kitchen progress.
 * - A rejected order resolves to `rejected` only on approval decision.
 * - Voided orders are cancelled on the `payment` axis (`status = 'cancelled'`).
 * - Otherwise, active (non-voided) lines determine aggregate kitchen stage:
 *     all served            -> `served`
 *     all ready or served   -> `ready`
 *     any preparing/ready/served -> `preparing`
 *     otherwise (all sent)  -> `accepted`
 */
export function deriveOrderFulfillmentState(
  input: DeriveOrderFulfillmentInput,
): CmsOrderOutboxFulfillmentState | null {
  if (input.approvalState === "rejected") return "rejected";
  if (input.approvalState !== "accepted") return null;
  if (input.orderStatus === "voided") return null;

  const active = input.itemStatuses.filter((status) => status !== "voided");
  if (active.length === 0) return null;

  if (active.every((status) => status === "served")) return "served";
  if (active.every((status) => status === "ready" || status === "served")) {
    return "ready";
  }
  if (
    active.some(
      (status) =>
        status === "preparing" || status === "ready" || status === "served",
    )
  ) {
    return "preparing";
  }
  return "accepted";
}

export interface ExistingOutboxStateEntry {
  axis: CmsOrderOutboxAxis;
  state: CmsOrderOutboxState;
  stateVersion: number;
  status: CmsOrderOutboxStatus;
}

export type TransitionEligibility =
  | { allowed: true; axis: CmsOrderOutboxAxis; stateVersion: number }
  | { allowed: false; reason: string };

/**
 * Decide whether a candidate outbox transition may be queued given all prior
 * rows already recorded for the same `(cms_connection_id, cms_order_id)`.
 *
 * Enforces:
 * - No fulfillment progression or counter payment may resurrect a cancelled or
 *   rejected order (`rejected` orders *may* still be refunded if paid earlier).
 * - Neither axis may regress or re-emit an equal/older `state_version` (e.g.
 *   `preparing` after `ready`, or `paid` after `refunded`/`cancelled`).
 * - Once `refunded` has been recorded, no later `paid` or `cancelled` may
 *   overwrite it.
 */
export function canEnqueueOrderStateTransition(
  existing: readonly ExistingOutboxStateEntry[],
  nextState: CmsOrderOutboxState,
): TransitionEligibility {
  const axis = axisForCmsOrderState(nextState);
  const nextVersion = versionForCmsOrderState(nextState);

  const activeOrDelivered = existing.filter((row) => row.status !== "superseded");

  if (activeOrDelivered.some((row) => row.state === "cancelled")) {
    return { allowed: false, reason: "already_cancelled" };
  }

  if (
    activeOrDelivered.some((row) => row.state === "rejected") &&
    nextState !== "refunded" &&
    nextState !== "cancelled"
  ) {
    return { allowed: false, reason: "already_rejected" };
  }

  if (
    axis === "payment" &&
    activeOrDelivered.some((row) => row.state === "refunded")
  ) {
    return { allowed: false, reason: "already_refunded" };
  }

  let maxVersionOnAxis = 0;
  for (const row of existing) {
    if (row.axis === axis && row.stateVersion > maxVersionOnAxis) {
      maxVersionOnAxis = row.stateVersion;
    }
  }

  if (nextVersion <= maxVersionOnAxis) {
    return { allowed: false, reason: "stale_or_duplicate_transition" };
  }

  return { allowed: true, axis, stateVersion: nextVersion };
}

/**
 * Pre-send guard for the delivery worker: checks whether a row that was
 * already queued (e.g., an in-flight lease that timed out or a delayed retry)
 * has since been overtaken by a newer state on the same axis or cancelled /
 * rejected out from under it.
 */
export function isOutboxRowSupersededByExisting(
  candidate: ExistingOutboxStateEntry,
  siblings: readonly ExistingOutboxStateEntry[],
): boolean {
  for (const other of siblings) {
    if (other.status === "superseded") continue;
    if (
      other.axis === candidate.axis &&
      other.stateVersion > candidate.stateVersion
    ) {
      return true;
    }
    if (
      other.state === "cancelled" &&
      candidate.state !== "cancelled"
    ) {
      return true;
    }
    if (
      other.state === "rejected" &&
      candidate.state !== "rejected" &&
      candidate.state !== "refunded" &&
      candidate.state !== "cancelled"
    ) {
      return true;
    }
    if (
      other.state === "refunded" &&
      candidate.axis === "payment" &&
      candidate.state !== "refunded"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build the minimal `PATCH /api/orders/:id` payload accepted by `eshobe-cms`
 * (`restrictApiKeyOrderWrite.ts`). Fulfillment and payment stay cleanly split:
 * fulfillment updates never touch `status`, and payment/lifecycle updates
 * never touch `cafe.fulfillment`.
 */
export function buildCmsOrderPatchBody(
  state: CmsOrderOutboxState,
  occurredAtIso: string,
): CmsOrderStatePatch {
  if (axisForCmsOrderState(state) === "fulfillment") {
    return {
      cafe: {
        fulfillment: state as CmsCafeFulfillmentState,
        fulfillmentAt: occurredAtIso,
      },
    };
  }
  return {
    status: state as CmsOrder["status"],
  };
}

export interface CmsOrderStateErrorClassification {
  retryable: boolean;
  code: string;
  authFailure: boolean;
}

/**
 * Classify a CMS HTTP/network error without ever leaking API keys, Host
 * secrets, URLs, or arbitrary HTML/stack strings.
 */
export function classifyCmsOrderStateDeliveryError(
  error: unknown,
): CmsOrderStateErrorClassification {
  if (error instanceof CmsNetworkError) {
    const safeCode =
      error.message === "cms_timeout" || error.message === "cms_network_error"
        ? error.message
        : "cms_network_error";
    return { retryable: true, code: safeCode, authFailure: false };
  }

  if (error instanceof CmsApiError) {
    if (error.status === 401) {
      return { retryable: false, code: "unauthorized", authFailure: true };
    }
    if (error.status === 403) {
      return { retryable: false, code: "forbidden", authFailure: true };
    }
    if (error.status === 404) {
      return { retryable: false, code: "cms_order_not_found", authFailure: false };
    }
    if (error.status === 400 || error.status === 422) {
      return {
        retryable: false,
        code: `cms_validation_${error.status}`,
        authFailure: false,
      };
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return {
        retryable: true,
        code: `cms_http_${error.status}`,
        authFailure: false,
      };
    }
    return {
      retryable: false,
      code: `cms_http_${error.status}`,
      authFailure: false,
    };
  }

  if (error instanceof Error) {
    if (error.message === "no_eshobe_cms_connection") {
      return { retryable: false, code: "connection_not_active", authFailure: true };
    }
    if (/^[a-z0-9_:-]{1,64}$/.test(error.message)) {
      return { retryable: true, code: error.message, authFailure: false };
    }
  }

  return { retryable: true, code: "cms_delivery_failed", authFailure: false };
}
