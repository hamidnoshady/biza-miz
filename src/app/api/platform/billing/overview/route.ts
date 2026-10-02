import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { query } from "@/lib/db";
import { getPaymentConfig } from "@/lib/wallet-service";
import { getPlatformAiConfig } from "@/lib/ai-config";
import { resolveEffectivePlanAllowance, tehranMonthWindow } from "@/lib/ai-plan-allowance";
import { isSubscriptionCarryingPlan } from "@/lib/billing-plans-service";

/**
 * The Billing overview KPIs — one read-only round trip per source, answering
 * «how is the platform's money doing?» over the canonical Asia/Tehran billing
 * month window:
 *
 *   subscriptions (active / trialing / past_due / cancelled / expired),
 *   this month's billed amount vs collected revenue vs net usage spend,
 *   payments (succeeded by verified_at / failed / pending),
 *   outstanding invoices,
 *   wallet liabilities and AI debt,
 *   AI effective allowance + wallet usage this month,
 *   messaging net usage this month (gross minus refunds),
 *   media storage usage,
 *   gateway health.
 */
export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  let now = new Date();
  if (req?.url) {
    const nowParam = new URL(req.url).searchParams.get("now");
    if (nowParam) {
      const parsed = new Date(nowParam);
      if (!Number.isNaN(parsed.getTime())) now = parsed;
    }
  }

  const window = tehranMonthWindow(now);
  const nextWindow = tehranMonthWindow(window.nextStartUtc);
  const startIso = window.startUtc.toISOString();
  const nextStartIso = window.nextStartUtc.toISOString();
  const monthLabel = window.periodMonth;
  const monthStartDay = `${window.periodMonth}-01`;
  const nextMonthStartDay = `${nextWindow.periodMonth}-01`;

  const [subs, money, invoices, wallet, aiRows, aiWallet, messaging, media, gateway, aiConfig] =
    await Promise.all([
      query<{ status: string; count: string }>(
        `SELECT s.status, count(*)::text AS count
           FROM business_subscriptions s
           JOIN businesses b ON b.id = s.business_id
          WHERE b.ownership_kind = 'customer'
          GROUP BY s.status`,
      ),
      query<{
        invoiced_rial: string;
        unlinked_sub_debits_rial: string;
        collected_payments_rial: string;
        collected_invoice_payments_rial: string;
        usage_debits_rial: string;
        usage_refunds_rial: string;
        external_rated_rial: string;
        payments_ok: string;
        payments_fail: string;
      }>(
        `SELECT
           (SELECT COALESCE(SUM(total_rial), 0)::text
              FROM billing_invoices
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND status <> 'void'
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS invoiced_rial,
           (SELECT COALESCE(SUM(l.amount_rial), 0)::text
              FROM wallet_ledger l
             WHERE l.business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND l.direction = 'debit'
               AND l.kind IN ('subscription', 'plan_fee')
               AND l.created_at >= $1::timestamptz
               AND l.created_at < $2::timestamptz
               AND (
                 l.metadata->>'invoiceId' IS NULL
                 OR NOT EXISTS (
                   SELECT 1 FROM billing_invoices i
                    WHERE i.id::text = l.metadata->>'invoiceId'
                      AND i.status <> 'void'
                      AND i.created_at >= $1::timestamptz
                      AND i.created_at < $2::timestamptz
                 )
               )) AS unlinked_sub_debits_rial,
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM billing_payments
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND status = 'verified'
               AND COALESCE(verified_at, created_at) >= $1::timestamptz
               AND COALESCE(verified_at, created_at) < $2::timestamptz) AS collected_payments_rial,
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM billing_invoice_payments
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS collected_invoice_payments_rial,
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM wallet_ledger
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND direction = 'debit'
               AND kind NOT IN ('admin_adjust', 'subscription', 'plan_fee')
               AND COALESCE((metadata->>'aiDebtPaydown')::boolean, false) = false
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS usage_debits_rial,
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM wallet_ledger
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND direction = 'credit'
               AND kind = 'refund'
               AND COALESCE((metadata->>'reversesSpend')::boolean, true) = true
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS usage_refunds_rial,
           (SELECT COALESCE(SUM(r.rated_amount_rial), 0)::text
              FROM billing_usage_ratings r
              JOIN billing_usage_events e ON e.id = r.usage_event_id
             WHERE r.business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND e.occurred_at >= $1::timestamptz
               AND e.occurred_at < $2::timestamptz
               AND e.source NOT IN ('ai_wallet_settlement', 'media_billing', 'message_outbox')) AS external_rated_rial,
           (SELECT count(*)::text
              FROM billing_payments
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND status = 'verified'
               AND COALESCE(verified_at, created_at) >= $1::timestamptz
               AND COALESCE(verified_at, created_at) < $2::timestamptz) AS payments_ok,
           (SELECT count(*)::text
              FROM billing_payments
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND status IN ('failed', 'cancelled')
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS payments_fail`,
        [startIso, nextStartIso],
      ),
      query<{ open: string; outstanding: string }>(
        `SELECT count(*)::text AS open,
                COALESCE(SUM(GREATEST(0, total_rial - paid_rial)), 0)::text AS outstanding
           FROM billing_invoices
          WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
            AND status IN ('open', 'partially_paid', 'overdue')`,
      ),
      query<{ liabilities: string; wallets: string; ai_debt: string }>(
        `SELECT
           (SELECT COALESCE(SUM(GREATEST(0, balance_rial)), 0)::text
              FROM business_wallets
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')) AS liabilities,
           (SELECT count(*)::text
              FROM business_wallets
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')) AS wallets,
           (SELECT COALESCE(SUM(GREATEST(0, debt_rial)), 0)::text
              FROM ai_wallet_debt
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')) AS ai_debt`,
      ),
      query<{
        business_id: string;
        monthly_ai_credit_rial: string | null;
        snapshot_granted_rial: string | null;
        used_rial: string | null;
        status: string | null;
        current_period_end: Date | string | null;
        cancel_at_period_end: boolean | null;
        auto_renew: boolean | null;
        trial_end: Date | string | null;
        grace_end: Date | string | null;
      }>(
        `SELECT b.id AS business_id,
                COALESCE(
                  (SELECT al.included_quantity FROM billing_plan_meter_allowances al
                    WHERE al.plan_key = p.key AND al.meter_key = 'ai.credit'),
                  p.monthly_ai_credit_rial
                )::text AS monthly_ai_credit_rial,
                u.granted_rial::text AS snapshot_granted_rial,
                u.used_rial::text AS used_rial,
                s.status,
                s.current_period_end,
                s.cancel_at_period_end,
                s.auto_renew,
                s.trial_end,
                s.grace_end
           FROM businesses b
           LEFT JOIN billing_plans p ON p.key = b.plan
           LEFT JOIN business_subscriptions s ON s.business_id = b.id
           LEFT JOIN ai_plan_allowance_usage u
                  ON u.business_id = b.id AND u.period_month = $1
          WHERE b.ownership_kind = 'customer'`,
        [window.periodMonth],
      ),
      query<{ wallet_ai: string; ai_shortfall: string }>(
        `SELECT
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM wallet_ledger
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND direction = 'debit'
               AND kind = 'feature_charge'
               AND feature_key = 'ai'
               AND COALESCE((metadata->>'aiDebtPaydown')::boolean, false) = false
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS wallet_ai,
           (SELECT COALESCE(SUM(debt_rial), 0)::text
              FROM ai_wallet_settlements
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS ai_shortfall`,
        [startIso, nextStartIso],
      ),
      query<{ balance: string; gross_usage: string; refunded_usage: string }>(
        `SELECT
           (SELECT COALESCE(SUM(GREATEST(0, balance_rial)), 0)::text
              FROM business_wallets
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')) AS balance,
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM wallet_ledger
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND feature_key = 'messaging'
               AND direction = 'debit'
               AND kind = 'feature_charge'
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS gross_usage,
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM wallet_ledger
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND feature_key = 'messaging'
               AND direction = 'credit'
               AND kind = 'refund'
               AND created_at >= $1::timestamptz
               AND created_at < $2::timestamptz) AS refunded_usage`,
        [startIso, nextStartIso],
      ),
      query<{ businesses: string; bytes: string; charges: string }>(
        `SELECT
           (SELECT count(DISTINCT business_id)::text
              FROM media_assets
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')) AS businesses,
           (SELECT COALESCE(SUM(byte_size), 0)::text
              FROM media_assets
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')) AS bytes,
           (SELECT COALESCE(SUM(amount_rial), 0)::text
              FROM media_usage_charges
             WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
               AND day >= $1
               AND day < $2) AS charges`,
        [monthStartDay, nextMonthStartDay],
      ),
      getPaymentConfig(),
      getPlatformAiConfig(),
    ]);

  const subsBy = Object.fromEntries(subs.rows.map((r) => [r.status, Number(r.count)]));
  const moneyRow = money.rows[0];
  const invoiceRow = invoices.rows[0];
  const walletRow = wallet.rows[0];
  const aiWalletRow = aiWallet.rows[0];
  const messagingRow = messaging.rows[0];
  const mediaRow = media.rows[0];

  let allowanceGrantedRial = 0;
  let allowanceUsedRial = 0;
  for (const row of aiRows.rows) {
    const carries =
      row.status == null
        ? true
        : isSubscriptionCarryingPlan(
            {
              status: row.status,
              currentPeriodEnd: row.current_period_end,
              cancelAtPeriodEnd: row.cancel_at_period_end,
              autoRenew: row.auto_renew,
              trialEnd: row.trial_end,
              graceEnd: row.grace_end,
            },
            now.toISOString(),
          );
    const resolved = resolveEffectivePlanAllowance({
      configuredCreditRial:
        row.monthly_ai_credit_rial == null ? 0 : Number(row.monthly_ai_credit_rial),
      grantedRial:
        row.snapshot_granted_rial == null ? null : Number(row.snapshot_granted_rial),
      usedRial: row.used_rial == null ? 0 : Number(row.used_rial),
      subscriptionCarrying: carries,
      periodMonth: window.periodMonth,
    });
    allowanceGrantedRial += resolved.effectiveCreditRial;
    allowanceUsedRial += resolved.usedRial;
  }

  const invoicedRial = Number(moneyRow?.invoiced_rial ?? 0);
  const unlinkedSubDebitsRial = Number(moneyRow?.unlinked_sub_debits_rial ?? 0);
  const billedRial = invoicedRial + unlinkedSubDebitsRial;
  const collectedRevenueRial =
    Number(moneyRow?.collected_payments_rial ?? 0) +
    Number(moneyRow?.collected_invoice_payments_rial ?? 0);

  const usageDebitsRial = Number(moneyRow?.usage_debits_rial ?? 0);
  const usageRefundsRial = Number(moneyRow?.usage_refunds_rial ?? 0);
  const externalRatedRial = Number(moneyRow?.external_rated_rial ?? 0);
  const aiShortfallRial = Number(aiWalletRow?.ai_shortfall ?? 0);
  const netUsageSpendRial = Math.max(
    0,
    usageDebitsRial - usageRefundsRial + allowanceUsedRial + aiShortfallRial + externalRatedRial,
  );

  const liabilityRial = Number(walletRow?.liabilities ?? 0);
  const aiDebtRial = Number(walletRow?.ai_debt ?? 0);
  const grossMessagingUsage = Number(messagingRow?.gross_usage ?? 0);
  const refundedMessagingUsage = Number(messagingRow?.refunded_usage ?? 0);
  const netMessagingUsage = Math.max(0, grossMessagingUsage - refundedMessagingUsage);

  const { rows: lastSuccess } = await query<{ last_verified: string | null }>(
    `SELECT max(verified_at)::text AS last_verified
       FROM billing_payments
      WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'customer')
        AND status = 'verified'`,
  );

  return NextResponse.json({
    subscriptions: {
      active: subsBy.active ?? 0,
      trialing: subsBy.trialing ?? 0,
      pastDue: subsBy.past_due ?? 0,
      cancelled: subsBy.cancelled ?? 0,
      expired: subsBy.expired ?? 0,
    },
    money: {
      month: monthLabel,
      timezone: "Asia/Tehran",
      periodStart: startIso,
      periodEnd: nextStartIso,
      billedRial,
      collectedRevenueRial,
      netUsageSpendRial,
      successfulPayments: Number(moneyRow?.payments_ok ?? 0),
      failedPayments: Number(moneyRow?.payments_fail ?? 0),
    },
    invoices: {
      outstandingCount: Number(invoiceRow?.open ?? 0),
      outstandingRial: Number(invoiceRow?.outstanding ?? 0),
    },
    wallets: {
      liabilityRial,
      aiDebtRial,
      netLiabilityRial: Math.max(0, liabilityRial - aiDebtRial),
      count: Number(walletRow?.wallets ?? 0),
    },
    ai: {
      allowanceGrantedRial,
      allowanceUsedRial,
      walletChargedRial: Number(aiWalletRow?.wallet_ai ?? 0),
      debtRial: aiDebtRial,
      costingEnabled: Boolean(aiConfig.gatewayCostingEnabled && (aiConfig.usdRialRate ?? 0) > 0),
    },
    messaging: {
      creditBalanceRial: Number(messagingRow?.balance ?? 0),
      grossUsageRialThisMonth: grossMessagingUsage,
      refundedRialThisMonth: refundedMessagingUsage,
      usageRialThisMonth: netMessagingUsage,
    },
    media: {
      businesses: Number(mediaRow?.businesses ?? 0),
      storedBytes: Number(mediaRow?.bytes ?? 0),
      chargesRialThisMonth: Number(mediaRow?.charges ?? 0),
    },
    gateway: {
      configured: gateway.gateway,
      sandbox: gateway.sandbox,
      currency: gateway.currency,
      merchantIdSet: Boolean(gateway.merchantId),
      lastSuccessfulPayment: lastSuccess[0]?.last_verified ?? null,
    },
  });
});
