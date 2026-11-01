/**
 * Pins §D's reimbursable-cost error map.
 *
 * The value of this file is the *type*, not the assertions: `EXPECTED_STATUS` is
 * `Record<AgencyReimbursableCostErrorCode, number>`, so adding a refusal to the
 * service without deciding what a member should see fails `tsc` here before it can
 * reach a route. That is the net §E's `review-guard.test.ts` and §C's
 * `campaign-guard.test.ts` spread, and it caught a real omission in §D's first
 * attempt at one.
 *
 * Two things about this map are worth pinning beyond the codes. `not_agency` is a 403
 * and not a 400, because the request is well-formed and it is the *business's own
 * industry* that refuses — the same reasoning the shared agency guard gives
 * `industry_mismatch`. And `cost_posted` is a 409, which is what tells the screen the
 * correction is a reversal rather than an edit; renumbering it to a 400 would make the
 * form re-show fields the ledger has already frozen.
 *
 * The composition with `handleAgencyError` is pinned too, because it is the part a
 * reader of either file alone cannot see: the cost guard must return null for the
 * ledger's `MissingLedgerAccountError` so the shared handler can answer it with a 409
 * in the product's own words, rather than a cost-only map answering it with a 500.
 */
import { describe, expect, it } from "vitest";
import { AgencyReimbursableCostError } from "@/lib/agency-reimbursable-cost-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { handleAgencyError } from "./guard";
import {
  AGENCY_REIMBURSABLE_COST_ERROR_CODES,
  REIMBURSABLE_COST_ERROR_STATUS,
  costActor,
  costErrorResponse,
  readCostBody,
  type AgencyReimbursableCostErrorCode,
} from "./reimbursable-cost-guard";

const EXPECTED_STATUS: Record<AgencyReimbursableCostErrorCode, number> = {
  // A record that is not there.
  cost_not_found: 404,

  // Not a malformed request — a business whose trade has no reimbursable client
  // cost at all, so a café is refused rather than served a register that would
  // silently mean something else.
  not_agency: 403,

  // A field the member typed wrong, or left out. Re-showing the form is the answer.
  client_required: 400,
  description_required: 400,
  amount_required: 400,
  invalid_amount: 400,
  date_required: 400,
  invalid_date: 400,
  invalid_presentation: 400,
  invalid_settlement: 400,
  text_too_long: 400,

  // The ledger already carries the figure, so the record refuses because of where it
  // is in its life cycle: the request was reasonable and the state says no.
  cost_posted: 409,
};

describe("reimbursable-cost-guard", () => {
  it("gives every refusal the status this screen is written against", () => {
    // Both directions, so the two lists cannot drift: every code the service can
    // throw has a pinned status, and every pinned status is a real code.
    expect([...AGENCY_REIMBURSABLE_COST_ERROR_CODES].sort()).toEqual(
      Object.keys(EXPECTED_STATUS).sort(),
    );
    for (const code of AGENCY_REIMBURSABLE_COST_ERROR_CODES) {
      expect(REIMBURSABLE_COST_ERROR_STATUS[code], code).toBe(EXPECTED_STATUS[code]);
    }
  });

  it("answers a refusal with its code and its status", async () => {
    for (const code of AGENCY_REIMBURSABLE_COST_ERROR_CODES) {
      const response = costErrorResponse(new AgencyReimbursableCostError(code));
      expect(response, code).not.toBeNull();
      expect(response!.status, code).toBe(EXPECTED_STATUS[code]);
      const body = (await response!.json()) as { error?: string };
      // The code reaches the member verbatim: the screen holds the Persian wording,
      // because a message that has to be translated on the server is a message that
      // gets translated twice.
      expect(body.error, code).toBe(code);
    }
  });

  it("translates what 0280's trigger raises into a refusal this feature means", async () => {
    // The FK proves a uuid exists; only the trigger proves it is this tenant's. So
    // 23514 here is a cross-tenant write attempt, which is a domain rule rather than
    // an accident — and surfacing as a 500 would hide which.
    const check = costErrorResponse({ code: "23514", message: "client does not belong to this business" });
    expect(check!.status).toBe(400);
    expect(((await check!.json()) as { error?: string }).error).toBe("cost_refused");

    const foreign = costErrorResponse({ code: "23503", message: "violates foreign key" });
    expect(foreign!.status).toBe(400);

    // A lost race for the same series position: retrying the identical request is the
    // answer, so it is a collision and not a malformed one.
    const unique = costErrorResponse({ code: "23505", message: "duplicate key" });
    expect(unique!.status).toBe(409);
  });

  it("returns null for what it does not own, so the shared agency handler answers it", () => {
    // The composition the routes rely on: a cost-only map that answered everything
    // would turn a missing ledger account into a 500, and would also swallow the
    // workspace codes `handleAgencyError` already translates.
    expect(costErrorResponse(new MissingLedgerAccountError("1270"))).toBeNull();
    expect(costErrorResponse(new Error("connection terminated"))).toBeNull();
    expect(costErrorResponse("not an error")).toBeNull();
    expect(costErrorResponse(null)).toBeNull();
    // A five-character string is not a SQLSTATE.
    expect(costErrorResponse({ code: "nope" })).toBeNull();

    // And the shared handler does answer the one this guard deliberately leaves it,
    // with a conflict rather than a server error: a chart missing 1270 is a state the
    // member can act on, not a crash.
    const handled = handleAgencyError(new MissingLedgerAccountError("1270"));
    expect(handled.status).toBe(409);
  });

  it("reads a body, and treats a malformed one as a 400 rather than an exception", async () => {
    const ok = await readCostBody(
      new Request("http://test/api/agency/reimbursable-costs", {
        method: "POST",
        body: JSON.stringify({ description: "خرید رسانه", amountRial: 5000 }),
      }),
    );
    expect(ok).toEqual({ description: "خرید رسانه", amountRial: 5000 });

    expect(
      await readCostBody(
        new Request("http://test/api/agency/reimbursable-costs", { method: "POST", body: "{not json" }),
      ),
    ).toBeNull();
    expect(
      await readCostBody(
        new Request("http://test/api/agency/reimbursable-costs", { method: "POST", body: "[]" }),
      ),
    ).toBeNull();
    // An empty object *is* a body — the service decides that an empty patch is a
    // no-op returning the row, and that decision is not this function's to make.
    expect(
      await readCostBody(
        new Request("http://test/api/agency/reimbursable-costs", { method: "POST", body: "{}" }),
      ),
    ).toEqual({});
  });

  it("takes the actor from the session the route already verified", () => {
    // Not a placeholder: `domain_events.created_by` is a foreign key to `users`, so a
    // posted cost is attributed to a real member or the write fails at the event.
    expect(costActor({ sub: "user-1", fullName: "مریم احمدی" })).toEqual({
      userId: "user-1",
      name: "مریم احمدی",
    });
    expect(costActor({ sub: "user-1", fullName: null })).toEqual({ userId: "user-1", name: "" });
    expect(costActor({ sub: "user-1" })).toEqual({ userId: "user-1", name: "" });
  });
});
