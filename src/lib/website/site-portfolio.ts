/**
 * The read model behind «مدیریت وب‌سایت»'s site cards — one entry per *actual*
 * site, not one per manager (issue #1215 / P1‑1).
 *
 * The app home used to show a single CMS card and one WordPress card whose
 * whole content was «N فروشگاه متصل». A business with three stores could not
 * see which store was paused, which one last answered, or which one had failed
 * work waiting — it had to open the WordPress manager and pick stores one at a
 * time. This module is the *shape* of that answer, kept framework-free (no
 * React, no db) so the rules are unit-tested in `site-portfolio.test.ts` and the
 * same rules feed the server read model (`portfolio-service.ts`) and the cards.
 *
 * The governing rule is **no invented green**: a fact we do not have is
 * `null`, and the card shows «نامشخص». In particular a configured REST pair is
 * not a verified connection (`unverified`, not `active`), and a store with no
 * plugin heartbeat is `action_required` — its jobs are queuing into nothing.
 */

/** Which of the two website systems a card belongs to. They never merge. */
export type SitePlatform = "cms" | "woocommerce";

/**
 * What a site's connection is doing right now.
 *
 *   active           verified and healthy — a live plugin heartbeat, a recorded
 *                    successful connection check, or (REST) a successful sync.
 *   paused           the owner stopped the direction from this side.
 *   degraded         something is recorded as broken: an `error` connection
 *                    status, a failed connection check, or a stale plugin.
 *   action_required  nothing will move until a person acts: the plugin has
 *                    never connected, or answers from another domain, or the
 *                    CMS credential is disabled.
 *   unverified       configured, but nothing has ever confirmed it works.
 *   unknown          the read could not tell (no transport reading at all).
 */
export type SiteConnectionState = "active" | "paused" | "degraded" | "action_required" | "unverified" | "unknown";

export const SITE_STATE_LABELS: Record<SiteConnectionState, string> = {
  active: "فعال",
  paused: "متوقف",
  degraded: "مختل",
  action_required: "نیازمند اقدام",
  unverified: "تأییدنشده",
  unknown: "نامشخص",
};

/** The sentence a card (or its help text) says for each state — same words everywhere. */
export const SITE_STATE_EXPLANATIONS: Record<SiteConnectionState, string> = {
  active: "اتصال در آخرین بررسی سالم بوده است.",
  paused: "همگام‌سازی از این سمت متوقف شده است؛ کارهای تازه صف می‌شوند تا دوباره فعال شود.",
  degraded: "آخرین تلاش اتصال یا همگام‌سازی با خطا مواجه شده است.",
  action_required:
    "تا زمانی که کسی این اتصال را درست نکند، کارها اجرا نمی‌شوند: افزونه وصل نشده، از دامنه‌ای دیگر پاسخ می‌دهد، یا مجوز سایت غیرفعال است.",
  unverified: "اطلاعات اتصال ثبت شده است، اما هنوز هیچ همگام‌سازی یا آزمایش موفقی آن را تأیید نکرده است.",
  unknown: "وضعیت اتصال خوانده نشد؛ این «سالم» نیست، فقط «نامشخص» است.",
};

export function siteStateTone(state: SiteConnectionState): "positive" | "neutral" | "danger" {
  if (state === "active") return "positive";
  if (state === "degraded" || state === "action_required") return "danger";
  return "neutral";
}

/** Whether a card of this state belongs at the top of the page. */
export function siteNeedsAttention(state: SiteConnectionState): boolean {
  return state === "degraded" || state === "action_required" || state === "paused";
}

/**
 * An ISO string for a timestamp the driver may hand over as a `Date` (node-pg
 * parses `timestamptz` into one), a string, or nothing at all. Junk is `null`,
 * never `Invalid Date` printed into the UI.
 */
export function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

/** The newest of several timestamps, or `null` when none of them is a real one. */
export function latestTimestamp(...values: unknown[]): string | null {
  let newest: { at: string; ms: number } | null = null;
  for (const value of values) {
    const at = isoTimestamp(value);
    if (!at) continue;
    const ms = Date.parse(at);
    if (!newest || ms > newest.ms) newest = { at, ms };
  }
  return newest?.at ?? null;
}

/** How much work is waiting or stuck for one site. */
export interface SiteWork {
  /** Still expected to move on its own (queued or processing). */
  pending: number;
  /** Will not move without a person (failed, needs review, dead). */
  failed: number;
}

export const NO_SITE_WORK: SiteWork = { pending: 0, failed: 0 };

export function hasSiteWork(work: SiteWork): boolean {
  return work.pending > 0 || work.failed > 0;
}

/**
 * The one-line queue sentence for a card, or `null` when the queue is clear.
 * «۲ کار در صف» and «۱ کار ناموفق» are counted separately on purpose: a queued
 * job is normal, a failed one is somebody's problem.
 */
export function siteWorkLabel(work: SiteWork): string | null {
  const parts: string[] = [];
  if (work.pending > 0) parts.push(`${work.pending.toLocaleString("fa-IR")} در صف`);
  if (work.failed > 0) parts.push(`${work.failed.toLocaleString("fa-IR")} ناموفق`);
  return parts.length ? parts.join("، ") : null;
}

/** The facts a store connection row can answer a card with. */
export interface StoreStateInput {
  status?: string | null;
  linkMode?: string | null;
  /** `transportHealth.state` from the connection read model. */
  transportState?: string | null;
  lastSuccessfulTestAt?: unknown;
  lastSyncAt?: unknown;
  lastCatalogueSyncAt?: unknown;
  lastOrderSyncAt?: unknown;
  lastCustomerSyncAt?: unknown;
  lastContentSyncAt?: unknown;
  lastPluginSeenAt?: unknown;
}

/** The newest of a store's per-job watermarks — when data last really moved. */
export function storeLastAppliedAt(input: StoreStateInput): string | null {
  return latestTimestamp(
    input.lastSyncAt,
    input.lastCatalogueSyncAt,
    input.lastOrderSyncAt,
    input.lastCustomerSyncAt,
    input.lastContentSyncAt,
  );
}

export interface StoreVerification {
  at: string | null;
  /** What the timestamp actually is, so the card can label it honestly. */
  source: "plugin_heartbeat" | "connection_test" | "sync" | null;
}

/**
 * When this store's connection was last *confirmed*, and by what.
 *
 * Plugin mode's only real «is it alive?» signal is the last authenticated
 * request; REST mode has no heartbeat at all, so the newest of the recorded
 * connection test and the sync watermarks stands in — and both missing means
 * the pair has never been proven to work.
 */
export function storeVerification(input: StoreStateInput): StoreVerification {
  const heartbeat = isoTimestamp(input.lastPluginSeenAt);
  if (input.linkMode === "plugin" && heartbeat) return { at: heartbeat, source: "plugin_heartbeat" };
  const test = isoTimestamp(input.lastSuccessfulTestAt);
  if (test) return { at: test, source: "connection_test" };
  const sync = storeLastAppliedAt(input);
  if (sync) return { at: sync, source: "sync" };
  return { at: heartbeat, source: heartbeat ? "plugin_heartbeat" : null };
}

export const STORE_VERIFICATION_SOURCE_LABELS: Record<NonNullable<StoreVerification["source"]>, string> = {
  plugin_heartbeat: "آخرین پاسخ افزونه",
  connection_test: "آخرین آزمایش موفق اتصال",
  sync: "آخرین همگام‌سازی موفق",
};

/**
 * The connection state of one WooCommerce store.
 *
 * `status` (configured) and `transportHealth` (observed) are two different
 * readings and the card keeps them apart: configured-and-`active` with a dead
 * plugin is not a healthy store, and a paused store is not a broken one.
 */
export function storeSiteState(input: StoreStateInput): SiteConnectionState {
  const transport = input.transportState ?? null;
  if (input.status === "paused" || transport === "paused") return "paused";
  if (input.status === "error") return "degraded";
  if (transport === "site_mismatch" || transport === "never_connected") return "action_required";
  if (transport === "error" || transport === "stale") return "degraded";
  if (input.linkMode === "plugin") {
    if (transport === "healthy") return "active";
    // No transport reading at all: say so rather than inherit the configured
    // status, which is the exact «green because it exists» this epic forbids.
    return "unknown";
  }
  const verified = storeVerification(input);
  return verified.at ? "active" : "unverified";
}

/** The facts the CMS connection row can answer a card with. */
export interface CmsStateInput {
  status?: string | null;
  lastError?: string | null;
  lastCheckedAt?: unknown;
}

/**
 * The connection state of the business's one Eshobe CMS site.
 *
 * The CMS connection has a recorded check (`last_checked_at`, written when the
 * credential was saved or last tested) and the error it left behind. It has no
 * heartbeat feed, so nothing here claims a fresher health than that recorded
 * check; `lastCheckedAt` is shown with its own timestamp.
 */
export function cmsSiteState(input: CmsStateInput): SiteConnectionState {
  if (input.status === "disabled") return "action_required";
  if (input.lastError) return "degraded";
  return isoTimestamp(input.lastCheckedAt) ? "active" : "unverified";
}

/** A card for the platform's own site — at most one per business today. */
export interface CmsSiteCard {
  kind: "cms";
  /** The connection row's id; the CMS has no per-site URL of its own. */
  id: string;
  domain: string | null;
  state: SiteConnectionState;
  /** When the stored credential was last checked, and the panel recorded it. */
  lastCheckedAt: string | null;
  /** The last product/stock/price push the site acknowledged, if any. */
  lastAppliedAt: string | null;
  /** Products the owner marked to go to the site (a local, reliable count). */
  syncedProducts: number;
  work: SiteWork;
}

/** A card for one non-deleted WooCommerce connection. */
export interface StoreSiteCard {
  kind: "woocommerce";
  /** `integration_connections.id` — also the `?store=` navigation key. */
  id: string;
  name: string;
  domain: string | null;
  /** The store's own address, as recorded — what «بازکردن فروشگاه» must open. */
  url: string | null;
  linkMode: "rest_api" | "plugin" | null;
  state: SiteConnectionState;
  lastVerifiedAt: string | null;
  verificationSource: StoreVerification["source"];
  lastAppliedAt: string | null;
  /** Mirrored products and orders — reliable only because they are local counts. */
  products: number;
  orders: number;
  work: SiteWork;
}

export type SiteCard = CmsSiteCard | StoreSiteCard;

/**
 * «نام — دامنه» so two stores that share a name are still told apart. Every
 * card is already tenant-scoped, so the tenant suffix the epic asks for is the
 * business's own context — this function only disambiguates *within* it.
 */
export function storeCardTitle(card: Pick<StoreSiteCard, "name" | "domain">): string {
  return card.domain && card.domain !== card.name ? `${card.name} — ${card.domain}` : card.name;
}

/** The store's address, normalized, or `null` when the stored value is not one. */
export function siteUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** The host of a store URL, for the card title and the «بازکردن فروشگاه» link. */
export function siteHost(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    const stripped = baseUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    return stripped || null;
  }
}

const ATTENTION_RANK: Record<SiteConnectionState, number> = {
  action_required: 0,
  degraded: 1,
  paused: 2,
  unverified: 3,
  unknown: 4,
  active: 5,
};

/**
 * Attention first, then the CMS site (the platform's own site, and the one the
 * business pays for), then stores by name. Ordering is stable so a re-render
 * never reshuffles the grid under the reader.
 */
export function sortSiteCards(cards: readonly SiteCard[]): SiteCard[] {
  return [...cards].sort((a, b) => {
    const rank = ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state];
    if (rank !== 0) return rank;
    if (a.kind !== b.kind) return a.kind === "cms" ? -1 : 1;
    const left = a.kind === "cms" ? a.domain ?? "" : storeCardTitle(a);
    const right = b.kind === "cms" ? b.domain ?? "" : storeCardTitle(b);
    return left.localeCompare(right, "fa");
  });
}

export interface SitePortfolioTotals {
  sites: number;
  stores: number;
  needingAttention: number;
  pendingWork: number;
  failedWork: number;
}

/** The page-level counts. Only sums of local rows — never a remote per-site call. */
export function sitePortfolioTotals(cards: readonly SiteCard[]): SitePortfolioTotals {
  return cards.reduce<SitePortfolioTotals>(
    (totals, card) => ({
      sites: totals.sites + 1,
      stores: totals.stores + (card.kind === "woocommerce" ? 1 : 0),
      needingAttention: totals.needingAttention + (siteNeedsAttention(card.state) ? 1 : 0),
      pendingWork: totals.pendingWork + card.work.pending,
      failedWork: totals.failedWork + card.work.failed,
    }),
    { sites: 0, stores: 0, needingAttention: 0, pendingWork: 0, failedWork: 0 },
  );
}

/** A section of the portfolio that was read, refused, or could not be read. */
export type PortfolioPart<T> =
  | { status: "ok"; value: T }
  | { status: "denied" }
  | { status: "error" };

export interface SitePortfolioState {
  /** When this snapshot was assembled — the cards' «as of» for cached health. */
  readAt: string;
  /** The platform's CMS site, or `null` when the business has none. */
  cms: PortfolioPart<CmsSiteCard | null>;
  /** One card per non-deleted WooCommerce connection. */
  stores: PortfolioPart<StoreSiteCard[]>;
}

export function portfolioCards(state: SitePortfolioState): SiteCard[] {
  const cms = state.cms.status === "ok" && state.cms.value ? [state.cms.value] : [];
  const stores = state.stores.status === "ok" ? state.stores.value : [];
  return sortSiteCards([...cms, ...stores]);
}

/**
 * Whether the page may show onboarding — *only* when both halves were read and
 * both came back empty. A refused or failed read is never «no website yet»:
 * that copy would tell a business with three stores to connect its first one.
 */
export function portfolioShowsOnboarding(state: SitePortfolioState): boolean {
  if (state.cms.status !== "ok" || state.stores.status !== "ok") return false;
  return state.cms.value === null && state.stores.value.length === 0;
}

/** Whether anything at all could be read — used to choose the page-level notice. */
export function portfolioHasReadablePart(state: SitePortfolioState): boolean {
  return state.cms.status === "ok" || state.stores.status === "ok";
}
