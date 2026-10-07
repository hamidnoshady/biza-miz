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

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (business_id,location_id,entry_date,memo,source_type,source_id,created_by,posting_kind,inventory_event_id,project_id)
     VALUES($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
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
    ],
  );
  for (const line of lines) {
    await client.query(
      "INSERT INTO journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,$3,$4)",
      [rows[0].id, line.accountId, line.debit, line.credit],
    );
  }
  return rows[0].id;
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
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.accountsPayable,
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
  ]);
  const settlementLines = await purchaseSettlementLines(client, params.businessId, params.settlementMethod, params.total, params.vat);
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "Purchase receipt",
    sourceType: "purchase",
    sourceId: params.purchaseId,
    createdBy: params.createdBy,
    postingKind: "receipt",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: params.total, credit: "0" as RialText },
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
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.accountsPayable,
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
  ]);
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
      { accountId: accounts.get(WELL_KNOWN_CODES.periodicPurchases)!, debit: params.total, credit: "0" as RialText },
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
    memo: "Negative stock cost settlement",
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
    entryDate: params.entryDate ?? null,
    memo: "Cost of goods sold",
    sourceType: params.sourceType ?? "order",
    sourceId: params.sourceId ?? params.orderId,
    createdBy: params.createdBy,
    postingKind: "cogs",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: params.totalCost, credit: zero },
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
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    entryDate: params.entryDate ?? null,
    memo: "Order payment",
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
        credit: revenue.toString() as RialText,
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
  },
): Promise<string | null> {
  const { rows: lines } = await client.query<{ account_id: string; debit: string; credit: string }>(
    "SELECT account_id, debit::text, credit::text FROM journal_lines WHERE entry_id=$1 ORDER BY id",
    [params.originalEntryId],
  );
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
    lines: lines.map((line) => ({
      accountId: line.account_id,
      debit: line.credit as RialText,
      credit: line.debit as RialText,
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
      { accountId: accounts.get(params.creditCode)!, debit: zero, credit: params.amount },
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
  },
): Promise<string | null> {
  const common = {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "supplier_return",
    sourceId: params.supplierReturnId,
    postingKind: "supplier_return",
    memo: "Supplier return",
    createdBy: params.createdBy,
    inventoryEventId: params.inventoryEventId,
  };
  const vat = rialBigInt(params.vat);
  if (vat < 0n) throw new Error("invalid_supplier_return_vat");
  if (vat === 0n) {
    return postExactOperationalInventoryEntry(client, {
      ...common,
      debitCode: params.debitCode,
      creditCode: WELL_KNOWN_CODES.inventory,
      amount: params.goods,
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
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: zero, credit: params.goods },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatReceivable)!, debit: zero, credit: params.vat },
    ],
  });
}

export async function postExactCustomerRefundEntry(
  client: PoolClient,
  params: {
    businessId:string; locationId:string; customerReturnId:string; createdBy:string|null;
    inventoryEventId:string; paymentMethod:string; amount:RialText; tax:RialText;
  },
): Promise<string|null> {
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
    memo:"Customer refund",sourceType:"customer_return",sourceId:params.customerReturnId,
    createdBy:params.createdBy,postingKind:"customer_refund",inventoryEventId:params.inventoryEventId,
    lines:[
      {accountId:accounts.get(WELL_KNOWN_CODES.salesReturns)!,debit:net.toString() as RialText,credit:zero},
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

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, created_by, posting_kind, inventory_event_id, project_id)
     VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [input.businessId, input.locationId, input.entryDate ?? null, input.memo, input.sourceType, input.sourceId, input.createdBy, input.postingKind ?? null, input.inventoryEventId ?? null, input.projectId ?? null],
  );
  const entryId = rows[0].id;
  for (const l of lines) {
    await client.query("INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)", [
      entryId,
      l.accountId,
      l.debit,
      l.credit,
    ]);
  }
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
    memo: "بهای تمام‌شده کالای فروش‌رفته",
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
    memo: "دریافت کالای خرید",
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
