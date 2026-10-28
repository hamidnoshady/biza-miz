/**
 * Billing facade — the one function an important platform feature calls to
 * bill a use, and the purchase flow that turns a verified plan/addon payment
 * into an entitlement and a subscription.
 *
 * Keeping this seam narrow means feature code never reaches into the wallet
 * or plan catalogue directly: it asks `billFeatureUse(...)` and either
 * continues (charged or free) or catches `FeatureNotEntitledError` /
 * `WalletInsufficientFundsError` and shows the buy-credits prompt.
 */
import { getPool, query, withoutTenantScope } from "./db";
import { chargeFeatureUse, WalletInsufficientFundsError } from "./wallet-service";
import {
  grantEntitlement,
  listPlanFeatures,
  resolveFeatureAccess,
  type FeatureAccess,
} from "./billing-plans-service";
import { changeBusinessPlan } from "./subscription-service";

export { WalletInsufficientFundsError };

export class FeatureNotEntitledError extends Error {
  constructor(public featureKey: string) {
    super("feature_not_entitled");
  }
}

export interface FeatureUseCharge {
  /** False when the use was free (promo / zero price). */
  charged: boolean;
  priceRial: number;
  balanceRial: number;
  access: FeatureAccess;
}

/**
 * Bill one use of a metered feature.
 *
 * - Not entitled at all → FeatureNotEntitledError (UI routes to the plan page).
 * - Entitled but out of credits → WalletInsufficientFundsError (UI top-up prompt).
 * - Free promo / zero price → counted, not charged.
 * - Otherwise → wallet debited, ledger + usage counters updated.
 */
export async function billFeatureUse(input: {
  businessId: string;
  featureKey: string;
  note?: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FeatureUseCharge> {
  const access = await resolveFeatureAccess(input.businessId, input.featureKey);
  if (!access.entitled) {
    throw new FeatureNotEntitledError(input.featureKey);
  }
  // A per-use feature is metered — even free promo uses count toward a
  // free-for-N-uses limit. An unpriced/included function is not metered here.
  const metered = access.metered;
  const result = await chargeFeatureUse({
    businessId: input.businessId,
    featureKey: input.featureKey,
    priceRial: access.perUsePriceRial,
    note: input.note,
    userId: input.userId ?? null,
    metadata: { ...(input.metadata ?? {}), metered },
  });
  return {
    charged: result.charged,
    priceRial: access.perUsePriceRial,
    balanceRial: result.balanceRial,
    access,
  };
}

/**
 * Record the entitlement a verified purchase grants. Called after a payment
 * settles:
 *  - plan_purchase  → the subscription service owns the plan switch; here we
 *                     stamp the plan's entitled features as owned via plan.
 *  - addon_purchase → one feature owned outright with optional expiry.
 */
export async function fulfilPurchasedEntitlement(input: {
  businessId: string;
  featureKey: string;
  source: "addon" | "plan" | "promo";
  expiresAt?: string | null;
  freeUntil?: string | null;
  freeLimit?: number | null;
}): Promise<void> {
  await grantEntitlement({
    businessId: input.businessId,
    featureKey: input.featureKey,
    source: input.source,
    expiresAt: input.expiresAt ?? null,
    freeUntil: input.freeUntil ?? null,
    freeLimit: input.freeLimit ?? null,
  });
}

/**
 * After a verified plan purchase, move the business onto that plan through
 * the ONE subscription path: the subscription row is created/extended, the
 * plan's prices become the ones it is billed at, and auto-renew is enabled so
 * the renewal tick can attempt the next period from the wallet. Runs in
 * bypass scope: this is a platform-level change (called from the tenant's own
 * verified payment and from the admin manual-approval route alike).
 */
export async function activatePurchasedPlan(input: {
  businessId: string;
  planKey: string;
  source?: "purchase" | "admin";
  /** The payment being fulfilled — makes the activation apply once per payment. */
  paymentId?: string | null;
}): Promise<void> {
  await withoutTenantScope("plan_purchase", () =>
    changeBusinessPlan({
      businessId: input.businessId,
      planKey: input.planKey,
      source: input.source ?? "purchase",
      paymentId: input.paymentId ?? null,
    }),
  );
}

/**
 * Fulfil a settled plan/addon purchase — the ONE function the tenant's
 * gateway return and the super-admin's manual approval both call, so the two
 * paths can never drift into different activation logic again.
 *
 * Durable and idempotent: when `payment.id` is provided, tracks `fulfilment_status`
 * (`pending` -> `succeeded` | `failed`) on `billing_payments`. If activation
 * fails after payment settlement, `fulfilment_status` is marked `'failed'` so a
 * subsequent retry of `fulfilPurchasedPayment` or `reviewManualPayment` can
 * complete fulfilment without double-crediting the wallet.
 */
export async function fulfilPurchasedPayment(payment: {
  id?: string;
  businessId: string;
  purpose: string;
  planKey: string | null;
  featureKey: string | null;
}): Promise<void> {
  if (!payment.id) {
    await applyPurchasedPayment(payment);
    return;
  }

  // The status check below is a read followed by writes. The gateway callback,
  // the return page's verify call and a manual reconcile can all reach here for
  // one payment at the same moment, and each would pass the check and activate
  // the plan: because a same-plan purchase extends the period, one payment then
  // bought two months. A session advisory lock on a dedicated connection makes
  // the whole fulfilment a critical section per payment (it is released if the
  // process dies, because the connection closes), and the status is re-read
  // once the lock is held.
  const lockClient = await getPool().connect();
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
      `billing-fulfil:${payment.id}`,
    ]);
    try {
      const { rows } = await query<{ fulfilment_status: string }>(
        `SELECT fulfilment_status FROM billing_payments WHERE id = $1`,
        [payment.id],
      );
      if (rows[0]?.fulfilment_status === "succeeded") return;

      try {
        await applyPurchasedPayment(payment);
        await query(
          `UPDATE billing_payments
              SET fulfilment_status = 'succeeded',
                  fulfilled_at = COALESCE(fulfilled_at, now()),
                  fulfilment_error = NULL
            WHERE id = $1`,
          [payment.id],
        );
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        await query(
          `UPDATE billing_payments
              SET fulfilment_status = 'failed',
                  fulfilment_error = $2
            WHERE id = $1`,
          [payment.id, errMessage],
        ).catch(() => {});
        throw err;
      }

      // The customer has paid and the purchase is applied; a hiccup issuing the
      // invoice must not turn that into a failed fulfilment. It is resumable
      // and `backfillPurchaseInvoices` (run from the renewal tick) retries it.
      try {
        const { issuePurchaseInvoice } = await import("./purchase-invoice-service");
        await issuePurchaseInvoice(payment.id);
      } catch (err) {
        console.error("purchase invoice failed for payment:", payment.id, err);
      }
    } finally {
      await lockClient
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`billing-fulfil:${payment.id}`])
        .catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

async function applyPurchasedPayment(payment: {
  id?: string;
  businessId: string;
  purpose: string;
  planKey: string | null;
  featureKey: string | null;
}): Promise<void> {
  if (payment.purpose === "addon_purchase" && payment.featureKey) {
    await fulfilPurchasedEntitlement({
      businessId: payment.businessId,
      featureKey: payment.featureKey,
      source: "addon",
    });
  } else if (payment.purpose === "plan_purchase" && payment.planKey) {
    await activatePurchasedPlan({
      businessId: payment.businessId,
      planKey: payment.planKey,
      paymentId: payment.id ?? null,
    });
    const features = await listPlanFeatures(payment.planKey);
    for (const f of features) {
      if (f.pricingModel === "included" || f.pricingModel === "monthly") {
        await fulfilPurchasedEntitlement({
          businessId: payment.businessId,
          featureKey: f.featureKey,
          source: "plan",
          freeUntil: f.freeUntil,
          freeLimit: f.freeLimit,
        });
      }
    }
  }
}

/**
 * Super-admin manual review of a billing payment — the one implementation
 * behind both `/api/platform/billing/payments/[id]/review` and the unified
 * manual-review queue. Approval settles the payment (posting the wallet
 * credit exactly once) and fulfils what it purchased through the same path
 * an automatic gateway success uses; rejection marks it failed and moves no
 * money (never overwriting an already-verified payment). Returns the payment's
 * actual persisted status.
 */
export async function reviewManualPayment(input: {
  paymentId: string;
  action: "approve" | "reject";
  platformAdminId: string;
}): Promise<"verified" | "failed" | "cancelled"> {
  if (input.action !== "approve" && input.action !== "reject") {
    throw new Error("invalid_review_action");
  }
  const { getPaymentById, rejectPayment, settlePayment } = await import("./wallet-service");
  const { GatewayError } = await import("./payment-gateway");
  const payment = await getPaymentById(input.paymentId);
  if (!payment) throw new GatewayError("payment_not_found");

  if (input.action === "reject") {
    const updated = await rejectPayment(input.paymentId, { platformAdminId: input.platformAdminId });
    return updated.status as "verified" | "failed" | "cancelled";
  }

  if (payment.status !== "verified") {
    await settlePayment(input.paymentId, {
      gatewayRef: payment.gatewayRef ?? null,
      gatewayStatus: "manual_approved",
      platformAdminId: input.platformAdminId,
    });
  }

  const settled = await getPaymentById(input.paymentId);
  if (settled && settled.status === "verified" && settled.fulfilmentStatus !== "succeeded") {
    await fulfilPurchasedPayment({
      id: settled.id,
      businessId: settled.businessId,
      purpose: settled.purpose,
      planKey: settled.planKey,
      featureKey: settled.featureKey,
    });
  }

  const updated = await getPaymentById(input.paymentId);
  return (updated?.status ?? "pending") as "verified" | "failed" | "cancelled";
}
