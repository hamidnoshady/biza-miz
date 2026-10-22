/**
 * DB-touching ledger orchestration (not unit-tested directly, per repo
 * convention — pure logic lives in ledger.ts and is what's covered by
 * ledger.test.ts).
 *
 * Everything here runs inside a caller-supplied transaction (`client`) so a
 * journal entry is always atomic with whatever triggered it (order payment,
 * a purchase receipt, a waste entry).
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import {
  buildCogsLines,
  buildOrderPaymentLines,
  buildPurchaseLines,
  buildWasteLines,
  checkBalance,
  revenueAccountCodeForOrderChannel,
  validateJournalLines,
  type JournalLine,
  type OrderChannel,
  type SettlementMethod,
} from "./ledger";
import type { Rial } from "./money";
import { rialBigInt, type RialText } from "./inventory-exact";
import type { LineDimensions } from "./accounting-dimensions";
import { assertDimensionsPostable, dimensionColumnValues, dimensionsFromColumns, hasDimensions } from "./accounting-dimensions-service";
import { resolveTradingAttribution } from "./accounting-dimension-mappings-service";
import { orderChannelRef, platformChannelRef, type TradingDocumentRefs } from "./accounting-dimension-mappings";
import { assignVoucherNumber } from "./voucher-numbering-service";
import { systemJournalMemo } from "./journal-memo";

/**
 * Thrown when an auto-posting event needs a well-known account (by Chart of
 * Accounts code) that doesn't exist for this business — e.g. it was removed
 * while customizing the chart in the setup wizard. Callers turn this into a
 * 409 so the underlying business event (payment, purchase receipt, waste
 * entry) rolls back cleanly instead of silently posting an incomplete entry.
 */
export class MissingLedgerAccountError extends Error {
  code: string;
  constructor(code: string) {
    super(`ledger_account_missing: ${code}`);
    this.code = code;
  }
}

export async function accountIdsByCode(
  client: PoolClient,
  businessId: string,
  codes: string[],
): Promise<Map<string, string>> {
  const uniqueCodes = [...new Set(codes)];
  const { rows } = await client.query<{ code: string; id: string }>(
    "SELECT code, id FROM accounts WHERE business_id = $1 AND code = ANY($2::text[]) AND is_active",
    [businessId, uniqueCodes],
  );
  const map = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of uniqueCodes) {
    if (!map.has(code)) throw new MissingLedgerAccountError(code);
  }
  return map;
}

export interface ExactJournalLine {
  accountId: string;
  debit: RialText;
  credit: RialText;
  /** Optional accounting dimensions (issue #868). See `PostJournalEntryInput.dimensionMirror`. */
  dimensions?: LineDimensions | null;
  /**
   * Multicurrency (issue #863, extended by #862): the foreign side of this leg,
   * in minor units of the entry's transaction currency. Absent means zero —
   * every caller before this one produced base-only lines, and still does.
   *
   * A line on a foreign entry is either a *foreign leg* (exactly one of the two
   * non-zero) or a *base-only leg* (both zero: the FX gain/loss line); the
   * database's deferred trigger enforces that split and that the foreign side
   * balances, so a caller cannot post half a foreign document.
   */
  foreignDebit?: RialText;
  foreignCredit?: RialText;
  /** The party a foreign receivable/payable leg belongs to, when attributed. */
  partyId?: string | null;
}

/**
 * Exported (Phase 21 Wave 1) so posting-engine.ts's dispatchDomainEvent can
 * post a registered rule's lines through the same exact-arithmetic path
 * every inventory-costing-sensitive posting already uses — RialText/BigInt,
 * not the plain-number postJournalEntry, since Wave 2's weight-based gold
 * pricing will need the same precision guarantee this already gives
 * COGS/purchases/waste.
 */
export async function postExactJournalEntry(
  client: PoolClient,
  input: Omit<PostJournalEntryInput, "lines"> & { lines: ExactJournalLine[] },
): Promise<string | null> {
  const lines = input.lines.filter((line) => rialBigInt(line.debit) !== 0n || rialBigInt(line.credit) !== 0n);
  if (lines.length === 0) return null;
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    const lineDebit = rialBigInt(line.debit);
    const lineCredit = rialBigInt(line.credit);
    if (!line.accountId || lineDebit < 0n || lineCredit < 0n || (lineDebit !== 0n && lineCredit !== 0n)) {
      throw new Error("invalid_exact_journal_line");
    }
    debit += lineDebit;
    credit += lineCredit;
  }
  if (debit !== credit) throw new Error("unbalanced_journal_entry");

  const { rows } = await client.query<{ id: string; entry_date: string }>(
    `INSERT INTO journal_entries
       (business_id,location_id,entry_date,memo,source_type,source_id,created_by,posting_kind,inventory_event_id,project_id,
        currency_code,base_currency_code,exchange_rate_id,exchange_rate,rounding_version,rounding_delta,idempotency_key)
     VALUES($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,
            $11,COALESCE($12,'IRR'),$13,$14,$15,COALESCE($16,0),$17)
     RETURNING id, entry_date::text AS entry_date`,
    [
      input.businessId,
      input.locationId,
      input.entryDate ?? null,
      input.memo,
      input.sourceType,
      input.sourceId,
      input.createdBy,
      input.postingKind ?? null,
      input.inventoryEventId ?? null,
      input.projectId ?? null,
      input.currencyCode ?? null,
      input.baseCurrencyCode ?? null,
      input.exchangeRateId ?? null,
      input.exchangeRate ?? null,
      input.roundingVersion ?? null,
      // A base entry carries no rounding delta — the database's snapshot CHECK
      // requires exactly that, so a caller that names a currency must name a
      // rounding policy version or the entry is refused as half-described.
      input.currencyCode ? (input.roundingDelta ?? "0") : 0,
      input.journalIdempotencyKey ?? input.idempotencyKey ?? null,
    ],
  );
  await insertJournalLines(client, input, rows[0].id, lines);
  // Issue #867 — the document's number is part of its identity: assigned in
  // this same transaction from the stored entry_date, so an entry and its
  // voucher number commit together (and a posting that cannot be numbered
  // rolls back with the rest). The voucher columns are outside the fiscal
  // trigger's column set, so numbering does not extend the construction grant.
  await assignVoucherNumber(client, {
    businessId: input.businessId,
    entryId: rows[0].id,
    entryDate: rows[0].entry_date,
    sourceType: input.sourceType,
    voucherReference: input.voucherReference ?? null,
  });
  // The DB line trigger grants insertion into a soft-closed period only while
  // this freshly-created entry is being assembled. Do not let later statements
  // in the same outer transaction reuse that construction marker.
  await client.query("SELECT set_config('app.fiscal_constructing_entry_id', '', true)");
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Operational attribution (issue #868, Phase 3)
// ---------------------------------------------------------------------------
//
// One resolution point for every operational posting: purchases, sales, COGS
// and their returns decide attribution here and stamp it on the cost/revenue
// legs only. Settlement legs (cash, bank, A/P, A/R, VAT) stay unattributed —
// they settle balances, they do not incur or earn them — and reversals never
// consult rules at all: `postExactMirrorEntry` copies the original's stamped
// attribution column for column.
//
// The precedence is the one in `accounting-dimension-mappings.ts`: explicit
// attribution from the caller (a mirror-repost, an amendment, a source
// document that has it) wins per kind; then the business's mapping rules,
// most specific scope first; then «بدون بُعد». Never inferred from unrelated
// data.

/**
 * The channel keys an order sale can be keyed by, most specific first: a
 * platform settlement (SnapFood and friends) outranks the plain order channel.
 */
function salesChannelRefs(tenders: readonly string[], orderChannel: OrderChannel): string[] {
  const refs: string[] = [];
  for (const settlement of tenders) {
    if (SETTLEMENT_DEBIT_CODES[settlement] === WELL_KNOWN_CODES.platformReceivable) {
      refs.push(platformChannelRef(settlement));
    }
  }
  refs.push(orderChannelRef(orderChannel));
  return [...new Set(refs)];
}

/** The item, category and channel references an order's lines carry, for mapping rules. */
async function orderMappingRefs(
  client: PoolClient,
  orderId: string,
): Promise<TradingDocumentRefs> {
  const { rows } = await client.query<{
    menu_item_id: string | null;
    item_id: string | null;
    category_id: string | null;
    channel: string | null;
  }>(
    `SELECT oi.menu_item_id, oi.item_id, mi.category_id, o.type::text AS channel
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = $1`,
    [orderId],
  );
  const itemRefs = new Set<string>();
  const categoryRefs = new Set<string>();
  const channelRefs: string[] = [];
  for (const row of rows) {
    if (row.item_id) itemRefs.add(row.item_id);
    if (row.menu_item_id) itemRefs.add(row.menu_item_id);
    if (row.category_id) categoryRefs.add(row.category_id);
    if (row.channel && channelRefs.length === 0) channelRefs.push(orderChannelRef(row.channel));
  }
  return { itemRefs: [...itemRefs], categoryRefs: [...categoryRefs], channelRefs };
}

/** The supplier a purchase names, for its mapping rules. */
async function purchaseSupplierRef(client: PoolClient, purchaseId: string): Promise<string | null> {
  const { rows } = await client.query<{ supplier_id: string | null }>(
    `SELECT supplier_id FROM purchases WHERE id = $1`,
    [purchaseId],
  );
  return rows[0]?.supplier_id ?? null;
}

/**
 * The attribution an earlier posting recorded for this source document — what
 * a return mirrors (issue #868: «reversals must mirror original dimensions»).
 *
 * Reads the most recent non-reversed entry of the named sources and takes the
 * first line that carries attribution. An original that posted *without*
 * attribution answers `{ found: true, dimensions: {} }` and the return stays
 * unattributed too: mirroring «none» is still mirroring, and filling a return
 * from today's rules would put a cost centre on a document whose sale never
 * had one. `found: false` (no original readable at all) lets the caller fall
 * back to the mapping rules over the same document refs.
 */
async function postedEntryAttribution(
  client: PoolClient,
  businessId: string,
  sourceIds: readonly string[],
  postingKinds: readonly string[],
): Promise<{ found: boolean; dimensions: LineDimensions }> {
  const { rows } = await client.query<{
    cost_center_id: string | null;
    profit_center_id: string | null;
    department_id: string | null;
    detail_dimension_id: string | null;
  }>(
    `SELECT jl.cost_center_id, jl.profit_center_id, jl.department_id, jl.detail_dimension_id
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.business_id = $1
        AND je.source_id = ANY($2::uuid[])
        AND je.posting_kind = ANY($3::text[])
        AND je.reversed_at IS NULL
        AND (jl.cost_center_id IS NOT NULL OR jl.profit_center_id IS NOT NULL
             OR jl.department_id IS NOT NULL OR jl.detail_dimension_id IS NOT NULL)
      ORDER BY je.id DESC, jl.id
      LIMIT 1`,
    [businessId, [...sourceIds], [...postingKinds]],
  );
  const row = rows[0];
  if (row) return { found: true, dimensions: dimensionsFromColumns(row) };
  const { rows: found } = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM journal_entries
      WHERE business_id = $1 AND source_id = ANY($2::uuid[]) AND posting_kind = ANY($3::text[])
      LIMIT 1`,
    [businessId, [...sourceIds], [...postingKinds]],
  );
  return { found: Boolean(found[0]), dimensions: {} };
}

async function operationalAttribution(
  client: PoolClient,
  params: {
    businessId: string;
    entryDate: string | null;
    locationId: string;
    explicit?: LineDimensions | null;
    refs?: TradingDocumentRefs | null;
  },
): Promise<LineDimensions | null> {
  return resolveTradingAttribution(client, {
    businessId: params.businessId,
    entryDate: params.entryDate,
    locationId: params.locationId,
    explicit: params.explicit ?? null,
    refs: params.refs ?? null,
  });
}

/**
 * Audit F11 — the credit side and input-VAT leg shared by both purchase
 * receipt postings. The supplier's invoice may carry VAT on top of the goods
 * value: it is debited to input VAT (`vatReceivable`, 1220 — the account the
 * VAT report reads) and the settlement account is credited goods + VAT, so a
 * credit purchase's payable is what the supplier actually billed. With no VAT
 * the entry is exactly what it always was (and 1220 is not even looked up).
 */
async function purchaseSettlementLines(
  client: PoolClient,
  businessId: string,
  settlementMethod: SettlementMethod,
  goods: RialText,
  vat: RialText | undefined,
): Promise<ExactJournalLine[]> {
  const creditCode =
    settlementMethod === "cash"
      ? WELL_KNOWN_CODES.cash
      : settlementMethod === "bank"
        ? WELL_KNOWN_CODES.bankClearing
        : WELL_KNOWN_CODES.accountsPayable;
  const vatValue = vat ? rialBigInt(vat) : 0n;
  if (vatValue < 0n) throw new Error("invalid_purchase_vat");
  const accounts = await accountIdsByCode(
    client,
    businessId,
    vatValue > 0n ? [creditCode, WELL_KNOWN_CODES.vatReceivable] : [creditCode],
  );
  const lines: ExactJournalLine[] = [];
  if (vatValue > 0n) {
    lines.push({ accountId: accounts.get(WELL_KNOWN_CODES.vatReceivable)!, debit: vat!, credit: "0" as RialText });
  }
  lines.push({
    accountId: accounts.get(creditCode)!,
    debit: "0" as RialText,
    credit: (rialBigInt(goods) + vatValue).toString() as RialText,
  });
  return lines;
}

export async function postExactPurchaseEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    createdBy: string | null;
    total: RialText;
    settlementMethod: SettlementMethod;
    inventoryEventId: string;
    /** Audit F11 — the supplier invoice's VAT (input VAT), on top of `total`. */
    vat?: RialText;
    /**
     * Issue #868 — explicit attribution (a replay that carries the original's).
     * With none, the supplier's mapping rules decide; with no rule, the entry
     * posts unattributed exactly as it always did.
     */
    dimensions?: LineDimensions | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.accountsPayable,
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
  ]);
  const attribution = await operationalAttribution(client, {
    businessId: params.businessId,
    entryDate: null,
    locationId: params.locationId,
    explicit: params.dimensions ?? null,
    refs: { supplierRef: await purchaseSupplierRef(client, params.purchaseId) },
  });
  const settlementLines = await purchaseSettlementLines(client, params.businessId, params.settlementMethod, params.total, params.vat);
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: systemJournalMemo("purchase_receipt"),
    sourceType: "purchase",
    sourceId: params.purchaseId,
    createdBy: params.createdBy,
    postingKind: "receipt",
    inventoryEventId: params.inventoryEventId,
    lines: [
      // The cost leg carries the attribution; the settlement and VAT legs
      // settle balances and stay unattributed.
      {
        accountId: accounts.get(WELL_KNOWN_CODES.inventory)!,
        debit: params.total,
        credit: "0" as RialText,
        dimensions: attribution,
      },
      ...settlementLines,
    ],
  });
}

/**
 * سیستم ادواری — a received purchase under the periodic system. Debits
 * «خرید طی دوره» (5105) instead of the inventory asset; the credit side is
 * the same cash/bank-clearing/AP choice as the perpetual entry. No stock
 * movement or lot accompanies it — the period-close document is what
 * restates 1300 and recognises COGS.
 */
export async function postPeriodicPurchaseEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    createdBy: string | null;
    total: RialText;
    settlementMethod: SettlementMethod;
    /** Audit F11 — the supplier invoice's VAT (input VAT), on top of `total`. */
    vat?: RialText;
    /** Issue #868 — explicit attribution; see `postExactPurchaseEntry`. */
    dimensions?: LineDimensions | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.accountsPayable,
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
  ]);
  const attribution = await operationalAttribution(client, {
    businessId: params.businessId,
    entryDate: null,
    locationId: params.locationId,
    explicit: params.dimensions ?? null,
    refs: { supplierRef: await purchaseSupplierRef(client, params.purchaseId) },
  });
  const settlementLines = await purchaseSettlementLines(client, params.businessId, params.settlementMethod, params.total, params.vat);
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "خرید طی دوره (سیستم ادواری)",
    sourceType: "purchase",
    sourceId: params.purchaseId,
    createdBy: params.createdBy,
    postingKind: "periodic_purchase",
    lines: [
      {
        accountId: accounts.get(WELL_KNOWN_CODES.periodicPurchases)!,
        debit: params.total,
        credit: "0" as RialText,
        dimensions: attribution,
      },
      ...settlementLines,
    ],
  });
}

/**
 * سیستم ادواری — the period-close entry. Recognises
 * COGS = beginning + purchases − ending in one compound entry:
 *
 *   Debit  5100 COGS            (بهای تمام‌شده دوره)
 *   Debit  1300 Inventory       ending value (restate the asset)
 *   Credit 1300 Inventory       beginning value (remove last period's asset)
 *   Credit 5105 خرید طی دوره    purchases value (close it to zero)
 *
 * The two 1300 legs are posted net (one line, signed by direction) so the
 * entry reads as a restatement, not an inflate-then-deflate. When the count
 * finds more than B + P (negative COGS), the COGS leg flips to a credit.
 */
export async function postPeriodicClosingEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    closingId: string;
    createdBy: string | null;
    entryDate: string;
    beginningValue: RialText;
    purchasesValue: RialText;
    endingValue: RialText;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.cogs,
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.periodicPurchases,
  ]);
  const zero = "0" as RialText;
  const beginning = rialBigInt(params.beginningValue);
  const purchases = rialBigInt(params.purchasesValue);
  const ending = rialBigInt(params.endingValue);
  const cogs = beginning + purchases - ending;
  const inventoryDelta = ending - beginning; // net 1300 restatement
  const lines: ExactJournalLine[] = [];
  if (cogs >= 0n) {
    lines.push({ accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: cogs.toString() as RialText, credit: zero });
  } else {
    lines.push({ accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: zero, credit: (-cogs).toString() as RialText });
  }
  if (inventoryDelta >= 0n) {
    lines.push({ accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: inventoryDelta.toString() as RialText, credit: zero });
  } else {
    lines.push({ accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: zero, credit: (-inventoryDelta).toString() as RialText });
  }
  lines.push({
    accountId: accounts.get(WELL_KNOWN_CODES.periodicPurchases)!,
    debit: zero,
    credit: purchases.toString() as RialText,
  });
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    entryDate: params.entryDate,
    memo: "بستن دوره انبار (سیستم ادواری)",
    sourceType: "periodic_closing",
    sourceId: params.closingId,
    createdBy: params.createdBy,
    postingKind: "periodic_closing",
    lines,
  });
}

/**
 * Corrects provisional COGS to the value actually assigned when an incoming
 * quantity closes a negative layer. Shared by purchase receipts and by
 * stock-count surpluses, which settle layers on the same terms.
 */
export async function postExactNegativeSettlementEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    sourceType: string;
    sourceId: string;
    createdBy: string | null;
    upward: RialText;
    downward: RialText;
    inventoryEventId: string;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.cogs,
  ]);
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: systemJournalMemo("negative_stock_cost_settlement"),
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    createdBy: params.createdBy,
    postingKind: "negative_stock_settlement",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: params.upward, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: zero, credit: params.upward },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: params.downward, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: zero, credit: params.downward },
    ],
  });
}

export async function postNegativeStockSettlementEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    createdBy: string | null;
    upward: RialText;
    downward: RialText;
    inventoryEventId: string;
  },
): Promise<string | null> {
  return postExactNegativeSettlementEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "purchase",
    sourceId: params.purchaseId,
    createdBy: params.createdBy,
    upward: params.upward,
    downward: params.downward,
    inventoryEventId: params.inventoryEventId,
  });
}

/** Stock-count variance → shortage to count expense, surplus to count gain. */
export async function postExactStockCountEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    stockCountId: string;
    inventoryEventId: string;
    createdBy: string | null;
    shortageValue: RialText;
    surplusValue: RialText;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.inventoryCountExpense,
    WELL_KNOWN_CODES.inventoryCountGain,
  ]);
  const inventory = accounts.get(WELL_KNOWN_CODES.inventory)!;
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "مغایرت شمارش موجودی",
    sourceType: "stock_count",
    sourceId: params.stockCountId,
    createdBy: params.createdBy,
    postingKind: "variance",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountExpense)!, debit: params.shortageValue, credit: zero },
      { accountId: inventory, debit: zero, credit: params.shortageValue },
      { accountId: inventory, debit: params.surplusValue, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountGain)!, debit: zero, credit: params.surplusValue },
    ],
  });
}

/**
 * Reversal of a posted stock-count variance: the original shortage expense and
 * surplus gain are put back. Uses the reversal row's own source identity so the
 * `(business_id, source_type, source_id, posting_kind)` uniqueness index never
 * collides with the original count's entries.
 */
export async function postExactStockCountReversalEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    stockCountId: string;
    inventoryEventId: string;
    createdBy: string | null;
    shortageValue: RialText;
    surplusValue: RialText;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.inventoryCountExpense,
    WELL_KNOWN_CODES.inventoryCountGain,
  ]);
  const inventory = accounts.get(WELL_KNOWN_CODES.inventory)!;
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "ابطال مغایرت شمارش موجودی",
    sourceType: "stock_count_reversal",
    sourceId: params.stockCountId,
    createdBy: params.createdBy,
    postingKind: "variance_reversal",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: inventory, debit: params.shortageValue, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountExpense)!, debit: zero, credit: params.shortageValue },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountGain)!, debit: params.surplusValue, credit: zero },
      { accountId: inventory, debit: zero, credit: params.surplusValue },
    ],
  });
}

export async function postExactCogsEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    orderId: string;
    createdBy: string | null;
    totalCost: RialText;
    inventoryEventId: string;
    /**
     * Identity and date of the posting. Default to the order itself, today —
     * a closed-order amendment (order-amendment-service.ts) re-posts the
     * corrected sale under its own identity, on the original's date, so it
     * neither collides with the entry it replaced nor moves the sale into the
     * month the correction was made in.
     */
    sourceType?: string;
    sourceId?: string;
    entryDate?: string | null;
    /**
     * Issue #868 — explicit attribution. An amendment re-posting a corrected
     * sale passes the original entry's attribution here, so the correction
     * carries what the sale carried even if a mapping rule changed since.
     */
    dimensions?: LineDimensions | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.cogs,
  ]);
  const attribution = await operationalAttribution(client, {
    businessId: params.businessId,
    entryDate: params.entryDate ?? null,
    locationId: params.locationId,
    explicit: params.dimensions ?? null,
    refs: await orderMappingRefs(client, params.orderId),
  });
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    entryDate: params.entryDate ?? null,
    memo: systemJournalMemo("order_cogs"),
    sourceType: params.sourceType ?? "order",
    sourceId: params.sourceId ?? params.orderId,
    createdBy: params.createdBy,
    postingKind: "cogs",
    inventoryEventId: params.inventoryEventId,
    lines: [
      // The cost of sale carries the sale's own attribution; the inventory
      // credit is the asset leaving the shelves and stays unattributed.
      {
        accountId: accounts.get(WELL_KNOWN_CODES.cogs)!,
        debit: params.totalCost,
        credit: zero,
        dimensions: attribution,
      },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: zero, credit: params.totalCost },
    ],
  });
}

/**
 * Which account a settlement debits. The keys are the `payment_method` enum —
 * a business's own payment ways (migration 0091) each declare one of these, so
 * naming a new way never reaches the ledger.
 */
const SETTLEMENT_DEBIT_CODES: Record<string, string | undefined> = {
  cash: WELL_KNOWN_CODES.cash,
  card: WELL_KNOWN_CODES.bankClearing,
  card_to_card: WELL_KNOWN_CODES.bankClearing,
  online: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
  // Not cash and not a card: a cheque sits in چک‌های نزد صندوق until it clears,
  // and the checkout writes the `cheques` row that says which cheque it is.
  cheque: WELL_KNOWN_CODES.chequesOnHand,
  snappfood: WELL_KNOWN_CODES.platformReceivable,
};

/**
 * One debit line per *account*, not per tender: two card-family ways in one
 * split both land in bank clearing, and an entry with the same account twice
 * on the same side is legal but reads as a duplicate on every report that
 * groups by account. Insertion order is kept so the receipt and the entry list
 * the tenders in the order the cashier took them.
 */
function mergeTendersBySettlement(
  tenders: readonly { settlement: string; amount: bigint }[],
): { settlement: string; amount: bigint }[] {
  const merged: { settlement: string; amount: bigint }[] = [];
  for (const tender of tenders) {
    const code = SETTLEMENT_DEBIT_CODES[tender.settlement];
    const existing = merged.find((other) => code !== undefined && SETTLEMENT_DEBIT_CODES[other.settlement] === code);
    if (existing) existing.amount += tender.amount;
    else merged.push({ ...tender });
  }
  return merged;
}

export async function postExactOrderPaymentEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    orderId: string;
    createdBy: string | null;
    /**
     * The single way the whole bill was settled. Kept for every caller that
     * has one — an amendment re-posting a corrected sale, a retail invoice —
     * and mutually exclusive with `tenders`, which is what a split bill sends.
     */
    method?: string;
    /**
     * A bill settled across several ways (migration 0091): ۲۰۰٬۰۰۰ نقدی plus
     * ۳۰۰٬۰۰۰ کارت‌خوان is two tenders, one debit line each, against the one
     * revenue credit. They must add up to `amount` + `tip` — the entry is the
     * proof the money arrived, so a split that doesn't cover the bill is a
     * caller bug, not something to post half of.
     */
    tenders?: readonly { settlement: string; amount: RialText }[];
    amount: RialText;
    tax: RialText;
    inventoryEventId: string;
    orderChannel: OrderChannel;
    /**
     * A tip collected alongside the bill (issue #160 §4) — added on top of
     * `amount` for the debit side (it's real cash/card movement), but never
     * part of revenue: it's a pass-through liability owed to staff, credited
     * to tipsPayable instead. Optional/defaults to "0" so every pre-existing
     * caller (and the plain-number legacy path, untouched) keeps compiling
     * and behaving exactly as before.
     */
    tip?: RialText;
    /**
     * The commission an online ordering platform (SnapFood, issue #160 §4)
     * keeps out of `amount + tip` before remitting the rest. Only valid with
     * `method: "snappfood"` — a business owner resolves the % (it varies by
     * contract) to a Rial amount before calling this, the same "caller
     * resolves the setting to an amount" shape `tip` already uses. Optional/
     * defaults to "0".
     */
    platformCommission?: RialText;
    /**
     * The unpaid remainder of a settle-with-difference checkout (the manual
     * «مبلغ دریافتی» flow): what the tenders fell short of the bill, posted
     * as a debit to Accounts Receivable — the customer's debt. Mutually
     * exclusive with `customerCredit` by construction (settlementDifference
     * never fills both); both zero for an exact settlement.
     */
    balanceDue?: RialText;
    /**
     * The overpaid excess of a settle-with-difference checkout: what the
     * tenders exceeded the bill by, posted as a credit to the store-credit
     * liability (2410) — the customer's credit. Reconstructed per customer
     * from the `order.customer_credit_issued` domain event, never a column.
     */
    customerCredit?: RialText;
    /**
     * Identity and date of the posting, defaulting to the order itself, today.
     * A closed-order amendment re-posts the corrected sale under its own
     * identity on the original's date — see postExactCogsEntry's note.
     */
    sourceType?: string;
    sourceId?: string;
    entryDate?: string | null;
    /**
     * Issue #868 — explicit attribution (a mirror-repost, an amendment
     * carrying the original's). With none, the business's mapping rules
     * decide from the order's channel/items; with no rule the revenue posts
     * unattributed exactly as it always did.
     */
    dimensions?: LineDimensions | null;
  },
): Promise<string | null> {
  const tip = rialBigInt(params.tip ?? ("0" as RialText));
  if (tip < 0n) throw new Error("negative_tip");
  const commission = rialBigInt(params.platformCommission ?? ("0" as RialText));
  if (commission < 0n) throw new Error("negative_commission");
  const balanceDue = rialBigInt(params.balanceDue ?? ("0" as RialText));
  if (balanceDue < 0n) throw new Error("negative_balance_due");
  const customerCredit = rialBigInt(params.customerCredit ?? ("0" as RialText));
  if (customerCredit < 0n) throw new Error("negative_customer_credit");
  if (balanceDue > 0n && customerCredit > 0n) throw new Error("difference_is_one_sided");

  // What actually changed hands: the bill plus the tip. Whether that arrived
  // as one tender or five, the credit side below is identical — which is the
  // reason a split bill is one entry with several debit lines rather than
  // several entries, each re-crediting the same revenue.
  const totalCollected = rialBigInt(params.amount) + tip + customerCredit - balanceDue;
  // A zero-total order (everything on it was comped or voided) collects
  // nothing, and has no debit line to post — postExactJournalEntry drops the
  // whole entry once the credits are zero too. It reaches here rather than
  // being refused because completing such an order is legitimate.
  const tenders =
    totalCollected === 0n && balanceDue === 0n
      ? []
      : mergeTendersBySettlement(
          params.tenders?.length
            ? params.tenders.map((tender) => ({ settlement: tender.settlement, amount: rialBigInt(tender.amount) }))
            : [{ settlement: params.method ?? "", amount: totalCollected }],
        );
  for (const tender of tenders) {
    if (!SETTLEMENT_DEBIT_CODES[tender.settlement]) {
      throw new Error(`unknown_payment_method: ${tender.settlement}`);
    }
    if (tender.amount <= 0n) throw new Error("invalid_tender_amount");
  }
  if (tenders.reduce((sum, tender) => sum + tender.amount, 0n) !== totalCollected) {
    // The invariant, stated plainly: tendered + unpaid remainder − the excess
    // handed over must equal the bill + tip. Under- and over-payment included,
    // this is the one equation every settle-with-difference entry satisfies.
    throw new Error("tender_total_mismatch");
  }
  const platformTenderTotal = tenders.reduce(
    (total, tender) => (tender.settlement === "snappfood" ? total + tender.amount : total),
    0n,
  );
  if (commission > 0n && platformTenderTotal === 0n) {
    throw new Error("commission_requires_platform_method");
  }
  // Keep a malformed caller from creating a negative platform-receivable line.
  // The settings-driven checkout path can never hit this with a valid 0–100%
  // rate, but the ledger boundary should enforce the invariant independently
  // of its callers.
  if (commission > platformTenderTotal) {
    throw new Error("commission_exceeds_platform_tender");
  }

  const codes: string[] = [
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
    WELL_KNOWN_CODES.accountsReceivable,
    WELL_KNOWN_CODES.dineInRevenue,
    WELL_KNOWN_CODES.takeawayRevenue,
    WELL_KNOWN_CODES.deliveryRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ];
  // Only required when there's actually a tip to post — a business that
  // never uses tips (or removed the account while customizing its chart)
  // shouldn't have every ordinary, tip-free sale start failing.
  if (tip > 0n) codes.push(WELL_KNOWN_CODES.tipsPayable);
  if (tenders.some((tender) => tender.settlement === "snappfood")) codes.push(WELL_KNOWN_CODES.platformReceivable);
  if (commission > 0n) codes.push(WELL_KNOWN_CODES.platformCommissionExpense);
  // Only resolved when a settle-with-difference checkout actually created a
  // customer credit — the ordinary, exact sale never asks for the account.
  if (customerCredit > 0n) codes.push(WELL_KNOWN_CODES.storeCreditPayable);
  const accounts = await accountIdsByCode(client, params.businessId, codes);

  const revenue = rialBigInt(params.amount) - rialBigInt(params.tax);
  if (revenue < 0n) throw new Error("tax_exceeds_payment");
  const revenueCode = revenueAccountCodeForOrderChannel(params.orderChannel, {
    dineInRevenue: WELL_KNOWN_CODES.dineInRevenue,
    takeawayRevenue: WELL_KNOWN_CODES.takeawayRevenue,
    deliveryRevenue: WELL_KNOWN_CODES.deliveryRevenue,
  });
  const orderRefs = await orderMappingRefs(client, params.orderId);
  const attribution = await operationalAttribution(client, {
    businessId: params.businessId,
    entryDate: params.entryDate ?? null,
    locationId: params.locationId,
    explicit: params.dimensions ?? null,
    refs: {
      ...orderRefs,
      channelRefs: [...salesChannelRefs(tenders.map((t) => t.settlement), params.orderChannel), ...(orderRefs.channelRefs ?? [])],
    },
  });
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    entryDate: params.entryDate ?? null,
    memo: systemJournalMemo("order_payment"),
    sourceType: params.sourceType ?? "order",
    sourceId: params.sourceId ?? params.orderId,
    createdBy: params.createdBy,
    postingKind: "revenue",
    inventoryEventId: params.inventoryEventId,
    lines: [
      ...tenders.map((tender) => ({
        accountId: accounts.get(SETTLEMENT_DEBIT_CODES[tender.settlement]!)!,
        // SnapFood never hands over the commission slice — the receivable is
        // net of it, and the expense line below is the other half of that.
        debit: (tender.settlement === "snappfood" ? tender.amount - commission : tender.amount).toString() as RialText,
        credit: zero,
      })),
      ...(commission > 0n
        ? [{ accountId: accounts.get(WELL_KNOWN_CODES.platformCommissionExpense)!, debit: commission.toString() as RialText, credit: zero }]
        : []),
      // The unpaid remainder of an underpayment: the customer's debt, on the
      // same Accounts Receivable a نسیه tender debits, attributed to the
      // order's customer by the AR subledger's order join.
      ...(balanceDue > 0n
        ? [{ accountId: accounts.get(WELL_KNOWN_CODES.accountsReceivable)!, debit: balanceDue.toString() as RialText, credit: zero }]
        : []),
      {
        accountId: accounts.get(revenueCode)!,
        debit: zero,
        // The sale's own attribution (issue #868): revenue keeps the source
        // the mapping rules resolved for this order. Settlement, VAT and
        // liability legs stay unattributed — they settle balances.
        credit: revenue.toString() as RialText,
        dimensions: attribution,
      },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: params.tax },
      ...(tip > 0n
        ? [{ accountId: accounts.get(WELL_KNOWN_CODES.tipsPayable)!, debit: zero, credit: tip.toString() as RialText }]
        : []),
      // The excess of an overpayment: money the business now owes the
      // customer, on the store-credit liability (2410) — a real obligation,
      // reconstructed per customer from the order.customer_credit_issued
      // domain event, never a mutable column.
      ...(customerCredit > 0n
        ? [{ accountId: accounts.get(WELL_KNOWN_CODES.storeCreditPayable)!, debit: zero, credit: customerCredit.toString() as RialText }]
        : []),
    ],
  });
}

/**
 * Posts the exact mirror of an already-posted entry — every line's debit and
 * credit swapped — and marks the original reversed.
 *
 * Reading the original's own lines rather than rebuilding them from the source
 * document is the point: an order payment's lines depend on its channel, its
 * tip, its platform commission and its settlement method, and a reversal built
 * from today's settings would silently diverge from what was actually posted.
 * Copying the lines cannot.
 *
 * The reversal carries its *own* source identity (an amendment, a correction)
 * so it never collides with the original under the
 * `(business_id, source_type, source_id, posting_kind)` uniqueness index, and
 * so re-posting the corrected document can reuse the ordinary posting kinds.
 */
export async function postExactMirrorEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string | null;
    /** the entry being undone */
    originalEntryId: string;
    /** identity of the reversal itself */
    sourceType: string;
    sourceId: string;
    postingKind: string;
    memo: string;
    createdBy: string | null;
    /** ISO date; defaults to today. Amendments pass the original's own date. */
    entryDate?: string | null;
    inventoryEventId?: string | null;
    /** Idempotency identity for the immutable mirror journal, when the source requires one. */
    idempotencyKey?: string | null;
  },
): Promise<string | null> {
  const { rows: lines } = await client.query<{
    account_id: string;
    debit: string;
    credit: string;
    cost_center_id: string | null;
    profit_center_id: string | null;
    department_id: string | null;
    detail_dimension_id: string | null;
    party_id: string | null;
  }>(
    `SELECT account_id, debit::text, credit::text,
            cost_center_id, profit_center_id, department_id, detail_dimension_id, party_id
       FROM journal_lines WHERE entry_id=$1 ORDER BY id`,
    [params.originalEntryId],
  );
  // A reversal mirrors exactly what the original recorded — including its
  // dimension attribution (issue #868). It must succeed even if a value has
  // since been archived or a kind switched off, so we set dimensionMirror=true
  // and let the database structural guards handle tenancy/kind.
  const entryId = await postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    entryDate: params.entryDate ?? null,
    memo: params.memo,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    createdBy: params.createdBy,
    postingKind: params.postingKind,
    inventoryEventId: params.inventoryEventId ?? null,
    journalIdempotencyKey: params.idempotencyKey ?? null,
    dimensionMirror: true,
    lines: lines.map((line) => ({
      accountId: line.account_id,
      debit: line.credit as RialText,
      credit: line.debit as RialText,
      dimensions: {
        cost_center: line.cost_center_id ?? undefined,
        profit_center: line.profit_center_id ?? undefined,
        department: line.department_id ?? undefined,
        detail: line.detail_dimension_id ?? undefined,
      },
      partyId: line.party_id,
    })),
  });
  if (entryId) {
    await client.query("UPDATE journal_entries SET reverses_entry_id=$2 WHERE id=$1", [
      entryId,
      params.originalEntryId,
    ]);
  }
  await client.query(
    "UPDATE journal_entries SET reversed_at=now(), reversed_by=$2 WHERE id=$1 AND reversed_at IS NULL",
    [params.originalEntryId, params.createdBy],
  );
  return entryId;
}

export async function postExactOperationalInventoryEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    sourceType: string;
    sourceId: string;
    postingKind: string;
    memo: string;
    createdBy: string | null;
    inventoryEventId: string;
    debitCode: string;
    creditCode: string;
    amount: RialText;
    /**
     * Issue #868 — attribution for the **credit** leg (the cost being
     * reversed: inventory on a supplier return, COGS on a sales return).
     * Only callers with a real source attribution (a return mirroring its
     * original) pass this; plain stock movements post unattributed.
     */
    dimensions?: LineDimensions | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [params.debitCode, params.creditCode]);
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: params.memo,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    createdBy: params.createdBy,
    postingKind: params.postingKind,
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(params.debitCode)!, debit: params.amount, credit: zero },
      {
        accountId: accounts.get(params.creditCode)!,
        debit: zero,
        credit: params.amount,
        dimensions: params.dimensions ?? null,
      },
    ],
  });
}

/**
 * A supplier return: Debit the settlement side / Credit inventory for the goods
 * — exactly `postExactOperationalInventoryEntry` when the purchase carried no
 * VAT — and, when it did (audit F11), Credit input VAT (1220) for the share of
 * the invoice's VAT this return reverses, in the same entry, with the
 * settlement side debited goods + VAT so A/P and 1220 both come back down.
 */
export async function postExactSupplierReturnEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    supplierReturnId: string;
    createdBy: string | null;
    inventoryEventId: string;
    debitCode: string;
    goods: RialText;
    vat: RialText;
    /** The purchase being returned from — its posted attribution is mirrored. */
    purchaseId?: string | null;
    /** Issue #868 — explicit attribution; wins over the mirrored original. */
    dimensions?: LineDimensions | null;
  },
): Promise<string | null> {
  const common = {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "supplier_return",
    sourceId: params.supplierReturnId,
    postingKind: "supplier_return",
    memo: systemJournalMemo("supplier_return"),
    createdBy: params.createdBy,
    inventoryEventId: params.inventoryEventId,
  };
  // A return reverses cost the purchase recorded: it mirrors the purchase's
  // own attribution (issue #868). Only when no original posting is readable
  // do the supplier's mapping rules speak — never a mix of both.
  let attribution: LineDimensions | null = params.dimensions ?? null;
  if (!attribution && params.purchaseId) {
    const mirrored = await postedEntryAttribution(client, params.businessId, [params.purchaseId], [
      "receipt",
      "periodic_purchase",
    ]);
    if (mirrored.found) attribution = mirrored.dimensions;
    else {
      attribution = await operationalAttribution(client, {
        businessId: params.businessId,
        entryDate: null,
        locationId: params.locationId,
        refs: { supplierRef: await purchaseSupplierRef(client, params.purchaseId) },
      });
    }
  }
  const vat = rialBigInt(params.vat);
  if (vat < 0n) throw new Error("invalid_supplier_return_vat");
  if (vat === 0n) {
    return postExactOperationalInventoryEntry(client, {
      ...common,
      debitCode: params.debitCode,
      creditCode: WELL_KNOWN_CODES.inventory,
      amount: params.goods,
      dimensions: attribution,
    });
  }
  const accounts = await accountIdsByCode(client, params.businessId, [
    params.debitCode,
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.vatReceivable,
  ]);
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    ...common,
    lines: [
      {
        accountId: accounts.get(params.debitCode)!,
        debit: (rialBigInt(params.goods) + vat).toString() as RialText,
        credit: zero,
      },
      // The cost leg mirrors the purchase's attribution; settlement and VAT
      // legs settle balances and stay unattributed.
      {
        accountId: accounts.get(WELL_KNOWN_CODES.inventory)!,
        debit: zero,
        credit: params.goods,
        dimensions: attribution,
      },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatReceivable)!, debit: zero, credit: params.vat },
    ],
  });
}

/**
 * The attribution a return of this order should carry (issue #868): the
 * original sale's posted attribution mirrored; when no original posting is
 * readable, the order's mapping rules; otherwise unattributed. Exported so
 * the sales-return document's COGS-reversal leg carries the same tuple as its
 * refund leg.
 */
export async function resolveOrderReturnAttribution(
  client: PoolClient,
  params: { businessId: string; locationId: string; orderId: string },
): Promise<LineDimensions | null> {
  // A closed-order amendment re-posts the sale under its own source id, so the
  // live attribution of the order lives on the amendment's entries once one
  // exists. Walk the chain: the order and every amendment of it.
  const { rows: amendments } = await client.query<{ id: string }>(
    `SELECT id FROM order_amendments WHERE order_id = $1`,
    [params.orderId],
  );
  const sourceIds = [params.orderId, ...amendments.map((row) => row.id)];
  const mirrored = await postedEntryAttribution(client, params.businessId, sourceIds, ["revenue", "cogs"]);
  if (mirrored.found) return mirrored.dimensions;
  return operationalAttribution(client, {
    businessId: params.businessId,
    entryDate: null,
    locationId: params.locationId,
    refs: await orderMappingRefs(client, params.orderId),
  });
}

export async function postExactCustomerRefundEntry(
  client: PoolClient,
  params: {
    businessId:string; locationId:string; customerReturnId:string; createdBy:string|null;
    inventoryEventId:string; paymentMethod:string; amount:RialText; tax:RialText;
    /** The sale being returned — its posted revenue attribution is mirrored (issue #868). */
    orderId?: string | null;
    /** Issue #868 — explicit attribution; wins over the mirrored original. */
    dimensions?: LineDimensions | null;
  },
): Promise<string|null> {
  // The return mirrors the sale's own attribution; only when the original
  // posting is unreadable do the order's mapping rules speak.
  const attribution: LineDimensions | null =
    params.dimensions ??
    (params.orderId
      ? await resolveOrderReturnAttribution(client, {
          businessId: params.businessId,
          locationId: params.locationId,
          orderId: params.orderId,
        })
      : null);
  const accounts=await accountIdsByCode(client,params.businessId,[
    WELL_KNOWN_CODES.cash,WELL_KNOWN_CODES.bankClearing,WELL_KNOWN_CODES.accountsReceivable,
    WELL_KNOWN_CODES.salesReturns,WELL_KNOWN_CODES.vatPayable,
  ]);
  const refundAccount=params.paymentMethod==="cash"?WELL_KNOWN_CODES.cash:
    params.paymentMethod==="credit"?WELL_KNOWN_CODES.accountsReceivable:WELL_KNOWN_CODES.bankClearing;
  const net=rialBigInt(params.amount)-rialBigInt(params.tax);
  if(net<0n)throw new Error("tax_exceeds_refund");
  const zero="0" as RialText;
  return postExactJournalEntry(client,{businessId:params.businessId,locationId:params.locationId,
    memo:systemJournalMemo("customer_refund"),sourceType:"customer_return",sourceId:params.customerReturnId,
    createdBy:params.createdBy,postingKind:"customer_refund",inventoryEventId:params.inventoryEventId,
    lines:[
      // The contra-revenue leg mirrors the sale's attribution (issue #868);
      // the VAT and settlement legs stay unattributed.
      {accountId:accounts.get(WELL_KNOWN_CODES.salesReturns)!,debit:net.toString() as RialText,credit:zero,dimensions:attribution},
      {accountId:accounts.get(WELL_KNOWN_CODES.vatPayable)!,debit:params.tax,credit:zero},
      {accountId:accounts.get(refundAccount)!,debit:zero,credit:params.amount},
    ]});
}

export interface PostJournalEntryInput {
  businessId: string;
  locationId: string | null;
  /** ISO date (YYYY-MM-DD); defaults to today */
  entryDate?: string | null;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  lines: JournalLine[];
  createdBy: string | null;
  postingKind?: string | null;
  inventoryEventId?: string | null;
  /** Optional operating dimension. The caller must establish tenant affinity. */
  projectId?: string | null;
  /**
   * Issue #868. A NEW posting with attribution is checked against the dimension
   * policy (enabled kind, active leaf value, branch, effective date) before it is
   * written. A reversal sets this to `true`: it mirrors lines that already exist,
   * so it must succeed even after the value it names has been archived. The
   * database still checks tenancy and kind on every write either way.
   */
  dimensionMirror?: boolean;
  /**
   * Issue #867 — the accountant's own reference number for the document (what
   * it was called in the system it came from). Advisory metadata on the entry,
   * never part of the fiscal-year sequence; `undefined` posts without one.
   */
  voucherReference?: string | null;
  /**
   * Multicurrency snapshot (issue #863 / #862). All six are absent for a
   * base-currency entry, which is what every caller before this one posts.
   * When `currencyCode` is present the database's `journal_entries_currency_snapshot`
   * CHECK requires the whole set, so they travel together or not at all.
   */
  currencyCode?: string | null;
  baseCurrencyCode?: string | null;
  exchangeRateId?: string | null;
  exchangeRate?: string | null;
  roundingVersion?: number | null;
  roundingDelta?: string | null;
  /**
   * The entry's own idempotency key (`journal_entries.idempotency_key`, unique
   * per business). A caller that already has a key for the document it is
   * posting passes it here so a concurrent retry collides in the database
   * instead of posting a second entry.
   */
  journalIdempotencyKey?: string | null;
  /** Compatibility alias for existing immutable-posting callers (issue #864). */
  idempotencyKey?: string | null;
}

/**
 * The shared line writer for both posting variants. Attribution is validated
 * here, once, for every path that reaches it, and written as four nullable
 * columns — so a line without attribution writes exactly what it always did.
 */
async function insertJournalLines(
  client: PoolClient,
  input: Pick<PostJournalEntryInput, "businessId" | "locationId" | "entryDate" | "dimensionMirror">,
  entryId: string,
  lines: ReadonlyArray<{
    accountId: string;
    debit: RialText | number;
    credit: RialText | number;
    dimensions?: LineDimensions | null;
    foreignDebit?: RialText;
    foreignCredit?: RialText;
    partyId?: string | null;
  }>,
): Promise<void> {
  if (!input.dimensionMirror && lines.some((line) => hasDimensions(line.dimensions))) {
    await assertDimensionsPostable(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      entryDate: input.entryDate ?? null,
      lines,
    });
  }
  for (const line of lines) {
    const dims = dimensionColumnValues(line.dimensions);
    await client.query(
      `INSERT INTO journal_lines
         (entry_id, account_id, debit, credit, cost_center_id, profit_center_id, department_id, detail_dimension_id,
          foreign_debit, foreign_credit, party_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entryId,
        line.accountId,
        line.debit,
        line.credit,
        dims.cost_center_id,
        dims.profit_center_id,
        dims.department_id,
        dims.detail_dimension_id,
        line.foreignDebit ?? 0,
        line.foreignCredit ?? 0,
        line.partyId ?? null,
      ],
    );
  }
}

/**
 * Inserts a journal_entries row + its journal_lines, after validating the
 * lines balance. Lines with debit=credit=0 are dropped first; if nothing is
 * left, no entry is created (e.g. a zero-cost waste/COGS event) and null is
 * returned.
 */
export async function postJournalEntry(client: PoolClient, input: PostJournalEntryInput): Promise<string | null> {
  const lines = input.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  if (lines.length === 0) return null;

  const errors = validateJournalLines(lines);
  if (errors.length > 0) {
    throw new Error(`unbalanced_journal_entry: ${errors.join("; ")}`);
  }
  if (!checkBalance(lines).balanced) {
    throw new Error("unbalanced_journal_entry");
  }

  const { rows } = await client.query<{ id: string; entry_date: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, created_by, posting_kind, inventory_event_id, project_id, idempotency_key)
     VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, entry_date::text AS entry_date`,
    [input.businessId, input.locationId, input.entryDate ?? null, input.memo, input.sourceType, input.sourceId, input.createdBy, input.postingKind ?? null, input.inventoryEventId ?? null, input.projectId ?? null, input.journalIdempotencyKey ?? input.idempotencyKey ?? null],
  );
  const entryId = rows[0].id;
  await insertJournalLines(client, input, entryId, lines);
  // Issue #867 — see postExactJournalEntry: the number commits with the entry.
  // The voucher columns are outside the fiscal trigger's column set, so
  // numbering does not extend the construction grant.
  await assignVoucherNumber(client, {
    businessId: input.businessId,
    entryId,
    entryDate: rows[0].entry_date,
    sourceType: input.sourceType,
    voucherReference: input.voucherReference ?? null,
  });
  // A soft-close construction token is single-use at the entry boundary, not
  // a continuing authorization to append lines later in this transaction.
  await client.query("SELECT set_config('app.fiscal_constructing_entry_id', '', true)");
  return entryId;
}

/** Order paid → Debit Cash/Bank-Clearing/Accounts-Receivable / Credit Sales Revenue + Tax Payable. */
export async function postOrderPaymentEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    orderId: string;
    createdBy: string | null;
    method: string;
    amount: Rial;
    tax: Rial;
    inventoryEventId?: string | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
    WELL_KNOWN_CODES.accountsReceivable,
    WELL_KNOWN_CODES.chequesOnHand,
    WELL_KNOWN_CODES.salesRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);
  const lines = buildOrderPaymentLines(
    {
      cash: accounts.get(WELL_KNOWN_CODES.cash)!,
      bankClearing: accounts.get(WELL_KNOWN_CODES.bankClearing)!,
      accountsReceivable: accounts.get(WELL_KNOWN_CODES.accountsReceivable)!,
      chequesOnHand: accounts.get(WELL_KNOWN_CODES.chequesOnHand)!,
      salesRevenue: accounts.get(WELL_KNOWN_CODES.salesRevenue)!,
      vatPayable: accounts.get(WELL_KNOWN_CODES.vatPayable)!,
    },
    { method: params.method, amount: params.amount, tax: params.tax },
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "فروش سفارش",
    sourceType: "order",
    sourceId: params.orderId,
    lines,
    createdBy: params.createdBy,
    postingKind: "revenue",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Stock deducted on sale → Debit COGS / Credit Inventory Asset. */
export async function postCogsEntry(
  client: PoolClient,
  params: { businessId: string; locationId: string; orderId: string; createdBy: string | null; totalCost: Rial; inventoryEventId?: string | null },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.cogs, WELL_KNOWN_CODES.inventory]);
  const lines = buildCogsLines(
    { cogs: accounts.get(WELL_KNOWN_CODES.cogs)!, inventory: accounts.get(WELL_KNOWN_CODES.inventory)! },
    params.totalCost,
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: systemJournalMemo("order_cogs"),
    sourceType: "order",
    sourceId: params.orderId,
    lines,
    createdBy: params.createdBy,
    postingKind: "cogs",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Waste logged → Debit Waste Expense / Credit Inventory Asset. */
export async function postWasteEntry(
  client: PoolClient,
  params: { businessId: string; locationId: string; sourceId: string; createdBy: string | null; totalCost: Rial; inventoryEventId?: string },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.wasteExpense,
    WELL_KNOWN_CODES.inventory,
  ]);
  const lines = buildWasteLines(
    { wasteExpense: accounts.get(WELL_KNOWN_CODES.wasteExpense)!, inventory: accounts.get(WELL_KNOWN_CODES.inventory)! },
    params.totalCost,
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "ضایعات",
    sourceType: "waste",
    sourceId: params.sourceId,
    lines,
    createdBy: params.createdBy,
    postingKind: "waste",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Purchase received → Debit Inventory Asset / Credit Accounts Payable (or Cash/Bank). */
export async function postPurchaseEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    createdBy: string | null;
    total: Rial;
    settlementMethod: SettlementMethod;
    inventoryEventId?: string | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.accountsPayable,
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
  ]);
  const lines = buildPurchaseLines(
    {
      inventory: accounts.get(WELL_KNOWN_CODES.inventory)!,
      accountsPayable: accounts.get(WELL_KNOWN_CODES.accountsPayable)!,
      cash: accounts.get(WELL_KNOWN_CODES.cash)!,
      bankClearing: accounts.get(WELL_KNOWN_CODES.bankClearing)!,
    },
    { total: params.total, settlementMethod: params.settlementMethod },
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: systemJournalMemo("purchase_receipt"),
    sourceType: "purchase",
    sourceId: params.purchaseId,
    lines,
    createdBy: params.createdBy,
    postingKind: "receipt",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Physical count variance: shortage is expense; surplus is count gain. */
export async function postStockCountEntry(client: PoolClient, params: {
  businessId: string; locationId: string; stockCountId: string; inventoryEventId: string;
  createdBy: string | null; shortageValue: Rial; surplusValue: Rial;
}): Promise<string | null> {
  const codes = [WELL_KNOWN_CODES.inventory, WELL_KNOWN_CODES.inventoryCountExpense, WELL_KNOWN_CODES.inventoryCountGain];
  const accounts = await accountIdsByCode(client, params.businessId, codes);
  const inventory = accounts.get(WELL_KNOWN_CODES.inventory)!;
  const lines = [
    { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountExpense)!, debit: params.shortageValue, credit: 0 },
    { accountId: inventory, debit: 0, credit: params.shortageValue },
    { accountId: inventory, debit: params.surplusValue, credit: 0 },
    { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountGain)!, debit: 0, credit: params.surplusValue },
  ];
  return postJournalEntry(client, { businessId: params.businessId, locationId: params.locationId,
    memo: "مغایرت شمارش موجودی", sourceType: "stock_count", sourceId: params.stockCountId,
    postingKind: "variance", inventoryEventId: params.inventoryEventId, lines, createdBy: params.createdBy });
}
