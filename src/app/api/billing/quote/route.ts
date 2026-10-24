import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCreditPackages } from "@/lib/wallet-service";
import { listBillingPlans, listPlanFeatures } from "@/lib/billing-plans-service";
import { calculateSubscriptionTotal } from "@/lib/subscription-service";
import { readCommercialSettings } from "@/lib/billing/runtime";
import { applyTaxAndRounding } from "@/lib/billing/rating/engine";
import { parseSafeIntInput } from "@/lib/platform-money";

/**
 * Tenant-authorized quote endpoint using the SAME commercial calculator
 * and immutable price/terms snapshot used to create payment (#928 P1).
 *
 * POST { kind: "plan", planKey } | { kind: "topup", packageId } | { kind: "topup", amountRial } | { kind: "addon", featureKey }
 * Returns subtotal, tax, discount, bonus, total, recurring amount, wallet requirements.
 */
export const POST = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const kind = String(body.kind ?? "");
  try {
    const commercial = await readCommercialSettings();
    const taxRateBps = Number(commercial.tax_rate_bps ?? 0);
    const rounding: "ceil" | "floor" = commercial.rounding === "floor" ? "floor" : "ceil";
    const minTopUpRial = Math.max(0, Number(commercial.minimum_top_up_rial ?? 100_000));

    if (kind === "plan") {
      const planKey = String(body.planKey ?? "");
      if (!planKey) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
      const plans = await listBillingPlans(true);
      const plan = plans.find((p) => p.key === planKey);
      if (!plan) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
      const quote = await calculateSubscriptionTotal(session.businessId, { planKey });
      // Immutable snapshot that payment will reuse
      const snapshot = {
        kind: "plan" as const,
        planKey: plan.key,
        subtotalRial: quote.subtotalRial,
        taxRial: quote.taxRial,
        totalRial: quote.totalRial,
        discountRial: quote.discountRial,
        lines: quote.lines,
        rounding,
        taxRateBps,
        quotedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min validity
      };
      return NextResponse.json({
        quoteId: `${plan.key}:${quote.totalRial}:${Date.now()}`,
        ...snapshot,
        breakdown: {
          baseRial: quote.baseRial,
          addonsRial: quote.addonsRial,
          subtotalRial: quote.subtotalRial,
          discountRial: quote.discountRial,
          taxRial: quote.taxRial,
          totalRial: quote.totalRial,
          futureRecurringRial: quote.totalRial, // next renewal same amount
        },
        display: {
          totalToman: Math.floor(quote.totalRial / 10),
          totalRial: quote.totalRial,
        },
        walletRequired: false,
        gatewayAllowed: true,
        note: quote.totalRial === 0 ? "رایگان — نیازی به پرداخت نیست" : undefined,
      });
    }

    if (kind === "topup") {
      const pkgId = typeof body.packageId === "string" ? body.packageId : null;
      const packages = await listCreditPackages(true);
      if (pkgId) {
        const pkg = packages.find((p) => p.id === pkgId);
        if (!pkg) return NextResponse.json({ error: "package_not_found" }, { status: 404 });
        const quoted = applyTaxAndRounding({ subtotalRial: pkg.priceRial, taxRateBps, rounding });
        const snapshot = {
          kind: "topup_package" as const,
          packageId: pkg.id,
          subtotalRial: quoted.subtotalRial,
          taxRial: quoted.taxRial,
          totalRial: quoted.totalRial,
          creditRial: pkg.creditRial,
          bonusRial: Math.max(0, pkg.creditRial - pkg.priceRial),
          rounding,
          taxRateBps,
          quotedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
        return NextResponse.json({
          quoteId: `${pkg.id}:${quoted.totalRial}:${Date.now()}`,
          ...snapshot,
          breakdown: {
            priceRial: pkg.priceRial,
            creditRial: pkg.creditRial,
            bonusRial: Math.max(0, pkg.creditRial - pkg.priceRial),
            subtotalRial: quoted.subtotalRial,
            taxRial: quoted.taxRial,
            totalRial: quoted.totalRial,
          },
          display: { totalToman: Math.floor(quoted.totalRial / 10), totalRial: quoted.totalRial, creditToman: Math.floor(pkg.creditRial / 10) },
        });
      } else {
        const baseAmount = parseSafeIntInput(body.amountRial, { min: 1 });
        if (baseAmount === null) return NextResponse.json({ error: "bad_amount" }, { status: 400 });
        if (minTopUpRial > 0 && baseAmount < minTopUpRial) {
          return NextResponse.json({ error: "below_minimum_top_up", minimumTopUpRial: minTopUpRial }, { status: 400 });
        }
        if (baseAmount > 5_000_000_000) return NextResponse.json({ error: "amount_too_large" }, { status: 400 });
        const quoted = applyTaxAndRounding({ subtotalRial: baseAmount, taxRateBps, rounding });
        const snapshot = {
          kind: "topup_custom" as const,
          amountRial: baseAmount,
          subtotalRial: quoted.subtotalRial,
          taxRial: quoted.taxRial,
          totalRial: quoted.totalRial,
          creditRial: baseAmount,
          rounding,
          taxRateBps,
          minimumTopUpRial: minTopUpRial,
          quotedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
        return NextResponse.json({
          quoteId: `custom:${quoted.totalRial}:${Date.now()}`,
          ...snapshot,
          breakdown: {
            baseAmountRial: baseAmount,
            subtotalRial: quoted.subtotalRial,
            taxRial: quoted.taxRial,
            totalRial: quoted.totalRial,
            creditRial: baseAmount,
          },
          display: { totalToman: Math.floor(quoted.totalRial / 10), totalRial: quoted.totalRial },
        });
      }
    }

    if (kind === "addon") {
      const featureKey = String(body.featureKey ?? "");
      if (!featureKey) return NextResponse.json({ error: "addon_not_found" }, { status: 404 });
      const { query } = await import("@/lib/db");
      const { rows: bizRows } = await query<{ plan: string }>(`SELECT plan FROM businesses WHERE id = $1`, [session.businessId]);
      const currentPlanKey = bizRows[0]?.plan ?? "free";
      const features = await listPlanFeatures(currentPlanKey);
      const feature = features.find((f) => f.featureKey === featureKey && f.pricingModel === "addon");
      if (!feature) return NextResponse.json({ error: "addon_not_found" }, { status: 404 });
      const quoted = applyTaxAndRounding({ subtotalRial: feature.priceRial, taxRateBps, rounding });
      const snapshot = {
        kind: "addon" as const,
        featureKey,
        subtotalRial: quoted.subtotalRial,
        taxRial: quoted.taxRial,
        totalRial: quoted.totalRial,
        rounding,
        taxRateBps,
        quotedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
      return NextResponse.json({
        quoteId: `${featureKey}:${quoted.totalRial}:${Date.now()}`,
        ...snapshot,
        breakdown: {
          priceRial: feature.priceRial,
          subtotalRial: quoted.subtotalRial,
          taxRial: quoted.taxRial,
          totalRial: quoted.totalRial,
        },
        display: { totalToman: Math.floor(quoted.totalRial / 10), totalRial: quoted.totalRial },
      });
    }

    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  } catch (err) {
    throw err;
  }
});
