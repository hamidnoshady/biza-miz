import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
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
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;
  const [payments, config] = await Promise.all([
    listPayments({ businessId: session.businessId, limit: 100 }),
    getPaymentConfig(),
  ]);
  return NextResponse.json({ payments, gateway: config.gateway });
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
  try {
    const commercial = await readCommercialSettings();
    const taxRateBps = Number(commercial.tax_rate_bps ?? 0);
    const rounding: "ceil" | "floor" = commercial.rounding === "floor" ? "floor" : "ceil";
    const minTopUpRial = Math.max(0, Number(commercial.minimum_top_up_rial ?? 100_000));

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
        payment = await createPayment({
          businessId: session.businessId,
          purpose: "top_up",
          amountRial: quoted.totalRial,
          creditRial: pkg.creditRial,
          packageId: pkg.id,
          description: `شارژ اعتبار: ${pkg.name}`,
          userId: session.sub,
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
        payment = await createPayment({
          businessId: session.businessId,
          purpose: "top_up",
          amountRial: quoted.totalRial,
          creditRial: baseAmount,
          description: "شارژ اعتبار (مبلغ دلخواه)",
          userId: session.sub,
        });
      }
    } else if (kind === "plan") {
      const plans = await listBillingPlans(true);
      const plan = plans.find((p) => p.key === body.planKey);
      if (!plan || plan.monthlyPriceRial == null) {
        return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
      }
      const quote = await calculateSubscriptionTotal(session.businessId, { planKey: plan.key });
      payment = await createPayment({
        businessId: session.businessId,
        purpose: "plan_purchase",
        amountRial: quote.totalRial,
        creditRial: 0,
        planKey: plan.key,
        description: `اشتراک پلن «${plan.name}»`,
        userId: session.sub,
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
      payment = await createPayment({
        businessId: session.businessId,
        purpose: "addon_purchase",
        amountRial: quoted.totalRial,
        creditRial: 0,
        featureKey: feature.featureKey,
        planKey: currentPlanKey,
        description: `خرید قابلیت «${feature.featureName ?? feature.featureKey}»`,
        userId: session.sub,
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
      return NextResponse.json(
        { error: err.code, message: gatewayErrorMessage(err.code) },
        { status: 502 },
      );
    }
    throw err;
  }
});
