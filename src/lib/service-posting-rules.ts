/**
 * Service sale posting rule, registered against the domain-event/posting engine.
 *
 * The service trades (`service_saas`, `architecture_construction`,
 * `advertising_agency`) invoice work rather than goods, so a service line is the
 * revenue half of an accessory sale and nothing else — there is no stock to
 * relieve and therefore no COGS rule. A contractor's direct project cost reaches
 * the books through purchases, expenses and payroll, not at the moment of
 * invoicing, and an agency's direct client cost the same way: into 5196–5199
 * (issue #1128 §D), never against the invoice that bills it.
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
  /**
   * The project this invoice bills, when it bills one (issue #1128 §D).
   *
   * Carried to the accounting document rather than read back later: an agency
   * bills a client project's milestone, and §D's project P&L is one read over
   * `journal_entries.project_id` — revenue on one side, the project's own
   * expenses on the other. Without the tag the invoice's revenue lands in the
   * ledger unattributed and the P&L would have to be assembled from the
   * invoice documents instead of from the books, which is exactly the
   * booked/posted confusion §D forbids.
   */
  projectId?: string | null;
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
    // Issue #1128 §D — the project this invoice bills, so the entry it posts is
    // attributable in the ledger rather than only in the register that asked
    // for it. Null for an invoice with no project, which is every invoice the
    // till writes: the dimension is carried, never invented.
    projectId: payload.projectId ?? null,
  };
});
