/**
 * Issue #894 Wave 4 — **what a shop publishes**, as a rule rather than a side effect.
 *
 * A merchant answers one question about a channel: *which of my products go to
 * Torob?* There are exactly two honest ways to answer it, and this file is the
 * whole of both:
 *
 *   `all`       everything the catalogue can publish, **minus** the products the
 *               merchant switched off one by one;
 *   `selected`  **only** the products the merchant switched on.
 *
 * They are one question asked from opposite ends, which is why they share one
 * table (`torob_shop_products`, migration 0282) and one decision column instead of
 * two lists that could disagree. The rule decides which of the two decisions is
 * doing the work; the per-product decision is stored either way, so switching the
 * rule back and forth never loses what the merchant marked.
 *
 * Pure — no database, no `fetch` — because this is the one place the two rules
 * could quietly disagree with each other, and a build with a wrong answer here
 * publishes a product the merchant switched off. Every branch is in
 * `publication.test.ts`.
 */

import type { FeedSummary, TorobFeedSkipReason } from "./feed";

/** The shop's rule. Mirrors `torob_shops.publication_rule`'s CHECK. */
export type PublicationRule = "all" | "selected";

/** The merchant's per-product decision. Mirrors `torob_shop_products.decision`. */
export type TorobDecision = "include" | "exclude";

/**
 * Whether a product is in this shop's feed.
 *
 * `decision` is `null` for a product the merchant never touched — the ordinary
 * case, and the reason `all` needs no rows at all to work.
 */
export function isPublishedByRule(input: {
  rule: PublicationRule;
  decision: TorobDecision | null | undefined;
}): boolean {
  const decision = input.decision ?? null;
  return input.rule === "selected" ? decision === "include" : decision !== "exclude";
}

/**
 * The decision a click produces.
 *
 * `include → exclude → null → include`: the third state matters, because "back to
 * the shop's rule" is not the same as "switched off" — under `all` an untouched
 * product is published, and a merchant who clears a decision must get that
 * behaviour back rather than a permanent exclusion they cannot see.
 */
export function nextDecision(current: TorobDecision | null | undefined): TorobDecision | null {
  if (!current) return "include";
  return current === "include" ? "exclude" : null;
}

/**
 * What each rule means, in one sentence a merchant can check against their own
 * intention — and what it will do to a product they have not touched.
 */
export const PUBLICATION_RULE_COPY: Readonly<
  Record<PublicationRule, { label: string; summary: string; untouched: string }>
> = {
  all: {
    label: "همهٔ محصولات",
    summary: "هر محصول منتشرشدهٔ فروشگاه به ترب می‌رود؛ هر محصولی را جداگانه می‌توانید کنار بگذارید.",
    untouched: "محصولی که دست نزده‌اید منتشر می‌شود.",
  },
  selected: {
    label: "فقط محصولات انتخابی",
    summary: "تنها محصولاتی که خودتان انتخاب می‌کنید به ترب می‌روند.",
    untouched: "محصولی که انتخاب نکرده‌اید منتشر نمی‌شود.",
  },
};

/**
 * The one-line answer to "what does this shop publish?", for the section header.
 *
 * Counts, not adjectives: a screen that says «همهٔ محصولات» while twelve are
 * excluded is the kind of summary that makes a merchant stop trusting the page.
 */
export function publicationSummary(input: {
  rule: PublicationRule;
  published: number;
  excluded: number;
  unselected: number;
}): string {
  const parts = [`${toPersian(input.published)} محصول در فید`];
  if (input.excluded > 0) parts.push(`${toPersian(input.excluded)} کنار گذاشته‌شده`);
  if (input.rule === "selected" && input.unselected > 0) {
    parts.push(`${toPersian(input.unselected)} انتخاب‌نشده`);
  }
  return parts.join(" · ");
}

function toPersian(value: number): string {
  return String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

/** Rows per page on the per-shop product list. Deliberately small: it is a screen. */
export const TOROB_PRODUCT_PAGE_SIZE = 25;

/**
 * How many products one selection request may carry.
 *
 * The screen selects one at a time; this limit exists so the endpoint cannot be
 * used to post a whole catalogue in a single unbounded body.
 */
export const TOROB_SELECTION_BATCH_LIMIT = 100;

/** A page number that is always one the caller can render. */
export function clampPage(page: unknown, totalPages: number): number {
  const parsed = typeof page === "number" ? page : Number(page);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Math.max(1, Math.trunc(parsed)), Math.max(1, totalPages));
}

/**
 * Why a product the merchant wants published is not in the feed.
 *
 * The four states, and the reason they are *here* rather than in the service: the
 * screen renders them, so they have to be reachable from a client component
 * without dragging `db.ts` into the browser bundle — the mistake
 * `client-bundle-boundary.test.ts` exists to catch.
 */
export type ProductPublicationState = "published" | "excluded" | "unselected" | "blocked";

/** One catalogue product, as the per-shop screen shows it. */
export interface ShopProductRow {
  id: string;
  name: string;
  /** Integer Toman, or `null` when the price has no exact Toman form. */
  priceToman: number | null;
  priceRial: string;
  categoryName: string | null;
  imageUrl: string | null;
  /** Published by the storefront at all — a withdrawn product is a separate problem. */
  active: boolean;
  /** The merchant's stored decision, `null` when untouched. */
  decision: TorobDecision | null;
  state: ProductPublicationState;
  /** The feed builder's own reason, when `state` is `blocked`. */
  skipReason: TorobFeedSkipReason | null;
  /** Said in the merchant's language, so the screen never renders a code. */
  reasonCopy: string | null;
}

/** Everything `/growth/torob/[shopId]` renders, in one shape. */
export interface ShopPublication {
  shop: {
    id: string;
    businessId: string;
    kind: "woocommerce" | "eshobe_cms";
    domain: string;
    authorizationState: "not_authorized" | "pending_approval" | "authorized" | "revoked";
    enabled: boolean;
    publicationRule: PublicationRule;
    includeOutOfStock: boolean;
  };
  /** The same summary «پیش‌نمایش فید» shows, so the two screens agree. */
  summary: FeedSummary;
  counts: {
    /** Catalogue rows the business owns. */
    total: number;
    published: number;
    excluded: number;
    unselected: number;
    blocked: number;
  };
  page: { page: number; pageSize: number; totalPages: number; matching: number };
  products: ShopProductRow[];
  /** The rule's own sentences, so the screen and the docs cannot drift. */
  ruleCopy: typeof PUBLICATION_RULE_COPY;
}

/**
 * What the per-shop screen says about a product, in one line.
 *
 * Beside the states rather than in the component, so the sentence a merchant reads
 * and the state the feed acts on are written once.
 */
export const PRODUCT_STATE_COPY: Readonly<Record<ProductPublicationState, string>> = {
  published: "در فید ترب",
  excluded: "کنار گذاشته‌اید",
  unselected: "انتخاب نشده",
  blocked: "منتشر نمی‌شود",
};
