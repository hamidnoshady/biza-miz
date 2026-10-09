import { describe, expect, it } from "vitest";
import { createOpeningBalanceSet, generateCarryForwardProposal, OpeningBalanceError, reverseOpeningBalanceSet } from "./opening-balance-service";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ACTOR = "33333333-3333-4333-8333-333333333333";

// Refusals decided before any database work starts; the full flow is in integration/.
describe("opening-balance-service input refusals", () => {
  it("rejects a malformed fiscal year id", async () => {
    await expect(
      createOpeningBalanceSet(BIZ, ACTOR, { fiscalYearId: "not-a-uuid", effectiveDate: "2026-03-21" }),
    ).rejects.toMatchObject({ message: "fiscal_year_not_found", status: 404 });
  });

  it("rejects an over-long idempotency key", async () => {
    await expect(
      createOpeningBalanceSet(BIZ, ACTOR, {
        fiscalYearId: "22222222-2222-4222-8222-222222222222",
        effectiveDate: "2026-03-21",
        idempotencyKey: "k".repeat(201),
      }),
    ).rejects.toMatchObject({ message: "invalid_idempotency_key", status: 400 });
  });

  it("reversal needs a reason before anything else", async () => {
    await expect(
      reverseOpeningBalanceSet(BIZ, ACTOR, "22222222-2222-4222-8222-222222222222", "   "),
    ).rejects.toBeInstanceOf(OpeningBalanceError);
  });

  it("carry-forward rejects a malformed target year", async () => {
    await expect(generateCarryForwardProposal(BIZ, ACTOR, "bad")).rejects.toMatchObject({
      message: "fiscal_year_not_found",
    });
  });
});
