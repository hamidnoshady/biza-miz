import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  countPayments,
  createPayment,
  getPaymentConfig,
  listCreditPackages,
  listPayments,
  startPayment,
} from "@/lib/wallet-service";
import { listBillingPlans, listPlanFeatures } from "@/lib/billing-plans-service";
import { readCommercialSettings } from "@/lib/billing/runtime";
import { isPlanTermMonths, type PlanQuote } from "@/lib/billing/quote/plan-quote";
import { createPlanCheckoutQuote } from "@/lib/billing/quote/checkout-quote";
import { assertQuotePayable, consumeQuote, loadQuote } from "@/lib/billing/quote/quote-store";
import { applyTaxAndRounding } from "@/lib/billing/rating/engine";
import { parseSafeIntInput } from "@/lib/platform-money";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * The business's own payments (top-ups and purchases), newest first.
 */
export const GET = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") as string | null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const [payments, total, config] = await Promise.all([
    listPayments({ businessId: session.businessId, limit, offset, status: status as never ?? undefined }),
    countPayments({ businessId: session.businessId, status: status as never ?? undefined }),
    getPaymentConfig(),
  ]);
  // Issue #902 §0 — a tenant screen needs to know *how* a top-up is taken, not
  // which company takes it. `gateway` used to be returned raw and the billing
  // page compared it to a supplier's name; `paymentMode` is the same decision in
  // first-party words, and the supplier's name never leaves the platform.
  return NextResponse.json({
    payments,
    total,
    paymentMode: config.gateway === "manual" ? "manual" : "online",
  });
});

/**
 * Create + start a payment.
 *
 * Body:
 *  { kind: "topup", packageId }                      → credit package top-up
 *  { kind: "topup", amountRial }                     → custom top-up (credit == base amount)
 *  { kind: "plan", planKey }                         → plan monthly fee + recurring add-ons + tax
 *  { kind: "addon", featureKey }                     → one-off feature purchase + tax
 *
 * Returns { redirectUrl } to send the browser to the gateway, or null for the
 * manual gateway (payment waits for admin approval).
 */
export const POST = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = String(body.kind ?? "topup");
  // Optional idempotency & quote validation (P0/P1: prevent double-charge, stale price)
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : null;
  const expectedAmountRial = body.expectedAmountRial != null ? Number(body.expectedAmountRial) : null;
  const quoteId = typeof body.quoteId === "string" ? body.quoteId : null;
  let minTopUpRial = 100_000;
  try {
    const commercial = await readCommercialSettings();
    const taxRateBps = Number(commercial.tax_rate_bps ?? 0);
    const rounding: "ceil" | "floor" = commercial.rounding === "floor" ? "floor" : "ceil";
    minTopUpRial = Math.max(0, Number(commercial.minimum_top_up_rial ?? 100_000));

    let payment: { id: string; amountRial: number };

    if (kind === "topup") {
      const packages = await listCreditPackages(true);
      const pkg = body.packageId ? packages.find((p) => p.id === body.packageId) : undefined;
      if (pkg) {
        const quoted = applyTaxAndRounding({
          subtotalRial: pkg.priceRial,
          taxRateBps,
          rounding,
        });
        if (expectedAmountRial != null && expectedAmountRial !== quoted.totalRial) {
          return NextResponse.json({ error: "stale_quote", expected: expectedAmountRial, actual: quoted.totalRial }, { status: 409 });
        }
        payment = await createPayment({
          businessId: session.businessId,
          purpose: "top_up",
          amountRial: quoted.totalRial,
          creditRial: pkg.creditRial,
          packageId: pkg.id,
          description: `شارژ اعتبار: ${pkg.name}`,
          userId: session.sub,
          idempotencyKey: idempotencyKey ?? (quoteId ?? null),
          quoteSnapshot: { packageId: pkg.id, totalRial: quoted.totalRial, creditRial: pkg.creditRial },
        });
      } else {
        const baseAmount = parseSafeIntInput(body.amountRial, { min: 1 });
        if (baseAmount === null) {
          return NextResponse.json({ error: "bad_amount" }, { status: 400 });
        }
        if (minTopUpRial > 0 && baseAmount < minTopUpRial) {
          return NextResponse.json(
            { error: "below_minimum_top_up", minimumTopUpRial: minTopUpRial },
            { status: 400 },
          );
        }
        const quoted = applyTaxAndRounding({
          subtotalRial: baseAmount,
          taxRateBps,
          rounding,
        });
        if (expectedAmountRial != null && expectedAmountRial !== quoted.totalRial) {
          return NextResponse.json({ error: "stale_quote", expected: expectedAmountRial, actual: quoted.totalRial }, { status: 409 });
        }
        // Safe integer Rial conversion: prevent overflow via parseSafeIntInput already enforces max, but add upper bound
        if (baseAmount > 5_000_000_000) {
          return NextResponse.json({ error: "amount_too_large" }, { status: 400 });
        }
        payment = await createPayment({
          businessId: session.businessId,
          purpose: "top_up",
          amountRial: quoted.totalRial,
          creditRial: baseAmount,
          description: "شارژ اعتبار (مبلغ دلخواه)",
          userId: session.sub,
          idempotencyKey: idempotencyKey ?? (quoteId ?? null),
          quoteSnapshot: { amountRial: baseAmount, totalRial: quoted.totalRial },
        });
      }
    } else if (kind === "plan") {
      const plans = await listBillingPlans(true);
      const plan = plans.find((p) => p.key === body.planKey);
      if (!plan) {
        return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
      }
      // P0: prevent same-plan duplicate purchase without benefit. Check current subscription.
      const { getBusinessSubscription } = await import("@/lib/subscription-service");
      const currentSub = await getBusinessSubscription(session.businessId);
      const nowIso = new Date().toISOString();
      const isCarrying = currentSub && ["active","trialing","past_due"].includes(currentSub.status);
      const samePlanCarrying = currentSub?.planKey === plan.key && isCarrying && currentSub.currentPeriodEnd > nowIso;
      if (samePlanCarrying) {
        // Check for existing pending plan purchase to provide idempotency guidance
        const { query } = await import("@/lib/db");
        try {
          const { rows: dupRows } = await query<{ id: string }>(
            `SELECT id FROM billing_payments WHERE business_id = $1 AND plan_key = $2 AND purpose = 'plan_purchase' AND status IN ('pending','redirect') AND created_at > now() - interval '15 minutes' LIMIT 1`,
            [session.businessId, plan.key],
          );
          if (dupRows[0]) {
            return NextResponse.json({ error: "duplicate_pending_payment", paymentId: dupRows[0].id }, { status: 409 });
          }
        } catch {}
        // Allow extension but inform UI to use management action. We still permit
        // the purchase as "renew/extend" with explicit quote, but block naive double-buy
        // without quote confirmation: require quoteId or expectedAmount when same plan.
        if (!quoteId && expectedAmountRial == null) {
          return NextResponse.json({ error: "already_subscribed", planKey: plan.key, message: "شما همین پلن را دارید؛ برای تمدید از بخش مدیریت اشتراک اقدام کنید." }, { status: 409 });
        }
      }

      // ESH-193: a plan checkout settles a PERSISTED quote. When the caller
      // supplies one, it is authoritative and re-checked against live prices;
      // otherwise the server creates and stores the same canonical document,
      // so no legacy caller can pay a price the quote store never saw.
      let quote: PlanQuote;
      let effectiveQuoteId: string;
      const stored = quoteId ? await loadQuote({ businessId: session.businessId, quoteId }) : null;
      if (quoteId) {
        if (!stored) return NextResponse.json({ error: "quote_not_found" }, { status: 404 });
        if (stored.quote.planKey !== plan.key) {
          return NextResponse.json({ error: "quote_plan_mismatch" }, { status: 409 });
        }
        const payable = await assertQuotePayable({
          businessId: session.businessId,
          quoteId: stored.id,
        });
        if (!payable.ok) return NextResponse.json({ error: payable.error }, { status: 409 });
        quote = stored.quote;
        effectiveQuoteId = stored.id;
      } else {
        const created = await createPlanCheckoutQuote({
          businessId: session.businessId,
          platformUserId: session.platformUserId ?? null,
          membershipId: session.sub,
          planKey: plan.key,
          termMonths: isPlanTermMonths(body.termMonths) ? body.termMonths : 1,
          couponCode: typeof body.couponCode === "string" ? body.couponCode : "",
        });
        if (!created.ok) return NextResponse.json({ error: created.error }, { status: 409 });
        quote = created.quote;
        effectiveQuoteId = created.quoteId;
      }

      // Stale quote protection: if client supplied expected amount, ensure it matches the persisted quote
      if (expectedAmountRial != null && expectedAmountRial !== quote.totals.netRial) {
        return NextResponse.json(
          { error: "stale_quote", expected: expectedAmountRial, actual: quote.totals.netRial },
          { status: 409 },
        );
      }

      const payWithWallet = body.payWithWallet === true;
      payment = await createPayment({
        businessId: session.businessId,
        purpose: "plan_purchase",
        gateway: payWithWallet ? "wallet" : undefined,
        amountRial: quote.totals.netRial,
        creditRial: 0,
        planKey: plan.key,
        description: `اشتراک پلن «${plan.name}» — دورهٔ ${quote.termMonths} ماهه`,
        userId: session.sub,
        idempotencyKey: idempotencyKey ?? effectiveQuoteId,
        quoteId: effectiveQuoteId,
        termMonths: quote.termMonths,
        quoteSnapshot: {
          planKey: plan.key,
          quoteId: effectiveQuoteId,
          termMonths: quote.termMonths,
          stackingPolicy: quote.stackingPolicy,
          grossRial: quote.totals.grossRial,
          discountRial: quote.totals.discountRial,
          couponDiscountRial: quote.totals.couponDiscountRial,
          taxRial: quote.totals.taxRial,
          totalRial: quote.totals.netRial,
          period: quote.period,
          lines: quote.lines,
        },
      });

      if (payWithWallet) {
        // A previous attempt that failed (for example a shortfall) left this
        // quote's one payment row in `failed`; retry reuses it rather than
        // creating a second row the unique quote index would refuse.
        {
          const { query } = await import("@/lib/db");
          await query(
            `UPDATE billing_payments
                SET status = 'pending', fulfilment_status = 'pending', fulfilment_error = NULL
              WHERE id = $1 AND status = 'failed'`,
            [payment.id],
          );
        }
        // The balance is the payment method, so settlement is immediate. The
        // quote's net is debited inside `consumeQuote`, together with the quote
        // flip and the coupon redemption: a retry of the same quote is a
        // success and moves no money again.
        const consumed = await consumeQuote({
          businessId: session.businessId,
          quoteId: effectiveQuoteId,
          paymentId: payment.id,
          debitWallet: { note: `خرید اشتراک پلن «${plan.name}»` },
        });
        if (!consumed.ok) {
          const { query } = await import("@/lib/db");
          await query(
            `UPDATE billing_payments
                SET status = 'failed', fulfilment_status = 'failed',
                    fulfilment_error = $2, reviewed_at = now()
              WHERE id = $1 AND status = 'pending'`,
            [payment.id, consumed.error],
          );
          const status = consumed.error === "insufficient_funds" ? 402 : 409;
          return NextResponse.json(
            {
              error: consumed.error,
              requiredRial: consumed.requiredRial,
              balanceRial: consumed.balanceRial,
              quoteId: effectiveQuoteId,
            },
            { status },
          );
        }
        const { query } = await import("@/lib/db");
        await query(
          `UPDATE billing_payments
              SET status = 'verified', gateway_status = 'wallet', verified_at = now()
            WHERE id = $1 AND status = 'pending'`,
          [payment.id],
        );
        const { fulfilPurchasedPayment } = await import("@/lib/billing-service");
        await fulfilPurchasedPayment({
          id: payment.id,
          businessId: session.businessId,
          purpose: "plan_purchase",
          planKey: plan.key,
          featureKey: null,
        });
        return NextResponse.json({
          paymentId: payment.id,
          amountRial: quote.totals.netRial,
          quoteId: effectiveQuoteId,
          settled: true,
          redirectUrl: null,
          gateway: "wallet",
        });
      }
    } else if (kind === "addon") {
      const featureKey = String(body.featureKey ?? "");
      const { query } = await import("@/lib/db");
      const { rows: bizRows } = await query<{ plan: string }>(
        `SELECT plan FROM businesses WHERE id = $1`,
        [session.businessId],
      );
      const currentPlanKey = bizRows[0]?.plan ?? "free";
      const features = await listPlanFeatures(currentPlanKey);
      const feature = features.find((f) => f.featureKey === featureKey && f.pricingModel === "addon");
      if (!feature) {
        return NextResponse.json({ error: "addon_not_found" }, { status: 404 });
      }
      const quoted = applyTaxAndRounding({
        subtotalRial: feature.priceRial,
        taxRateBps,
        rounding,
      });
      if (expectedAmountRial != null && expectedAmountRial !== quoted.totalRial) {
        return NextResponse.json({ error: "stale_quote", expected: expectedAmountRial, actual: quoted.totalRial }, { status: 409 });
      }
      payment = await createPayment({
        businessId: session.businessId,
        purpose: "addon_purchase",
        amountRial: quoted.totalRial,
        creditRial: 0,
        featureKey: feature.featureKey,
        planKey: currentPlanKey,
        description: `خرید قابلیت «${feature.featureName ?? feature.featureKey}»`,
        userId: session.sub,
        idempotencyKey: idempotencyKey ?? (quoteId ?? null),
        quoteSnapshot: {
          featureKey: feature.featureKey,
          totalRial: quoted.totalRial,
          subtotalRial: quoted.subtotalRial,
          taxRial: quoted.taxRial,
        },
      });
    } else {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const started = await startPayment(payment.id);
    return NextResponse.json({
      paymentId: payment.id,
      amountRial: payment.amountRial,
      redirectUrl: started.redirectUrl,
      gateway: started.gateway,
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      const status = err.code === "below_minimum_top_up" || err.code === "bad_amount" ? 400 : 502;
      return NextResponse.json(
        { error: err.code, message: gatewayErrorMessage(err.code) },
        { status },
      );
    }
    if (err instanceof Error && err.message === "below_minimum_top_up") {
      return NextResponse.json({ error: "below_minimum_top_up", minimumTopUpRial: minTopUpRial }, { status: 400 });
    }
    throw err;
  }
});
