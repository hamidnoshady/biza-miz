/**
 * The pure rules of the stock/price push (issue #1149, C1–C3). Free of the
 * database so they can be unit-tested to the digit and imported anywhere.
 *
 * Three questions live here, each the answer to a way the push once did harm:
 *
 *   - **Who owns the number?** `source_of_truth`. A connection whose store is
 *     the authority must not receive this app's stock or prices, whatever its
 *     two push switches were left on.
 *   - **May this product's stock be pushed, and how?** Only where the store
 *     already tracks it, or the owner consented to turning tracking on. A push
 *     to an untracked product used to send `manage_stock: true, quantity: 0`.
 *   - **Is a queued push worth sending?** Not when the store already holds the
 *     value, and not when the figure was computed so long ago that applying it
 *     would be news from the past.
 */
import { wooAmountToRial } from "./woo-money";

export const SOURCE_OF_TRUTH_VALUES = ["store", "pos", "two_way"] as const;
export type SourceOfTruth = (typeof SOURCE_OF_TRUTH_VALUES)[number];

export function isSourceOfTruth(value: unknown): value is SourceOfTruth {
  return typeof value === "string" && (SOURCE_OF_TRUTH_VALUES as readonly string[]).includes(value);
}

/** What the scheduled push may actually do, after the authority is taken into account. */
export function effectivePushSwitches(connection: {
  source_of_truth?: string | null;
  push_stock: boolean;
  push_prices: boolean;
}): { pushStock: boolean; pushPrices: boolean } {
  if (connection.source_of_truth === "store") return { pushStock: false, pushPrices: false };
  return { pushStock: Boolean(connection.push_stock), pushPrices: Boolean(connection.push_prices) };
}

/**
 * The stock axis of a scheduled push for one product, or null when none may be sent.
 *
 *   - The store already manages this product's stock → send the quantity alone.
 *   - It does not (or the shape was never recorded) → only with the owner's
 *     opt-in, and then `manage_stock: true` goes with it, because a quantity
 *     on an untracked product is ignored by WooCommerce.
 *   - Otherwise nothing: this app does not know the product is tracked, and
 *     inventing a figure for it is how a catalogue ends up "out of stock".
 */
export function stockPushPayload(input: {
  quantity: number;
  remoteManageStock: unknown;
  manageStockOptIn: boolean;
}): { stock_quantity: number; manage_stock?: true } | null {
  if (input.remoteManageStock === true) return { stock_quantity: input.quantity };
  if (input.manageStockOptIn) return { stock_quantity: input.quantity, manage_stock: true };
  return null;
}

/** A stock/price push this old was computed from a catalogue that has since moved on. */
export const STALE_PUSH_JOB_HOURS = 24;

/** What the store last reported for one product (written by `recordProductShape`). */
export interface RemoteProductState {
  remoteManageStock?: unknown;
  remoteStockQuantity?: unknown;
  remoteRegularPriceRial?: unknown;
}

/**
 * Does applying this queued push change nothing, because the store already
 * reports exactly this value? Only an exact, recorded match counts — an
 * unrecorded or unparseable figure is "unknown", never "equal".
 */
export function isNoopPush(
  entityType: string,
  payload: unknown,
  remote: RemoteProductState,
  currencyUnit: Parameters<typeof wooAmountToRial>[1],
): boolean {
  const body = (payload ?? {}) as Record<string, unknown>;
  if (entityType === "stock") {
    if (typeof body.stock_quantity !== "number") return false;
    if (typeof remote.remoteStockQuantity !== "number") return false;
    // A push that would switch tracking on is a change even at the same number.
    if (body.manage_stock === true && remote.remoteManageStock !== true) return false;
    return remote.remoteStockQuantity === body.stock_quantity;
  }
  if (entityType === "price") {
    const price = body.regular_price;
    if (typeof price !== "string" && typeof price !== "number") return false;
    if (typeof remote.remoteRegularPriceRial !== "string") return false;
    try {
      return wooAmountToRial(price, currencyUnit).toString() === remote.remoteRegularPriceRial;
    } catch {
      return false;
    }
  }
  return false;
}

/** Is this timestamp older than STALE_PUSH_JOB_HOURS? An unreadable one is not stale. */
export function isStalePushJob(updatedAt: string | Date | null | undefined, now: Date): boolean {
  if (!updatedAt) return false;
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return false;
  return now.getTime() - ms > STALE_PUSH_JOB_HOURS * 3_600_000;
}
