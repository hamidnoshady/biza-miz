import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessSubscription, cancelBusinessSubscription, setAutoRenew, reactivateBusinessSubscription, SubscriptionError } from "@/lib/subscription-service";
import { getWallet } from "@/lib/wallet-service";
import { listBillingPlans, listEntitlements, listPlanFeatures } from "@/lib/billing-plans-service";
import { customerUsageSummary, getSpendPolicy } from "@/lib/billing/runtime";
import { calculateSubscriptionTotal } from "@/lib/subscription-service";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const businessId = session.businessId;
  const [subscription, wallet, plans, entitlements, usage, spendPolicy] = await Promise.all([
    getBusinessSubscription(businessId),
    getWallet(businessId),
    listBillingPlans(true),
    listEntitlements(businessId),
    customerUsageSummary(businessId),
    getSpendPolicy(businessId),
  ]);

  // Feature matrix for current plan + operational limits
  let currentPlan = null as Awaited<ReturnType<typeof listBillingPlans>>[number] | null;
  let planFeatures: Awaited<ReturnType<typeof listPlanFeatures>> = [];
  let quote = null as Awaited<ReturnType<typeof calculateSubscriptionTotal>> | null;
  if (subscription) {
    currentPlan = plans.find((p) => p.key === subscription.planKey) ?? null;
    // If plan is retired but still assigned, fetch it directly
    if (!currentPlan) {
      const { getBillingPlan } = await import("@/lib/billing-plans-service");
      currentPlan = (await getBillingPlan(subscription.planKey)) ?? null;
    }
    try {
      planFeatures = await listPlanFeatures(subscription.planKey);
      quote = await calculateSubscriptionTotal(businessId);
    } catch {}
  }

  // Determine trial/free/active/retired/pending states for UI
  const nowIso = new Date().toISOString();
  const isTrial = subscription?.status === "trialing";
  const isPastDue = subscription?.status === "past_due";
  const isCancelled = subscription?.status === "cancelled";
  const isExpired = subscription?.status === "expired";
  const periodEnd = subscription?.currentPeriodEnd ?? null;
  const periodStart = subscription?.currentPeriodStart ?? null;
  const graceEnd = subscription?.graceEnd ?? null;
  const trialEnd = subscription?.trialEnd ?? null;

  // Permissions for UI: canManage vs canView
  const manageCheck = await requirePermission(PERMISSIONS.billingManage);
  const canManage = !manageCheck.error;

  return NextResponse.json({
    subscription: subscription
      ? {
          planKey: subscription.planKey,
          planName: currentPlan?.name ?? subscription.planKey,
          status: subscription.status,
          statusLabel: subscription.status === "trialing" ? "دورهٔ آزمایشی" : subscription.status === "active" ? "فعال" : subscription.status === "past_due" ? "عقب‌افتاده" : subscription.status === "cancelled" ? "لغو شده" : "منقضی",
          periodStart,
          periodEnd,
          trialEnd,
          trialStartedAt: subscription.trialStartedAt,
          graceEnd,
          autoRenew: subscription.autoRenew,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          cancelledAt: subscription.cancelledAt,
          isTrial,
          isPastDue,
          isCancelled,
          isExpired,
          nextChargeAt: isCancelled || isExpired ? null : periodEnd,
          renewalSource: "wallet" as const, // recurring renewals draw from wallet
          willRenew: subscription.autoRenew && !subscription.cancelAtPeriodEnd,
        }
      : null,
    currentPlan,
    plans,
    planFeatures,
    entitlements,
    operationalLimits: currentPlan
      ? {
          branches: currentPlan.branchLimit,
          members: currentPlan.memberLimit,
          monthlyOrders: currentPlan.monthlyOrderLimit,
          aiCredit: currentPlan.monthlyAiCreditRial,
        }
      : null,
    usage,
    spendPolicy,
    wallet: { balanceRial: wallet.balanceRial, netBalanceRial: (wallet as { netBalanceRial?: number }).netBalanceRial ?? wallet.balanceRial },
    quote,
    canManage,
    canView: true,
  });
});

export const POST = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  const businessId = session.businessId;

  try {
    switch (action) {
      case "cancel": {
        const atPeriodEnd = body.atPeriodEnd !== false;
        const sub = await cancelBusinessSubscription(businessId, { atPeriodEnd });
        return NextResponse.json({ subscription: sub });
      }
      case "reactivate": {
        const sub = await reactivateBusinessSubscription(businessId);
        return NextResponse.json({ subscription: sub });
      }
      case "set_auto_renew": {
        const autoRenew = body.autoRenew === true;
        const sub = await setAutoRenew(businessId, autoRenew);
        return NextResponse.json({ subscription: sub });
      }
      default:
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof SubscriptionError) {
      const status = err.code === "business_not_found" || err.code === "subscription_not_found" ? 404 : 400;
      return NextResponse.json({ error: err.code }, { status });
    }
    throw err;
  }
});
