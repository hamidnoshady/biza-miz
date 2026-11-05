/**
 * Per-domain freshness (issue #1206, P1).
 *
 * One cron state answers "does the scheduler run". It does not answer "is stock
 * moving" — a store can have a healthy scheduler, a working connection and a
 * catalogue that stopped updating three days ago because one push keeps
 * failing. This grades each domain separately, from the app's own outbox and
 * inbox, so a stall shows up where it happened instead of being averaged into
 * one reassuring number.
 *
 * The rule that keeps it honest: **quiet is not stale.** A shop with no orders
 * today has no order traffic and that is not a fault. A domain is only ever
 * graded `delayed` when work is actually *waiting* and not moving — backlog is
 * the only evidence this side has that something should have happened and did
 * not. Everything else reports what was last exchanged and when, and says
 * "nothing yet" plainly rather than borrowing the colour of a failure.
 */

/** The domains the screen reports, in the order the issue lists them. */
export const SYNC_DOMAINS = ["products", "stock", "prices", "orders", "customers", "content"] as const;

export type SyncDomain = (typeof SYNC_DOMAINS)[number];

/**
 * How each domain maps onto the two tables that carry its traffic.
 *
 * `outbound` are `integration_outbox_events.entity_type` values — what this app
 * sends to the store. `inbound` are prefix families of
 * `integration_webhook_events.event_topic` — what the store sends here. Both
 * lists are exhaustive on purpose: an entity type that belongs to no domain
 * would be traffic nobody is watching, which is how a silent domain hides.
 */
export const SYNC_DOMAIN_SOURCES: Record<SyncDomain, { outbound: string[]; inbound: string[] }> = {
  products: {
    outbound: ["product_update", "product_publish", "catalogue_export"],
    inbound: ["product."],
  },
  stock: { outbound: ["stock"], inbound: [] },
  prices: { outbound: ["price"], inbound: [] },
  orders: {
    outbound: ["order_status", "refund_create", "orders_export"],
    inbound: ["order.", "refund."],
  },
  customers: { outbound: ["customer_export"], inbound: ["customer."] },
  content: {
    outbound: [
      "content_export",
      "post_upsert",
      "media_create",
      "taxonomy_export",
      "taxonomy_ensure",
      // The app-side read of the same tree (#1206 PERF-05). Same domain: it is
      // the taxonomy snapshot, whoever fetches it.
      "taxonomy_sync",
    ],
    inbound: ["post.", "media.", "term.", "product_category.", "product_tag."],
  },
};

/** Which domain an outbound entity type belongs to, or null for non-domain work. */
export function domainForEntityType(entityType: string): SyncDomain | null {
  for (const domain of SYNC_DOMAINS) {
    if (SYNC_DOMAIN_SOURCES[domain].outbound.includes(entityType)) return domain;
  }
  return null;
}

/** Which domain a store event topic belongs to, or null when it maps to none. */
export function domainForTopic(topic: string): SyncDomain | null {
  for (const domain of SYNC_DOMAINS) {
    if (SYNC_DOMAIN_SOURCES[domain].inbound.some((prefix) => topic.startsWith(prefix))) return domain;
  }
  return null;
}

export type DomainState = "ok" | "delayed" | "never";

export interface SyncDomainFreshness {
  domain: SyncDomain;
  state: DomainState;
  /** A stable code, so the label and the docs cannot drift apart. */
  reason: string;
  /** The last exchange either way: a job delivered, or an event applied. */
  lastExchangeAt: string | null;
  /** Jobs for this domain still waiting (pending, failed or leased). */
  backlog: number;
  /** How long the oldest of those has waited. */
  oldestBacklogSeconds: number | null;
}

export interface OutboundRow {
  entity_type: string;
  backlog: number;
  oldest: string | null;
  last_sent: string | null;
}

export interface InboundRow {
  event_topic: string;
  last_processed: string | null;
}

function latest(...stamps: (string | null | undefined)[]): string | null {
  let best: number | null = null;
  let bestStamp: string | null = null;
  for (const stamp of stamps) {
    if (!stamp) continue;
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > best) {
      best = ms;
      bestStamp = stamp;
    }
  }
  return bestStamp;
}

function oldest(...stamps: (string | null | undefined)[]): string | null {
  let best: number | null = null;
  let bestStamp: string | null = null;
  for (const stamp of stamps) {
    if (!stamp) continue;
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms < best) {
      best = ms;
      bestStamp = stamp;
    }
  }
  return bestStamp;
}

/**
 * Fold the two grouped queries into one entry per domain, then grade it.
 *
 * Every domain is returned, including the ones with no traffic at all: a screen
 * that omits a silent domain is worse than one that says "nothing yet", because
 * the omission looks like health.
 */
export function assessDomainFreshness(
  rows: { outbound: OutboundRow[]; inbound: InboundRow[] },
  now: Date,
  options: { warnAfterMs: number },
): SyncDomainFreshness[] {
  return SYNC_DOMAINS.map((domain) => {
    const sources = SYNC_DOMAIN_SOURCES[domain];
    const outbound = rows.outbound.filter((row) => sources.outbound.includes(row.entity_type));
    const inbound = rows.inbound.filter((row) => sources.inbound.some((prefix) => row.event_topic.startsWith(prefix)));

    const backlog = outbound.reduce((total, row) => total + Number(row.backlog || 0), 0);
    const oldestBacklog = oldest(...outbound.map((row) => row.oldest));
    const lastExchangeAt = latest(...outbound.map((row) => row.last_sent), ...inbound.map((row) => row.last_processed));
    const oldestMs = oldestBacklog ? Date.parse(oldestBacklog) : NaN;
    const oldestBacklogSeconds = Number.isFinite(oldestMs) ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000)) : null;

    if (backlog > 0 && oldestBacklogSeconds !== null && oldestBacklogSeconds * 1000 > options.warnAfterMs) {
      return {
        domain,
        state: "delayed",
        reason: "backlog_not_draining",
        lastExchangeAt,
        backlog,
        oldestBacklogSeconds,
      } satisfies SyncDomainFreshness;
    }
    if (!lastExchangeAt) {
      return {
        domain,
        state: "never",
        // Quiet, not broken: nothing has been sent or received for this domain
        // yet, which is normal on a new connection and for a shop with no
        // orders today.
        reason: backlog > 0 ? "backlog_not_sent_yet" : "no_traffic_yet",
        lastExchangeAt: null,
        backlog,
        oldestBacklogSeconds,
      } satisfies SyncDomainFreshness;
    }
    return {
      domain,
      state: "ok",
      reason: backlog > 0 ? "backlog_draining" : "no_backlog",
      lastExchangeAt,
      backlog,
      oldestBacklogSeconds,
    } satisfies SyncDomainFreshness;
  });
}

/** An all-`never` picture, for a connection whose overview has no rows yet. */
export function noDomainTraffic(): SyncDomainFreshness[] {
  return SYNC_DOMAINS.map((domain) => ({
    domain,
    state: "never" as const,
    reason: "no_traffic_yet",
    lastExchangeAt: null,
    backlog: 0,
    oldestBacklogSeconds: null,
  }));
}

/**
 * The domain labels, kept here rather than in the component so a report, an
 * alert or a doc can name a domain exactly as the screen does.
 */
export const SYNC_DOMAIN_LABELS: Record<SyncDomain, string> = {
  products: "محصولات و تنوع‌ها",
  stock: "موجودی",
  prices: "قیمت‌ها",
  orders: "سفارش‌ها و مرجوعی‌ها",
  customers: "مشتریان",
  content: "محتوا و دسته‌بندی‌ها",
};
