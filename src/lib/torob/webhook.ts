/**
 * Issue #894 Wave 5b — the Product Webhook, as rules rather than as a client.
 *
 * Torob pulls pages through the Product API; the webhook is how we say "these
 * changed, pull them sooner". `torob/Torob-Sync` → `product_webhook.md` gives it
 * exactly three invariants, and every one of them is a rule this file owns so the
 * database layer never has to remember it:
 *
 *   1. **At most 100 items per request**, and at most 20 requests per minute per
 *      shop. So a drain takes at most 100 due rows at a time and a run sends at most
 *      a handful of batches.
 *   2. **One domain per request.** A batch mixing hosts is refused with 400, so a
 *      row whose URL does not belong to the shop's own domain is not sent at all —
 *      not "sent and hoped for". That check is here, once, and it is also what keeps
 *      a mis-joined row from pointing Torob at somebody else's site.
 *   3. **The payload is a pair of identifiers.** `{page_url, page_unique}` and
 *      nothing else — no price, no stock, no title. Torob re-fetches the page itself
 *      through the Product API, and a copy in the notification would only create a
 *      second truth.
 *
 * And one distinction the document repeats twice, which decides the vocabulary of
 * this whole slice: a `200 {"message": "success"}` means Torob **queued** the pages
 * for a refresh. It does not mean Torob fetched them, and it certainly does not
 * mean they are indexed. `accepted` is the only word this module will use for it.
 *
 * Pure — no `fetch`, no database — because a wrong rule here either spams a
 * provider into a 429 or silently drops the merchant's changes.
 */

/** Torob's documented endpoint. Overridable so tests never reach the network. */
export const TOROB_WEBHOOK_URL = "https://api.torob.com/update/webhook/v1/";

/** `items` is min 1, max 100 — the document's own bound. */
export const TOROB_WEBHOOK_MAX_ITEMS = 100;

/** 20 requests per minute per shop. */
export const TOROB_WEBHOOK_RATE_LIMIT = 20;

/** The spacing that keeps a drain under the limit: 60s / 20. */
export const TOROB_WEBHOOK_MIN_INTERVAL_MS = Math.ceil(60_000 / TOROB_WEBHOOK_RATE_LIMIT);

/**
 * Batches one drain run may send.
 *
 * Four is a quarter of the provider's per-minute budget, which leaves room for a
 * tick that overlaps its predecessor (a slow request, a restart) without ever
 * tripping the limit. A shop with more than 400 changed pages simply takes a few
 * minutes to catch up — and since every row is coalesced, that is the same shop
 * announcing 400 products, not 4 000 events.
 */
export const TOROB_WEBHOOK_BATCHES_PER_RUN = 4;

/** Delivery attempts before a row is dead-lettered: enough for a long outage, not forever. */
export const TOROB_WEBHOOK_MAX_ATTEMPTS = 8;

/** Why a request to Torob's webhook did not result in an acceptance. */
export type TorobWebhookError =
  | "not_configured"
  | "unauthorized"
  | "domain_mismatch"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "shop_not_active";

/**
 * One page's notice, as the queue holds it.
 *
 * `pageUnique` and `pageUrl` are the entire payload; `reason` and `pageUpdatedAt`
 * are ours, for the screen and for reconciliation.
 */
export interface WebhookItem {
  pageUnique: string;
  pageUrl: string;
  reason: "added" | "updated";
  pageUpdatedAt: string | null;
}

/** Torob's request body, exactly the two documented fields. */
export interface TorobWebhookBody {
  items: { page_url: string; page_unique: string }[];
}

/** The host of an absolute URL, lowercased and without a leading `www.`; null if unusable. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Split items into batches Torob will accept.
 *
 * Two things happen here rather than in the caller, because both are ways a batch
 * is refused wholesale:
 *
 *   - items whose URL is not on the shop's own domain are **dropped and reported**,
 *     never sent: one foreign host in a batch of 99 is a 400 for all 100;
 *   - an item with no `page_unique` or an unusable URL is dropped for the same
 *     reason. Reporting the count is what lets a caller refuse to pretend.
 *
 * `maxBatches` bounds a run; the remainder stays queued and goes out next time.
 */
export function planWebhookBatches(input: {
  items: readonly WebhookItem[];
  domain: string;
  maxItems?: number;
  maxBatches?: number;
}): { batches: WebhookItem[][]; dropped: number } {
  const maxItems = Math.min(Math.max(1, input.maxItems ?? TOROB_WEBHOOK_MAX_ITEMS), TOROB_WEBHOOK_MAX_ITEMS);
  const maxBatches = Math.max(1, input.maxBatches ?? TOROB_WEBHOOK_BATCHES_PER_RUN);
  const domain = input.domain.trim().toLowerCase().replace(/^www\./, "");

  const usable: WebhookItem[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of input.items) {
    const unique = item.pageUnique?.trim() ?? "";
    const host = hostOf(item.pageUrl ?? "");
    if (!unique || host === null || host !== domain || seen.has(unique)) {
      dropped += 1;
      continue;
    }
    seen.add(unique);
    usable.push({ ...item, pageUnique: unique });
  }

  const batches: WebhookItem[][] = [];
  for (let start = 0; start < usable.length && batches.length < maxBatches; start += maxItems) {
    batches.push(usable.slice(start, start + maxItems));
  }
  return { batches, dropped };
}

/** The request body for one batch — two fields per item, and nothing else. */
export function webhookBody(items: readonly WebhookItem[]): TorobWebhookBody {
  return { items: items.map((item) => ({ page_url: item.pageUrl, page_unique: item.pageUnique })) };
}

/**
 * Whether Torob accepted the request into its queue.
 *
 * Deliberately narrow: only `200` with `message: "success"` counts. A body that
 * merely parsed is not an acceptance, and `{"message": "ok"}` is not the
 * documented answer — treating an unexpected success body as acceptance is how a
 * merchant is told their changes landed when nothing was queued.
 */
export function isWebhookAccepted(status: number, body: unknown): boolean {
  if (status !== 200) return false;
  const row = (body ?? {}) as Record<string, unknown>;
  return row.message === "success";
}

/**
 * What a failed request does to the rows it carried.
 *
 * The split is by *whether retrying can change the answer*, not by status code
 * prettiness:
 *
 *   - `400` — Torob refused the request itself. Retrying the same body repeats it,
 *     so the batch dead-letters at once; something in our data or our URL is wrong
 *     and a human has to look.
 *   - `401` / `403` — the token is refused, or the shop is not active on Torob.
 *     Retrying is pointless **until a human fixes the credential**, so these
 *     dead-letter too: a queue that retries a revoked token forever looks busy and
 *     is not, and the shop's health already says `attention`.
 *   - `429` — the limit, which is exactly what a retry later fixes. Retry, with the
 *     rows due after the documented spacing.
 *   - everything else (5xx, timeout, network) — retry with backoff, dead-letter at
 *     the attempt cap.
 */
export type WebhookFailureOutcome =
  | { state: "pending"; attempts: number; delayMs: number }
  | { state: "dead"; attempts: number; delayMs: 0 };

export function afterWebhookFailure(
  attemptsSoFar: number,
  error: TorobWebhookError,
  backoff: (attempt: number) => number,
): WebhookFailureOutcome {
  const attempts = attemptsSoFar + 1;
  if (error === "invalid_request" || error === "unauthorized" || error === "domain_mismatch" || error === "shop_not_active") {
    return { state: "dead", attempts, delayMs: 0 };
  }
  if (error === "rate_limited") {
    // Spacing, not backoff: the provider asked us to slow down, and it says by how
    // much (20 per minute) rather than by an exponential guess.
    return { state: "pending", attempts, delayMs: TOROB_WEBHOOK_MIN_INTERVAL_MS };
  }
  if (attempts >= TOROB_WEBHOOK_MAX_ATTEMPTS) return { state: "dead", attempts, delayMs: 0 };
  return { state: "pending", attempts, delayMs: backoff(attempts) };
}

/** What each failure means to a merchant, and what they can do. */
export const TOROB_WEBHOOK_ERROR_COPY: Readonly<Record<TorobWebhookError, string>> = {
  not_configured: "برای اطلاع‌دادن به ترب، توکن فروشگاه لازم است؛ آن را در همین صفحه ثبت کنید.",
  unauthorized: "ترب این توکن را نپذیرفت؛ توکن فروشگاه را دوباره ثبت کنید.",
  domain_mismatch: "آدرس صفحه با دامنهٔ این فروشگاه نمی‌خواند؛ تغییری به ترب فرستاده نشد.",
  invalid_request: "ترب درخواست را نپذیرفت؛ یک صفحه در این فهرست آدرس یا شناسهٔ درستی ندارد.",
  rate_limited: "ترب شمار درخواست‌ها را محدود کرد؛ صف خودش کمی بعد ادامه می‌دهد.",
  timeout: "پاسخ ترب در زمان مجاز نرسید؛ صف خودش دوباره تلاش می‌کند.",
  provider_error: "پاسخ ترب خوانده نشد؛ صف خودش دوباره تلاش می‌کند.",
  shop_not_active: "ترب این فروشگاه را فعال نمی‌داند؛ وبهوک فقط برای فروشگاه‌های فعال کار می‌کند.",
};

/**
 * The three states of the queue, in the merchant's terms.
 *
 * `pending` is not a problem — a queue with work in it is a queue doing its job.
 * `dead` is the only one that needs a person, and it is named after what the
 * merchant can do about it (try again, or fix the reason).
 */
export const WEBHOOK_STATE_COPY: Readonly<Record<"pending" | "sent" | "dead", string>> = {
  pending: "در صف",
  sent: "به ترب اطلاع داده شد",
  dead: "متوقف",
};
