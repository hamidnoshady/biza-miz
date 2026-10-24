/**
 * شرح اسناد سیستمی — the Persian text of every *system-generated* journal memo,
 * and the one presentation rule that reads historical documents back.
 *
 * Issue #1060: a handful of automatic posting paths persisted English prose
 * (`Order payment`, `Cost of goods sold`, …) into `journal_entries.memo`, so
 * the otherwise-Persian «دفتر روزنامه» and «آخرین اسناد» printed English in
 * the شرح column. Those strings are *history* — posted documents are never
 * rewritten — so the fix has two independent halves, both living here:
 *
 *  1. **New postings persist Persian, by key.** A posting path calls
 *     `systemJournalMemo("order_payment")` and stores the Persian text, the
 *     way every other posting rule in this codebase already stores Persian
 *     prose. The stable key is the code-level identity; the persisted memo
 *     stays human-readable, searchable, exportable and sync-safe without
 *     needing this table to be present on the reader's device. English prose
 *     is never scattered at call sites again — `journal-memo.test.ts` greps
 *     `src/` for English `memo: "…"` literals so a new one fails the build.
 *
 *  2. **Historical rows are localized at presentation, never in the DB.**
 *     `journalMemoForDisplay(memo, sourceType)` returns the Persian text only
 *     when the stored memo is, byte-for-byte (after trimming), one of the
 *     known legacy system strings *and* the entry's `source_type` is one of
 *     the sources that posting path emits. Everything else — an unknown
 *     string, a missing source, and above all a user-typed memo on a manual
 *     journal (`source_type = 'manual'`) — comes back untouched, even if the
 *     user typed exactly `Order payment`. That source check is what separates
 *     "the system wrote this" from "a person wrote this", and it is why this
 *     is not a blind global string replacement over somebody's notes.
 *
 * Raw vs. displayed ─ APIs, sync payloads and the audit trail keep the raw
 * stored memo; this module only runs where a person reads (journal list and
 * detail, recent entries, drill-downs, reversal summary, Persian-facing
 * exports/print). Search runs on the raw column, so `journalMemoSearchAliases`
 * bridges the two spellings: a Persian query that matches a display text also
 * finds the historical English rows, and an English query also finds the
 * Persian rows persisted after this change.
 *
 * Framework-free on purpose (like `ledger-source-labels.ts`, its sibling):
 * server export builders and client components read the same table.
 */

export interface SystemJournalMemoDefinition {
  /** Persian template. New postings persist this text (after `{param}` interpolation). */
  fa: string;
  /**
   * The exact English memo the pre-#1060 posting path persisted, matched
   * whole-string at presentation so historical documents read in Persian.
   * `null` for keys whose persisted text was always Persian (templates) —
   * they localize nothing on read.
   */
  legacyEn: string | null;
  /**
   * `journal_entries.source_type` values the posting path emits this memo
   * under. The presentation rule requires the entry's source to be listed:
   * it is the evidence that the system, not a person, wrote the text.
   */
  sourceTypes: readonly string[];
}

export const SYSTEM_JOURNAL_MEMOS = {
  // postExactOrderPaymentEntry (`order`), replays under `order_amendment`.
  order_payment: {
    fa: "پرداخت سفارش",
    legacyEn: "Order payment",
    sourceTypes: ["order", "order_amendment"],
  },
  // postExactCogsEntry — same sources as the payment.
  order_cogs: {
    fa: "بهای تمام‌شده کالای فروش‌رفته",
    legacyEn: "Cost of goods sold",
    sourceTypes: ["order", "order_amendment"],
  },
  // postExactPurchaseEntry; the legacy number-based twin already persisted
  // this exact Persian wording, so both generations now read alike.
  purchase_receipt: {
    fa: "دریافت کالای خرید",
    legacyEn: "Purchase receipt",
    sourceTypes: ["purchase"],
  },
  // postExactNegativeSettlementEntry carries its caller's source: purchases,
  // production runs and stock counts (and their reversal) settle through it.
  negative_stock_cost_settlement: {
    fa: "تسویهٔ بهای موجودی منفی",
    legacyEn: "Negative stock cost settlement",
    sourceTypes: ["purchase", "production", "stock_count", "stock_count_reversal"],
  },
  supplier_return: {
    fa: "برگشت به تأمین‌کننده",
    legacyEn: "Supplier return",
    sourceTypes: ["supplier_return"],
  },
  customer_refund: {
    fa: "بازپرداخت به مشتری",
    legacyEn: "Customer refund",
    sourceTypes: ["customer_return"],
  },
  // Inventory recovered on a customer return (DR inventory / CR COGS).
  customer_return_cogs_reversal: {
    fa: "برگشت بهای تمام‌شدهٔ مرجوعی مشتری",
    legacyEn: "Customer return inventory recovery",
    sourceTypes: ["customer_return"],
  },
  inventory_nrv_write_down: {
    fa: "کاهش ارزش موجودی به خالص ارزش فروش",
    legacyEn: "Inventory NRV write-down",
    sourceTypes: ["inventory_write_down"],
  },
  inventory_nrv_reversal: {
    fa: "برگشت کاهش ارزش موجودی",
    legacyEn: "Inventory NRV reversal",
    sourceTypes: ["inventory_write_down"],
  },
  inventory_transfer_shipped: {
    fa: "ارسال انتقال موجودی",
    legacyEn: "Inventory transfer shipped",
    sourceTypes: ["inventory_transfer"],
  },
  inventory_transfer_received: {
    fa: "دریافت انتقال موجودی",
    legacyEn: "Inventory transfer received",
    sourceTypes: ["inventory_transfer"],
  },
  inventory_transfer_cancellation: {
    fa: "لغو انتقال موجودی",
    legacyEn: "Inventory transfer cancellation",
    sourceTypes: ["inventory_transfer_cancel"],
  },
  /**
   * The reversing document's default memo — a *template* over the original's
   * own memo. Callers pass the original through `journalMemoForDisplay`
   * first, so reversing a historical system document never re-persists its
   * English text into a brand-new document, while a person's own manual
   * memo is quoted back exactly as written.
   */
  journal_reversal: {
    fa: "برگشت سند: {originalMemo}",
    legacyEn: null,
    sourceTypes: ["manual"],
  },
  journal_reversal_fx: {
    fa: "برگشت سند ارزی: {originalMemo}",
    legacyEn: null,
    sourceTypes: ["multicurrency", "fx_settlement", "fx_revaluation"],
  },
} as const satisfies Record<string, SystemJournalMemoDefinition>;

export type SystemJournalMemoKey = keyof typeof SYSTEM_JOURNAL_MEMOS;

/** The definitions widened to the interface, for the read-side lookups below. */
const DEFINITIONS: readonly SystemJournalMemoDefinition[] = Object.values(SYSTEM_JOURNAL_MEMOS);

/** Every legacy English system memo the presentation rule knows, for tests and audits. */
export const LEGACY_SYSTEM_JOURNAL_MEMOS: readonly string[] = DEFINITIONS
  .map((def) => def.legacyEn)
  .filter((text): text is string => text !== null);

/**
 * The Persian memo a new automatic posting persists.
 *
 * `{name}` placeholders in the template are replaced from `params`; a missing
 * parameter becomes an empty string rather than leaking the literal braces
 * into a posted document.
 */
export function systemJournalMemo(
  key: SystemJournalMemoKey,
  params?: Readonly<Record<string, string | null | undefined>>,
): string {
  return SYSTEM_JOURNAL_MEMOS[key].fa
    .replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? "")
    .trim();
}

/**
 * The memo a Persian-facing view or export shows for one journal entry.
 *
 * - A known legacy system string under one of its posting sources → Persian.
 * - Anything else → the raw stored memo, byte-for-byte (null stays null, so
 *   each surface's own «بدون شرح» fallback keeps working). In particular a
 *   `manual` entry, an entry with no known source, and free-form user text
 *   are returned exactly as the person wrote them.
 *
 * `sourceType` is the entry's own `journal_entries.source_type`. Callers that
 * cannot name it get the raw text: without provenance there is no safe way to
 * tell a system memo from a person's English note.
 */
export function journalMemoForDisplay(
  memo: string | null | undefined,
  sourceType?: string | null,
): string | null {
  if (memo == null) return null;
  const source = sourceType?.trim();
  if (!source) return memo;
  const text = memo.trim();
  if (!text) return memo;
  for (const def of DEFINITIONS) {
    if (def.legacyEn === null || def.legacyEn !== text) continue;
    // A templated Persian text cannot be interpolated on read (its parameters
    // were the posting's, not the reader's) — such keys never display-localize.
    if (def.fa.includes("{")) continue;
    if (def.sourceTypes.includes(source)) return def.fa;
  }
  return memo;
}

/**
 * A Persian query is usually typed with a space where the stored label uses
 * a ZWNJ («تمام شده» for «تمام‌شده»); alias detection ignores both so the
 * common spelling still bridges to the historical rows.
 */
function squashForMatch(text: string): string {
  return text.replace(/[\s\u200c]+/g, "").toLowerCase();
}

/**
 * The other spelling(s) a journal search must also match, as exact raw memos.
 *
 * Search filters run against the stored column, but the reader searches for
 * the words on screen: «پرداخت سفارش» must find the historical
 * `Order payment` documents it is the translation of, and `Order payment`
 * must find the «پرداخت سفارش» documents persisted after the fix. Returns
 * whole-memo raw strings for an equality arm of the search predicate; an
 * unrelated (or empty) query yields none.
 */
export function journalMemoSearchAliases(query: string | null | undefined): string[] {
  const q = query?.trim();
  if (!q) return [];
  const squashed = squashForMatch(q);
  const aliases = new Set<string>();
  for (const def of DEFINITIONS) {
    if (def.legacyEn === null || def.fa.includes("{")) continue;
    if (squashForMatch(def.fa).includes(squashed)) aliases.add(def.legacyEn);
    if (def.legacyEn.toLowerCase().includes(q.toLowerCase())) aliases.add(def.fa);
  }
  return [...aliases];
}
