/**
 * Service sale posting rule, registered against the domain-event/posting engine.
 *
 * The service trades (`service_saas`, `architecture_construction`) invoice work
 * rather than goods, so a service line is the revenue half of an accessory sale
 * and nothing else — there is no stock to relieve and therefore no COGS rule.
 * A contractor's direct project cost reaches the books through purchases,
 * expenses and payroll, not at the moment of invoicing.
 *
 *   - `service.sale_revenue`: Debit Cash/Bank-Clearing/Accounts-Receivable by
 *     payment method for the total; Credit the line's revenue account for the
 *     net (post-discount) amount and `vatPayable` for VAT.
 *
 * The revenue account is chosen when the line is written (the payload carries
 * it, already validated against the trade's list in `service-invoice.ts`), so
 * a design fee and a site-execution fee on one invoice land in different
 * accounts of the same entry's sibling documents.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { SettlementMethod } from "./ledger";
import { groupTendersByCode, type RetailTender } from "./retail-tenders";

const PAYMENT_ACCOUNT_CODE: Record<SettlementMethod, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
};

const ZERO = "0" as RialText;

interface ServiceSaleRevenuePayload {
  description: string;
  quantity: string;
  revenueCode: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
}

registerPostingRule("service.sale_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as ServiceSaleRevenuePayload;
  const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);

  const accounts = await accountIdsByCode(client, event.businessId, [
    ...debits.map((d) => d.code),
    payload.revenueCode,
    WELL_KNOWN_CODES.vatPayable,
  ]);

  return {
    lines: [
      ...debits.map((d) => ({ accountId: accounts.get(d.code)!, debit: d.amount, credit: ZERO })),
      { accountId: accounts.get(payload.revenueCode)!, debit: ZERO, credit: payload.net },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: ZERO, credit: payload.vat },
    ],
    memo: "فروش خدمات",
    postingKind: "service_sale_revenue",
  };
});
