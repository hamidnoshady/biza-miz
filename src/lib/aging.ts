/**
 * Phase 16 — subledger aging, the pure part. Shared by AR (ar-service.ts)
 * and AP (ap-service.ts): a credit order/purchase posts its full amount to
 * the control account the instant it's rung up (no partial/unpaid state —
 * see postExactOrderPaymentEntry/postExactPurchaseEntry in ledger-service.ts),
 * so there is no per-invoice/per-bill "amount still open" already tracked
 * anywhere. Aging has to reconstruct it: given a party's open items
 * (invoices owed to the business, or bills the business owes) and the
 * payments recorded against their balance, apply the payments FIFO against
 * the oldest open items first and see what's left of each one as of a date.
 *
 * DB orchestration (fetching the lines, resolving customer/supplier names)
 * lives in ar-service.ts/ap-service.ts and is not unit-tested directly, per
 * repo convention.
 */

/**
 * Group key for subledger lines carrying no party attribution — a manual
 * journal entry against A/R, or a credit order predating customer attribution.
 *
 * Lives in this pure module rather than in `ar-service` because client
 * components need it too (the A/R statement hides its "open the CRM file" link
 * for unattributed lines), and importing `ar-service` into a client component
 * drags the Postgres driver into the browser bundle — which is a build
 * failure, not a subtle one.
 */
export const UNKNOWN_CUSTOMER_KEY = "unknown";

/**
 * Group key for A/P lines carrying no supplier attribution — a manual journal
 * entry against A/P, or a credit purchase predating supplier attribution.
 *
 * The A/P mirror of {@link UNKNOWN_CUSTOMER_KEY}, in this pure module for the
 * same reason: client components (the payables screen, the supplier statement)
 * need the sentinel to hide their «پرداخت» action and directory link for the
 * unattributed bucket, and importing `ap-service` into a client component would
 * drag the Postgres driver into the browser bundle. `ap-service` re-exports it
 * for its own callers, exactly as `ar-service` re-exports the customer key.
 */
export const UNKNOWN_SUPPLIER_KEY = "unknown";

export interface OpenItem {
  id: string;
  date: string; // ISO date
  amount: number; // Rial, positive
}

export interface Payment {
  id: string;
  date: string; // ISO date
  amount: number; // Rial, positive
}

export type AgingBucket = "current" | "d31_60" | "d61_90" | "over90";

export const AGING_BUCKETS: AgingBucket[] = ["current", "d31_60", "d61_90", "over90"];

/**
 * The Persian label for each bucket.
 *
 * Here rather than in each screen because the A/R table, the A/P table and the
 * CRM's customer file all name these buckets, and three private copies of the
 * same four strings is three chances for «بیش از ۹۰ روز» to become «۹۰+ روز»
 * on one screen and not the others. A customer reading two screens should not
 * have to work out whether they mean the same thing.
 */
export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "جاری (۰-۳۰ روز)",
  d31_60: "۳۱-۶۰ روز",
  d61_90: "۶۱-۹۰ روز",
  over90: "بیش از ۹۰ روز",
};

/**
 * The oldest bucket holding anything — the collections signal.
 *
 * Returns null when nothing is overdue. `current` is money owed but not yet
 * late, which is a normal state and deliberately not reported as a problem.
 */
export function oldestOverdueBucket(
  summary: Partial<Record<AgingBucket, number>>,
): AgingBucket | null {
  if ((summary.over90 ?? 0) > 0) return "over90";
  if ((summary.d61_90 ?? 0) > 0) return "d61_90";
  if ((summary.d31_60 ?? 0) > 0) return "d31_60";
  return null;
}

/**
 * The inclusive upper age of each bucket, in days — the *definition* of the
 * boundaries, in one place.
 *
 * `bucketForAge` reads it, and `agingBucketCaseSql` below generates the SQL
 * `CASE` from it, so the JS report and the SQL report cannot drift: moving a
 * boundary is one edit here, not two edits and a silent disagreement between
 * two screens that are supposed to show the same number.
 */
export const AGING_BUCKET_MAX_AGE_DAYS: Record<AgingBucket, number> = {
  current: 30,
  d31_60: 60,
  d61_90: 90,
  // Open-ended: everything older.
  over90: Number.POSITIVE_INFINITY,
};

/** 0-30 days old = current, then 30-day buckets out to 90+. */
export function bucketForAge(ageDays: number): AgingBucket {
  if (ageDays <= AGING_BUCKET_MAX_AGE_DAYS.current) return "current";
  if (ageDays <= AGING_BUCKET_MAX_AGE_DAYS.d31_60) return "d31_60";
  if (ageDays <= AGING_BUCKET_MAX_AGE_DAYS.d61_90) return "d61_90";
  return "over90";
}

/**
 * The SQL twin of {@link bucketForAge}: a `CASE` expression over an age in
 * days, built from {@link AGING_BUCKET_MAX_AGE_DAYS}.
 *
 * Exists because the subledger aging reports aggregate in PostgreSQL now
 * (a tenant with years of history must not ship every A/R line to Node just to
 * add it up). The buckets a person reads there still have to be the buckets
 * `bucketForAge` defines — so the SQL is generated from the same table rather
 * than transcribed, which is the only way two implementations stay one.
 */
export function agingBucketCaseSql(ageDaysExpression: string): string {
  const buckets: AgingBucket[] = ["current", "d31_60", "d61_90"];
  const cases = buckets
    .map((bucket) => `WHEN ${ageDaysExpression} <= ${AGING_BUCKET_MAX_AGE_DAYS[bucket]} THEN '${bucket}'`)
    .join(" ");
  return `CASE ${cases} ELSE 'over90' END`;
}

export interface AgedItem extends OpenItem {
  outstanding: number;
  ageDays: number;
  bucket: AgingBucket;
}

/**
 * Applies the total of `payments` against `items` oldest-first (FIFO),
 * returning only the items still carrying a balance as of `asOfDate`, each
 * with its remaining amount and age bucket. Callers should already have
 * filtered both lists to dates on or before `asOfDate`.
 *
 * FIFO against the party's total rather than matching a payment to a
 * specific item: nothing records which item a payment was "for" (the
 * product decision was a running balance per party, not per-item
 * allocation), so oldest-first is the standard, deterministic stand-in.
 */
export function ageOpenItems(items: OpenItem[], payments: Payment[], asOfDate: string): AgedItem[] {
  // Journal lines can share an accounting date. Use their stable source id as
  // a final key so FIFO allocation matches the deterministic order returned by
  // both subledger statements across requests.
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let pool = payments.reduce((sum, p) => sum + p.amount, 0);
  const asOfMs = Date.parse(asOfDate);

  const result: AgedItem[] = [];
  for (const item of sorted) {
    const applied = Math.min(pool, item.amount);
    pool -= applied;
    const outstanding = item.amount - applied;
    if (outstanding <= 0) continue;
    const ageDays = Math.floor((asOfMs - Date.parse(item.date)) / 86_400_000);
    result.push({ ...item, outstanding, ageDays, bucket: bucketForAge(ageDays) });
  }
  return result;
}

/**
 * The part of `payments` FIFO could never reach — the party's *unapplied
 * credit*: an advance, an overpayment, or a receipt bigger than everything
 * owed. `ageOpenItems` drops it because there is no open item left to age,
 * but the credit is real money on the party's balance, and a report that
 * forgets it stops agreeing with the control account the moment one
 * customer pays ahead.
 *
 * FIFO applies payments oldest-first, so the applied total is always
 * `min(paid, owed)` and the leftover is whatever `paid` exceeds `owed` by.
 */
export function unappliedCredit(items: OpenItem[], payments: Payment[]): number {
  const owed = items.reduce((sum, item) => sum + item.amount, 0);
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);
  return Math.max(0, paid - owed);
}

export type AgingSummary = Record<AgingBucket, number> & { total: number };

export function summarizeAging(aged: AgedItem[]): AgingSummary {
  const sums: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const item of aged) {
    sums[item.bucket] += item.outstanding;
    sums.total += item.outstanding;
  }
  return sums;
}
