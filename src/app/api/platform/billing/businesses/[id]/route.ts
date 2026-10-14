import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import {
  countLedger,
  countPayments,
  deductCredits,
  getWallet,
  grantCredits,
  listLedger,
  listPayments,
} from "@/lib/wallet-service";
import { listEntitlements } from "@/lib/billing-plans-service";
import {
  countInvoices,
  getBusinessSubscription,
  listInvoices,
  calculateSubscriptionTotal,
} from "@/lib/subscription-service";
import { getMessageBusinessBilling } from "@/lib/messaging-billing";
import { emptyMediaUsage, mediaUsageFor } from "@/lib/media-service";
import { getPlatformAiConfig } from "@/lib/ai-config";
import {
  getAiGatewayConfig,
  listBusinessGateways,
  refreshKeySpend,
  toPublicBusinessGateway,
} from "@/lib/ai-gateway-service";
import { rialFromGatewayUsd } from "@/lib/ai-gateway";
import { getPlanAllowance } from "@/lib/ai-plan-allowance";
import { parseSafeIntInput } from "@/lib/platform-money";
import { query } from "@/lib/db";
import {
  BILLING_ALWAYS_INCLUDED,
  BILLING_INCLUDE_KEYS,
  isBillingIncludeKey,
} from "@/lib/platform-billing-includes";

/**
 * The section keys `include=` accepts — one per tab of the business Billing
 * page, so the page fetches the tab it is actually showing (issue #755 §17)
 * rather than every collection for every business on every open.
 *
 * The keys live in `@/lib/platform-billing-includes` because the page names them
 * too, and the two lists have to agree: the first version of this contract had
 * the page sending a key this function refused, which turned every tab load into
 * a 400 that no test could see.
 */
type IncludeKey = (typeof BILLING_INCLUDE_KEYS)[number];

function parseInclude(raw: string | null): { keys: Set<IncludeKey> } | { invalid: string } {
  // No `include` means "everything" — the pre-§17 contract, kept so the global
  // Billing control center and existing callers keep working unchanged.
  if (raw === null) return { keys: new Set<IncludeKey>(BILLING_INCLUDE_KEYS) };
  const keys = new Set<IncludeKey>();
  for (const part of raw.split(",")) {
    const key = part.trim().toLowerCase();
    if (!key) continue;
    // The business's own identity is always returned, so naming it is allowed
    // rather than a refusal — see BILLING_ALWAYS_INCLUDED. `?include=business`
    // is therefore a legitimate (if thin) request, and the version that refused
    // it is what broke every tab of the Billing page.
    if (key === BILLING_ALWAYS_INCLUDED) continue;
    if (!isBillingIncludeKey(key)) return { invalid: key };
    keys.add(key);
  }
  // `?include=` with nothing after it is a malformed request, not a thin one.
  if (keys.size === 0 && raw.trim() === "") return { invalid: "" };
  return { keys };
}

/** A bounded page size from the query string; `fallback` when absent/garbage. */
function pageSize(sp: URLSearchParams, name: string, fallback: number): number {
  const n = Number(sp.get(name));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

function pageOffset(sp: URLSearchParams, name: string): number {
  const n = Number(sp.get(name));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * One business's commercial view for the consolidated Billing page (migration
 * 0176) — subscription, plan limits, wallet, ledger, entitlements, usage across
 * AI / messaging / media, invoices, payments, overrides and the LiteLLM spend
 * read-back.
 *
 * **Scalability (issue #755 §17).** It used to load all fourteen of those at
 * once and cap the ledger/payments/invoices lists at 50 rows with no way to see
 * past them. Now the caller names the sections it needs with an explicit
 * `include=` contract (one key per tab), and the three list collections page
 * with `{section}Limit` / `{section}Offset`, reporting `total` in `meta` so the
 * UI can say "50 of 312" and offer a real load-more. `include` omitted still
 * returns everything, for the cross-business console and older callers.
 */
export const GET = withPlatformScope(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { error } = await requirePlatformAdmin();
    if (error) return error;
    const { id: businessId } = await ctx.params;

    const sp = new URL(request.url).searchParams;
    const parsed = parseInclude(sp.get("include"));
    if ("invalid" in parsed) {
      return NextResponse.json(
        {
          error: "invalid_include",
          invalid: parsed.invalid,
          valid: [...BILLING_INCLUDE_KEYS, BILLING_ALWAYS_INCLUDED],
        },
        { status: 400 },
      );
    }
    const want = parsed.keys;

    const { rows: bizRows } = await query<{ name: string; plan: string }>(
      `SELECT name, plan FROM businesses WHERE id = $1`,
      [businessId],
    );
    if (!bizRows[0]) return NextResponse.json({ error: "business_not_found" }, { status: 404 });

    const ledgerLimit = pageSize(sp, "ledgerLimit", 50);
    const ledgerOffset = pageOffset(sp, "ledgerOffset");
    const paymentsLimit = pageSize(sp, "paymentsLimit", 50);
    const paymentsOffset = pageOffset(sp, "paymentsOffset");
    const invoicesLimit = pageSize(sp, "invoicesLimit", 50);
    const invoicesOffset = pageOffset(sp, "invoicesOffset");

    // Only the included sections are queried — that is the whole point of the
    // contract: opening the Invoices tab must not also compute usage, media and
    // the subscription total for a business with a million ledger rows.
    const [
      wallet,
      ledger,
      ledgerTotal,
      entitlements,
      payments,
      paymentsTotal,
      usage,
      gateway,
      platform,
      gatewayRows,
      subscription,
      invoices,
      invoicesTotal,
      recurring,
      messageBilling,
      mediaUsage,
      planAllowance,
      overrides,
    ] = await Promise.all([
      want.has("wallet") || want.has("ai") ? getWallet(businessId) : null,
      want.has("ledger") ? listLedger(businessId, ledgerLimit, ledgerOffset) : null,
      want.has("ledger") ? countLedger(businessId) : null,
      want.has("subscription") ? listEntitlements(businessId) : null,
      want.has("payments")
        ? listPayments({ businessId, limit: paymentsLimit, offset: paymentsOffset })
        : null,
      want.has("payments") ? countPayments({ businessId }) : null,
      // The AI tab reports this business's AI spend from the same usage rows,
      // so `ai` needs them too — one small aggregate query, not the whole tab.
      want.has("usage") || want.has("ai")
        ? query<{
            feature_key: string;
            used_count: string;
            charged_count: string;
            spent_rial: string;
          }>(
            `SELECT feature_key, used_count, charged_count, spent_rial
               FROM feature_usage WHERE business_id = $1
              ORDER BY spent_rial DESC, feature_key`,
            [businessId],
          )
        : null,
      want.has("ai") ? getAiGatewayConfig() : null,
      want.has("ai") ? getPlatformAiConfig() : null,
      want.has("ai") ? listBusinessGateways(businessId) : null,
      want.has("subscription") ? getBusinessSubscription(businessId) : null,
      want.has("invoices")
        ? listInvoices({ businessId, limit: invoicesLimit, offset: invoicesOffset })
        : null,
      want.has("invoices") ? countInvoices({ businessId }) : null,
      want.has("subscription") ? calculateSubscriptionTotal(businessId).catch(() => null) : null,
      want.has("usage")
        ? getMessageBusinessBilling(businessId).catch(() => ({ balanceRial: 0 }))
        : null,
      // The failure fallback must have the *same* shape as a success, or the
      // recovery path crashes where the happy path worked. `emptyMediaUsage()`
      // carries every kind, so `usage.byKind.image.count` is always defined.
      want.has("usage") ? mediaUsageFor(businessId).catch(() => emptyMediaUsage()) : null,
      want.has("wallet") || want.has("ai") ? getPlanAllowance(businessId) : null,
      // Every override row, classified. The entitlement engine already ignores
      // an expired override, so returning expired rows as if they were live made
      // the console disagree with the engine that actually decides access.
      want.has("overrides")
        ? query<{
            id: string;
            kind: string;
            target: string;
            value_int: number | null;
            value_bool: boolean | null;
            reason: string;
            expires_at: string | null;
            created_at: string;
            admin_name: string | null;
            state: "active" | "expired" | "removed";
          }>(
            `SELECT o.id, o.kind, o.target, o.value_int, o.value_bool, o.reason,
                    o.expires_at, o.created_at, adm.full_name AS admin_name,
                    CASE WHEN NOT o.active THEN 'removed'
                         WHEN o.expires_at IS NOT NULL AND o.expires_at <= now() THEN 'expired'
                         ELSE 'active' END AS state
               FROM business_billing_overrides o
               LEFT JOIN platform_admins adm ON adm.id = o.created_by
              WHERE o.business_id = $1
              ORDER BY o.created_at DESC`,
            [businessId],
          )
        : null,
    ]);

    const overrideRows = overrides?.rows ?? [];
    const toOverride = (o: (typeof overrideRows)[number]) => ({
      id: o.id,
      kind: o.kind,
      target: o.target,
      valueInt: o.value_int,
      valueBool: o.value_bool,
      reason: o.reason,
      expiresAt: o.expires_at,
      createdAt: o.created_at,
      createdBy: o.admin_name,
      state: o.state,
    });

    const response: Record<string, unknown> = {
      business: { id: businessId, name: bizRows[0].name, plan: bizRows[0].plan },
      meta: {
        includes: [...want],
        ledger: { total: ledgerTotal ?? 0, limit: ledgerLimit, offset: ledgerOffset },
        payments: { total: paymentsTotal ?? 0, limit: paymentsLimit, offset: paymentsOffset },
        invoices: { total: invoicesTotal ?? 0, limit: invoicesLimit, offset: invoicesOffset },
      },
    };

    if (wallet && want.has("wallet")) {
      const remainingAllowanceRial = planAllowance?.remainingRial ?? 0;
      const netBalanceRial =
        wallet.netBalanceRial ?? Math.max(0, wallet.balanceRial - (wallet.aiDebtRial ?? 0));
      response.wallet = {
        ...wallet,
        netBalanceRial,
        aiAllowanceRemainingRial: remainingAllowanceRial,
        usableAiCreditRial: netBalanceRial + remainingAllowanceRial,
      };
    }
    if (ledger) response.ledger = ledger;
    if (entitlements) response.entitlements = entitlements;
    if (payments) response.payments = payments;
    if (invoices) response.invoices = invoices;
    if (subscription !== undefined && want.has("subscription")) {
      response.subscription = subscription;
      response.recurring = recurring;
    }
    if (want.has("usage")) {
      response.messaging = { balanceRial: messageBilling?.balanceRial ?? 0 };
      response.media = { usage: mediaUsage ?? emptyMediaUsage() };
      response.usage = (usage?.rows ?? []).map((u) => ({
        featureKey: u.feature_key,
        usedCount: Number(u.used_count),
        chargedCount: Number(u.charged_count),
        spentRial: Number(u.spent_rial),
      }));
    }
    if (want.has("ai")) {
      const remainingAllowanceRial = planAllowance?.remainingRial ?? 0;
      const aiDebtRial = wallet?.aiDebtRial ?? 0;
      const netWalletBalanceRial = wallet?.netBalanceRial ?? 0;
      response.ai = {
        allowance: planAllowance,
        walletSpentRial: (usage?.rows ?? [])
          .filter((u) => u.feature_key === "ai" || u.feature_key === "ai_assistant")
          .reduce((sum, u) => sum + Number(u.spent_rial), 0),
        aiDebtRial,
        usableAiCreditRial: netWalletBalanceRial + remainingAllowanceRial,
      };
    }
    if (want.has("overrides")) {
      // `overrides` is the *effective* set (what the entitlement engine will
      // actually honour); `overrideHistory` is expired/removed rows kept for
      // accountability rather than shown as active.
      response.overrides = overrideRows.filter((o) => o.state === "active").map(toOverride);
      response.overrideHistory = overrideRows.filter((o) => o.state !== "active").map(toOverride);
    }
    if (gateway && platform && gatewayRows) {
      // The LiteLLM side of this business: each virtual key's reported USD
      // spend, converted to Rial at the platform's stored rate so the console
      // can show the real cost the platform is paying LiteLLM for this
      // business.
      const rate = platform.usdRialRate ?? 0;
      const keys = gatewayRows.map((row) => {
        const pub = toPublicBusinessGateway(row, gateway, platform.model);
        return {
          locationId: pub.locationId,
          keyAlias: pub.keyAlias,
          effectiveModel: pub.effectiveModel,
          hasVirtualKey: pub.hasVirtualKey,
          spendUsd: row.spendUsd,
          spendRial: rate > 0 ? rialFromGatewayUsd(row.spendUsd, rate) : 0,
          syncedAt: pub.syncedAt,
          syncError: pub.syncError,
        };
      });
      response.litellm = {
        costingEnabled: Boolean(platform.gatewayCostingEnabled && rate > 0),
        usdRialRate: rate > 0 ? rate : null,
        totalSpendUsd: keys.reduce((sum, k) => sum + k.spendUsd, 0),
        totalSpendRial: keys.reduce((sum, k) => sum + k.spendRial, 0),
        keys,
      };
    }

    return NextResponse.json(response);
  },
);

/**
 * Manual wallet adjustment by the super-admin: grant (positive) or deduct
 * (negative) credits with a note. Every adjustment is audited (§36) with the
 * before/after balance.
 */
export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("adjustments.manage");
    if (guard.error) return guard.error;
    const { id: businessId } = await ctx.params;

    let body: { amountRial?: unknown; note?: string; action?: string; locationId?: string | null };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    // Pull this business's live LiteLLM spend from the gateway on demand, so the
    // console shows what the platform is actually paying LiteLLM right now.
    if (body.action === "sync_litellm_spend") {
      const gateway = await getAiGatewayConfig();
      const platform = await getPlatformAiConfig();
      const locationId =
        typeof body.locationId === "string" && body.locationId ? body.locationId : null;
      if (locationId) {
        await refreshKeySpend(gateway, businessId, locationId);
      } else {
        const rows = await listBusinessGateways(businessId);
        await Promise.all(
          rows
            .filter((r) => Boolean(r.virtualKey))
            .map((r) => refreshKeySpend(gateway, businessId, r.locationId)),
        );
      }
      const rate = platform.usdRialRate ?? 0;
      const rows = await listBusinessGateways(businessId);
      const keys = rows.map((row) => {
        const pub = toPublicBusinessGateway(row, gateway, platform.model);
        return {
          locationId: pub.locationId,
          keyAlias: pub.keyAlias,
          effectiveModel: pub.effectiveModel,
          hasVirtualKey: pub.hasVirtualKey,
          spendUsd: row.spendUsd,
          spendRial: rate > 0 ? rialFromGatewayUsd(row.spendUsd, rate) : 0,
          syncedAt: pub.syncedAt,
          syncError: pub.syncError,
        };
      });
      return NextResponse.json({
        litellm: {
          costingEnabled: Boolean(platform.gatewayCostingEnabled && rate > 0),
          usdRialRate: rate > 0 ? rate : null,
          totalSpendUsd: keys.reduce((s, k) => s + k.spendUsd, 0),
          totalSpendRial: keys.reduce((s, k) => s + k.spendRial, 0),
          keys,
        },
      });
    }

    const amount = parseSafeIntInput(body.amountRial, { min: -Number.MAX_SAFE_INTEGER });
    if (amount === null || amount === 0) {
      return NextResponse.json({ error: "bad_amount" }, { status: 400 });
    }

    try {
      const before = await getWallet(businessId);
      const result =
        amount > 0
          ? await grantCredits({
              businessId,
              amountRial: amount,
              note: body.note?.trim() || undefined,
              platformAdminId: guard.session.padmin,
            })
          : await deductCredits({
              businessId,
              amountRial: Math.abs(amount),
              note: body.note?.trim() || undefined,
              platformAdminId: guard.session.padmin,
            });
      const afterWallet = await getWallet(businessId);
      await platformAudit({
        adminId: guard.session.padmin,
        businessId,
        action: "wallet.adjusted",
        entity: "business_wallets",
        entityId: businessId,
        payload: {
          amountRial: amount,
          note: body.note?.trim() || null,
          beforeRial: before.balanceRial,
          afterRial: result.balanceRial,
          beforeDebtRial: before.aiDebtRial,
          afterDebtRial: afterWallet.aiDebtRial,
          debtPaidRial: (result as { debtPaidRial?: number }).debtPaidRial ?? 0,
        },
      });
      return NextResponse.json({
        balanceRial: result.balanceRial,
        aiDebtRial: afterWallet.aiDebtRial,
        netBalanceRial: afterWallet.netBalanceRial,
        debtPaidRial: (result as { debtPaidRial?: number }).debtPaidRial ?? 0,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "insufficient_credits") {
        return NextResponse.json({ error: "insufficient_credits" }, { status: 409 });
      }
      throw err;
    }
  },
);
