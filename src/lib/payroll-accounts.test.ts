import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("./payroll-db", () => ({
  clientRunner: (client: PoolClient) => client.query.bind(client),
  poolRunner: vi.fn(),
}));
vi.mock("./ledger-service", () => ({ accountIdsByCode: vi.fn() }));
import { resolvePayoutAccount } from "./payroll-accounts";

describe("Rial payout account ownership", () => {
  it("rechecks and locks currency after eligibility was read, before a payout may post", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "bank", code: "1110", name: "Bank", parent_id: null, type: "asset", currency_code: "IRR" }] })
      .mockResolvedValueOnce({ rows: [{ currency_code: "USD" }] });
    await expect(resolvePayoutAccount({ query } as unknown as PoolClient, "tenant", { paymentAccountId: "bank", method: "bank" }))
      .rejects.toMatchObject({ message: "invalid_payment_account", status: 400 });
    expect(query.mock.calls[1][0]).toContain("FOR SHARE");
    expect(query.mock.calls[1][1]).toEqual(["tenant", "bank"]);
  });
});
