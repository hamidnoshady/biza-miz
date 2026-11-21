import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCreditPackages } from "@/lib/wallet-service";
import { listBillingPlans, listPlanFeatures } from "@/lib/billing-plans-service";
import { readCommercialSettings } from "@/lib/billing/runtime";
import { applyTaxAndRounding } from "@/lib/billing/rating/engine";
import { parseSafeIntInput } from "@/lib/platform-money";
import {
  isPlanTermMonths,
  quoteDiscountSource,
  type QuoteLine,
} from "@/lib/billing/quote/plan-quote";
import { createPlanCheckoutQuote } from "@/lib/billing/quote/checkout-quote";
import { readPlanTransitionQuote } from "@/lib/billing/resolver/transition-service";

/**
 * Tenant-authorized quote endpoint using the SAME commercial calculator
 * and immutable price/terms snapshot used to create payment (#928 P1).
 *
 * POST { kind: "plan", planKey } | { kind: "topup", packageId } | { kind: "topup", amountRial } | { kind: "addon", featureKey }
 * Returns subtotal, tax, discount, bonus, total, recurring amount, wallet requirements.
 */
/** A human-readable line for the tenant's own itemisation (Shamsi dates only). */
function quoteLineDescription(line: QuoteLine, planName: string): string {
  switch (line.kind) {
    case "plan_base":
      return `اشتراک پلن ${planName} — ${line.quantity} ماه`;
    case "recurring_addon":
      return `افزونهٔ ماهانه: ${line.key} — ${line.quantity} ماه`;
    case "one_off_addon":
      return `افزونهٔ یک‌باره: ${line.key}`;
    case "term_discount":
      return "تخفیف دورهٔ پیش‌پرداخت";
    case "coupon_discount":
      return `تخفیف کد ${line.key.replace(/^coupon:/, "")}`;
    case "tax":
      return "مالیات";
  }
}

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

      // ESH-193: the tenant quote is the SAME document the payment boundary
      // settles. It is built by the canonical resolver, stored with its
      // integer inputs, and returned with a real quote id — the old endpoint
      // returned an object the payment route then re-priced differently.
      const termMonths = isPlanTermMonths(body.termMonths) ? body.termMonths : 1;
      const couponCode = typeof body.couponCode === "string" ? body.couponCode.trim() : "";
      const created = await createPlanCheckoutQuote({
        businessId: session.businessId,
        platformUserId: session.platformUserId ?? null,
        membershipId: session.sub,
        planKey,
        termMonths,
        couponCode,
      });
      if (!created.ok) return NextResponse.json({ error: created.error }, { status: 409 });
      const quote = created.quote;

      const baseGross = quote.lines.find((line) => line.kind === "plan_base")?.grossRial ?? 0;
      const addonsGross = quote.lines
        .filter((line) => line.kind === "recurring_addon" || line.kind === "one_off_addon")
        .reduce((sum, line) => sum + line.grossRial, 0);
      const displayLines = quote.lines.map((line) => ({
        kind: line.kind,
        description: quoteLineDescription(line, plan.name),
        quantity: line.quantity,
        unitAmountRial: line.unitAmountRial,
        amountRial: line.grossRial,
        discountRial: line.discountRial,
        netRial: line.netRial,
        priceVersion: line.priceVersion,
      }));

      return NextResponse.json({
        quoteId: created.quoteId,
        kind: "plan" as const,
        planKey: plan.key,
        termMonths: quote.termMonths,
        subtotalRial: quote.totals.grossRial,
        discountRial: quote.totals.discountRial,
        couponDiscountRial: quote.totals.couponDiscountRial,
        discountSource: quoteDiscountSource(quote),
        stackingPolicy: quote.stackingPolicy,
        taxRial: quote.totals.taxRial,
        totalRial: quote.totals.netRial,
        lines: displayLines,
        period: quote.period,
        issuedAt: quote.issuedAt,
        expiresAt: quote.expiresAt,
        rounding,
        taxRateBps,
        quotedAt: quote.issuedAt,
        breakdown: {
          baseRial: baseGross,
          addonsRial: addonsGross,
          subtotalRial: quote.totals.grossRial,
          discountRial: quote.totals.discountRial + quote.totals.couponDiscountRial,
          taxRial: quote.totals.taxRial,
          totalRial: quote.totals.netRial,
          futureRecurringRial: quote.totals.netRial,
        },
        display: {
          totalToman: Math.floor(quote.totals.netRial / 10),
          totalRial: quote.totals.netRial,
        },
        walletRequired: false,
        gatewayAllowed: true,
        note: quote.totals.netRial === 0 ? "رایگان — نیازی به پرداخت نیست" : undefined,
      });
    }

    if (kind === "plan_transition") {
      // Read-only: the calculator's answer for an upgrade/downgrade, with the
      // paid period, credit basis and configured policy made explicit. It
      // moves no money; charging remains a release-gated decision.
      const planKey = String(body.planKey ?? "");
      if (!planKey) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
      const transition = await readPlanTransitionQuote({
        businessId: session.businessId,
        targetPlanKey: planKey,
      });
      return NextResponse.json(transition, { status: transition.ok ? 200 : 409 });
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
