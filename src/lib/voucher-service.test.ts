import { describe, expect, it } from "vitest";
import { renumberVoucher, setVoucherReference, VoucherError } from "./voucher-service";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

// These refusals are decided before any database work starts, so they run without Postgres.
describe("voucher-service input refusals", () => {
  it("renumber needs a reason", async () => {
    await expect(renumberVoucher(BIZ, ACTOR, ENTRY, { toVoucherNumber: 2, reason: "  " })).rejects.toMatchObject({
      message: "reason_required",
      status: 400,
    });
  });

  it("reference change needs a reason", async () => {
    await expect(setVoucherReference(BIZ, ACTOR, ENTRY, { reference: "A1", reason: "" })).rejects.toBeInstanceOf(
      VoucherError,
    );
  });

  it("reference must be text", async () => {
    await expect(setVoucherReference(BIZ, ACTOR, ENTRY, { reference: 42, reason: "fix" })).rejects.toMatchObject({
      message: "reference_invalid_characters",
      status: 400,
    });
  });
});
