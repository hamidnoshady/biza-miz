import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { rialText } from "@/lib/inventory-exact";
import type { SettlementMethod } from "@/lib/ledger";
import {
  AGENCY_MILESTONE_ACTIONS,
  agencyCommercialActionNeedsApproval,
  isAgencyMilestoneAction,
} from "@/lib/agency-commercial";
import { applyMilestoneAction } from "@/lib/agency-commercial-service";
import { MAX_RETAIL_TENDERS, type RetailTenderInput } from "@/lib/retail-tenders";
import type { CreateRetailInvoiceTenderInput } from "@/lib/retail-invoice-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../../guard";

const SETTLEMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];

interface RawTender {
  method?: string;
  amount?: number | string | null;
  paymentMethodId?: string | null;
  reference?: string | null;
}

/**
 * §D's milestone chain, one endpoint — the same shape the AEC status routes use,
 * and for the same reason: the transitions belong together, so the chain is one
 * readable list rather than six routes that can drift apart.
 *
 * Two permissions, deliberately not one (§24's rule that a high-risk commercial
 * action must not inherit ordinary edit rights), and which of them applies is
 * read from the catalogue in `agency-commercial.ts` rather than restated here:
 *
 *   * `submit`, `reopen` and `withdraw` are the author's own acts — sending a
 *     row for approval and taking it back again — so they are
 *     `workspace.manage`, like every other register edit. The approvals engine
 *     refuses a self-approval on the other side, which is what actually keeps a
 *     submitter from deciding their own request.
 *   * `approve`, `reject`, `cancel` and `invoice` are determinations on
 *     `workspace.approve`.
 *
 * `invoice` is one act with a third half. It is a determination *and* a money
 * movement, so it also demands the pair the invoice screen itself is gated on
 * (`canUsePos` = `orders.create` && `payments.take`, issue #913 item 9). Without
 * that, a project manager who may not take payments could take them through the
 * workspace door instead — the one capability no screen would have offered them.
 *
 * Settlement defaults to on account (نسیه) in the service, which is what an
 * agency invoice means: the posting engine debits Accounts Receivable, so §D's
 * client receivables arrive through the existing AR path. A caller who settles
 * at the same moment passes `tenders`.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!isAgencyMilestoneAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needsApproval = agencyCommercialActionNeedsApproval(AGENCY_MILESTONE_ACTIONS, action);
    const { owner, error } = await agencyOwner(
      needsApproval ? PERMISSIONS.workspaceApprove : PERMISSIONS.workspaceManage,
      request,
    );
    if (error) return error;

    let tenders: CreateRetailInvoiceTenderInput[] | undefined;
    if (action === "invoice") {
      // The invoice screen's own permissions: issuing a milestone's invoice is
      // taking a payment, whichever door it is taken through. Demanded whether
      // or not the caller settles it now — an invoice on account is still an
      // invoice, and it is the one that creates the receivable.
      const payments = await requirePermission(PERMISSIONS.paymentsTake);
      if (payments.error) return payments.error;
      const orders = await requirePermission(PERMISSIONS.ordersCreate);
      if (orders.error) return orders.error;
      if (body.tenders !== undefined) {
        const parsed = parseTenders(body.tenders);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        tenders = parsed.tenders;
      }
    }

    try {
      const milestone = await applyMilestoneAction(owner, id, action, {
        note: body.note,
        locationId: typeof body.locationId === "string" ? body.locationId : null,
        tenders,
      });
      return NextResponse.json({ milestone });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);

/**
 * The invoice's payment slices, validated the way the till's own route validates
 * them: at most `MAX_RETAIL_TENDERS`, each a known settlement method, and at
 * most one left open ("whatever this comes to").
 *
 * A malformed slice is refused rather than dropped — dropping it would settle
 * the invoice with money the caller never asked to take.
 */
function parseTenders(
  value: unknown,
): { ok: true; tenders: CreateRetailInvoiceTenderInput[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "bad_request" };
  if (value.length === 0) return { ok: false, error: "empty_tenders" };
  if (value.length > MAX_RETAIL_TENDERS) return { ok: false, error: "too_many_tenders" };
  const tenders: CreateRetailInvoiceTenderInput[] = [];
  let openCount = 0;
  for (const entry of value as RawTender[]) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "bad_request" };
    const method = entry.method as SettlementMethod;
    if (!SETTLEMENT_METHODS.includes(method)) {
      return { ok: false, error: "invalid_payment_method" };
    }
    const omitted = entry.amount === undefined || entry.amount === null;
    if (omitted) {
      openCount += 1;
      if (openCount > 1) return { ok: false, error: "too_many_open_tenders" };
    }
    tenders.push({
      method,
      amount: omitted ? undefined : (rialText(String(entry.amount)) as RetailTenderInput["amount"]),
      paymentMethodId:
        typeof entry.paymentMethodId === "string" && entry.paymentMethodId.trim()
          ? entry.paymentMethodId.trim()
          : null,
      reference: typeof entry.reference === "string" && entry.reference.trim() ? entry.reference.trim() : null,
    });
  }
  return { ok: true, tenders };
}
