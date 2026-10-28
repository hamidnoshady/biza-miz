/**
 * The agency error map, including the two halves of it that are not the agency's.
 *
 * `/api/agency/**` refuses for three different reasons, and each has its own
 * vocabulary: the agency service (an industry or a record said no), the invoice
 * engine (`invoice` is a determination *and* a money movement, so issuing one
 * leaves this module and enters the retail invoice service), and the workspace
 * module (these registers live inside My Workspace projects, so
 * `requireProjectCapability` runs on top of every one of them).
 *
 * Before the third half was asserted, an agency-only map answered the workspace's
 * ordinary 403 with a 500 — the same defect the AEC guard's test pins. The
 * invoice half matters for a different reason: those three refusals carry the
 * Persian sentence an operator needs, and a map that replaced it with a code
 * would leave somebody who cannot bill a milestone with nothing to act on.
 */
import { describe, expect, it } from "vitest";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  AGENCY_COMMERCIAL_ERROR_CODES,
  AgencyCommercialError,
  type AgencyCommercialErrorCode,
} from "@/lib/agency-commercial-service";
import {
  RetailInvoiceError,
  RetailRequestConflictError,
} from "@/lib/retail-invoice-service";
import { WorkspaceError } from "@/lib/workspace";
import { handleAgencyError } from "./guard";

/**
 * Every code the service throws, with the status it deserves.
 *
 * Typed as a `Record` over the union so this table cannot be missing one: add a
 * code to `AGENCY_COMMERCIAL_ERROR_CODES` and this file stops compiling until
 * the status is chosen deliberately. That is the point — the map's `?? 400`
 * default would otherwise answer a new life-cycle refusal as a malformed-field
 * refusal, and nothing would notice.
 */
const EXPECTED_STATUS: Record<AgencyCommercialErrorCode, number> = {
  industry_mismatch: 403,
  milestone_not_found: 404,
  change_request_not_found: 404,
  approval_not_found: 404,
  title_required: 400,
  description_required: 400,
  due_date_required: 400,
  invalid_milestone_kind: 400,
  invalid_milestone_amount: 400,
  invalid_revenue_code: 400,
  invalid_date: 400,
  invalid_period: 400,
  invalid_hours: 400,
  invalid_billing_base: 400,
  invalid_schedule_impact: 400,
  invalid_milestone_action: 400,
  invalid_change_request_action: 400,
  invalid_change_request_amount: 400,
  milestone_not_editable: 409,
  invalid_milestone_transition: 409,
  change_request_not_editable: 409,
  invalid_change_request_transition: 409,
  change_request_amount_required: 409,
  approval_already_pending: 409,
  schedule_empty: 409,
  schedule_exists: 409,
  schedule_over_allocated: 409,
  contract_value_required: 409,
  customer_required: 409,
  location_required: 409,
};

/** `handleAgencyError` is synchronous, so a status needs no awaiting. */
function statusOf(error: unknown): number {
  return handleAgencyError(error).status;
}

describe("handleAgencyError", () => {
  it("gives every agency code its own status, never the map's default", () => {
    for (const code of AGENCY_COMMERCIAL_ERROR_CODES) {
      expect(handleAgencyError(new AgencyCommercialError(code)).status).toBe(EXPECTED_STATUS[code]);
    }
  });

  it("holds no stale code the service no longer throws", () => {
    expect(Object.keys(EXPECTED_STATUS).sort()).toEqual([...AGENCY_COMMERCIAL_ERROR_CODES].sort());
  });

  it("keeps the field-versus-life-cycle split: malformed input is 400, a record's state is 409", () => {
    // A 400 tells the caller their request was wrong and could be fixed by
    // sending something else. A 409 tells them the request was reasonable and
    // the record is where it refuses to move from — which is a different thing
    // for a screen to say, and the reason `schedule_empty` is a 409 rather than
    // a 400: an hourly engagement asked for a schedule is not a mistake, it is
    // a shape that has nothing to lay out.
    expect(statusOf(new AgencyCommercialError("invalid_milestone_amount"))).toBe(400);
    expect(statusOf(new AgencyCommercialError("invalid_milestone_transition"))).toBe(409);
    expect(statusOf(new AgencyCommercialError("milestone_not_editable"))).toBe(409);
    expect(statusOf(new AgencyCommercialError("schedule_empty"))).toBe(409);
  });

  it("answers a refusal that is the business's own industry, not the caller's fault, with 403", () => {
    expect(statusOf(new AgencyCommercialError("industry_mismatch"))).toBe(403);
  });

  it("maps the workspace codes the project gate throws", () => {
    // #761 folded `not_a_project_member` into `project_not_found`: whether a
    // project exists is itself something a non-member must not learn.
    expect(statusOf(new WorkspaceError("project_not_found"))).toBe(404);
    expect(statusOf(new WorkspaceError("insufficient_project_role"))).toBe(403);
  });

  it("keeps the invoice engine's three refusals, and the sentence each was raised with", async () => {
    const conflict = handleAgencyError(new RetailRequestConflictError("stale key"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "request_conflict" });

    const invoice = handleAgencyError(
      new RetailInvoiceError("مبلغ دریافتی از مبلغ فاکتور بیشتر است"),
    );
    expect(invoice.status).toBe(400);
    expect(await invoice.json()).toEqual({
      error: "invoice_failed",
      message: "مبلغ دریافتی از مبلغ فاکتور بیشتر است",
    });

    const ledger = handleAgencyError(new MissingLedgerAccountError("4640"));
    expect(ledger.status).toBe(409);
    expect(await ledger.json()).toEqual({
      error: "missing_ledger_account",
      message: "ledger_account_missing: 4640",
    });
  });

  it("still refuses to dress an unknown error up as a 4xx", () => {
    expect(() => handleAgencyError(new Error("boom"))).toThrow("boom");
  });
});
