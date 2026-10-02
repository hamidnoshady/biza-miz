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
import type { MessageProvider, SendResult } from "./messaging/provider";
import { postCompletedCampaignCost } from "./message-cost-posting";

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

function sendResultCost(result: SendResult, channel: string, body: string, rate: MessageRate): number {
  if (result.ok) return messageCostRial(channel as "sms" | "email", body, rate);
  return 0;
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
  const providers = buildProviders(config);
  const rows = await drainRows(businessId);
  if (rows.length === 0) return { attempted: 0, sent: 0, failed: 0, refundedRial: 0 };

  const totalCost = rows.reduce(
    (sum, r) => sum + messageCostRial(r.channel as "sms" | "email", r.body, config.rate),
    0,
  );

  let reservation: { requestId: string; reservedRial: number } | null = null;
  if (totalCost > 0) {
    try {
      reservation = await reserveMessageSend({ businessId, reservedRial: totalCost });
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
                last_attempt_at = now(), error = NULL, updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [row.id, businessId, result.providerMessageId],
      );
      sent += 1;
      const rowCost = sendResultCost(result, row.channel, row.body, config.rate);
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
      } else {
        await query(
          `UPDATE message_outbox SET status = 'queued', next_attempt_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
            WHERE id = $1 AND business_id = $2`,
          [row.id, businessId, retryBackoffMs(attempts)],
        );
      }
    }
  }

  if (reservation) {
    await settleMessageSend({
      businessId,
      reservation,
      actualCostRial: sentCost.total,
      note: "ارسال پیام‌های صف",
    });
  }

  await reconcileCampaigns(businessId, [...touchedCampaigns]);
  return { attempted: rows.length, sent, failed, refundedRial: 0 };
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
        const outcome = await withTenant(businessId, () =>
          runBusinessMessageDrain(businessId, config),
        );
        processed += outcome.attempted;
      } catch (error) {
        console.error(
          `messaging tick failed for business ${businessId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return processed;
  } finally {
    tickInFlight = false;
  }
}
