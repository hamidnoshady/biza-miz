/**
 * Phase 31 — the order-discount write, callable without a request.
 *
 * The PATCH /api/orders/[id] handler composes several mutations (note,
 * customer, table, void, discount) inside one transaction, so it keeps its own
 * body and shares this module's validation. `applyOrderDiscount` is the
 * standalone path an autopilot run uses: same lock, same recompute, same
 * broadcast, no HTTP and no session cookie.
 */
import { getPool } from "./db";
import { lockOpenOrder } from "./order-lock";
import { recomputeOrderTotals } from "./order-totals";
import { broadcast } from "./realtime";
import { discountPercentForControl } from "./order-controls";
import { enforceOrderControl, recordOrderAudit, type OrderActor } from "./order-control-service";
import { recordOrderState } from "./order-state-sync";
import type { DiscountInput, OrderTotals } from "./orders";

export interface RawDiscount {
  type?: "percent" | "amount" | null;
  value?: number;
}

/**
 * The single definition of a valid discount body, shared by the route's 400
 * check and by the unattended path, so the two can never disagree on what a
 * caller is allowed to send.
 */
export function normalizeDiscountInput(raw: RawDiscount): DiscountInput | null {
  const type = raw.type === "percent" || raw.type === "amount" ? raw.type : null;
  const value = Number(raw.value ?? 0);
  if (!type) return { type: null };
  if (!Number.isFinite(value) || value < 0 || (type === "percent" && value > 100)) return null;
  return { type, value };
}

export type ApplyOrderDiscountResult =
  | { ok: true; totals: OrderTotals; prior: { discountType: string | null; discountValue: string | null } }
  | { ok: false; error: string };

export async function applyOrderDiscount(input: {
  locationId: string;
  orderId: string;
  discount: DiscountInput;
  actor: OrderActor & { userId: string };
}): Promise<ApplyOrderDiscountResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, input.locationId, input.orderId);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return { ok: false, error: locked.error };
    }
    // Read before write, in the same transaction, so undo has the exact value
    // the order carried rather than whatever it holds by the time undo runs.
    const prior = {
      discountType: locked.order.discount_type ?? null,
      discountValue: locked.order.discount_value ?? null,
    };
    try {
      await enforceOrderControl(client, {
        actor: input.actor,
        locationId: input.locationId,
        orderId: input.orderId,
        action: "discount",
        discountPercent: discountPercentForControl({
          type: input.discount.type,
          value: input.discount.type === null ? 0 : input.discount.value,
          subtotal: locked.order.subtotal,
        }),
      });
    } catch (controlError) {
      await client.query("ROLLBACK");
      return { ok: false, error: controlError instanceof Error ? controlError.message : "order_control_failed" };
    }
    const totals = await recomputeOrderTotals(client, input.orderId, input.discount);
    await recordOrderAudit(client, {
      actor: input.actor,
      locationId: input.locationId,
      action: "order.discount_changed",
      entityType: "order",
      entityId: input.orderId,
      metadata: {
        previousDiscountType: prior.discountType,
        previousDiscountValue: prior.discountValue,
        discountType: input.discount.type,
        discountValue: input.discount.type === null ? 0 : input.discount.value,
        discountAmountRial: totals.discount,
        subtotalRial: totals.subtotal,
      },
    });
    await recordOrderState(client, { locationId: input.locationId, orderId: input.orderId, actor: input.actor });
    await client.query("COMMIT");
    broadcast(input.locationId, { type: "order.updated", orderId: input.orderId });
    return { ok: true, totals, prior };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
