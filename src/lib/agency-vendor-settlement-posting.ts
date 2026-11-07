/**
 * #1128 §D — vendor payments debit 2140 and credit the chosen cash/bank
 * account through the domain-event posting engine. This clears a liability;
 * it does not recognise a second expense, revenue or VAT.
 *
 * Reversals deliberately have no mapping-based rule here. The service records
 * a reversal event and uses the shared exact-mirror path, preserving the actual
 * original accounts, amounts, dimensions and party attribution even if mappings
 * have changed since payment.
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import {
  vendorSettlementAccounts,
  type VendorSettlementMethod,
} from "./agency-reimbursable-cost";

const ZERO = "0" as RialText;

/** What both rules read off the event. */
interface VendorSettlementPayload {
  /** Integer rial, already validated positive by 0287's CHECK. */
  amount: RialText;
  /** The credit side: the cash box or the bank. */
  method: VendorSettlementMethod;
  /** The day the money moved (YYYY-MM-DD), which is the day the entry is dated. */
  paidOn: string;
  /**
   * The project, when every cost this payment cleared agrees on one.
   *
   * Tagged only when they agree and left untagged when they do not, for the reason the
   * recharge gives: a payment spanning two projects belongs to neither, and guessing one
   * would put the whole settlement in a single project's books and quietly take it out of
   * the other's.
   */
  projectId?: string | null;
}

/**
 * Forward payments resolve the chosen cash/bank account. Reversals instead use
 * postExactMirrorEntry in the service, preserving the actual posted accounts.
 */
async function settlementLines(
  client: PoolClient,
  businessId: string,
  payload: VendorSettlementPayload,
): Promise<PostingResult | null> {
  // A non-positive amount cannot reach here — 0287 CHECKs it — but a posting rule that
  // would happily write a zero or a negative entry is a rule that trusts its caller.
  if (!payload.amount || Number(payload.amount) <= 0) return null;

  const accounts = vendorSettlementAccounts(payload.method);
  // A chart that no longer carries one of the two accounts throws
  // `MissingLedgerAccountError` out of here and the engine does not catch a rule's error,
  // so the caller's transaction rolls back and the member is told. That is the right
  // outcome: a settlement that cannot post would leave money recorded as paid while the
  // books still show it owed.
  const ids = await accountIdsByCode(client, businessId, [
    accounts.debitCode,
    accounts.creditCode,
  ]);
  const payable = ids.get(accounts.debitCode)!;
  const cashOrBank = ids.get(accounts.creditCode)!;

  return {
    lines: [
      { accountId: payable, debit: payload.amount, credit: ZERO },
      { accountId: cashOrBank, debit: ZERO, credit: payload.amount },
    ],
    // The memo names the account, because «پرداخت» on a list of entries does not say
    // whether this cleared a vendor payable or bought something — and 2140 is the one
    // account in the agency's chart whose whole purpose is the difference.
    memo: `تسویهٔ پرداختنی رسانه و تولید — ${WELL_KNOWN_CODES.agencyMediaVendorPayable}`,
    postingKind: "agency_vendor_settlement",
    entryDate: payload.paidOn,
    projectId: payload.projectId ?? null,
  };
}

registerPostingRule(
  "agency.vendor_settlement",
  async (event, client): Promise<PostingResult | null> =>
    settlementLines(client, event.businessId, event.payload as unknown as VendorSettlementPayload),
);
