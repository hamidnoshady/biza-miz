/**
 * Issue #1128 §D — the reimbursable client cost, posted by the engine.
 *
 * The rule that makes account 1270 reachable. Wave 1 seeded it as an asset and
 * `account-classification.ts` deliberately left it unclassified, because it is an
 * *unbilled* pass-through and not an invoice the client owes yet; eight waves later
 * nothing could post to it, because the expense path refuses asset accounts and §D
 * forbids an ad hoc journal entry. This is the door.
 *
 *   net    Debit  `1270  هزینه‌های قابل بازدریافت از مشتری`
 *   gross  Debit  `5197  هزینهٔ رسانه`
 *   both   Credit `1100` / `1120` / `2140`  by how it was settled
 *
 * ## The entry date is the day it was spent, not the day it was recorded
 *
 * A member records a platform invoice days after the platform charged the card, and
 * the cost belongs to the day it was incurred — the same distinction
 * `campaignBusinessDay` exists to serve, except that here the member states the day
 * rather than the system inferring it from a tick. A locked fiscal period does not
 * stop a real spend being recognised: the engine's exact posting path routes it to
 * the human-approval queue exactly as it does for every auto-posted entry, which is
 * why `entry_id` staying NULL is a state rather than a failure.
 *
 * ## What is deliberately absent
 *
 * No VAT line and no revenue line. This is money the agency spent, not a sale, and
 * the recharge that turns it into money the client owes is a separate document with
 * its own entry — the next wave's work, and the reason this one has to exist first:
 * crediting 1270 before anything debited it would drive an asset to a credit
 * balance and report a *negative* claim on the client.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import {
  isPassThroughToClient,
  reimbursableCostAccounts,
  type AgencyCostSettlement,
  type AgencyPassThroughPresentation,
} from "./agency-reimbursable-cost";

const ZERO = "0" as RialText;

export interface ReimbursableCostPayload {
  /** Integer rial, already validated positive by 0280's CHECK. */
  amount: RialText;
  /** §D's gross-versus-net choice, recorded on the document. */
  presentation: AgencyPassThroughPresentation;
  /** The credit side: cash, bank clearing, or the media/print/production payable. */
  settledBy: AgencyCostSettlement;
  /** The day the money was spent (YYYY-MM-DD), which is the day the entry is dated. */
  spentOn: string;
  /**
   * The project this cost belongs to, when it belongs to one.
   *
   * Carried to the accounting document rather than read back later, for the reason
   * the service line's `projectId` is: §D's project P&L is one read over
   * `journal_entries.project_id`, with the project's revenue on one side and its
   * costs on the other. Without the tag the cost lands in the ledger unattributed
   * and the P&L would have to be assembled from the register instead of from the
   * books — which is the booked/posted confusion §D forbids.
   */
  projectId?: string | null;
}

registerPostingRule(
  "agency.reimbursable_cost",
  async (event, client): Promise<PostingResult | null> => {
    const payload = event.payload as unknown as ReimbursableCostPayload;
    // A non-positive amount cannot reach here — 0280 CHECKs it — but a posting rule
    // that would happily write a zero or a negative entry is a rule that trusts its
    // caller, and this one has more than one.
    if (!payload.amount || Number(payload.amount) <= 0) return null;

    const accounts = reimbursableCostAccounts({
      presentation: payload.presentation,
      settledBy: payload.settledBy,
    });
    // A chart that no longer carries one of the two accounts throws
    // `MissingLedgerAccountError` out of here, and the engine does not catch a rule's
    // error — so the caller's transaction rolls back and the member is told. That is
    // the right outcome rather than an unfortunate one: recording a cost that can
    // never post would leave a row in the register that the ledger knows nothing
    // about, and the two would be reconcilable only by noticing the omission.
    const ids = await accountIdsByCode(client, event.businessId, [
      accounts.debitCode,
      accounts.creditCode,
    ]);

    return {
      lines: [
        { accountId: ids.get(accounts.debitCode)!, debit: payload.amount, credit: ZERO },
        { accountId: ids.get(accounts.creditCode)!, debit: ZERO, credit: payload.amount },
      ],
      // The memo names the treatment, because the two presentations look identical on
      // a list of entries and an accountant reading the ledger should not have to
      // open the source document to know which side of §D's choice this was.
      memo: isPassThroughToClient(payload.presentation)
        ? "هزینهٔ قابل بازدریافت از کارفرما"
        : `هزینهٔ رسانه — ${WELL_KNOWN_CODES.agencyMediaCost}`,
      postingKind: "agency_reimbursable_cost",
      entryDate: payload.spentOn,
      projectId: payload.projectId ?? null,
    };
  },
);
