import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { query } from "@/lib/db";
import { getPaymentConfig } from "@/lib/wallet-service";
import { getPlatformAiConfig } from "@/lib/ai-config";

/**
 * The Billing overview KPIs — one read-only round trip per source, answering
 * «how is the platform's money doing?»:
 *
 *   subscriptions (active / trialing / past_due / expired),
 *   this month's billed amount (wallet debits of kind subscription/plan_fee),
 *   payments (succeeded / failed / pending),
 *   outstanding invoices,
 *   wallet liabilities (total credit businesses are owed),
 *   AI allowance + wallet usage this month,
 *   messaging usage this month,
 *   media storage usage,
 *   gateway health (the configured gateway and its last successful payment).
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const [subs, money, invoices, wallet, ai, messaging, media, gateway, aiConfig] = await Promise.all([
    query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM business_subscriptions s JOIN businesses b ON b.id=s.business_id WHERE b.ownership_kind='customer' GROUP BY s.status`,
    ),
    query<{ billed: string; payments_ok: string; payments_fail: string; month: string }>(
      `SELECT
         (SELECT COALESCE(SUM(amount_rial), 0)::text FROM wallet_ledger
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND direction = 'debit' AND kind IN ('subscription', 'plan_fee')
             AND created_at >= date_trunc('month', now())) AS billed,
         (SELECT count(*)::text FROM billing_payments
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND status = 'verified' AND created_at >= date_trunc('month', now())) AS payments_ok,
         (SELECT count(*)::text FROM billing_payments
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND status IN ('failed', 'cancelled') AND created_at >= date_trunc('month', now())) AS payments_fail,
         to_char(now(), 'YYYY-MM') AS month`,
    ),
    query<{ open: string; outstanding: string }>(
      `SELECT count(*)::text AS open,
              COALESCE(SUM(total_rial - paid_rial), 0)::text AS outstanding
         FROM billing_invoices
        WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND status IN ('open', 'partially_paid', 'overdue')`,
    ),
    query<{ liabilities: string; wallets: string }>(
      `SELECT COALESCE(SUM(balance_rial), 0)::text AS liabilities,
              count(*)::text AS wallets
         FROM business_wallets WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer')`,
    ),
    query<{ allowance_granted: string; allowance_used: string; wallet_ai: string }>(
      `SELECT
         (SELECT COALESCE(SUM(granted_rial), 0)::text FROM ai_plan_allowance_usage
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND period_month = to_char(now(), 'YYYY-MM')) AS allowance_granted,
         (SELECT COALESCE(SUM(used_rial), 0)::text FROM ai_plan_allowance_usage
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND period_month = to_char(now(), 'YYYY-MM')) AS allowance_used,
         (SELECT COALESCE(SUM(amount_rial), 0)::text FROM wallet_ledger
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND kind = 'feature_charge' AND feature_key = 'ai'
             AND created_at >= date_trunc('month', now())) AS wallet_ai`,
    ),
    query<{ balance: string; usage: string }>(
      `SELECT
         (SELECT COALESCE(SUM(balance_rial), 0)::text FROM business_wallets WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer')) AS balance,
         (SELECT COALESCE(SUM(amount_rial), 0)::text FROM wallet_ledger
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND feature_key = 'messaging' AND kind = 'feature_charge'
             AND created_at >= date_trunc('month', now())) AS usage`,
    ),
    query<{ businesses: string; bytes: string; charges: string }>(
      `SELECT
         (SELECT count(DISTINCT business_id)::text FROM media_assets WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer')) AS businesses,
         (SELECT COALESCE(SUM(byte_size), 0)::text FROM media_assets WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer')) AS bytes,
         (SELECT COALESCE(SUM(amount_rial), 0)::text FROM media_usage_charges
           WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND day >= to_char(date_trunc('month', now()), 'YYYY-MM-DD')) AS charges`,
    ),
    getPaymentConfig(),
    getPlatformAiConfig(),
  ]);

  const subsBy = Object.fromEntries(subs.rows.map((r) => [r.status, Number(r.count)]));
  const moneyRow = money.rows[0];
  const invoiceRow = invoices.rows[0];
  const walletRow = wallet.rows[0];
  const aiRow = ai.rows[0];
  const messagingRow = messaging.rows[0];
  const mediaRow = media.rows[0];

  const { rows: lastSuccess } = await query<{ last_verified: string | null }>(
    `SELECT max(verified_at)::text AS last_verified FROM billing_payments WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer') AND status = 'verified'`,
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
      month: moneyRow?.month ?? null,
      billedRial: Number(moneyRow?.billed ?? 0),
      successfulPayments: Number(moneyRow?.payments_ok ?? 0),
      failedPayments: Number(moneyRow?.payments_fail ?? 0),
    },
    invoices: {
      outstandingCount: Number(invoiceRow?.open ?? 0),
      outstandingRial: Number(invoiceRow?.outstanding ?? 0),
    },
    wallets: {
      liabilityRial: Number(walletRow?.liabilities ?? 0),
      count: Number(walletRow?.wallets ?? 0),
    },
    ai: {
      allowanceGrantedRial: Number(aiRow?.allowance_granted ?? 0),
      allowanceUsedRial: Number(aiRow?.allowance_used ?? 0),
      walletChargedRial: Number(aiRow?.wallet_ai ?? 0),
      costingEnabled: Boolean(aiConfig.gatewayCostingEnabled && (aiConfig.usdRialRate ?? 0) > 0),
    },
    messaging: {
      creditBalanceRial: Number(messagingRow?.balance ?? 0),
      usageRialThisMonth: Math.abs(Number(messagingRow?.usage ?? 0)),
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
