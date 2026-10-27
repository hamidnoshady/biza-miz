/**
 * Phase 37 Wave 2/3 — the outbox drain. This is the ONLY thing that talks to a
 * message provider: launching a campaign writes recipients + queued outbox
 * rows, and this tick performs the sends. A cashier closing a till must never
 * wait on — or fail because of — an SMTP or Kavenegar round trip.
 *
 * The per-business pass mirrors `runWooCommerceSyncTick` exactly (the shape
 * #372 asked for):
 *   1. enumerate businesses with ready queued rows under the platform bypass,
 *   2. re-enter each one through `withTenant`,
 *   3. reserve credit (max up front), attempt through the adapter, record the
 *      outcome, then settle at what actually went,
 *   4. retry with exponential backoff up to a cap,
 *   5. swallow its own errors — no user request ever fails because of this tick.
 *
 * A per-business rate cap keeps one large campaign from locking out the others.
 */
import { query, withoutTenantScope, withTenant } from "./db";
import { appendUsageEvent } from "./billing/runtime";
import {
  requireMessageProviders,
  reserveMessageSend,
  settleMessageSend,
  MessageInsufficientCreditError,
  type MessageResolvedConfig,
} from "./messaging-billing";
import type { MessageRate } from "./messaging-billing-pure";
import { messageCostRial, smsSegmentCount } from "./messaging-billing-pure";
import { providerErrorLabel } from "./messaging/provider";
import { KavenegarMessageProvider } from "./messaging/providers/kavenegar-client";
import { SmtpMessageProvider } from "./messaging/providers/smtp";
import type { MessageProvider } from "./messaging/provider";
import { postCompletedCampaignCost } from "./message-cost-posting";
import { backfillSendVendorCosts, recordSendVendorCost } from "./messaging-vendor-cost";
import { isAppServiceOperational } from "./service-activation/app-gate-service";
import { resolveBusinessSmsSender } from "./kavenegar/credentials";
import {
  DEFAULT_RETAIL_PRICE_VERSION,
  quoteRetailBatch,
  type RetailChannel,
  type RetailChargeQuote,
  type RetailPriceVersion,
} from "./kavenegar/retail-pricing";
import { quoteBusinessSends } from "./kavenegar/retail-pricing-service";

export const MESSAGE_TICK_INTERVAL_MS = 20_000;
/** Max outbox rows drained per business per tick — the per-business rate cap. */
const DRAIN_BATCH_LIMIT = 200;

type DrainRow = {
  id: string;
  campaign_id: string;
  channel: string;
  address: string;
  subject: string;
  body: string;
};

/**
 * Issue #902 — which SMS account a business's marketing drain may use.
 *
 * A business with an ACTIVE managed child sends through that child's key,
 * resolved from the row's own `business_id` inside the tenant scope that
 * `runMessagingTick` established. A child that exists but is not active yields
 * `null`, and the drain leaves every SMS row queued: fail closed rather than
 * quietly billing the platform master account for a tenant whose managed
 * service is suspended. A business with no managed account keeps the legacy
 * platform configuration during the rollout.
 */
export function applyManagedSmsSender(
  config: MessageResolvedConfig,
  sender: Awaited<ReturnType<typeof resolveBusinessSmsSender>>,
): MessageResolvedConfig {
  if (sender.mode === "legacy_platform") return config;
  return {
    ...config,
    kavenegarApiKey: sender.apiKey,
    kavenegarSender: sender.sender || config.kavenegarSender,
    kavenegarConfigured: sender.apiKey !== null,
  };
}

export function buildProviders(config: MessageResolvedConfig): {
  sms: MessageProvider | null;
  email: MessageProvider | null;
} {
  let sms: MessageProvider | null = null;
  if (config.smsProvider === "kavenegar" && config.kavenegarApiKey) {
    sms = new KavenegarMessageProvider(config.kavenegarApiKey, config.kavenegarSender);
  }
  let email: MessageProvider | null = null;
  if (config.emailProvider === "smtp" && config.smtp) {
    email = new SmtpMessageProvider({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user,
      password: config.smtp.password ?? "",
      from: config.smtp.from,
    });
  }
  return { sms, email };
}

/** Exponential backoff for a retryable failure, seconds → next_attempt_at. */
export function retryBackoffMs(attempts: number): number {
  // attempts is the count already made; first retry waits ~60s, doubling.
  return Math.min(60_000 * 2 ** (attempts - 1), 30 * 60_000);
}

async function drainRows(businessId: string): Promise<DrainRow[]> {
  const { rows } = await query<DrainRow>(
    `SELECT o.id, o.campaign_id, r.channel, r.address, r.subject, r.body
       FROM message_outbox o
       JOIN message_recipients r ON r.id = o.recipient_id
       JOIN message_campaigns c ON c.id = o.campaign_id AND c.business_id = o.business_id
      WHERE o.business_id = $1 AND o.status = 'queued' AND o.next_attempt_at <= now()
        -- Pausing is a real brake, not just a label: unclaimed outbox rows
        -- remain historical queue records but cannot enter another reservation.
        AND c.status = 'sending'
      ORDER BY o.next_attempt_at, o.created_at
      LIMIT ${DRAIN_BATCH_LIMIT}`,
    [businessId],
  );
  return rows;
}

function unitPriceFor(channel: RetailChannel, rate: MessageRate): number {
  return channel === "sms" ? rate.smsRialPerSegment : rate.emailRialPerSend;
}

function unitQuantityFor(channel: RetailChannel, body: string): number {
  return channel === "sms" ? Math.max(1, smsSegmentCount(body)) : 1;
}

/**
 * Issue #902 §4 — price the whole batch ONCE, up front, under the price version
 * in force at reservation. Each message's retail charge is then a lookup: the
 * amount reserved is the amount settled, minus only what did not go out.
 *
 * If the pricing tables cannot be read (a deployment mid-migration, a failed
 * query), the drain falls back to the plain Billing base rate rather than
 * stopping a business's messaging: the tenant is then charged exactly what Wave
 * 1 charged, which is the pre-§4 behaviour, not a wrong price.
 */
async function priceDrainBatch(
  businessId: string,
  rows: DrainRow[],
  rate: MessageRate,
): Promise<{ quotes: Map<string, RetailChargeQuote>; version: RetailPriceVersion }> {
  const messages = rows.map((row) => {
    const channel = row.channel as RetailChannel;
    return {
      channel,
      unitPriceRial: unitPriceFor(channel, rate),
      quantity: unitQuantityFor(channel, row.body),
    };
  });
  let batch: { quotes: RetailChargeQuote[]; version: RetailPriceVersion };
  try {
    const priced = await quoteBusinessSends({ businessId, messages });
    batch = { quotes: priced.quotes, version: priced.version };
  } catch (error) {
    console.error("managed retail pricing unavailable; charging the base rate:", error);
    const fallback = quoteRetailBatch({
      businessId,
      monthlySegments: 0,
      version: DEFAULT_RETAIL_PRICE_VERSION,
      messages,
    });
    batch = { quotes: fallback.quotes, version: DEFAULT_RETAIL_PRICE_VERSION };
  }
  return {
    quotes: new Map(rows.map((row, index) => [row.id, batch.quotes[index]])),
    version: batch.version,
  };
}

/**
 * One business's pending sends. Exported for the integration test to drive a
 * fake adapter and assert 10 recipients → 10 outbox outcomes (Wave 2 exit #1).
 */
export async function runBusinessMessageDrain(
  businessId: string,
  config: MessageResolvedConfig,
): Promise<{ attempted: number; sent: number; failed: number; refundedRial: number }> {
  if (!config.enabled) return { attempted: 0, sent: 0, failed: 0, refundedRial: 0 };
  // Fail closed for a managed business whose child is not usable: leaving the
  // rows queued is recoverable, billing the platform account is not.
  const sender = await resolveBusinessSmsSender(businessId);
  const effective = applyManagedSmsSender(config, sender);
  const providers = buildProviders(effective);
  const rows = await drainRows(businessId);
  if (rows.length === 0) return { attempted: 0, sent: 0, failed: 0, refundedRial: 0 };

  const pricing = await priceDrainBatch(businessId, rows, effective.rate);
  const totalCost = [...pricing.quotes.values()].reduce((sum, quote) => sum + quote.totalRial, 0);

  let reservation: { requestId: string; reservedRial: number } | null = null;
  if (totalCost > 0) {
    try {
      reservation = await reserveMessageSend({
        businessId,
        reservedRial: totalCost,
        // Only the version number travels with the money: the wallet entry is
        // tenant-readable, and markup/margin are not tenant data (§0, DoD #3).
        metadata: { retailPriceVersion: pricing.version.version },
      });
    } catch (error) {
      if (error instanceof MessageInsufficientCreditError) {
        // Wave 1 exit #5: a business without credit is stopped before any
        // attempt. Rows stay queued; the next top-up lets the next tick drain.
        return { attempted: 0, sent: 0, failed: 0, refundedRial: 0 };
      }
      throw error;
    }
  }

  let sent = 0;
  let failed = 0;
  const sentCost = { total: 0 };
  const touchedCampaigns = new Set<string>();

  for (const row of rows) {
    const provider = row.channel === "sms" ? providers.sms : providers.email;
    touchedCampaigns.add(row.campaign_id);
    if (!provider) {
      // No adapter for this channel yet (or disabled): leave queued so it sends
      // the moment the console configures one — never silently drop it.
      continue;
    }
    const result = await provider.send({
      to: row.address,
      subject: row.subject || undefined,
      body: row.body,
    });

    if (result.ok) {
      await query(
        `UPDATE message_outbox
            SET status = 'sent', sent_at = now(), provider_message_id = $3,
                provider_cost_rial = $4,
                last_attempt_at = now(), error = NULL, updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [
          row.id,
          businessId,
          result.providerMessageId,
          typeof result.providerCostRial === "number" ? result.providerCostRial : null,
        ],
      );
      sent += 1;
      const quote = pricing.quotes.get(row.id);
      const rowCost = quote?.totalRial ?? messageCostRial(row.channel as "sms" | "email", row.body, effective.rate);
      sentCost.total += rowCost;
      // Issue #902 §4 — the accepted send's wholesale cost becomes a ledgered
      // finance fact, idempotent on the outbox row, carrying the retail charge
      // and the price version that priced it as internal evidence. A billing
      // write must never fail a send that already went out: the backfill picks
      // it up instead. `recordSendVendorCost` marks the row tenant-invisible
      // (§0/DoD #3), so no supplier name or wholesale tariff can reach a tenant.
      try {
        await recordSendVendorCost({
          businessId,
          outboxId: String(row.id),
          channel: row.channel,
          provider: row.channel === "sms" ? effective.smsProvider : effective.emailProvider,
          costRial: result.providerCostRial,
          metadata: {
            retailRial: rowCost,
            priceVersion: pricing.version.version,
            segments: unitQuantityFor(row.channel as RetailChannel, row.body),
          },
        });
      } catch (error) {
        console.error(
          "message vendor cost failed:",
          row.id,
          error instanceof Error ? error.message : error,
        );
      }
      sentCost.total += rowCost;
      const sms = row.channel === "sms";
      await appendUsageEvent({
        eventId: String(row.id),
        businessId,
        meterKey: sms ? "messaging.sms_segment" : "messaging.email_send",
        source: "messaging",
        quantity: sms ? Math.max(1, smsSegmentCount(row.body)) : 1,
        unit: sms ? "segment" : "send",
        resource: "message_outbox",
        resourceId: String(row.id),
        dimensions: { walletBacked: true, channel: row.channel },
        ratedAmountRial: rowCost,
      }).catch((error) => {
        console.error("message usage event failed:", row.id, error);
      });
    } else {
      const permanent = !result.retryable;
      const { rowCount } = await query<{ id: string }>(
        `UPDATE message_outbox
            SET attempts = attempts + 1,
                last_attempt_at = now(),
                error = $3,
                updated_at = now()
          WHERE id = $1 AND business_id = $2
          RETURNING id`,
        [row.id, businessId, providerErrorLabel(result.code)],
      );
      if (rowCount === 0) continue;
      const attemptsRow = await query<{ attempts: number; max_attempts: number }>(
        `SELECT attempts, max_attempts FROM message_outbox WHERE id = $1 AND business_id = $2`,
        [row.id, businessId],
      );
      const attempts = attemptsRow.rows[0]?.attempts ?? 0;
      const maxAttempts = attemptsRow.rows[0]?.max_attempts ?? 3;
      if (permanent || attempts >= maxAttempts) {
        await query(
          `UPDATE message_outbox SET status = 'failed', updated_at = now()
            WHERE id = $1 AND business_id = $2`,
          [row.id, businessId],
        );
        failed += 1;
        // §4 failure policy: `refund` (the default) charges nothing for a send
        // the provider never accepted; `charge` bills the attempt, and says so
        // in the settlement rather than silently keeping the reservation.
        if (pricing.version.failedSendPolicy === "charge") {
          sentCost.total += pricing.quotes.get(row.id)?.totalRial ?? 0;
        }
      } else {
        await query(
          `UPDATE message_outbox SET status = 'queued', next_attempt_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
            WHERE id = $1 AND business_id = $2`,
          [row.id, businessId, retryBackoffMs(attempts)],
        );
      }
    }
  }

  let refundedRial = 0;
  if (reservation) {
    const settled = await settleMessageSend({
      businessId,
      reservation,
      actualCostRial: sentCost.total,
      note: "ارسال پیام‌های صف",
    });
    refundedRial = settled.refundedRial;
  }

  await reconcileCampaigns(businessId, [...touchedCampaigns]);
  return { attempted: rows.length, sent, failed, refundedRial };
}

async function reconcileCampaigns(businessId: string, campaignIds: string[]): Promise<void> {
  if (campaignIds.length === 0) return;
  const { rows } = await query<{ id: string; became_completed: boolean }>(
    `UPDATE message_campaigns c
        SET sent_count = s.sent,
            delivered_count = s.delivered,
            failed_count = s.failed,
            updated_at = now(),
            status = CASE WHEN s.open = 0 THEN 'completed' ELSE c.status END,
            completed_at = CASE WHEN s.open = 0 AND c.status <> 'completed' THEN now() ELSE c.completed_at END
       FROM (
         SELECT campaign_id,
                count(*) FILTER (WHERE status = 'sent')     AS sent,
                count(*) FILTER (WHERE status = 'delivered') AS delivered,
                count(*) FILTER (WHERE status = 'failed')    AS failed,
                count(*) FILTER (WHERE status IN ('queued','sending')) AS open
           FROM message_outbox
          WHERE business_id = $1 AND campaign_id = ANY($2::uuid[])
          GROUP BY campaign_id
       ) s
      WHERE c.business_id = $1 AND c.id = s.campaign_id
      RETURNING c.id, (s.open = 0 AND c.status <> 'completed') AS became_completed`,
    [businessId, campaignIds],
  );
  // Wave 4: a campaign that just completed posts its real-send cost (one
  // document per campaign) unless the period is locked, which routes it to the
  // human approval queue.
  for (const r of rows) {
    if (r.became_completed) {
      try {
        await postCompletedCampaignCost(businessId, r.id);
      } catch (error) {
        console.error(
          `message campaign ${r.id} cost posting failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}

let tickInFlight = false;

/**
 * The background tick (server.ts). Enumerates businesses under the documented
 * platform bypass, re-enters each with `withTenant`, and swallows per-business
 * failures — no error here can ever take down a user request.
 */
export async function runMessagingTick(): Promise<number> {
  if (tickInFlight) return 0;
  tickInFlight = true;
  try {
    const [config, businessIds] = await Promise.all([
      requireMessageProviders().catch(() => null),
      withoutTenantScope("platform", async () => {
        const { rows } = await query<{ id: string }>(
          `SELECT DISTINCT business_id AS id FROM message_outbox
            WHERE status = 'queued' AND next_attempt_at <= now()`,
        );
        return rows.map((r) => r.id);
      }),
    ]);
    if (!config || !config.enabled) return 0;

    let processed = 0;
    for (const businessId of businessIds) {
      try {
        const outcome = await withTenant(businessId, async () => {
          if (!(await isAppServiceOperational(businessId, "growth"))) {
            return { attempted: 0, sent: 0, failed: 0, refundedRial: 0 };
          }
          return runBusinessMessageDrain(businessId, config);
        });
        processed += outcome.attempted;
      } catch (error) {
        console.error(
          `messaging tick failed for business ${businessId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Issue #902 §4 — catch up wholesale costs for sends accepted before this
    // module existed, or whose billing write happened to fail. Bounded per tick
    // and driven by the absence of the event, so it self-heals and then idles.
    try {
      await backfillSendVendorCosts({
        providers: { sms: config.smsProvider, email: config.emailProvider },
      });
    } catch (error) {
      console.error(
        "message vendor cost backfill failed:",
        error instanceof Error ? error.message : error,
      );
    }

    return processed;
  } finally {
    tickInFlight = false;
  }
}
