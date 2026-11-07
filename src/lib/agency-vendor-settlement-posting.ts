/**
 * Issue #1128 §D — the vendor payable's settlement, posted by the engine.
 *
 * The rule that makes account **2140** reachable from the debit side. 0280 gave the
 * agency's reimbursable-cost register a third settlement, `payable`, which credits
 * «حساب‌های پرداختنی رسانه، چاپ و تولید» and called it "the seam §D's vendor chain will
 * use". Until now the seam was one-way: 2140 was credited in exactly one place in the
 * whole tree and debited in none, so an agency recording its media buys as payable was
 * accumulating a liability nothing in the product could clear. §D names the missing step
 * — "payable → **settlement**" — and requires it go through the existing posting engine
 * rather than an ad hoc journal entry, which is why this is a rule and not an INSERT.
 *
 *   settle   Debit  `2140`  Credit `1100` / `1120`  by how the vendor was paid
 *   reverse  Debit  `1100` / `1120`  Credit `2140`  — the same two accounts, swapped
 *
 * ## Why the reversal is a rule of its own and not a negative amount
 *
 * A payment of −5,000,000 would balance and would clear the payable, and it would be
 * wrong in the two places that matter: the entry's own audit trail would say a payment
 * happened on a day it did not, and every report that sums debits or credits by account
 * would net the two rows into a figure neither of them states. `ap_payment_reversal` is
 * the platform's existing precedent for the same distinction, and it keeps the two apart
 * by source type as well as by lines — so this does too, and `ledger-source-labels.ts`
 * gives each its own Persian label because a list of entries has to be able to say which
 * of two opposite acts on one account a row is.
 *
 * ## What is deliberately absent
 *
 * No VAT and no expense line. Paying a vendor for a media buy the agency already
 * recorded is not a new cost — the cost landed in 1270 or 5197 when 0280 posted it, and
 * debiting either here would count the same rial twice. This entry moves money out of a
 * liability and out of the bank, and nothing else.
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
 * The lines are the same pair in both directions, so one builder serves both rules and
 * a change to the accounts cannot reach one of them and not the other.
 */
async function settlementLines(
  client: PoolClient,
  businessId: string,
  payload: VendorSettlementPayload,
  reversed: boolean,
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
    lines: reversed
      ? [
          { accountId: cashOrBank, debit: payload.amount, credit: ZERO },
          { accountId: payable, debit: ZERO, credit: payload.amount },
        ]
      : [
          { accountId: payable, debit: payload.amount, credit: ZERO },
          { accountId: cashOrBank, debit: ZERO, credit: payload.amount },
        ],
    // The memo names the account, because «پرداخت» on a list of entries does not say
    // whether this cleared a vendor payable or bought something — and 2140 is the one
    // account in the agency's chart whose whole purpose is the difference.
    memo: reversed
      ? `برگشت تسویهٔ پرداختنی رسانه و تولید — ${WELL_KNOWN_CODES.agencyMediaVendorPayable}`
      : `تسویهٔ پرداختنی رسانه و تولید — ${WELL_KNOWN_CODES.agencyMediaVendorPayable}`,
    postingKind: reversed ? "agency_vendor_settlement_reversal" : "agency_vendor_settlement",
    entryDate: payload.paidOn,
    projectId: payload.projectId ?? null,
  };
}

registerPostingRule(
  "agency.vendor_settlement",
  async (event, client): Promise<PostingResult | null> =>
    settlementLines(client, event.businessId, event.payload as unknown as VendorSettlementPayload, false),
);

registerPostingRule(
  "agency.vendor_settlement_reversal",
  async (event, client): Promise<PostingResult | null> =>
    settlementLines(client, event.businessId, event.payload as unknown as VendorSettlementPayload, true),
);
