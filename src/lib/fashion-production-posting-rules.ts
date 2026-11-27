/**
 * GH #1567 Phase 6B — posting rules for fashion production orders.
 *
 * The same three-account shape as F&B production (production-posting-rules.ts:
 * work in progress 1310, absorbed conversion 5180, finished goods), but the
 * inventory side is the business's OWN trade account resolved live
 * (`inventoryCodeForBusiness`: 1374 for fashion), because these goods live in
 * the `items` stock model rather than in F&B's `inventory_items`.
 *
 *   materials issued    Dr 1310 WIP            / Cr {trade} inventory
 *   materials returned  Dr {trade} inventory   / Cr 1310 WIP
 *   conversion absorbed Dr 1310 WIP            / Cr 5180 absorbed conversion
 *   output received     Dr {trade} inventory   / Cr 1310 WIP
 *   WIP written off     Dr 5170 write-down     / Cr 1310 WIP (controlled cancellation)
 *
 * GH #1567 6.3 — subcontracted stages (journal source `item_production_subcontract`,
 * attributed to the supplier alias through ap-attribution.ts):
 *   accepted work       Dr 1310 WIP            / Cr 2100 Accounts Payable
 *   chargeback          Dr 2100 Accounts Payable / Cr 1310 WIP
 *
 * Unlike rules that return null when an account is missing, these throw: the
 * stock movement runs in the same transaction, so a missing account must roll
 * the whole action back rather than leave stock moved with no ledger entry.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import { inventoryCodeForBusiness } from "./retail-stock-posting-rules";

const ZERO = "0" as RialText;
const INVENTORY = "{inventory}";

interface Payload {
  amount: RialText;
}

export const FASHION_PRODUCTION_EVENTS = {
  materialsIssued: "item_production.materials_issued",
  materialsReturned: "item_production.materials_returned",
  conversionAbsorbed: "item_production.conversion_absorbed",
  outputReceived: "item_production.output_received",
  wipWrittenOff: "item_production.wip_written_off",
  subcontractAccrued: "item_production.subcontract_accrued",
  subcontractChargeback: "item_production.subcontract_chargeback",
} as const;

function rule(eventType: string, debit: string, credit: string, memo: string, postingKind: string): void {
  registerPostingRule(eventType, async (event, client): Promise<PostingResult | null> => {
    const { amount } = event.payload as unknown as Payload;
    if (rialBigInt(amount) === 0n) return null;
    const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
    const debitCode = debit === INVENTORY ? inventoryCode : debit;
    const creditCode = credit === INVENTORY ? inventoryCode : credit;
    const accounts = await accountIdsByCode(client, event.businessId, [debitCode, creditCode]);
    const debitId = accounts.get(debitCode);
    const creditId = accounts.get(creditCode);
    if (!debitId || !creditId) throw new Error(`production_account_missing:${!debitId ? debitCode : creditCode}`);
    return {
      lines: [
        { accountId: debitId, debit: amount, credit: ZERO },
        { accountId: creditId, debit: ZERO, credit: amount },
      ],
      memo,
      postingKind,
    };
  });
}

rule(FASHION_PRODUCTION_EVENTS.materialsIssued, WELL_KNOWN_CODES.workInProgress, INVENTORY,
  "مصرف مواد در سفارش تولید", "item_production_materials");
rule(FASHION_PRODUCTION_EVENTS.materialsReturned, INVENTORY, WELL_KNOWN_CODES.workInProgress,
  "برگشت مواد مصرف‌نشده از سفارش تولید", "item_production_materials_return");
rule(FASHION_PRODUCTION_EVENTS.conversionAbsorbed, WELL_KNOWN_CODES.workInProgress, WELL_KNOWN_CODES.appliedConversionCost,
  "جذب دستمزد/پیمانکار/سربار در سفارش تولید", "item_production_conversion");
rule(FASHION_PRODUCTION_EVENTS.outputReceived, INVENTORY, WELL_KNOWN_CODES.workInProgress,
  "ورود محصول تولیدشده به انبار", "item_production_output");
rule(FASHION_PRODUCTION_EVENTS.wipWrittenOff, WELL_KNOWN_CODES.inventoryWriteDownExpense, WELL_KNOWN_CODES.workInProgress,
  "زیان کالای در جریان ساخت سفارش لغوشده", "item_production_wip_write_off");
rule(FASHION_PRODUCTION_EVENTS.subcontractAccrued, WELL_KNOWN_CODES.workInProgress, WELL_KNOWN_CODES.accountsPayable,
  "اجرت پیمانکار برای کار پذیرفته‌شده در سفارش تولید", "item_production_subcontract_accrual");
rule(FASHION_PRODUCTION_EVENTS.subcontractChargeback, WELL_KNOWN_CODES.accountsPayable, WELL_KNOWN_CODES.workInProgress,
  "کسر خسارت از طلب پیمانکار سفارش تولید", "item_production_subcontract_chargeback");
