/**
 * GH #1567 Phase 6D — posting rules for fashion consignment (امانی).
 *
 * - `fashion_consignment.sale`: Dr payment accounts by tender (total);
 *   Cr 2200 VAT; Cr 2110 owner share; Cr 4700 commission. No COGS, no
 *   inventory: the shop never owned the goods.
 * - `fashion_consignment.return_reclass`: next to the normal customer-refund
 *   entry (Dr 4400 / Dr VAT / Cr cash), move the returned line's contra-revenue
 *   to where the sale actually credited it: Dr 2110 share, Dr 4700 commission,
 *   Cr 4400.
 * - `fashion_consignment.settlement`: Dr 2110 / Cr 1100 cash or 1110 bank.
 *
 * Missing accounts throw (`consignment_account_missing:<code>`) — a sale must
 * never move stock without its entry.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import { groupTendersByCode, type RetailTender } from "./retail-tenders";

const ZERO = "0" as RialText;

export const FASHION_CONSIGNMENT_EVENTS = {
  sale: "fashion_consignment.sale",
  returnReclass: "fashion_consignment.return_reclass",
  settlement: "fashion_consignment.settlement",
} as const;

const PAYMENT_ACCOUNT_CODE: Record<SettlementMethod, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
};

async function ids(client: Parameters<Parameters<typeof registerPostingRule>[1]>[1], businessId: string, codes: string[]) {
  const accounts = await accountIdsByCode(client, businessId, codes);
  for (const code of codes) {
    if (!accounts.get(code)) throw new Error(`consignment_account_missing:${code}`);
  }
  return (code: string) => accounts.get(code)!;
}

registerPostingRule(FASHION_CONSIGNMENT_EVENTS.sale, async (event, client): Promise<PostingResult | null> => {
  const p = event.payload as unknown as { tenders: RetailTender[]; vat: RialText; ownerShare: RialText; commission: RialText };
  const debits = groupTendersByCode(p.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);
  const id = await ids(client, event.businessId, [
    ...debits.map((d) => d.code),
    WELL_KNOWN_CODES.vatPayable,
    WELL_KNOWN_CODES.consignmentPayable,
    WELL_KNOWN_CODES.consignmentCommissionRevenue,
  ]);
  const lines = [
    ...debits.filter((d) => rialBigInt(d.amount) > 0n).map((d) => ({ accountId: id(d.code), debit: d.amount, credit: ZERO })),
    ...(rialBigInt(p.vat) > 0n ? [{ accountId: id(WELL_KNOWN_CODES.vatPayable), debit: ZERO, credit: p.vat }] : []),
    ...(rialBigInt(p.ownerShare) > 0n ? [{ accountId: id(WELL_KNOWN_CODES.consignmentPayable), debit: ZERO, credit: p.ownerShare }] : []),
    ...(rialBigInt(p.commission) > 0n ? [{ accountId: id(WELL_KNOWN_CODES.consignmentCommissionRevenue), debit: ZERO, credit: p.commission }] : []),
  ];
  if (lines.length === 0) return null;
  return { lines, memo: "فروش کالای امانی", postingKind: "fashion_consignment_sale" };
});

registerPostingRule(FASHION_CONSIGNMENT_EVENTS.returnReclass, async (event, client): Promise<PostingResult | null> => {
  const p = event.payload as unknown as { ownerShare: RialText; commission: RialText };
  const share = rialBigInt(p.ownerShare);
  const commission = rialBigInt(p.commission);
  if (share + commission === 0n) return null;
  const id = await ids(client, event.businessId, [
    WELL_KNOWN_CODES.consignmentPayable,
    WELL_KNOWN_CODES.consignmentCommissionRevenue,
    WELL_KNOWN_CODES.salesReturns,
  ]);
  return {
    lines: [
      ...(share > 0n ? [{ accountId: id(WELL_KNOWN_CODES.consignmentPayable), debit: p.ownerShare, credit: ZERO }] : []),
      ...(commission > 0n ? [{ accountId: id(WELL_KNOWN_CODES.consignmentCommissionRevenue), debit: p.commission, credit: ZERO }] : []),
      { accountId: id(WELL_KNOWN_CODES.salesReturns), debit: ZERO, credit: (share + commission).toString() as RialText },
    ],
    memo: "برگشت فروش کالای امانی — انتقال به حساب امانت‌گذار و کارمزد",
    postingKind: "fashion_consignment_return_reclass",
  };
});

registerPostingRule(FASHION_CONSIGNMENT_EVENTS.settlement, async (event, client): Promise<PostingResult | null> => {
  const p = event.payload as unknown as { amount: RialText; method: "cash" | "bank" };
  if (rialBigInt(p.amount) <= 0n) return null;
  const paidFrom = p.method === "bank" ? WELL_KNOWN_CODES.bank : WELL_KNOWN_CODES.cash;
  const id = await ids(client, event.businessId, [WELL_KNOWN_CODES.consignmentPayable, paidFrom]);
  return {
    lines: [
      { accountId: id(WELL_KNOWN_CODES.consignmentPayable), debit: p.amount, credit: ZERO },
      { accountId: id(paidFrom), debit: ZERO, credit: p.amount },
    ],
    memo: "تسویه با امانت‌گذار",
    postingKind: "fashion_consignment_settlement",
  };
});
