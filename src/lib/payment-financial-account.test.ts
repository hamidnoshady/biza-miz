import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { resolvePaymentFinancialAccountId } from "./payment-financial-account";

const bank = { id: "bank-one", location_id: "branch-one", is_active: true, currency_code: "IRR", kind: "bank" };
const params = {
  businessId: "tenant-one", locationId: "branch-one", accountId: "bank-gl", explicit: true,
  allowedKinds: ["bank"] as const, invalid: () => new Error("invalid_payment_account"),
};

describe("registered payment provenance", () => {
  it("resolves the selected GL only within its tenant and checks the expected identity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [bank] });
    const client = { query } as unknown as PoolClient;
    await expect(resolvePaymentFinancialAccountId(client, { ...params, expectedFinancialAccountId: bank.id })).resolves.toBe(bank.id);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE business_id = $1 AND gl_account_id = $2 FOR SHARE"), ["tenant-one", "bank-gl"]);
    await expect(resolvePaymentFinancialAccountId(client, { ...params, expectedFinancialAccountId: "other-bank" })).rejects.toThrow("invalid_payment_account");
  });

  it.each([
    { location_id: "other-branch" }, { is_active: false }, { currency_code: "USD" }, { kind: "pos_psp" },
  ])("refuses an unusable registered account (%j)", async (change) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...bank, ...change }] });
    await expect(resolvePaymentFinancialAccountId({ query } as unknown as PoolClient, params)).rejects.toThrow("invalid_payment_account");
  });

  it("keeps an unregistered legacy GL unattributed and rejects ambiguous pooled bank payments", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [bank, { ...bank, id: "bank-two" }] });
    const client = { query } as unknown as PoolClient;
    await expect(resolvePaymentFinancialAccountId(client, params)).resolves.toBeNull();
    await expect(resolvePaymentFinancialAccountId(client, { ...params, explicit: false, fallbackKind: "bank" })).rejects.toThrow("invalid_payment_account");
  });
});
