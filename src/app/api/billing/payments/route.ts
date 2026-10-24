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
import { calculateSubscriptionTotal } from "@/lib/subscription-service";
import { readCommercialSettings } from "@/lib/billing/runtime";
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
  return NextResponse.json({ payments, total, gateway: config.gateway });
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
      if (!plan || plan.monthlyPriceRial == null) {
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
      const quote = await calculateSubscriptionTotal(session.businessId, { planKey: plan.key });
      // Stale quote protection: if client supplied expected amount, ensure it matches authoritative quote
      if (expectedAmountRial != null && expectedAmountRial !== quote.totalRial) {
        return NextResponse.json({ error: "stale_quote", expected: expectedAmountRial, actual: quote.totalRial, quote }, { status: 409 });
      }
      payment = await createPayment({
        businessId: session.businessId,
        purpose: "plan_purchase",
        amountRial: quote.totalRial,
        creditRial: 0,
        planKey: plan.key,
        description: `اشتراک پلن «${plan.name}»`,
        userId: session.sub,
        idempotencyKey: idempotencyKey ?? (quoteId ?? null),
        quoteSnapshot: { planKey: plan.key, totalRial: quote.totalRial, subtotalRial: quote.subtotalRial, taxRial: quote.taxRial, lines: quote.lines },
      });
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
        quoteSnapshot: { featureKey: feature.featureKey, totalRial: quoted.totalRial },
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
