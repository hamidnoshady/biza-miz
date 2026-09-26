/**
 * Retail split-payment support — how a retail invoice's tenders (۲۰۰٬۰۰۰
 * نقدی plus ۳۰۰٬۰۰۰ کارت‌خوان) turn into per-line ledger debits.
 *
 * The café's split payment (payment-draft.ts, migration 0091) settles ONE
 * order total across several ways with ONE journal entry. A retail invoice
 * has no single total to settle: it is N independently-priced lines, each
 * posted by its own industry service (gold/watch/accessory/cosmetic/trade-
 * goods) through its own revenue entry, and each of those entries must
 * balance on its own. So a retail split can't reuse the café's one-entry
 * shape; instead, the invoice's tenders are a shared, mutable queue that
 * every line draws its own total off of, in order — line 1 might end up
 * "۱۰۰٪ نقدی" and line 2 "نیمی نقدی نیمی کارت" purely because of where the
 * queue happened to be when it was line 2's turn, which is fine: nothing
 * shows a line's own split anywhere, only the invoice's (what `payments`
 * stores, from the cashier's original slices — see resolveTenderAmounts).
 *
 * A tender may omit its amount — "take whatever the invoice comes to" — the
 * same convenience the café's payment-draft.ts gives its last slice, and the
 * only way a single-method sale (still the overwhelming common case) can pay
 * without knowing the total before it's priced. At most one tender per
 * invoice may do this; it always resolves last, regardless of where the
 * cashier put it, so the bounded slices are drawn from first and the open
 * one only ever covers what they didn't.
 */
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";

/** One slice of a retail invoice's payment, as a caller sends it. */
export interface RetailTenderInput {
  method: SettlementMethod;
  /** Omit for "whatever the invoice comes to" — at most one per invoice. */
  amount?: RialText;
}

/** One slice, fully resolved to a concrete Rial amount. */
export interface RetailTender {
  method: SettlementMethod;
  amount: RialText;
}

/** The running queue `drawTenders` consumes from, one invoice line at a time. */
export interface RetailTenderQueueEntry {
  method: SettlementMethod;
  /** `null` marks the (at most one) open tender — unlimited until the invoice is fully priced. */
  remaining: bigint | null;
}

export const MAX_RETAIL_TENDERS = 10;

const MISMATCH_MESSAGE = "مجموع پرداختی‌ها با مبلغ فاکتور مطابقت ندارد.";

/** A tender list that doesn't make sense on its own — before any pricing has happened. */
export class RetailTenderError extends Error {}

/**
 * Validates the cashier's tender list and turns it into the running queue
 * `settleLine` threads through every sell call. The open tender (if any)
 * always sorts last, so it only ever picks up what the bounded ones left.
 */
export function buildTenderQueue(tenders: readonly RetailTenderInput[]): RetailTenderQueueEntry[] {
  if (!Array.isArray(tenders) || tenders.length === 0) {
    throw new RetailTenderError("حداقل یک روش پرداخت لازم است.");
  }
  if (tenders.length > MAX_RETAIL_TENDERS) {
    throw new RetailTenderError("تعداد روش‌های پرداخت بیش از حد مجاز است.");
  }
  const open = tenders.filter((t) => t.amount === undefined || t.amount === null);
  if (open.length > 1) {
    throw new RetailTenderError("حداکثر یک روش پرداخت می‌تواند بدون مبلغ (باقی‌مانده) باشد.");
  }
  const bounded = tenders.filter((t) => t.amount !== undefined && t.amount !== null);
  for (const t of bounded) {
    if (rialBigInt(t.amount as RialText) <= 0n) {
      throw new RetailTenderError("مبلغ پرداختی باید مثبت باشد.");
    }
  }
  return [
    ...bounded.map((t) => ({ method: t.method, remaining: rialBigInt(t.amount as RialText) })),
    ...open.map((t) => ({ method: t.method, remaining: null as bigint | null })),
  ];
}

/**
 * Draws exactly `amount` off the front of the queue for one invoice line,
 * across as many tenders as it takes, and returns what was drawn grouped by
 * method. Mutates `queue` in place — the next line continues where this one
 * left off, which is what keeps one invoice's tenders from being spent
 * twice across its lines. Throws if the bounded tenders run out before the
 * line is covered (and there is no open tender left to fall back on).
 */
export function drawTenders(queue: RetailTenderQueueEntry[], amount: RialText): RetailTender[] {
  let need = rialBigInt(amount);
  if (need < 0n) throw new RetailTenderError("مبلغ نامعتبر است.");
  const drawn = new Map<SettlementMethod, bigint>();
  while (need > 0n) {
    const head = queue[0];
    if (!head) throw new RetailTenderError(MISMATCH_MESSAGE);
    if (head.remaining === null) {
      drawn.set(head.method, (drawn.get(head.method) ?? 0n) + need);
      need = 0n;
      break;
    }
    const take = head.remaining < need ? head.remaining : need;
    drawn.set(head.method, (drawn.get(head.method) ?? 0n) + take);
    head.remaining -= take;
    need -= take;
    if (head.remaining === 0n) queue.shift();
  }
  return [...drawn].map(([method, amt]) => ({ method, amount: rialText(amt.toString()) }));
}

/** Whatever a bounded tender never got drawn — nonzero means the slices added up to more than the invoice. */
export function remainingBoundedTotal(queue: readonly RetailTenderQueueEntry[]): bigint {
  return queue.reduce((sum, entry) => sum + (entry.remaining ?? 0n), 0n);
}

/** Call once every line has been priced and drawn from — refuses a split that overshot the invoice. */
export function assertTendersExhausted(queue: readonly RetailTenderQueueEntry[]): void {
  if (remainingBoundedTotal(queue) > 0n) throw new RetailTenderError(MISMATCH_MESSAGE);
}

/**
 * What each ORIGINAL input tender resolved to, once the invoice's real total
 * is known: the open tender (if any) becomes the exact remainder, every
 * other slice keeps the amount the cashier typed. This — not however the
 * per-line ledger draw fragmented things — is what `payments` stores, one
 * row per slice, exactly as the till rang it up.
 */
export function resolveTenderAmounts(
  tenders: readonly RetailTenderInput[],
  invoiceTotal: RialText,
): RetailTender[] {
  const boundedSum = tenders.reduce(
    (sum, t) => sum + (t.amount !== undefined && t.amount !== null ? rialBigInt(t.amount) : 0n),
    0n,
  );
  const openAmount = rialBigInt(invoiceTotal) - boundedSum;
  return tenders.map((t) => ({
    method: t.method,
    amount: t.amount !== undefined && t.amount !== null ? t.amount : rialText(openAmount.toString()),
  }));
}

/**
 * Groups a line's resolved tenders by the GL account they post to, so two
 * ways that resolve to the same account (any two non-cash, non-credit ways
 * both post to Bank-Clearing) become one debit line, not a duplicate.
 */
export function groupTendersByCode(
  tenders: readonly RetailTender[],
  codeFor: (method: SettlementMethod) => string,
): { code: string; amount: RialText }[] {
  const totals = new Map<string, bigint>();
  for (const t of tenders) {
    const code = codeFor(t.method);
    totals.set(code, (totals.get(code) ?? 0n) + rialBigInt(t.amount));
  }
  return [...totals].map(([code, amount]) => ({ code, amount: rialText(amount.toString()) }));
}

/**
 * A sell service's one entry point for "who paid for this line, and how
 * much of each": either the caller already resolved the whole line to one
 * settlement (`paymentMethod` — every pre-split caller: the three
 * standalone quick-sell panels, and any other direct caller), or it hands
 * over the invoice's shared tender queue and this draws the line's own
 * total off the front of it (`tenders`). Exactly one must be given.
 */
export function resolveLineTenders(
  input: { paymentMethod?: SettlementMethod; tenders?: RetailTenderQueueEntry[] },
  lineTotal: RialText,
): RetailTender[] {
  if (input.tenders) return drawTenders(input.tenders, lineTotal);
  if (input.paymentMethod) return [{ method: input.paymentMethod, amount: lineTotal }];
  throw new RetailTenderError("روش پرداخت مشخص نشده است.");
}
