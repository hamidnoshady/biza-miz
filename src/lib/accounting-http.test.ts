import { describe, expect, it } from "vitest";
import { accountingErrorResponse } from "./accounting-http";
import { OpeningBalanceError } from "./opening-balance-service";
import { VoucherError } from "./voucher-service";

describe("accountingErrorResponse", () => {
  it("maps an opening-balance refusal to its own status and code", async () => {
    const res = accountingErrorResponse(new OpeningBalanceError("opening_not_balanced", 409, { debit: 5, credit: 4 }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    expect(await res!.json()).toEqual({ error: "opening_not_balanced", debit: 5, credit: 4 });
  });

  it("maps a voucher refusal to its status", async () => {
    const res = accountingErrorResponse(new VoucherError("voucher_number_out_of_range", 409, { lastIssued: 2 }));
    expect(res!.status).toBe(409);
    expect(await res!.json()).toEqual({ error: "voucher_number_out_of_range", lastIssued: 2 });
  });

  it("maps a fiscal-period lock to 409", async () => {
    const res = accountingErrorResponse(new VoucherError("fiscal_period_locked", 409));
    expect(res!.status).toBe(409);
  });

  it("returns null for an unexpected failure so the caller rethrows it", () => {
    expect(accountingErrorResponse(new Error("boom"))).toBeNull();
    expect(accountingErrorResponse("not an error")).toBeNull();
  });
});
