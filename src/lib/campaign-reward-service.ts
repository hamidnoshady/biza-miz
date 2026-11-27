/**
 * Issue #901, Wave 2 — the cashback reward service (the database half).
 *
 * This is the money engine the campaign builder was pointing at: a live
 * campaign's settled POS sales earn one reward each, the campaign's budget is
 * reserved atomically, the reward becomes spendable after its return hold, and
 * refunds, expiry and payouts move it through the append-only ledger.
 *
 * ## Why a sweep instead of a hook on the payment path
 *
 * The trigger is "a settled POS sale", and the facts that decide eligibility —
 * net paid after refunds, the branch, the customer, the campaign's activation
 * window — are all read from `orders`/`payments`. A sweep is the honest shape
 * for that: it is idempotent (one entitlement per campaign+order, enforced by a
 * unique key), it survives a worker crash mid-order, it sees a refund that
 * happened after the grant, and it repairs a missed run. Pushing this into the
 * checkout transaction would mean the till's availability decides whether a
 * reward exists, and a replayed offline sale would need its own deduplication.
 *
 * The sweep is safe to run concurrently: each campaign is serialised by a
 * transaction-scoped advisory lock, the budget is read and written inside that
 * lock, and the unique keys are the final guard if a second worker somehow
 * races past it.
 *
 * ## Budget
 *
 * `totalBudgetRial` is a hard ceiling on money the campaign has consumed:
 * value already paid out **or** still owed. That figure is maintained as the
 * sum of active rows in `growth_campaign_budget_reservations`, updated as a
 * reward is reversed or expires, and never exceeds the budget — a reward that
 * does not fit is refused whole rather than granted part-paid.
 *
 * ## What this file does not do
 *
 * It grants, reverses, expires and pays out. It does not touch the promotion
 * engine, loyalty points, store credit or message campaigns; those stay the
 * canonical primitives they are. In particular a cashback payout posts through
 * `growth.cashback_*` (account 2445), never `loyalty.store_credit_*` (2410) or
 * `promotions.gift_card_*` (2420).
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTenant, withTenantTransaction, withoutTenantScope } from "./db";
import { rialText, type RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import {
  parseCampaignDefinition,
  rewardForSale,
  type CampaignDefinition,
  type CashbackReward,
} from "./campaign-builder";
import {
  CAMPAIGN_REWARD_VALIDITY_DAYS,
  budgetAllows,
  clipToCustomerCap,
  deriveRewardStatus,
  planRedemption,
  remainingRial,
  spendableRial,
  type RewardPosition,
  type RewardStatus,
} from "./campaign-reward-ledger";
import { isUuid } from "./uuid";
// Side-effect import: registers the 2445/5600 posting rules.
import "./campaign-posting-rules";

export class CampaignRewardError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

const DAY_MS = 86_400_000;

/** Orders one sweep pass will look at. A campaign larger than this catches up over later passes. */
export const REWARD_SWEEP_BATCH = 500;

function businessDateOf(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// ── campaign loading ─────────────────────────────────────────────────────────

interface CampaignRow extends Record<string, unknown> {
  id: string;
  status: string;
  activated_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  version_id: string;
  version_number: number;
  definition: unknown;
}

const CAMPAIGN_WITH_VERSION = `
  SELECT c.id, c.status, c.activated_at::text AS activated_at,
         c.starts_at::text AS starts_at, c.ends_at::text AS ends_at,
         v.id AS version_id, v.version_number, v.definition
    FROM growth_campaigns c
    JOIN LATERAL (
      SELECT id, version_number, definition
        FROM growth_campaign_versions
       WHERE campaign_id = c.id
       ORDER BY version_number DESC
       LIMIT 1
    ) v ON true`;

function definitionOf(row: CampaignRow): CampaignDefinition {
  const parsed = parseCampaignDefinition(row.definition);
  if (!parsed.ok) throw new CampaignRewardError("stored_definition_invalid", 500);
  return parsed.definition;
}

interface RewardWindow {
  /** First instant a sale can earn. */
  from: Date;
  /** Last instant (exclusive) a sale can earn. */
  to: Date;
}

/**
 * A campaign earns only for sales after it was activated and inside its own
 * scheduled window. Without this, activating a campaign in November would pay
 * for every October sale the simulation replayed.
 */
function earnWindow(row: CampaignRow, now: Date): RewardWindow | null {
  if (!row.activated_at) return null;
  const from = new Date(row.activated_at);
  if (row.starts_at) {
    const scheduled = new Date(row.starts_at);
    if (scheduled.getTime() > from.getTime()) return windowFrom(scheduled, row, now);
  }
  return windowFrom(from, row, now);
}

function windowFrom(from: Date, row: CampaignRow, now: Date): RewardWindow | null {
  const end = row.ends_at ? new Date(row.ends_at) : null;
  const to = end && end.getTime() < now.getTime() ? end : now;
  if (to.getTime() <= from.getTime()) return null;
  return { from, to };
}

// ── sweep ────────────────────────────────────────────────────────────────────

export interface RewardSweepResult {
  campaignId: string;
  scannedOrders: number;
  granted: number;
  grantedRial: number;
  reversed: number;
  reversedRial: number;
  expired: number;
  expiredRial: number;
  /** Rewards that became spendable on this pass. */
  released: number;
  /** A refund took back more than the customer still had unspent. */
  unrecoveredRial: number;
  /** The campaign's scheduled end passed and it was closed. */
  completed: boolean;
  /** The batch limit was hit; run again to continue. */
  hasMore: boolean;
  /** Exclusions the operator should be able to explain, by reason. */
  skipped: Record<string, number>;
}

async function activeBudgetRial(client: PoolClient, campaignId: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_rial), 0)::text AS total
       FROM growth_campaign_budget_reservations
      WHERE campaign_id = $1 AND released_at IS NULL`,
    [campaignId],
  );
  return Number(rows[0]?.total ?? 0);
}

async function customerEarnedRial(client: PoolClient, campaignId: string, customerId: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(earned_rial - reversed_rial), 0)::text AS total
       FROM growth_reward_entitlements
      WHERE campaign_id = $1 AND customer_id = $2`,
    [campaignId, customerId],
  );
  return Number(rows[0]?.total ?? 0);
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  customer_id: string;
  business_date: string;
  net_paid: string;
  total: string;
  tax: string;
}

interface ExistingEntitlementRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  customer_id: string;
  earned_rial: string;
  redeemed_rial: string;
  reversed_rial: string;
  expired_rial: string;
  unrecovered_rial: string;
  available_at: string;
  expires_at: string;
  status: RewardStatus;
}

interface OrderFactsRow extends Record<string, unknown> {
  id: string;
  order_status: string;
  net_paid: string;
  total: string;
  tax: string;
  business_date: string;
}

/**
 * Runs one campaign's whole reward pass: grants what is owed, takes back what
 * a refund cancelled, expires what lapsed and releases holds that ended.
 *
 * Returns counts rather than throwing on individual orders: one malformed sale
 * must not stop the rest of a campaign from being correct.
 */
export async function sweepCampaignRewards(
  businessId: string,
  campaignId: string,
  options: { now?: Date } = {},
): Promise<RewardSweepResult> {
  if (!isUuid(campaignId)) throw new CampaignRewardError("campaign_not_found", 404);
  const now = options.now ?? new Date();

  return withTenantTransaction(businessId, async (client) => {
    // One lock per campaign: the budget read, the grant and the reservation
    // write must be one serialised decision, whatever else is running.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`growth-campaign-reward:${campaignId}`]);

    const { rows: campaignRows } = await client.query<CampaignRow>(
      `${CAMPAIGN_WITH_VERSION} WHERE c.business_id = $1 AND c.id = $2 FOR UPDATE OF c`,
      [businessId, campaignId],
    );
    const campaign = campaignRows[0];
    if (!campaign) throw new CampaignRewardError("campaign_not_found", 404);

    const result: RewardSweepResult = {
      campaignId,
      scannedOrders: 0,
      granted: 0,
      grantedRial: 0,
      reversed: 0,
      reversedRial: 0,
      expired: 0,
      expiredRial: 0,
      released: 0,
      unrecoveredRial: 0,
      completed: false,
      hasMore: false,
      skipped: {},
    };
    const skip = (reason: string) => {
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    };

    // A campaign whose end has passed is closed rather than left "live" and
    // forever skipping; its rewards stay spendable until they expire.
    if (campaign.status === "live" && campaign.ends_at && new Date(campaign.ends_at).getTime() <= now.getTime()) {
      await client.query(
        `UPDATE growth_campaigns SET status = 'completed', updated_at = now()
          WHERE business_id = $1 AND id = $2 AND status = 'live'`,
        [businessId, campaignId],
      );
      campaign.status = "completed";
      result.completed = true;
    }

    const definition = definitionOf(campaign);
    const window = earnWindow(campaign, now);

    // ── existing positions: refunds, expiry, holds ──────────────────────────
    // The positions are locked first, on their own, because PostgreSQL does
    // not allow `FOR UPDATE` beside `GROUP BY` — and the numbers a refund
    // changes are the aggregate of payments, which must be read after the lock.
    const { rows: existingPositions } = await client.query<ExistingEntitlementRow>(
      `SELECT id, order_id, customer_id,
              earned_rial::text AS earned_rial, redeemed_rial::text AS redeemed_rial,
              reversed_rial::text AS reversed_rial, expired_rial::text AS expired_rial,
              unrecovered_rial::text AS unrecovered_rial,
              available_at::text AS available_at, expires_at::text AS expires_at, status
         FROM growth_reward_entitlements
        WHERE campaign_id = $1 AND business_id = $2
          AND status IN ('pending', 'available', 'partially_redeemed')
        ORDER BY created_at, id
        FOR UPDATE`,
      [campaignId, businessId],
    );

    const factsByOrder = new Map<string, OrderFactsRow>();
    if (existingPositions.length > 0) {
      const { rows: facts } = await client.query<OrderFactsRow>(
        `SELECT o.id, o.status::text AS order_status,
                o.total::text AS total, o.tax::text AS tax,
                COALESCE(SUM(p.amount) FILTER (WHERE p.method <> 'credit'), 0)::text AS net_paid,
                app_business_date(COALESCE(o.closed_at, o.opened_at), l.timezone, l.business_day_start_minutes)::text AS business_date
           FROM orders o
           JOIN locations l ON l.id = o.location_id
           LEFT JOIN payments p ON p.order_id = o.id
          WHERE o.id = ANY($1::uuid[])
          GROUP BY o.id, l.id`,
        [[...new Set(existingPositions.map((row) => row.order_id))]],
      );
      for (const fact of facts) factsByOrder.set(fact.id, fact);
    }

    for (const row of existingPositions) {
      const facts = factsByOrder.get(row.order_id);
      if (!facts) continue; // the order vanished with a cascade; nothing left to reverse
      const position: RewardPosition = {
        earnedRial: Number(row.earned_rial),
        redeemedRial: Number(row.redeemed_rial),
        reversedRial: Number(row.reversed_rial),
        expiredRial: Number(row.expired_rial),
        unrecoveredRial: Number(row.unrecovered_rial),
        availableAt: row.available_at,
        expiresAt: row.expires_at,
      };
      const entryDate = businessDateOf(facts.business_date);

      // 1. A refund, cancellation or un-settlement reduces what was earned.
      const netPaidRial = Number(facts.net_paid);
      const stillEligible = facts.order_status === "completed" && netPaidRial > 0;
      const newReward = stillEligible
        ? rewardForSale(definition.reward, {
            totalRial: Number(facts.total),
            taxRial: Number(facts.tax),
            netPaidRial,
          })
        : 0;

      if (newReward < position.earnedRial) {
        const delta = position.earnedRial - newReward;
        const recoverable = Math.min(delta, remainingRial(position));
        const shortfall = delta - recoverable;
        if (recoverable > 0) {
          const reversedRial = position.reversedRial + recoverable;
          await client.query(
            `INSERT INTO growth_reward_events
               (business_id, entitlement_id, campaign_id, customer_id, event_type, amount_rial, order_id, reason)
             VALUES ($1, $2, $3, $4, 'reversed', $5, $6, $7)`,
            [businessId, row.id, campaignId, row.customer_id, recoverable, row.order_id, "refund_or_cancellation"],
          );
          await emitDomainEvent(client, {
            businessId,
            locationId: null,
            eventType: "growth.cashback_reversed",
            payload: {
              customerId: row.customer_id,
              campaignId,
              amount: rialText(String(recoverable)) as RialText,
              entryDate,
            },
            sourceType: "growth_campaign_reward",
            // A fresh identity per correction: the delta can shrink in a
            // second refund, and each correction is its own journal entry.
            // Re-running the same pass computes a zero delta and posts nothing.
            sourceId: randomUUID(),
            createdBy: null,
          });
          await client.query(
            `UPDATE growth_reward_entitlements
                SET reversed_rial = $2, unrecovered_rial = unrecovered_rial + $3, updated_at = now()
              WHERE id = $1`,
            [row.id, reversedRial, shortfall],
          );
          // The reservation only counts while value is still owed or paid. A
          // fully reversed reward releases it; a partial one keeps the rest.
          // The amount itself never goes to zero (the column is positive); a
          // released row is excluded from the budget by `released_at`.
          await client.query(
            `UPDATE growth_campaign_budget_reservations
                SET released_at = CASE WHEN amount_rial <= $3 THEN now() ELSE released_at END,
                    amount_rial = CASE WHEN amount_rial > $3 THEN amount_rial - $3 ELSE amount_rial END,
                    updated_at = now()
              WHERE campaign_id = $1 AND order_id = $2`,
            [campaignId, row.order_id, recoverable],
          );
          result.reversed += 1;
          result.reversedRial += recoverable;
          position.reversedRial = reversedRial;
        }
        if (shortfall > 0) {
          await client.query(
            `UPDATE growth_reward_entitlements
                SET unrecovered_rial = unrecovered_rial + $2, updated_at = now() WHERE id = $1`,
            [row.id, shortfall],
          );
          position.unrecoveredRial += shortfall;
          result.unrecoveredRial += shortfall;
        }
      }

      // 2. Expiry: value left when the validity window closed.
      const expiredNow = new Date(row.expires_at).getTime() <= now.getTime();
      const remaining = remainingRial(position);
      if (expiredNow && remaining > 0) {
        const expiredRial = position.expiredRial + remaining;
        await client.query(
          `INSERT INTO growth_reward_events
             (business_id, entitlement_id, campaign_id, customer_id, event_type, amount_rial, reason)
           VALUES ($1, $2, $3, $4, 'expired', $5, 'validity_ended')`,
          [businessId, row.id, campaignId, row.customer_id, remaining],
        );
        await emitDomainEvent(client, {
          businessId,
          locationId: null,
          eventType: "growth.cashback_expired",
          payload: {
            customerId: row.customer_id,
            campaignId,
            amount: rialText(String(remaining)) as RialText,
            entryDate,
          },
          sourceType: "growth_campaign_reward",
          // Expiry is guarded by the append-only partial unique index on the
          // ``expired`` event, so it can only ever post once per position.
          sourceId: randomUUID(),
          createdBy: null,
        });
        await client.query(
          `UPDATE growth_reward_entitlements SET expired_rial = $2, updated_at = now() WHERE id = $1`,
          [row.id, expiredRial],
        );
        await client.query(
          `UPDATE growth_campaign_budget_reservations
              SET released_at = CASE WHEN amount_rial <= $3 THEN now() ELSE released_at END,
                  amount_rial = CASE WHEN amount_rial > $3 THEN amount_rial - $3 ELSE amount_rial END,
                  updated_at = now()
            WHERE campaign_id = $1 AND order_id = $2`,
          [campaignId, row.order_id, remaining],
        );
        position.expiredRial = expiredRial;
        result.expired += 1;
        result.expiredRial += remaining;
      }

      // 3. The hold ended: the position is now spendable. No posting — the
      // liability was recognised when it was granted.
      const nextStatus = deriveRewardStatus(position, now);
      if (nextStatus !== row.status) {
        await client.query(`UPDATE growth_reward_entitlements SET status = $2, updated_at = now() WHERE id = $1`, [
          row.id,
          nextStatus,
        ]);
        if (nextStatus === "available" && row.status === "pending") result.released += 1;
      }
    }

    // ── new grants ──────────────────────────────────────────────────────────
    if (campaign.status === "live" && window) {
      const scope = definition.trigger.locationIds;
      const { rows: candidates } = await client.query<CandidateRow>(
        `SELECT o.id, o.location_id, o.customer_id,
                app_business_date(COALESCE(o.closed_at, o.opened_at), l.timezone, l.business_day_start_minutes)::text AS business_date,
                COALESCE(SUM(p.amount) FILTER (WHERE p.method <> 'credit'), 0)::text AS net_paid,
                o.total::text AS total, o.tax::text AS tax
           FROM orders o
           JOIN locations l ON l.id = o.location_id
           LEFT JOIN payments p ON p.order_id = o.id
          WHERE l.business_id = $1
            AND o.status = 'completed'
            AND o.customer_id IS NOT NULL
            -- A website-imported order is not a POS sale; what the online
            -- channel enforces comes from its own adapter, not from here.
            AND NOT EXISTS (SELECT 1 FROM online_order_documents d WHERE d.order_id = o.id)
            AND NOT EXISTS (SELECT 1 FROM online_sale_lines s WHERE s.order_id = o.id)
            AND COALESCE(o.closed_at, o.opened_at) >= $3
            AND COALESCE(o.closed_at, o.opened_at) < $4
            AND ($5::uuid[] IS NULL OR o.location_id = ANY($5::uuid[]))
            AND NOT EXISTS (
              SELECT 1 FROM growth_reward_entitlements e
               WHERE e.campaign_id = $2 AND e.order_id = o.id
            )
          GROUP BY o.id, l.id
          ORDER BY COALESCE(o.closed_at, o.opened_at), o.id
          LIMIT $6`,
        [
          businessId,
          campaignId,
          window.from.toISOString(),
          window.to.toISOString(),
          scope ? [...scope] : null,
          REWARD_SWEEP_BATCH + 1,
        ],
      );

      result.hasMore = candidates.length > REWARD_SWEEP_BATCH;
      const batch = candidates.slice(0, REWARD_SWEEP_BATCH);
      result.scannedOrders = batch.length;

      let budgetUsed = await activeBudgetRial(client, campaignId);
      const customerEarned = new Map<string, number>();

      for (const candidate of batch) {
        const netPaidRial = Number(candidate.net_paid);
        if (netPaidRial <= 0) {
          skip("not_settled");
          continue;
        }
        if (netPaidRial < definition.trigger.minNetPaidRial) {
          skip("below_minimum");
          continue;
        }

        let rewardRial = rewardForSale(definition.reward, {
          totalRial: Number(candidate.total),
          taxRial: Number(candidate.tax),
          netPaidRial,
        });
        if (rewardRial <= 0) {
          skip("no_reward");
          continue;
        }

        if (definition.limits.perCustomerCapRial !== null) {
          if (!customerEarned.has(candidate.customer_id)) {
            customerEarned.set(
              candidate.customer_id,
              await customerEarnedRial(client, campaignId, candidate.customer_id),
            );
          }
          const already = customerEarned.get(candidate.customer_id) ?? 0;
          const clipped = clipToCustomerCap(definition.limits.perCustomerCapRial, already, rewardRial);
          if (clipped === 0) {
            skip("customer_cap_reached");
            continue;
          }
          rewardRial = clipped;
        }

        if (!budgetAllows(budgetUsed, definition.limits.totalBudgetRial, rewardRial)) {
          skip("budget_exhausted");
          continue;
        }

        const availableAt = addDays(new Date(`${candidate.business_date}T00:00:00.000Z`), definition.reward.holdDays);
        const expiresAt = addDays(availableAt, CAMPAIGN_REWARD_VALIDITY_DAYS);
        const entryDate = candidate.business_date;

        await client.query(
          `INSERT INTO growth_campaign_budget_reservations (business_id, campaign_id, order_id, amount_rial)
           VALUES ($1, $2, $3, $4)`,
          [businessId, campaignId, candidate.id, rewardRial],
        );
        const { rows: entitlementRows } = await client.query<{ id: string }>(
          `INSERT INTO growth_reward_entitlements
             (business_id, campaign_id, campaign_version_id, order_id, customer_id, location_id,
              earned_rial, status, available_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            businessId,
            campaignId,
            campaign.version_id,
            candidate.id,
            candidate.customer_id,
            candidate.location_id,
            rewardRial,
            availableAt.getTime() <= now.getTime() ? "available" : "pending",
            availableAt.toISOString(),
            expiresAt.toISOString(),
          ],
        );
        const entitlementId = entitlementRows[0].id;

        const { rows: eventRows } = await client.query<{ id: string }>(
          `INSERT INTO growth_reward_events
             (business_id, entitlement_id, campaign_id, customer_id, event_type, amount_rial, order_id, reason)
           VALUES ($1, $2, $3, $4, 'earned', $5, $6, 'settled_sale')
           RETURNING id`,
          [businessId, entitlementId, campaignId, candidate.customer_id, rewardRial, candidate.id],
        );

        await emitDomainEvent(client, {
          businessId,
          locationId: candidate.location_id,
          eventType: "growth.cashback_earned",
          payload: {
            customerId: candidate.customer_id,
            campaignId,
            orderId: candidate.id,
            amount: rialText(String(rewardRial)) as RialText,
            entryDate,
          },
          sourceType: "growth_campaign_reward",
          // The reward event's own row id: unique per grant, so two rewards on
          // the same order (never possible, but the ledger must not assume it)
          // still post separately.
          sourceId: eventRows[0].id,
          createdBy: null,
        });

        budgetUsed += rewardRial;
        customerEarned.set(candidate.customer_id, (customerEarned.get(candidate.customer_id) ?? 0) + rewardRial);
        result.granted += 1;
        result.grantedRial += rewardRial;
      }
    }

    return result;
  });
}

/** One pass over every live campaign of a business — what the background tick and the screen's «اجرا» button call. */
export async function sweepBusinessCampaignRewards(
  businessId: string,
  options: { now?: Date } = {},
): Promise<RewardSweepResult[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM growth_campaigns
      WHERE business_id = $1 AND status IN ('live', 'paused')
      ORDER BY created_at, id`,
    [businessId],
  );
  const results: RewardSweepResult[] = [];
  for (const row of rows) {
    results.push(await sweepCampaignRewards(businessId, row.id, options));
  }
  return results;
}

// ── redemption ───────────────────────────────────────────────────────────────

export interface RewardRedemptionResult {
  redemptionId: string;
  amountRial: number;
  payoutMethod: "cash" | "bank";
  entryId: string | null;
  /** True when the request key had already paid; nothing new was posted. */
  replayed: boolean;
  /** What the customer still has available after this payout. */
  availableRialAfter: number;
}

interface SpendableRow extends Record<string, unknown> {
  id: string;
  earned_rial: string;
  redeemed_rial: string;
  reversed_rial: string;
  expired_rial: string;
  unrecovered_rial: string;
  available_at: string;
  expires_at: string;
}

/** What a customer can spend right now, without locking anything — the replay/read path. */
async function availableRialFor(businessId: string, customerId: string, now: Date): Promise<number> {
  const { rows } = await query<Record<string, string>>(
    `SELECT earned_rial::text AS earned_rial, redeemed_rial::text AS redeemed_rial,
            reversed_rial::text AS reversed_rial, expired_rial::text AS expired_rial,
            unrecovered_rial::text AS unrecovered_rial,
            available_at::text AS available_at, expires_at::text AS expires_at
       FROM growth_reward_entitlements
      WHERE business_id = $1 AND customer_id = $2
        AND status IN ('pending', 'available', 'partially_redeemed')`,
    [businessId, customerId],
  );
  return rows.reduce(
    (total, row) =>
      total +
      spendableRial(
        {
          earnedRial: Number(row.earned_rial),
          redeemedRial: Number(row.redeemed_rial),
          reversedRial: Number(row.reversed_rial),
          expiredRial: Number(row.expired_rial),
          unrecoveredRial: Number(row.unrecovered_rial),
          availableAt: row.available_at,
          expiresAt: row.expires_at,
        },
        now,
      ),
    0,
  );
}

/** Every active position for a customer, locked for the payout decision. */
async function spendablePositions(
  client: PoolClient,
  businessId: string,
  customerId: string,
): Promise<{ id: string; position: RewardPosition }[]> {
  const { rows } = await client.query<SpendableRow>(
    `SELECT id, earned_rial::text AS earned_rial, redeemed_rial::text AS redeemed_rial,
            reversed_rial::text AS reversed_rial, expired_rial::text AS expired_rial,
            unrecovered_rial::text AS unrecovered_rial,
            available_at::text AS available_at, expires_at::text AS expires_at
       FROM growth_reward_entitlements
      WHERE business_id = $1 AND customer_id = $2
        AND status IN ('pending', 'available', 'partially_redeemed')
      ORDER BY expires_at, available_at, id
      FOR UPDATE`,
    [businessId, customerId],
  );
  return rows.map((row) => ({
    id: row.id,
    position: {
      earnedRial: Number(row.earned_rial),
      redeemedRial: Number(row.redeemed_rial),
      reversedRial: Number(row.reversed_rial),
      expiredRial: Number(row.expired_rial),
      unrecoveredRial: Number(row.unrecovered_rial),
      availableAt: row.available_at,
      expiresAt: row.expires_at,
    },
  }));
}

/**
 * Pays a customer's available campaign rewards out, atomically.
 *
 * `requestKey` is the caller's idempotency key (a UUID it generates once and
 * reuses on retry). A repeated key returns the original result without paying
 * twice. The balance is read under a per-customer advisory lock and the
 * positions are locked `FOR UPDATE`, so two tills redeeming at once cannot
 * both spend the same Rial.
 */
export async function redeemCampaignReward(
  businessId: string,
  input: {
    customerId: string;
    amountRial: number;
    payoutMethod: "cash" | "bank";
    requestKey: string;
    actorId: string | null;
    businessDate: string;
    locationId?: string | null;
    /** Deterministic "now" for a backfill or a test; the till always omits it. */
    now?: Date;
  },
): Promise<RewardRedemptionResult> {
  if (!isUuid(input.customerId)) throw new CampaignRewardError("customer_not_found", 404);
  if (!Number.isSafeInteger(input.amountRial) || input.amountRial <= 0) {
    throw new CampaignRewardError("amount_invalid", 400);
  }
  if (input.payoutMethod !== "cash" && input.payoutMethod !== "bank") {
    throw new CampaignRewardError("payout_method_invalid", 400);
  }
  if (typeof input.requestKey !== "string" || input.requestKey.trim().length < 8 || input.requestKey.length > 128) {
    throw new CampaignRewardError("request_key_invalid", 400);
  }
  const businessDate = input.businessDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new CampaignRewardError("business_date_invalid", 400);

  return withTenantTransaction(businessId, async (client) => {
    const { rows: existing } = await client.query<{
      id: string;
      amount_rial: string;
      payout_method: "cash" | "bank";
      entry_id: string | null;
    }>(
      `SELECT id, amount_rial::text AS amount_rial, payout_method, entry_id
         FROM growth_reward_redemptions
        WHERE business_id = $1 AND request_key = $2`,
      [businessId, input.requestKey],
    );
    if (existing[0]) {
      const available = await availableRialFor(businessId, input.customerId, input.now ?? new Date());
      return {
        redemptionId: existing[0].id,
        amountRial: Number(existing[0].amount_rial),
        payoutMethod: existing[0].payout_method,
        entryId: existing[0].entry_id,
        replayed: true,
        availableRialAfter: available,
      };
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `growth-customer-reward:${businessId}:${input.customerId}`,
    ]);

    const now = input.now ?? new Date();
    const positions = await spendablePositions(client, businessId, input.customerId);
    const plan = planRedemption(
      positions.map((row) => ({ entitlementId: row.id, ...row.position })),
      input.amountRial,
      now,
    );
    if (!plan.ok) {
      throw new CampaignRewardError(
        plan.reason === "insufficient" ? "reward_balance_insufficient" : "amount_invalid",
        plan.reason === "insufficient" ? 409 : 400,
        { availableRial: plan.availableRial },
      );
    }

    const { rows: redemptionRows } = await client.query<{ id: string }>(
      `INSERT INTO growth_reward_redemptions
         (business_id, customer_id, amount_rial, payout_method, request_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [businessId, input.customerId, input.amountRial, input.payoutMethod, input.requestKey, input.actorId],
    );
    const redemptionId = redemptionRows[0].id;

    const byId = new Map(positions.map((row) => [row.id, row.position]));
    for (const allocation of plan.plan.allocations) {
      const position = byId.get(allocation.entitlementId)!;
      const redeemedRial = position.redeemedRial + allocation.amountRial;
      const after: RewardPosition = { ...position, redeemedRial };
      await client.query(
        `INSERT INTO growth_reward_events
           (business_id, entitlement_id, campaign_id, customer_id, event_type, amount_rial, redemption_id, reason)
         SELECT $1, e.id, e.campaign_id, e.customer_id, 'redeemed', $3, $4, 'wallet_payout'
           FROM growth_reward_entitlements e WHERE e.id = $2`,
        [businessId, allocation.entitlementId, allocation.amountRial, redemptionId],
      );
      await client.query(
        `UPDATE growth_reward_entitlements
            SET redeemed_rial = $2, status = $3, updated_at = now()
          WHERE id = $1`,
        [allocation.entitlementId, redeemedRial, deriveRewardStatus(after, now)],
      );
    }

    const { entryId } = await emitDomainEvent(client, {
      businessId,
      locationId: input.locationId ?? null,
      eventType: "growth.cashback_redeemed",
      payload: {
        customerId: input.customerId,
        amount: rialText(String(input.amountRial)) as RialText,
        payoutMethod: input.payoutMethod,
        entryDate: businessDate,
      },
      sourceType: "growth_cashback_redemption",
      sourceId: redemptionId,
      createdBy: input.actorId,
    });
    if (entryId) {
      await client.query(`UPDATE growth_reward_redemptions SET entry_id = $2 WHERE id = $1`, [redemptionId, entryId]);
    }

    return {
      redemptionId,
      amountRial: input.amountRial,
      payoutMethod: input.payoutMethod,
      entryId,
      replayed: false,
      availableRialAfter: plan.plan.leftoverRial,
    };
  });
}

// ── reads ────────────────────────────────────────────────────────────────────

export interface RewardWalletEntry {
  entitlementId: string;
  campaignId: string;
  campaignName: string;
  orderId: string;
  earnedRial: number;
  remainingRial: number;
  spendableRial: number;
  availableAt: string;
  expiresAt: string;
  status: RewardStatus;
}

export interface RewardWallet {
  customerId: string;
  spendableRial: number;
  pendingRial: number;
  redeemedRial: number;
  expiredRial: number;
  reversedRial: number;
  entries: RewardWalletEntry[];
}

/** A customer's campaign rewards, as the till shows them. Read-only. */
export async function campaignRewardWallet(businessId: string, customerId: string): Promise<RewardWallet> {
  if (!isUuid(customerId)) throw new CampaignRewardError("customer_not_found", 404);
  const now = new Date();
  const { rows } = await query<{
    id: string;
    campaign_id: string;
    campaign_name: string;
    order_id: string;
    earned_rial: string;
    redeemed_rial: string;
    reversed_rial: string;
    expired_rial: string;
    unrecovered_rial: string;
    available_at: string;
    expires_at: string;
    status: RewardStatus;
  }>(
    `SELECT e.id, e.campaign_id, c.name AS campaign_name, e.order_id,
            e.earned_rial::text AS earned_rial, e.redeemed_rial::text AS redeemed_rial,
            e.reversed_rial::text AS reversed_rial, e.expired_rial::text AS expired_rial,
            e.unrecovered_rial::text AS unrecovered_rial,
            e.available_at::text AS available_at, e.expires_at::text AS expires_at, e.status
       FROM growth_reward_entitlements e
       JOIN growth_campaigns c ON c.id = e.campaign_id
      WHERE e.business_id = $1 AND e.customer_id = $2
      ORDER BY e.created_at DESC
      LIMIT 200`,
    [businessId, customerId],
  );

  const wallet: RewardWallet = {
    customerId,
    spendableRial: 0,
    pendingRial: 0,
    redeemedRial: 0,
    expiredRial: 0,
    reversedRial: 0,
    entries: [],
  };
  for (const row of rows) {
    const position: RewardPosition = {
      earnedRial: Number(row.earned_rial),
      redeemedRial: Number(row.redeemed_rial),
      reversedRial: Number(row.reversed_rial),
      expiredRial: Number(row.expired_rial),
      unrecoveredRial: Number(row.unrecovered_rial),
      availableAt: row.available_at,
      expiresAt: row.expires_at,
    };
    const remaining = remainingRial(position);
    const spendable = spendableRial(position, now);
    wallet.spendableRial += spendable;
    wallet.pendingRial += remaining - spendable;
    wallet.redeemedRial += position.redeemedRial;
    wallet.expiredRial += position.expiredRial;
    wallet.reversedRial += position.reversedRial;
    wallet.entries.push({
      entitlementId: row.id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      orderId: row.order_id,
      earnedRial: position.earnedRial,
      remainingRial: remaining,
      spendableRial: spendable,
      availableAt: row.available_at,
      expiresAt: row.expires_at,
      status: row.status,
    });
  }
  return wallet;
}

export interface CampaignRewardReportRow {
  campaignId: string;
  name: string;
  status: string;
  activatedAt: string | null;
  endsAt: string | null;
  budgetRial: number;
  /** Budget consumed: paid out or still owed. */
  usedRial: number;
  /** Budget not yet committed to any reward. */
  remainingBudgetRial: number;
  earnedRial: number;
  availableRial: number;
  pendingRial: number;
  redeemedRial: number;
  expiredRial: number;
  reversedRial: number;
  unrecoveredRial: number;
  customers: number;
  orders: number;
  /** True when the campaign can no longer grant because its budget is exhausted. */
  budgetExhausted: boolean;
}

/**
 * The Growth screen's campaign money table. Every figure comes from the
 * position and event tables; nothing here is a stored counter, so it can never
 * disagree with the ledger.
 */
export async function campaignRewardReport(businessId: string): Promise<CampaignRewardReportRow[]> {
  const { rows } = await query<Record<string, string | null>>(
    `SELECT c.id AS campaign_id, c.name, c.status::text AS status,
            c.activated_at::text AS activated_at, c.ends_at::text AS ends_at,
            COALESCE((v.definition->'limits'->>'totalBudgetRial')::bigint, 0)::text AS budget_rial,
            COALESCE((SELECT SUM(r.amount_rial) FROM growth_campaign_budget_reservations r
                       WHERE r.campaign_id = c.id AND r.released_at IS NULL), 0)::text AS used_rial,
            COALESCE(e.earned, 0)::text AS earned_rial,
            COALESCE(e.redeemed, 0)::text AS redeemed_rial,
            COALESCE(e.expired, 0)::text AS expired_rial,
            COALESCE(e.reversed, 0)::text AS reversed_rial,
            COALESCE(e.unrecovered, 0)::text AS unrecovered_rial,
            COALESCE(e.customers, 0)::text AS customers,
            COALESCE(e.orders, 0)::text AS orders,
            COALESCE(e.available, 0)::text AS available_rial,
            COALESCE(e.pending, 0)::text AS pending_rial
       FROM growth_campaigns c
       JOIN LATERAL (
         SELECT definition FROM growth_campaign_versions
          WHERE campaign_id = c.id ORDER BY version_number DESC LIMIT 1
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT SUM(earned_rial) AS earned,
                SUM(redeemed_rial) AS redeemed,
                SUM(expired_rial) AS expired,
                SUM(reversed_rial) AS reversed,
                SUM(unrecovered_rial) AS unrecovered,
                COUNT(DISTINCT customer_id) AS customers,
                COUNT(*) AS orders,
                SUM(CASE WHEN available_at <= now() AND expires_at > now()
                         THEN GREATEST(earned_rial - redeemed_rial - reversed_rial - expired_rial, 0) ELSE 0 END) AS available,
                SUM(CASE WHEN available_at > now()
                         THEN GREATEST(earned_rial - redeemed_rial - reversed_rial - expired_rial, 0) ELSE 0 END) AS pending
           FROM growth_reward_entitlements
          WHERE campaign_id = c.id
       ) e ON true
      WHERE c.business_id = $1
      ORDER BY (c.status = 'archived'), c.created_at DESC`,
    [businessId],
  );

  return rows.map((row) => {
    const budget = Number(row.budget_rial ?? 0);
    const used = Number(row.used_rial ?? 0);
    return {
      campaignId: String(row.campaign_id),
      name: String(row.name),
      status: String(row.status),
      activatedAt: row.activated_at ?? null,
      endsAt: row.ends_at ?? null,
      budgetRial: budget,
      usedRial: used,
      remainingBudgetRial: Math.max(0, budget - used),
      earnedRial: Number(row.earned_rial ?? 0),
      availableRial: Number(row.available_rial ?? 0),
      pendingRial: Number(row.pending_rial ?? 0),
      redeemedRial: Number(row.redeemed_rial ?? 0),
      expiredRial: Number(row.expired_rial ?? 0),
      reversedRial: Number(row.reversed_rial ?? 0),
      unrecoveredRial: Number(row.unrecovered_rial ?? 0),
      customers: Number(row.customers ?? 0),
      orders: Number(row.orders ?? 0),
      budgetExhausted: budget > 0 && used >= budget,
    };
  });
}

/** The financial effect of the reward ledger as the books hold it, per phase. */
export async function cashbackLiabilitySummary(
  businessId: string,
): Promise<{ earnedRial: number; redeemedRial: number; reversedRial: number; expiredRial: number; outstandingRial: number }> {
  const { rows } = await query<Record<string, string>>(
    `SELECT COALESCE(SUM(CASE WHEN event_type = 'earned' THEN amount_rial ELSE 0 END), 0)::text AS earned,
            COALESCE(SUM(CASE WHEN event_type = 'redeemed' THEN amount_rial ELSE 0 END), 0)::text AS redeemed,
            COALESCE(SUM(CASE WHEN event_type = 'reversed' THEN amount_rial ELSE 0 END), 0)::text AS reversed,
            COALESCE(SUM(CASE WHEN event_type = 'expired' THEN amount_rial ELSE 0 END), 0)::text AS expired
       FROM growth_reward_events WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0] ?? {};
  const earnedRial = Number(row.earned ?? 0);
  const redeemedRial = Number(row.redeemed ?? 0);
  const reversedRial = Number(row.reversed ?? 0);
  const expiredRial = Number(row.expired ?? 0);
  return {
    earnedRial,
    redeemedRial,
    reversedRial,
    expiredRial,
    outstandingRial: Math.max(0, earnedRial - redeemedRial - reversedRial - expiredRial),
  };
}

// ── the background tick ──────────────────────────────────────────────────────

/** Every two minutes; a grant a couple of minutes after the sale is the intended latency. */
export const GROWTH_REWARD_TICK_INTERVAL_MS = 2 * 60 * 1000;

export interface GrowthRewardTickResult {
  businesses: number;
  campaigns: number;
  granted: number;
  grantedRial: number;
  reversed: number;
  expired: number;
  failed: number;
}

/**
 * One pass over every business that has a live campaign. Businesses are
 * enumerated under the documented platform bypass and each one's work is then
 * wrapped in `withTenant`, exactly like every other tick.
 */
export async function runGrowthRewardTick(now: Date = new Date()): Promise<GrowthRewardTickResult> {
  const { rows } = await withoutTenantScope(
    "growth reward tick — enumerating businesses with a live campaign",
    () =>
      query<{ business_id: string }>(
        `SELECT DISTINCT business_id FROM growth_campaigns
          WHERE status = 'live' ORDER BY business_id`,
      ),
  );

  const total: GrowthRewardTickResult = {
    businesses: rows.length,
    campaigns: 0,
    granted: 0,
    grantedRial: 0,
    reversed: 0,
    expired: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      const results = await withTenant(row.business_id, () =>
        sweepBusinessCampaignRewards(row.business_id, { now }),
      );
      total.campaigns += results.length;
      for (const result of results) {
        total.granted += result.granted;
        total.grantedRial += result.grantedRial;
        total.reversed += result.reversed;
        total.expired += result.expired;
      }
    } catch (error) {
      // One business's broken campaign must not stop the next business's run.
      console.error(`growth reward tick failed for business ${row.business_id}:`, error);
      total.failed += 1;
    }
  }

  return total;
}

/** Exposed for the screen's «اجرا» button: one campaign, one pass. */
export async function runSingleCampaignSweep(
  businessId: string,
  campaignId: string,
): Promise<RewardSweepResult> {
  return withTenant(businessId, () => sweepCampaignRewards(businessId, campaignId));
}

/** The reward of one order for a campaign, without writing anything — the POS receipt's explanation. */
export function expectedRewardForOrder(
  reward: CashbackReward,
  sale: { totalRial: number; taxRial: number; netPaidRial: number },
): number {
  return rewardForSale(reward, sale);
}

