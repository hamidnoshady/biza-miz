/**
 * Phase 27 Wave 8 — posting rules for the `items`-model stock operations.
 *
 * The industry's inventory account differs by trade (gold/watch/accessory/
 * cosmetics each have their own finished-goods account), so the rules resolve
 * the business's industry live and pick the matching well-known code — the
 * same "resolve against the current record" instinct accountIdsByCode uses.
 *
 *   - purchase received:  Debit {industry}Inventory / Credit accounts payable
 *   - supplier return:    Debit settlement account / Credit {industry}Inventory
 *   - transfer ship:      Debit inventory-in-transit / Credit {industry}Inventory
 *   - transfer receive:   Debit {industry}Inventory / Credit inventory-in-transit
 *   - stock count:        Debit count shortage / Credit {industry}Inventory, and
 *                         Debit {industry}Inventory / Credit count surplus gain
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import type { Industry } from "./industries";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";

const ZERO = "0" as RialText;

const INVENTORY_CODE_BY_INDUSTRY: Record<Industry, string> = {
  service_saas: WELL_KNOWN_CODES.inventory,
  food_service: WELL_KNOWN_CODES.inventory,
  // Issue #799 — kept in step with accounting-posting-rules.ts, whose copy of
  // this mapping the settings panel reads (the pairing is asserted in
  // accounting-posting-rules.test.ts).
  architecture_construction: WELL_KNOWN_CODES.inventory,
  jewelry: WELL_KNOWN_CODES.goldInventory,
  watch: WELL_KNOWN_CODES.watchInventory,
  accessories: WELL_KNOWN_CODES.accessoryInventory,
  cosmetics: WELL_KNOWN_CODES.cosmeticInventory,
  wholesale: WELL_KNOWN_CODES.wholesaleInventory,
  tools_fittings: WELL_KNOWN_CODES.toolsInventory,
  haberdashery: WELL_KNOWN_CODES.haberdasheryInventory,
};

/**
 * The business's industry inventory account code. Exported because the retail
 * warehouse document service reports the same code in its create summary —
 * the screen's «بدهکار/بستانکار» line must name the account the rule actually
 * posted to, not a second guess at the mapping.
 */
export async function inventoryCodeForBusiness(client: PoolClient, businessId: string): Promise<string> {
  const { rows } = await client.query<{ industry: Industry }>(
    `SELECT industry FROM businesses WHERE id = $1`,
    [businessId],
  );
  return INVENTORY_CODE_BY_INDUSTRY[rows[0]?.industry ?? "food_service"];
}

interface AmountPayload {
  amount: RialText;
}

registerPostingRule("retail.purchase_received", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [inventoryCode, WELL_KNOWN_CODES.accountsPayable]);

  return {
    lines: [
      { accountId: accounts.get(inventoryCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.accountsPayable)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "خرید کالای خرده‌فروشی",
    postingKind: "retail_purchase",
  };
});

const RETURN_DEBIT_CODE: Record<string, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  supplier_receivable: WELL_KNOWN_CODES.supplierReceivable,
  accounts_payable: WELL_KNOWN_CODES.accountsPayable,
};

interface ReturnPayload extends AmountPayload {
  settlementMethod: string;
}

registerPostingRule("retail.supplier_return", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as ReturnPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const debitCode = RETURN_DEBIT_CODE[payload.settlementMethod] ?? WELL_KNOWN_CODES.accountsPayable;
  const accounts = await accountIdsByCode(client, event.businessId, [debitCode, inventoryCode]);

  return {
    lines: [
      { accountId: accounts.get(debitCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(inventoryCode)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "برگشت به تأمین‌کننده",
    postingKind: "retail_supplier_return",
  };
});

registerPostingRule("retail.transfer_ship", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.retailInventoryInTransit,
    inventoryCode,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.retailInventoryInTransit)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(inventoryCode)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "ارسال انتقال کالا",
    postingKind: "retail_transfer_ship",
  };
});

registerPostingRule("retail.transfer_receive", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    inventoryCode,
    WELL_KNOWN_CODES.retailInventoryInTransit,
  ]);

  return {
    lines: [
      { accountId: accounts.get(inventoryCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.retailInventoryInTransit)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "دریافت انتقال کالا",
    postingKind: "retail_transfer_receive",
  };
});

interface StockCountPayload {
  /** Total value of the lines that came up short (positive Rial, 0 if none). */
  shortage: RialText;
  /** Total value of the lines that came up over (positive Rial, 0 if none). */
  surplus: RialText;
}

/**
 * A physical count's variance, netted across the whole count into one entry —
 * the same shape `postExactStockCountEntry` gives F&B, so the two models'
 * variance entries read identically in the ledger.
 *
 * Shortage and surplus are kept as separate totals rather than one signed
 * number on purpose: they hit different accounts, and a count that is 100,000
 * short on one item and 100,000 over on another has *not* had a quiet night —
 * netting them to zero would hide both.
 *
 * The shortage account is `retailCountShortageExpense` (5190) and not F&B's
 * 5160: cosmetics already spends 5160 on expiry and testers, an identified
 * loss that unexplained shrinkage must not be folded into. The surplus side
 * shares 4910 with F&B, which means the same thing in every trade.
 */
registerPostingRule("retail.stock_count_adjustment", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as StockCountPayload;
  const shortage = rialBigInt(payload.shortage);
  const surplus = rialBigInt(payload.surplus);
  // A count that matches the system exactly is still a real event worth
  // recording; it just has nothing to post.
  if (shortage === 0n && surplus === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    inventoryCode,
    WELL_KNOWN_CODES.retailCountShortageExpense,
    WELL_KNOWN_CODES.inventoryCountGain,
  ]);
  const inventory = accounts.get(inventoryCode)!;

  const lines = [];
  if (shortage > 0n) {
    lines.push({
      accountId: accounts.get(WELL_KNOWN_CODES.retailCountShortageExpense)!,
      debit: payload.shortage,
      credit: ZERO,
    });
    lines.push({ accountId: inventory, debit: ZERO, credit: payload.shortage });
  }
  if (surplus > 0n) {
    lines.push({ accountId: inventory, debit: payload.surplus, credit: ZERO });
    lines.push({
      accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountGain)!,
      debit: ZERO,
      credit: payload.surplus,
    });
  }

  return { lines, memo: "مغایرت انبارگردانی", postingKind: "retail_stock_count" };
});

/**
 * Undoing a posted count: the same lines with the two sides swapped, so the
 * shortage expense and surplus gain are given back at the value originally
 * recorded. A separate event type rather than a negative amount, so the
 * `(source_type, source_id, posting_kind)` identity of the reversal is its own
 * and cannot collide with the count it reverses.
 */
registerPostingRule("retail.stock_count_reversal", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as StockCountPayload;
  const shortage = rialBigInt(payload.shortage);
  const surplus = rialBigInt(payload.surplus);
  if (shortage === 0n && surplus === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    inventoryCode,
    WELL_KNOWN_CODES.retailCountShortageExpense,
    WELL_KNOWN_CODES.inventoryCountGain,
  ]);
  const inventory = accounts.get(inventoryCode)!;

  const lines = [];
  if (shortage > 0n) {
    lines.push({ accountId: inventory, debit: payload.shortage, credit: ZERO });
    lines.push({
      accountId: accounts.get(WELL_KNOWN_CODES.retailCountShortageExpense)!,
      debit: ZERO,
      credit: payload.shortage,
    });
  }
  if (surplus > 0n) {
    lines.push({
      accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountGain)!,
      debit: payload.surplus,
      credit: ZERO,
    });
    lines.push({ accountId: inventory, debit: ZERO, credit: payload.surplus });
  }

  return { lines, memo: "برگشت مغایرت انبارگردانی", postingKind: "retail_stock_count_reversal" };
});

/**
 * Phase 42b — warehouse documents (رسید/حواله انبار) on the retail stock
 * model. The same "other in / other out" F&B's Phase 42 posts, resolved
 * against the business's own industry inventory account the way every
 * retail.* stock rule above does:
 *
 *   - warehouse receipt: Debit {industry}Inventory / Credit other income (4900)
 *     — stock that entered without a purchase order is other income.
 *   - warehouse issue:   Debit other expense (5900) / Credit {industry}Inventory
 *     — stock that left without a sale or a supplier return is an other
 *     expense, valued at the relieved lot's own cost.
 */
interface WarehouseDocumentPayload extends AmountPayload {
  documentId: string;
}

registerPostingRule("retail.warehouse_receipt", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as WarehouseDocumentPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    inventoryCode,
    WELL_KNOWN_CODES.otherIncome,
  ]);

  return {
    lines: [
      { accountId: accounts.get(inventoryCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.otherIncome)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "رسید انبار",
    postingKind: "retail_warehouse_receipt",
  };
});

registerPostingRule("retail.warehouse_issue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as WarehouseDocumentPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.otherExpense,
    inventoryCode,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.otherExpense)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(inventoryCode)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "حواله انبار",
    postingKind: "retail_warehouse_issue",
  };
});
