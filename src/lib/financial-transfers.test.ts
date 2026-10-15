/**
 * The Internal Transfers domain's pure rules (issue #862).
 *
 * The part of a transfer that decides what the journal will say is deliberately
 * a pure function (`buildTransferLines`) so it can be pinned here: the form
 * previews with it and the service posts with it, which is what makes the
 * preview honest. The rest of the file covers the request validation a transfer
 * can fail on its own, and the lifecycle rules that make a transfer append-only.
 */
import { describe, expect, it } from "vitest";

import {
  TRANSFER_DESCRIPTION_MAX,
  TRANSFER_FEE_PAYERS,
  TRANSFER_REFERENCE_MAX,
  TRANSFER_REVERSAL_REASON_MAX,
  TRANSFER_STATUSES,
  TRANSFER_STATUS_LABELS,
  addAmounts,
  amountToRialText,
  buildTransferLines,
  canEditTransfer,
  canReverseTransfer,
  isPositiveAmountText,
  isTransferFeePayer,
  isTransferStatus,
  reversalDisposition,
  subtractAmounts,
  transferNetEffect,
  transferNumberFor,
  transferPostingProblem,
  transferRequestProblem,
} from "./financial-transfers";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const DESTINATION = "22222222-2222-4222-8222-222222222222";
const FEE_ACCOUNT = "33333333-3333-4333-8333-333333333333";

const accounts = {
  sourceGlAccountId: "gl-source",
  destinationGlAccountId: "gl-destination",
  feeGlAccountId: "gl-fee",
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    transferDate: "2026-04-20",
    sourceAccountId: SOURCE,
    destinationAccountId: DESTINATION,
    amount: "1000000",
    ...overrides,
  };
}

describe("the entry a transfer builds", () => {
  it("moves the amount with no fee at all", () => {
    const built = buildTransferLines(accounts, { amount: "1000", feeAmount: "0", feePayer: "source" });
    expect(built).toEqual({
      lines: [
        { accountId: "gl-destination", debit: "1000", credit: "0" },
        { accountId: "gl-source", debit: "0", credit: "1000" },
      ],
      sourceOutflow: "1000",
      destinationInflow: "1000",
    });
  });

  it("books a fee paid by the source as a second debit, and credits the whole outflow", () => {
    const built = buildTransferLines(accounts, { amount: "1000", feeAmount: "50", feePayer: "source" })!;
    expect(built.lines).toEqual([
      { accountId: "gl-destination", debit: "1000", credit: "0" },
      { accountId: "gl-fee", debit: "50", credit: "0" },
      { accountId: "gl-source", debit: "0", credit: "1050" },
    ]);
    expect(built.sourceOutflow).toBe("1050");
    expect(built.destinationInflow).toBe("1000");
  });

  it("books a fee paid by the destination as money that never arrives", () => {
    const built = buildTransferLines(accounts, { amount: "1000", feeAmount: "50", feePayer: "destination" })!;
    expect(built.lines).toEqual([
      { accountId: "gl-destination", debit: "950", credit: "0" },
      { accountId: "gl-fee", debit: "50", credit: "0" },
      { accountId: "gl-source", debit: "0", credit: "1000" },
    ]);
    expect(built.sourceOutflow).toBe("1000");
    expect(built.destinationInflow).toBe("950");
  });

  it("balances to the Rial in every shape it accepts", () => {
    for (const feePayer of TRANSFER_FEE_PAYERS) {
      for (const feeAmount of ["0", "1", "500000"]) {
        for (const amount of ["1", "1000", "999999999999"]) {
          const built = buildTransferLines(accounts, { amount, feeAmount, feePayer });
          if (!built) continue;
          const debits = built.lines.reduce((sum, line) => sum + BigInt(line.debit), 0n);
          const credits = built.lines.reduce((sum, line) => sum + BigInt(line.credit), 0n);
          expect(debits).toBe(credits);
        }
      }
    }
  });

  it("refuses the five things a transfer cannot be, each with its own name", () => {
    expect(transferPostingProblem(accounts, { amount: "0", feeAmount: "0", feePayer: "source" })).toBe(
      "invalid_amount",
    );
    expect(transferPostingProblem(accounts, { amount: "-1", feeAmount: "0", feePayer: "source" })).toBe(
      "invalid_amount",
    );
    expect(transferPostingProblem(accounts, { amount: "1000", feeAmount: "1.5", feePayer: "source" })).toBe(
      "invalid_fee",
    );
    expect(
      transferPostingProblem({ ...accounts, feeGlAccountId: null }, { amount: "1000", feeAmount: "5", feePayer: "source" }),
    ).toBe("fee_account_required");
    expect(transferPostingProblem(accounts, { amount: "1000", feeAmount: "1000", feePayer: "destination" })).toBe(
      "fee_exceeds_amount",
    );
    expect(
      transferPostingProblem(
        { ...accounts, destinationGlAccountId: "gl-source" },
        { amount: "1000", feeAmount: "0", feePayer: "source" },
      ),
    ).toBe("same_gl_account");
    expect(transferPostingProblem(accounts, { amount: "1000", feeAmount: "0", feePayer: "source" })).toBeNull();
  });

  it("returns null instead of throwing for a form that is not ready yet", () => {
    expect(buildTransferLines(accounts, { amount: "", feeAmount: "0", feePayer: "source" })).toBeNull();
    expect(
      buildTransferLines({ ...accounts, feeGlAccountId: null }, { amount: "1000", feeAmount: "0", feePayer: "source" }),
    ).not.toBeNull();
    expect(
      buildTransferLines({ ...accounts, feeGlAccountId: null }, { amount: "1000", feeAmount: "5", feePayer: "source" }),
    ).toBeNull();
  });

  it("nets a document and its mirror to nothing, for every leg", () => {
    const built = buildTransferLines(accounts, { amount: "1000", feeAmount: "50", feePayer: "source" })!;
    const mirror = built.lines.map((line) => ({
      accountId: line.accountId,
      debit: line.credit,
      credit: line.debit,
    }));
    for (const value of transferNetEffect(built.lines, mirror).values()) expect(value).toBe("0");
  });
});

describe("amounts", () => {
  it("takes Rial text and whole-Rial numbers from a legacy client", () => {
    expect(amountToRialText("1000", "amount")).toBe("1000");
    expect(amountToRialText(" 1000 ", "amount")).toBe("1000");
    expect(amountToRialText(1000, "amount")).toBe("1000");
    expect(amountToRialText("0", "amount")).toBe("0");
  });

  it("refuses a fractional or non-numeric amount rather than rounding it", () => {
    for (const value of ["1.5", "-1", "abc", "", 1.5, -3, null, undefined, {}, []]) {
      expect(amountToRialText(value, "amount")).toBeNull();
    }
  });

  it("refuses an amount past the column's own ceiling", () => {
    // The storage is a Postgres `bigint`, so the ceiling is `2^63 − 1` — and the
    // exact boundary is asserted rather than a round number, because the value
    // that must NOT be refused is the one a busy business reaches.
    expect(amountToRialText("9223372036854775807", "amount")).toBe("9223372036854775807");
    expect(amountToRialText("9223372036854775808", "amount")).toBeNull();
    expect(amountToRialText("9".repeat(20), "amount")).toBeNull();
    expect(amountToRialText(String(Number.MAX_SAFE_INTEGER), "amount")).not.toBeNull();
  });

  it("keeps the fee arithmetic exact", () => {
    expect(addAmounts("9007199254740993", "1")).toBe("9007199254740994");
    expect(subtractAmounts("1000", "1")).toBe("999");
    expect(isPositiveAmountText("1")).toBe(true);
    expect(isPositiveAmountText("0")).toBe(false);
  });
});

describe("the document number", () => {
  it("pads the tenant's own sequence to a stable, sortable number", () => {
    expect(transferNumberFor(1)).toBe("TR-000001");
    expect(transferNumberFor(123)).toBe("TR-000123");
    expect(transferNumberFor("999999")).toBe("TR-999999");
    expect(transferNumberFor(1000000n)).toBe("TR-1000000");
  });

  it("refuses a sequence that never existed", () => {
    expect(() => transferNumberFor(0)).toThrow();
    expect(() => transferNumberFor(-1)).toThrow();
  });
});

describe("what a request may be", () => {
  it("accepts the minimum a transfer needs", () => {
    expect(transferRequestProblem(request())).toBeNull();
  });

  it("asks for a date in the ISO shape the ledger stores", () => {
    expect(transferRequestProblem(request({ transferDate: undefined }))?.code).toBe("transfer_date_required");
    expect(transferRequestProblem(request({ transferDate: "" }))?.code).toBe("transfer_date_required");
    expect(transferRequestProblem(request({ transferDate: "1404/01/31" }))?.code).toBe("invalid_transfer_date");
    expect(transferRequestProblem(request({ transferDate: "2026-02-30" }))?.code).toBe("invalid_transfer_date");
  });

  it("insists the two sides are two different accounts", () => {
    expect(transferRequestProblem(request({ sourceAccountId: "nope" }))?.code).toBe("source_account_required");
    expect(transferRequestProblem(request({ destinationAccountId: undefined }))?.code).toBe(
      "destination_account_required",
    );
    expect(transferRequestProblem(request({ destinationAccountId: SOURCE }))?.code).toBe("same_account");
  });

  it("refuses a zero or non-integer amount, and names the field", () => {
    expect(transferRequestProblem(request({ amount: "0" }))).toEqual({ code: "invalid_amount", field: "amount" });
    expect(transferRequestProblem(request({ amount: "1.5" }))?.field).toBe("amount");
    expect(transferRequestProblem(request({ amount: undefined }))?.code).toBe("invalid_amount");
  });

  it("requires a fee account as soon as there is a fee — and only then", () => {
    expect(transferRequestProblem(request({ feeAmount: "500" }))).toEqual({
      code: "fee_account_required",
      field: "feeAccountId",
    });
    expect(transferRequestProblem(request({ feeAmount: "500", feeAccountId: FEE_ACCOUNT }))).toBeNull();
    expect(transferRequestProblem(request({ feeAccountId: FEE_ACCOUNT }))?.code).toBe("fee_account_without_fee");
    // A zero fee with an account named is tolerated: the two fields are
    // independent in the payload, and a form that clears the amount before the
    // picker must not fail on the way. The posting rule reads the zero either
    // way, so no fee account is debited.
    expect(transferRequestProblem(request({ feeAmount: "0", feeAccountId: FEE_ACCOUNT }))).toBeNull();
  });

  it("refuses a destination-paid fee that eats the whole transfer", () => {
    expect(
      transferRequestProblem(
        request({ amount: "1000", feeAmount: "1000", feeAccountId: FEE_ACCOUNT, feePayer: "destination" }),
      )?.code,
    ).toBe("fee_exceeds_amount");
    expect(
      transferRequestProblem(
        request({ amount: "1000", feeAmount: "999", feeAccountId: FEE_ACCOUNT, feePayer: "destination" }),
      ),
    ).toBeNull();
  });

  it("refuses an unknown fee payer instead of defaulting silently", () => {
    expect(
      transferRequestProblem(request({ feeAmount: "500", feeAccountId: FEE_ACCOUNT, feePayer: "bank" }))?.code,
    ).toBe("invalid_fee_payer");
    expect(isTransferFeePayer("source")).toBe(true);
    expect(isTransferFeePayer("destination")).toBe(true);
    expect(isTransferFeePayer("bank")).toBe(false);
  });

  it("bounds the reference and the description at the columns' widths", () => {
    expect(transferRequestProblem(request({ referenceNumber: "r".repeat(TRANSFER_REFERENCE_MAX) }))).toBeNull();
    expect(transferRequestProblem(request({ referenceNumber: "r".repeat(TRANSFER_REFERENCE_MAX + 1) }))?.code).toBe(
      "referenceNumber_too_long",
    );
    expect(transferRequestProblem(request({ description: "د".repeat(TRANSFER_DESCRIPTION_MAX) }))).toBeNull();
    expect(transferRequestProblem(request({ description: "د".repeat(TRANSFER_DESCRIPTION_MAX + 1) }))?.code).toBe(
      "description_too_long",
    );
    expect(TRANSFER_REVERSAL_REASON_MAX).toBeGreaterThan(0);
  });

  it("takes uuid references or nothing at all", () => {
    expect(transferRequestProblem(request({ projectId: "not-a-uuid" }))?.code).toBe("invalid_projectId");
    expect(transferRequestProblem(request({ attachmentAssetId: "not-a-uuid" }))?.code).toBe("invalid_attachmentAssetId");
    expect(transferRequestProblem(request({ projectId: "", attachmentAssetId: null }))).toBeNull();
    expect(transferRequestProblem(request({ projectId: FEE_ACCOUNT, attachmentAssetId: FEE_ACCOUNT }))).toBeNull();
  });

  it("rejects a non-string idempotency key", () => {
    expect(transferRequestProblem(request({ idempotencyKey: 7 }))?.code).toBe("invalid_idempotency_key");
    expect(transferRequestProblem(request({ idempotencyKey: "abc" }))).toBeNull();
  });
});

describe("lifecycle", () => {
  it("knows its two statuses", () => {
    expect([...TRANSFER_STATUSES]).toEqual(["posted", "reversed"]);
    expect(isTransferStatus("posted")).toBe(true);
    expect(isTransferStatus("cancelled")).toBe(false);
    for (const status of TRANSFER_STATUSES) expect(TRANSFER_STATUS_LABELS[status]).not.toBe("");
  });

  it("may be reversed while posted, and never twice", () => {
    expect(canReverseTransfer("posted")).toBe(true);
    expect(canReverseTransfer("reversed")).toBe(false);
  });

  it("may never be edited — a correction is a reversal", () => {
    expect(canEditTransfer()).toBe(false);
  });

  it("replays a repeated reversal of the same request, and refuses a different one", () => {
    expect(reversalDisposition({ status: "posted", reversalKey: null, requestKey: "k1" })).toEqual({
      kind: "proceed",
    });
    expect(reversalDisposition({ status: "reversed", reversalKey: "k1", requestKey: "k1" })).toEqual({
      kind: "idempotent",
    });
    expect(reversalDisposition({ status: "reversed", reversalKey: "k1", requestKey: "k2" })).toEqual({
      kind: "refuse",
      code: "transfer_already_reversed",
    });
    expect(reversalDisposition({ status: "reversed", reversalKey: null, requestKey: null })).toEqual({
      kind: "refuse",
      code: "transfer_already_reversed",
    });
  });
});
