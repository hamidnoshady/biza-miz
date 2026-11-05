/**
 * Issue #894 Wave 5b — the queue behind the Product Webhook: fill, drain, settle.
 *
 * Three functions and one tick, and the split is the whole design:
 *
 *   **fill** (`enqueueChangedPages`) reads the *built feed* — the same
 *   `readShopCatalogue` the crawler is served from — and queues one row per page
 *   whose `date_updated` is newer than what we last queued. So the platform never
 *   announces something it would not serve, and never has to guess what "changed"
 *   means at a call site: the feed is the definition.
 *
 *   **drain** (`drainWebhookQueue`) claims due rows, sends at most
 *   `TOROB_WEBHOOK_BATCHES_PER_RUN` batches of at most 100, and settles each row to
 *   `sent`, back to `pending` with a delay, or `dead`. Settlement is by *batch*,
 *   because Torob's answer is per request: a 400 refuses all 100 pages in it.
 *
 *   **settle policy** lives in `webhook.ts` (`afterWebhookFailure`) so this file
 *   never decides that a revoked token deserves another try.
 *
 * The claim is deliberately not a lease table. It pushes `next_attempt_at` forward
 * by `CLAIM_LEASE_MS` inside one `FOR UPDATE SKIP LOCKED` statement, so two drains
 * — two ticks, or a tick and a merchant's «ارسال اکنون» — cannot send the same row
 * twice, and a crash between claim and send costs one lease rather than a lost
 * notice. At-least-once is the right side of that trade here: the webhook's only
 * effect is "please re-fetch", and fetching a page twice is free.
 *
 * What this file refuses to do, in the spirit of §6e: **stop when the channel is
 * off**. A shop that is not authorized, whose switch is off, or whose website is
 * gone is not drained at all. The issue is explicit that disconnecting stops
 * managed background operations — and a queue that keeps announcing pages for a
 * shop the merchant switched off is the platform talking behind their back.
 */
import { query, withoutTenantScope, withTenant, withTenantTransaction } from "../db";
import { backoffDelayMs } from "../integrations/retry";
import { readShopCatalogue } from "./feed-service";
import { readTorobShop, readTorobShopToken, TorobShopError } from "./shop-service";
import {
  TOROB_WEBHOOK_BATCHES_PER_RUN,
  TOROB_WEBHOOK_MAX_ATTEMPTS,
  afterWebhookFailure,
  hostOf,
  planWebhookBatches,
  webhookBody,
  type TorobWebhookError,
  type WebhookItem,
} from "./webhook";
import { TorobWebhookClientError, sendTorobWebhook } from "./webhook-client";

/** How long a claim holds a row before another drain may take it. */
const CLAIM_LEASE_MS = 5 * 60_000;

/** `server.ts`'s cadence: a minute, like every other outbox tick. */
export const TOROB_WEBHOOK_TICK_INTERVAL_MS = 60_000;

/** What one fill did. */
export interface FillResult {
  /** Pages newly queued (including coalesced re-arms). */
  queued: number;
  /** Rows removed because the page is no longer in the shop's feed at all. */
  dropped: number;
}

/**
 * Queue every page of the shop's feed whose product changed since it was last
 * queued, and forget the pages that left the feed.
 *
 * The comparison is on `date_updated` from the **feed item**, not on a change log
 * we do not have: a shop that edits a price and edits it back still has a newer
 * `date_updated`, and letting Torob re-fetch is cheaper and more honest than
 * deciding the edit did not matter.
 *
 * Deleting rows for pages that left the feed is the other half of honesty: a
 * product the merchant excluded (§6d) or withdrew must not be announced, because
 * the announcement would invite Torob to fetch a page the shop no longer serves
 * it — and the feed is where that decision already lives.
 */
export async function enqueueChangedPages(input: {
  businessId: string;
  shopId: string;
}): Promise<FillResult> {
  const catalogue = await readShopCatalogue(input);
  if (!catalogue) throw new TorobShopError("shop_not_found");

  // `added` is a page Torob has never been told about; `updated` is one it has.
  // Read from the outbox's own history rather than from a second column, so the
  // two can never disagree about whether Torob knows this page exists.
  const { rows: sentRows } = await query<{ page_unique: string }>(
    `SELECT page_unique FROM torob_webhook_outbox
      WHERE business_id = $1 AND shop_id = $2 AND state = 'sent'`,
    [input.businessId, input.shopId],
  );
  const announced = new Set(sentRows.map((row) => row.page_unique));

  const items: WebhookItem[] = catalogue.built.items.map((item) => ({
    pageUnique: item.page_unique,
    pageUrl: item.page_url,
    reason: announced.has(item.page_unique) ? "updated" : "added",
    pageUpdatedAt: item.date_updated ?? item.date_added ?? null,
  }));

  return withTenantTransaction(input.businessId, async () => {
    let queued = 0;
    for (const item of items) {
      // Coalescing: one row per page. A row already `sent` starts a fresh cycle —
      // attempts back to zero, because this is a new change, not a retry of the old
      // announcement. A `pending` row keeps its attempts and simply becomes due
      // again, which is what stops a busy shop from resetting its own backoff.
      const { rowCount } = await query(
        `INSERT INTO torob_webhook_outbox
           (business_id, shop_id, page_unique, page_url, reason, state,
            attempts, next_attempt_at, last_error, page_updated_at, first_enqueued_at, sent_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', 0, now(), NULL, $6, now(), NULL)
         ON CONFLICT (business_id, shop_id, page_unique) DO UPDATE
            SET page_url = EXCLUDED.page_url,
                page_updated_at = EXCLUDED.page_updated_at,
                reason = CASE WHEN torob_webhook_outbox.state = 'sent' THEN 'updated' ELSE torob_webhook_outbox.reason END,
                attempts = CASE WHEN torob_webhook_outbox.state = 'sent' THEN 0 ELSE torob_webhook_outbox.attempts END,
                next_attempt_at = CASE
                    WHEN torob_webhook_outbox.state = 'pending' THEN LEAST(torob_webhook_outbox.next_attempt_at, now())
                    ELSE now()
                END,
                state = 'pending',
                sent_at = NULL,
                last_error = NULL,
                updated_at = now()
          WHERE torob_webhook_outbox.page_updated_at IS DISTINCT FROM EXCLUDED.page_updated_at
             OR torob_webhook_outbox.state <> 'pending'
             OR torob_webhook_outbox.page_url IS DISTINCT FROM EXCLUDED.page_url`,
        [
          input.businessId,
          input.shopId,
          item.pageUnique,
          item.pageUrl,
          item.reason,
          item.pageUpdatedAt,
        ],
      );
      queued += rowCount ?? 0;
    }

    // Pages that left the feed: not announced, and their queue rows are gone.
    const keep = items.map((item) => item.pageUnique);
    const removed = await query(
      `DELETE FROM torob_webhook_outbox
        WHERE business_id = $1 AND shop_id = $2 AND NOT (page_unique = ANY($3::text[]))`,
      [input.businessId, input.shopId, keep],
    );

    return { queued, dropped: removed.rowCount ?? 0 };
  });
}

/** What one drain did. */
export interface DrainResult {
  sentPages: number;
  batches: number;
  accepted: number;
  failed: number;
  deadLettered: number;
  /** Why the drain stopped early, when it did — the closed vocabulary of the queue. */
  stoppedBy: TorobWebhookError | null;
}

/**
 * Send what is due for one shop.
 *
 * Returns counts rather than throwing for every Torob refusal: the caller is a tick
 * or a button, and both have to keep going. A missing shop is still a bad request
 * and still throws.
 */
export async function drainWebhookQueue(input: {
  businessId: string;
  shopId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  maxBatches?: number;
  /** For tests: skips the `GET /shop/` pre-flight. */
  skipPreflight?: boolean;
}): Promise<DrainResult> {
  const shop = await readTorobShop({ businessId: input.businessId, shopId: input.shopId });
  if (!shop) throw new TorobShopError("shop_not_found");

  const result: DrainResult = {
    sentPages: 0,
    batches: 0,
    accepted: 0,
    failed: 0,
    deadLettered: 0,
    stoppedBy: null,
  };

  // Disconnect means stop: both of these are answered before any network call.
  if (shop.authorizationState !== "authorized") return { ...result, stoppedBy: "unauthorized" };
  if (!shop.enabled) return { ...result, stoppedBy: "not_configured" };

  const env = input.env ?? process.env;
  const credential = await readTorobShopToken({ businessId: input.businessId, shopId: input.shopId });
  // The webhook token is a **shop** token: one per shop domain, issued by Torob.
  // A deployment-level token covers a platform that had them issued centrally;
  // a generator token cannot send this at all.
  const token =
    (credential?.token ?? "").trim() || (env.TOROB_WEBHOOK_TOKEN ?? "").trim() || "";
  if (!token) return { ...result, stoppedBy: "not_configured" };

  const maxBatches = Math.max(1, input.maxBatches ?? TOROB_WEBHOOK_BATCHES_PER_RUN);
  for (let index = 0; index < maxBatches; index += 1) {
    const claimed = await claimDuePages(input.businessId, shop.id);
    if (claimed.length === 0) break;

    const { batches, dropped } = planWebhookBatches({ items: claimed, domain: shop.domain });
    // Rows the rules refuse are settled as dead here, beside the reason: leaving a
    // foreign-host page in `pending` would make it due forever and starve the shop.
    if (dropped > 0) {
      const keep = new Set(batches.flat().map((item) => item.pageUnique));
      const rejected = claimed.filter((item) => !keep.has(item.pageUnique)).map((item) => item.pageUnique);
      if (rejected.length > 0) {
        await settle(input.businessId, shop.id, rejected, {
          state: "dead",
          attempts: TOROB_WEBHOOK_MAX_ATTEMPTS,
          error: "domain_mismatch",
        });
        result.deadLettered += rejected.length;
      }
    }
    if (batches.length === 0) break;

    const batch = batches[0];
    const startedAt = new Date();
    result.batches += 1;
    try {
      await sendTorobWebhook({
        token,
        body: webhookBody(batch),
        env,
        fetchImpl: input.fetchImpl,
      });
      await settle(input.businessId, shop.id, batch.map((item) => item.pageUnique), {
        state: "sent",
        attempts: 0,
        error: null,
      });
      await recordBatch(input.businessId, shop.id, {
        items: batch.length,
        outcome: "accepted",
        error: null,
        pageUniques: batch.map((item) => item.pageUnique),
        startedAt,
      });
      result.sentPages += batch.length;
      result.accepted += 1;
    } catch (caught) {
      if (!(caught instanceof TorobWebhookClientError)) throw caught;
      result.failed += 1;
      const pageUniques = batch.map((item) => item.pageUnique);
      // Settlement is per row, because attempts differ: the queue is coalesced, and
      // one row may already be on its fifth try while another is on its first.
      const outcome = await settleFailure(input.businessId, shop.id, claimed, pageUniques, caught.code);
      result.deadLettered += outcome.dead;
      await recordBatch(input.businessId, shop.id, {
        items: 0,
        outcome: "failed",
        error: caught.code,
        pageUniques: [],
        startedAt,
      });
      result.stoppedBy = caught.code;
      // A refused credential or an inactive shop is not worth another batch this
      // run; a rate limit is exactly what spacing fixes, so it continues.
      if (caught.code !== "rate_limited" && caught.code !== "provider_error" && caught.code !== "timeout") break;
    }
  }

  return result;
}

/**
 * Claim up to 100 due pages for one shop, pushing their next attempt forward so a
 * concurrent drain cannot send them too.
 */
async function claimDuePages(businessId: string, shopId: string): Promise<WebhookItem[]> {
  const { rows } = await query<{
    page_unique: string;
    page_url: string;
    reason: "added" | "updated";
    page_updated_at: Date | null;
  }>(
    `WITH due AS (
       SELECT id FROM torob_webhook_outbox
        WHERE business_id = $1 AND shop_id = $2 AND state = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at, page_unique
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     )
     UPDATE torob_webhook_outbox o
        SET next_attempt_at = now() + ($3::int * interval '1 millisecond'),
            updated_at = now()
       FROM due
      WHERE o.id = due.id
      RETURNING o.page_unique, o.page_url, o.reason, o.page_updated_at`,
    [businessId, shopId, CLAIM_LEASE_MS],
  );
  return rows.map((row) => ({
    pageUnique: row.page_unique,
    pageUrl: row.page_url,
    reason: row.reason,
    pageUpdatedAt: row.page_updated_at ? row.page_updated_at.toISOString() : null,
  }));
}

/** Mark rows sent, and clear the failure they may have carried. */
async function settle(
  businessId: string,
  shopId: string,
  pageUniques: readonly string[],
  input: { state: "sent" | "pending" | "dead"; attempts: number; error: TorobWebhookError | null; delayMs?: number },
): Promise<void> {
  if (pageUniques.length === 0) return;
  await query(
    `UPDATE torob_webhook_outbox
        SET state = $4,
            attempts = $5,
            last_error = $6,
            sent_at = CASE WHEN $4 = 'sent' THEN now() ELSE NULL END,
            next_attempt_at = CASE WHEN $4 = 'pending' THEN now() + ($7::int * interval '1 millisecond') ELSE now() END,
            updated_at = now()
      WHERE business_id = $1 AND shop_id = $2 AND page_unique = ANY($3::text[])`,
    [businessId, shopId, [...pageUniques], input.state, input.attempts, input.error, input.delayMs ?? 0],
  );
}

/** Settle one failed batch, row by row, using each row's own attempt count. */
async function settleFailure(
  businessId: string,
  shopId: string,
  claimed: readonly WebhookItem[],
  pageUniques: readonly string[],
  error: TorobWebhookError,
): Promise<{ dead: number }> {
  const { rows } = await query<{ page_unique: string; attempts: number }>(
    `SELECT page_unique, attempts FROM torob_webhook_outbox
      WHERE business_id = $1 AND shop_id = $2 AND page_unique = ANY($3::text[])`,
    [businessId, shopId, [...pageUniques]],
  );
  let dead = 0;
  for (const row of rows) {
    const outcome = afterWebhookFailure(row.attempts, error, (attempt) => backoffDelayMs(attempt));
    if (outcome.state === "dead") dead += 1;
    await settle(businessId, shopId, [row.page_unique], {
      state: outcome.state,
      attempts: outcome.attempts,
      error,
      delayMs: outcome.delayMs,
    });
  }
  // A shop whose credential Torob refuses is not healthy, whichever row was first.
  if (error === "unauthorized" || error === "shop_not_active") {
    await query(
      `UPDATE torob_shops
          SET health = 'attention', health_reason = $3, last_checked_at = now(), updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [shopId, businessId, error],
    );
  }
  return { dead };
}

async function recordBatch(
  businessId: string,
  shopId: string,
  input: {
    items: number;
    outcome: "accepted" | "failed";
    error: TorobWebhookError | null;
    pageUniques: string[];
    startedAt: Date;
  },
): Promise<void> {
  await query(
    `INSERT INTO torob_webhook_batches
       (business_id, shop_id, items, outcome, error, page_uniques, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [businessId, shopId, input.items, input.outcome, input.error, input.pageUniques, input.startedAt],
  );
}

/** One shop's queue, as a screen shows it. */
export interface WebhookQueueView {
  counts: { pending: number; sent: number; dead: number };
  /** The oldest page still waiting, so "how far behind" has an answer. */
  oldestPendingAt: string | null;
  /** Pages currently stopped, newest first — what a merchant may retry. */
  dead: { pageUnique: string; pageUrl: string; error: TorobWebhookError | null; attempts: number }[];
  batches: {
    items: number;
    outcome: "accepted" | "failed";
    error: TorobWebhookError | null;
    finishedAt: string;
  }[];
}

export async function readWebhookQueue(input: {
  businessId: string;
  shopId: string;
}): Promise<WebhookQueueView | null> {
  const shop = await readTorobShop(input);
  if (!shop) return null;

  const [counts, dead, batches] = await Promise.all([
    query<{ state: string; count: string; oldest: Date | null }>(
      `SELECT state, count(*)::text AS count, min(first_enqueued_at) AS oldest
         FROM torob_webhook_outbox
        WHERE business_id = $1 AND shop_id = $2
        GROUP BY state`,
      [input.businessId, input.shopId],
    ),
    query<{ page_unique: string; page_url: string; last_error: TorobWebhookError | null; attempts: number }>(
      `SELECT page_unique, page_url, last_error, attempts
         FROM torob_webhook_outbox
        WHERE business_id = $1 AND shop_id = $2 AND state = 'dead'
        ORDER BY updated_at DESC
        LIMIT 20`,
      [input.businessId, input.shopId],
    ),
    query<{ items: number; outcome: "accepted" | "failed"; error: TorobWebhookError | null; finished_at: Date }>(
      `SELECT items, outcome, error, finished_at
         FROM torob_webhook_batches
        WHERE business_id = $1 AND shop_id = $2
        ORDER BY finished_at DESC
        LIMIT 10`,
      [input.businessId, input.shopId],
    ),
  ]);

  const byState = new Map(counts.rows.map((row) => [row.state, Number(row.count)]));
  const pending = counts.rows.find((row) => row.state === "pending");
  return {
    counts: {
      pending: byState.get("pending") ?? 0,
      sent: byState.get("sent") ?? 0,
      dead: byState.get("dead") ?? 0,
    },
    oldestPendingAt: pending?.oldest ? pending.oldest.toISOString() : null,
    dead: dead.rows.map((row) => ({
      pageUnique: row.page_unique,
      pageUrl: row.page_url,
      error: row.last_error,
      attempts: row.attempts,
    })),
    batches: batches.rows.map((row) => ({
      items: row.items,
      outcome: row.outcome,
      error: row.error,
      finishedAt: row.finished_at.toISOString(),
    })),
  };
}

/** Put stopped pages back in the queue, due now, with their attempts forgiven. */
export async function retryDeadPages(input: {
  businessId: string;
  shopId: string;
  pageUniques?: readonly string[];
}): Promise<number> {
  const { rowCount } = await query(
    `UPDATE torob_webhook_outbox
        SET state = 'pending', attempts = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
      WHERE business_id = $1 AND shop_id = $2 AND state = 'dead'
        AND ($3::text[] IS NULL OR page_unique = ANY($3::text[]))`,
    [input.businessId, input.shopId, input.pageUniques && input.pageUniques.length > 0 ? [...input.pageUniques] : null],
  );
  return rowCount ?? 0;
}

/**
 * Fill then drain for one shop — the shape every other outbox tick in this repo
 * uses, and what `server.ts` schedules.
 */
export async function syncTorobWebhookForShop(input: {
  businessId: string;
  shopId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<{ fill: FillResult; drain: DrainResult }> {
  const fill = await enqueueChangedPages(input);
  const drain = await drainWebhookQueue(input);
  return { fill, drain };
}

/**
 * The background tick.
 *
 * Enumerate **eligible** shops under the platform bypass, then re-enter each
 * business with `withTenant` and swallow its own error, exactly like the website
 * and WooCommerce ticks. The filter is `enabled AND authorized` in SQL so a
 * merchant who switched a channel off is not even visited.
 */
export async function runTorobWebhookTick(options: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; id: string }>(
      `SELECT business_id, id FROM torob_shops
        WHERE enabled AND authorization_state = 'authorized'`,
    ),
  );
  for (const row of rows) {
    try {
      await withTenant(row.business_id, () =>
        syncTorobWebhookForShop({
          businessId: row.business_id,
          shopId: row.id,
          env: options.env,
          fetchImpl: options.fetchImpl,
        }),
      );
    } catch (error) {
      console.error("torob webhook tick: shop failed", {
        shopId: row.id,
        error: (error as Error).message,
      });
    }
  }
}

/**
 * Whether a shop's webhook has ever been accepted, and its queue depth.
 *
 * Exported for the per-shop screen's `capabilities`: `sent` is no longer a constant
 * `false` once a batch has been accepted — but it still never means "indexed".
 */
export async function webhookCapability(input: {
  businessId: string;
  shopId: string;
}): Promise<{ sent: boolean; pending: number; dead: number }> {
  const { rows } = await query<{ accepted: string; pending: string; dead: string }>(
    `SELECT
       (SELECT count(*) FROM torob_webhook_batches
         WHERE business_id = $1 AND shop_id = $2 AND outcome = 'accepted')::text AS accepted,
       (SELECT count(*) FROM torob_webhook_outbox
         WHERE business_id = $1 AND shop_id = $2 AND state = 'pending')::text AS pending,
       (SELECT count(*) FROM torob_webhook_outbox
         WHERE business_id = $1 AND shop_id = $2 AND state = 'dead')::text AS dead`,
    [input.businessId, input.shopId],
  );
  const row = rows[0];
  return {
    sent: Number(row?.accepted ?? 0) > 0,
    pending: Number(row?.pending ?? 0),
    dead: Number(row?.dead ?? 0),
  };
}

/** Re-exported so a caller that only needs the host rule does not import the queue. */
export { hostOf };
