/**
 * Server-side billing gate for metered ("per-use") platform functions.
 *
 * A route that performs an important, billable function calls `chargeForFeature`
 * with its feature key *before* doing the work. It resolves the business's plan
 * price + free-promo state and debits the wallet one use. Outcomes:
 *
 *  - free use (promo / zero price / feature not priced per-use) →
 *      `{ ok: true, charged: false }`, work proceeds, nothing billed.
 *  - entitled + sufficient credits → wallet debited, `{ ok: true, charged: true }`.
 *  - entitled but out of credits → `{ error: "insufficient_credits", response }`.
 *  - not entitled at all → `{ error: "feature_not_entitled", response }`.
 *
 * Usage:
 *   const gate = await chargeForFeature(session.businessId, "backup", {
 *     note: "پشتیبان‌گیری دستی",
 *   });
 *   if (!gate.ok) return gate.response;
 *
 * Entitlement (feature flags) is still enforced independently in
 * withTenantScope; this only handles the *price* of an entitled function.
 */
import { NextResponse } from "next/server";
import { billFeatureUse, previewFeatureUse } from "./billing-service";

export type BillingGateResult =
  | {
      ok: true;
      charged: boolean;
      balanceRial?: number;
      priceRial?: number;
    }
  | {
      ok: false;
      charged: false;
      /** Short-circuit 402/403 response the route should return. */
      response: NextResponse;
      balanceRial?: number;
      priceRial?: number;
      error: "insufficient_credits" | "feature_not_entitled";
    };

export type BillingPreflightResult =
  | {
      ok: true;
      /** True when settling after the work would debit the wallet. */
      willCharge: boolean;
      priceRial: number;
      balanceRial: number;
    }
  | {
      ok: false;
      charged: false;
      response: NextResponse;
      balanceRial?: number;
      priceRial?: number;
      error: "insufficient_credits" | "feature_not_entitled";
    };

/**
 * Check entitlement and affordability **without debiting anything**.
 *
 * Issue #903: a route whose work can fail must not buy a charge before it
 * starts. `/api/backup/run` uses this to refuse early (402/403, the same
 * responses `chargeForFeature` returns) and then settles with
 * `chargeForFeature` only after an artifact actually exists.
 */
export async function preflightFeatureUse(
  businessId: string,
  featureKey: string,
): Promise<BillingPreflightResult> {
  try {
    const preview = await previewFeatureUse({ businessId, featureKey });
    if (!preview.entitled) {
      return {
        ok: false,
        charged: false,
        error: "feature_not_entitled",
        priceRial: preview.priceRial,
        balanceRial: preview.balanceRial,
        response: NextResponse.json(
          {
            error: "feature_not_entitled",
            message: "این قابلیت برای پلن شما فعال نیست. از بخش «اعتبار و پرداخت‌ها» می‌توانید پلن یا افزونهٔ آن را تهیه کنید.",
            topUpUrl: "/settings/billing",
          },
          { status: 403 },
        ),
      };
    }
    const willCharge = preview.priceRial > 0;
    if (preview.priceRial > 0 && preview.balanceRial < preview.priceRial) {
      return {
        ok: false,
        charged: false,
        error: "insufficient_credits",
        balanceRial: preview.balanceRial,
        priceRial: preview.priceRial,
        response: NextResponse.json(
          {
            error: "insufficient_credits",
            message: "اعتبار حساب شما برای این عملیات کافی نیست. از بخش «اعتبار و پرداخت‌ها» حساب خود را شارژ کنید.",
            balanceRial: preview.balanceRial,
            requiredRial: preview.priceRial,
            topUpUrl: "/settings/billing",
          },
          { status: 402 },
        ),
      };
    }
    return {
      ok: true,
      willCharge,
      priceRial: preview.priceRial,
      balanceRial: preview.balanceRial,
    };
  } catch (err) {
    // An entitlement read that fails is not permission to run the work free.
    throw err;
  }
}

export async function chargeForFeature(
  businessId: string,
  featureKey: string,
  opts: { note?: string; userId?: string | null } = {},
): Promise<BillingGateResult> {
  try {
    const result = await billFeatureUse({
      businessId,
      featureKey,
      note: opts.note,
      userId: opts.userId ?? null,
    });
    return {
      ok: true as const,
      charged: result.charged,
      balanceRial: result.balanceRial,
      priceRial: result.priceRial,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "insufficient_credits") {
      const balance = (err as { balanceRial?: number }).balanceRial ?? 0;
      const required = (err as { requiredRial?: number }).requiredRial ?? 0;
      return {
        ok: false,
        charged: false,
        error: "insufficient_credits",
        balanceRial: balance,
        priceRial: required,
        response: NextResponse.json(
          {
            error: "insufficient_credits",
            message: "اعتبار حساب شما برای این عملیات کافی نیست. از بخش «اعتبار و پرداخت‌ها» حساب خود را شارژ کنید.",
            balanceRial: balance,
            requiredRial: required,
            topUpUrl: "/settings/billing",
          },
          { status: 402 },
        ),
      };
    }
    if (err instanceof Error && err.message === "feature_not_entitled") {
      return {
        ok: false,
        charged: false,
        error: "feature_not_entitled",
        response: NextResponse.json(
          {
            error: "feature_not_entitled",
            message: "این قابلیت برای پلن شما فعال نیست. از بخش «اعتبار و پرداخت‌ها» می‌توانید پلن یا افزونهٔ آن را تهیه کنید.",
            topUpUrl: "/settings/billing",
          },
          { status: 403 },
        ),
      };
    }
    // Anything else is a real error — rethrow so the route's error handling
    // treats it as a 500 rather than silently letting the work through free.
    throw err;
  }
}
