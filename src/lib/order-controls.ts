import type { Role } from "./auth";

export interface OrderControlPolicy {
  cashierDiscountLimitPercent: number;
  wholeOrderVoidRequiresManager: boolean;
  postKitchenChangeRequiresManager: boolean;
}

export const DEFAULT_ORDER_CONTROL_POLICY: OrderControlPolicy = {
  cashierDiscountLimitPercent: 10,
  wholeOrderVoidRequiresManager: true,
  postKitchenChangeRequiresManager: true,
};

export type ControlledOrderAction = "discount" | "order_void" | "item_quantity" | "item_change" | "item_void";

/** Convert either a percent or a Rial amount discount to its effective rate. */
export function discountPercentForControl(input: {
  type: "percent" | "amount" | null | undefined;
  value?: number | null;
  subtotal: string | number;
}): number {
  const value = Number(input.value ?? 0);
  if (input.type !== "amount") return input.type === "percent" && Number.isFinite(value) ? value : 0;
  const subtotal = Number(input.subtotal);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(subtotal) || subtotal <= 0) return 0;
  return (value / subtotal) * 100;
}

export interface OrderControlRequest {
  policy: OrderControlPolicy;
  actorRole: Role;
  action: ControlledOrderAction;
  discountPercent?: number;
  kitchenStarted: boolean;
}

export const MAX_ORDER_VOID_REASON_LENGTH = 500;

export function normalizeVoidReason(reason: unknown): string {
  const normalized = typeof reason === "string" ? reason.trim() : "";
  if (!normalized) throw Object.assign(new Error("void_reason_required"), { code: "void_reason_required", status: 400 });
  if (normalized.length > MAX_ORDER_VOID_REASON_LENGTH) {
    throw Object.assign(new Error("void_reason_too_long"), { code: "void_reason_too_long", status: 400 });
  }
  return normalized;
}

export function isManagerRole(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "manager";
}

export function assertOrderControl(request: OrderControlRequest): void {
  if (isManagerRole(request.actorRole)) return;
  const { policy, action } = request;
  // Appending a new line to an open order is deliberately not controlled
  // (issue #1123): it neither alters nor voids anything the kitchen already
  // holds, and only the new lines are dispatched. "Changed after the kitchen
  // started" means the lines that were sent, so a waiter adding a round to a
  // placed order is the ordinary flow, not an approval request.
  const needsManager =
    (action === "discount" &&
      Number(request.discountPercent ?? 0) > policy.cashierDiscountLimitPercent) ||
    (action === "order_void" && policy.wholeOrderVoidRequiresManager) ||
    (request.kitchenStarted &&
      policy.postKitchenChangeRequiresManager &&
      (action === "item_quantity" || action === "item_change" || action === "item_void"));
  if (needsManager) {
    throw Object.assign(new Error("manager_approval_required"), {
      code: "manager_approval_required",
      status: 403,
    });
  }
}

export function normalizeOrderControlPolicy(value: unknown): OrderControlPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<OrderControlPolicy>;
  const limit = input.cashierDiscountLimitPercent;
  if (
    typeof limit !== "number" || !Number.isFinite(limit) || limit < 0 || limit > 100 ||
    typeof input.wholeOrderVoidRequiresManager !== "boolean" ||
    typeof input.postKitchenChangeRequiresManager !== "boolean"
  ) return null;
  return {
    cashierDiscountLimitPercent: limit,
    wholeOrderVoidRequiresManager: input.wholeOrderVoidRequiresManager,
    postKitchenChangeRequiresManager: input.postKitchenChangeRequiresManager,
  };
}

export function parseOrderControlPolicy(value: unknown): OrderControlPolicy {
  if (!value || typeof value !== "object") return DEFAULT_ORDER_CONTROL_POLICY;
  const input = value as Partial<OrderControlPolicy>;
  const limit = Number(input.cashierDiscountLimitPercent);
  return {
    cashierDiscountLimitPercent:
      Number.isFinite(limit) && limit >= 0 && limit <= 100
        ? limit
        : DEFAULT_ORDER_CONTROL_POLICY.cashierDiscountLimitPercent,
    wholeOrderVoidRequiresManager:
      typeof input.wholeOrderVoidRequiresManager === "boolean"
        ? input.wholeOrderVoidRequiresManager
        : DEFAULT_ORDER_CONTROL_POLICY.wholeOrderVoidRequiresManager,
    postKitchenChangeRequiresManager:
      typeof input.postKitchenChangeRequiresManager === "boolean"
        ? input.postKitchenChangeRequiresManager
        : DEFAULT_ORDER_CONTROL_POLICY.postKitchenChangeRequiresManager,
  };
}
