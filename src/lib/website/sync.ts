/**
 * Phase 38 Wave 3 (issue #381) — product/stock/price push, the pure half.
 *
 * `sync-service.ts` reads the database and calls the adapter; the decisions —
 * *which* events a product needs, and *what happens* to a queued event after
 * a failure — live here so they are deterministic and unit-tested.
 *
 * Retry policy is `integrations/retry.ts`'s, unchanged: the website queue is
 * the same shape as the WooCommerce outbox by decision, not a second policy.
 */
import { backoffDelayMs, isDeadAfterAttempts, OUTBOX_MAX_ATTEMPTS } from "../integrations/retry";
import type { MenuCategoryInput, MenuModifierGroup } from "./adapter";

export const WEBSITE_OUTBOX_KINDS = ["product.upsert", "stock.set", "price.set"] as const;
export type WebsiteOutboxKind = (typeof WEBSITE_OUTBOX_KINDS)[number];

export type LocalProductKind = "item" | "menu_item";

export const WEBSITE_OUTBOX_KIND_LABELS: Record<WebsiteOutboxKind, string> = {
  "product.upsert": "ارسال کالا",
  "stock.set": "به‌روزرسانی موجودی",
  "price.set": "به‌روزرسانی قیمت",
};

export const WEBSITE_OUTBOX_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار",
  processing: "در حال ارسال",
  sent: "ارسال‌شده",
  failed: "ناموفق (تلاش مجدد)",
  dead: "متوقف‌شده",
};

export interface ProductMapState {
  remoteId: string | null;
  syncEnabled: boolean;
  lastPushedPriceRial: number | null;
  lastPushedStock: number | null;
  lastPushedContentHash?: string | null;
  /** Undefined only for a legacy map; treat it as published so it can be withdrawn. */
  lastPushedPublished?: boolean | null;
}

export interface WebsiteLocalProduct {
  name: string;
  sku: string | null;
  description: string | null;
  imageMediaId?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  category?: Omit<MenuCategoryInput, "taxonomyId" | "remoteId"> | null;
  modifierGroups?: MenuModifierGroup[];
}

export interface DesiredProductState {
  /** Integer Rial; `null` when the local product has no price. */
  priceRial: number | null;
  /** `null` when the app itself cannot say (F&B item with no recipe). */
  stock: number | null;
  /** Fingerprint of everything product.upsert owns (not price/stock). */
  contentHash?: string | null;
  published?: boolean;
  available?: boolean;
}

export interface SyncSwitches {
  pushPrices: boolean;
  pushStock: boolean;
  /** `selected` → only `syncEnabled` rows go; `all` → every mapped product. */
  productScope: "selected" | "all";
}

/** Is this product in scope at all? */
export function productInScope(map: ProductMapState, switches: SyncSwitches): boolean {
  return switches.productScope === "all" || map.syncEnabled;
}

/**
 * Which events a product needs right now. Order matters: an unmapped product
 * needs `product.upsert` first and nothing else — the upsert carries the
 * price and stock, and the follow-up events would have no remote id to
 * address. Once mapped, price and stock are diffed independently, each
 * behind its own switch.
 */
export function planProductEvents(
  map: ProductMapState,
  desired: DesiredProductState,
  switches: SyncSwitches,
): WebsiteOutboxKind[] {
  // Opting out is itself a durable change: withdraw an already published
  // product before applying the scope gate. An unmarked row with no remote id
  // has nothing to withdraw.
  if (!productInScope(map, switches)) {
    return map.remoteId && map.lastPushedPublished !== false ? ["product.upsert"] : [];
  }
  if (!map.remoteId) return ["product.upsert"];
  const events: WebsiteOutboxKind[] = [];
  if (desired.contentHash != null && desired.contentHash !== map.lastPushedContentHash) {
    events.push("product.upsert");
  }
  if (switches.pushPrices && desired.priceRial !== null && desired.priceRial !== map.lastPushedPriceRial) {
    events.push("price.set");
  }
  // null is an explicit unknown: clear a previously pushed count, never
  // fabricate zero or unlimited stock for an item whose recipe disappeared.
  if (switches.pushStock && desired.stock !== map.lastPushedStock) {
    events.push("stock.set");
  }
  return events;
}

export type OutboxFailureOutcome =
  | { status: "failed"; attempts: number; delayMs: number }
  | { status: "dead"; attempts: number; delayMs: 0 };

/**
 * After a failed send: back off exponentially, or dead-letter after the cap.
 * A non-retryable failure (credential refused, remote row gone, write
 * rejected) dead-letters at once — retrying it would only repeat the answer.
 */
export function afterFailure(attemptsSoFar: number, retryable: boolean): OutboxFailureOutcome {
  const attempts = attemptsSoFar + 1;
  if (!retryable || isDeadAfterAttempts(attempts, OUTBOX_MAX_ATTEMPTS)) return { status: "dead", attempts, delayMs: 0 };
  return { status: "failed", attempts, delayMs: backoffDelayMs(attempts) };
}

/** The recipe rule: sellable = min over ingredients of floor(on-hand / per-unit). */
export function sellableFromIngredients(rows: { onHand: number; perUnit: number }[]): number | null {
  if (rows.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (!(row.perUnit > 0)) continue;
    const sellable = Math.floor(row.onHand / row.perUnit);
    if (sellable < min) min = sellable;
  }
  return min === Number.POSITIVE_INFINITY ? null : Math.max(0, min);
}
