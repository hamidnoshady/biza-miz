import { describe, expect, it } from "vitest";
import { buildTransferLines } from "./financial-transfers";
import { parsePspSettlement, pspSettlementKey, pspSettlementProblem } from "./psp-settlements";

const terminalAccountId = "20000000-0000-4000-8000-000000000001";
const bankAccountId = "20000000-0000-4000-8000-000000000002";
const feeAccountId = "20000000-0000-4000-8000-000000000003";
const statement = {
  terminalAccountId, bankAccountId, feeAccountId,
  batchReference: " B-872 ", movementReference: "bank-0008",
  settledOn: "2026-10-16", expectedOn: "2026-10-14",
  batchGrossAmount: "1000000", netAmount: "595000", feeAmount: "5000",
};

describe("confirmed PSP settlements", () => {
  it("credits only the verified net and leaves the unpaid portion in clearing", () => {
    const parsed = parsePspSettlement(statement);
    expect(parsed).toMatchObject({
      batchReference: "B-872", batchGrossAmount: "1000000",
      input: { amount: "600000", feeAmount: "5000", feePayer: "destination", transferDate: "2026-10-16" },
    });
    expect(buildTransferLines({ sourceGlAccountId: "clearing", destinationGlAccountId: "bank", feeGlAccountId: "fee" }, {
      amount: String(parsed?.input.amount), feeAmount: String(parsed?.input.feeAmount), feePayer: "destination",
    })?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "clearing", debit: "0", credit: "600000" }),
      expect.objectContaining({ accountId: "bank", debit: "595000", credit: "0" }),
      expect.objectContaining({ accountId: "fee", debit: "5000", credit: "0" }),
    ]));
  });

  it("deduplicates the same bank movement even if the terms or assigned batch change", () => {
    const original = pspSettlementKey(terminalAccountId, "bank-0008");
    expect(parsePspSettlement({ ...statement, netAmount: "500000" })?.input.idempotencyKey).toBe(original);
    expect(parsePspSettlement({ ...statement, batchReference: "B-873" })?.input.idempotencyKey).toBe(original);
    expect(parsePspSettlement({ ...statement, movementReference: "bank-۰۰۰۸" })?.input.idempotencyKey).toBe(original);
    expect(pspSettlementKey(terminalAccountId, "bank-0009")).not.toBe(original);
    expect(pspSettlementKey(bankAccountId, "bank-0008")).not.toBe(original);
  });

  it.each([
    [{ movementReference: "  " }, "invalid_psp_reference"],
    [{ expectedOn: "2026-02-30" }, "invalid_psp_expected_date"],
    [{ netAmount: "1.5" }, "invalid_psp_amount"],
    [{ feeAccountId: null }, "invalid_psp_fee_account"],
    [{ feeAmount: "0" }, "invalid_psp_fee_account"],
    [{ netAmount: "999000" }, "psp_batch_amount_exceeded"],
    [{ netAmount: 9_007_199_254_740_992 }, "invalid_psp_amount"],
  ])("rejects invalid statement evidence %j", (patch, code) => {
    expect(pspSettlementProblem({ ...statement, ...patch })).toBe(code);
  });
});
